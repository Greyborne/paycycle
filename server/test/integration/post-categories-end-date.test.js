// Integration test for POST /categories (server/routes/categories.js).
// Verifies the optional "Valid until" date (endDate -> end_date column) is
// accepted at creation time and persisted, alongside the pre-existing
// startDate behavior.
//
// Requires a real Postgres reachable via DATABASE_URL/PG* vars with the
// schema already migrated. Not part of the default `npm test` unit run -
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

async function post(server, body) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/categories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

async function seed() {
  const email = `post-categories-enddate-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { rows: user } = await q(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [email]
  );
  const userId = user[0].id;
  const budget = await createSoloBudget(userId);
  const budgetId = budget.id;
  const accountId = await getDefaultAccountId(budgetId);
  return { userId, budgetId, budget, accountId };
}

async function cleanup(ctx) {
  await q('DELETE FROM budgets WHERE id = $1', [ctx.budgetId]);
  await q('DELETE FROM users WHERE id = $1', [ctx.userId]);
}

test('POST /categories: endDate is persisted to end_date when supplied', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const { status, body } = await post(server, {
    name: 'Seasonal Gym Membership',
    type: 'expense',
    accountId: ctx.accountId,
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    amountCents: 5000,
  });

  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.category.startDate, '2026-01-01');
  assert.equal(body.category.endDate, '2026-12-31');

  const { rows } = await q('SELECT end_date::text AS end_date FROM category_templates WHERE id = $1', [body.category.id]);
  assert.equal(rows[0].end_date, '2026-12-31');
});

test('POST /categories: omitting endDate leaves end_date NULL (ongoing)', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const { status, body } = await post(server, {
    name: 'Groceries',
    type: 'expense',
    accountId: ctx.accountId,
    amountCents: 40000,
  });

  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.category.endDate, null);

  const { rows } = await q('SELECT end_date FROM category_templates WHERE id = $1', [body.category.id]);
  assert.equal(rows[0].end_date, null);
});

test.after(() => pool.end());
