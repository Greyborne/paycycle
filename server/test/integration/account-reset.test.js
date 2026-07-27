// Integration tests for Tier 2 of docs/plans/data-reset.md: POST
// /accounts/:id/reset (server/routes/accounts.js). Verifies:
//   (a) a normal reset (startedOn after the last closed period) wipes only
//       the account's open transactions/pay_periods/line_items, re-dates
//       started_on, and leaves categories/rules and the closed period
//       byte-for-byte untouched;
//   (b) the block case: startedOn at/before the earliest closed period's
//       start_date is rejected with a 4xx naming that date, and nothing is
//       deleted;
//   (c) closedPeriods: 'confirm' bypasses the block but still never touches
//       the closed period itself;
//   (d) a second, unrelated account in the same budget is unaffected.
//
// Exercises the real route handler by mounting accounts.js's router on a
// minimal express app with a stub auth middleware, mirroring
// post-transactions-recurring.test.js's pattern.
//
// Requires a real Postgres reachable via DATABASE_URL with the schema
// already migrated. Not part of the default `npm test` unit run — use
// `npm run test:integration` (or the ephemeral-DB wrapper,
// `npm run test:integration:ephemeral`).
//
// Seeds its own isolated budget and deletes it afterwards (every
// budget-scoped table cascades from budgets), so runs never collide and
// leave no residue.

import './_env-guard.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { pool, q } from '../../db.js';
import { HttpError } from '../../validation.js';
import { createSoloBudget, ensureMaterialized, getDefaultAccountId } from '../../services/budget.js';
import { addDays, todayISO } from '../../services/schedule.js';
import accountRoutes from '../../routes/accounts.js';

async function startTestServer(budget, userId) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.budget = budget;
    req.userId = userId;
    next();
  });
  app.use('/accounts', accountRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err.message || 'Internal server error' });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function reset(server, accountId, body) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/accounts/${accountId}/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

