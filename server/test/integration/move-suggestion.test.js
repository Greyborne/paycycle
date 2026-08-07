// Integration tests for the adjacent-period move SUGGESTION added to
// PATCH /transactions/assign (server/routes/transactions.js,
// detectMoveSuggestion in server/services/budget.js).
//
// This is detection only: read-only queries, no mutation of pay_period_id -
// it surfaces { transactionId, direction, reason } entries in the response's
// new `suggestions` array so the frontend can offer Task 1's PATCH
// /:id/move. Two heuristics split by category_templates.recurrence, per
// CONSTITUTION.md's 2026-08-04 "recurring-match auto-detect" decision:
//   - every_period (no due-day concept, e.g. a paycheck): a "double-pay"
//     signature near a period boundary.
//   - monthly (has due_day): nearest-occurrence-day comparison.
//
// Requires a real Postgres reachable via DATABASE_URL with the schema
// already migrated. Not part of the default `npm test` unit run - use
// `npm run test:integration` (or the ephemeral-DB wrapper,
// `npm run test:integration:ephemeral`).
//
// Seeds its own isolated budget per test and deletes it afterwards (every
// budget-scoped table cascades from budgets), so runs never collide and
// leave no residue. Period bounds are inserted directly (not materialized
// via a cadence config) so every test controls exact day-distances to a
// period boundary / due_day without depending on "today" or cadence
// arithmetic.

import './_env-guard.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { pool, q } from '../../db.js';
import { HttpError } from '../../validation.js';
import { createSoloBudget, getDefaultAccountId } from '../../services/budget.js';
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

async function assignTxns(server, ids, categoryId) {
  return req(server, 'PATCH', '/transactions/assign', { ids, categoryId });
}

// Four fixed, non-overlapping, contiguous periods (no cadence engine
// involved - inserted directly so every test controls exact day-distances):
//   P0 2024-12-21..2025-01-03  (contains due_day=1 occurrence: Jan 1)
//   P1 2025-01-04..2025-01-17  (contains none)
//   P2 2025-01-18..2025-01-31  (contains none)
//   P3 2025-02-01..2025-02-14  (contains due_day=1 occurrence: Feb 1)
const PERIOD_BOUNDS = [
  ['2024-12-21', '2025-01-03'],
  ['2025-01-04', '2025-01-17'],
  ['2025-01-18', '2025-01-31'],
  ['2025-02-01', '2025-02-14'],
];

