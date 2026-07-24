-- SimpleFIN bank sync, replacing Plaid entirely (see
-- docs/plans/simplefin-migration.md). Plaid required server-wide API
-- credentials and a business/production application; SimpleFIN Bridge is
-- the opposite shape - the *user* signs up with SimpleFIN directly and
-- pastes a one-time setup token into their own PayCycle instance, so the
-- feature needs no operator configuration at all.
--
-- A "connection" is one SimpleFIN access URL (itself a bearer credential,
-- stored encrypted at rest via server/services/secrets.js - see decision
-- #8 in the migration plan). One access URL can expose accounts from
-- several institutions, so the institution/org name lives on the *link*
-- row, not the connection. There is no `mask`; SimpleFIN's protocol does
-- not provide one.
--
-- One-way migration (CONSTITUTION.md §6d): Plaid's access tokens are
-- worthless the moment the Plaid client is removed from the codebase, and
-- Plaid Production access required a business application, so no
-- self-hosted household can plausibly be carrying a live Plaid item today.
-- No down path is provided; recovery from a bad run is a database restore,
-- recorded here in writing rather than in a down-migration nobody could
-- use. `transactions` rows are left untouched - historical `plaid:*`
-- import_hash values simply stop matching anything going forward.
DROP TABLE IF EXISTS plaid_account_links CASCADE;
DROP TABLE IF EXISTS plaid_items CASCADE;

CREATE TABLE simplefin_connections (
  id             SERIAL PRIMARY KEY,
  budget_id      INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  -- Encrypted at rest (server/services/secrets.js). Embeds basic-auth
  -- user:pass, so it is a credential, not metadata - never returned by any
  -- API response, never logged.
  access_url     TEXT NOT NULL,
  label          TEXT,
  last_synced_at TIMESTAMPTZ,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX simplefin_connections_budget ON simplefin_connections (budget_id);

CREATE TABLE simplefin_account_links (
  id            SERIAL PRIMARY KEY,
  connection_id INTEGER NOT NULL REFERENCES simplefin_connections(id) ON DELETE CASCADE,
  sf_account_id TEXT NOT NULL,
  sf_name       TEXT,
  -- Institution name for this specific bank account; one connection can
  -- span multiple institutions, so this cannot live on the connection.
  sf_org_name   TEXT,
  sf_currency   TEXT,
  -- The PayCycle account transactions land in; NULL = this bank account is
  -- not synced.
  account_id    INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  UNIQUE (connection_id, sf_account_id)
);
