// Integration tests for PATCH /categories/:id reassigning a category's
// account_id (server/routes/categories.js). See
// docs/plans/category-account-reassign-fix.md for the root cause: without
// this reconciliation, a category's already-materialized, uncleared,
// open-period line item stays parked under the OLD account forever while
// ensureMaterialized seeds a fresh, correctly-owned item under the NEW
// account on the next request — the same planned amount double-counts on
// both accounts' balance math.
//
// Requires a real Postgres reachable via DATABASE_URL/PG* vars with the
// schema already migrated. Not part of the default `npm test` unit run —
// use `npm run test:integration` (or the ephemeral-DB wrapper,
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
import { createSoloBudget, getDefaultAccountId } from '../../services/budget.js';
import { todayISO, addDays } from '../../services/schedule.js';
import categoryRoutes from '../../routes/categories.js';

async function startTestServer(budget, userId) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.budget = budget;
    req.userId = userId;
    next();
  });
  app.use('/categories', categoryRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err.message || 'Internal server error' });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function patch(server, id, body) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/categories/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

// Seeds a budget with two accounts (A = default, B = second, both
// household-currency so PATCH /categories/:id's account guard accepts
// either), a recurring category owned by account B, and directly-inserted
// line items under account B covering the three scenarios the fix cares
// about: an uncleared item in an OPEN period (must be deleted on
// reassignment), a CLEARED item in an open period (must survive), and an
// uncleared item in a CLOSED period (must survive).
async function seed() {
  const email = `patch-category-reassign-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { rows: user } = await q(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [email]
  );
  const userId = user[0].id;
  const budget = await createSoloBudget(userId);
  const budgetId = budget.id;
  const accountA = await getDefaultAccountId(budgetId);

  const today = todayISO();
  const { rows: acctB } = await q(
    "INSERT INTO accounts (budget_id, name, started_on) VALUES ($1, 'Account B', $2) RETURNING id",
    [budgetId, addDays(today, -60)]
  );
  const accountB = acctB[0].id;

  const { rows: cat } = await q(
    `INSERT INTO category_templates (budget_id, account_id, name, type, recurrence, category_type, sort_order)
     VALUES ($1, $2, 'Electric', 'expense', 'every_period', 'recurring', 0) RETURNING id`,
    [budgetId, accountB]
  );
  const categoryId = cat[0].id;
  await q(
    'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, $2, $3)',
    [categoryId, 25000, addDays(today, -60)]
  );

  // Open period under account B, holding both the uncleared item (the
  // stale row the fix must delete) and — in a second open period — a
  // cleared item that must survive.
  const { rows: openPeriod } = await q(
    `INSERT INTO pay_periods (budget_id, account_id, start_date, end_date) VALUES ($1, $2, $3, $4) RETURNING id`,
    [budgetId, accountB, addDays(today, -14), addDays(today, -1)]
  );
  const openPeriodId = openPeriod[0].id;
  const { rows: uncleared } = await q(
    `INSERT INTO line_items (pay_period_id, category_template_id, account_id, planned_amount_cents, cleared)
     VALUES ($1, $2, $3, 25000, FALSE) RETURNING id`,
    [openPeriodId, categoryId, accountB]
  );

  const { rows: openPeriod2 } = await q(
    `INSERT INTO pay_periods (budget_id, account_id, start_date, end_date) VALUES ($1, $2, $3, $4) RETURNING id`,
    [budgetId, accountB, today, addDays(today, 13)]
  );
  const openPeriodId2 = openPeriod2[0].id;
  const { rows: cleared } = await q(
    `INSERT INTO line_items (pay_period_id, category_template_id, account_id, planned_amount_cents, cleared, cleared_date)
     VALUES ($1, $2, $3, 25000, TRUE, $4) RETURNING id`,
    [openPeriodId2, categoryId, accountB, today]
  );

  // Closed period under account B, with its own uncleared item that must
  // survive because closed periods are frozen snapshots.
  const { rows: closedPeriod } = await q(
    `INSERT INTO pay_periods (budget_id, account_id, start_date, end_date, closed_at)
     VALUES ($1, $2, $3, $4, now()) RETURNING id`,
    [budgetId, accountB, addDays(today, -28), addDays(today, -15)]
  );
  const closedPeriodId = closedPeriod[0].id;
  const { rows: closedItem } = await q(
    `INSERT INTO line_items (pay_period_id, category_template_id, account_id, planned_amount_cents, cleared)
     VALUES ($1, $2, $3, 25000, FALSE) RETURNING id`,
    [closedPeriodId, categoryId, accountB]
  );

  return {
    userId, budgetId, budget, accountA, accountB, categoryId,
    unclearedId: uncleared[0].id, clearedId: cleared[0].id, closedItemId: closedItem[0].id,
  };
}

async function cleanup(ctx) {
  await q('DELETE FROM budgets WHERE id = $1', [ctx.budgetId]);
  await q('DELETE FROM users WHERE id = $1', [ctx.userId]);
}

async function lineItemExists(id) {
  const { rows } = await q('SELECT 1 FROM line_items WHERE id = $1', [id]);
  return rows.length > 0;
}

test('PATCH /categories/:id: reassigning accountId deletes the stale uncleared open-period item under the old account', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const { status, body } = await patch(server, ctx.categoryId, { accountId: ctx.accountA });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.category.accountId, ctx.accountA);

  assert.equal(await lineItemExists(ctx.unclearedId), false, 'the stale uncleared open-period item must be deleted');
});

test('PATCH /categories/:id: a CLEARED item under the old account survives reassignment', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  await patch(server, ctx.categoryId, { accountId: ctx.accountA });

  assert.equal(await lineItemExists(ctx.clearedId), true, 'cleared history must never be touched');
});

test('PATCH /categories/:id: a CLOSED-period item under the old account survives reassignment', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  await patch(server, ctx.categoryId, { accountId: ctx.accountA });

  assert.equal(await lineItemExists(ctx.closedItemId), true, 'closed periods are frozen snapshots and must never be touched');
});

test('PATCH /categories/:id: combined categoryType (recurring->tag) + accountId change in one request deletes the stale item exactly once', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const { status, body } = await patch(server, ctx.categoryId, { accountId: ctx.accountA, categoryType: 'tag' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.category.accountId, ctx.accountA);
  assert.equal(body.category.categoryType, 'tag');

  // No double-delete error (a DELETE with no matching rows the second time
  // would just be a no-op, but the real risk is a duplicated statement
  // throwing or behaving oddly under a single connection - status 200
  // above already proves no error was thrown). Confirm the actual outcome:
  // both survivors still exist, and the stale open-period item is gone.
  assert.equal(await lineItemExists(ctx.unclearedId), false);
  assert.equal(await lineItemExists(ctx.clearedId), true);
  assert.equal(await lineItemExists(ctx.closedItemId), true);
});

test('PATCH /categories/:id: a PATCH that does not change accountId touches no line items', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const { status, body } = await patch(server, ctx.categoryId, { name: 'Electric Bill' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.category.name, 'Electric Bill');
  assert.equal(body.category.accountId, ctx.accountB, 'account must be unchanged');

  assert.equal(await lineItemExists(ctx.unclearedId), true, 'no accountId change means no line items should be touched');
  assert.equal(await lineItemExists(ctx.clearedId), true);
  assert.equal(await lineItemExists(ctx.closedItemId), true);
});

// Regression guard: sending the SAME accountId back (no actual change)
// must also be a no-op, not just an absent `accountId` key.
test('PATCH /categories/:id: sending the same accountId back (no real change) touches no line items', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const { status } = await patch(server, ctx.categoryId, { accountId: ctx.accountB });
  assert.equal(status, 200);

  assert.equal(await lineItemExists(ctx.unclearedId), true);
  assert.equal(await lineItemExists(ctx.clearedId), true);
  assert.equal(await lineItemExists(ctx.closedItemId), true);
});

test.after(() => pool.end());
