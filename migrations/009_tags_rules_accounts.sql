-- Tag categories, explicit ordered categorization rules, richer accounts,
-- manual-vs-rule provenance on transactions, and a configurable drift
-- threshold.

-- Two category behaviors from one list: 'recurring' (planned amount +
-- effective-dated history + a line item every period) and 'tag' (a label for
-- one-off spending; no plan, no projection impact — its transactions count
-- like misc in the cleared math).
ALTER TABLE category_templates ADD COLUMN category_type TEXT NOT NULL DEFAULT 'recurring'
  CHECK (category_type IN ('recurring', 'tag'));

-- Account metadata rules can match on. Institution/mask flow from Plaid when
-- linked; manual accounts can fill them in by hand. Only the last 4 digits
-- are ever stored.
ALTER TABLE accounts ADD COLUMN institution TEXT;
ALTER TABLE accounts ADD COLUMN number_mask TEXT;
ALTER TABLE accounts ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
UPDATE accounts a SET institution = pi.institution_name, number_mask = pal.plaid_mask, source = 'plaid'
FROM plaid_account_links pal
JOIN plaid_items pi ON pi.id = pal.plaid_item_id
WHERE pal.account_id = a.id;

-- Who categorized a transaction. 'manual' assignments are an explicit user
-- decision and are never touched by rule evaluation, past or future.
-- Everything categorized so far went through user review, so it counts as
-- manual.
ALTER TABLE transactions ADD COLUMN categorized_by TEXT
  CHECK (categorized_by IN ('rule', 'manual'));
UPDATE transactions SET categorized_by = 'manual' WHERE category_template_id IS NOT NULL;

-- "Your Electric cleared at $260 but you plan $250" — flagged when actual
-- differs from planned by more than max(this, 5% of planned).
ALTER TABLE budgets ADD COLUMN drift_threshold_cents INTEGER NOT NULL DEFAULT 500;

-- Explicit, ordered categorization rules. Within a rule every filled-in
-- field must match (AND); across rules the first match in sort_order wins.
CREATE TABLE category_rules (
  id                      SERIAL PRIMARY KEY,
  budget_id               INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  category_template_id    INTEGER NOT NULL REFERENCES category_templates(id) ON DELETE CASCADE,
  sort_order              INTEGER NOT NULL DEFAULT 0,
  description_contains    TEXT,
  account_contains        TEXT,
  institution_contains    TEXT,
  account_number_contains TEXT,
  amount_min_cents        INTEGER,
  amount_max_cents        INTEGER,
  amount_equals_cents     INTEGER,
  amount_contains         TEXT,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX category_rules_budget ON category_rules (budget_id, sort_order, id);

-- The learned substring rules carry over, keeping their longest-first
-- precedence as explicit sort order.
INSERT INTO category_rules (budget_id, category_template_id, sort_order, description_contains, notes)
SELECT budget_id, category_template_id,
       row_number() OVER (PARTITION BY budget_id ORDER BY length(pattern) DESC, id),
       pattern, 'Learned during import'
FROM import_rules;

DROP TABLE import_rules;
