// Integration tests for PATCH /transactions/:id/move (server/routes/transactions.js)
// and the derived `period_overridden` field on GET /transactions
// (CONSTITUTION.md, 2026-08-04 "Manual period reassignment" decision).
//
// Moves a transaction to the immediately adjacent (previous or next)
// pay_periods row for its account, WITHOUT touching transactions.date -
// only pay_period_id moves. Covers: successful move in both directions
// (both periods' line items recompute correctly), the source-closed guard,
// the destination-closed guard, the no-adjacent-period guard, and that
// period_overridden is derived correctly (true after a move, false for an
// untouched transaction).
//
// Requires a real Postgres reachable via DATABASE_URL with the schema
// already migrated. Not part of the default `npm test` unit run - use
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

async function moveTxn(server, id, direction) {
  return req(server, 'PATCH', `/transactions/${id}/move`, { direction });
}

// Seeds a fresh solo budget, a biweekly default account tracking far enough
// back to materialize at least 4 open periods, and a recurring expense
// category (so line_items exist to recompute against). Every materialized
// period starts open (closed_at NULL) - individual tests close whichever
// period they need closed.
async function seedBudget() {
  const email = `move-txn-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { rows: user } = await q(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [email]
  );
  const userId = user[0].id;
  const budget = await createSoloBudget(userId);
  const budgetId = budget.id;

  const today = todayISO();
  const startedOn = addDays(today, -70);
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
  await q(
    'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, $2, $3)',
    [categoryId, 10000, startedOn]
  );

  await ensureMaterialized(budgetId);
  const { rows: periods } = await q(
    'SELECT id, start_date, end_date, closed_at FROM pay_periods WHERE account_id = $1 ORDER BY start_date',
    [accountId]
  );
  assert.ok(periods.length >= 4, 'seedBudget needs at least four materialized periods for prev/next/edge coverage');
  assert.ok(periods.every((p) => !p.closed_at), 'every seeded period must start open');

  return { userId, budgetId, budget, accountId, categoryId, periods };
}

async function insertTxn(ctx, periodId, amountCents, date) {
  const { rows } = await q(
    `INSERT INTO transactions (budget_id, pay_period_id, type, amount_cents, description, date, account_id, category_template_id, categorized_by)
     VALUES ($1, $2, 'expense', $3, 'Electric bill', $4, $5, $6, 'manual') RETURNING id`,
    [ctx.budgetId, periodId, amountCents, date, ctx.accountId, ctx.categoryId]
  );
  return rows[0].id;
}

async function clearedAmount(periodId, categoryId) {
  const { rows } = await q(
    'SELECT cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [periodId, categoryId]
  );
  return rows[0]?.cleared_amount_cents ?? null;
}

async function closePeriod(periodId) {
  await q('UPDATE pay_periods SET closed_at = now(), closed_snapshot = $1 WHERE id = $2', [
    JSON.stringify({ total: 0 }), periodId,
  ]);
}

async function cleanup(ctx) {
  await q('DELETE FROM budgets WHERE id = $1', [ctx.budgetId]);
  await q('DELETE FROM users WHERE id = $1', [ctx.userId]);
}

test('PATCH /:id/move: moves a transaction to the NEXT period and recomputes both periods\' line items', async (t) => {
  const ctx = await seedBudget();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const source = ctx.periods[1];
  const nextPeriod = ctx.periods[2];
  const txnId = await insertTxn(ctx, source.id, 10000, source.start_date);
  // Realistic starting state: an already-cleared line item on the source
  // period, computed the same way a real categorize/insert would leave it.
  await q('UPDATE line_items SET cleared_amount_cents = 10000 WHERE pay_period_id = $1 AND category_template_id = $2', [source.id, ctx.categoryId]);

  const { status, body } = await moveTxn(server, txnId, 'next');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.transaction.id, txnId);
  assert.equal(body.transaction.pay_period_id, nextPeriod.id, 'must land in the immediately next period');
  assert.equal(body.transaction.date, source.start_date, 'transactions.date must NEVER be touched by a move');

  const { rows: txnRow } = await q('SELECT pay_period_id, date FROM transactions WHERE id = $1', [txnId]);
  assert.equal(txnRow[0].pay_period_id, nextPeriod.id);
  assert.equal(txnRow[0].date, source.start_date);

  assert.equal(await clearedAmount(source.id, ctx.categoryId), null, 'source period line item must recompute to NULL - it lost its only transaction');
  assert.equal(await clearedAmount(nextPeriod.id, ctx.categoryId), 10000, 'destination period line item must pick up the moved transaction\'s amount');
});

test('PATCH /:id/move: moves a transaction to the PREV period and recomputes both periods\' line items', async (t) => {
  const ctx = await seedBudget();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const source = ctx.periods[2];
  const prevPeriod = ctx.periods[1];
  const txnId = await insertTxn(ctx, source.id, 15000, source.start_date);
  await q('UPDATE line_items SET cleared_amount_cents = 15000 WHERE pay_period_id = $1 AND category_template_id = $2', [source.id, ctx.categoryId]);

  const { status, body } = await moveTxn(server, txnId, 'prev');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.transaction.pay_period_id, prevPeriod.id, 'must land in the immediately previous period');
  assert.equal(body.transaction.date, source.start_date, 'transactions.date must NEVER be touched by a move');

  assert.equal(await clearedAmount(source.id, ctx.categoryId), null, 'source period line item must recompute to NULL');
  assert.equal(await clearedAmount(prevPeriod.id, ctx.categoryId), 15000, 'destination period line item must pick up the moved transaction\'s amount');
});

test('PATCH /:id/move: blocked when the SOURCE period is closed', async (t) => {
  const ctx = await seedBudget();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const source = ctx.periods[1];
  const txnId = await insertTxn(ctx, source.id, 5000, source.start_date);
  await closePeriod(source.id);

  const { status, body } = await moveTxn(server, txnId, 'next');
  assert.equal(status, 400, JSON.stringify(body));
  assert.match(body.error, /closed pay period.*reopen it to move it/i);

  const { rows: txnRow } = await q('SELECT pay_period_id FROM transactions WHERE id = $1', [txnId]);
  assert.equal(txnRow[0].pay_period_id, source.id, 'must not have moved');
});

test('PATCH /:id/move: blocked when the DESTINATION (target) period is closed', async (t) => {
  const ctx = await seedBudget();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const source = ctx.periods[1];
  const nextPeriod = ctx.periods[2];
  const txnId = await insertTxn(ctx, source.id, 5000, source.start_date);
  await closePeriod(nextPeriod.id);

  const { status, body } = await moveTxn(server, txnId, 'next');
  assert.equal(status, 400, JSON.stringify(body));
  assert.match(body.error, /target period is closed.*reopen it/i);

  const { rows: txnRow } = await q('SELECT pay_period_id FROM transactions WHERE id = $1', [txnId]);
  assert.equal(txnRow[0].pay_period_id, source.id, 'must not have moved');

  const { rows: liRows } = await q(
    'SELECT cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [nextPeriod.id, ctx.categoryId]
  );
  assert.equal(liRows[0]?.cleared_amount_cents ?? null, null, 'closed destination period must gain no phantom actual');
});

test('PATCH /:id/move: blocked (no adjacent period) moving "next" from the LAST period', async (t) => {
  const ctx = await seedBudget();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const last = ctx.periods[ctx.periods.length - 1];
  const txnId = await insertTxn(ctx, last.id, 5000, last.start_date);

  const { status, body } = await moveTxn(server, txnId, 'next');
  assert.equal(status, 400, JSON.stringify(body));
  assert.match(body.error, /no period in that direction/i);

  const { rows: txnRow } = await q('SELECT pay_period_id FROM transactions WHERE id = $1', [txnId]);
  assert.equal(txnRow[0].pay_period_id, last.id, 'must not have moved');
});

test('PATCH /:id/move: blocked (no adjacent period) moving "prev" from the FIRST period', async (t) => {
  const ctx = await seedBudget();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const first = ctx.periods[0];
  const txnId = await insertTxn(ctx, first.id, 5000, first.start_date);

  const { status, body } = await moveTxn(server, txnId, 'prev');
  assert.equal(status, 400, JSON.stringify(body));
  assert.match(body.error, /no period in that direction/i);

  const { rows: txnRow } = await q('SELECT pay_period_id FROM transactions WHERE id = $1', [txnId]);
  assert.equal(txnRow[0].pay_period_id, first.id, 'must not have moved');
});

test('GET /transactions: period_overridden is true after a move and false for an untouched transaction', async (t) => {
  const ctx = await seedBudget();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const source = ctx.periods[1];
  const nextPeriod = ctx.periods[2];
  const movedId = await insertTxn(ctx, source.id, 5000, source.start_date);
  const untouchedId = await insertTxn(ctx, source.id, 7500, source.start_date);

  const { status: moveStatus, body: moveBody } = await moveTxn(server, movedId, 'next');
  assert.equal(moveStatus, 200, JSON.stringify(moveBody));
  assert.notEqual(nextPeriod.start_date, source.start_date, 'sanity: periods must not share a start date');
  // The moved row's own date (source.start_date) is guaranteed to fall
  // outside the destination period's [start_date, end_date] range, since
  // pay_periods rows for one account never overlap.
  assert.ok(source.start_date < nextPeriod.start_date || source.start_date > nextPeriod.end_date);

  const { status, body } = await req(server, 'GET', '/transactions');
  assert.equal(status, 200, JSON.stringify(body));
  const moved = body.transactions.find((tx) => tx.id === movedId);
  const untouched = body.transactions.find((tx) => tx.id === untouchedId);
  assert.ok(moved, 'moved transaction must be present in the list');
  assert.ok(untouched, 'untouched transaction must be present in the list');
  assert.equal(moved.period_overridden, true, 'a manually-moved transaction must be flagged as period_overridden');
  assert.equal(untouched.period_overridden, false, 'a transaction still in its date-implied period must not be flagged');
});

test.after(() => pool.end());
