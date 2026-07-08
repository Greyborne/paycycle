-- When tracking begins for an account. The starting balance is understood as
-- the balance going into this date's pay period (i.e. as of the day before).
-- Pay periods before it hold no activity for the account, and categories on
-- the account default their "valid from" to it. NULL keeps the legacy
-- behavior (no start constraint — balance applies from the beginning of
-- recorded history).
ALTER TABLE accounts ADD COLUMN started_on DATE;

-- Existing accounts: anchor to the earliest recorded period so behavior is
-- unchanged (the balance already applied from the start of history).
UPDATE accounts a
SET started_on = (
  SELECT MIN(pp.start_date) FROM pay_periods pp WHERE pp.budget_id = a.budget_id
)
WHERE a.started_on IS NULL;
