// Integration test for POST /transactions assigning a RECURRING category at
// creation time (server/routes/transactions.js). Verifies:
//   (a) creating a transaction with a recurring category routes through the
//       same assignCategory/clearLineItemForTransaction path used when
//       categorizing an existing transaction — it records the actual and
//       clears that bill's line item for the period.
//   (b) a recurring category owned by a DIFFERENT account than the
//       transaction's own is rejected with a 400 (templateOwnsAccount).
//
// Exercises the real route handler (not just the underlying service
// functions) by mounting transactionRoutes on a minimal express app with a
// stub auth middleware that attaches req.budget/req.userId directly —
// mirroring how server/index.js wires requireAuth + attachBudget, without
// pulling in the real auth/session machinery.
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
import {
  createSoloBudget, ensureMaterialized, getDefaultAccountId,
} from '../../services/budget.js';
import { addDays, todayISO } from '../../services/schedule.js';
import transactionRoutes from '../../routes/transactions.js';

async function startTestServer(budget, userId) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.budget = budget;
    req.userId = userId;
    next();
  });
  app.use('/transactions', transactionRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err.message || 'Internal server error' });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function post(server, body) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

async function seed() {
  const email = `post-txn-recurring-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { rows: user } = await q(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [email]
  );
  const userId = user[0].id;
  const budget = await createSoloBudget(userId);
  const budgetId = budget.id;

  const today = todayISO();
  const startedOn = addDays(today, -30);
  const accountA = await getDefaultAccountId(budgetId);
  await q('UPDATE accounts SET started_on = $1 WHERE id = $2', [startedOn, accountA]);
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'biweekly', $3)",
    [budgetId, accountA, today]
  );

  // A second base-currency account, so ownership mismatches are real.
  const { rows: acctB } = await q(
    "INSERT INTO accounts (budget_id, name, started_on) VALUES ($1, 'Second account', $2) RETURNING id",
    [budgetId, startedOn]
  );
  const accountB = acctB[0].id;
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'biweekly', $3)",
    [budgetId, accountB, today]
  );

  // A recurring category owned by account A.
  const { rows: cat } = await q(
    `INSERT INTO category_templates (budget_id, account_id, name, type, recurrence, category_type, sort_order)
     VALUES ($1, $2, 'Electric', 'expense', 'every_period', 'recurring', 0) RETURNING id`,
    [budgetId, accountA]
  );
  const categoryId = cat[0].id;
  await q(
    'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, $2, $3)',
    [categoryId, 25000, startedOn]
  );

  await ensureMaterialized(budgetId);
  const { rows: period } = await q(
    'SELECT id, start_date FROM pay_periods WHERE account_id = $1 ORDER BY start_date DESC LIMIT 1',
    [accountA]
  );

  return { userId, budgetId, budget, accountA, accountB, categoryId, periodId: period[0].id };
}

async function cleanup(ctx) {
  await q('DELETE FROM budgets WHERE id = $1', [ctx.budgetId]);
  await q('DELETE FROM users WHERE id = $1', [ctx.userId]);
}

test('POST /transactions: assigning a recurring category clears the line item for the period', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const { rows: periodRow } = await q('SELECT start_date FROM pay_periods WHERE id = $1', [ctx.periodId]);
  const date = periodRow[0].start_date;

  const { status, body } = await post(server, {
    amountCents: 26000,
    type: 'expense',
    date,
    accountId: ctx.accountA,
    categoryTemplateId: ctx.categoryId,
  });

  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.transaction.category_template_id, ctx.categoryId);
  assert.equal(body.transaction.categorized_by, 'manual');

  const { rows: li } = await q(
    'SELECT cleared, cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [ctx.periodId, ctx.categoryId]
  );
  assert.equal(li[0].cleared, true, 'the line item must be cleared');
  assert.equal(li[0].cleared_amount_cents, 26000, 'cleared_amount_cents must reflect the new transaction');

  // Drift: planned is 25000, actual is 26000 — below the default threshold,
  // so no drift notice is expected here; this just documents the shape.
  assert.ok(!body.drift || typeof body.drift === 'object');
});

test('POST /transactions: a recurring category owned by a DIFFERENT account is rejected', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const { rows: periodRow } = await q('SELECT start_date FROM pay_periods WHERE id = $1', [ctx.periodId]);
  const date = periodRow[0].start_date;

  // ctx.categoryId is owned by accountA; posting it against accountB must be
  // rejected before anything is inserted.
  const { status, body } = await post(server, {
    amountCents: 26000,
    type: 'expense',
    date,
    accountId: ctx.accountB,
    categoryTemplateId: ctx.categoryId,
  });

  assert.equal(status, 400);
  assert.match(body.error, /different account/i);

  const { rows: txns } = await q(
    'SELECT id FROM transactions WHERE budget_id = $1 AND account_id = $2', [ctx.budgetId, ctx.accountB]
  );
  assert.equal(txns.length, 0, 'no transaction row must have been inserted');
});

test('POST /transactions: a failure while clearing the line item rolls back the INSERT too', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  // Inject a failure at the DB level, downstream of the INSERT into
  // transactions, so we prove the whole write unit shares one transaction
  // and rolls back together. clearLineItemForTransaction/recomputeLineItemActual
  // are imported by value at module load in transactions.js, so stubbing
  // their exports at runtime would not intercept the reference the route
  // actually calls — a trigger on the underlying table is the only reliable
  // injection point.
  //
  // node --test runs test FILES concurrently against this same ephemeral DB,
  // so a table-wide trigger would spuriously break unrelated tests running
  // in parallel. Scope the trigger with a WHEN clause to only this test's
  // own period+category, so it's inert for every other row in the table.
  await q(`CREATE OR REPLACE FUNCTION _pc_fail_clear() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'injected clear failure'; END; $$ LANGUAGE plpgsql;`);
  await q(
    `CREATE TRIGGER _pc_fail_clear_trg BEFORE INSERT OR UPDATE ON line_items
     FOR EACH ROW WHEN (NEW.pay_period_id = ${Number(ctx.periodId)} AND NEW.category_template_id = ${Number(ctx.categoryId)})
     EXECUTE FUNCTION _pc_fail_clear();`
  );
  t.after(async () => {
    await q('DROP TRIGGER IF EXISTS _pc_fail_clear_trg ON line_items');
    await q('DROP FUNCTION IF EXISTS _pc_fail_clear()');
  });

  const { rows: periodRow } = await q('SELECT start_date FROM pay_periods WHERE id = $1', [ctx.periodId]);
  const date = periodRow[0].start_date;

  const { status } = await post(server, {
    amountCents: 26000,
    type: 'expense',
    date,
    accountId: ctx.accountA,
    categoryTemplateId: ctx.categoryId,
  });

  assert.equal(status, 500);

  const { rows: txns } = await q(
    'SELECT id FROM transactions WHERE budget_id = $1 AND account_id = $2 AND category_template_id = $3',
    [ctx.budgetId, ctx.accountA, ctx.categoryId]
  );
  assert.equal(txns.length, 0, 'the INSERT must have been rolled back along with the failed clear');
});

test.after(() => pool.end());
