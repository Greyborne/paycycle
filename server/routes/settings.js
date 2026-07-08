import { Router } from 'express';
import { q } from '../db.js';
import { bad, parseCadenceConfig, requireCents, requireCurrency } from '../validation.js';
import { getBudget, getConfig, getUser } from '../services/budget.js';
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

router.get('/', async (req, res, next) => {
  try {
    const [user, cfg] = await Promise.all([getUser(req.userId), getConfig(req.budget.id)]);
    res.json({
      user: publicUser(user, req.budget),
      payPeriodConfig: publicConfig(cfg),
      emailEnabled: emailEnabled(),
    });
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

    // Cadence is editable post-onboarding: existing real periods are kept
    // as-is and the new schedule applies from the next period forward.
    if (body.cadence !== undefined) {
      const cfg = parseCadenceConfig(body);
      await q(
        `UPDATE pay_period_configs SET cadence = $1, anchor_date = $2, day_1 = $3, day_2 = $4,
           interval_days = $5, updated_at = now() WHERE budget_id = $6`,
        [cfg.cadence, cfg.anchor_date, cfg.day_1, cfg.day_2, cfg.interval_days, budget.id]
      );
    }

    const [user, updatedBudget, updatedCfg] = await Promise.all([
      getUser(req.userId), getBudget(budget.id), getConfig(budget.id),
    ]);
    res.json({
      user: publicUser(user, { ...updatedBudget, role: req.budgetRole }),
      payPeriodConfig: publicConfig(updatedCfg),
      emailEnabled: emailEnabled(),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
