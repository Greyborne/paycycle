import { q } from '../db.js';
import {
  buildProjection, effectiveAmount, ensureMaterialized, getConfig, loadTemplates,
} from './budget.js';
import { addDays, daysBetween, monthlyOccurrences, periodContaining, todayISO } from './schedule.js';

const BILL_LOOKAHEAD_DAYS = 7;
const BILL_URGENT_DAYS = 2;
const PERIOD_END_NUDGE_DAYS = 3;
const STALE_DAYS = 10;

// Notifications are computed on demand from budget state - nothing is stored
// except per-user dismissals and per-user sent-email records, keyed by a
// stable id so a handled instance stays quiet while the next occurrence (a
// new key) fires again.
export async function computeNotifications(budget, cfg) {
  const today = todayISO();
  const out = [];

  // 1. Monthly bills due within the lookahead window, not yet cleared.
  const templates = await loadTemplates(budget.id);
  const monthlyExpenses = templates.filter((t) => t.type === 'expense' && t.recurrence === 'monthly');
  for (const t of monthlyExpenses) {
    const occurrences = monthlyOccurrences(t.due_day, today, addDays(today, BILL_LOOKAHEAD_DAYS));
    for (const occ of occurrences) {
      if (t.start_date && occ < t.start_date) continue;
      if (t.end_date && occ > t.end_date) continue;
      const { rows: cleared } = await q(
        `SELECT li.cleared FROM line_items li
         JOIN pay_periods pp ON pp.id = li.pay_period_id
         WHERE pp.budget_id = $1 AND li.category_template_id = $2
           AND pp.start_date <= $3 AND pp.end_date >= $3`,
        [budget.id, t.id, occ]
      );
      if (cleared.length && cleared[0].cleared) continue;
      const daysAway = daysBetween(today, occ);
      out.push({
        key: `bill:${t.id}:${occ}`,
        severity: daysAway <= BILL_URGENT_DAYS ? 'warning' : 'info',
        title: `${t.name} due ${daysAway === 0 ? 'today' : daysAway === 1 ? 'tomorrow' : `in ${daysAway} days`}`,
        amountCents: effectiveAmount(t.history, occ),
        date: occ,
        link: `/period/${periodContaining(cfg, occ).start}`,
      });
    }
  }

  // 2. Projection threshold crossings within 12 months.
  const projection = await buildProjection(budget, cfg, { months: 12 });
  if (projection.firstNegative) {
    out.push({
      key: `negative:${projection.firstNegative.start}`,
      severity: 'critical',
      title: 'Projected to go negative',
      amountCents: projection.firstNegative.estBalance,
      date: projection.firstNegative.start,
      link: `/period/${projection.firstNegative.start}`,
    });
  } else if (projection.firstBelowWarning) {
    out.push({
      key: `warning:${projection.firstBelowWarning.start}`,
      severity: 'warning',
      title: 'Projected below your warning threshold',
      amountCents: projection.firstBelowWarning.estBalance,
      date: projection.firstBelowWarning.start,
      link: `/period/${projection.firstBelowWarning.start}`,
    });
  }

  // 3. Current period ends soon with uncleared items.
  const current = projection.entries[projection.currentIndex];
  if (current?.materialized && daysBetween(today, current.end) <= PERIOD_END_NUDGE_DAYS) {
    const { rows } = await q(
      `SELECT COUNT(*)::int AS n FROM line_items li
       JOIN pay_periods pp ON pp.id = li.pay_period_id
       WHERE pp.budget_id = $1 AND pp.start_date = $2 AND NOT li.cleared AND li.planned_amount_cents <> 0`,
      [budget.id, current.start]
    );
    if (rows[0].n > 0) {
      out.push({
        key: `uncleared:${current.start}`,
        severity: 'info',
        title: `${rows[0].n} item${rows[0].n === 1 ? '' : 's'} not cleared — period ends soon`,
        amountCents: null,
        date: current.end,
        link: '/period/current',
      });
    }
  }

  // 4. Nothing recorded in a while.
  const { rows: activity } = await q(
    `SELECT GREATEST(
       (SELECT MAX(li.cleared_date) FROM line_items li JOIN pay_periods pp ON pp.id = li.pay_period_id WHERE pp.budget_id = $1),
       (SELECT MAX(t.date) FROM transactions t WHERE t.budget_id = $1)
     ) AS last`,
    [budget.id]
  );
  const last = activity[0].last;
  if (last && daysBetween(last, today) >= STALE_DAYS) {
    out.push({
      key: `stale:${last}`,
      severity: 'info',
      title: `Nothing recorded since ${last} — time to catch up?`,
      amountCents: null,
      date: last,
      link: '/period/current',
    });
  }

  return out;
}

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

export function sortNotifications(items) {
  return [...items].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.date < b.date ? -1 : 1)
  );
}

// Notifications for one budget, ready to show a specific user (dismissed
// instances removed).
export async function notificationsForUser(userId, budget) {
  const cfg = await getConfig(budget.id);
  if (!cfg || !budget.onboarding_complete) return [];
  await ensureMaterialized(budget.id, cfg);
  const all = await computeNotifications(budget, cfg);
  if (!all.length) return [];
  const { rows: dismissed } = await q(
    'SELECT key FROM notification_dismissals WHERE user_id = $1 AND key = ANY($2)',
    [userId, all.map((n) => n.key)]
  );
  const hidden = new Set(dismissed.map((d) => d.key));
  return sortNotifications(all.filter((n) => !hidden.has(n.key)));
}