// Seeds a fresh solo budget, its default account, four fixed pay_periods
// (all open), a `paycheck` every_period recurring template, a `Rent`
// monthly (due_day=1) recurring template, and a `Coffee` tag template.
async function seedBudget() {
  const email = `move-suggestion-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { rows: user } = await q(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [email]
  );
  const userId = user[0].id;
  const budget = await createSoloBudget(userId);
  const budgetId = budget.id;
  const accountId = await getDefaultAccountId(budgetId);

  const periods = [];
  for (const [start, end] of PERIOD_BOUNDS) {
    const { rows } = await q(
      'INSERT INTO pay_periods (budget_id, account_id, start_date, end_date) VALUES ($1, $2, $3, $4) RETURNING id, start_date, end_date',
      [budgetId, accountId, start, end]
    );
    periods.push(rows[0]);
  }

  const { rows: paycheck } = await q(
    `INSERT INTO category_templates (budget_id, account_id, name, type, recurrence, category_type, sort_order)
     VALUES ($1, $2, 'Paycheck', 'income', 'every_period', 'recurring', 0) RETURNING id`,
    [budgetId, accountId]
  );
  const { rows: rent } = await q(
    `INSERT INTO category_templates (budget_id, account_id, name, type, recurrence, due_day, category_type, sort_order)
     VALUES ($1, $2, 'Rent', 'expense', 'monthly', 1, 'recurring', 1) RETURNING id`,
    [budgetId, accountId]
  );
  const { rows: coffee } = await q(
    `INSERT INTO category_templates (budget_id, account_id, name, type, recurrence, category_type, sort_order)
     VALUES ($1, $2, 'Coffee', 'expense', 'every_period', 'tag', 2) RETURNING id`,
    [budgetId, accountId]
  );

  return {
    userId, budgetId, budget, accountId,
    paycheckId: paycheck[0].id, rentId: rent[0].id, coffeeId: coffee[0].id,
    periods,
  };
}

async function insertTxn(ctx, periodId, type, amountCents, date, categoryTemplateId = null) {
  const { rows } = await q(
    `INSERT INTO transactions (budget_id, pay_period_id, type, amount_cents, description, date, account_id, category_template_id, categorized_by)
     VALUES ($1, $2, $3, $4, 'Test txn', $5, $6, $7, $8) RETURNING id`,
    [ctx.budgetId, periodId, type, amountCents, date, ctx.accountId, categoryTemplateId, categoryTemplateId ? 'manual' : null]
  );
  return rows[0].id;
}

async function cleanup(ctx) {
  await q('DELETE FROM budgets WHERE id = $1', [ctx.budgetId]);
  await q('DELETE FROM users WHERE id = $1', [ctx.userId]);
}

test('PATCH /assign: every_period double-pay signature near a boundary produces a suggestion', async (t) => {
  const ctx = await seedBudget();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const p1 = ctx.periods[1]; // 2025-01-04..2025-01-17
  await insertTxn(ctx, p1.id, 'income', 200000, '2025-01-10', ctx.paycheckId);
  await insertTxn(ctx, p1.id, 'income', 200000, '2025-01-11', ctx.paycheckId);
  const boundaryTxnId = await insertTxn(ctx, p1.id, 'income', 200000, p1.end_date); // uncategorized, on the last day

  const { status, body } = await assignTxns(server, [boundaryTxnId], ctx.paycheckId);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.updated, 1);
  assert.equal(body.suggestions.length, 1, JSON.stringify(body.suggestions));
  const suggestion = body.suggestions[0];
  assert.equal(suggestion.transactionId, boundaryTxnId);
  assert.equal(suggestion.direction, 'next');
  assert.match(suggestion.reason, /3 transactions for Paycheck/);
  assert.match(suggestion.reason, /next period has none/);
});

test('PATCH /assign: every_period, NOT near a boundary produces no suggestion', async (t) => {
  const ctx = await seedBudget();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const p1 = ctx.periods[1]; // 2025-01-04..2025-01-17
  await insertTxn(ctx, p1.id, 'income', 200000, '2025-01-10', ctx.paycheckId);
  await insertTxn(ctx, p1.id, 'income', 200000, '2025-01-11', ctx.paycheckId);
  // 2025-01-12: 5 days from start, 5 days from end - not within 3 of either.
  const midTxnId = await insertTxn(ctx, p1.id, 'income', 200000, '2025-01-12');

  const { status, body } = await assignTxns(server, [midTxnId], ctx.paycheckId);
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.suggestions, []);
});

test('PATCH /assign: every_period, only one transaction for the template produces no suggestion (no double-pay)', async (t) => {
  const ctx = await seedBudget();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const p2 = ctx.periods[2]; // 2025-01-18..2025-01-31, empty of paycheck txns
  const boundaryTxnId = await insertTxn(ctx, p2.id, 'income', 200000, p2.end_date);

  const { status, body } = await assignTxns(server, [boundaryTxnId], ctx.paycheckId);
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.suggestions, [], 'a single transaction for the template is not a double-pay signature');
});

test('PATCH /assign: monthly template posted closer to due_day in the adjacent (prev) period gets suggested', async (t) => {
  const ctx = await seedBudget();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const p1 = ctx.periods[1]; // 2025-01-04..2025-01-17: no due_day=1 occurrence in range
  // p0 (2024-12-21..2025-01-03) DOES contain the Jan 1 occurrence, 3 days
  // from this transaction's date - within tolerance and strictly closer than
  // its own period's (nonexistent) occurrence.
  const txnId = await insertTxn(ctx, p1.id, 'expense', 150000, p1.start_date);

  const { status, body } = await assignTxns(server, [txnId], ctx.rentId);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.suggestions.length, 1, JSON.stringify(body.suggestions));
  const suggestion = body.suggestions[0];
  assert.equal(suggestion.transactionId, txnId);
  assert.equal(suggestion.direction, 'prev');
  assert.match(suggestion.reason, /Rent/);
});

test('PATCH /assign: monthly template posted at its own period\'s due_day occurrence produces no suggestion', async (t) => {
  const ctx = await seedBudget();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const p3 = ctx.periods[3]; // 2025-02-01..2025-02-14, contains the Feb 1 occurrence
  const txnId = await insertTxn(ctx, p3.id, 'expense', 150000, p3.start_date); // exactly on due_day

  const { status, body } = await assignTxns(server, [txnId], ctx.rentId);
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.suggestions, []);
});

test('PATCH /assign: a tag-type category assignment never produces a suggestion', async (t) => {
  const ctx = await seedBudget();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const p1 = ctx.periods[1];
  // Dated on the period's last day (would be a boundary candidate under the
  // every_period heuristic) to prove the tag category_type short-circuits
  // before any period-bounds logic runs at all.
  const txnId = await insertTxn(ctx, p1.id, 'expense', 500, p1.end_date);

  const { status, body } = await assignTxns(server, [txnId], ctx.coffeeId);
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.suggestions, []);
});

test('PATCH /assign: bulk assign returns suggestions only for the transactions that trigger one', async (t) => {
  const ctx = await seedBudget();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const p2 = ctx.periods[2]; // 2025-01-18..2025-01-31
  await insertTxn(ctx, p2.id, 'income', 200000, '2025-01-24', ctx.paycheckId);
  await insertTxn(ctx, p2.id, 'income', 200000, '2025-01-25', ctx.paycheckId);
  const boundaryTxnId = await insertTxn(ctx, p2.id, 'income', 200000, p2.end_date); // triggers
  const midTxnId = await insertTxn(ctx, p2.id, 'income', 200000, '2025-01-25'); // does not

  const { status, body } = await assignTxns(server, [boundaryTxnId, midTxnId], ctx.paycheckId);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.updated, 2);
  assert.equal(body.suggestions.length, 1, JSON.stringify(body.suggestions));
  assert.equal(body.suggestions[0].transactionId, boundaryTxnId);
  assert.equal(body.suggestions[0].direction, 'next');
});

test.after(() => pool.end());
