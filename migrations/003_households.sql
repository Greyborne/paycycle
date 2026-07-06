-- Shared household budgets. A "budget" (household) owns all budget data;
-- users are members of exactly one budget at a time. Existing users each get
-- a household carrying over their settings and data.

CREATE TABLE budgets (
  id                      SERIAL PRIMARY KEY,
  name                    TEXT NOT NULL DEFAULT 'My household',
  currency                TEXT NOT NULL DEFAULT 'USD',
  starting_balance_cents  INTEGER NOT NULL DEFAULT 0,
  threshold_low_cents     INTEGER NOT NULL DEFAULT 20000,
  threshold_healthy_cents INTEGER NOT NULL DEFAULT 100000,
  warning_threshold_cents INTEGER NOT NULL DEFAULT 0,
  onboarding_complete     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  migrated_user_id        INTEGER
);

CREATE TABLE budget_members (
  id         SERIAL PRIMARY KEY,
  budget_id  INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  -- UNIQUE user_id enforces the one-household-per-user model.
  user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX budget_members_budget ON budget_members (budget_id);

CREATE TABLE budget_invites (
  id         SERIAL PRIMARY KEY,
  budget_id  INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  code       TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One household per existing user, carrying over their per-user settings.
INSERT INTO budgets (name, currency, starting_balance_cents, threshold_low_cents,
                     threshold_healthy_cents, warning_threshold_cents, onboarding_complete,
                     created_at, migrated_user_id)
SELECT split_part(email, '@', 1) || '''s household', currency, starting_balance_cents,
       threshold_low_cents, threshold_healthy_cents, warning_threshold_cents,
       onboarding_complete, created_at, id
FROM users;

INSERT INTO budget_members (budget_id, user_id, role)
SELECT id, migrated_user_id, 'owner' FROM budgets WHERE migrated_user_id IS NOT NULL;

-- Re-parent all budget-scoped tables from user_id to budget_id.

ALTER TABLE pay_period_configs ADD COLUMN budget_id INTEGER REFERENCES budgets(id) ON DELETE CASCADE;
UPDATE pay_period_configs t SET budget_id = b.id FROM budgets b WHERE b.migrated_user_id = t.user_id;
ALTER TABLE pay_period_configs ALTER COLUMN budget_id SET NOT NULL;
ALTER TABLE pay_period_configs DROP COLUMN user_id;
ALTER TABLE pay_period_configs ADD CONSTRAINT pay_period_configs_budget_unique UNIQUE (budget_id);

ALTER TABLE pay_periods ADD COLUMN budget_id INTEGER REFERENCES budgets(id) ON DELETE CASCADE;
UPDATE pay_periods t SET budget_id = b.id FROM budgets b WHERE b.migrated_user_id = t.user_id;
ALTER TABLE pay_periods ALTER COLUMN budget_id SET NOT NULL;
ALTER TABLE pay_periods DROP COLUMN user_id;
ALTER TABLE pay_periods ADD CONSTRAINT pay_periods_budget_start_unique UNIQUE (budget_id, start_date);
CREATE INDEX pay_periods_budget_dates ON pay_periods (budget_id, start_date, end_date);

ALTER TABLE category_templates ADD COLUMN budget_id INTEGER REFERENCES budgets(id) ON DELETE CASCADE;
UPDATE category_templates t SET budget_id = b.id FROM budgets b WHERE b.migrated_user_id = t.user_id;
ALTER TABLE category_templates ALTER COLUMN budget_id SET NOT NULL;
ALTER TABLE category_templates DROP COLUMN user_id;
CREATE INDEX category_templates_budget ON category_templates (budget_id);

ALTER TABLE import_rules ADD COLUMN budget_id INTEGER REFERENCES budgets(id) ON DELETE CASCADE;
UPDATE import_rules t SET budget_id = b.id FROM budgets b WHERE b.migrated_user_id = t.user_id;
ALTER TABLE import_rules ALTER COLUMN budget_id SET NOT NULL;
ALTER TABLE import_rules DROP COLUMN user_id;
ALTER TABLE import_rules ADD CONSTRAINT import_rules_budget_pattern_unique UNIQUE (budget_id, pattern);

-- Transactions belong to the budget; user_id remains as "entered by" and
-- survives the member being removed.
ALTER TABLE transactions ADD COLUMN budget_id INTEGER REFERENCES budgets(id) ON DELETE CASCADE;
UPDATE transactions t SET budget_id = b.id FROM budgets b WHERE b.migrated_user_id = t.user_id;
ALTER TABLE transactions ALTER COLUMN budget_id SET NOT NULL;
ALTER TABLE transactions DROP CONSTRAINT transactions_user_id_fkey;
ALTER TABLE transactions ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE transactions ADD CONSTRAINT transactions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
DROP INDEX transactions_import_hash;
CREATE UNIQUE INDEX transactions_import_hash
  ON transactions (budget_id, import_hash) WHERE import_hash IS NOT NULL;
CREATE INDEX transactions_budget ON transactions (budget_id);

-- Per-user settings moved to the budget.
ALTER TABLE users
  DROP COLUMN currency,
  DROP COLUMN starting_balance_cents,
  DROP COLUMN threshold_low_cents,
  DROP COLUMN threshold_healthy_cents,
  DROP COLUMN warning_threshold_cents,
  DROP COLUMN onboarding_complete;

ALTER TABLE budgets DROP COLUMN migrated_user_id;
