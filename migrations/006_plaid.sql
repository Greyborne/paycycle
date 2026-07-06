-- Plaid bank sync. An "item" is one bank login; it exposes one or more bank
-- accounts, each of which the user can map to a PayCycle account. Synced
-- transactions flow through the same pipeline as CSV imports (import_hash
-- dedupe, learned rules, line-item clearing).

CREATE TABLE plaid_items (
  id               SERIAL PRIMARY KEY,
  budget_id        INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  item_id          TEXT NOT NULL UNIQUE,
  access_token     TEXT NOT NULL,
  institution_name TEXT,
  cursor           TEXT,
  last_synced_at   TIMESTAMPTZ,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX plaid_items_budget ON plaid_items (budget_id);

CREATE TABLE plaid_account_links (
  id               SERIAL PRIMARY KEY,
  plaid_item_id    INTEGER NOT NULL REFERENCES plaid_items(id) ON DELETE CASCADE,
  plaid_account_id TEXT NOT NULL,
  plaid_name       TEXT,
  plaid_mask       TEXT,
  -- The PayCycle account transactions land in; NULL = this bank account is
  -- not synced.
  account_id       INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  UNIQUE (plaid_item_id, plaid_account_id)
);
