-- CSV bank-statement import support.

-- Dedupe imported rows: hash of (date|amount|description) per user. Manual
-- transactions leave it NULL and are never deduped.
ALTER TABLE transactions ADD COLUMN import_hash TEXT;
CREATE UNIQUE INDEX transactions_import_hash
  ON transactions (user_id, import_hash) WHERE import_hash IS NOT NULL;

-- Learned auto-categorization rules: case-insensitive substring of the bank
-- description -> category. Created when the user confirms a match during
-- import; applied to suggest matches on later imports.
CREATE TABLE import_rules (
  id                   SERIAL PRIMARY KEY,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pattern              TEXT NOT NULL,
  category_template_id INTEGER NOT NULL REFERENCES category_templates(id) ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, pattern)
);
