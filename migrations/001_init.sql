-- PayCycle initial schema.
-- All monetary amounts are stored as integer cents (of the user's single
-- configured currency) to avoid floating-point drift.

CREATE TABLE users (
  id                      SERIAL PRIMARY KEY,
  email                   TEXT NOT NULL,
  password_hash           TEXT NOT NULL,
  currency                TEXT NOT NULL DEFAULT 'USD',
  starting_balance_cents  INTEGER NOT NULL DEFAULT 0,
  -- Balance-health color thresholds (personal risk tolerance, per user):
  --   balance <  0                  -> negative (red)
  --   balance <  threshold_low      -> danger   (pink)
  --   balance <  threshold_healthy  -> ok       (light blue)
  --   otherwise                     -> healthy  (solid blue)
  threshold_low_cents     INTEGER NOT NULL DEFAULT 20000,
  threshold_healthy_cents INTEGER NOT NULL DEFAULT 100000,
  -- Projection warning: flag the first future period whose projected balance
  -- drops below this value (0 = flag only when going negative).
  warning_threshold_cents INTEGER NOT NULL DEFAULT 0,
  onboarding_complete     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE TABLE pay_period_configs (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  cadence       TEXT NOT NULL CHECK (cadence IN ('weekly','biweekly','semimonthly','monthly','custom')),
  -- weekly/biweekly/custom: anchor_date is the start of any one period.
  anchor_date   DATE,
  -- semimonthly: day_1 and day_2 are the two period-start days of month.
  -- monthly: day_1 is the period-start day of month.
  day_1         SMALLINT,
  day_2         SMALLINT,
  -- custom: length of each period in days.
  interval_days SMALLINT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only real ("materialized") periods exist as rows: past and current periods
-- the user actually interacts with. Future periods are computed on the fly by
-- the projection engine and never stored.
CREATE TABLE pay_periods (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date   DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, start_date)
);

CREATE INDEX pay_periods_user_dates ON pay_periods (user_id, start_date, end_date);

CREATE TABLE category_templates (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('expense','income')),
  -- every_period: applies once to every pay period.
  -- monthly: applies on a specific day of month (due_day), landing in
  --          whichever pay period contains that date.
  recurrence TEXT NOT NULL DEFAULT 'every_period' CHECK (recurrence IN ('every_period','monthly')),
  due_day    SMALLINT,
  start_date DATE,
  end_date   DATE,
  archived   BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX category_templates_user ON category_templates (user_id);

-- Effective-dated amounts: updating a recurring amount inserts a new row here
-- rather than overwriting, so past periods keep their original figure and all
-- future projected periods pick up the new amount from that date forward.
CREATE TABLE category_amount_history (
  id                   SERIAL PRIMARY KEY,
  category_template_id INTEGER NOT NULL REFERENCES category_templates(id) ON DELETE CASCADE,
  amount_cents         INTEGER NOT NULL,
  effective_start_date DATE NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (category_template_id, effective_start_date)
);

-- Snapshot of a category's planned amount within one materialized period.
-- Frozen at materialization time; editable per-period by the user without
-- affecting the template.
CREATE TABLE line_items (
  id                   SERIAL PRIMARY KEY,
  pay_period_id        INTEGER NOT NULL REFERENCES pay_periods(id) ON DELETE CASCADE,
  category_template_id INTEGER NOT NULL REFERENCES category_templates(id) ON DELETE CASCADE,
  planned_amount_cents INTEGER NOT NULL DEFAULT 0,
  cleared              BOOLEAN NOT NULL DEFAULT FALSE,
  cleared_date         DATE,
  UNIQUE (pay_period_id, category_template_id)
);

CREATE INDEX line_items_period ON line_items (pay_period_id);

-- Ad-hoc transactions. category_template_id is NULL for the common
-- "misc/uncategorized" case (the spreadsheet's Misc_Trans tab and Misc Income
-- rows, unified); the column exists so Phase 2 features (bank import,
-- categorized transactions) don't need a schema change.
CREATE TABLE transactions (
  id                   SERIAL PRIMARY KEY,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pay_period_id        INTEGER NOT NULL REFERENCES pay_periods(id) ON DELETE CASCADE,
  category_template_id INTEGER REFERENCES category_templates(id) ON DELETE SET NULL,
  type                 TEXT NOT NULL CHECK (type IN ('expense','income')),
  amount_cents         INTEGER NOT NULL,
  description          TEXT,
  date                 DATE NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX transactions_period ON transactions (pay_period_id);
CREATE INDEX transactions_user ON transactions (user_id);
