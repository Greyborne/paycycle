import { Router } from 'express';
import { pool, q } from '../db.js';
import { bad, parseCadenceConfig, requireCents, requireCurrency, requireDate, requireId } from '../validation.js';
import { accountBalances, getConfig, getDefaultAccountId } from '../services/budget.js';
import { periodContaining, todayISO } from '../services/schedule.js';

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
    startedOn: a.started_on ?? null,
    institution: a.institution ?? null,
    numberMask: a.number_mask ?? null,
    source: a.source ?? 'manual',
  };
}

// Snap a requested tracking-start date to the pay period that contains it
// (defaulting to today's period), so an account's start always lands on a
// real period boundary.
async function resolveStartedOn(budget, raw) {
  const cfg = await getConfig(budget.id);
  const date = raw ? requireDate(raw, 'startedOn') : todayISO();
  return cfg ? periodContaining(cfg, date).start : date;
}

// Normalize a requested currency against the household's base: base currency
// is stored as NULL; anything else marks the account as a foreign-currency
// tracked account (own unit, outside period budget math).
// Only the last 4 digits of an account number are ever stored.
function normalizeMask(value) {
  if (value === undefined || value === null) return null;
  const digits = String(value).replace(/\D/g, '');
  return digits ? digits.slice(-4) : null;
}

function normalizeText(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : null;
}

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
  const client = await pool.connect();
  try {
    const { name, type } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) bad('name is required');
    if (type !== undefined && !TYPES.includes(type)) bad(`type must be one of ${TYPES.join(', ')}`);
    const starting = requireCents(req.body.startingBalanceCents ?? 0, 'startingBalanceCents');
    const currency = normalizeCurrency(req.body.currency, req.budget);
    const startedOn = await resolveStartedOn(req.budget, req.body.startedOn);

    // Base-currency accounts budget on the pay-period cadence and need their
    // own config row (migration 013). Foreign-currency (tracked) accounts
    // never budget, so they get none - any requested cadence for one is
    // silently ignored.
    //
    // Validate the cadence choice BEFORE writing anything: parseCadenceConfig
    // can throw (e.g. bad intervalDays), and that must leave zero rows behind
    // rather than an orphaned, unconfigured account.
    let explicitCfg = null;
    if (currency === null && req.body.cadence !== undefined) {
      // User picked this account's own cadence rather than inheriting the
      // default account's. Derivation rules (anchor = this account's
      // tracking-from date, `startedOn`):
      //   weekly/biweekly -> anchorDate = startedOn
      //   custom          -> anchorDate = startedOn, intervalDays from body
      //   monthly         -> day1 = day-of-month of startedOn
      //   semimonthly     -> day1 = 1, day2 = 15 (common default; refine
      //                      later in Settings -> Pay schedule)
      // Built as a plain cadence body and run through the same
      // parseCadenceConfig validation used elsewhere, so invalid input
      // (e.g. missing/out-of-range intervalDays for custom) is rejected
      // consistently.
      const cadence = req.body.cadence;
      const cadenceBody = { cadence };
      if (cadence === 'weekly' || cadence === 'biweekly') {
        cadenceBody.anchorDate = startedOn;
      } else if (cadence === 'custom') {
        cadenceBody.anchorDate = startedOn;
        cadenceBody.intervalDays = req.body.intervalDays;
      } else if (cadence === 'monthly') {
        cadenceBody.day1 = Number(startedOn.slice(8, 10));
      } else if (cadence === 'semimonthly') {
        cadenceBody.day1 = 1;
        cadenceBody.day2 = 15;
      }
      explicitCfg = parseCadenceConfig(cadenceBody);
    }

    await client.query('BEGIN');
    const { rows: maxOrder } = await client.query(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM accounts WHERE budget_id = $1',
      [req.budget.id]
    );
    const { rows: inserted } = await client.query(
      `INSERT INTO accounts (budget_id, name, type, starting_balance_cents, sort_order, currency, institution, number_mask, started_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [req.budget.id, name.trim(), type || 'checking', starting, maxOrder[0].next, currency,
       normalizeText(req.body.institution), normalizeMask(req.body.numberMask), startedOn]
    );

    if (currency === null) {
      if (explicitCfg) {
        await client.query(
          `INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date, day_1, day_2, interval_days)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (account_id) DO NOTHING`,
          [req.budget.id, inserted[0].id, explicitCfg.cadence, explicitCfg.anchor_date,
           explicitCfg.day_1, explicitCfg.day_2, explicitCfg.interval_days]
        );
      } else {
        // No cadence chosen: keep legacy behaviour and inherit the
        // household's default account's cadence rather than starting
        // unconfigured.
        const defaultAccountId = await getDefaultAccountId(req.budget.id);
        const defaultCfg = await getConfig(req.budget.id, defaultAccountId);
        if (defaultCfg) {
          await client.query(
            `INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date, day_1, day_2, interval_days)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (account_id) DO NOTHING`,
            [req.budget.id, inserted[0].id, defaultCfg.cadence, defaultCfg.anchor_date,
             defaultCfg.day_1, defaultCfg.day_2, defaultCfg.interval_days]
          );
        }
      }
    }
    await client.query('COMMIT');
    const rows = await accountBalances(req.budget.id);
    res.status(201).json({ accounts: rows.map(publicAccount) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.patch('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = requireId(req.params.id, 'account');
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
    // Editing the start date only re-anchors the label and future category
    // defaults; it never rewrites existing line items.
    const startedOn = body.startedOn !== undefined
      ? await resolveStartedOn(req.budget, body.startedOn) : a.started_on;
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
         is_default = $5, currency = $6, started_on = $8 WHERE id = $7`,
      [name, type, starting, archived, makeDefault || a.is_default, currency, id, startedOn]
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
