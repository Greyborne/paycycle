// Integration test for cross-source possible-duplicate flagging
// (CONSTITUTION.md, 2026-08-01 §8B): server/services/duplicates.js
// (findPossibleDuplicate), its three call sites (server/routes/transactions.js
// POST /, server/routes/import.js POST /commit, server/services/simplefin.js
// insertSyncedTxn via processTxn), and the two new review-UI endpoints
// (GET /transactions/duplicates, PATCH /transactions/:id/dismiss-duplicate).
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
import { q, pool } from '../../db.js';
import { HttpError } from '../../validation.js';
import {
  createSoloBudget, ensureMaterialized, getDefaultAccountId, getConfig, loadTemplates,
} from '../../services/budget.js';
import { addDays, todayISO } from '../../services/schedule.js';
import transactionRoutes from '../../routes/transactions.js';
import importRoutes from '../../routes/import.js';
import { processTxn } from '../../services/simplefin.js';

async function startTestServer(budget, userId) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.budget = budget;
    req.userId = userId;
    next();
  });
  app.use('/transactions', transactionRoutes);
  app.use('/import', importRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err.message || 'Internal server error' });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function req(server, method, path, body) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function seed() {
  const email = `dup-flag-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { rows: user } = await q(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [email]
  );
  const userId = user[0].id;
  const budget = await createSoloBudget(userId);
  const budgetId = budget.id;

  const today = todayISO();
  const startedOn = addDays(today, -60);
  const accountA = await getDefaultAccountId(budgetId);
  await q('UPDATE accounts SET started_on = $1 WHERE id = $2', [startedOn, accountA]);
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'biweekly', $3)",
    [budgetId, accountA, today]
  );
  await ensureMaterialized(budgetId);
  const { rows: period } = await q(
    'SELECT id, start_date FROM pay_periods WHERE account_id = $1 AND start_date <= $2 AND end_date >= $2',
    [accountA, today]
  );

  return { userId, budgetId, budget, accountA, periodId: period[0].id, date: today };
}

async function cleanup(ctx) {
  await q('DELETE FROM budgets WHERE id = $1', [ctx.budgetId]);
  await q('DELETE FROM users WHERE id = $1', [ctx.userId]);
}

test('POST /transactions: a manual entry is flagged as a possible duplicate of a pre-existing matching transaction', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  // Pre-existing transaction (e.g. pulled in by bank sync earlier).
  const { rows: existing } = await q(
    `INSERT INTO transactions (budget_id, user_id, pay_period_id, type, amount_cents, description, date, account_id)
     VALUES ($1, $2, $3, 'expense', 4321, 'COFFEE SHOP #4', $4, $5) RETURNING id`,
    [ctx.budgetId, ctx.userId, ctx.periodId, ctx.date, ctx.accountA]
  );
  const existingId = existing[0].id;

  // Manual second leg: same type/amount, within 3 days, description does not
  // resemble the original at all — must still match, since description is
  // explicitly not part of the heuristic.
  const { status, body } = await req(server, 'POST', '/transactions', {
    amountCents: 4321,
    type: 'expense',
    date: addDays(ctx.date, 2),
    accountId: ctx.accountA,
    description: 'Coffee - reimburse me',
  });
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.transaction.possible_duplicate_of, existingId);

  // GET /transactions/duplicates surfaces the pair.
  const list = await req(server, 'GET', `/transactions/duplicates?account=${ctx.accountA}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.pairs.length, 1);
  assert.equal(list.body.pairs[0].id, body.transaction.id);
  assert.equal(list.body.pairs[0].original_id, existingId);

  // Dismissing nulls the flag, not a separate state.
  const dismiss = await req(server, 'PATCH', `/transactions/${body.transaction.id}/dismiss-duplicate`);
  assert.equal(dismiss.status, 204);
  const { rows: after } = await q('SELECT possible_duplicate_of FROM transactions WHERE id = $1', [body.transaction.id]);
  assert.equal(after[0].possible_duplicate_of, null);

  const listAfter = await req(server, 'GET', `/transactions/duplicates?account=${ctx.accountA}`);
  assert.equal(listAfter.body.pairs.length, 0);
});

test('POST /transactions: outside the +/-3 day window is NOT flagged', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  await q(
    `INSERT INTO transactions (budget_id, user_id, pay_period_id, type, amount_cents, description, date, account_id)
     VALUES ($1, $2, $3, 'expense', 5000, 'X', $4, $5)`,
    [ctx.budgetId, ctx.userId, ctx.periodId, ctx.date, ctx.accountA]
  );

  const { status, body } = await req(server, 'POST', '/transactions', {
    amountCents: 5000,
    type: 'expense',
    date: addDays(ctx.date, 4),
    accountId: ctx.accountA,
  });
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.transaction.possible_duplicate_of, null);
});

