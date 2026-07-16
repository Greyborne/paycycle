import { Router } from 'express';
import { pool, q } from '../db.js';
import { bad, requireCents, requireDate } from '../validation.js';
import {
  buildProjection, clearedBalancesForPeriod, ensureMaterialized, getConfig, getDefaultAccountId,
  getLifecycle, getPeriodDetail, materializePeriodAfter, resolveAccountId, setAmountGoingForward,
} from '../services/budget.js';
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

// The lifecycle-current period: the earliest not-yet-closed one (which is
// the period containing today until closing starts, and can sit in the
// future once every recorded period is closed).
router.get('/current', async (req, res, next) => {
  try {
    const { budget } = await loadContext(req);
    await ensureMaterialized(budget.id);
    const accountId = await resolveAccountId(budget.id, req.query.account);
    // The account's own cadence/config, not the household-default bridge -
    // nav boundaries and lifecycle must reflect this account's schedule.
    const cfg = await getConfig(budget.id, accountId);
    const lifecycle = await getLifecycle(budget.id, cfg, accountId);
    const detail = await getPeriodDetail(budget, cfg, lifecycle.currentStart, accountId);
    res.json({ ...withNav(cfg, detail), accountId });
  } catch (err) {
    next(err);
  }
});

// A specific period by start date (materialized -> editable; future -> projected).
router.get('/:start', async (req, res, next) => {
  try {
    const { budget } = await loadContext(req);
    const start = requireDate(req.params.start, 'start');
    await ensureMaterialized(budget.id);
    const accountId = await resolveAccountId(budget.id, req.query.account);
    // The account's own cadence/config, not the household-default bridge.
    const cfg = await getConfig(budget.id, accountId);
    const detail = await getPeriodDetail(budget, cfg, start, accountId);
    if (!detail) return res.status(404).json({ error: 'No such pay period' });
    res.json({ ...withNav(cfg, detail), accountId });
  } catch (err) {
    next(err);
  }
});

// The state a close-out has to resolve before the current period can close:
// uncleared planned items, and the reconciliation discrepancy that would
// remain even if every one of them were marked cleared.
async function unclearedItems(periodId) {
  const { rows } = await q(
    `SELECT li.id, li.planned_amount_cents, ct.name, ct.type
     FROM line_items li JOIN category_templates ct ON ct.id = li.category_template_id
     WHERE li.pay_period_id = $1 AND NOT li.cleared AND li.planned_amount_cents <> 0
     ORDER BY ct.type, ct.sort_order, ct.id`,
    [periodId]
  );
  return rows;
}

async function requireCurrentPeriod(budget, cfg, start, accountId) {
  const lifecycle = await getLifecycle(budget.id, cfg, accountId);
  if (start !== lifecycle.currentStart) bad('Only the current pay period can be closed');
  const { rows } = await q(
    'SELECT * FROM pay_periods WHERE budget_id = $1 AND start_date = $2 AND account_id = $3',
    [budget.id, start, accountId]
  );
  if (!rows.length) bad('The current period is not recorded yet');
  if (rows[0].closed_at) bad('This period is already closed');
  return rows[0];
}

router.get('/:start/close-preview', async (req, res, next) => {
  try {
    const { budget } = await loadContext(req);
    const start = requireDate(req.params.start, 'start');
    const accountId = await resolveAccountId(budget.id, req.query.account);
    const cfg = await getConfig(budget.id, accountId);
    await ensureMaterialized(budget.id);
    const periodRow = await requireCurrentPeriod(budget, cfg, start, accountId);
    const uncleared = await unclearedItems(periodRow.id);
    const projection = await buildProjection(budget, cfg, { months: 12, accountId });
    const entry = projection.entries.find((e) => e.start === start);
    const unclearedNet = uncleared.reduce(
      (sum, i) => sum + (i.type === 'income' ? i.planned_amount_cents : -i.planned_amount_cents), 0
    );
    const predictedCleared = (entry?.clearedBalance ?? 0) + unclearedNet;
    res.json({
      uncleared: uncleared.map((i) => ({
        id: i.id, name: i.name, type: i.type, plannedAmountCents: i.planned_amount_cents,
      })),
      estBalanceCents: entry?.estBalance ?? 0,
      predictedClearedCents: predictedCleared,
      discrepancyCents: (entry?.estBalance ?? 0) - predictedCleared,
    });
  } catch (err) {
    next(err);
  }
});

