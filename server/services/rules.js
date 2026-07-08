import { q } from './../db.js';

// Explicit categorization rules: within one rule every filled-in field must
// match (AND); across rules, first match in user-defined sort order wins.
// Manual assignments are never touched by rule evaluation.

export async function loadRules(budgetId) {
  const { rows } = await q(
    'SELECT * FROM category_rules WHERE budget_id = $1 ORDER BY sort_order, id',
    [budgetId]
  );
  return rows;
}

const contains = (haystack, needle) =>
  (haystack || '').toLowerCase().includes(needle.trim().toLowerCase());

// txn: { description, amountCents (absolute), account: { name, institution,
// number_mask } | null }
export function ruleMatches(rule, txn) {
  let criteria = 0;
  const check = (cond) => { criteria++; return cond; };

  if (rule.description_contains && !check(contains(txn.description, rule.description_contains))) return false;
  if (rule.account_contains && !check(contains(txn.account?.name, rule.account_contains))) return false;
  if (rule.institution_contains && !check(contains(txn.account?.institution, rule.institution_contains))) return false;
  if (rule.account_number_contains && !check(contains(txn.account?.number_mask, rule.account_number_contains))) return false;
  const amount = Math.abs(txn.amountCents);
  if (rule.amount_min_cents !== null && !check(amount >= rule.amount_min_cents)) return false;
  if (rule.amount_max_cents !== null && !check(amount <= rule.amount_max_cents)) return false;
  if (rule.amount_equals_cents !== null && !check(amount === rule.amount_equals_cents)) return false;
  if (rule.amount_contains && !check((amount / 100).toFixed(2).includes(rule.amount_contains.trim()))) return false;

  // An empty rule matches nothing rather than everything.
  return criteria > 0;
}

export function firstMatchingCategory(rules, txn) {
  for (const rule of rules) {
    if (ruleMatches(rule, txn)) return rule.category_template_id;
  }
  return null;
}
