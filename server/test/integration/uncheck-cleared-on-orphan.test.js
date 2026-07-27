// Integration tests for docs/plans/uncheck-cleared-on-orphan.md: extending
// recomputeLineItemActual (server/services/budget.js) to also uncheck
// `cleared`/clear `cleared_date` when the LAST backing transaction for a
// cleared line item is removed, instead of leaving cleared=TRUE with a NULL
// cleared_amount_cents (the "stale checked box" bug, and its Reports
// side-effect of counting a planned amount as cleared with nothing behind
// it).
//
// Modeled on recompute-actuals.test.js: seeds an isolated budget per test and
// deletes it afterwards (every budget-scoped table cascades from budgets).
//
// Requires a real Postgres reachable via DATABASE_URL with the schema
// already migrated. Not part of the default `npm test` unit run - use
// `npm run test:integration` (or the ephemeral-DB wrapper,
// `npm run test:integration:ephemeral`).

import './_env-guard.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, q } from '../../db.js';
import {
  createSoloBudget, ensureMaterialized, getDefaultAccountId, clearLineItemForTransaction,
  recomputeLineItemActual,
} from '../../services/budget.js';
import { todayISO, addDays } from '../../services/schedule.js';

async function seedBudget() {
  const email = `orphan-uncheck-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { rows: user } = await q(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [email]
  );
  const userId = user[0].id;
  const budget = await createSoloBudget(userId);
  const budgetId = budget.id;

  const today = todayISO();
  const startedOn = addDays(today, -30);
  const accountId = await getDefaultAccountId(budgetId);
  await q('UPDATE accounts SET started_on = $1 WHERE id = $2', [startedOn, accountId]);
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'biweekly', $3)",
    [budgetId, accountId, today]
  );

  const { rows: cat } = await q(
    `INSERT INTO category_templates (budget_id, account_id, name, type, recurrence, category_type, sort_order)
     VALUES ($1, $2, 'Electric', 'expense', 'every_period', 'recurring', 0) RETURNING id`,
    [budgetId, accountId]
  );
  const categoryId = cat[0].id;
  const PLANNED = 25000;
  await q(
    'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, $2, $3)',
    [categoryId, PLANNED, startedOn]
  );

  await ensureMaterialized(budgetId);
  const { rows: period } = await q(
    'SELECT id, start_date, end_date FROM pay_periods WHERE account_id = $1 ORDER BY start_date DESC LIMIT 1',
    [accountId]
  );
  const { rows: tRows } = await q('SELECT * FROM category_templates WHERE id = $1', [categoryId]);
  const template = tRows[0];

  return { userId, budgetId, accountId, categoryId, template, periodId: period[0].id, PLANNED };
}

async function cleanup(ctx) {
  await q('DELETE FROM budgets WHERE id = $1', [ctx.budgetId]);
  await q('DELETE FROM users WHERE id = $1', [ctx.userId]);
}

async function insertTxn(ctx, amountCents, date = todayISO(), categoryTemplateId = ctx.categoryId) {
  const { rows } = await q(
    `INSERT INTO transactions (budget_id, pay_period_id, type, amount_cents, description, date, account_id, category_template_id, categorized_by)
     VALUES ($1, $2, 'expense', $3, 'test', $4, $5, $6, 'manual') RETURNING id`,
    [ctx.budgetId, ctx.periodId, amountCents, date, ctx.accountId, categoryTemplateId]
  );
  return rows[0].id;
}

// Mirrors exactly what transactions.js's DELETE /:id handler (and accounts.js's
// DELETE /:id/transactions Tier 1 bulk delete) do: BEGIN; DELETE the
// transaction row(s); recomputeLineItemActual for every affected
// (period, template) pair; COMMIT.
async function deleteTransactionLikeRoute(txnId) {
  const { rows } = await q(
    'SELECT pay_period_id, category_template_id FROM transactions WHERE id = $1', [txnId]
  );
  const txn = rows[0];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM transactions WHERE id = $1', [txnId]);
    if (txn.category_template_id && txn.pay_period_id) {
      await recomputeLineItemActual(client, txn.pay_period_id, txn.category_template_id);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Mirrors reports.js's GET /summary scoped-account query for a single
// category/month, so the assertion proves the actual route logic self-
// corrects, not a paraphrase of it.
async function reportsClearedForMonth(budgetId, categoryId, year, month) {
  const { rows } = await q(
    `SELECT COALESCE(SUM(COALESCE(li.cleared_amount_cents, li.planned_amount_cents)) FILTER (WHERE li.cleared), 0) AS cleared
     FROM line_items li
     JOIN pay_periods pp ON pp.id = li.pay_period_id
     WHERE pp.budget_id = $1 AND li.category_template_id = $2
       AND EXTRACT(YEAR FROM pp.start_date) = $3 AND EXTRACT(MONTH FROM pp.start_date) = $4`,
    [budgetId, categoryId, year, month]
  );
  return Number(rows[0].cleared);
}

test('1. cleared item, one backing transaction, delete it -> cleared/cleared_date/cleared_amount_cents all clear', async (t) => {
  const ctx = await seedBudget();
  t.after(() => cleanup(ctx));

  const id1 = await insertTxn(ctx, 10000);
  await clearLineItemForTransaction({ query: q }, ctx.template, {
    periodId: ctx.periodId, date: todayISO(), amountCents: 10000, accountId: ctx.accountId,
  });

  const before = await q(
    'SELECT cleared, cleared_date, cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [ctx.periodId, ctx.categoryId]
  );
  assert.equal(before.rows[0].cleared, true, 'sanity: cleared before delete');
  assert.equal(before.rows[0].cleared_amount_cents, 10000, 'sanity: actual before delete');
  assert.ok(before.rows[0].cleared_date, 'sanity: cleared_date set before delete');

  await deleteTransactionLikeRoute(id1);

  const after = await q(
    'SELECT cleared, cleared_date, cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [ctx.periodId, ctx.categoryId]
  );
  assert.equal(after.rows[0].cleared, false, 'cleared must auto-uncheck');
  assert.equal(after.rows[0].cleared_date, null, 'cleared_date must clear');
  assert.equal(after.rows[0].cleared_amount_cents, null, 'cleared_amount_cents must be NULL, never 0');
});

test('2. manually-cleared item with NO transaction ever linked is untouched by a recompute call for that (period, template)', async (t) => {
  const ctx = await seedBudget();
  t.after(() => cleanup(ctx));

  // Manual tick with no linked transaction at all - cleared_amount_cents was
  // already NULL beforehand. This is the critical regression guard: the fix
  // must only fire on the (had-a-real-value -> now NULL) transition, never
  // on an already-NULL value.
  const clearedDate = todayISO();
  await q(
    'UPDATE line_items SET cleared = TRUE, cleared_date = $1 WHERE pay_period_id = $2 AND category_template_id = $3',
    [clearedDate, ctx.periodId, ctx.categoryId]
  );

  const before = await q(
    'SELECT cleared, cleared_date, cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [ctx.periodId, ctx.categoryId]
  );
  assert.equal(before.rows[0].cleared, true);
  assert.equal(before.rows[0].cleared_amount_cents, null, 'sanity: no transaction ever backed this - already NULL');

  // Any operation that calls recomputeLineItemActual for this (period,
  // template) pair - e.g. a sibling transaction's un-assignment, or a repair
  // run - must leave this manual tick alone.
  await recomputeLineItemActual({ query: q }, ctx.periodId, ctx.categoryId);

  const after = await q(
    'SELECT cleared, cleared_date, cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [ctx.periodId, ctx.categoryId]
  );
  assert.equal(after.rows[0].cleared, true, 'manual tick must survive an unrelated recompute call');
  assert.equal(after.rows[0].cleared_date?.slice(0, 10) ?? after.rows[0].cleared_date, clearedDate, 'cleared_date must be untouched');
  assert.equal(after.rows[0].cleared_amount_cents, null);
});

test('3. two backing transactions, delete one -> stays cleared, actual reflects the remaining transaction', async (t) => {
  const ctx = await seedBudget();
  t.after(() => cleanup(ctx));

  const id1 = await insertTxn(ctx, 10000);
  await clearLineItemForTransaction({ query: q }, ctx.template, {
    periodId: ctx.periodId, date: todayISO(), amountCents: 10000, accountId: ctx.accountId,
  });
  await insertTxn(ctx, 5000);
  await clearLineItemForTransaction({ query: q }, ctx.template, {
    periodId: ctx.periodId, date: todayISO(), amountCents: 5000, accountId: ctx.accountId,
  });

  const before = await q(
    'SELECT cleared, cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [ctx.periodId, ctx.categoryId]
  );
  assert.equal(before.rows[0].cleared_amount_cents, 15000, 'sanity: sum of both transactions');

  await deleteTransactionLikeRoute(id1);

  const after = await q(
    'SELECT cleared, cleared_date, cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [ctx.periodId, ctx.categoryId]
  );
  assert.equal(after.rows[0].cleared, true, 'must stay cleared - some backing remains');
  assert.ok(after.rows[0].cleared_date, 'cleared_date must survive - no false uncheck');
  assert.equal(after.rows[0].cleared_amount_cents, 5000, 'must reflect the remaining transaction only');
});

test('4. reports: deleting the transaction that cleared a category stops it counting as cleared for that month', async (t) => {
  const ctx = await seedBudget();
  t.after(() => cleanup(ctx));

  const { rows: periodRow } = await q('SELECT start_date FROM pay_periods WHERE id = $1', [ctx.periodId]);
  const startDate = new Date(`${periodRow[0].start_date}T00:00:00Z`);
  const year = startDate.getUTCFullYear();
  const month = startDate.getUTCMonth() + 1;

  // Seed the user's actual scenario: a recurring category, materialized
  // period, a transaction that clears it (as a SimpleFin import + auto-
  // categorize, or manual categorize, would).
  const id1 = await insertTxn(ctx, ctx.PLANNED);
  await clearLineItemForTransaction({ query: q }, ctx.template, {
    periodId: ctx.periodId, date: todayISO(), amountCents: ctx.PLANNED, accountId: ctx.accountId,
  });

  const clearedBefore = await reportsClearedForMonth(ctx.budgetId, ctx.categoryId, year, month);
  assert.equal(clearedBefore, ctx.PLANNED, 'reports must count this category as cleared for the month before delete');

  // Delete the transaction - mirrors both DELETE /transactions/:id and Tier 1
  // bulk delete (DELETE /accounts/:id/transactions), which share this exact
  // recompute call.
  await deleteTransactionLikeRoute(id1);

  const clearedAfter = await reportsClearedForMonth(ctx.budgetId, ctx.categoryId, year, month);
  assert.equal(clearedAfter, 0, 'reports must NOT count the planned amount as cleared once cleared has been auto-unchecked');
});

test.after(() => pool.end());
