-- Multiple tracked bank accounts per household, and per-user notification
-- dismissals.
--
-- The estimated-balance projection stays budget-wide (it projects the
-- household's total position); accounts split the ACTUAL side: starting
-- balances live on accounts, and cleared line items / transactions are
-- attributed to the account they hit.

CREATE TABLE accounts (
  id                     SERIAL PRIMARY KEY,
  budget_id              INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  type                   TEXT NOT NULL DEFAULT 'checking'
                           CHECK (type IN ('checking', 'savings', 'credit', 'cash', 'other')),
  starting_balance_cents INTEGER NOT NULL DEFAULT 0,
  is_default             BOOLEAN NOT NULL DEFAULT FALSE,
  archived               BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order             INTEGER NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX accounts_budget ON accounts (budget_id);
-- Exactly one live default per household.
CREATE UNIQUE INDEX accounts_one_default ON accounts (budget_id) WHERE is_default AND NOT archived;

-- Every existing household gets a default account carrying its old starting
-- balance.
INSERT INTO accounts (budget_id, name, starting_balance_cents, is_default)
SELECT id, 'Primary account', starting_balance_cents, TRUE FROM budgets;

ALTER TABLE budgets DROP COLUMN starting_balance_cents;

-- Which account a category normally clears from/to (NULL = the default
-- account at the time the period is materialized).
ALTER TABLE category_templates ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;

-- Which account a line item's cleared amount hits.
ALTER TABLE line_items ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
UPDATE line_items li SET account_id = a.id
FROM pay_periods pp, accounts a
WHERE li.pay_period_id = pp.id AND a.budget_id = pp.budget_id AND a.is_default;

-- Which account a transaction hit.
ALTER TABLE transactions ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
UPDATE transactions t SET account_id = a.id
FROM accounts a WHERE a.budget_id = t.budget_id AND a.is_default;

-- Per-user dismissals of computed notifications, keyed by a stable id like
-- "bill:12:2026-07-10" so an instance stays hidden once dismissed.
CREATE TABLE notification_dismissals (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);
