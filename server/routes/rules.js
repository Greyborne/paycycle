import { Router } from 'express';
import { q } from '../db.js';
import { bad, requireCents, requireId } from '../validation.js';
import { loadRules, ruleMatches } from '../services/rules.js';
import { getDefaultAccountId, templateOwnsAccount } from '../services/budget.js';

const router = Router();

const FIELDS = [
  'description_contains', 'account_contains', 'institution_contains', 'account_number_contains',
  'amount_min_cents', 'amount_max_cents', 'amount_equals_cents', 'amount_contains', 'notes',
];

function publicRule(r) {
  return {
    id: r.id,
    categoryTemplateId: r.category_template_id,
    sortOrder: r.sort_order,
    descriptionContains: r.description_contains,
    accountContains: r.account_contains,
    institutionContains: r.institution_contains,
    accountNumberContains: r.account_number_contains,
    amountMinCents: r.amount_min_cents,
    amountMaxCents: r.amount_max_cents,
    amountEqualsCents: r.amount_equals_cents,
    amountContains: r.amount_contains,
    notes: r.notes,
  };
}

// Body → column values; text fields trim to NULL, amount fields are cents.
function parseFields(body, existing = {}) {
  const out = {};
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const cents = (v, name) => (v === null || v === undefined || v === '' ? null : requireCents(v, name));
  const pick = (bodyKey, col, isCents) => {
    if (body[bodyKey] === undefined) out[col] = existing[col] ?? null;
    else out[col] = isCents ? cents(body[bodyKey], bodyKey) : text(body[bodyKey]);
  };
  pick('descriptionContains', 'description_contains');
  pick('accountContains', 'account_contains');
  pick('institutionContains', 'institution_contains');
  pick('accountNumberContains', 'account_number_contains');
  pick('amountMinCents', 'amount_min_cents', true);
  pick('amountMaxCents', 'amount_max_cents', true);
  pick('amountEqualsCents', 'amount_equals_cents', true);
  pick('amountContains', 'amount_contains');
  pick('notes', 'notes');
  return out;
}

const hasCriterion = (f) => FIELDS.some((k) => k !== 'notes' && f[k] !== null && f[k] !== undefined);

async function requireCategory(budgetId, id) {
  const { rows } = await q(
    'SELECT id FROM category_templates WHERE id = $1 AND budget_id = $2', [id, budgetId]
  );
  if (!rows.length) bad('Unknown category');
  return rows[0].id;
}

router.get('/', async (req, res, next) => {
  try {
    const rules = await loadRules(req.budget.id);
    res.json({ rules: rules.map(publicRule) });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const categoryId = await requireCategory(req.budget.id, Number(body.categoryTemplateId));
    const f = parseFields(body);
    if (!hasCriterion(f)) bad('A rule needs at least one match condition');
    const { rows: max } = await q(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM category_rules WHERE budget_id = $1',
      [req.budget.id]
    );
    const { rows } = await q(
      `INSERT INTO category_rules (budget_id, category_template_id, sort_order, description_contains,
         account_contains, institution_contains, account_number_contains, amount_min_cents,
         amount_max_cents, amount_equals_cents, amount_contains, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [req.budget.id, categoryId, max[0].next, f.description_contains, f.account_contains,
       f.institution_contains, f.account_number_contains, f.amount_min_cents, f.amount_max_cents,
       f.amount_equals_cents, f.amount_contains, f.notes]
    );
    res.status(201).json({ rule: publicRule(rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = requireId(req.params.id, 'rule');
    const { rows: existing } = await q(
      'SELECT * FROM category_rules WHERE id = $1 AND budget_id = $2',
      [id, req.budget.id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Rule not found' });
    const body = req.body || {};
    const categoryId = body.categoryTemplateId !== undefined
      ? await requireCategory(req.budget.id, Number(body.categoryTemplateId))
      : existing[0].category_template_id;
    const f = parseFields(body, existing[0]);
    if (!hasCriterion(f)) bad('A rule needs at least one match condition');
    const { rows } = await q(
      `UPDATE category_rules SET category_template_id = $1, description_contains = $2,
         account_contains = $3, institution_contains = $4, account_number_contains = $5,
         amount_min_cents = $6, amount_max_cents = $7, amount_equals_cents = $8,
         amount_contains = $9, notes = $10
       WHERE id = $11 RETURNING *`,
      [categoryId, f.description_contains, f.account_contains, f.institution_contains,
       f.account_number_contains, f.amount_min_cents, f.amount_max_cents, f.amount_equals_cents,
       f.amount_contains, f.notes, existing[0].id]
    );
    res.json({ rule: publicRule(rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = requireId(req.params.id, 'rule');
    const { rowCount } = await q(
      'DELETE FROM category_rules WHERE id = $1 AND budget_id = $2',
      [id, req.budget.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Rule not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Order matters: first match wins. Body { ids } in the new order.
router.post('/reorder', async (req, res, next) => {
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.every(Number.isInteger)) bad('ids must be an array of rule ids');
    for (let i = 0; i < ids.length; i++) {
      await q(
        'UPDATE category_rules SET sort_order = $1 WHERE id = $2 AND budget_id = $3',
        [i + 1, ids[i], req.budget.id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Live preview while editing: how many existing transactions would this rule
// match (ignoring rule order and manual assignments — it answers "what does
// this pattern hit", not "what would change").
router.post('/preview', async (req, res, next) => {
  try {
    const f = parseFields(req.body || {});
    if (!hasCriterion(f)) return res.json({ count: 0, sample: [] });
    // Predicts what apply would do, so it applies the identical account-
    // ownership filter as the rules-apply loop in transactions.js: a rule
    // that matches a transaction but targets a category owned by a
    // DIFFERENT account than the transaction's own is not counted as a
    // match here either (see server/routes/transactions.js /recategorize).
    const categoryTemplateId = req.body?.categoryTemplateId
      ? Number(req.body.categoryTemplateId) : null;
    const [{ rows: txns }, { rows: accounts }, { rows: catRows }, defaultAccountId] = await Promise.all([
      q(
        `SELECT t.id, t.date, t.description, t.amount_cents, t.account_id
         FROM transactions t WHERE t.budget_id = $1 ORDER BY t.date DESC, t.id DESC LIMIT 5000`,
        [req.budget.id]
      ),
      q('SELECT * FROM accounts WHERE budget_id = $1', [req.budget.id]),
      categoryTemplateId
        ? q('SELECT id, account_id FROM category_templates WHERE id = $1 AND budget_id = $2', [categoryTemplateId, req.budget.id])
        : Promise.resolve({ rows: [] }),
      getDefaultAccountId(req.budget.id),
    ]);
    const targetTemplate = catRows[0] || null;
    const accountsById = new Map(accounts.map((a) => [a.id, a]));
    const matches = txns.filter((t) => {
      if (!ruleMatches(f, {
        description: t.description,
        amountCents: t.amount_cents,
        account: accountsById.get(t.account_id) || null,
      })) return false;
      if (targetTemplate && !templateOwnsAccount(targetTemplate, t.account_id, defaultAccountId)) return false;
      return true;
    });
    res.json({
      count: matches.length,
      sample: matches.slice(0, 10).map((t) => ({
        id: t.id, date: t.date, description: t.description, amountCents: t.amount_cents,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
