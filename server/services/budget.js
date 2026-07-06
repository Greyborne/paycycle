// Budget engine: materialization of real periods, per-period totals, and the
// forward balance projection.
//
// All budget data belongs to a "budget" (household); users access it through
// their budget_members row. Real (past/current) periods are database rows
// with line-item snapshots; future periods are virtual - computed on demand
// from the category templates and their effective-dated amounts - so the
// projection horizon is unbounded without unbounded storage.

import { pool, q } from '../db.js';
import {
  addDays, addMonths, monthlyOccurrences, periodAfter, periodContaining, todayISO,
} from './schedule.js';

export async function getUser(userId) {
  const { rows } = await q('SELECT * FROM users WHERE id = $1', [userId]);
  return rows[0] || null;
}

export async function getBudget(budgetId) {
  const { rows } = await q('SELECT * FROM budgets WHERE id = $1', [budgetId]);
  return rows[0] || null;
}

// The budget (household) a user belongs to, with their role. Every user has
// exactly one; if it is somehow missing (e.g. removed from a household by a
// process crash), a fresh solo budget is created so the account still works.
export async function getMembership(userId) {
  const { rows } = await q(
    `SELECT b.*, m.role FROM budget_members m JOIN budgets b ON b.id = m.budget_id
     WHERE m.user_id = $1`,
    [userId]
  );
  if (rows.length) return rows[0];
  return createSoloBudget(userId);
}

export async function createSoloBudget(userId, client = null) {
  const run = (text, params) => (client ? client.query(text, params) : q(text, params));
  const user = await getUser(userId);
  const name = `${(user?.email || 'my').split('@')[0]}'s household`;
  const { rows: budget } = await run(
    'INSERT INTO budgets (name, currency) VALUES ($1, $2) RETURNING *',
    [name, process.env.DEFAULT_CURRENCY?.toUpperCase() || 'USD']
  );
  await run(
    'INSERT INTO budget_members (budget_id, user_id, role) VALUES ($1, $2, $3)',
    [budget[0].id, userId, 'owner']
  );
  await run(
    'INSERT INTO accounts (budget_id, name, is_default) VALUES ($1, $2, TRUE)',
    [budget[0].id, 'Primary account']
  );
  return { ...budget[0], role: 'owner' };
}

export async function getAccounts(budgetId) {
  const { rows } = await q(
    'SELECT * FROM accounts WHERE budget_id = $1 ORDER BY sort_order, id',
    [budgetId]
  );
  return rows;
}

// The default account (always base-currency), self-healing if a household
// somehow lacks one.
export async function getDefaultAccountId(budgetId) {
  const { rows } = await q(
    'SELECT id FROM accounts WHERE budget_id = $1 AND is_default AND NOT archived AND currency IS NULL',
    [budgetId]
  );
  if (rows.length) return rows[0].id;
  const { rows: any } = await q(
    'SELECT id FROM accounts WHERE budget_id = $1 AND currency IS NULL ORDER BY archived, sort_order, id LIMIT 1',
    [budgetId]
  );
  if (any.length) return any[0].id;
  const { rows: created } = await q(
    "INSERT INTO accounts (budget_id, name, is_default) VALUES ($1, 'Primary account', TRUE) RETURNING id",
    [budgetId]
  );
  return created[0].id;
}

