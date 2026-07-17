-- Account-first pay periods (Phase 1a of docs/plans/account-first-periods.md).
--
-- The account becomes the primary period entity; "household" (budget)
-- becomes a pure roll-up. This migration re-platforms both
-- pay_period_configs and pay_periods from one row per budget to one row
-- per account, and repoints every line_items/transactions row that was
-- attached to the old household-wide period onto the new account-scoped
-- period for the same account and start_date.
--
-- Snapshot scoping: pay_periods.closed_snapshot used to be a household-wide
-- object {"total": <cents>, "accounts": {"<accountId>": <cents>}}. Each new
-- row now represents exactly one account, so its closed_snapshot collapses
-- to {"total": <cents>} — that account's own value pulled out of the old
-- "accounts" map (NULL if that account had no entry there). closed_at is
-- copied byte-for-byte from the original row so a period's close timestamp
-- never changes.
--
-- NULL-account rule: line_items/transactions with account_id IS NULL
-- (legacy rows predating per-line-item accounts) are repointed to that
-- budget's live default account's new period (is_default AND NOT archived —
-- exactly one is guaranteed to exist per accounts_one_default).
--
-- Non-archived-account rule, with a conservation guard: per the brief, a
-- config/period row is created for every NON-ARCHIVED account in the
-- budget. However, an ARCHIVED account can still be the account_id on
-- historical line_items/transactions (an account is commonly archived
-- *after* it accumulated activity), and pay_periods rows are the parent of
-- those children via ON DELETE CASCADE. Creating periods for non-archived
-- accounts only, then deleting the old household rows, would silently
-- cascade-delete any such archived-account history — a conservation
-- violation (CONSTITUTION.md §5/§6). So this migration also creates a
-- period row for any ARCHIVED account that has at least one line_items or
-- transactions row on that specific old period, so every child has a home
-- before the old row is removed. pay_period_configs has no children (it
-- only steers *future* materialization), so it is left exactly per the
-- literal brief: non-archived accounts only.
--
-- One-way / recovery (CONSTITUTION.md §6d): this migration is NOT
-- reversible in place. The original household-wide pay_periods rows (and,
-- for configs, the original budget-level rows) are deleted once their data
-- has been copied/repointed, so there is no down-migration that
-- reconstructs them losslessly. Recovery from a bad run is by restoring
-- the pre-migration database backup, not by an in-database rollback.
--
-- Idempotency: every DDL step uses IF NOT EXISTS / IF EXISTS guards, and
-- every data step is scoped to rows that still look "unmigrated"
-- (account_id IS NULL). After one successful run there are no
-- account-less pay_period_configs or pay_periods rows left, so re-running
-- this file finds nothing to do and is a safe no-op.

-- ---------------------------------------------------------------------
-- A. pay_period_configs -> per account
-- ---------------------------------------------------------------------

ALTER TABLE pay_period_configs
  ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE;

-- Drop the old budget-level uniqueness before inserting multiple per-account
-- rows for the same budget_id below (they would otherwise collide with it).
ALTER TABLE pay_period_configs DROP CONSTRAINT IF EXISTS pay_period_configs_budget_unique;

-- One config row per non-archived account, copied from that account's
-- budget-level config. Only touches configs not yet split (account_id IS
-- NULL), so a second run is a no-op.
INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date, day_1, day_2, interval_days, updated_at)
SELECT c.budget_id, a.id, c.cadence, c.anchor_date, c.day_1, c.day_2, c.interval_days, c.updated_at
FROM pay_period_configs c
JOIN accounts a ON a.budget_id = c.budget_id AND NOT a.archived
WHERE c.account_id IS NULL;

