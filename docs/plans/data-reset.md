# Build spec — per-account data reset & account delete

Status: **not started** — plan only, awaiting boss sign-off before staffing.

## Context

Phase 1 of this roadmap (stale `cleared_amount_cents` bug fix + the
non-destructive "Recalculate actuals" button) is **already shipped** —
see `docs/plans/recompute-actuals.md`. This plan covers the next,
destructive phase: giving a user a way to wipe and/or re-date an
account's data, and to delete an account outright, for the "fresh start,
keep structure" case (mirrors the user's prior 20-year spreadsheet
workflow) and for genuinely closing a real bank account.

**Ordering principle carried over from the roadmap:** these tiers only
make sense on top of a correct actuals cache. That dependency is already
satisfied.

## Schema recap (verified in migrations/, 2026-07-26)

Account-scoped ownership, post `013_account_first_periods` /
`004_accounts_notifications`:

- `accounts` — one row per tracked account, `budget_id` FK, `is_default`
  (exactly one live default enforced by `accounts_one_default`).
- `pay_period_configs` / `pay_periods` — **one row per account**
  (`account_id NOT NULL ... ON DELETE CASCADE`), not per budget.
- `line_items` — child of `pay_periods` (`ON DELETE CASCADE`); also
  carries its own `account_id` (`ON DELETE SET NULL`, which is moot once
  the parent period cascades away).
- `transactions` — child of `pay_periods` (`ON DELETE CASCADE`);
  `category_template_id` is `ON DELETE SET NULL`, `account_id` is
  `ON DELETE SET NULL`.
- `category_templates` — **budget-owned**, not account-owned by FK,
  but effectively account-scoped via `account_id` (`ON DELETE SET NULL`,
  nullable = "owned by whatever the default account is" — the exact
  `template.account_id ?? getDefaultAccountId()` pattern already used
  everywhere, per [[paycycle-rules-account-scoped-build]]). **Categories
  are never deleted by any of these tiers** — deleting or resetting an
  account only unassigns/reassigns their ownership.
- `category_rules` — budget-owned, scoped in practice through the
  category they point at (same pattern as categories).
- `simplefin_account_links.account_id` — `ON DELETE SET NULL`: deleting
  an account silently un-syncs any linked bank connection rather than
  erroring.
- **No existing hard-delete for an account** — `accounts.js` only ever
  archives (`archived` boolean via PATCH). This plan adds the first real
  `DELETE`.
- **No existing bulk category delete** — categories are only archived
  today. Out of scope here (matches the roadmap's "separate, rare" note
  on a delete-categories tier); not building it in this pass.

## Tiers

### Tier 1 — Delete all transactions for an account
Wipes every `transactions` row for the account. Leaves periods,
`line_items`, categories, and plan untouched — but every recurring line
item's `cleared_amount_cents` must be recomputed afterward (now zero
matching transactions), so this reuses `recomputeLineItemActual` /
`recalculateOpenPeriodActuals` from the shipped Recalculate work, scoped
to this account's open periods. **Closed periods' transactions are left
alone** — their `closed_snapshot` is the frozen audited record (§5); this
tier only ever touches open-period transactions, same as every other
mutation path in this codebase.

- Route: `DELETE /accounts/:id/transactions`
- One DB transaction: `DELETE FROM transactions WHERE account_id = $1
  AND pay_period_id IN (<this account's OPEN periods>)`, then recompute
  every touched line item.
- Response: `{ deleted: <count> }`.

### Tier 2 — Reset account
The "fresh start, keep structure" tier. Wipes the account's transactions
**and** its open pay_periods/line_items (closed periods are never
touched — see below), keeps categories, and lets the user re-date the
account's `started_on` (tracking-begins date, `accounts.started_on` from
migration 010) to the new starting point, same as onboarding's existing
`resolveStartedOn` snap-to-period-boundary logic.

- Route: `POST /accounts/:id/reset` — body: `{ startedOn, closedPeriods:
  'block' | 'confirm' }` (see closed-period handling below).
- One DB transaction:
  1. Delete `transactions` for this account's open periods.
  2. Delete `line_items` for this account's open periods (cascades from
     deleting the `pay_periods` rows themselves, since `line_items` is a
     CASCADE child).
  3. Delete the account's **open** `pay_periods` rows.
  4. Update `accounts.started_on` to the new date (snapped to a period
     boundary via the existing `resolveStartedOn` helper).
  5. Categories, `category_rules`, and `category_amount_history` are
     untouched — the whole point is to keep them.
