import { Router } from 'express';
import { q } from '../db.js';
import { bad, requireCents, requireDate } from '../validation.js';
import { getConfig, ensureMaterialized, getDefaultAccountId } from '../services/budget.js';
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
      'SELECT id FROM pay_periods WHERE budget_id = $1 AND start_date <= $2 AND end_date >= $2 ORDER BY start_date DESC LIMIT 1',
      [req.budget.id, date]
    );
    if (!period.length) bad('Transactions can only be added to current or past pay periods');
    const { rows } = await q(
      `INSERT INTO transactions (budget_id, user_id, pay_period_id, type, amount_cents, description, date, account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.budget.id, req.userId, period[0].id, type, amount, description, date, accountId]
    );
    res.status(201).json({ transaction: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await q(
      'DELETE FROM transactions WHERE id = $1 AND budget_id = $2',
      [Number(req.params.id), req.budget.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Transaction not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
