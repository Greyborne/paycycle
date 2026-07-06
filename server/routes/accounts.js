import { Router } from 'express';
import { pool, q } from '../db.js';
import { bad, requireCents, requireCurrency } from '../validation.js';
import { accountBalances } from '../services/budget.js';

const router = Router();

const TYPES = ['checking', 'savings', 'credit', 'cash', 'other'];

function publicAccount(a) {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    currency: a.currency, // null = household base currency
    startingBalanceCents: a.starting_balance_cents,
    balanceCents: a.balance_cents,
    isDefault: a.is_default,
    archived: a.archived,
    sortOrder: a.sort_order,
  };
}

// Normalize a requested currency against the household's base: base currency
// is stored as NULL; anything else marks the account as a foreign-currency
// tracked account (own unit, outside period budget math).
function normalizeCurrency(value, budget) {
  if (value === undefined || value === null || value === '') return null;
  const code = requireCurrency(value);
  return code === budget.currency ? null : code;
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
    const currency = normalizeCurrency(req.body.currency, req.budget);
    const { rows: maxOrder } = await q(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM accounts WHERE budget_id = $1',
      [req.budget.id]
    );
    await q(
      `INSERT INTO accounts (budget_id, name, type, starting_balance_cents, sort_order, currency)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.budget.id, name.trim(), type || 'checking', starting, maxOrder[0].next, currency]
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

    let currency = a.currency;
    if (body.currency !== undefined) {
      currency = normalizeCurrency(body.currency, req.budget);
      if (currency !== a.currency) {
        // Amounts never convert - only allow re-denominating an account that
        // has no budget history attached.
        const { rows: items } = await q(
          'SELECT 1 FROM line_items WHERE account_id = $1 LIMIT 1', [id]
        );
        if (items.length) bad('This account has cleared budget items and cannot change currency');
      }
    }
    if (currency !== null && (makeDefault || a.is_default)) {
      bad('The default account must use the household currency');
    }

    await client.query('BEGIN');
    if (makeDefault) {
      await client.query(
        'UPDATE accounts SET is_default = FALSE WHERE budget_id = $1 AND is_default',
        [req.budget.id]
      );
    }
    await client.query(
      `UPDATE accounts SET name = $1, type = $2, starting_balance_cents = $3, archived = $4,
         is_default = $5, currency = $6 WHERE id = $7`,
      [name, type, starting, archived, makeDefault || a.is_default, currency, id]
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
