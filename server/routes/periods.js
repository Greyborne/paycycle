import { Router } from 'express';
import { q } from '../db.js';
import { bad, requireCents, requireDate } from '../validation.js';
import { getConfig, ensureMaterialized, getPeriodDetail } from '../services/budget.js';
import { addDays, periodBefore, periodContaining, todayISO } from '../services/schedule.js';

const router = Router();

async function loadContext(req) {
  const cfg = await getConfig(req.budget.id);
  if (!cfg || !req.budget.onboarding_complete) bad('Complete setup first');
  return { budget: req.budget, cfg };
}

function withNav(cfg, detail) {
  const period = { start: detail.period.start, end: detail.period.end };
  return {
    ...detail,
    nav: {
      prevStart: periodBefore(cfg, period).start,
      nextStart: periodContaining(cfg, addDays(period.end, 1)).start,
    },
  };
}

// The period containing today.
router.get('/current', async (req, res, next) => {
  try {
    const { budget, cfg } = await loadContext(req);
    await ensureMaterialized(budget.id, cfg);
    const start = periodContaining(cfg, todayISO()).start;
    // After a cadence change the stored current period may start on a
    // different day than the schedule now says; find it by containment.
    const { rows } = await q(
      'SELECT start_date FROM pay_periods WHERE budget_id = $1 AND start_date <= $2 AND end_date >= $2 ORDER BY start_date DESC LIMIT 1',
      [budget.id, todayISO()]
    );
    const detail = await getPeriodDetail(budget, cfg, rows.length ? rows[0].start_date : start);
    res.json(withNav(cfg, detail));
  } catch (err) {
    next(err);
  }
});

// A specific period by start date (materialized -> editable; future -> projected).
router.get('/:start', async (req, res, next) => {
  try {
    const { budget, cfg } = await loadContext(req);
    const start = requireDate(req.params.start, 'start');
    await ensureMaterialized(budget.id, cfg);
    const detail = await getPeriodDetail(budget, cfg, start);
    if (!detail) return res.status(404).json({ error: 'No such pay period' });
    res.json(withNav(cfg, detail));
  } catch (err) {
    next(err);
  }
});

// Edit a line item in a materialized period: planned amount and/or cleared.
router.patch('/line-items/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await q(
      `SELECT li.* FROM line_items li
       JOIN pay_periods pp ON pp.id = li.pay_period_id
       WHERE li.id = $1 AND pp.budget_id = $2`,
      [id, req.budget.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Line item not found' });
    const item = rows[0];
    const body = req.body || {};
    const planned = body.plannedAmountCents !== undefined
      ? requireCents(body.plannedAmountCents, 'plannedAmountCents')
      : item.planned_amount_cents;
    let cleared = item.cleared;
    let clearedDate = item.cleared_date;
    if (body.cleared !== undefined) {
      cleared = Boolean(body.cleared);
      clearedDate = cleared ? (item.cleared_date || todayISO()) : null;
    }
    let accountId = item.account_id;
    if (body.accountId !== undefined) {
      const { rows: acct } = await q(
        'SELECT id FROM accounts WHERE id = $1 AND budget_id = $2 AND currency IS NULL',
        [body.accountId, req.budget.id]
      );
      if (!acct.length) return res.status(400).json({ error: 'Line items can only clear to household-currency accounts' });
      accountId = body.accountId;
    }
    const { rows: updated } = await q(
      'UPDATE line_items SET planned_amount_cents = $1, cleared = $2, cleared_date = $3, account_id = $4 WHERE id = $5 RETURNING *',
      [planned, cleared, clearedDate, accountId, id]
    );
    res.json({ lineItem: updated[0] });
  } catch (err) {
    next(err);
  }
});

export default router;
