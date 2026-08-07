// Integration tests for CONSTITUTION.md's 2026-08-06 entry, "Rule matching
// must prefer a same-account-resolving rule over an earlier-but-foreign one,
// in all three call sites, not stop at the first foreign match."
//
// Covers all three consumers of server/services/rules.js's
// firstMatchingCategory:
//   - server/routes/transactions.js POST /transactions/recategorize
//   - server/routes/import.js POST /import/preview
//   - server/services/simplefin.js insertSyncedTxn (via processTxn)
//
// For each: (1) an earlier, textually-matching rule that resolves to a
// DIFFERENT account's category must not shadow a same-account rule sitting
// later in sort order - the same-account rule must win. (2) the original
// safety property must still hold unchanged - when only a foreign-account
// rule matches (no same-account rule matches at all), the transaction is
// left uncategorized, never assigned the foreign category. (3) the
// diagnostic "skipped: wrong account" counters (skippedOtherAccount /
// results.otherAccount) fire in exactly the case in (2), and do not fire
// when nothing matches at all.
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
import { q, pool } from '../../db.js';
import { HttpError } from '../../validation.js';
import { createSoloBudget, ensureMaterialized, getDefaultAccountId, getConfig, loadTemplates } from '../../services/budget.js';
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

// Seeds a budget with two accounts (A = default, B = second), each with its
// own weekly pay-period config and a materialized open period, plus a
// category template owned by each account. accountA's template has a NULL
// account_id (owns the default account per templateOwnsAccount's `??`
// rule); accountB's template has an explicit account_id.
async function seed() {
  const email = `rule-fallthrough-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
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
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'weekly', $3)",
    [budgetId, accountA, startedOn]
  );

  const { rows: acctB } = await q(
    "INSERT INTO accounts (budget_id, name, started_on) VALUES ($1, 'Second account', $2) RETURNING id",
    [budgetId, startedOn]
  );
  const accountB = acctB[0].id;
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'weekly', $3)",
    [budgetId, accountB, startedOn]
  );

  await ensureMaterialized(budgetId);
  const { rows: periodA } = await q(
    'SELECT id FROM pay_periods WHERE account_id = $1 AND start_date <= $2 AND end_date >= $2',
    [accountA, today]
  );
  const { rows: periodB } = await q(
    'SELECT id FROM pay_periods WHERE account_id = $1 AND start_date <= $2 AND end_date >= $2',
    [accountB, today]
  );

  const { rows: templateA } = await q(
    `INSERT INTO category_templates (budget_id, account_id, name, type, recurrence, category_type, sort_order)
     VALUES ($1, NULL, 'Groceries A', 'expense', 'every_period', 'recurring', 0) RETURNING id`,
    [budgetId]
  );
  const { rows: templateB } = await q(
    `INSERT INTO category_templates (budget_id, account_id, name, type, recurrence, category_type, sort_order)
     VALUES ($1, $2, 'Groceries B', 'expense', 'every_period', 'recurring', 1) RETURNING id`,
    [budgetId, accountB]
  );
  const catAmount = async (templateId) => q(
    'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, $2, $3)',
    [templateId, 5000, startedOn]
  );
  await catAmount(templateA[0].id);
  await catAmount(templateB[0].id);

  return {
    userId, budgetId, budget, accountA, accountB,
    periodA: periodA[0].id, periodB: periodB[0].id,
    templateA: templateA[0].id, templateB: templateB[0].id,
    date: today,
  };
}

async function cleanup(ctx) {
  await q('DELETE FROM budgets WHERE id = $1', [ctx.budgetId]);
  await q('DELETE FROM users WHERE id = $1', [ctx.userId]);
}

async function addRule(budgetId, categoryTemplateId, sortOrder, descriptionContains) {
  await q(
    `INSERT INTO category_rules (budget_id, category_template_id, sort_order, description_contains)
     VALUES ($1, $2, $3, $4)`,
    [budgetId, categoryTemplateId, sortOrder, descriptionContains]
  );
}

// --- POST /transactions/recategorize ---------------------------------

test('POST /transactions/recategorize: an earlier foreign-account rule match falls through to a later same-account rule', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  // Rule 1 (earlier in sort order): matches by description but resolves to
  // templateA, owned by accountA - foreign relative to this txn on accountB.
  await addRule(ctx.budgetId, ctx.templateA, 0, 'GROCERY');
  // Rule 2 (later): also matches, resolves to templateB, owned by accountB -
  // the transaction's own account.
  await addRule(ctx.budgetId, ctx.templateB, 1, 'GROCERY');

  const { rows: txn } = await q(
    `INSERT INTO transactions (budget_id, user_id, pay_period_id, type, amount_cents, description, date, account_id)
     VALUES ($1, $2, $3, 'expense', 1234, 'GROCERY STORE 5', $4, $5) RETURNING id`,
    [ctx.budgetId, ctx.userId, ctx.periodB, ctx.date, ctx.accountB]
  );

  const { status, body } = await req(server, 'POST', '/transactions/recategorize');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.matched, 1);
  assert.equal(body.skippedOtherAccount, 0);

  const { rows: after } = await q('SELECT category_template_id FROM transactions WHERE id = $1', [txn[0].id]);
  assert.equal(after[0].category_template_id, ctx.templateB);
});

test('POST /transactions/recategorize: only a foreign-account rule matches -> stays uncategorized, skippedOtherAccount increments', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  // Only a foreign rule (owned by accountA) exists - no same-account rule
  // for accountB matches this transaction at all.
  await addRule(ctx.budgetId, ctx.templateA, 0, 'GROCERY');

  const { rows: txn } = await q(
    `INSERT INTO transactions (budget_id, user_id, pay_period_id, type, amount_cents, description, date, account_id)
     VALUES ($1, $2, $3, 'expense', 1234, 'GROCERY STORE 5', $4, $5) RETURNING id`,
    [ctx.budgetId, ctx.userId, ctx.periodB, ctx.date, ctx.accountB]
  );

  const { status, body } = await req(server, 'POST', '/transactions/recategorize');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.matched, 0);
  assert.equal(body.skippedOtherAccount, 1);

  const { rows: after } = await q('SELECT category_template_id FROM transactions WHERE id = $1', [txn[0].id]);
  assert.equal(after[0].category_template_id, null);
});

test('POST /transactions/recategorize: no rule matches at all -> skippedOtherAccount does not increment', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  await addRule(ctx.budgetId, ctx.templateA, 0, 'GROCERY');

  const { rows: txn } = await q(
    `INSERT INTO transactions (budget_id, user_id, pay_period_id, type, amount_cents, description, date, account_id)
     VALUES ($1, $2, $3, 'expense', 1234, 'UNRELATED PURCHASE', $4, $5) RETURNING id`,
    [ctx.budgetId, ctx.userId, ctx.periodB, ctx.date, ctx.accountB]
  );

  const { status, body } = await req(server, 'POST', '/transactions/recategorize');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.matched, 0);
  assert.equal(body.skippedOtherAccount, 0);

  const { rows: after } = await q('SELECT category_template_id FROM transactions WHERE id = $1', [txn[0].id]);
  assert.equal(after[0].category_template_id, null);
});

// --- POST /import/preview ---------------------------------------------

test('POST /import/preview: an earlier foreign-account rule match falls through to a later same-account rule', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  await addRule(ctx.budgetId, ctx.templateA, 0, 'GROCERY');
  await addRule(ctx.budgetId, ctx.templateB, 1, 'GROCERY');

  const { status, body } = await req(server, 'POST', '/import/preview', {
    accountId: ctx.accountB,
    rows: [
      { date: ctx.date, description: 'GROCERY STORE 5', amountCents: -1234 },
    ],
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].suggestedCategoryId, ctx.templateB);
  assert.equal(body.rows[0].matchedBy, 'rule');
});

test('POST /import/preview: only a foreign-account rule matches -> no suggestion', async (t) => {
  const ctx = await seed();
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  await addRule(ctx.budgetId, ctx.templateA, 0, 'GROCERY');

  const { status, body } = await req(server, 'POST', '/import/preview', {
    accountId: ctx.accountB,
    rows: [
      { date: ctx.date, description: 'GROCERY STORE 5', amountCents: -1234 },
    ],
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].suggestedCategoryId, null);
  assert.equal(body.rows[0].matchedBy, null);
});

// --- simplefin.js insertSyncedTxn (via processTxn) ---------------------

async function runProcessTxn(ctx, rules, description) {
  const cfg = await getConfig(ctx.budgetId, ctx.accountB);
  const templates = await loadTemplates(ctx.budgetId, { includeArchived: true });
  const { rows: accountRows } = await q('SELECT * FROM accounts WHERE budget_id = $1', [ctx.budgetId]);
  const ctxObj = {
    budget: ctx.budget,
    cfg,
    defaultAccountId: ctx.accountA,
    cfgByAccount: new Map(),
    rules,
    templatesById: new Map(templates.map((tpl) => [tpl.id, tpl])),
    accountsById: new Map(accountRows.map((a) => [a.id, a])),
  };
  const link = { account_id: ctx.accountB, sf_account_id: 'sf-acct-1' };
  const results = {
    added: 0, duplicates: 0, updated: 0, skipped: 0, cleared: 0, moved: 0, inClosed: 0, declinedClosed: 0,
    replanned: 0, otherAccount: 0, drift: [], warnings: [],
  };

  const clientDb = await pool.connect();
  try {
    await clientDb.query('BEGIN');
    await processTxn(clientDb, ctxObj, link, {
      id: `sf-txn-${Math.random().toString(36).slice(2, 8)}`,
      amount: '-15.00',
      description,
      posted: Math.floor(new Date(`${ctx.date}T12:00:00Z`).getTime() / 1000),
    }, ctx.userId, results);
    await clientDb.query('COMMIT');
  } finally {
    clientDb.release();
  }

  const { rows: synced } = await q(
    'SELECT category_template_id FROM transactions WHERE budget_id = $1 AND description = $2',
    [ctx.budgetId, description]
  );
  return { results, categoryTemplateId: synced[0]?.category_template_id ?? null };
}

test('simplefin insertSyncedTxn: an earlier foreign-account rule match falls through to a later same-account rule', async (t) => {
  const ctx = await seed();
  t.after(() => cleanup(ctx));

  const rules = [
    { category_template_id: ctx.templateA, description_contains: 'GROCERY', account_contains: null, institution_contains: null, account_number_contains: null, amount_min_cents: null, amount_max_cents: null, amount_equals_cents: null, amount_contains: null },
    { category_template_id: ctx.templateB, description_contains: 'GROCERY', account_contains: null, institution_contains: null, account_number_contains: null, amount_min_cents: null, amount_max_cents: null, amount_equals_cents: null, amount_contains: null },
  ];

  const { results, categoryTemplateId } = await runProcessTxn(ctx, rules, 'GROCERY STORE SFSYNC 1');
  assert.equal(results.added, 1);
  assert.equal(results.otherAccount, 0);
  assert.equal(categoryTemplateId, ctx.templateB);
});

test('simplefin insertSyncedTxn: only a foreign-account rule matches -> stays uncategorized, results.otherAccount increments', async (t) => {
  const ctx = await seed();
  t.after(() => cleanup(ctx));

  const rules = [
    { category_template_id: ctx.templateA, description_contains: 'GROCERY', account_contains: null, institution_contains: null, account_number_contains: null, amount_min_cents: null, amount_max_cents: null, amount_equals_cents: null, amount_contains: null },
  ];

  const { results, categoryTemplateId } = await runProcessTxn(ctx, rules, 'GROCERY STORE SFSYNC 2');
  assert.equal(results.added, 1);
  assert.equal(results.otherAccount, 1);
  assert.equal(categoryTemplateId, null);
});

test('simplefin insertSyncedTxn: no rule matches at all -> results.otherAccount does not increment', async (t) => {
  const ctx = await seed();
  t.after(() => cleanup(ctx));

  const rules = [
    { category_template_id: ctx.templateA, description_contains: 'GROCERY', account_contains: null, institution_contains: null, account_number_contains: null, amount_min_cents: null, amount_max_cents: null, amount_equals_cents: null, amount_contains: null },
  ];

  const { results, categoryTemplateId } = await runProcessTxn(ctx, rules, 'UNRELATED SFSYNC PURCHASE');
  assert.equal(results.added, 1);
  assert.equal(results.otherAccount, 0);
  assert.equal(categoryTemplateId, null);
});
