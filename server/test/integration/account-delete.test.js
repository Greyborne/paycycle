// Integration tests for Tier 3 of docs/plans/data-reset.md: DELETE
// /accounts/:id (server/routes/accounts.js). Verifies:
//   (a) a non-default, non-only account with transactions/line_items across
//       an open AND a closed period, plus a category and a rule it owns,
//       deletes cleanly: the account, its periods (open and closed), its
//       line_items, and its transactions are all gone; the category and
//       rule SURVIVE and resolve to the household's default account
//       (account_id nulled, template.account_id ?? getDefaultAccountId());
//       any linked simplefin_account_link survives with account_id nulled;
//   (b) refuses to delete the household's only account;
//   (c) refuses to delete the live default account;
//   (d) a second, unrelated account in the same budget is byte-for-byte
//       unchanged.
//
// Exercises the real route handler by mounting accounts.js's router on a
// minimal express app with a stub auth middleware, mirroring
// account-reset.test.js's pattern.
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
import { todayISO, addDays } from '../../services/schedule.js';
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

async function del(server, accountId) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/accounts/${accountId}`, { method: 'DELETE' });
  let body = null;
  try { body = await res.json(); } catch { /* 204 has no body */ }
  return { status: res.status, body };
}

async function seed() {
  const email = `account-delete-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { rows: user } = await q(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [email]
  );
  const userId = user[0].id;
  const budget = await createSoloBudget(userId);
  const budgetId = budget.id;
  const defaultAccountId = await getDefaultAccountId(budgetId);

  const today = todayISO();
  const startedOn = addDays(today, -60);

  // The account under test: a second, non-default account with its own
  // config, so it materializes its own periods.
  const { rows: acct } = await q(
    "INSERT INTO accounts (budget_id, name, started_on) VALUES ($1, 'Old Checking', $2) RETURNING id",
    [budgetId, startedOn]
  );
  const accountId = acct[0].id;
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'weekly', $3)",
    [budgetId, accountId, startedOn]
  );

  // A third, unrelated account in the same budget - must survive untouched
  // by a delete run on accountId.
  const { rows: acctC } = await q(
    "INSERT INTO accounts (budget_id, name, started_on) VALUES ($1, 'Untouched account', $2) RETURNING id",
    [budgetId, startedOn]
  );
  const accountC = acctC[0].id;
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'weekly', $3)",
    [budgetId, accountC, startedOn]
  );

  // A category and a rule owned by the account under test.
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

  // A simplefin link pointed at this account - must survive with account_id
  // nulled (un-synced), not error or cascade-delete.
  const { rows: conn } = await q(
    `INSERT INTO simplefin_connections (budget_id, access_url, label) VALUES ($1, 'https://example.test/token', 'Test bank') RETURNING id`,
    [budgetId]
  );
  const { rows: link } = await q(
    `INSERT INTO simplefin_account_links (connection_id, sf_account_id, sf_name, account_id)
     VALUES ($1, 'sf-acct-1', 'SF Checking', $2) RETURNING id`,
    [conn[0].id, accountId]
  );
  const linkId = link[0].id;

  await ensureMaterialized(budgetId);

  const { rows: periods } = await q(
    'SELECT id, start_date, end_date FROM pay_periods WHERE account_id = $1 ORDER BY start_date ASC',
    [accountId]
  );
  assert.ok(periods.length >= 1, 'expected at least one materialized period');

  const closedPeriod = periods[0];
  await q(
    'UPDATE pay_periods SET closed_at = now(), closed_snapshot = $1 WHERE id = $2',
    [JSON.stringify({ total: 12345 }), closedPeriod.id]
  );
  await q(
    `INSERT INTO transactions (budget_id, pay_period_id, type, amount_cents, description, date, account_id, category_template_id, categorized_by)
     VALUES ($1, $2, 'expense', 5000, 'closed txn', $3, $4, $5, 'manual')`,
    [budgetId, closedPeriod.id, closedPeriod.start_date, accountId, categoryId]
  );
  const { rows: closedLineItem } = await q(
    'SELECT id FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [closedPeriod.id, categoryId]
  );

  const openPeriod = periods[periods.length - 1];
  await q(
    `INSERT INTO transactions (budget_id, pay_period_id, type, amount_cents, description, date, account_id, category_template_id, categorized_by)
     VALUES ($1, $2, 'expense', 5000, 'open txn', $3, $4, $5, 'manual')`,
    [budgetId, openPeriod.id, openPeriod.start_date, accountId, categoryId]
  );
  const { rows: openLineItem } = await q(
    'SELECT id FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [openPeriod.id, categoryId]
  );

  return {
    userId, budgetId, budget, defaultAccountId, accountId, accountC,
    categoryId, ruleId, linkId,
    closedPeriodId: closedPeriod.id, closedLineItemId: closedLineItem[0].id,
    openPeriodId: openPeriod.id, openLineItemId: openLineItem[0].id,
  };
}