test('POST /transactions: multiple candidates within the window pick the CLOSEST date', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const { rows: far } = await q(
    `INSERT INTO transactions (budget_id, user_id, pay_period_id, type, amount_cents, description, date, account_id)
     VALUES ($1, $2, $3, 'expense', 7000, 'far', $4, $5) RETURNING id`,
    [ctx.budgetId, ctx.userId, ctx.periodId, addDays(ctx.date, -3), ctx.accountA]
  );
  const { rows: close } = await q(
    `INSERT INTO transactions (budget_id, user_id, pay_period_id, type, amount_cents, description, date, account_id)
     VALUES ($1, $2, $3, 'expense', 7000, 'close', $4, $5) RETURNING id`,
    [ctx.budgetId, ctx.userId, ctx.periodId, addDays(ctx.date, -1), ctx.accountA]
  );

  const { status, body } = await req(server, 'POST', '/transactions', {
    amountCents: 7000,
    type: 'expense',
    date: ctx.date,
    accountId: ctx.accountA,
  });
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.transaction.possible_duplicate_of, close[0].id);
  assert.notEqual(body.transaction.possible_duplicate_of, far[0].id);
});

test('POST /import/commit: a genuinely new CSV row is flagged against a pre-existing matching transaction', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const { rows: existing } = await q(
    `INSERT INTO transactions (budget_id, user_id, pay_period_id, type, amount_cents, description, date, account_id)
     VALUES ($1, $2, $3, 'expense', 9900, 'Manually entered gas', $4, $5) RETURNING id`,
    [ctx.budgetId, ctx.userId, ctx.periodId, ctx.date, ctx.accountA]
  );
  const existingId = existing[0].id;

  const { status, body } = await req(server, 'POST', '/import/commit', {
    accountId: ctx.accountA,
    updatePlanned: false,
    rows: [
      {
        date: addDays(ctx.date, 1),
        description: 'SHELL OIL 04829',
        amountCents: -9900,
        bankId: 'bank-txn-1',
        categoryTemplateId: null,
      },
    ],
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.imported, 1);

  const { rows: imported } = await q(
    "SELECT id, possible_duplicate_of FROM transactions WHERE budget_id = $1 AND description = 'SHELL OIL 04829'",
    [ctx.budgetId]
  );
  assert.equal(imported.length, 1);
  assert.equal(imported[0].possible_duplicate_of, existingId);
});

test('SimpleFIN insertSyncedTxn (via processTxn): a synced transaction is flagged against a pre-existing matching transaction', async (t) => {
  const ctx = await seed();
  t.after(() => cleanup(ctx));

  const { rows: existing } = await q(
    `INSERT INTO transactions (budget_id, user_id, pay_period_id, type, amount_cents, description, date, account_id)
     VALUES ($1, $2, $3, 'expense', 1500, 'Manual note', $4, $5) RETURNING id`,
    [ctx.budgetId, ctx.userId, ctx.periodId, ctx.date, ctx.accountA]
  );
  const existingId = existing[0].id;

  const cfg = await getConfig(ctx.budgetId);
  const templates = await loadTemplates(ctx.budgetId, { includeArchived: true });
  const { rows: accountRows } = await q('SELECT * FROM accounts WHERE budget_id = $1', [ctx.budgetId]);
  const ctxObj = {
    budget: ctx.budget,
    cfg,
    defaultAccountId: await getDefaultAccountId(ctx.budgetId),
    cfgByAccount: new Map(),
    rules: [],
    templatesById: new Map(templates.map((tpl) => [tpl.id, tpl])),
    accountsById: new Map(accountRows.map((a) => [a.id, a])),
  };
  const link = { account_id: ctx.accountA, sf_account_id: 'sf-acct-1' };
  const results = {
    added: 0, duplicates: 0, updated: 0, skipped: 0, cleared: 0, moved: 0, inClosed: 0, declinedClosed: 0,
    replanned: 0, otherAccount: 0, drift: [], warnings: [],
  };

  const clientDb = await pool.connect();
  try {
    await clientDb.query('BEGIN');
    await processTxn(clientDb, ctxObj, link, {
      id: 'sf-txn-1',
      amount: '-15.00',
      description: 'GROCERY STORE 99',
      posted: Math.floor(new Date(`${ctx.date}T12:00:00Z`).getTime() / 1000),
    }, ctx.userId, results);
    await clientDb.query('COMMIT');
  } finally {
    clientDb.release();
  }

  assert.equal(results.added, 1);
  const { rows: synced } = await q(
    "SELECT possible_duplicate_of FROM transactions WHERE budget_id = $1 AND description = 'GROCERY STORE 99'",
    [ctx.budgetId]
  );
  assert.equal(synced.length, 1);
  assert.equal(synced[0].possible_duplicate_of, existingId);
});