- **Closed periods:** never deleted or altered by this tier (they are
  the audited record, §5). Default behavior is to **block** the reset if
  the account has any closed periods, with a clear error naming the
  earliest one, since resetting the tracking start date to *before* a
  closed period would be nonsensical (the closed snapshot would predate
  the account's own claimed start). If the requested `startedOn` is
  *after* the last closed period, the closed periods aren't touched at
  all and the reset proceeds normally — only the open tail is wiped.
- Response: `{ deletedTransactions, deletedPeriods, startedOn }`.

### Tier 3 — Delete account
Hard-deletes the `accounts` row itself (for closing a real bank
account). Relies on the existing cascade graph — no new cascade logic
needed, just the guard rails:

- Route: `DELETE /accounts/:id`
- Guards (mirror [[paycycle-account-deletion]]'s pattern, scoped down
  from household to account):
  - **Budget-scoped, never client-trusted id beyond `req.budget.id`
    ownership** — IDOR-safe by construction (same `WHERE budget_id = $1`
    every other route here uses).
  - **Refuse if this is the household's only account** — a budget must
    always have ≥1 account (onboarding invariant).
  - **Refuse if this is the live default account** (`is_default AND NOT
    archived`) — require the caller to make another account default
    first, exactly like the existing archive guard in
    `accounts.js:188`. Reuse that same check, don't reinvent it.
  - **Race guard:** `SELECT id FROM accounts WHERE id = $1 FOR UPDATE`
    at the top of the transaction before re-checking is-default/
    is-only-account, mirroring the `FOR UPDATE` fix from
    [[paycycle-account-deletion]] — a concurrent PATCH that flips another
    account's `is_default` or archives the last sibling account must not
    race this delete.
  - **Closed periods on this account are deleted too** (cascade) — this
    is a deliberate, harder line than Tier 1/2: the account itself is
    going away, so its frozen snapshots go with it. This is the
    irreversible step; call it out plainly in the confirm UI (see
    below) and in the CONSTITUTION §6d one-way-decision sense, in
    writing here: **no down path** — recovery from an unwanted account
    delete is a full database restore, not an in-app undo.
- One transaction: `DELETE FROM accounts WHERE id = $1` (cascades do the
  rest); categories/rules previously owned by this account fall back to
  `getDefaultAccountId()` automatically via the existing nullable-FK
  pattern — no extra code needed, but the checker must prove it.
- Response: `204`.

## Confirmation UI (all three tiers)

No existing "type to confirm" component exists in this codebase — every
current destructive action uses a plain `window.confirm()` (Transactions
bulk delete, Rules delete, HouseholdCard leave/remove). Tiers 2 and 3 are
irreversible enough (Tier 2 deletes real transaction history; Tier 3
deletes an account and its closed audited periods) to warrant more than
that:

- **Tier 1:** a `window.confirm()` naming the transaction count is
  sufficient — matches the existing bulk-delete pattern
  (`Transactions.jsx:169`), same blast radius class.
- **Tier 2 and 3:** a small inline confirm control — type the account's
  exact name into a text input before the action button enables. This is
  a new *interaction* but not a new *visual* pattern: build it from
  existing `.card` / input / `.btn` tokens (§4), no new component
  library entry. Flag it to design-checker anyway since it's a new
  control shape, even though it reuses tokens.
- Both settings live in a "Danger zone" section of `AccountsCard.jsx` (or
  a per-account row action, matching where account editing already
  lives) — not `Settings.jsx`'s "Maintenance" section, since these are
  scoped to one account, not the whole household.

## Security / integrity (§3, §5, §6 — this is financial data)

- All three routes are authed + budget-scoped; verify no route accepts
  an account id outside `req.budget.id`.
- Tier 1/2 must provably never touch a closed period's transactions,
  `line_items`, or the period row itself — checker proves this with a
  seeded closed period that survives byte-for-byte.
- Tier 3's cascade-deletes-closed-periods behavior is the one deliberate
  exception to the "closed periods are frozen" rule elsewhere in this
  app — call this out explicitly to every checker so it isn't flagged as
  a regression; it's a documented, in-scope design decision, not a bug.
- **Conservation check inverted for this feature:** every other §5/§6
  rule in this app is about *not* losing financial data by accident.
  These routes exist specifically to delete data on purpose. The
  invariant to prove instead: **nothing is deleted outside the account
  the caller targeted** — no cross-account leakage, no other household's
  rows touched, no accidental full-budget wipe from a malformed WHERE
  clause missing its account/budget scope.
- Rate limiting: not needed (authed, low-frequency, destructive-by-intent
  actions), but keep the existing auth/session checks (§3) in front of
  all three routes.
- Per [[paycycle-destructive-check-isolation]]: **every checker for this
  build must use its own isolated ephemeral DB, never the shared dev
  stack, and checkers must run one at a time, not in parallel.**

## Verification

- Tier 1: seed an account with transactions in both an open and a closed
  period → delete → open-period transactions gone, actuals recomputed
  (drop to "—" or the new sum); closed-period transactions and its
  `closed_snapshot` byte-for-byte unchanged.
- Tier 2: seed an account with open periods (some with transactions) and
  one closed period → reset with a `startedOn` after the closed period →
  open periods/line_items/transactions gone, `started_on` updated,
  categories/rules untouched, closed period untouched. Also test the
  block case: `startedOn` before/at the closed period → 4xx naming it,
  nothing deleted.
- Tier 3: seed a non-default, non-only account with transactions across
  open and closed periods, plus a category and a rule owned by it →
  delete → account gone, all its periods/line_items/transactions gone
  (including the closed one — expected here), the category and rule
  survive and now resolve to the household's default account
  (`getDefaultAccountId()`), no other account's data touched. Also test
  the two refusal paths (only account, live default) and the
  concurrent-request race per the `FOR UPDATE` guard.
- Regression: an unrelated second account in the same budget is
  byte-for-byte unchanged after any tier runs on the first.

## Scope

`server/routes/accounts.js` (new routes + reused archive-guard logic),
`server/services/budget.js` (reuse `recomputeLineItemActual`/
`recalculateOpenPeriodActuals`, `getDefaultAccountId`; no schema change
needed for tiers 1–3), `web/src/components/AccountsCard.jsx` (new Danger
zone UI, inline type-to-confirm control), tests. No migration required —
this plan is pure routes + cascade behavior already defined by existing
FKs.
