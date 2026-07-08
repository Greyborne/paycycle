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
  addDays, addMonths, monthlyOccurrences, periodAfter, periodBefore, periodContaining, todayISO,
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
            a.institution, a.number_mask, a.source, a.started_on::text AS started_on,
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
       SELECT t.account_id,
              COALESCE(SUM(t.amount_cents) FILTER (WHERE t.type = 'income' AND (t.category_template_id IS NULL OR tct.category_type = 'tag')), 0)  AS misc_income,
              COALESCE(SUM(t.amount_cents) FILTER (WHERE t.type = 'expense' AND (t.category_template_id IS NULL OR tct.category_type = 'tag')), 0) AS misc_expenses
       FROM transactions t
       LEFT JOIN category_templates tct ON tct.id = t.category_template_id
       WHERE t.budget_id = $1
       GROUP BY t.account_id
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

async function accountStartingBalance(budgetId, accountId) {
  const { rows } = await q(
    'SELECT starting_balance_cents FROM accounts WHERE budget_id = $1 AND id = $2',
    [budgetId, accountId]
  );
  return rows[0]?.starting_balance_cents ?? 0;
}

// Resolve a client-supplied account id to a base-currency account of this
// budget, falling back to the default account (the projection and period
// views are always scoped to exactly one account).
export async function resolveAccountId(budgetId, raw) {
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0) {
    const { rows } = await q(
      'SELECT id FROM accounts WHERE id = $1 AND budget_id = $2 AND currency IS NULL',
      [id, budgetId]
    );
    if (rows.length) return rows[0].id;
  }
  return getDefaultAccountId(budgetId);
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

// "Electric cleared at $260 but you plan $250": flag when a transaction's
// actual amount drifts from the recurring plan by more than
// max(configurable cents, 5% of planned).
export function driftFor(budget, template, amountCents, date) {
  if (!template || template.category_type !== 'recurring') return null;
  const planned = effectiveAmount(template.history, date);
  if (!planned) return null;
  const actual = Math.abs(amountCents);
  const threshold = Math.max(budget.drift_threshold_cents ?? 500, Math.round(planned * 0.05));
  if (Math.abs(actual - planned) <= threshold) return null;
  return { categoryTemplateId: template.id, name: template.name, plannedCents: planned, actualCents: actual, date };
}