-- Remove the old budget-level rows now that every non-archived account has
-- its own copy. A budget with zero non-archived accounts leaves no
-- per-account rows above, so this simply removes its now-orphaned,
-- account-less config rather than leaving one referencing account_id NULL.
DELETE FROM pay_period_configs WHERE account_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pay_period_configs_account_unique'
  ) THEN
    ALTER TABLE pay_period_configs
      ADD CONSTRAINT pay_period_configs_account_unique UNIQUE (account_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- B. pay_periods -> per account (the data split)
-- ---------------------------------------------------------------------

ALTER TABLE pay_periods
  ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE;

-- Drop the old (budget_id, start_date) uniqueness before inserting multiple
-- per-account rows below that share a budget_id/start_date (they would
-- otherwise collide with it). The old account-less rows themselves are
-- unaffected by this and still get matched/deleted further down.
ALTER TABLE pay_periods DROP CONSTRAINT IF EXISTS pay_periods_budget_start_unique;

-- One new period row per account that needs one: every non-archived
-- account of the budget, plus any archived account that still has
-- line_items/transactions attached to this specific old (account-less)
-- period. Scoped to account-less old rows, so a second run finds none.
WITH old_periods AS (
  SELECT * FROM pay_periods WHERE account_id IS NULL
),
period_accounts AS (
  SELECT op.id AS old_period_id, op.budget_id, op.start_date, op.end_date,
         op.created_at, op.closed_at, op.closed_snapshot, a.id AS account_id
  FROM old_periods op
  JOIN accounts a ON a.budget_id = op.budget_id AND NOT a.archived
  UNION
  SELECT op.id, op.budget_id, op.start_date, op.end_date,
         op.created_at, op.closed_at, op.closed_snapshot, a.id
  FROM old_periods op
  JOIN accounts a ON a.budget_id = op.budget_id AND a.archived
  WHERE EXISTS (
    SELECT 1 FROM line_items li WHERE li.pay_period_id = op.id AND li.account_id = a.id
    UNION ALL
    SELECT 1 FROM transactions t WHERE t.pay_period_id = op.id AND t.account_id = a.id
  )
)
INSERT INTO pay_periods (budget_id, account_id, start_date, end_date, created_at, closed_at, closed_snapshot)
SELECT budget_id, account_id, start_date, end_date, created_at, closed_at,
       CASE WHEN closed_at IS NULL THEN NULL
            ELSE jsonb_build_object('total', (closed_snapshot -> 'accounts' ->> account_id::text)::integer)
       END
FROM period_accounts;

-- Repoint every line_items/transactions row off the old household period
-- onto the new account-scoped period for the same account and start_date.
-- NULL account_id -> that budget's live default account.
-- (A plain comma-join, not an explicit JOIN ... ON, so the WHERE clause can
-- reference the target table's own columns — Postgres disallows that
-- inside an explicit JOIN's ON clause in an UPDATE ... FROM.)
UPDATE line_items li
SET pay_period_id = new_pp.id
FROM pay_periods old_pp, pay_periods new_pp
WHERE li.pay_period_id = old_pp.id
  AND old_pp.account_id IS NULL
  AND new_pp.budget_id = old_pp.budget_id
  AND new_pp.start_date = old_pp.start_date
  AND new_pp.account_id = COALESCE(
        li.account_id,
        (SELECT def.id FROM accounts def WHERE def.budget_id = old_pp.budget_id AND def.is_default AND NOT def.archived)
      );

UPDATE transactions t
SET pay_period_id = new_pp.id
FROM pay_periods old_pp, pay_periods new_pp
WHERE t.pay_period_id = old_pp.id
  AND old_pp.account_id IS NULL
  AND new_pp.budget_id = old_pp.budget_id
  AND new_pp.start_date = old_pp.start_date
  AND new_pp.account_id = COALESCE(
        t.account_id,
        (SELECT def.id FROM accounts def WHERE def.budget_id = old_pp.budget_id AND def.is_default AND NOT def.archived)
      );

-- Guard: refuse to proceed (and roll back the whole migration transaction)
-- if any child row is still attached to a household (account-less) period.
-- If this fires, the account/period matching above missed a case and the
-- old rows must NOT be deleted.
DO $$
DECLARE
  stray_line_items INTEGER;
  stray_transactions INTEGER;
BEGIN
  SELECT count(*) INTO stray_line_items
  FROM line_items li JOIN pay_periods pp ON pp.id = li.pay_period_id
  WHERE pp.account_id IS NULL;

  SELECT count(*) INTO stray_transactions
  FROM transactions t JOIN pay_periods pp ON pp.id = t.pay_period_id
  WHERE pp.account_id IS NULL;

  IF stray_line_items > 0 OR stray_transactions > 0 THEN
    RAISE EXCEPTION
      'account_first_periods: % line_items and % transactions still attached to household periods; aborting before delete',
      stray_line_items, stray_transactions;
  END IF;
END $$;

-- Every child has moved to an account-scoped period; safe to remove the
-- old household-wide rows. Nothing cascades away.
DELETE FROM pay_periods WHERE account_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pay_periods_account_start_unique'
  ) THEN
    ALTER TABLE pay_periods
      ADD CONSTRAINT pay_periods_account_start_unique UNIQUE (account_id, start_date);
  END IF;
END $$;

-- pay_periods_budget_dates (budget_id, start_date, end_date) stays: budget_id
-- is still a useful roll-up column (e.g. the Phase 5 household net-worth
-- view), so the household-wide index remains valid. Add the account-scoped
-- equivalent alongside it.
CREATE INDEX IF NOT EXISTS pay_periods_account_dates ON pay_periods (account_id, start_date, end_date);
