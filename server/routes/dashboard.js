import { Router } from 'express';
import { bad } from '../validation.js';
import { getConfig, ensureMaterialized, buildProjection, accountBalances } from '../services/budget.js';

const router = Router();

// Everything the dashboard needs in one call: current actual balance, the
// current period's planned-vs-cleared summary, and the forward projection
// with threshold-crossing flags.
router.get('/', async (req, res, next) => {
  try {
    const cfg = await getConfig(req.budget.id);
    if (!cfg || !req.budget.onboarding_complete) bad('Complete setup first');
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 24, 1), 60);

    await ensureMaterialized(req.budget.id, cfg);
    const projection = await buildProjection(req.budget, cfg, { months });
    const accounts = await accountBalances(req.budget.id);

    res.json({
      accounts: accounts.map((a) => ({
        id: a.id, name: a.name, type: a.type, currency: a.currency, balanceCents: a.balance_cents,
        isDefault: a.is_default, archived: a.archived,
      })),
      currency: req.budget.currency,
      thresholds: {
        lowCents: req.budget.threshold_low_cents,
        healthyCents: req.budget.threshold_healthy_cents,
        warningCents: req.budget.warning_threshold_cents,
      },
      actualBalanceCents: projection.actualBalanceCents,
      actualAsOf: projection.actualAsOf,
      currentPeriod: projection.entries[projection.currentIndex] || null,
      projection: projection.entries,
      firstNegative: projection.firstNegative,
      firstBelowWarning: projection.firstBelowWarning,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