// Clear the line item for a recurring category when a matching transaction
// posts. Bills sometimes post in the period after the one they were planned
// in (due 7/2, period ends 7/3, actually posts 7/5): when the transaction's
// period has no line item for the category, the planned occurrence moves
// forward — the original period keeps a $0 cleared marker and the
// transaction's period gains the item. The category's due date is never
// touched. `dbc` lets callers run inside their own transaction.
export async function clearLineItemForTransaction(dbc, template, { periodId, date, amountCents, accountId, updatePlanned = false }) {
  const amount = Math.abs(amountCents);
  const setPlanned = updatePlanned ? ', planned_amount_cents = $5' : '';
  const params = updatePlanned
    ? [date, periodId, template.id, accountId, amount]
    : [date, periodId, template.id, accountId];
  const { rowCount } = await dbc.query(
    `UPDATE line_items SET cleared = TRUE, cleared_date = $1, account_id = COALESCE($4, account_id)${setPlanned}
     WHERE pay_period_id = $2 AND category_template_id = $3`,
    params
  );
  if (rowCount) return { cleared: true, moved: false };

  // No line item in this period: move the nearest earlier still-pending
  // occurrence forward (closed periods are frozen and never touched).
  const { rows: prior } = await dbc.query(
    `SELECT li.id, li.planned_amount_cents
     FROM line_items li
     JOIN pay_periods pp ON pp.id = li.pay_period_id
     JOIN pay_periods cur ON cur.id = $1
     WHERE pp.budget_id = cur.budget_id AND pp.start_date < cur.start_date AND pp.closed_at IS NULL
       AND li.category_template_id = $2 AND NOT li.cleared AND li.planned_amount_cents <> 0
     ORDER BY pp.start_date DESC LIMIT 1`,
    [periodId, template.id]
  );
  let planned = amount; // unplanned extra occurrence: the actual is all we know
  if (prior.length) {
    planned = updatePlanned ? amount : prior[0].planned_amount_cents;
    await dbc.query(
      'UPDATE line_items SET planned_amount_cents = 0, cleared = TRUE, cleared_date = $1 WHERE id = $2',
      [date, prior[0].id]
    );
  }
  await dbc.query(
    `INSERT INTO line_items (pay_period_id, category_template_id, planned_amount_cents, account_id, cleared, cleared_date)
     VALUES ($1, $2, $3, $4, TRUE, $5)
     ON CONFLICT (pay_period_id, category_template_id)
     DO UPDATE SET cleared = TRUE, cleared_date = $5`,
    [periodId, template.id, planned, accountId ?? template.account_id ?? null, date]
  );
  return { cleared: true, moved: prior.length > 0 };
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

// Record a recurring category's amount effective from a date and roll it
// forward: every non-closed materialized period on or after that date has its
// line item recomputed from the updated history (closed periods stay frozen;
// future virtual periods already recompute live). Runs inside the caller's
// transaction (dbc) so imports can batch it. Returns how many periods changed.
export async function setAmountGoingForward(dbc, budgetId, cfg, categoryTemplateId, amountCents, effectiveDate) {
  const effStart = periodContaining(cfg, effectiveDate).start;
  await dbc.query(
    `INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date)
     VALUES ($1, $2, $3)
     ON CONFLICT (category_template_id, effective_start_date) DO UPDATE SET amount_cents = EXCLUDED.amount_cents`,
    [categoryTemplateId, amountCents, effStart]
  );
  // Reload the template with fresh in-transaction history so recomputed
  // amounts reflect the change just made.
  const { rows: tRows } = await dbc.query('SELECT * FROM category_templates WHERE id = $1', [categoryTemplateId]);
  if (!tRows.length) return 0;
  const { rows: hist } = await dbc.query(
    'SELECT * FROM category_amount_history WHERE category_template_id = $1 ORDER BY effective_start_date',
    [categoryTemplateId]
  );
  const template = { ...tRows[0], history: hist };
  const defaultAccountId = await getDefaultAccountId(budgetId);
  const { rows: periods } = await dbc.query(
    `SELECT id, start_date, end_date FROM pay_periods
     WHERE budget_id = $1 AND start_date >= $2 AND closed_at IS NULL ORDER BY start_date`,
    [budgetId, effStart]
  );
  let touched = 0;
  for (const p of periods) {
    const planned = plannedForPeriod(template, { start: p.start_date, end: p.end_date });
    if (planned === null) continue;
    await dbc.query(
      `INSERT INTO line_items (pay_period_id, category_template_id, planned_amount_cents, account_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (pay_period_id, category_template_id)
       DO UPDATE SET planned_amount_cents = EXCLUDED.planned_amount_cents`,
      [p.id, categoryTemplateId, planned, template.account_id ?? defaultAccountId]
    );
    touched += 1;
  }
  return touched;
}

// Insert line items for any active template that applies to the period but
// has no row yet (covers both fresh materialization and categories added
// mid-period). Existing rows are never touched - they are frozen snapshots.
// Each item is attributed to the template's account (or the default).
async function syncLineItems(client, periodRow, templates, defaultAccountId) {
  for (const t of templates) {
    if (t.category_type === 'tag') continue; // tags never generate line items
    const planned = plannedForPeriod(t, { start: periodRow.start_date, end: periodRow.end_date });
    if (planned === null) continue;
    await client.query(
      `INSERT INTO line_items (pay_period_id, category_template_id, planned_amount_cents, account_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT (pay_period_id, category_template_id) DO NOTHING`,
      [periodRow.id, t.id, planned, t.account_id ?? defaultAccountId]
    );
  }
}

// Whether a template's valid-date window overlaps a period at all. Used to
// decide which categories appear (as $0 rows) in a given period column.
export function templateInPeriod(template, period) {
  if (template.start_date && template.start_date > period.end) return false;
  if (template.end_date && template.end_date < period.start) return false;
  return true;
}

// Create rows for every period from the last materialized one — or, on first
// run, the period containing the earliest account start date (or today) — up
// through today, and make sure the current period's line items reflect
// current active templates.
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
      // A fresh budget begins tracking at the earliest account start date
      // (letting a user backdate to a chosen payday), else today.
      const { rows: startRows } = await client.query(
        "SELECT MIN(started_on)::text AS s FROM accounts WHERE budget_id = $1 AND started_on IS NOT NULL",
        [budgetId]
      );
      const anchor = startRows[0].s && startRows[0].s < today ? startRows[0].s : today;
      next = periodContaining(cfg, anchor);
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
    // Never touch a closed period — its contents are frozen.
    const { rows: current } = await client.query(
      'SELECT * FROM pay_periods WHERE budget_id = $1 AND start_date <= $2 AND end_date >= $2 ORDER BY start_date DESC LIMIT 1',
      [budgetId, today]
    );
    if (current.length && !current[0].closed_at) await syncLineItems(client, current[0], templates, defaultAccountId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// All materialized periods with their aggregate totals, ordered by date.
// With an account scope, only line items and transactions attributed to that
// account count (a NULL attribution means the default account).
async function materializedSummaries(budgetId, scope = null) {
  const acctFilter = scope ? 'AND COALESCE(li.account_id, $2) = $3' : '';
  const acctParams = scope ? [scope.defaultId, scope.accountId] : [];
  const { rows: periods } = await q(
    `SELECT pp.id, pp.start_date, pp.end_date,
            COALESCE(SUM(li.planned_amount_cents) FILTER (WHERE ct.type = 'expense'), 0)                  AS planned_expenses,
            COALESCE(SUM(li.planned_amount_cents) FILTER (WHERE ct.type = 'expense' AND li.cleared), 0)   AS cleared_expense_items,
            COALESCE(SUM(li.planned_amount_cents) FILTER (WHERE ct.type = 'income'), 0)                   AS planned_income,
            COALESCE(SUM(li.planned_amount_cents) FILTER (WHERE ct.type = 'income' AND li.cleared), 0)    AS cleared_income_items,
            COUNT(li.id) AS item_count
     FROM pay_periods pp
     LEFT JOIN line_items li ON li.pay_period_id = pp.id ${acctFilter}
     LEFT JOIN category_templates ct ON ct.id = li.category_template_id
     WHERE pp.budget_id = $1
     GROUP BY pp.id
     ORDER BY pp.start_date`,
    [budgetId, ...acctParams]
  );
  // Only uncategorized transactions count as "misc"; a transaction linked to
  // a category is the record of that category's line item clearing (the line
  // item's amount carries the value, so counting both would double-count).
  // Transactions on foreign-currency (tracked) accounts are in a different
  // unit entirely and never enter period budget math.
  const txnFilter = scope ? 'AND COALESCE(t.account_id, $2) = $3' : '';
  // "Misc" = uncategorized OR tagged: a tag category is just a label on a
  // one-off transaction, so it counts exactly like misc in the balance math
  // (only recurring categories represent line items clearing).
  const { rows: txn } = await q(
    `SELECT t.pay_period_id,
            COALESCE(SUM(t.amount_cents) FILTER (WHERE t.type = 'expense' AND (t.category_template_id IS NULL OR tct.category_type = 'tag')), 0) AS misc_expenses,
            COALESCE(SUM(t.amount_cents) FILTER (WHERE t.type = 'income' AND (t.category_template_id IS NULL OR tct.category_type = 'tag')), 0)  AS misc_income,
            COUNT(*) AS txn_count
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN category_templates tct ON tct.id = t.category_template_id
     WHERE t.budget_id = $1 AND (a.id IS NULL OR a.currency IS NULL) ${txnFilter}
     GROUP BY t.pay_period_id`,
    [budgetId, ...acctParams]
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
export async function buildProjection(budget, cfg, { months = 24, accountId = null } = {}) {
  const today = todayISO();
  const horizon = addMonths(today, months);
  const scope = accountId
    ? { accountId, defaultId: await getDefaultAccountId(budget.id) }
    : null;
  const materialized = await materializedSummaries(budget.id, scope);
  const matByStart = new Map(materialized.map((p) => [p.start_date, p]));
  let templates = (await loadTemplates(budget.id)).filter((t) => t.category_type !== 'tag');
  if (scope) templates = templates.filter((t) => (t.account_id ?? scope.defaultId) === scope.accountId);

  let period = materialized.length
    ? { start: materialized[0].start_date, end: materialized[0].end_date }
    : periodContaining(cfg, today);
  // Both balance chains seed from the scoped account's starting balance, or
  // the household's combined starting balances when unscoped (net position).
  const startingBalance = scope
    ? await accountStartingBalance(budget.id, scope.accountId)
    : await totalStartingBalance(budget.id);
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
        // Running actual through this period's end: the reconciliation
        // number to match against the bank balance before the next paycheck.
        clearedBalance: actual,
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
        clearedBalance: null,
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

// Period lifecycle: closing is manual and strictly sequential, so the
// "current" period is the earliest not-yet-closed materialized one — before
// any close has ever happened that is simply the earliest recorded period,
// and once every recorded period is closed it is the schedule period after
// the latest closed one (which may lie in the future).
export async function getLifecycle(budgetId, cfg) {
  const { rows: closed } = await q(
    `SELECT start_date, end_date FROM pay_periods
     WHERE budget_id = $1 AND closed_at IS NOT NULL ORDER BY start_date DESC LIMIT 1`,
    [budgetId]
  );
  const latestClosedStart = closed[0]?.start_date ?? null;
  const { rows: open } = await q(
    `SELECT start_date FROM pay_periods
     WHERE budget_id = $1 AND closed_at IS NULL ${closed.length ? 'AND start_date > $2' : ''}
     ORDER BY start_date LIMIT 1`,
    closed.length ? [budgetId, closed[0].start_date] : [budgetId]
  );
  if (open.length) return { currentStart: open[0].start_date, latestClosedStart };
  const cur = closed.length
    ? periodContaining(cfg, addDays(closed[0].end_date, 1))
    : periodContaining(cfg, todayISO());
  return { currentStart: cur.start, latestClosedStart };
}

// Make sure the schedule period following `period` exists as a real row with
// line items (used when closing hands "current" to a period that may still
// lie in the future, and as the carry target for uncleared items).
export async function materializePeriodAfter(budgetId, cfg, period) {
  let next = periodContaining(cfg, addDays(period.end, 1));
  if (next.start <= period.end) {
    next = next.end > period.end
      ? { start: addDays(period.end, 1), end: next.end }
      : periodAfter(cfg, { start: next.start, end: period.end });
  }
  const templates = await loadTemplates(budgetId);
  const defaultAccountId = await getDefaultAccountId(budgetId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO pay_periods (budget_id, start_date, end_date) VALUES ($1, $2, $3)
       ON CONFLICT (budget_id, start_date) DO UPDATE SET end_date = pay_periods.end_date
       RETURNING *`,
      [budgetId, next.start, next.end]
    );
    await syncLineItems(client, rows[0], templates, defaultAccountId);
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Cleared balances for one period as of now — the numbers frozen into the
// close-out snapshot: household total plus each base-currency account.
export async function clearedBalancesForPeriod(budget, cfg, startDate) {
  const total = await buildProjection(budget, cfg, { months: 12 });
  const snapshot = {
    total: total.entries.find((e) => e.start === startDate)?.clearedBalance ?? null,
    accounts: {},
  };
  const accounts = (await getAccounts(budget.id)).filter((a) => !a.currency);
  for (const account of accounts) {
    const scoped = await buildProjection(budget, cfg, { months: 12, accountId: account.id });
    snapshot.accounts[account.id] = scoped.entries.find((e) => e.start === startDate)?.clearedBalance ?? null;
  }
  return snapshot;
}

// Closed periods created outside the normal close flow (migration 008 closes
// legacy periods in bulk) lack a frozen snapshot; compute and store one at
// boot so their Cleared balance card is real and never recalculates.
export async function backfillClosedSnapshots() {
  const { rows: budgets } = await q(
    `SELECT DISTINCT b.* FROM budgets b
     JOIN pay_periods pp ON pp.budget_id = b.id
     WHERE pp.closed_at IS NOT NULL AND pp.closed_snapshot IS NULL`
  );
  let count = 0;
  for (const budget of budgets) {
    const cfg = await getConfig(budget.id);
    if (!cfg) continue;
    const { rows: periods } = await q(
      `SELECT start_date FROM pay_periods
       WHERE budget_id = $1 AND closed_at IS NOT NULL AND closed_snapshot IS NULL
       ORDER BY start_date`,
      [budget.id]
    );
    for (const p of periods) {
      const snapshot = await clearedBalancesForPeriod(budget, cfg, p.start_date);
      await q(
        'UPDATE pay_periods SET closed_snapshot = $1 WHERE budget_id = $2 AND start_date = $3',
        [JSON.stringify(snapshot), budget.id, p.start_date]
      );
      count++;
    }
  }
  return count;
}

// Full detail for one period, addressed by its start date. Materialized
// periods return editable line items and transactions; future periods return
// read-only projected values derived from the templates.
export async function getPeriodDetail(budget, cfg, startDate, accountId = null) {
  const today = todayISO();
  const { rows: matRows } = await q(
    'SELECT * FROM pay_periods WHERE budget_id = $1 AND start_date = $2',
    [budget.id, startDate]
  );
  const scope = accountId
    ? { accountId, defaultId: await getDefaultAccountId(budget.id) }
    : null;
  const projection = await buildProjection(budget, cfg, { months: 60, accountId });
  let entry = projection.entries.find((e) => e.start === startDate) || null;

  // Periods before the first recorded one have no projection entry, but the
  // estimate is still well-defined: walk the schedule backward from the first
  // entry, un-applying each period's planned loss/gain. They read as closed
  // and reconciled by construction — cleared balance equals the estimate.
  let preHistory = false;
  if (!entry && projection.entries.length && startDate < projection.entries[0].start) {
    let templates = (await loadTemplates(budget.id)).filter((t) => t.category_type !== 'tag');
    if (scope) templates = templates.filter((t) => (t.account_id ?? scope.defaultId) === scope.accountId);
    const first = projection.entries[0];
    // Balance entering the first entry. lossGain deliberately excludes misc
    // expenses (spreadsheet parity), so un-applying the period adds them back.
    let est = first.estBalance - first.lossGain + first.miscExpenses;
    let p = periodBefore(cfg, { start: first.start, end: first.end });
    for (let guard = 0; guard < 400 && p.start > startDate; guard++) {
      const totals = virtualTotals(templates, p);
      est -= totals.plannedIncome - totals.plannedExpenses;
      p = periodBefore(cfg, p);
    }
    if (p.start === startDate) {
      preHistory = true;
      const { plannedExpenses, plannedIncome } = virtualTotals(templates, p);
      entry = {
        periodId: null,
        materialized: false,
        start: p.start,
        end: p.end,
        isCurrent: false,
        plannedExpenses,
        clearedExpenses: plannedExpenses,
        plannedIncome,
        clearedIncome: plannedIncome,
        miscExpenses: 0,
        miscIncome: 0,
        lossGain: plannedIncome - plannedExpenses,
        empty: false,
        estBalance: est,
        health: healthFor(budget, est),
        clearedBalance: est,
      };
    }
  }

  const lifecycle = await getLifecycle(budget.id, cfg);
  const statusOf = (row) => {
    if (row?.closed_at) return 'closed';
    if (startDate === lifecycle.currentStart) return 'current';
    // Recorded periods up through today that still await close-out stay
    // "open" (editable) so a close-out backlog never locks recent activity;
    // anything later (including rows left behind by a reopen) reads
    // projected.
    return row && row.start_date <= today ? 'open' : 'projected';
  };

  if (matRows.length) {
    const periodRow = matRows[0];
    const status = statusOf(periodRow);
    const itemFilter = scope ? 'AND COALESCE(li.account_id, $2) = $3' : '';
    const scopeParams = scope ? [scope.defaultId, scope.accountId] : [];
    const { rows: items } = await q(
      `SELECT li.id, li.category_template_id, li.planned_amount_cents, li.cleared, li.cleared_date,
              li.account_id, ct.name, ct.type, ct.sort_order, ct.recurrence, ct.due_day
       FROM line_items li JOIN category_templates ct ON ct.id = li.category_template_id
       WHERE li.pay_period_id = $1 ${itemFilter} ORDER BY ct.sort_order, ct.id`,
      [periodRow.id, ...scopeParams]
    );
    // Every active category valid in this period shows, even at $0 (read-only
    // placeholder rows; there is no line item to edit). Categories whose
    // valid-date window doesn't reach this period — e.g. periods before the
    // account's start date — are omitted.
    const periodWindow = { start: periodRow.start_date, end: periodRow.end_date };
    let activeTemplates = (await loadTemplates(budget.id))
      .filter((t) => t.category_type !== 'tag' && templateInPeriod(t, periodWindow));
    if (scope) activeTemplates = activeTemplates.filter((t) => (t.account_id ?? scope.defaultId) === scope.accountId);
    const have = new Set(items.map((i) => i.category_template_id));
    for (const t of activeTemplates) {
      if (have.has(t.id)) continue;
      items.push({
        id: null,
        category_template_id: t.id,
        planned_amount_cents: 0,
        cleared: false,
        cleared_date: null,
        account_id: t.account_id,
        name: t.name,
        type: t.type,
        sort_order: t.sort_order,
        recurrence: t.recurrence,
        due_day: t.due_day,
      });
    }
    items.sort((a, b) => a.sort_order - b.sort_order || a.category_template_id - b.category_template_id);
    const txnFilter = scope ? 'AND COALESCE(t.account_id, $2) = $3' : '';
    const { rows: txns } = await q(
      `SELECT t.*, u.email AS entered_by, a.currency AS account_currency, a.name AS account_name,
              ct.name AS category_name, ct.category_type
       FROM transactions t
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN accounts a ON a.id = t.account_id
       LEFT JOIN category_templates ct ON ct.id = t.category_template_id
       WHERE t.pay_period_id = $1 ${txnFilter} ORDER BY t.date, t.id`,
      [periodRow.id, ...scopeParams]
    );
    // A closed period's cleared balance is the snapshot frozen at close-out,
    // never recalculated.
    let summary = entry || null;
    if (summary && periodRow.closed_at && periodRow.closed_snapshot) {
      const snap = periodRow.closed_snapshot;
      const frozen = scope ? snap.accounts?.[scope.accountId] : snap.total;
      summary = { ...summary, clearedBalance: frozen ?? summary.clearedBalance };
    }
    return {
      period: {
        id: periodRow.id,
        start: periodRow.start_date,
        end: periodRow.end_date,
        materialized: true,
        status,
        editable: status === 'current' || status === 'open',
        canClose: status === 'current',
        canReopen: status === 'closed' && periodRow.start_date === lifecycle.latestClosedStart,
        closedAt: periodRow.closed_at,
      },
      expenses: items.filter((i) => i.type === 'expense'),
      income: items.filter((i) => i.type === 'income'),
      transactions: txns,
      summary,
    };
  }

  // Virtual period: must be a valid schedule period.
  const computed = periodContaining(cfg, startDate);
  if (computed.start !== startDate && startDate > today) return null;
  let templates = (await loadTemplates(budget.id))
    .filter((t) => t.category_type !== 'tag' && templateInPeriod(t, computed));
  if (scope) templates = templates.filter((t) => (t.account_id ?? scope.defaultId) === scope.accountId);
  // Every active category valid here shows even when it contributes nothing
  // ($0). Pre-history periods read closed-and-reconciled, so their nonzero
  // rows show as cleared.
  const mk = (type) => templates
    .filter((t) => t.type === type)
    .map((t) => {
      const planned = plannedForPeriod(t, computed) ?? 0;
      return {
        id: null,
        category_template_id: t.id,
        planned_amount_cents: planned,
        cleared: preHistory && planned !== 0,
        cleared_date: null,
        name: t.name,
        type: t.type,
        sort_order: t.sort_order,
        recurrence: t.recurrence,
        due_day: t.due_day,
      };
    });
  const status = preHistory ? 'closed' : statusOf(null);
  return {
    period: {
      id: null,
      start: computed.start,
      end: computed.end,
      materialized: false,
      status,
      editable: false,
      canClose: false,
      canReopen: false,
      closedAt: null,
    },
    expenses: mk('expense'),
    income: mk('income'),
    transactions: [],
    summary: entry || null,
  };
}
