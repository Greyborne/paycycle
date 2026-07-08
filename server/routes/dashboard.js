import { Router } from 'express';
import { bad } from '../validation.js';
import {
  getConfig, ensureMaterialized, buildProjection, accountBalances, resolveAccountId,
} from '../services/budget.js';

const router = Router();

// Everything the dashboard needs in one call: the selected account's actual
// balance and forward projection with threshold-crossing flags, plus every
// account's balance for the net-worth strip. The projection is always scoped
// to one base-currency account (?account=), defaulting to the default
// account — a healthy household total can hide an overdraft in one account.
router.get('/', async (req, res, next) => {
  try {
    const cfg = await getConfig(req.budget.id);
    if (!cfg || !req.budget.onboarding_complete) bad('Complete setup first');
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 24, 1), 60);

    await ensureMaterialized(req.budget.id, cfg);
    const accountId = await resolveAccountId(req.budget.id, req.query.account);
    const projection = await buildProjection(req.budget, cfg, { months, accountId });
    const accounts = await accountBalances(req.budget.id);
    const netWorthCents = accounts
      .filter((a) => !a.currency)
      .reduce((sum, a) => sum + a.balance_cents, 0);

    res.json({
      accountId,
      accounts: accounts.map((a) => ({
        id: a.id, name: a.name, type: a.type, currency: a.currency, balanceCents: a.balance_cents,
        isDefault: a.is_default, archived: a.archived,
      })),
      netWorthCents,
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
