# Planned vs actual on cleared line items

**Status:** approved 2026-07-23. Reported by the operator from a real SimpleFIN
test account.

## The bug

`line_items.planned_amount_cents` does double duty: it is the plan before the
item clears, and it is the amount counted afterwards. There is no record of what
actually posted.

Account balances sum `planned_amount_cents` for **cleared** line items
(`server/services/budget.js:98-99`). Only uncategorized and tag transactions
contribute their real amounts. So a cleared recurring item contributes its
*plan*, never the transaction that cleared it.

Whether the plan gets snapped to reality depends on which path cleared it:

| Path | `updatePlanned` |
| --- | --- |
| CSV import (`server/routes/import.js:154`) | user's choice |
| Bank sync (`server/services/simplefin.js:467`) | always `true` |
| Manual / rule assign (`server/routes/transactions.js:153`) | **never passed → `false`** |

**The same transaction therefore produces a different balance depending on how
it was categorized.** Reproduced on real data: `TestPayday` planned $2,758.00,
actual pay of $2,564.48 assigned by rule, cleared balance reads $1,742.48
(= $1,000 start + $2,758 − $2,015.52 misc) when the truthful figure is
$1,548.96. Overstated by $193.52.

Even where the plan *is* snapped (import/sync), the plan is destroyed to do it —
you can no longer see what you had budgeted.

## Decision

Record the actual separately and show both. Chosen over "snap the plan
everywhere" (destroys the budget figure) and "fix only the balance" (leaves the
table contradicting the balance).

1. **Schema (migration `015_line_item_actuals.sql`).** Add
   `cleared_amount_cents INTEGER NULL` to `line_items`. `NULL` means "cleared
   with no known transaction amount" — e.g. the user ticked the checkbox by
   hand — and falls back to `planned_amount_cents` everywhere.

2. **Every clear path records the actual.** `clearLineItemForTransaction` sets
   `cleared_amount_cents` from the transaction. This replaces `updatePlanned` as
   the mechanism for balance correctness — `updatePlanned` stays exactly as it
   is, since it means something different (rewrite the *budget*, not the
   record of what happened) and is still what the drift flow drives.

3. **Balance math uses `COALESCE(cleared_amount_cents, planned_amount_cents)`**
   for cleared items, in every place balances are computed. Uncleared items keep
   using `planned_amount_cents`. Auditing every such site is part of the task —
   there is more than one.

4. **Multiple transactions on one line item.** A line item can be cleared by one
   transaction and then have another assigned to the same category and period.
   `cleared_amount_cents` must reflect the **sum** of the transactions
   categorized to that template in that period, not just the last one to land.
   Un-assigning a transaction must correspondingly reduce it, and clearing it to
   zero transactions must return the column to `NULL`, not `0` — those mean
   different things.

5. **Backfill: open periods only. This deliberately changes stored balances.**
   Recorded here explicitly per CONSTITUTION §5, which forbids silently altering
   a household's cleared position: this migration *does* change it, because the
   current figure is wrong. For each cleared line item in a period with
   `closed_at IS NULL`, set `cleared_amount_cents` to the summed amount of
   transactions carrying that `category_template_id` and `pay_period_id`. Where
   no such transaction exists, leave `NULL` (behavior unchanged).
   **Closed periods are not touched.** They carry frozen snapshots
   (`closed_snapshot`) that are the record of what was true at close; rewriting
   history behind them would contradict the snapshot and is not what "closed"
   means. A closed period reopened later will pick up the new behavior when its
   items are re-cleared.

6. **UI — the period table gains an Actual column.** Planned stays. Actual shows
   `cleared_amount_cents` when present, and an em-dash when not. The existing
   header/`.num`/tabular-figures conventions apply (CONSTITUTION §4) — this is a
   new column in an existing table, not a new pattern.

7. **UI — "plan this going forward" reachable from the period.** The mechanism
   already exists and must be reused, not rebuilt: `driftFor`
   (`budget.js:217`), `setAmountGoingForward` (`budget.js:301`), the
   `POST /categories/:id/amounts` endpoint, and `DriftNotices.jsx`'s
   "Plan {amount} going forward" button. Today that button only surfaces
   transiently on the Transactions page (`Transactions.jsx:187`), is dismissible,
   and is lost on reload — so a user looking at the period, which is where the
   discrepancy is visible, has no way to act on it. Surface the same action on
   the period row when planned and actual differ beyond the drift threshold.
   Reuse the existing endpoint and the existing copy for the button.

## Non-goals

- No change to `driftFor`'s threshold (`max(drift_threshold_cents ?? 500, 5% of
  planned)`).
- No change to closed-period snapshot semantics.
- No change to how misc/tag transactions are counted.

## Phases

Sequential; the migration is destructive-adjacent and the checkers share a DB.

- **Phase 1 — schema + backend.** Migration, `clearLineItemForTransaction`,
  every balance site, the un-assign path, the backfill.
  Checkers: build-checker (**data-migration/integrity check per CONSTITUTION §6
  is mandatory here** — conservation, attribution, idempotency, and the
  explicitly-changed-balance case proven on an isolated ephemeral DB) and
  security-checker (financial-data touch).
- **Phase 2 — UI.** Actual column, drift action on the period row.
  Checkers: build-checker, a11y-checker (rendered, both themes), design-checker.
