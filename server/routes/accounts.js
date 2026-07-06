import { Router } from 'express';
import { pool, q } from '../db.js';
import { bad, requireCents } from '../validation.js';
import { accountBalances } from '../services/budget.js';

const router = Router();

const TYPES = ['checking', 'savings', 'credit', 'cash', 'other'];

function publicAccount(a) {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    startingBalanceCents: a.starting_balance_cents,
    balanceCents: a.balance_cents,
    isDefault: a.is_default,
    archived: a.archived,
    sortOrder: a.sort_order,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const rows = await accountBalances(req.budget.id);
    res.json({ accounts: rows.map(publicAccount) });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, type } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) bad('name is required');
    if (type !== undefined && !TYPES.includes(type)) bad(`type must be one of ${TYPES.join(', ')}`);
    const starting = requireCents(req.body.startingBalanceCents ?? 0, 'startingBalanceCents');
    const { rows: maxOrder } = await q(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM accounts WHERE budget_id = $1',
      [req.budget.id]
    );
    await q(
      `INSERT INTO accounts (budget_id, name, type, starting_balance_cents, sort_order)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.budget.id, name.trim(), type || 'checking', starting, maxOrder[0].next]
    );
    const rows = await accountBalances(req.budget.id);
    res.status(201).json({ accounts: rows.map(publicAccount) });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const { rows: existing } = await q(
      'SELECT * FROM accounts WHERE id = $1 AND budget_id = $2', [id, req.budget.id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Account not found' });
    const a = existing[0];
    const body = req.body || {};

    const name = body.name !== undefined
      ? (typeof body.name === 'string' && body.name.trim() ? body.name.trim() : bad('name cannot be empty'))
      : a.name;
    if (body.type !== undefined && !TYPES.includes(body.type)) bad(`type must be one of ${TYPES.join(', ')}`);
    const type = body.type ?? a.type;
    const starting = body.startingBalanceCents !== undefined
      ? requireCents(body.startingBalanceCents, 'startingBalanceCents') : a.starting_balance_cents;
    const archived = body.archived !== undefined ? Boolean(body.archived) : a.archived;
    const makeDefault = body.isDefault === true && !a.is_default;
    if (a.is_default && archived) bad('Make another account the default before archiving this one');
    if (makeDefault && archived) bad('An archived account cannot be the default');

    await client.query('BEGIN');
    if (makeDefault) {
      await client.query(
        'UPDATE accounts SET is_default = FALSE WHERE budget_id = $1 AND is_default',
        [req.budget.id]
      );
    }
    await client.query(
      `UPDATE accounts SET name = $1, type = $2, starting_balance_cents = $3, archived = $4,
         is_default = $5 WHERE id = $6`,
      [name, type, starting, archived, makeDefault || a.is_default, id]
    );
    await client.query('COMMIT');
    const rows = await accountBalances(req.budget.id);
    res.json({ accounts: rows.map(publicAccount) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

export default router;
