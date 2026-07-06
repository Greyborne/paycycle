import { Router } from 'express';
import { q } from '../db.js';
import { bad } from '../validation.js';
import { getConfig, buildProjection } from '../services/budget.js';

const router = Router();

// Yearly rollup: per category x month, planned and cleared amounts. Line
// items are attributed to the month their pay period starts in; misc
// (uncategorized) transactions to the month of their date.
router.get('/summary', async (req, res, next) => {
  try {
    const year = parseInt(req.query.year, 10);
    if (!year || year < 1900 || year > 3000) bad('year is required, e.g. ?year=2026');

    const { rows: items } = await q(
      `SELECT ct.id AS category_id, ct.name, ct.type,
              EXTRACT(MONTH FROM pp.start_date)::int AS month,
              COALESCE(SUM(li.planned_amount_cents), 0) AS planned,
              COALESCE(SUM(li.planned_amount_cents) FILTER (WHERE li.cleared), 0) AS cleared
       FROM line_items li
       JOIN pay_periods pp ON pp.id = li.pay_period_id
       JOIN category_templates ct ON ct.id = li.category_template_id
       WHERE pp.budget_id = $1 AND EXTRACT(YEAR FROM pp.start_date) = $2
       GROUP BY ct.id, ct.name, ct.type, month
       ORDER BY ct.type, ct.sort_order, ct.id`,
      [req.budget.id, year]
    );
    const { rows: misc } = await q(
      `SELECT type, EXTRACT(MONTH FROM date)::int AS month, COALESCE(SUM(amount_cents), 0) AS total
       FROM transactions
       WHERE budget_id = $1 AND category_template_id IS NULL AND EXTRACT(YEAR FROM date) = $2
       GROUP BY type, month`,
      [req.budget.id, year]
    );
    const { rows: years } = await q(
      `SELECT DISTINCT EXTRACT(YEAR FROM start_date)::int AS year FROM pay_periods WHERE budget_id = $1 ORDER BY year`,
      [req.budget.id]
    );

    const categories = new Map();
    for (const r of items) {
      if (!categories.has(r.category_id)) {
        categories.set(r.category_id, {
          id: r.category_id, name: r.name, type: r.type,
          months: Array.from({ length: 12 }, () => ({ planned: 0, cleared: 0 })),
        });
      }
      const c = categories.get(r.category_id);
      c.months[r.month - 1] = { planned: Number(r.planned), cleared: Number(r.cleared) };
    }
    const miscRows = { expense: Array(12).fill(0), income: Array(12).fill(0) };
    for (const r of misc) miscRows[r.type][r.month - 1] = Number(r.total);

    res.json({ year, years: years.map((y) => y.year), categories: [...categories.values()], misc: miscRows });
  } catch (err) {
    next(err);
  }
});

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
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
router.get('/export/periods.csv', async (req, res, next) => {
  try {
    const cfg = await getConfig(req.budget.id);
    if (!cfg) bad('Complete setup first');
    const projection = await buildProjection(req.budget, cfg, { months: 1 });
    const rows = projection.entries.filter((e) => e.materialized).map((e) => [
      e.start, e.end,
      (e.plannedIncome / 100).toFixed(2), (e.clearedIncome / 100).toFixed(2),
      (e.plannedExpenses / 100).toFixed(2), (e.clearedExpenses / 100).toFixed(2),
      (e.miscIncome / 100).toFixed(2), (e.miscExpenses / 100).toFixed(2),
      (e.lossGain / 100).toFixed(2), (e.estBalance / 100).toFixed(2),
    ]);
    sendCsv(res, 'paycycle-periods.csv',
      ['period_start', 'period_end', 'planned_income', 'cleared_income', 'planned_expenses',
       'cleared_expenses', 'misc_income', 'misc_expenses', 'loss_gain', 'estimated_balance'],
      rows);
  } catch (err) {
    next(err);
  }
});

export default router;
