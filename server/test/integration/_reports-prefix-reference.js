// Literal copy of the GET /summary handler from server/routes/reports.js AS
// IT STOOD AT commit 7ccbf6e (`git show 7ccbf6e:server/routes/reports.js`),
// i.e. the pre-change single-shared-cfg unscoped fill-in walk — the exact
// code the "before" side of reports-fillin.test.js's full-payload parity
// test needs to call. The file's other two routes (CSV exports), untouched
// by this task and not exercised by the parity test, are omitted.
//
// This file is TEST SUPPORT ONLY, never imported by production code (nothing
// under server/routes, server/services, or server/index.js references it),
// and it is not itself under test — reports.js is. It exists so the parity
// test can diff the real pre-change handler's output against the real
// post-change handler's output, rather than a hand-rolled reference
// implementation that could itself drift from what the old code actually did.
//
// The ONLY change from the git-show'd original is the relative import
// paths, adjusted for this file's location one directory deeper
// (server/test/integration/ instead of server/routes/) — '../db.js' etc.
// become '../../db.js'. No other line differs. Do not "fix", refactor, or
// otherwise touch the route logic below; if it ever needs to change, that
// means the "before" reference is wrong, which defeats the point.
import { Router } from 'express';
import { q } from '../../db.js';
import { bad } from '../../validation.js';
import {
  getConfig, getDefaultAccountId, buildProjection, resolveAccountId, loadTemplates, plannedForPeriod,
} from '../../services/budget.js';
import { periodAfter, periodContaining, todayISO } from '../../services/schedule.js';

const router = Router();