// Per-account actual balances: starting balance + cleared line items + misc
// (uncategorized) transactions attributed to the account. Archived accounts
// still count toward totals - archiving only hides an account from pickers.
export async function accountBalances(budgetId) {
  const { rows } = await q(
    `SELECT a.id, a.name, a.type, a.currency, a.starting_balance_cents, a.is_default, a.archived, a.sort_order,
            a.starting_balance_cents
            + COALESCE(li.cleared_income, 0) - COALESCE(li.cleared_expenses, 0)
            + COALESCE(tx.misc_income, 0) - COALESCE(tx.misc_expenses, 0) AS balance_cents
     FROM accounts a
     LEFT JOIN (
       SELECT li.account_id,
              COALESCE(SUM(li.planned_amount_cents) FILTER (WHERE ct.type = 'income' AND li.cleared), 0)  AS cleared_income,
              COALESCE(SUM(li.planned_amount_cents) FILTER (WHERE ct.type = 'expense' AND li.cleared), 0) AS cleared_expenses
       FROM line_items li
       JOIN category_templates ct ON ct.id = li.category_template_id
       JOIN pay_periods pp ON pp.id = li.pay_period_id
       WHERE pp.budget_id = $1
       GROUP BY li.account_id
     ) li ON li.account_id = a.id
     LEFT JOIN (
       SELECT account_id,
              COALESCE(SUM(amount_cents) FILTER (WHERE type = 'income' AND category_template_id IS NULL), 0)  AS misc_income,
              COALESCE(SUM(amount_cents) FILTER (WHERE type = 'expense' AND category_template_id IS NULL), 0) AS misc_expenses
       FROM transactions WHERE budget_id = $1
       GROUP BY account_id
     ) tx ON tx.account_id = a.id
     WHERE a.budget_id = $1
     ORDER BY a.sort_order, a.id`,
    [budgetId]
  );
  return rows.map((r) => ({ ...r, balance_cents: Number(r.balance_cents) }));
}

async function totalStartingBalance(budgetId) {
  const { rows } = await q(
    'SELECT COALESCE(SUM(starting_balance_cents), 0)::int AS total FROM accounts WHERE budget_id = $1 AND currency IS NULL',
    [budgetId]
  );
  return rows[0].total;
}

export async function getConfig(budgetId) {
  const { rows } = await q('SELECT * FROM pay_period_configs WHERE budget_id = $1', [budgetId]);
  return rows[0] || null;
}

// Templates with their amount history (ascending by effective date).
export async function loadTemplates(budgetId, { includeArchived = false } = {}) {
  const { rows: templates } = await q(
    `SELECT * FROM category_templates WHERE budget_id = $1 ${includeArchived ? '' : 'AND NOT archived'}
     ORDER BY type, sort_order, id`,
    [budgetId]
  );
  if (!templates.length) return [];
  const { rows: history } = await q(
    `SELECT h.* FROM category_amount_history h
     JOIN category_templates t ON t.id = h.category_template_id
     WHERE t.budget_id = $1 ORDER BY h.effective_start_date`,
    [budgetId]
  );
  const byTemplate = new Map(templates.map((t) => [t.id, []]));
  for (const h of history) byTemplate.get(h.category_template_id)?.push(h);
  return templates.map((t) => ({ ...t, history: byTemplate.get(t.id) }));
}

// Amount in force on refDate: the latest history row effective on or before
// it. Dates before the first row fall back to the earliest amount (there is
// no "original" to preserve before the category existed).
export function effectiveAmount(history, refDate) {
  if (!history?.length) return 0;
  let amount = history[0].amount_cents;
  for (const h of history) {
    if (h.effective_start_date <= refDate) amount = h.amount_cents;
    else break;
  }
  return amount;
}

// Planned amount this template contributes to a period, or null if it does
// not apply to the period at all.
export function plannedForPeriod(template, period) {
  if (template.archived) return null;
  if (template.recurrence === 'monthly') {
    const lo = template.start_date && template.start_date > period.start ? template.start_date : period.start;
    const hi = template.end_date && template.end_date < period.end ? template.end_date : period.end;
    if (lo > hi) return null;
    const occurrences = monthlyOccurrences(template.due_day, lo, hi);
    if (!occurrences.length) return null;
    return occurrences.reduce((sum, d) => sum + effectiveAmount(template.history, d), 0);
  }
  // every_period: applies if the template's active window overlaps the period.
  if (template.start_date && template.start_date > period.end) return null;
  if (template.end_date && template.end_date < period.start) return null;
  return effectiveAmount(template.history, period.start);
}

