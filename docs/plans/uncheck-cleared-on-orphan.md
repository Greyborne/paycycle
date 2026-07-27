# Build spec — auto-uncheck `cleared` when its last transaction is removed

Status: not started. Prod data-correctness bug, found by the user
2026-07-26 testing the new Tier 1 bulk-delete feature against SimpleFin.

## Root cause (confirmed by reading code, not yet reproduced)

`recomputeLineItemActual` (`server/services/budget.js:264-271`) is the
single shared helper every transaction-removal path calls to keep
`cleared_amount_cents` in sync: `DELETE /transactions/:id`
(`server/routes/transactions.js`), the new
`DELETE /accounts/:id/transactions` (Tier 1 bulk delete,
`server/routes/accounts.js`), and `assignCategory`'s un-assignment branch
(`server/routes/transactions.js`, the old-template recompute). It only
ever writes `cleared_amount_cents`; it never touches the `cleared`
boolean. So when the last transaction backing a cleared line item is
removed, the checkbox on `PeriodDetail.jsx` (`checked={item.cleared}`,
line 124) stays checked with nothing behind it (`cleared_amount_cents`
NULL).

This then explains a second symptom the user independently noticed:
`server/routes/reports.js:33` computes cleared totals as
`COALESCE(SUM(COALESCE(li.cleared_amount_cents, li.planned_amount_cents))
FILTER (WHERE li.cleared), 0)` — filtered on the `cleared` bool, falling
back to the *planned* amount when the actual is NULL. A stale-checked
item with no transaction reports as if its planned amount cleared —
phantom activity on Reports for an account whose transactions were just
deleted. Fixing the root cause (the checkbox never gets orphaned in the
first place) should make Reports self-correct with no changes needed
there — verify this explicitly rather than assuming it.

## The constraint that makes this NOT a simple "always uncheck on NULL"

`cleared_amount_cents IS NULL` is legitimately overloaded (migration 015's
own comment, `line_item_actuals.sql`): it means either (a) nothing has
ever backed this cleared item — a manual tick with no linked transaction,
by design (e.g. a cash bill) — or (b) something used to back it and no
longer does. These two states are indistinguishable from the CURRENT row
alone. The fix must only fire on the (b) transition: `cleared_amount_cents`
had a real value, an operation just recomputed it to NULL, and `cleared`
was TRUE. If it was already NULL beforehand (case a), do nothing — leave
the manual tick as the user set it.

## Fix

`server/services/budget.js`, `recomputeLineItemActual`: extend the single
`UPDATE line_items SET cleared_amount_cents = $1 ...` into one statement
that also conditionally clears `cleared`/`cleared_date`, keyed off the
row's OWN pre-update value (Postgres evaluates every `SET` expression in
one `UPDATE` against the pre-update row, so referencing
`cleared_amount_cents`/`cleared` in the new expressions is safe and reads
the OLD values, not `$1`):

```sql
UPDATE line_items
SET cleared_amount_cents = $1,
    cleared = CASE WHEN cleared_amount_cents IS NOT NULL AND $1 IS NULL AND cleared
                   THEN FALSE ELSE cleared END,
    cleared_date = CASE WHEN cleared_amount_cents IS NOT NULL AND $1 IS NULL AND cleared
                   THEN NULL ELSE cleared_date END
WHERE pay_period_id = $2 AND category_template_id = $3
```

This is the only code change needed — it's the shared helper, so every
caller (Transactions page delete, Tier 1 bulk delete, re-categorization)
gets the corrected behavior automatically. No changes to
`reports.js`/`periods.js`/frontend needed; verify Reports self-corrects
as a consequence, don't just assume it.

## Explicitly out of scope

The user has flagged that this makes them want to reconsider the
`cleared` checkbox concept more broadly (should it be manual at all vs.
fully derived from transaction presence?). That is a separate planning
conversation, not part of this fix. This fix only stops the checkbox from
going stale when transactions are deleted — it does not change what
"cleared" means or how it's set in any other flow.

## Verification

- Recurring category cleared by a transaction (`cleared_amount_cents` =
  some value, `cleared` = TRUE) → delete that transaction (via
  Transactions page delete, or the new Tier 1 bulk delete) → line item's
  `cleared` becomes FALSE, `cleared_date` becomes NULL,
  `cleared_amount_cents` is NULL. Checkbox unchecked, "—" shown.
- A line item manually ticked `cleared = TRUE` with NO transaction ever
  linked (`cleared_amount_cents` already NULL beforehand) → any recompute
  call for that (period, template) pair leaves `cleared`/`cleared_date`
  untouched. This is the critical regression guard — get this scenario
  wrong and manual cash-bill clearing breaks silently.
- A line item with TWO transactions backing it → delete one → the other's
  amount remains, `cleared_amount_cents` recomputes to a non-NULL value,
  `cleared` stays TRUE (no false uncheck when some backing remains).
- Closed periods: unaffected — every caller of `recomputeLineItemActual`
  already blocks closed-period mutation before reaching this helper;
  confirm this still holds, don't just assume.
- Reports: seed the exact scenario the user hit (a category cleared by a
  SimpleFin-imported transaction, delete the transaction via
  `DELETE /accounts/:id/transactions`) → `GET /reports/summary` for that
  month/category no longer reports the planned amount as cleared.
- Isolated ephemeral DB only, per [[paycycle-destructive-check-isolation]].
- build-checker + security-checker (financial data, shared helper touched
  by multiple money-affecting routes).

## Scope

`server/services/budget.js` (`recomputeLineItemActual` only). No schema
change, no migration (this only affects future recomputes going forward —
see the note below on already-affected data).

## Note: data already affected by today's testing

The user already exercised the Tier 1 bulk-delete feature against a real
SimpleFin account before this fix existed, so some real line items may
already be stuck checked-with-no-backing right now. This fix does not
retroactively repair them (a fresh recompute of an already-NULL value
can't detect the transition after the fact — see the constraint above).
After this fix ships, do a READ-ONLY query against the real dev DB to
find any currently-cleared, currently-NULL-actual line items in open
periods, report them to the user, and let them decide (manually uncheck
via the UI, since only they know which are legitimate manual ticks vs.
stale). Do not auto-repair this ambiguously without the user's input.