// Close the current period. Every uncleared planned item needs a resolution
// (clear / carry to next period / remove this occurrence); any remaining
// reconciliation discrepancy needs an explicit choice (log an adjustment
// line, or accept the mismatch). The cleared balance is then frozen into a
// snapshot and the next period becomes current.
router.post('/:start/close', async (req, res, next) => {
  try {
    const { budget } = await loadContext(req);
    const start = requireDate(req.params.start, 'start');
    const accountId = await resolveAccountId(budget.id, req.query.account);
    const cfg = await getConfig(budget.id, accountId);
    await ensureMaterialized(budget.id);
    const periodRow = await requireCurrentPeriod(budget, cfg, start, accountId);
    const body = req.body || {};
    const resolutions = body.resolutions || {};

    const uncleared = await unclearedItems(periodRow.id);
    for (const item of uncleared) {
      if (!['clear', 'carry', 'remove'].includes(resolutions[item.id])) {
        bad(`"${item.name}" has not cleared — choose whether to clear, carry, or remove it`);
      }
    }

    // The carry target (and the next current period) must exist as a row.
    const nextRow = await materializePeriodAfter(budget.id, accountId, cfg, {
      start: periodRow.start_date, end: periodRow.end_date,
    });

    // Everything done here is recorded so a reopen can undo it.
    const resolutionLog = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of uncleared) {
        const action = resolutions[item.id];
        if (action === 'clear') {
          await client.query(
            'UPDATE line_items SET cleared = TRUE, cleared_date = $1 WHERE id = $2',
            [todayISO(), item.id]
          );
          resolutionLog.push({ action: 'clear', itemId: item.id });
        } else if (action === 'carry') {
          const { rows: li } = await client.query('SELECT * FROM line_items WHERE id = $1', [item.id]);
          await client.query(
            `INSERT INTO line_items (pay_period_id, category_template_id, planned_amount_cents, account_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (pay_period_id, category_template_id)
             DO UPDATE SET planned_amount_cents = line_items.planned_amount_cents + EXCLUDED.planned_amount_cents`,
            [nextRow.id, li[0].category_template_id, li[0].planned_amount_cents, li[0].account_id]
          );
          await client.query('DELETE FROM line_items WHERE id = $1', [item.id]);
          resolutionLog.push({
            action: 'carry',
            targetPeriodId: nextRow.id,
            item: {
              categoryTemplateId: li[0].category_template_id,
              plannedAmountCents: li[0].planned_amount_cents,
              accountId: li[0].account_id,
            },
          });
        } else {
          const { rows: li } = await client.query('SELECT * FROM line_items WHERE id = $1', [item.id]);
          await client.query('DELETE FROM line_items WHERE id = $1', [item.id]);
          resolutionLog.push({
            action: 'remove',
            item: {
              categoryTemplateId: li[0].category_template_id,
              plannedAmountCents: li[0].planned_amount_cents,
              accountId: li[0].account_id,
            },
          });
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // With every planned item resolved, any remaining est-vs-cleared gap is
    // drift inherited from history. It needs an explicit decision.
    let projection = await buildProjection(budget, cfg, { months: 12, accountId });
    let entry = projection.entries.find((e) => e.start === start);
    const discrepancy = (entry?.estBalance ?? 0) - (entry?.clearedBalance ?? 0);
    if (discrepancy !== 0) {
      if (!['adjust', 'accept'].includes(body.discrepancy)) {
        bad('The cleared balance does not reconcile with the estimate — choose to log an adjustment or accept the mismatch');
      }
      if (body.discrepancy === 'adjust') {
        // An uncleared adjustment line shifts the estimate (not the cleared
        // side) by exactly the drift, so estimates match reality from here
        // on. The template is archived so it never seeds future periods.
        const type = discrepancy > 0 ? 'expense' : 'income';
        const { rows: tpl } = await q(
          `SELECT id FROM category_templates WHERE budget_id = $1 AND name = 'Close-out adjustment' AND type = $2`,
          [budget.id, type]
        );
        let templateId = tpl[0]?.id;
        if (!templateId) {
          const { rows: created } = await q(
            `INSERT INTO category_templates (budget_id, name, type, recurrence, sort_order, archived)
             VALUES ($1, 'Close-out adjustment', $2, 'every_period', 9999, TRUE) RETURNING id`,
            [budget.id, type]
          );
          templateId = created[0].id;
        }
        const { rows: adj } = await q(
          `INSERT INTO line_items (pay_period_id, category_template_id, planned_amount_cents, account_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (pay_period_id, category_template_id)
           DO UPDATE SET planned_amount_cents = line_items.planned_amount_cents + EXCLUDED.planned_amount_cents
           RETURNING id`,
          [periodRow.id, templateId, Math.abs(discrepancy), accountId]
        );
        resolutionLog.push({ action: 'adjust', itemId: adj[0].id });
      }
    }

    const snapshot = {
      ...await clearedBalancesForPeriod(budget, cfg, start, accountId),
      resolutions: resolutionLog,
    };
    await q(
      'UPDATE pay_periods SET closed_at = now(), closed_snapshot = $1 WHERE id = $2',
      [JSON.stringify(snapshot), periodRow.id]
    );
    res.json({ ok: true, nextStart: nextRow.start_date, snapshot });
  } catch (err) {
    next(err);
  }
});

// Reopen the most recently closed period: it becomes current again and
// everything after it reverts to projected behavior.
router.post('/:start/reopen', async (req, res, next) => {
  try {
    const { budget } = await loadContext(req);
    const start = requireDate(req.params.start, 'start');
    const accountId = await resolveAccountId(budget.id, req.query.account);
    const cfg = await getConfig(budget.id, accountId);
    const lifecycle = await getLifecycle(budget.id, cfg, accountId);
    if (!lifecycle.latestClosedStart || start !== lifecycle.latestClosedStart) {
      bad('Only the most recently closed period can be reopened');
    }
    const { rows: periodRow } = await q(
      'SELECT * FROM pay_periods WHERE budget_id = $1 AND start_date = $2 AND account_id = $3',
      [budget.id, start, accountId]
    );
    // Undo what close-out did: carried items come back (and out of the next
    // period), removed items come back, the close-out adjustment line goes
    // away. Explicit "mark cleared" choices stand.
    const log = periodRow[0]?.closed_snapshot?.resolutions ?? [];
    for (const entry of [...log].reverse()) {
      if (entry.action === 'carry') {
        await q(
          `UPDATE line_items SET planned_amount_cents = GREATEST(planned_amount_cents - $1, 0)
           WHERE pay_period_id = $2 AND category_template_id = $3`,
          [entry.item.plannedAmountCents, entry.targetPeriodId, entry.item.categoryTemplateId]
        );
      }
      if (entry.action === 'carry' || entry.action === 'remove') {
        await q(
          `INSERT INTO line_items (pay_period_id, category_template_id, planned_amount_cents, account_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (pay_period_id, category_template_id)
           DO UPDATE SET planned_amount_cents = EXCLUDED.planned_amount_cents, cleared = FALSE, cleared_date = NULL`,
          [periodRow[0].id, entry.item.categoryTemplateId, entry.item.plannedAmountCents, entry.item.accountId]
        );
      }
      if (entry.action === 'adjust') {
        await q('DELETE FROM line_items WHERE id = $1', [entry.itemId]);
      }
    }
    await q(
      'UPDATE pay_periods SET closed_at = NULL, closed_snapshot = NULL WHERE budget_id = $1 AND start_date = $2 AND account_id = $3',
      [budget.id, start, accountId]
    );
    res.json({ ok: true, restored: log.filter((e) => e.action !== 'clear').length });
  } catch (err) {
    next(err);
  }
});

// Edit a line item in a materialized period: planned amount and/or cleared.
router.patch('/line-items/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await q(
      `SELECT li.*, pp.closed_at, pp.start_date AS period_start FROM line_items li
       JOIN pay_periods pp ON pp.id = li.pay_period_id
       WHERE li.id = $1 AND pp.budget_id = $2`,
      [id, req.budget.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Line item not found' });
    if (rows[0].closed_at) bad('This pay period is closed — reopen it to make changes');
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

    // scope 'forward': record the new amount on the category effective from
    // this period and roll it through every open period + the projection.
    // Otherwise only this one period's frozen snapshot changes.
    if (body.scope === 'forward' && body.plannedAmountCents !== undefined) {
      // Roll forward on the item's OWN account's cadence, not the household
      // default's — periods are per-account (migration 013), so which
      // periods "on or after this date" means depends on whose schedule.
      const cfg = await getConfig(req.budget.id, accountId);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'UPDATE line_items SET cleared = $1, cleared_date = $2, account_id = $3 WHERE id = $4',
          [cleared, clearedDate, accountId, id]
        );
        const touched = await setAmountGoingForward(
          client, req.budget.id, cfg, item.category_template_id, planned, item.period_start
        );
        await client.query('COMMIT');
        const { rows: updated } = await q('SELECT * FROM line_items WHERE id = $1', [id]);
        return res.json({ lineItem: updated[0], scope: 'forward', periodsUpdated: touched });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
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

// Create (or upsert) a line item for a category in a period that has none —
// e.g. a monthly bill that posted a period early, so its category shows as a
// read-only $0 placeholder. Same scope choice as editing: 'period' records it
// only here; 'forward' also updates the recurring amount going forward.
router.post('/:start/line-items', async (req, res, next) => {
  try {
    const { budget } = await loadContext(req);
    const start = requireDate(req.params.start, 'start');
    const body = req.body || {};
    const categoryTemplateId = Number(body.categoryTemplateId);
    if (!Number.isInteger(categoryTemplateId)) bad('categoryTemplateId is required');
    const planned = requireCents(body.plannedAmountCents ?? 0, 'plannedAmountCents');

    const { rows: tmpl } = await q(
      'SELECT id, account_id FROM category_templates WHERE id = $1 AND budget_id = $2',
      [categoryTemplateId, budget.id]
    );
    if (!tmpl.length) bad('Unknown category');
    const accountId = tmpl[0].account_id ?? await getDefaultAccountId(budget.id);
    const { rows: period } = await q(
      'SELECT id, start_date, closed_at FROM pay_periods WHERE budget_id = $1 AND account_id = $3 AND start_date = $2',
      [budget.id, start, accountId]
    );
    if (!period.length) bad('That pay period is not recorded yet — you can only add items to current or past periods');
    if (period[0].closed_at) bad('This pay period is closed — reopen it to make changes');

    const cleared = Boolean(body.cleared);
    const clearedDate = cleared ? todayISO() : null;

    const UPSERT = `INSERT INTO line_items (pay_period_id, category_template_id, planned_amount_cents, account_id, cleared, cleared_date)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (pay_period_id, category_template_id)
       DO UPDATE SET planned_amount_cents = EXCLUDED.planned_amount_cents,
         cleared = EXCLUDED.cleared, cleared_date = EXCLUDED.cleared_date`;
    const params = [period[0].id, categoryTemplateId, planned, accountId, cleared, clearedDate];

    if (body.scope === 'forward') {
      // Roll forward on the template's OWN account's cadence, not the
      // household default's (periods are per-account, migration 013).
      const cfg = await getConfig(budget.id, accountId);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(UPSERT, params);
        await setAmountGoingForward(client, budget.id, cfg, categoryTemplateId, planned, period[0].start_date);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      await q(UPSERT, params);
    }
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
