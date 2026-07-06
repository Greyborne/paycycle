import { Router } from 'express';
import { pool } from '../db.js';
import { bad, parseCadenceConfig, requireCents, requireCurrency } from '../validation.js';
import { ensureMaterialized, getConfig } from '../services/budget.js';
import { periodContaining, todayISO } from '../services/schedule.js';

const router = Router();

// First-run setup wizard: cadence config, starting balance, currency, and an
// optional initial set of category templates. Configures the caller's
// household; a member who joined an already-configured household never sees
// this (onboarding_complete is a household flag).
router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (req.budget.onboarding_complete) bad('Setup has already been completed; use Settings instead');

    const cfg = parseCadenceConfig(req.body || {});
    const startingBalance = requireCents(req.body.startingBalanceCents ?? 0, 'startingBalanceCents');
    const currency = requireCurrency(req.body.currency || req.budget.currency);
    const categories = Array.isArray(req.body.categories) ? req.body.categories : [];

    for (const c of categories) {
      if (typeof c.name !== 'string' || !c.name.trim()) bad('Every category needs a name');
      if (!['expense', 'income'].includes(c.type)) bad(`Category "${c.name}": type must be expense or income`);
      requireCents(c.amountCents ?? 0, `Category "${c.name}" amount`);
      if (c.recurrence === 'monthly') {
        if (!Number.isInteger(c.dueDay) || c.dueDay < 1 || c.dueDay > 31) bad(`Category "${c.name}": dueDay must be 1-31`);
      } else if (c.recurrence && c.recurrence !== 'every_period') {
        bad(`Category "${c.name}": recurrence must be every_period or monthly`);
      }
    }

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO pay_period_configs (budget_id, cadence, anchor_date, day_1, day_2, interval_days)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (budget_id) DO UPDATE SET cadence = $2, anchor_date = $3, day_1 = $4, day_2 = $5,
         interval_days = $6, updated_at = now()`,
      [req.budget.id, cfg.cadence, cfg.anchor_date, cfg.day_1, cfg.day_2, cfg.interval_days]
    );
    await client.query(
      'UPDATE budgets SET currency = $1, onboarding_complete = TRUE WHERE id = $2',
      [currency, req.budget.id]
    );
    // The wizard's starting balance seeds the household's default account.
    await client.query(
      `UPDATE accounts SET starting_balance_cents = $1
       WHERE budget_id = $2 AND is_default AND NOT archived`,
      [startingBalance, req.budget.id]
    );

    // Initial amounts take effect from the start of the current period so the
    // very first period the user sees is fully populated.
    const effectiveFrom = periodContaining(cfg, todayISO()).start;
    let order = 0;
    for (const c of categories) {
      const { rows } = await client.query(
        `INSERT INTO category_templates (budget_id, name, type, recurrence, due_day, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [req.budget.id, c.name.trim(), c.type, c.recurrence === 'monthly' ? 'monthly' : 'every_period',
         c.recurrence === 'monthly' ? c.dueDay : null, order++]
      );
      await client.query(
        'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, $2, $3)',
        [rows[0].id, c.amountCents ?? 0, effectiveFrom]
      );
    }
    await client.query('COMMIT');

    await ensureMaterialized(req.budget.id, await getConfig(req.budget.id));
    res.status(201).json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

export default router;
