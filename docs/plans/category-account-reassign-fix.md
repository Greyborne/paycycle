# Build spec — fix stale line items on category account reassignment

Status: not started. Prod data-correctness bug, found incidentally by a
security-checker during the data-reset build (2026-07-26), confirmed and
root-caused by a code-worker investigation the same day.

## Root cause (confirmed by reproduction on an isolated ephemeral DB)

`PATCH /categories/:id` (`server/routes/categories.js:129-198`) lets a
category's `account_id` be reassigned to a different account. When it
changes, any already-materialized, **uncleared** `line_items` rows for
that category sitting in **open** periods under the OLD account are never
touched — they keep counting toward the old account's
`plannedExpenses`/`estBalance`/health via `getPeriodDetail`'s `itemFilter`
(`server/services/budget.js` ~line 923-930), which scopes by the line
item's own frozen `account_id` (set once at materialization), not the
category's current ownership. Meanwhile the next `ensureMaterialized` call
(fired on every `GET /periods/current`, `periods.js:36`) seeds a fresh,
correctly-owned line item for the SAME category under the NEW account's
open period. Result: the same planned amount is live under two accounts
at once, and both accounts' real balance math count it — a genuine
double-count, not a display artifact.

The existing handler already has the right precedent for this class of
problem one branch below: converting `recurring` → `tag`
(`categories.js:185-192`) deletes stale uncleared open-period line items
for exactly this reason (`categorized_by`/plan changed, old plan
shouldn't linger). Account reassignment needs the identical treatment.

## Fix

### 1. Reconcile on reassignment (`server/routes/categories.js`, `PATCH /:id`)
When `body.accountId !== undefined` and the resolved `accountId` actually
differs from `t.account_id` (the pre-update value), delete this
category's uncleared line items in open periods — same shape as the
existing tag-conversion branch:
```sql
DELETE FROM line_items li USING pay_periods pp
WHERE pp.id = li.pay_period_id AND li.category_template_id = $1
  AND NOT li.cleared AND pp.closed_at IS NULL
```
This must run regardless of `categoryType`, so if BOTH `accountId` and
`categoryType` change in the same request, the delete should not run
twice — write it as one shared conditional (`if accountChanged ||
convertedToTag`), not two separate DELETE statements.

**Do not touch cleared line items or closed periods** — same invariant as
every other route in this app (§5/§6). A cleared item represents money
that already posted; the reassignment only affects the still-open plan.
`ensureMaterialized` will seed a fresh, correctly-owned item for the new
account's open periods on the next request, exactly as it already does
for the tag-conversion case.

### 2. One-time data repair (this app has real production data)
Before or alongside the code fix, check whether this state ALREADY exists
in the production database today (categories that have been reassigned to
a different account in the past, leaving stale duplicate open-period line
items right now). Read-only investigation first:
```sql
-- Candidate stale rows: an uncleared, open-period line item whose
-- account_id no longer matches its category's CURRENT account_id
-- (falling back to the default account when NULL, same resolution as
-- templateOwnsAccount).
SELECT li.id, li.pay_period_id, li.category_template_id, li.account_id AS item_account,
       ct.account_id AS category_account
FROM line_items li
JOIN category_templates ct ON ct.id = li.category_template_id
JOIN pay_periods pp ON pp.id = li.pay_period_id
WHERE NOT li.cleared AND pp.closed_at IS NULL
  AND li.account_id IS DISTINCT FROM COALESCE(ct.account_id, <that budget's default account id>)
```
If this finds real rows in the live database: write a migration that
deletes them (same shape as the code fix's DELETE, scoped to rows whose
`item_account` disagrees with the category's current resolved owner) —
following the account-first-periods migration's model for a data-altering
migration under CONSTITUTION.md §6 (state the conservation reasoning in
writing, confirm it's additive-safe: only removes rows that are already
wrong/duplicated, never a legitimate single owner's plan). If it finds
nothing, no migration is needed — just ship the code fix.

**This step touches real production data — do not run any repair query
against the live database without the user's explicit go-ahead on the
exact DELETE, after the read-only investigation reports back what it
found.**

## Explicitly out of scope for this fix

The investigation also suggested a broader change: making
`getPeriodDetail`/`materializedSummaries`/`buildProjection` resolve
ownership via `ct.account_id ?? defaultAccountId` (the `templateOwnsAccount`
predicate) instead of the line item's own frozen `account_id`, "so display
and money totals can't silently diverge from a category's current
ownership again." That is a materially larger change touching the core
balance-computation path used by every account, every period, every
report — real value, but real blast radius, and it isn't needed to stop
today's double-count (the reconciliation in §1 does that by preventing the
stale row from ever existing). Treat it as a separate, later hardening
task if the user wants it; do not fold it into this fix.

## Verification

- Reproduce the exact repro from the investigation (category owned by
  account B, reassign to account A while an uncleared open-period line
  item exists) → after the fix, account B's stale item is gone, account
  A's period shows the item once, `plannedExpenses`/`estBalance` on
  account B no longer include it.
- A CLEARED line item under the old account, same category, same
  scenario → survives unchanged (cleared history is never touched).
- A line item in a CLOSED period under the old account → survives
  unchanged.
- Converting `recurring`→`tag` AND reassigning `accountId` in the same
  PATCH call → stale items deleted exactly once, no double-delete error.
- Regression: a PATCH that does NOT change `accountId` (only renames, only
  changes amount/recurrence) → no line items touched at all.
- Isolated ephemeral DB only for all destructive verification, per
  [[paycycle-destructive-check-isolation]] — never the shared dev DB.
- security-checker + build-checker both required (financial data +
  data-mutating route).

## Scope

`server/routes/categories.js` (the `PATCH /:id` handler). A migration file
under `migrations/` ONLY if the read-only production check in step 2 finds
real stale rows — confirm with the user before writing/running it.
