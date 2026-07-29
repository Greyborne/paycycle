import { Router } from 'express';
import { pool, q } from '../db.js';
import { bad, parseCadenceConfig, requireCents, requireCurrency, requireDate, requireId } from '../validation.js';
import {
  ensureMaterialized, getBudget, getConfig, getDefaultAccountId, getLifecycle, getUser,
  loadTemplates, recalculateOpenPeriodActuals, syncLineItems,
} from '../services/budget.js';
import { periodContaining } from '../services/schedule.js';
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

// One-off correction of the CURRENT (open, not-yet-closed) period's own
// start/end date - e.g. the account's anchor day was fat-fingered by a day
// or two at setup. This is deliberately NOT the same lever as PUT
// /schedule/:accountId above: that route changes the account's cadence
// config going forward and never touches a real pay_periods row; this route
// rewrites the one row that is still open, in place, and leaves
// pay_period_configs.anchor_date exactly as-is. ensureMaterialized then
// keeps walking forward from this row's (now corrected) end_date, so later
// periods pick up the fix automatically without any further action here.
router.put('/schedule/:accountId/current-period', async (req, res, next) => {
  try {
    const budget = req.budget;
    const accountId = requireId(req.params.accountId, 'account');

    const { rows: acctRows } = await q(
      'SELECT id FROM accounts WHERE id = $1 AND budget_id = $2 AND NOT archived AND currency IS NULL',
      [accountId, budget.id]
    );
    if (!acctRows.length) bad('Unknown account');

    const startDate = requireDate((req.body || {}).startDate, 'startDate');

    await ensureMaterialized(budget.id);
    const cfg = await getConfig(budget.id, accountId);
    if (!cfg) bad('This account has no pay schedule configured yet');
    const lifecycle = await getLifecycle(budget.id, cfg, accountId);

    // Derive the corrected period's own boundaries from the account's
    // cadence math rather than trusting a client-supplied end date.
    // Overriding anchor_date to the corrected startDate before calling
    // periodContaining reuses the existing weekly/biweekly/custom interval
    // math unchanged (k = 0, so start = startDate exactly, end = start +
    // (interval - 1)) without duplicating it here; for semimonthly/monthly,
    // anchor_date is unused and periodContaining resolves the calendar
    // period (by day_1/day_2) that actually contains startDate, which is
    // the only boundary "self-consistent with the cadence" for those.
    const corrected = periodContaining({ ...cfg, anchor_date: startDate }, startDate);

    const client = await pool.connect();
    let updatedRow;
    try {
      await client.query('BEGIN');
      // Lock the row before validating against it so a concurrent close (or
      // a concurrent correction) serializes behind this one instead of
      // racing on a stale read.
      const { rows: curRows } = await client.query(
        'SELECT * FROM pay_periods WHERE account_id = $1 AND start_date = $2 FOR UPDATE',
        [accountId, lifecycle.currentStart]
      );
      if (!curRows.length) bad('The current pay period is not recorded yet');
      const periodRow = curRows[0];
      if (periodRow.closed_at) bad('The current pay period is already closed and cannot be corrected here');

      // Collision with an existing (account_id, start_date) row - explicit
      // check so the UNIQUE constraint never surfaces as a raw 500. Same
      // startDate as the row's own current start is the idempotent no-op
      // case, not a collision.
      if (corrected.start !== periodRow.start_date) {
        const { rows: collide } = await client.query(
          'SELECT id FROM pay_periods WHERE account_id = $1 AND start_date = $2 AND id <> $3',
          [accountId, corrected.start, periodRow.id]
        );
        if (collide.length) bad('A pay period already starts on that date');
      }

      // Overlap with the immediately-previous real period for this account -
      // this is a one-off correction of the current period, not a cadence
      // change, so it must not eat into what is already recorded there.
      const { rows: prevRows } = await client.query(
        'SELECT end_date FROM pay_periods WHERE account_id = $1 AND start_date < $2 ORDER BY start_date DESC LIMIT 1',
        [accountId, periodRow.start_date]
      );
      if (prevRows.length && corrected.start <= prevRows[0].end_date) {
        bad('That start date overlaps the previous pay period');
      }

      const { rows: updated } = await client.query(
        'UPDATE pay_periods SET start_date = $1, end_date = $2 WHERE id = $3 RETURNING *',
        [corrected.start, corrected.end, periodRow.id]
      );
      updatedRow = updated[0];

      // Resync line items for the new boundary (e.g. a monthly bill's
      // occurrence that only now falls inside the corrected window) and
      // recompute cleared actuals - the same helpers ensureMaterialized
      // itself uses, never new sync logic.
      const templates = await loadTemplates(budget.id, { dbc: client });
      const defaultAccountId = await getDefaultAccountId(budget.id, client);
      const acctTemplates = templates.filter((t) => (t.account_id ?? defaultAccountId) === accountId);
      await syncLineItems(client, updatedRow, acctTemplates, defaultAccountId);
      await recalculateOpenPeriodActuals(client, budget.id);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    res.json({
      period: { id: updatedRow.id, accountId, start: updatedRow.start_date, end: updatedRow.end_date },
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
