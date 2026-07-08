-- One-time cleanup adopting the period lifecycle (007) onto pre-existing data.
--
-- 1. Line items tied to ARCHIVED categories are legacy strays: they render as
--    planned rows for categories that no longer appear in the master list.
--    Reclassify them as misc transactions — a cleared item becomes a misc
--    (uncategorized) transaction with the same amount/account, an uncleared
--    one simply goes away (it never happened). The est/cleared balance chains
--    are unchanged for cleared items (both sides count misc exactly like a
--    cleared item). The 'Close-out adjustment' template is archived by design
--    and its items are the est-side correction lever — never touch those.
INSERT INTO transactions (budget_id, user_id, pay_period_id, category_template_id, type, amount_cents, description, date, account_id)
SELECT pp.budget_id, NULL, li.pay_period_id, NULL, ct.type, li.planned_amount_cents,
       ct.name, COALESCE(li.cleared_date, pp.start_date), li.account_id
FROM line_items li
JOIN category_templates ct ON ct.id = li.category_template_id
JOIN pay_periods pp ON pp.id = li.pay_period_id
WHERE ct.archived AND ct.name <> 'Close-out adjustment'
  AND li.cleared AND li.planned_amount_cents <> 0;

DELETE FROM line_items li
USING category_templates ct
WHERE ct.id = li.category_template_id
  AND ct.archived AND ct.name <> 'Close-out adjustment';

-- 2. Every period that fully ended before today is considered closed and
--    reconciled: bulk-clear its remaining planned items and mark it closed.
--    The frozen cleared-balance snapshot needs the projection engine, so the
--    server backfills closed_snapshot at boot for any closed period missing
--    one.
UPDATE line_items li
SET cleared = TRUE, cleared_date = COALESCE(li.cleared_date, pp.end_date)
FROM pay_periods pp
WHERE pp.id = li.pay_period_id
  AND pp.end_date < CURRENT_DATE AND pp.closed_at IS NULL
  AND NOT li.cleared
  AND NOT EXISTS (
    SELECT 1 FROM category_templates ct
    WHERE ct.id = li.category_template_id AND ct.archived AND ct.name = 'Close-out adjustment'
  );

UPDATE pay_periods SET closed_at = now()
WHERE end_date < CURRENT_DATE AND closed_at IS NULL;