async function seed() {
  const email = `account-reset-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { rows: user } = await q(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [email]
  );
  const userId = user[0].id;
  const budget = await createSoloBudget(userId);
  const budgetId = budget.id;

  const today = todayISO();
  const startedOn = addDays(today, -60);
  const accountId = await getDefaultAccountId(budgetId);
  await q('UPDATE accounts SET started_on = $1 WHERE id = $2', [startedOn, accountId]);
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'weekly', $3)",
    [budgetId, accountId, startedOn]
  );

  // A second, unrelated account in the same budget - must survive untouched
  // by any reset run on the first account.
  const { rows: acctB } = await q(
    "INSERT INTO accounts (budget_id, name, started_on) VALUES ($1, 'Second account', $2) RETURNING id",
    [budgetId, startedOn]
  );
  const accountB = acctB[0].id;
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'weekly', $3)",
    [budgetId, accountB, startedOn]
  );

  const { rows: cat } = await q(
    `INSERT INTO category_templates (budget_id, account_id, name, type, recurrence, category_type, sort_order)
     VALUES ($1, $2, 'Electric', 'expense', 'every_period', 'recurring', 0) RETURNING id`,
    [budgetId, accountId]
  );
  const categoryId = cat[0].id;
  await q(
    'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, $2, $3)',
    [categoryId, 5000, startedOn]
  );
  const { rows: rule } = await q(
    `INSERT INTO category_rules (budget_id, category_template_id, sort_order, description_contains)
     VALUES ($1, $2, 0, 'ELECTRIC') RETURNING id`,
    [budgetId, categoryId]
  );
  const ruleId = rule[0].id;

  await ensureMaterialized(budgetId);

  // Materialize a couple of open periods and a closed one, with
  // transactions/line_items in each, so we can prove the close boundary is
  // respected.
  const { rows: periods } = await q(
    'SELECT id, start_date, end_date FROM pay_periods WHERE account_id = $1 ORDER BY start_date ASC',
    [accountId]
  );
  assert.ok(periods.length >= 1, 'expected at least one materialized period');

  const closedPeriod = periods[0];
  const closedSnapshot = { total: 12345 };
  await q(
    'UPDATE pay_periods SET closed_at = now(), closed_snapshot = $1 WHERE id = $2',
    [JSON.stringify(closedSnapshot), closedPeriod.id]
  );
  await q(
    `INSERT INTO transactions (budget_id, pay_period_id, type, amount_cents, description, date, account_id, category_template_id, categorized_by)
     VALUES ($1, $2, 'expense', 5000, 'closed txn', $3, $4, $5, 'manual')`,
    [budgetId, closedPeriod.id, closedPeriod.start_date, accountId, categoryId]
  );
  const { rows: closedLineItem } = await q(
    'SELECT id, cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [closedPeriod.id, categoryId]
  );

  const openPeriod = periods[periods.length - 1];
  await q(
    `INSERT INTO transactions (budget_id, pay_period_id, type, amount_cents, description, date, account_id, category_template_id, categorized_by)
     VALUES ($1, $2, 'expense', 5000, 'open txn', $3, $4, $5, 'manual')`,
    [budgetId, openPeriod.id, openPeriod.start_date, accountId, categoryId]
  );

  return {
    userId, budgetId, budget, accountId, accountB, categoryId, ruleId,
    closedPeriod, closedLineItemId: closedLineItem[0].id,
    openPeriodId: openPeriod.id, startedOn,
  };
}

async function cleanup(ctx) {
  await q('DELETE FROM budgets WHERE id = $1', [ctx.budgetId]);
  await q('DELETE FROM users WHERE id = $1', [ctx.userId]);
}

test('POST /accounts/:id/reset: wipes open transactions/periods, re-dates started_on, leaves closed period + categories/rules untouched', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const newStart = addDays(ctx.closedPeriod.start_date, 30);
  const { status, body } = await reset(server, ctx.accountId, { startedOn: newStart, closedPeriods: 'block' });

  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(body.deletedTransactions >= 1, 'expected at least the one open transaction deleted');
  assert.ok(body.deletedPeriods >= 1, 'expected at least the one open period deleted');
  assert.equal(typeof body.startedOn, 'string');

  const { rows: acctRow } = await q('SELECT started_on FROM accounts WHERE id = $1', [ctx.accountId]);
  assert.equal(acctRow[0].started_on, body.startedOn);

  // Open period + its transactions/line_items are gone.
  const { rows: openLeft } = await q('SELECT id FROM pay_periods WHERE id = $1', [ctx.openPeriodId]);
  assert.equal(openLeft.length, 0, 'open period must be deleted');

  // Closed period is byte-for-byte unchanged, including its transaction and
  // line item.
  const { rows: closedRow } = await q(
    'SELECT closed_at, closed_snapshot FROM pay_periods WHERE id = $1', [ctx.closedPeriod.id]
  );
  assert.equal(closedRow.length, 1, 'closed period must survive');
  assert.ok(closedRow[0].closed_at, 'closed_at must remain set');
  assert.equal(closedRow[0].closed_snapshot.total, 12345);

  const { rows: closedTxns } = await q(
    'SELECT id FROM transactions WHERE pay_period_id = $1', [ctx.closedPeriod.id]
  );
  assert.equal(closedTxns.length, 1, 'closed period transaction must survive');

  const { rows: closedLi } = await q(
    'SELECT id FROM line_items WHERE id = $1', [ctx.closedLineItemId]
  );
  assert.equal(closedLi.length, 1, 'closed period line item must survive');

  // Categories and rules untouched.
  const { rows: catRow } = await q('SELECT id FROM category_templates WHERE id = $1', [ctx.categoryId]);
  assert.equal(catRow.length, 1, 'category must survive');
  const { rows: ruleRow } = await q('SELECT id FROM category_rules WHERE id = $1', [ctx.ruleId]);
  assert.equal(ruleRow.length, 1, 'rule must survive');

  // Second, unrelated account is fully untouched.
  const { rows: acctBRow } = await q('SELECT started_on FROM accounts WHERE id = $1', [ctx.accountB]);
  assert.equal(acctBRow[0].started_on, ctx.startedOn);
  const { rows: acctBPeriods } = await q('SELECT id FROM pay_periods WHERE account_id = $1', [ctx.accountB]);
  assert.ok(acctBPeriods.length >= 1, 'second account periods must be untouched');
});

test("POST /accounts/:id/reset: blocks a startedOn at/before the earliest closed period, naming it, and deletes nothing", async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const { status, body } = await reset(server, ctx.accountId, {
    startedOn: ctx.closedPeriod.start_date, closedPeriods: 'block',
  });

  assert.equal(status, 400, JSON.stringify(body));
  assert.match(body.error, new RegExp(ctx.closedPeriod.start_date));

  // Nothing was deleted or changed.
  const { rows: openLeft } = await q('SELECT id FROM pay_periods WHERE id = $1', [ctx.openPeriodId]);
  assert.equal(openLeft.length, 1, 'open period must still exist');
  const { rows: acctRow } = await q('SELECT started_on FROM accounts WHERE id = $1', [ctx.accountId]);
  assert.equal(acctRow[0].started_on, ctx.startedOn);
});

test("POST /accounts/:id/reset: closedPeriods: 'confirm' bypasses the block but still never touches the closed period", async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const { status, body } = await reset(server, ctx.accountId, {
    startedOn: ctx.closedPeriod.start_date, closedPeriods: 'confirm',
  });

  assert.equal(status, 200, JSON.stringify(body));

  // Closed period, its transaction and line item all survive untouched.
  const { rows: closedRow } = await q(
    'SELECT closed_at, closed_snapshot FROM pay_periods WHERE id = $1', [ctx.closedPeriod.id]
  );
  assert.equal(closedRow.length, 1);
  assert.ok(closedRow[0].closed_at);
  const { rows: closedTxns } = await q('SELECT id FROM transactions WHERE pay_period_id = $1', [ctx.closedPeriod.id]);
  assert.equal(closedTxns.length, 1);

  // Open period is gone and started_on was updated to the requested date.
  const { rows: openLeft } = await q('SELECT id FROM pay_periods WHERE id = $1', [ctx.openPeriodId]);
  assert.equal(openLeft.length, 0);
  assert.equal(body.startedOn <= ctx.closedPeriod.start_date, true);
});

test.after(() => pool.end());
