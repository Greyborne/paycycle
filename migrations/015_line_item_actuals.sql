-- Planned vs actual on cleared line items (see
-- docs/plans/planned-vs-actual.md). `line_items.planned_amount_cents` used
-- to do double duty: it was the budgeted plan before an item cleared, AND
-- the figure the balance math counted afterwards - so a cleared recurring
-- item always contributed its *plan*, never the transaction that actually
-- cleared it, even when the two differed. This column separates them:
-- `planned_amount_cents` stays the budget; `cleared_amount_cents` records
-- what actually posted.
--
-- NULL vs 0 is meaningful and deliberately preserved everywhere this column
-- is written: NULL means "cleared, but no known transaction amount" (e.g. a
-- user ticked the cleared checkbox by hand with nothing linked) and falls
-- back to `planned_amount_cents` in every balance computation
-- (COALESCE(cleared_amount_cents, planned_amount_cents)); 0 means "cleared,
-- and the linked transaction(s) genuinely summed to zero." Never conflate
-- the two.
ALTER TABLE line_items ADD COLUMN IF NOT EXISTS cleared_amount_cents INTEGER NULL;

-- Backfill: OPEN periods only. This deliberately changes stored balances
-- for currently-open periods (recorded here per CONSTITUTION.md §5, which
-- requires calling out any migration that alters a household's cleared
-- position) - because the balance those open periods currently produce is
-- wrong, per the reported bug. Every cleared line item in a period with
-- closed_at IS NULL gets `cleared_amount_cents` set to the summed
-- `transactions.amount_cents` of the rows carrying that same
-- (category_template_id, pay_period_id) pair. `transactions.amount_cents`
-- is already stored non-negative (every writer - import.js, transactions.js,
-- simplefin.js - Math.abs()'s it before insert, matching the convention
-- server/services/budget.js's clearLineItemForTransaction already uses), so
-- a plain SUM is directly comparable to planned_amount_cents with no sign
-- juggling. Where no matching transaction exists the column is left NULL
-- (unchanged) - there is nothing to attribute, and the balance math already
-- falls back to the plan in that case.
--
-- CLOSED periods are deliberately left untouched. They carry a frozen
-- `closed_snapshot` - the recorded truth of what the cleared balance was at
-- close-out. Rewriting a closed period's line items after the fact would
-- silently contradict that snapshot, which is exactly what "closed" is
-- supposed to prevent (see migration 013's and periods.js's comments on
-- frozen/closed semantics). A closed period that is later reopened will
-- pick up the corrected behavior the next time its items are re-cleared,
-- same as any other line item.
--
-- Idempotency: scoped to cleared line items in open periods whose computed
-- sum differs from the currently-stored value (including NULL -> a real
-- transaction total, or a stale value -> a corrected total), so re-running
-- this file after a first successful run finds nothing left to update and
-- is a no-op. It is intentionally NOT scoped to "cleared_amount_cents IS
-- NULL" alone, because that would also re-touch (harmlessly) a row a
-- concurrent write already brought in line with the transactions table -
-- computing the same SUM twice is idempotent either way.
--
-- One-way / recovery (CONSTITUTION.md §6d): this is additive (a new nullable
-- column plus a value fill on open periods) and does not delete or resign
-- any existing row, so it is trivially reversible by setting the column
-- back to NULL (`UPDATE line_items SET cleared_amount_cents = NULL`) if a
-- bad run were ever suspected; no down-migration file is needed for that.
WITH totals AS (
  SELECT li.id AS line_item_id, SUM(t.amount_cents) AS actual_cents
  FROM line_items li
  JOIN pay_periods pp ON pp.id = li.pay_period_id
  JOIN transactions t
    ON t.pay_period_id = li.pay_period_id
   AND t.category_template_id = li.category_template_id
  WHERE li.cleared AND pp.closed_at IS NULL
  GROUP BY li.id
)
UPDATE line_items li
SET cleared_amount_cents = totals.actual_cents
FROM totals
WHERE li.id = totals.line_item_id
  AND li.cleared_amount_cents IS DISTINCT FROM totals.actual_cents;
