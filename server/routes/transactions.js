import { Router } from 'express';
import { pool, q } from '../db.js';
import { bad, requireCents, requireDate, requireId } from '../validation.js';
import {
  getConfig, ensureMaterialized, getDefaultAccountId, loadTemplates, driftFor,
  clearLineItemForTransaction, recomputeLineItemActual, templateOwnsAccount, detectMoveSuggestion,
} from '../services/budget.js';
import { loadRules, firstMatchingCategory } from '../services/rules.js';
import { findPossibleDuplicate } from '../services/duplicates.js';
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

    // The INSERT and (for a recurring category) the assignCategory call and
    // its refresh SELECT are one unit of work: if assignCategory throws after
    // the INSERT, we must not leave an uncategorized row behind. Run them all
    // in a single DB transaction, same BEGIN/COMMIT/ROLLBACK idiom as
    // DELETE /:id below.
    let transaction;
    let drift = null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO transactions (budget_id, user_id, pay_period_id, type, amount_cents, description, date, account_id, category_template_id, categorized_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [req.budget.id, req.userId, period[0].id, type, amount, description, date, accountId,
         directCategoryId, directCategoryId ? 'manual' : null]
      );
      transaction = rows[0];

      // A manual entry can be the SECOND leg of a duplicate just as easily
      // as the first (e.g. bank sync already pulled this purchase in, and
      // the user also enters it by hand) - run the same cross-source check
      // the import/sync paths run, on this same DB transaction.
      const possibleDuplicateOf = await findPossibleDuplicate(client, {
        budgetId: req.budget.id,
        accountId,
        type,
        amountCents: amount,
        date,
        excludeId: transaction.id,
      });
      if (possibleDuplicateOf) {
        await client.query('UPDATE transactions SET possible_duplicate_of = $1 WHERE id = $2', [possibleDuplicateOf, transaction.id]);
        transaction.possible_duplicate_of = possibleDuplicateOf;
      }

      if (recurringTemplate) {
        // Same clearing path as categorizing an existing transaction: records
        // the actual and clears (or moves) the line item, and honors the same
        // closed-period guard (moot here — the period was just checked open —
        // and drift detection).
        drift = await assignCategory(req.budget, templatesById, transaction, recurringTemplate.id, 'manual', client);
        const { rows: refreshed } = await client.query('SELECT * FROM transactions WHERE id = $1', [transaction.id]);
        transaction = refreshed[0];
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
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
              (pp.start_date IS NOT NULL AND (t.date < pp.start_date OR t.date > pp.end_date)) AS period_overridden,
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

// Unresolved possible-duplicate pairs (possible_duplicate_of IS NOT NULL),
// for the "Possible duplicates" review UI. Optionally scoped to one account.
// Each row is the FLAGGED transaction joined to the pre-existing ORIGINAL it
// was matched against, so a client can render both sides of the pair without
// a second round trip.
router.get('/duplicates', async (req, res, next) => {
  try {
    const where = ['t.budget_id = $1', 't.possible_duplicate_of IS NOT NULL'];
    const params = [req.budget.id];
    if (req.query.account) {
      params.push(Number(req.query.account));
      where.push(`t.account_id = $${params.length}`);
    }
    const { rows } = await q(
      `SELECT
         t.id, t.date, t.description, t.type, t.amount_cents, t.account_id,
         o.id AS original_id, o.date AS original_date, o.description AS original_description,
         o.type AS original_type, o.amount_cents AS original_amount_cents
       FROM transactions t
       JOIN transactions o ON o.id = t.possible_duplicate_of
       WHERE ${where.join(' AND ')}
       ORDER BY t.date DESC, t.id DESC`,
      params
    );
    res.json({ pairs: rows });
  } catch (err) {
    next(err);
  }
});

// Categorize one transaction: tag categories just label it; recurring
// categories also clear the period's matching line item and check the actual
// amount against the plan (drift). Returns any drift suggestion so the UI
// can offer "update the recurring amount going forward".
async function assignCategory(budget, templatesById, txn, categoryId, provenance, db = { query: q }) {
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
  await db.query(
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
    await recomputeLineItemActual(db, txn.pay_period_id, oldTemplate.id);
  }

  let drift = null;
  if (template?.category_type === 'recurring' && txn.pay_period_id) {
    await clearLineItemForTransaction(db, template, {
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
    const template = categoryId ? templatesById.get(categoryId) : null;

    // Adjacent-period move suggestions (CONSTITUTION.md, 2026-08-04
    // "recurring-match auto-detect" decision) only apply to a recurring-
    // category assignment, and need each affected transaction's CURRENT
    // period bounds up front. One batched query covers every distinct
    // pay_period_id in this request rather than one query per transaction -
    // detectMoveSuggestion (server/services/budget.js) itself never mutates
    // anything, it only reads.
    let periodsById = new Map();
    if (template?.category_type === 'recurring') {
      const periodIds = [...new Set(txns.map((t) => t.pay_period_id).filter((id) => id != null))];
      if (periodIds.length) {
        const { rows: periods } = await q(
          'SELECT id, account_id, budget_id, start_date, end_date FROM pay_periods WHERE id = ANY($1)',
          [periodIds]
        );
        periodsById = new Map(periods.map((p) => [p.id, p]));
      }
    }

    const drift = [];
    const suggestions = [];
    for (const txn of txns) {
      const d = await assignCategory(req.budget, templatesById, txn, categoryId, 'manual');
      if (d) drift.push(d);
      if (template?.category_type === 'recurring') {
        const suggestion = await detectMoveSuggestion(pool, template, txn, periodsById.get(txn.pay_period_id));
        if (suggestion) suggestions.push(suggestion);
      }
    }
    res.json({ updated: txns.length, drift, suggestions });
  } catch (err) {
    next(err);
  }
});

// Dismiss a possible-duplicate flag: this transaction is not actually a
// duplicate of the one it was matched against. There is no separate
// "dismissed" state - nulling possible_duplicate_of IS the dismiss action
// (CONSTITUTION.md, 2026-08-01 decision). An unflagged row and a
// reviewed-and-cleared row are indistinguishable afterward, which is
// intentional: nothing is remembered about a false positive.
router.patch('/:id/dismiss-duplicate', async (req, res, next) => {
  try {
    const id = requireId(req.params.id, 'transaction');
    const { rows } = await q(
      'UPDATE transactions SET possible_duplicate_of = NULL WHERE id = $1 AND budget_id = $2 RETURNING id',
      [id, req.budget.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Move a transaction to the immediately adjacent (previous or next) pay
// period for its account, overriding the date-based period it was filed
// under. transactions.date is NEVER touched here - only pay_period_id
// moves. The "moved" state is derived at read time (t.date falling outside
// its pay_period_id's [start_date, end_date] range - see the list route
// above) rather than stored, per CONSTITUTION.md's 2026-08-04 decision.
// Adjacent-only, enforced here: the client supplies only a direction, never
// a target period id, so it can never jump to an arbitrary period. Either
// side (source or destination) being closed blocks the move, with no new
// exception to that invariant (§5).
router.patch('/:id/move', async (req, res, next) => {
  try {
    const id = requireId(req.params.id, 'transaction');
    const direction = req.body?.direction;
    if (direction !== 'prev' && direction !== 'next') bad('direction must be "prev" or "next"');

    const { rows } = await q(
      `SELECT t.id, t.account_id, t.pay_period_id, t.category_template_id,
              pp.start_date AS period_start, pp.closed_at
       FROM transactions t
       LEFT JOIN pay_periods pp ON pp.id = t.pay_period_id
       WHERE t.id = $1 AND t.budget_id = $2`,
      [id, req.budget.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' });
    const txn = rows[0];
    if (txn.closed_at) bad('That transaction is in a closed pay period — reopen it to move it');

    // Adjacent = the next/previous pay_periods row for the SAME account and
    // budget, ordered by start_date - never a client-supplied period id.
    const adjacentSql = direction === 'next'
      ? `SELECT id, closed_at FROM pay_periods WHERE account_id = $1 AND budget_id = $2 AND start_date > $3 ORDER BY start_date ASC LIMIT 1`
      : `SELECT id, closed_at FROM pay_periods WHERE account_id = $1 AND budget_id = $2 AND start_date < $3 ORDER BY start_date DESC LIMIT 1`;
    const { rows: adjacentRows } = await q(adjacentSql, [txn.account_id, req.budget.id, txn.period_start]);
    if (!adjacentRows.length) bad('No period in that direction');
    const target = adjacentRows[0];
    if (target.closed_at) bad('The target period is closed — reopen it to move a transaction into it');

    const oldPeriodId = txn.pay_period_id;
    const client = await pool.connect();
    let transaction;
    try {
      await client.query('BEGIN');
      const { rows: updated } = await client.query(
        'UPDATE transactions SET pay_period_id = $1 WHERE id = $2 RETURNING *',
        [target.id, txn.id]
      );
      transaction = updated[0];
      // Same dual-sided recompute as the SimpleFIN date-restatement path
      // (simplefin.js:621-624) and transaction delete (above): the OLD
      // period's line item lost this transaction's contribution, the NEW
      // period's gained it. No-op for tag/uncategorized transactions - no
      // line_item row matches either UPDATE.
      if (txn.category_template_id) {
        await recomputeLineItemActual(client, oldPeriodId, txn.category_template_id);
        await recomputeLineItemActual(client, target.id, txn.category_template_id);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.json({ transaction });
  } catch (err) {
    next(err);
  }
});

// Bulk delete (import mistakes). Closed periods stay untouched. Every
// recurring line item that loses a transaction here must have its
// cleared_amount_cents (and, when it fully empties out, cleared/cleared_date)
// recomputed - same pattern as the single-transaction DELETE /:id route above
// and accounts.js's Tier 1 wipe, just deduped over every distinct
// (pay_period_id, category_template_id) pair touched by this batch so a
// period+category cleared by two of the deleted transactions is only
// recomputed once.
router.post('/bulk-delete', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const txns = await loadOwnTxns(req.budget.id, req.body?.ids);
    let deleted = 0;
    let skippedClosed = 0;
    const pairs = new Map();
    await client.query('BEGIN');
    for (const txn of txns) {
      if (txn.period_closed) { skippedClosed += 1; continue; }
      await client.query('DELETE FROM transactions WHERE id = $1', [txn.id]);
      deleted += 1;
      if (txn.category_template_id && txn.pay_period_id) {
        pairs.set(`${txn.pay_period_id}:${txn.category_template_id}`, {
          periodId: txn.pay_period_id,
          categoryTemplateId: txn.category_template_id,
        });
      }
    }
    for (const { periodId, categoryTemplateId } of pairs.values()) {
      await recomputeLineItemActual(client, periodId, categoryTemplateId);
    }
    await client.query('COMMIT');
    res.json({ deleted, skippedClosed });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
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
      const txnForMatch = {
        description: txn.description,
        amountCents: txn.amount_cents,
        account: accountsById.get(txn.account_id) || null,
      };
      // A rule can match on description/amount/account text but still resolve
      // to a category owned by a DIFFERENT account than the transaction's own
      // (e.g. two accounts both have a transaction named "Rent", but only one
      // owns the "Rent" category). Search same-account-eligible rules first
      // (in their existing relative order) so an earlier, unrelated-account
      // rule that happens to also match by text doesn't block a correctly
      // scoped rule sitting later in the list from ever being reached. Only
      // if NO same-account rule matches do we run a second, diagnostic-only
      // search to tell "skipped: wrong account" apart from "no rule matched
      // at all" - that second search's result is never applied.
      const ownsAccount = (rule) => {
        const t = templatesById.get(rule.category_template_id);
        return t && templateOwnsAccount(t, txn.account_id, defaultAccountId);
      };
      const categoryId = firstMatchingCategory(rules, txnForMatch, ownsAccount);
      if (!categoryId) {
        if (firstMatchingCategory(rules, txnForMatch)) skippedOtherAccount += 1;
        continue;
      }
      const template = templatesById.get(categoryId);
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
