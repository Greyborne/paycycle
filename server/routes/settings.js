import { Router } from 'express';
import { q } from '../db.js';
import { bad, parseCadenceConfig, requireCents, requireCurrency, requireId } from '../validation.js';
import { getBudget, getUser } from '../services/budget.js';
import { emailEnabled } from '../services/mailer.js';
import { publicUser } from './auth.js';

const router = Router();

function publicConfig(c) {
  if (!c) return null;
  return {
    cadence: c.cadence,
    anchorDate: c.anchor_date,
    day1: c.day_1,
    day2: c.day_2,
    intervalDays: c.interval_days,
  };
}

// One schedule per non-archived, base-currency account of the budget
// (foreign-currency and archived accounts don't budget / have no config
// row). Ordered the same way accounts are ordered elsewhere.
async function getPayPeriodConfigs(budgetId) {
  const { rows } = await q(
    `SELECT a.id AS account_id, a.name AS account_name, a.is_default,
            c.cadence, c.anchor_date, c.day_1, c.day_2, c.interval_days
     FROM accounts a
     LEFT JOIN pay_period_configs c ON c.account_id = a.id
     WHERE a.budget_id = $1 AND NOT a.archived AND a.currency IS NULL
     ORDER BY a.sort_order, a.id`,
    [budgetId]
  );
  return rows.map((r) => ({
    accountId: r.account_id,
    accountName: r.account_name,
    isDefault: r.is_default,
    ...publicConfig(r.cadence == null ? null : r),
  }));
}

router.get('/', async (req, res, next) => {
  try {
    const [user, payPeriodConfigs] = await Promise.all([
      getUser(req.userId), getPayPeriodConfigs(req.budget.id),
    ]);
    res.json({
      user: publicUser(user, req.budget),
      payPeriodConfigs,
      emailEnabled: emailEnabled(),
    });
  } catch (err) {
    next(err);
  }
});

// Per-account cadence editing (Phase 4b). Existing real periods are kept
// as-is; the new schedule applies from that account's next period forward.
router.put('/schedule/:accountId', async (req, res, next) => {
  try {
    const budget = req.budget;
    const accountId = requireId(req.params.accountId, 'account');

    const { rows: acctRows } = await q(
      'SELECT id FROM accounts WHERE id = $1 AND budget_id = $2 AND NOT archived AND currency IS NULL',
      [accountId, budget.id]
    );
    if (!acctRows.length) bad('Unknown account');

    const cfg = parseCadenceConfig(req.body || {});
    await q(
      `UPDATE pay_period_configs SET cadence = $1, anchor_date = $2, day_1 = $3, day_2 = $4,
         interval_days = $5, updated_at = now() WHERE account_id = $6`,
      [cfg.cadence, cfg.anchor_date, cfg.day_1, cfg.day_2, cfg.interval_days, accountId]
    );

    const payPeriodConfigs = await getPayPeriodConfigs(budget.id);
    res.json({ payPeriodConfigs });
  } catch (err) {
    next(err);
  }
});

// Household-level settings; any member can edit them.
router.put('/', async (req, res, next) => {
  try {
    const budget = req.budget;
    const body = req.body || {};

    const currency = body.currency !== undefined ? requireCurrency(body.currency) : budget.currency;
    const low = body.thresholdLowCents !== undefined
      ? requireCents(body.thresholdLowCents, 'thresholdLowCents') : budget.threshold_low_cents;
    const healthy = body.thresholdHealthyCents !== undefined
      ? requireCents(body.thresholdHealthyCents, 'thresholdHealthyCents') : budget.threshold_healthy_cents;
    const warning = body.warningThresholdCents !== undefined
      ? requireCents(body.warningThresholdCents, 'warningThresholdCents') : budget.warning_threshold_cents;
    const drift = body.driftThresholdCents !== undefined
      ? requireCents(body.driftThresholdCents, 'driftThresholdCents') : budget.drift_threshold_cents;
    if (low < 0 || healthy < 0 || warning < 0) bad('Thresholds cannot be negative');
    if (healthy < low) bad('The healthy threshold must be at least the low threshold');

    await q(
      `UPDATE budgets SET currency = $1, threshold_low_cents = $2,
         threshold_healthy_cents = $3, warning_threshold_cents = $4, drift_threshold_cents = $6 WHERE id = $5`,
      [currency, low, healthy, warning, budget.id, drift]
    );

    // Email opt-in is per user, not per household.
    if (body.emailNotifications !== undefined) {
      await q(
        'UPDATE users SET email_notifications = $1 WHERE id = $2',
        [Boolean(body.emailNotifications), req.userId]
      );
    }

    // Cadence is no longer editable here - see PUT /schedule/:accountId
    // (Phase 4b, docs/plans/account-first-periods.md). This route only
    // touches household currency/thresholds/email opt-in.

    const [user, updatedBudget] = await Promise.all([
      getUser(req.userId), getBudget(budget.id),
    ]);
    res.json({
      user: publicUser(user, { ...updatedBudget, role: req.budgetRole }),
      emailEnabled: emailEnabled(),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
