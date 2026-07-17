import { Router } from 'express';
import { q } from '../db.js';
import { bad } from '../validation.js';
import {
  getConfig, getDefaultAccountId, buildProjection, resolveAccountId, loadTemplates, plannedForPeriod,
} from '../services/budget.js';
import { periodAfter, periodContaining, todayISO } from '../services/schedule.js';

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

function csvEscape(v) {
  let s = v === null || v === undefined ? '' : String(v);
  // Neutralize formula/DDE injection (CWE-1236): a field opened by
  // Excel/Sheets/LibreOffice is interpreted as a formula if it starts with
  // =, +, -, @, tab, or CR. Prefixing a single quote forces it to be read
  // as text. Skip this for well-formed plain numbers (e.g. "-12.34") so
  // legitimate negative amounts aren't turned into text cells — a bare
  // numeric string can't carry a formula/command payload regardless of a
  // leading '-'.
  const isPlainNumber = /^-?\d+(\.\d+)?$/.test(s);
  if (!isPlainNumber && /^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sendCsv(res, filename, header, rows) {
  const body = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`${body}\n`);
}

router.get('/export/transactions.csv', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT t.date, t.type, t.amount_cents, t.description, ct.name AS category,
              pp.start_date AS period_start, pp.end_date AS period_end
       FROM transactions t
       JOIN pay_periods pp ON pp.id = t.pay_period_id
       LEFT JOIN category_templates ct ON ct.id = t.category_template_id
       WHERE t.budget_id = $1 ORDER BY t.date, t.id`,
      [req.budget.id]
    );
    sendCsv(res, 'paycycle-transactions.csv',
      ['date', 'type', 'amount', 'description', 'category', 'period_start', 'period_end'],
      rows.map((r) => [r.date, r.type, (r.amount_cents / 100).toFixed(2), r.description, r.category, r.period_start, r.period_end]));
  } catch (err) {
    next(err);
  }
});

// One row per recorded (materialized) period with its totals and running
// balances — the closest thing to exporting the original spreadsheet.
// Periods are per-account (migration 013), so this is always exported one
// account at a time, each walked with its own cadence config: either the
// single account named by ?account=, or (unscoped) every non-archived
// base-currency account of the budget, each in its own scoped projection —
// otherwise interleaved period rows from different accounts would collide on
// date and their running balances would be meaningless.
router.get('/export/periods.csv', async (req, res, next) => {
  try {
    const scoped = req.query.account !== undefined && req.query.account !== '';
    let targets;
    if (scoped) {
      const accountId = await resolveAccountId(req.budget.id, req.query.account);
      const { rows } = await q('SELECT id, name FROM accounts WHERE id = $1', [accountId]);
      targets = rows;
    } else {
      const { rows } = await q(
        `SELECT id, name FROM accounts
         WHERE budget_id = $1 AND currency IS NULL AND NOT archived
         ORDER BY sort_order, id`,
        [req.budget.id]
      );
      targets = rows;
    }

    if (!targets.length) bad('Complete setup first');
    let anyConfigured = false;
    const rows = [];
    for (const account of targets) {
      const acctCfg = await getConfig(req.budget.id, account.id);
      if (!acctCfg) continue;
      anyConfigured = true;
      const projection = await buildProjection(req.budget, acctCfg, { months: 1, accountId: account.id });
      for (const e of projection.entries.filter((e) => e.materialized)) {
        rows.push([
          account.name, e.start, e.end,
          (e.plannedIncome / 100).toFixed(2), (e.clearedIncome / 100).toFixed(2),
          (e.plannedExpenses / 100).toFixed(2), (e.clearedExpenses / 100).toFixed(2),
          (e.miscIncome / 100).toFixed(2), (e.miscExpenses / 100).toFixed(2),
          (e.lossGain / 100).toFixed(2), (e.estBalance / 100).toFixed(2),
        ]);
      }
    }
    if (!anyConfigured) bad('Complete setup first');
    sendCsv(res, 'paycycle-periods.csv',
      ['account', 'period_start', 'period_end', 'planned_income', 'cleared_income', 'planned_expenses',
       'cleared_expenses', 'misc_income', 'misc_expenses', 'loss_gain', 'estimated_balance'],
      rows);
  } catch (err) {
    next(err);
  }
});

export default router;
