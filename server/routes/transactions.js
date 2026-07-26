import { Router } from 'express';
import { pool, q } from '../db.js';
import { bad, requireCents, requireDate, requireId } from '../validation.js';
import {
  getConfig, ensureMaterialized, getDefaultAccountId, loadTemplates, driftFor,
  clearLineItemForTransaction, recomputeLineItemActual, templateOwnsAccount,
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

    // An optional category labels the transaction: a tag just labels it (tags
    // count as misc in the balance math); a recurring category ALSO clears
    // that bill's line item for the period it falls in, via the SAME
    // assignCategory/clearLineItemForTransaction path used when categorizing
    // an existing transaction (single source of truth — see assignCategory
    // below). templatesById is loaded here (not just the one row) because
    // assignCategory needs the full template shape, including amount
    // history, for driftFor.
    let categoryTemplateId = null;
    let recurringTemplate = null;
    let templatesById = null;
    if (body.categoryTemplateId !== undefined && body.categoryTemplateId !== null) {
      templatesById = new Map((await loadTemplates(req.budget.id)).map((t) => [t.id, t]));
      const template = templatesById.get(Number(body.categoryTemplateId));
      if (!template) bad('Unknown category');
      categoryTemplateId = template.id;
      type = template.type; // the category's type wins
      if (template.category_type === 'recurring') recurringTemplate = template;
    }

    let accountId = body.accountId;
    const defaultAccountId = await getDefaultAccountId(req.budget.id);
    if (accountId !== undefined && accountId !== null) {
      const { rows } = await q(
        'SELECT id FROM accounts WHERE id = $1 AND budget_id = $2', [accountId, req.budget.id]
      );
      if (!rows.length) bad('Unknown account');
    } else {
      accountId = defaultAccountId;
    }

    // A recurring category clears a line item that belongs to a specific
    // account (its own account_id, or the default account when unset) — it
    // may only be assigned to a transaction on that same account.
    if (recurringTemplate && !templateOwnsAccount(recurringTemplate, accountId, defaultAccountId)) {
      bad('That category belongs to a different account');
    }

    await ensureMaterialized(req.budget.id, cfg);
    const { rows: period } = await q(
      'SELECT id, closed_at FROM pay_periods WHERE budget_id = $1 AND account_id = $3 AND start_date <= $2 AND end_date >= $2 ORDER BY start_date DESC LIMIT 1',
      [req.budget.id, date, accountId]
    );
    if (!period.length) bad('Transactions can only be added to current or past pay periods');
    if (period[0].closed_at) bad('That date falls in a closed pay period — reopen it to add transactions');

    // A recurring category is assigned AFTER insert, through assignCategory
    // (below), so the row is first inserted uncategorized; a tag (or no
    // category) is recorded directly since it never touches a line item.
    const directCategoryId = recurringTemplate ? null : categoryTemplateId;
    const { rows } = await q(
      `INSERT INTO transactions (budget_id, user_id, pay_period_id, type, amount_cents, description, date, account_id, category_template_id, categorized_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [req.budget.id, req.userId, period[0].id, type, amount, description, date, accountId,
       directCategoryId, directCategoryId ? 'manual' : null]
    );

    let transaction = rows[0];
    let drift = null;
    if (recurringTemplate) {
      // Same clearing path as categorizing an existing transaction: records
      // the actual and clears (or moves) the line item, and honors the same
      // closed-period guard (moot here — the period was just checked open —
      // and drift detection).
      drift = await assignCategory(req.budget, templatesById, transaction, recurringTemplate.id, 'manual');
      const { rows: refreshed } = await q('SELECT * FROM transactions WHERE id = $1', [transaction.id]);
      transaction = refreshed[0];
    }

    res.status(201).json(drift ? { transaction, drift } : { transaction });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = requireId(req.params.id, 'transaction');
    const { rows } = await q(
      `SELECT t.id, t.pay_period_id, t.category_template_id, pp.closed_at FROM transactions t
       LEFT JOIN pay_periods pp ON pp.id = t.pay_period_id
       WHERE t.id = $1 AND t.budget_id = $2`,
      [id, req.budget.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' });
    if (rows[0].closed_at) bad('This transaction is in a closed pay period — reopen it to make changes');
    const txn = rows[0];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM transactions WHERE id = $1', [txn.id]);
      // Dropping this transaction means it no longer counts toward its
      // recurring template's line item in this period - recompute so
      // cleared_amount_cents reflects the SUM of what's left (or NULL, per
      // the column's NULL-vs-0 contract). No-op for tag/uncategorized
      // transactions - no line_item row matches, the UPDATE affects 0 rows.
      if (txn.category_template_id && txn.pay_period_id) {
        await recomputeLineItemActual(client, txn.pay_period_id, txn.category_template_id);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
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

  // This transaction no longer counts toward the OLD template's line item
  // (un-categorized, or moved to a different category) - recompute that
  // item's cleared_amount_cents so it drops by this transaction's share.
  // Recomputing (not subtracting) yields NULL, not 0, when nothing is left,
  // per the column's NULL-vs-0 contract. Skipped when the category didn't
  // actually change (oldTemplate.id === categoryId) since nothing moved, and
  // when the old category wasn't recurring (tag/none has no line item).
  if (oldTemplate?.category_type === 'recurring' && oldTemplate.id !== categoryId && txn.pay_period_id) {
    await recomputeLineItemActual({ query: q }, txn.pay_period_id, oldTemplate.id);
  }

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
    const [rules, templates, { rows: accounts }, { rows: txns }, defaultAccountId] = await Promise.all([
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
      getDefaultAccountId(req.budget.id),
    ]);
    const templatesById = new Map(templates.map((t) => [t.id, t]));
    const accountsById = new Map(accounts.map((a) => [a.id, a]));
    let matched = 0;
    let skippedClosed = 0;
    let skippedOtherAccount = 0;
    const drift = [];
    for (const txn of txns) {
      const categoryId = firstMatchingCategory(rules, {
        description: txn.description,
        amountCents: txn.amount_cents,
        account: accountsById.get(txn.account_id) || null,
      });
      if (!categoryId) continue;
      const template = templatesById.get(categoryId);
      // A rule can match on description/amount/account text but still resolve
      // to a category owned by a DIFFERENT account than the transaction's own
      // (e.g. two accounts both have a transaction named "Rent", but only one
      // owns the "Rent" category). Rather than silently falling through to
      // the next matching rule - which could assign some other, unrelated
      // category the user never intended for this transaction - we leave it
      // uncategorized for manual review. This mirrors the existing
      // closed-period behavior below: a structural conflict during automatic
      // rule application leaves the transaction alone rather than guessing.
      if (template && !templateOwnsAccount(template, txn.account_id, defaultAccountId)) {
        skippedOtherAccount += 1;
        continue;
      }
      if (txn.period_closed && template?.category_type === 'recurring') {
        skippedClosed += 1;
        continue;
      }
      const d = await assignCategory(req.budget, templatesById, txn, categoryId, 'rule');
      if (d) drift.push(d);
      matched += 1;
    }
    res.json({ examined: txns.length, matched, skippedClosed, skippedOtherAccount, drift });
  } catch (err) {
    next(err);
  }
});

export default router;