async function cleanup(ctx) {
  await q('DELETE FROM budgets WHERE id = $1', [ctx.budgetId]);
  await q('DELETE FROM users WHERE id = $1', [ctx.userId]);
}

test('DELETE /accounts/:id: deletes account + its periods (open and closed) + line_items + transactions; category/rule/simplefin link survive reassigned to default; other account untouched', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const { status, body } = await del(server, ctx.accountId);
  assert.equal(status, 204, JSON.stringify(body));

  // The account itself is gone.
  const { rows: acctLeft } = await q('SELECT id FROM accounts WHERE id = $1', [ctx.accountId]);
  assert.equal(acctLeft.length, 0, 'account must be deleted');

  // Its pay_period_config, both periods (open AND closed), and their
  // line_items/transactions are gone.
  const { rows: cfgLeft } = await q('SELECT id FROM pay_period_configs WHERE account_id = $1', [ctx.accountId]);
  assert.equal(cfgLeft.length, 0, 'pay_period_config must cascade-delete');

  const { rows: periodsLeft } = await q(
    'SELECT id FROM pay_periods WHERE id IN ($1, $2)', [ctx.closedPeriodId, ctx.openPeriodId]
  );
  assert.equal(periodsLeft.length, 0, 'both open and closed periods must cascade-delete (deliberate Tier 3 exception)');

  const { rows: lineItemsLeft } = await q(
    'SELECT id FROM line_items WHERE id IN ($1, $2)', [ctx.closedLineItemId, ctx.openLineItemId]
  );
  assert.equal(lineItemsLeft.length, 0, 'line_items must cascade-delete with their periods');

  const { rows: txnsLeft } = await q(
    'SELECT id FROM transactions WHERE pay_period_id IN ($1, $2)', [ctx.closedPeriodId, ctx.openPeriodId]
  );
  assert.equal(txnsLeft.length, 0, 'transactions must cascade-delete with their periods');

  // The category and rule survive, unassigned, and now resolve to the
  // household's default account.
  const { rows: catRow } = await q('SELECT id, account_id FROM category_templates WHERE id = $1', [ctx.categoryId]);
  assert.equal(catRow.length, 1, 'category must survive');
  assert.equal(catRow[0].account_id, null, 'category.account_id must be nulled');
  const resolved = catRow[0].account_id ?? ctx.defaultAccountId;
  assert.equal(resolved, ctx.defaultAccountId, 'category must resolve to the default account');

  const { rows: ruleRow } = await q('SELECT id FROM category_rules WHERE id = $1', [ctx.ruleId]);
  assert.equal(ruleRow.length, 1, 'rule must survive (it only references the category, unaffected)');

  // The simplefin link survives, un-synced (account_id nulled).
  const { rows: linkRow } = await q('SELECT id, account_id FROM simplefin_account_links WHERE id = $1', [ctx.linkId]);
  assert.equal(linkRow.length, 1, 'simplefin link must survive');
  assert.equal(linkRow[0].account_id, null, 'simplefin link must be un-synced (account_id nulled)');

  // The unrelated third account is fully untouched.
  const { rows: acctCRow } = await q('SELECT id FROM accounts WHERE id = $1', [ctx.accountC]);
  assert.equal(acctCRow.length, 1, 'unrelated account must survive');
  const { rows: acctCPeriods } = await q('SELECT id FROM pay_periods WHERE account_id = $1', [ctx.accountC]);
  assert.ok(acctCPeriods.length >= 1, 'unrelated account periods must be untouched');
});

test('DELETE /accounts/:id: refuses to delete the household\'s only account', async (t) => {
  const email = `account-delete-only-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { rows: user } = await q(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]
  );
  const userId = user[0].id;
  const budget = await createSoloBudget(userId);
  const defaultAccountId = await getDefaultAccountId(budget.id);
  const server = await startTestServer(budget, userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await q('DELETE FROM budgets WHERE id = $1', [budget.id]);
    await q('DELETE FROM users WHERE id = $1', [userId]);
  });

  const { status, body } = await del(server, defaultAccountId);
  assert.equal(status, 400, JSON.stringify(body));

  const { rows: still } = await q('SELECT id FROM accounts WHERE id = $1', [defaultAccountId]);
  assert.equal(still.length, 1, 'the only account must survive');
});

test('DELETE /accounts/:id: refuses to delete the live default account when another account exists', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const { status, body } = await del(server, ctx.defaultAccountId);
  assert.equal(status, 400, JSON.stringify(body));
  assert.match(body.error, /default/i);

  const { rows: still } = await q('SELECT id FROM accounts WHERE id = $1', [ctx.defaultAccountId]);
  assert.equal(still.length, 1, 'the live default account must survive');
});

test.after(() => pool.end());