// Insert line items for any active template that applies to the period but
// has no row yet (covers both fresh materialization and categories added
// mid-period). Existing rows are never touched - they are frozen snapshots.
// Each item is attributed to the template's account (or the default).
async function syncLineItems(client, periodRow, templates, defaultAccountId) {
  for (const t of templates) {
    const planned = plannedForPeriod(t, { start: periodRow.start_date, end: periodRow.end_date });
    if (planned === null) continue;
    await client.query(
      `INSERT INTO line_items (pay_period_id, category_template_id, planned_amount_cents, account_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT (pay_period_id, category_template_id) DO NOTHING`,
      [periodRow.id, t.id, planned, t.account_id ?? defaultAccountId]
    );
  }
}

// Create rows for every period from the last materialized one (or the period
// containing today, if none exist) up through today, and make sure the
// current period's line items reflect current active templates.
export async function ensureMaterialized(budgetId, cfg) {
  const today = todayISO();
  const templates = await loadTemplates(budgetId);
  const defaultAccountId = await getDefaultAccountId(budgetId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: last } = await client.query(
      'SELECT * FROM pay_periods WHERE budget_id = $1 ORDER BY start_date DESC LIMIT 1',
      [budgetId]
    );
    let next;
    if (!last.length) {
      next = periodContaining(cfg, today);
    } else {
      next = periodContaining(cfg, addDays(last[0].end_date, 1));
      // If the cadence config changed, the next computed period can overlap
      // the last real one; clip it so real periods never overlap.
      if (next.start <= last[0].end_date) {
        next = next.end > last[0].end_date
          ? { start: addDays(last[0].end_date, 1), end: next.end }
          : periodAfter(cfg, { start: next.start, end: last[0].end_date });
      }
    }
    while (next.start <= today) {
      const { rows } = await client.query(
        `INSERT INTO pay_periods (budget_id, start_date, end_date) VALUES ($1, $2, $3)
         ON CONFLICT (budget_id, start_date) DO UPDATE SET end_date = pay_periods.end_date
         RETURNING *`,
        [budgetId, next.start, next.end]
      );
      await syncLineItems(client, rows[0], templates, defaultAccountId);
      next = periodAfter(cfg, next);
    }
    // Current period may predate a just-added category: top up its items.
    const { rows: current } = await client.query(
      'SELECT * FROM pay_periods WHERE budget_id = $1 AND start_date <= $2 AND end_date >= $2 ORDER BY start_date DESC LIMIT 1',
      [budgetId, today]
    );
    if (current.length) await syncLineItems(client, current[0], templates, defaultAccountId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// All materialized periods with their aggregate totals, ordered by date.
async function materializedSummaries(budgetId) {
  const { rows: periods } = await q(
    `SELECT pp.id, pp.start_date, pp.end_date,
            COALESCE(SUM(li.planned_amount_cents) FILTER (WHERE ct.type = 'expense'), 0)                  AS planned_expenses,
            COALESCE(SUM(li.planned_amount_cents) FILTER (WHERE ct.type = 'expense' AND li.cleared), 0)   AS cleared_expense_items,
            COALESCE(SUM(li.planned_amount_cents) FILTER (WHERE ct.type = 'income'), 0)                   AS planned_income,
            COALESCE(SUM(li.planned_amount_cents) FILTER (WHERE ct.type = 'income' AND li.cleared), 0)    AS cleared_income_items,
            COUNT(li.id) AS item_count
     FROM pay_periods pp
     LEFT JOIN line_items li ON li.pay_period_id = pp.id
     LEFT JOIN category_templates ct ON ct.id = li.category_template_id
     WHERE pp.budget_id = $1
     GROUP BY pp.id
     ORDER BY pp.start_date`,
    [budgetId]
  );
  // Only uncategorized transactions count as "misc"; a transaction linked to
  // a category is the record of that category's line item clearing (the line
  // item's amount carries the value, so counting both would double-count).
  // Transactions on foreign-currency (tracked) accounts are in a different
  // unit entirely and never enter period budget math.
  const { rows: txn } = await q(
    `SELECT t.pay_period_id,
            COALESCE(SUM(t.amount_cents) FILTER (WHERE t.type = 'expense' AND t.category_template_id IS NULL), 0) AS misc_expenses,
            COALESCE(SUM(t.amount_cents) FILTER (WHERE t.type = 'income' AND t.category_template_id IS NULL), 0)  AS misc_income,
            COUNT(*) AS txn_count
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.budget_id = $1 AND (a.id IS NULL OR a.currency IS NULL)
     GROUP BY t.pay_period_id`,
    [budgetId]
  );
  const txnByPeriod = new Map(txn.map((t) => [t.pay_period_id, t]));
  return periods.map((p) => {
    const t = txnByPeriod.get(p.id) || { misc_expenses: 0, misc_income: 0, txn_count: 0 };
    return { ...p, misc_expenses: t.misc_expenses, misc_income: t.misc_income, txn_count: t.txn_count };
  });
}

export function healthFor(budget, cents) {
  if (cents < 0) return 'negative';
  if (cents < budget.threshold_low_cents) return 'danger';
  if (cents < budget.threshold_healthy_cents) return 'ok';
  return 'healthy';
}

function virtualTotals(templates, period) {
  let plannedExpenses = 0;
  let plannedIncome = 0;
  for (const t of templates) {
    const planned = plannedForPeriod(t, period);
    if (planned === null) continue;
    if (t.type === 'expense') plannedExpenses += planned;
    else plannedIncome += planned;
  }
  return { plannedExpenses, plannedIncome };
}

// The core of the app: walk every period from the first real one (or the
// current one) out to the horizon, chaining the estimated running balance
//
//   est(p) = (planned income + misc income)
//          - (planned expenses + misc expenses) + est(prev)
//
// and accumulating the actual balance from cleared items and transactions in
// real periods only.
export async function buildProjection(budget, cfg, { months = 24 } = {}) {
  const today = todayISO();
  const horizon = addMonths(today, months);
  const materialized = await materializedSummaries(budget.id);
  const matByStart = new Map(materialized.map((p) => [p.start_date, p]));
  const templates = await loadTemplates(budget.id);

  let period = materialized.length
    ? { start: materialized[0].start_date, end: materialized[0].end_date }
    : periodContaining(cfg, today);
  // Both balance chains seed from the household's combined account starting
  // balances; the projection is the household's total position.
  const startingBalance = await totalStartingBalance(budget.id);
  let est = startingBalance;
  let actual = startingBalance;
  let actualAsOf = null;
  const entries = [];

  while (period.start <= horizon || entries.length === 0) {
    const mat = matByStart.get(period.start);
    let entry;
    if (mat) {
      period = { start: mat.start_date, end: mat.end_date };
      const clearedExpenses = mat.cleared_expense_items + mat.misc_expenses;
      const clearedIncome = mat.cleared_income_items + mat.misc_income;
      est += (mat.planned_income + mat.misc_income) - (mat.planned_expenses + mat.misc_expenses);
      actual += clearedIncome - clearedExpenses;
      if (mat.cleared_expense_items || mat.cleared_income_items || mat.txn_count > 0) {
        actualAsOf = { start: mat.start_date, end: mat.end_date };
      }
      entry = {
        periodId: mat.id,
        materialized: true,
        plannedExpenses: mat.planned_expenses,
        clearedExpenses,
        plannedIncome: mat.planned_income,
        clearedIncome,
        miscExpenses: mat.misc_expenses,
        miscIncome: mat.misc_income,
        lossGain: (mat.planned_income + mat.misc_income) - mat.planned_expenses,
        empty: Number(mat.item_count) === 0 && Number(mat.txn_count) === 0,
      };
    } else {
      const { plannedExpenses, plannedIncome } = virtualTotals(templates, period);
      est += plannedIncome - plannedExpenses;
      entry = {
        periodId: null,
        materialized: false,
        plannedExpenses,
        clearedExpenses: 0,
        plannedIncome,
        clearedIncome: 0,
        miscExpenses: 0,
        miscIncome: 0,
        lossGain: plannedIncome - plannedExpenses,
        empty: false,
      };
    }
    entries.push({
      start: period.start,
      end: period.end,
      isCurrent: period.start <= today && period.end >= today,
      estBalance: est,
      health: healthFor(budget, est),
      ...entry,
    });

    // Advance, clipping overlap after a mid-history cadence change.
    let next = periodContaining(cfg, addDays(period.end, 1));
    if (next.start <= period.end) {
      next = next.end > period.end
        ? { start: addDays(period.end, 1), end: next.end }
        : periodAfter(cfg, { start: next.start, end: period.end });
    }
    period = next;
  }

  const future = entries.filter((e) => !e.isCurrent && e.start > today);
  const firstNegative = future.find((e) => e.estBalance < 0) || null;
  const firstBelowWarning = budget.warning_threshold_cents > 0
    ? future.find((e) => e.estBalance < budget.warning_threshold_cents) || null
    : null;

  return {
    entries,
    actualBalanceCents: actual,
    actualAsOf,
    firstNegative,
    firstBelowWarning,
    currentIndex: entries.findIndex((e) => e.isCurrent),
  };
}

// Full detail for one period, addressed by its start date. Materialized
// periods return editable line items and transactions; future periods return
// read-only projected values derived from the templates.
export async function getPeriodDetail(budget, cfg, startDate) {
  const today = todayISO();
  const { rows: matRows } = await q(
    'SELECT * FROM pay_periods WHERE budget_id = $1 AND start_date = $2',
    [budget.id, startDate]
  );
  const projection = await buildProjection(budget, cfg, { months: 60 });
  const entry = projection.entries.find((e) => e.start === startDate);

  if (matRows.length) {
    const periodRow = matRows[0];
    const { rows: items } = await q(
      `SELECT li.id, li.category_template_id, li.planned_amount_cents, li.cleared, li.cleared_date,
              li.account_id, ct.name, ct.type, ct.sort_order, ct.recurrence, ct.due_day
       FROM line_items li JOIN category_templates ct ON ct.id = li.category_template_id
       WHERE li.pay_period_id = $1 ORDER BY ct.sort_order, ct.id`,
      [periodRow.id]
    );
    const { rows: txns } = await q(
      `SELECT t.*, u.email AS entered_by, a.currency AS account_currency, a.name AS account_name
       FROM transactions t
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.pay_period_id = $1 ORDER BY t.date, t.id`,
      [periodRow.id]
    );
    return {
      period: { id: periodRow.id, start: periodRow.start_date, end: periodRow.end_date, materialized: true },
      expenses: items.filter((i) => i.type === 'expense'),
      income: items.filter((i) => i.type === 'income'),
      transactions: txns,
      summary: entry || null,
    };
  }

  // Virtual period: must be a valid schedule period.
  const computed = periodContaining(cfg, startDate);
  if (computed.start !== startDate && startDate > today) return null;
  const templates = await loadTemplates(budget.id);
  const mk = (type) => templates
    .filter((t) => t.type === type)
    .map((t) => ({ template: t, planned: plannedForPeriod(t, computed) }))
    .filter((x) => x.planned !== null)
    .map((x) => ({
      id: null,
      category_template_id: x.template.id,
      planned_amount_cents: x.planned,
      cleared: false,
      cleared_date: null,
      name: x.template.name,
      type: x.template.type,
      sort_order: x.template.sort_order,
      recurrence: x.template.recurrence,
      due_day: x.template.due_day,
    }));
  return {
    period: { id: null, start: computed.start, end: computed.end, materialized: false },
    expenses: mk('expense'),
    income: mk('income'),
    transactions: [],
    summary: entry || null,
  };
}