// Yearly rollup: per category x month, planned and cleared amounts. Line
// items are attributed to the month their pay period starts in; misc
// (uncategorized) transactions to the month of their date. Unscoped by
// default (all accounts together); ?account=<id> narrows everything to one
// base-currency account (NULL attributions mean the default account).
router.get('/summary', async (req, res, next) => {
  try {
    const year = parseInt(req.query.year, 10);
    if (!year || year < 1900 || year > 3000) bad('year is required, e.g. ?year=2026');
    const scoped = req.query.account !== undefined && req.query.account !== '';
    const accountId = scoped ? await resolveAccountId(req.budget.id, req.query.account) : null;
    const defaultId = scoped ? await getDefaultAccountId(req.budget.id) : null;
    const scopeParams = scoped ? [defaultId, accountId] : [];

    const { rows: items } = await q(
      `SELECT ct.id AS category_id, ct.name, ct.type, ct.account_id, ct.sort_order,
              EXTRACT(MONTH FROM pp.start_date)::int AS month,
              COALESCE(SUM(li.planned_amount_cents), 0) AS planned,
              COALESCE(SUM(li.planned_amount_cents) FILTER (WHERE li.cleared), 0) AS cleared
       FROM line_items li
       JOIN pay_periods pp ON pp.id = li.pay_period_id
       JOIN category_templates ct ON ct.id = li.category_template_id
       WHERE pp.budget_id = $1 AND EXTRACT(YEAR FROM pp.start_date) = $2
         ${scoped ? 'AND COALESCE(li.account_id, $3) = $4' : ''}
       GROUP BY ct.id, ct.name, ct.type, ct.account_id, ct.sort_order, month
       ORDER BY ct.type, ct.sort_order, ct.id`,
      [req.budget.id, year, ...scopeParams]
    );
    // Tag categories have no line items; their spend is the transactions
    // carrying the tag, reported per category (cleared side only).
    const { rows: tagRows } = await q(
      `SELECT ct.id AS category_id, ct.name, ct.type, ct.account_id, ct.sort_order,
              EXTRACT(MONTH FROM t.date)::int AS month,
              COALESCE(SUM(t.amount_cents), 0) AS cleared
       FROM transactions t
       JOIN category_templates ct ON ct.id = t.category_template_id
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.budget_id = $1 AND ct.category_type = 'tag' AND EXTRACT(YEAR FROM t.date) = $2
         AND (a.id IS NULL OR a.currency IS NULL)
         ${scoped ? 'AND COALESCE(t.account_id, $3) = $4' : ''}
       GROUP BY ct.id, ct.name, ct.type, ct.account_id, ct.sort_order, month
       ORDER BY ct.type, ct.sort_order, ct.id`,
      [req.budget.id, year, ...scopeParams]
    );
    // Foreign-currency (tracked) accounts are a different unit; they never
    // mix into the base-currency rollup.
    const { rows: misc } = await q(
      `SELECT t.type, EXTRACT(MONTH FROM t.date)::int AS month, COALESCE(SUM(t.amount_cents), 0) AS total
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.budget_id = $1 AND t.category_template_id IS NULL AND EXTRACT(YEAR FROM t.date) = $2
         AND (a.id IS NULL OR a.currency IS NULL)
         ${scoped ? 'AND COALESCE(t.account_id, $3) = $4' : ''}
       GROUP BY t.type, month`,
      [req.budget.id, year, ...scopeParams]
    );
    const { rows: years } = await q(
      `SELECT DISTINCT EXTRACT(YEAR FROM start_date)::int AS year FROM pay_periods WHERE budget_id = $1 ORDER BY year`,
      [req.budget.id]
    );

    const categories = new Map();
    const entryFor = (id, props) => {
      if (!categories.has(id)) {
        categories.set(id, {
          id,
          ...props,
          months: Array.from({ length: 12 }, () => ({ planned: 0, cleared: 0 })),
        });
      }
      return categories.get(id);
    };
    for (const r of items) {
      const c = entryFor(r.category_id, { name: r.name, type: r.type, accountId: r.account_id, sortOrder: r.sort_order });
      c.months[r.month - 1] = { planned: Number(r.planned), cleared: Number(r.cleared) };
    }
    for (const r of tagRows) {
      const c = entryFor(r.category_id, { name: r.name, type: r.type, accountId: r.account_id, sortOrder: r.sort_order, tag: true });
      c.months[r.month - 1].cleared = Number(r.cleared);
    }

    // Recorded periods only cover part of the year; the rest of the planned
    // picture comes from the same schedule walk the projection uses. Months
    // before the first recorded period read as reconciled (cleared = planned,
    // consistent with pre-history period columns); future months are planned
    // only. Category valid-from/until dates and effective-dated amounts apply.
    // Cadence-dependent period walk below (periodContaining/periodAfter):
    // when scoped to one account it must use THAT account's config, not the
    // default's — otherwise the fill-in periods for months without a
    // recorded row would be walked on the wrong cadence (migration 013:
    // each account has its own cfg).
    const cfg = scoped ? await getConfig(req.budget.id, accountId) : await getConfig(req.budget.id);
    if (cfg) {
      // Real periods must be scoped the same way cfg is (migration 013: each
      // account has its own periods). When scoped, restrict to this
      // account's rows so overlapsReal/firstRealStart reflect only its own
      // history; unscoped (household roll-up) intentionally keeps walking
      // every account's periods together with a single cfg — cadences can
      // legitimately differ across accounts once periods are per-account,
      // so this is a known simplification for the household view, not a bug
      // to "fix" here.
      const { rows: realPeriods } = await q(
        `SELECT start_date, end_date FROM pay_periods WHERE budget_id = $1${scoped ? ' AND account_id = $2' : ''} ORDER BY start_date`,
        scoped ? [req.budget.id, accountId] : [req.budget.id]
      );
      let templates = (await loadTemplates(req.budget.id)).filter((t) => t.category_type !== 'tag');
      if (scoped) templates = templates.filter((t) => (t.account_id ?? defaultId) === accountId);
      const firstRealStart = realPeriods[0]?.start_date ?? null;
      const today = todayISO();
      const overlapsReal = (p) => realPeriods.some((r) => r.start_date <= p.end && r.end_date >= p.start);
      let p = periodContaining(cfg, `${year}-01-01`);
      let guard = 0;
      while (p.start <= `${year}-12-31` && guard++ < 400) {
        if (!overlapsReal(p) && Number(p.start.slice(0, 4)) === year) {
          const month = Number(p.start.slice(5, 7));
          const preHistory = firstRealStart ? p.start < firstRealStart : p.end < today;
          for (const t of templates) {
            const planned = plannedForPeriod(t, p);
            if (!planned) continue;
            const c = entryFor(t.id, { name: t.name, type: t.type, accountId: t.account_id, sortOrder: t.sort_order });
            c.months[month - 1].planned += planned;
            if (preHistory) c.months[month - 1].cleared += planned;
          }
        }
        p = periodAfter(cfg, p);
      }
    }
    const miscRows = { expense: Array(12).fill(0), income: Array(12).fill(0) };
    for (const r of misc) miscRows[r.type][r.month - 1] = Number(r.total);

    const sorted = [...categories.values()].sort(
      (a, b) => (a.type === b.type ? 0 : a.type === 'expense' ? -1 : 1)
        || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id
    );
    res.json({
      year, years: years.map((y) => y.year), accountId, categories: sorted, misc: miscRows,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
