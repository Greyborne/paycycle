import { Router } from 'express';
import { q } from '../db.js';
import { bad, requireCents, requireDate } from '../validation.js';
import {
  getConfig, ensureMaterialized, getDefaultAccountId, loadTemplates, driftFor,
  clearLineItemForTransaction,
} from '../services/budget.js';
import { loadRules, firstMatchingCategory } from '../services/rules.js';
import { todayISO } from '../services/schedule.js';

const router = Router();

// Quick-add a misc/uncategorized transaction. Negative amounts entered by the
// user are normalized: sign decides expense vs income when type is omitted.
// user_id records who in the household entered it.
router.post('/', async (req, res, next) => {
  try {
    const cfg = await getConfig(req.budget.id);
    if (!cfg) bad('Complete setup first');
    const body = req.body || {};
    let amount = requireCents(body.amountCents, 'amountCents');
    let type = body.type;
    if (!type) type = amount < 0 ? 'expense' : 'income';
    if (!['expense', 'income'].includes(type)) bad('type must be expense or income');
    amount = Math.abs(amount);
    if (amount === 0) bad('amountCents cannot be zero');
    const date = requireDate(body.date || todayISO(), 'date');
    const description = typeof body.description === 'string' ? body.description.trim() || null : null;

    // An optional tag category labels the misc transaction (tags count as
    // misc in the balance math). Only tags are allowed here — recurring
    // categories clear line items and are assigned from the Transactions page.
    let categoryTemplateId = null;
    if (body.categoryTemplateId !== undefined && body.categoryTemplateId !== null) {
      const { rows: cat } = await q(
        "SELECT id, type FROM category_templates WHERE id = $1 AND budget_id = $2 AND category_type = 'tag' AND NOT archived",
        [body.categoryTemplateId, req.budget.id]
      );
      if (!cat.length) bad('Pick a tag category (recurring categories are assigned on the Transactions page)');
      categoryTemplateId = cat[0].id;
      type = cat[0].type; // the tag's type wins
    }

    let accountId = body.accountId;
    if (accountId !== undefined && accountId !== null) {
      const { rows } = await q(
        'SELECT id FROM accounts WHERE id = $1 AND budget_id = $2', [accountId, req.budget.id]
      );
      if (!rows.length) bad('Unknown account');
    } else {
      accountId = await getDefaultAccountId(req.budget.id);
    }

    await ensureMaterialized(req.budget.id, cfg);
    const { rows: period } = await q(
      'SELECT id, closed_at FROM pay_periods WHERE budget_id = $1 AND start_date <= $2 AND end_date >= $2 ORDER BY start_date DESC LIMIT 1',
      [req.budget.id, date]
    );
    if (!period.length) bad('Transactions can only be added to current or past pay periods');
    if (period[0].closed_at) bad('That date falls in a closed pay period — reopen it to add transactions');
    const { rows } = await q(
      `INSERT INTO transactions (budget_id, user_id, pay_period_id, type, amount_cents, description, date, account_id, category_template_id, categorized_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [req.budget.id, req.userId, period[0].id, type, amount, description, date, accountId,
       categoryTemplateId, categoryTemplateId ? 'manual' : null]
    );
    res.status(201).json({ transaction: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT t.id, pp.closed_at FROM transactions t
       LEFT JOIN pay_periods pp ON pp.id = t.pay_period_id
       WHERE t.id = $1 AND t.budget_id = $2`,
      [Number(req.params.id), req.budget.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' });
    if (rows[0].closed_at) bad('This transaction is in a closed pay period — reopen it to make changes');
    await q('DELETE FROM transactions WHERE id = $1', [rows[0].id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});


// The Transactions page: every transaction with its account, category, and
// period context. Filtering happens here; sorting is the client's job.
router.get('/', async (req, res, next) => {
  try {
    const where = ['t.budget_id = $1'];
    const params = [req.budget.id];
    const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (req.query.from) add('t.date >= ?', requireDate(req.query.from, 'from'));
    if (req.query.to) add('t.date <= ?', requireDate(req.query.to, 'to'));
    if (req.query.account) add('t.account_id = ?', Number(req.query.account));
    if (req.query.category === 'none') where.push('t.category_template_id IS NULL');
    else if (req.query.category) add('t.category_template_id = ?', Number(req.query.category));
    if (req.query.search) add('t.description ILIKE ?', `%${req.query.search}%`);

    const { rows } = await q(
      `SELECT t.id, t.date, t.description, t.type, t.amount_cents, t.category_template_id, t.categorized_by,
              t.account_id, ct.name AS category_name, ct.category_type,
              a.name AS account_name, a.currency AS account_currency,
              pp.start_date AS period_start, (pp.closed_at IS NOT NULL) AS period_closed,
              li.cleared AS line_item_cleared
       FROM transactions t
       LEFT JOIN category_templates ct ON ct.id = t.category_template_id
       LEFT JOIN accounts a ON a.id = t.account_id
       LEFT JOIN pay_periods pp ON pp.id = t.pay_period_id
       LEFT JOIN line_items li ON li.pay_period_id = t.pay_period_id
         AND li.category_template_id = t.category_template_id
       WHERE ${where.join(' AND ')}
       ORDER BY t.date DESC, t.id DESC
       LIMIT 1000`,
      params
    );
    res.json({ transactions: rows });
  } catch (err) {
    next(err);
  }
});

// Categorize one transaction: tag categories just label it; recurring
// categories also clear the period's matching line item and check the actual
// amount against the plan (drift). Returns any drift suggestion so the UI
// can offer "update the recurring amount going forward".
async function assignCategory(budget, templatesById, txn, categoryId, provenance) {
  const oldTemplate = txn.category_template_id ? templatesById.get(txn.category_template_id) : null;
  const template = categoryId ? templatesById.get(categoryId) : null;
  if (categoryId && !template) bad(`Unknown category id ${categoryId}`);

  if (txn.period_closed
      && (template?.category_type === 'recurring' || oldTemplate?.category_type === 'recurring')) {
    bad('That transaction is in a closed pay period — reopen it to change its reconciliation');
  }

  // Un-categorizing by hand still records 'manual' so rules never re-touch
  // the transaction; a rule run that leaves it uncategorized records nothing.
  const provenanceValue = categoryId !== null || provenance === 'manual' ? provenance : null;
  await q(
    `UPDATE transactions SET category_template_id = $1, type = $2, categorized_by = $3 WHERE id = $4`,
    [categoryId, template ? template.type : txn.type, provenanceValue, txn.id]
  );

  let drift = null;
  if (template?.category_type === 'recurring' && txn.pay_period_id) {
    await clearLineItemForTransaction({ query: q }, template, {
      periodId: txn.pay_period_id,
      date: txn.date,
      amountCents: txn.amount_cents,
      accountId: txn.account_id,
    });
    drift = driftFor(budget, template, txn.amount_cents, txn.date);
  }
  return drift;
}

async function loadOwnTxns(budgetId, ids) {
  if (!Array.isArray(ids) || !ids.length || !ids.every(Number.isInteger)) bad('ids must be an array of transaction ids');
  const { rows } = await q(
    `SELECT t.*, (pp.closed_at IS NOT NULL) AS period_closed
     FROM transactions t LEFT JOIN pay_periods pp ON pp.id = t.pay_period_id
     WHERE t.budget_id = $1 AND t.id = ANY($2)`,
    [budgetId, ids]
  );
  return rows;
}

// Manual (bulk or single) category assignment — always an explicit override,
// never revisited by rules.
router.patch('/assign', async (req, res, next) => {
  try {
    const body = req.body || {};
    const categoryId = body.categoryId ?? null;
    const txns = await loadOwnTxns(req.budget.id, body.ids);
    const templatesById = new Map(
      (await loadTemplates(req.budget.id, { includeArchived: true })).map((t) => [t.id, t])
    );
    const drift = [];
    for (const txn of txns) {
      const d = await assignCategory(req.budget, templatesById, txn, categoryId, 'manual');
      if (d) drift.push(d);
    }
    res.json({ updated: txns.length, drift });
  } catch (err) {
    next(err);
  }
});

// Bulk delete (import mistakes). Closed periods stay untouched.
router.post('/bulk-delete', async (req, res, next) => {
  try {
    const txns = await loadOwnTxns(req.budget.id, req.body?.ids);
    let deleted = 0;
    let skippedClosed = 0;
    for (const txn of txns) {
      if (txn.period_closed) { skippedClosed += 1; continue; }
      await q('DELETE FROM transactions WHERE id = $1', [txn.id]);
      deleted += 1;
    }
    res.json({ deleted, skippedClosed });
  } catch (err) {
    next(err);
  }
});

// Re-run categorization rules over currently-uncategorized transactions
// only. Anything the user categorized (or explicitly un-categorized) by hand
// is never touched.
router.post('/recategorize', async (req, res, next) => {
  try {
    const [rules, templates, { rows: accounts }, { rows: txns }] = await Promise.all([
      loadRules(req.budget.id),
      loadTemplates(req.budget.id, { includeArchived: true }),
      q('SELECT * FROM accounts WHERE budget_id = $1', [req.budget.id]),
      q(
        `SELECT t.*, (pp.closed_at IS NOT NULL) AS period_closed
         FROM transactions t LEFT JOIN pay_periods pp ON pp.id = t.pay_period_id
         WHERE t.budget_id = $1 AND t.category_template_id IS NULL
           AND t.categorized_by IS DISTINCT FROM 'manual'`,
        [req.budget.id]
      ),
    ]);
    const templatesById = new Map(templates.map((t) => [t.id, t]));
    const accountsById = new Map(accounts.map((a) => [a.id, a]));
    let matched = 0;
    let skippedClosed = 0;
    const drift = [];
    for (const txn of txns) {
      const categoryId = firstMatchingCategory(rules, {
        description: txn.description,
        amountCents: txn.amount_cents,
        account: accountsById.get(txn.account_id) || null,
      });
      if (!categoryId) continue;
      if (txn.period_closed && templatesById.get(categoryId)?.category_type === 'recurring') {
        skippedClosed += 1;
        continue;
      }
      const d = await assignCategory(req.budget, templatesById, txn, categoryId, 'rule');
      if (d) drift.push(d);
      matched += 1;
    }
    res.json({ examined: txns.length, matched, skippedClosed, drift });
  } catch (err) {
    next(err);
  }
});

export default router;
