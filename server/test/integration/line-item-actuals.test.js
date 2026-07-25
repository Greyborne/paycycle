// Integration tests for planned-vs-actual on cleared line items (see
// docs/plans/planned-vs-actual.md and migrations/015_line_item_actuals.sql):
// clearLineItemForTransaction's cleared_amount_cents bookkeeping, the
// un-assignment recompute in server/routes/transactions.js's assignCategory,
// and accountBalances falling back to planned_amount_cents when there's no
// recorded actual.
//
// Requires a real Postgres reachable via DATABASE_URL with the schema already
// migrated (see the CI workflow, or run `npm run migrate` against a throwaway
// database first). Not part of the default `npm test` unit run — use
// `npm run test:integration` (or the ephemeral-DB wrapper).
//
// Seeds its own isolated budget and deletes it afterwards (every
// budget-scoped table cascades from budgets), so runs never collide and
// leave no residue.

import './_env-guard.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, q } from '../../db.js';
import {
  createSoloBudget, ensureMaterialized, getDefaultAccountId, clearLineItemForTransaction,
  recomputeLineItemActual, accountBalances,
} from '../../services/budget.js';
import { processTxn } from '../../services/simplefin.js';
import { addDays, todayISO } from '../../services/schedule.js';

async function seedBudget() {
  const email = `actuals-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
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

test('clearLineItemForTransaction: a single transaction sets the actual', async (t) => {
  const ctx = await seedBudget();
  t.after(() => cleanup(ctx));

  await insertTxn(ctx, 22333);
  await clearLineItemForTransaction({ query: q }, ctx.template, {
    periodId: ctx.periodId, date: todayISO(), amountCents: 22333, accountId: ctx.accountId,
  });

  const { rows } = await q(
    'SELECT cleared, cleared_amount_cents, planned_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [ctx.periodId, ctx.categoryId]
  );
  assert.equal(rows[0].cleared, true);
  assert.equal(rows[0].cleared_amount_cents, 22333);
  assert.equal(rows[0].planned_amount_cents, ctx.PLANNED, 'updatePlanned=false must leave the plan untouched');
});

test('clearLineItemForTransaction: a second transaction assigned to the same template+period sums both', async (t) => {
  const ctx = await seedBudget();
  t.after(() => cleanup(ctx));

  await insertTxn(ctx, 10000);
  await clearLineItemForTransaction({ query: q }, ctx.template, {
    periodId: ctx.periodId, date: todayISO(), amountCents: 10000, accountId: ctx.accountId,
  });
  await insertTxn(ctx, 5000);
  await clearLineItemForTransaction({ query: q }, ctx.template, {
    periodId: ctx.periodId, date: todayISO(), amountCents: 5000, accountId: ctx.accountId,
  });

  const { rows } = await q(
    'SELECT cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [ctx.periodId, ctx.categoryId]
  );
  assert.equal(rows[0].cleared_amount_cents, 15000, 'must be the SUM of both transactions, not just the last one');
});

test('un-assigning one of two transactions reduces the actual', async (t) => {
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

  // Simulate un-assignment of the first transaction (what
  // transactions.js's assignCategory does for the oldTemplate branch).
  await q('UPDATE transactions SET category_template_id = NULL WHERE id = $1', [id1]);
  await recomputeLineItemActual({ query: q }, ctx.periodId, ctx.categoryId);

  const { rows } = await q(
    'SELECT cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [ctx.periodId, ctx.categoryId]
  );
  assert.equal(rows[0].cleared_amount_cents, 5000, 'must drop to just the remaining transaction');
});

test('un-assigning every transaction returns the actual to NULL, not 0', async (t) => {
  const ctx = await seedBudget();
  t.after(() => cleanup(ctx));

  const id1 = await insertTxn(ctx, 10000);
  await clearLineItemForTransaction({ query: q }, ctx.template, {
    periodId: ctx.periodId, date: todayISO(), amountCents: 10000, accountId: ctx.accountId,
  });

  await q('UPDATE transactions SET category_template_id = NULL WHERE id = $1', [id1]);
  await recomputeLineItemActual({ query: q }, ctx.periodId, ctx.categoryId);

  const { rows } = await q(
    'SELECT cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [ctx.periodId, ctx.categoryId]
  );
  assert.equal(rows[0].cleared_amount_cents, null, 'zero transactions must leave the column NULL, never 0');
});

test('a manually-cleared item with no transactions stays NULL and the balance falls back to planned', async (t) => {
  const ctx = await seedBudget();
  t.after(() => cleanup(ctx));

  // Manually tick "cleared" with no linked transaction at all (the
  // periods.js PATCH line-items path), exactly like ticking the checkbox by
  // hand.
  await q(
    'UPDATE line_items SET cleared = TRUE, cleared_date = $1 WHERE pay_period_id = $2 AND category_template_id = $3',
    [todayISO(), ctx.periodId, ctx.categoryId]
  );

  const { rows } = await q(
    'SELECT cleared_amount_cents, planned_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [ctx.periodId, ctx.categoryId]
  );
  assert.equal(rows[0].cleared_amount_cents, null);

  const balances = await accountBalances(ctx.budgetId);
  const acct = balances.find((b) => b.id === ctx.accountId);
  // starting balance (0, default) minus the planned amount (no actual on
  // record, so the balance math must fall back to planned_amount_cents).
  assert.equal(acct.balance_cents, -ctx.PLANNED);
});

// ---------------------------------------------------------------------
// simplefin.js's processTxn "existing/changed" (restatement) branch.
// Before this fix, a bank re-fetch that corrected an already-categorized,
// already-cleared transaction's amount (or posted date) updated
// `transactions.amount_cents` in place without touching the recurring
// template's `cleared_amount_cents` — leaving a stale actual once the
// balance math started reading that column instead of `planned_amount_cents`
// unconditionally.
// ---------------------------------------------------------------------

async function seedSyncBudget() {
  const email = `sync-actuals-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
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
    [categoryId, 25000, startedOn]
  );

  await ensureMaterialized(budgetId);
  const { rows: periods } = await q(
    'SELECT id, start_date, end_date FROM pay_periods WHERE account_id = $1 ORDER BY start_date',
    [accountId]
  );
  assert.ok(periods.length >= 2, 'seedSyncBudget needs at least two materialized periods for the period-move case');

  // periodContaining(anchor=today, startedOn) can (and here, does) start
  // BEFORE startedOn itself - that's the exact bug the tracking-floor fix
  // (docs/plans/simplefin-tracking-floor.md) targets. This suite's
  // restatement/closed-period scenarios are unrelated to that floor and
  // deliberately use dates at each period's own start, so back-date
  // started_on to the earliest materialized period's start here - the
  // dedicated floor tests below seed their own account with the exact
  // started_on/period misalignment instead.
  await q('UPDATE accounts SET started_on = $1 WHERE id = $2', [periods[0].start_date, accountId]);

  const { rows: tRows } = await q('SELECT * FROM category_templates WHERE id = $1', [categoryId]);
  const template = tRows[0];

  // A connection + account link, as syncBudget would set up, so `link` and
  // `ctx` look like the real thing processTxn is called with.
  const { rows: conn } = await q(
    "INSERT INTO simplefin_connections (budget_id, access_url, label) VALUES ($1, 'enc:test', 'Test Bank') RETURNING id",
    [budgetId]
  );
  const { rows: link } = await q(
    `INSERT INTO simplefin_account_links (connection_id, sf_account_id, sf_name, account_id)
     VALUES ($1, 'sf-acct-1', 'Checking', $2) RETURNING *`,
    [conn[0].id, accountId]
  );

  const { rows: accountRows } = await q('SELECT * FROM accounts WHERE id = $1', [accountId]);
  const ctx = {
    budget: { id: budgetId },
    templatesById: new Map([[categoryId, template]]),
    accountsById: new Map([[accountId, accountRows[0]]]),
  };

  return { userId, budgetId, accountId, categoryId, template, periods, ctx, link: link[0] };
}

function sfTxn(id, amountDollars, postedDate) {
  return {
    id,
    amount: amountDollars,
    description: 'Electric Co',
    posted: Math.floor(new Date(`${postedDate}T12:00:00Z`).getTime() / 1000),
  };
}

test('processTxn restatement: a re-fetched amount change updates cleared_amount_cents and the balance follows it', async (t) => {
  const ctx = await seedSyncBudget();
  t.after(() => cleanup(ctx));

  const period = ctx.periods[ctx.periods.length - 1]; // current period
  const sfId = 'txn-restated-amount';
  const importHash = `simplefin:${ctx.link.sf_account_id}:${sfId}`;

  // First sync: transaction posts at -100.00, categorized to the recurring
  // template, clearing its line item — exactly like insertSyncedTxn would
  // have left things.
  await q(
    `INSERT INTO transactions (budget_id, pay_period_id, type, amount_cents, description, date, account_id, category_template_id, categorized_by, import_hash)
     VALUES ($1, $2, 'expense', 10000, 'Electric Co', $3, $4, $5, 'rule', $6)`,
    [ctx.budgetId, period.id, period.start_date, ctx.accountId, ctx.categoryId, importHash]
  );
  await clearLineItemForTransaction({ query: q }, ctx.template, {
    periodId: period.id, date: period.start_date, amountCents: 10000, accountId: ctx.accountId, updatePlanned: true,
  });

  const before = await q(
    'SELECT cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [period.id, ctx.categoryId]
  );
  assert.equal(before.rows[0].cleared_amount_cents, 10000);

  // Bank re-fetch: the SAME transaction id, restated to -114.07 (a common
  // pending -> posted correction), same date/period.
  const results = { updated: 0 };
  await processTxn(
    { query: q }, ctx.ctx, ctx.link, sfTxn(sfId, '-114.07', period.start_date), ctx.userId, results
  );
  assert.equal(results.updated, 1);

  const after = await q(
    'SELECT amount_cents, cleared_amount_cents FROM line_items li JOIN transactions t ON t.pay_period_id = li.pay_period_id AND t.category_template_id = li.category_template_id WHERE li.pay_period_id = $1 AND li.category_template_id = $2',
    [period.id, ctx.categoryId]
  );
  assert.equal(after.rows[0].amount_cents, 11407, 'the transaction row itself must carry the restated amount');
  assert.equal(after.rows[0].cleared_amount_cents, 11407, 'cleared_amount_cents must follow the restated amount, not stay stale at 10000');

  const balances = await accountBalances(ctx.budgetId);
  const acct = balances.find((b) => b.id === ctx.accountId);
  assert.equal(acct.balance_cents, -11407, 'the account balance must reflect the restated actual, not the stale one');
});

test('processTxn restatement: a re-fetched date crossing into a different period recomputes BOTH periods\' line items', async (t) => {
  const ctx = await seedSyncBudget();
  t.after(() => cleanup(ctx));

  const oldPeriod = ctx.periods[0];
  const newPeriod = ctx.periods[1];
  assert.notEqual(oldPeriod.id, newPeriod.id);

  const sfId = 'txn-restated-period';
  const importHash = `simplefin:${ctx.link.sf_account_id}:${sfId}`;

  await q(
    `INSERT INTO transactions (budget_id, pay_period_id, type, amount_cents, description, date, account_id, category_template_id, categorized_by, import_hash)
     VALUES ($1, $2, 'expense', 10000, 'Electric Co', $3, $4, $5, 'rule', $6)`,
    [ctx.budgetId, oldPeriod.id, oldPeriod.start_date, ctx.accountId, ctx.categoryId, importHash]
  );
  await clearLineItemForTransaction({ query: q }, ctx.template, {
    periodId: oldPeriod.id, date: oldPeriod.start_date, amountCents: 10000, accountId: ctx.accountId, updatePlanned: true,
  });

  const oldBefore = await q(
    'SELECT cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [oldPeriod.id, ctx.categoryId]
  );
  assert.equal(oldBefore.rows[0].cleared_amount_cents, 10000);

  // Bank re-fetch: same transaction id, restated amount AND a corrected
  // posted date that now falls in the next period.
  const results = { updated: 0 };
  await processTxn(
    { query: q }, ctx.ctx, ctx.link, sfTxn(sfId, '-98.65', newPeriod.start_date), ctx.userId, results
  );
  assert.equal(results.updated, 1);

  const oldAfter = await q(
    'SELECT cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [oldPeriod.id, ctx.categoryId]
  );
  assert.equal(oldAfter.rows[0].cleared_amount_cents, null,
    'the OLD period\'s line item lost its only transaction and must fall back to NULL, not stay stale at 10000');

  const newAfter = await q(
    'SELECT li.cleared_amount_cents FROM line_items li WHERE li.pay_period_id = $1 AND li.category_template_id = $2',
    [newPeriod.id, ctx.categoryId]
  );
  assert.equal(newAfter.rows[0]?.cleared_amount_cents, 9865, 'the NEW period must pick up the restated actual');
});

// ---------------------------------------------------------------------
// Closed-period guard for processTxn's restatement branch (security-checker
// finding, upheld): a re-fetched transaction must never mutate anything -
// amount_cents, date, pay_period_id, or a line item's cleared_amount_cents -
// belonging to a CLOSED period, in either direction of a period move.
// ---------------------------------------------------------------------

async function closePeriod(periodId, snapshot = { total: 999999 }) {
  await q('UPDATE pay_periods SET closed_at = now(), closed_snapshot = $1 WHERE id = $2', [JSON.stringify(snapshot), periodId]);
}

test('processTxn restatement: a transaction inside a CLOSED period is declined - nothing mutates', async (t) => {
  const ctx = await seedSyncBudget();
  t.after(() => cleanup(ctx));

  const period = ctx.periods[0];
  const sfId = 'txn-closed-same-period';
  const importHash = `simplefin:${ctx.link.sf_account_id}:${sfId}`;

  await q(
    `INSERT INTO transactions (budget_id, pay_period_id, type, amount_cents, description, date, account_id, category_template_id, categorized_by, import_hash)
     VALUES ($1, $2, 'expense', 25000, 'Electric Co', $3, $4, $5, 'rule', $6)`,
    [ctx.budgetId, period.id, period.start_date, ctx.accountId, ctx.categoryId, importHash]
  );
  await clearLineItemForTransaction({ query: q }, ctx.template, {
    periodId: period.id, date: period.start_date, amountCents: 25000, accountId: ctx.accountId, updatePlanned: true,
  });
  const snapshot = { cleared_amount_cents: 25000 };
  await closePeriod(period.id, snapshot);

  const results = { updated: 0, declinedClosed: 0 };
  await processTxn(
    { query: q }, ctx.ctx, ctx.link, sfTxn(sfId, '-310.00', period.start_date), ctx.userId, results
  );

  assert.equal(results.updated, 0, 'must not report an update');
  assert.equal(results.declinedClosed, 1, 'must count the decline');

  const txn = await q('SELECT amount_cents, date, pay_period_id FROM transactions WHERE import_hash = $1', [importHash]);
  assert.equal(txn.rows[0].amount_cents, 25000, 'transaction amount must be untouched');
  assert.equal(txn.rows[0].pay_period_id, period.id, 'transaction period must be untouched');

  const li = await q(
    'SELECT cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [period.id, ctx.categoryId]
  );
  assert.equal(li.rows[0].cleared_amount_cents, 25000, 'the line item\'s actual must be untouched');

  const pp = await q('SELECT closed_snapshot FROM pay_periods WHERE id = $1', [period.id]);
  assert.deepEqual(pp.rows[0].closed_snapshot, snapshot, 'closed_snapshot must be byte-identical - never touched by a decline');
});

test('processTxn restatement: a move FROM a closed period INTO an open one is blocked', async (t) => {
  const ctx = await seedSyncBudget();
  t.after(() => cleanup(ctx));

  const closedPeriod = ctx.periods[0];
  const openPeriod = ctx.periods[1];
  const sfId = 'txn-move-from-closed';
  const importHash = `simplefin:${ctx.link.sf_account_id}:${sfId}`;

  await q(
    `INSERT INTO transactions (budget_id, pay_period_id, type, amount_cents, description, date, account_id, category_template_id, categorized_by, import_hash)
     VALUES ($1, $2, 'expense', 25000, 'Electric Co', $3, $4, $5, 'rule', $6)`,
    [ctx.budgetId, closedPeriod.id, closedPeriod.start_date, ctx.accountId, ctx.categoryId, importHash]
  );
  await clearLineItemForTransaction({ query: q }, ctx.template, {
    periodId: closedPeriod.id, date: closedPeriod.start_date, amountCents: 25000, accountId: ctx.accountId, updatePlanned: true,
  });
  const snapshot = { cleared_amount_cents: 25000 };
  await closePeriod(closedPeriod.id, snapshot);

  const results = { updated: 0, declinedClosed: 0 };
  // Re-fetched with a corrected date that now falls in the (open) next period.
  await processTxn(
    { query: q }, ctx.ctx, ctx.link, sfTxn(sfId, '-310.00', openPeriod.start_date), ctx.userId, results
  );

  assert.equal(results.updated, 0);
  assert.equal(results.declinedClosed, 1);

  const txn = await q('SELECT amount_cents, date, pay_period_id FROM transactions WHERE import_hash = $1', [importHash]);
  assert.equal(txn.rows[0].amount_cents, 25000, 'must not have moved amount');
  assert.equal(txn.rows[0].pay_period_id, closedPeriod.id, 'must not have moved period - still in the closed one');

  const openLi = await q(
    'SELECT cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [openPeriod.id, ctx.categoryId]
  );
  assert.equal(openLi.rows[0]?.cleared_amount_cents ?? null, null, 'the destination open period must not pick up a phantom actual');

  const pp = await q('SELECT closed_snapshot FROM pay_periods WHERE id = $1', [closedPeriod.id]);
  assert.deepEqual(pp.rows[0].closed_snapshot, snapshot);
});

test('processTxn restatement: a move FROM an open period INTO a closed one is blocked', async (t) => {
  const ctx = await seedSyncBudget();
  t.after(() => cleanup(ctx));

  const closedPeriod = ctx.periods[0];
  const openPeriod = ctx.periods[1];
  const sfId = 'txn-move-into-closed';
  const importHash = `simplefin:${ctx.link.sf_account_id}:${sfId}`;

  // Close the destination period FIRST (with no transaction of its own),
  // then seed and clear the transaction in the still-open source period.
  const snapshot = { cleared_amount_cents: null };
  await closePeriod(closedPeriod.id, snapshot);

  await q(
    `INSERT INTO transactions (budget_id, pay_period_id, type, amount_cents, description, date, account_id, category_template_id, categorized_by, import_hash)
     VALUES ($1, $2, 'expense', 25000, 'Electric Co', $3, $4, $5, 'rule', $6)`,
    [ctx.budgetId, openPeriod.id, openPeriod.start_date, ctx.accountId, ctx.categoryId, importHash]
  );
  await clearLineItemForTransaction({ query: q }, ctx.template, {
    periodId: openPeriod.id, date: openPeriod.start_date, amountCents: 25000, accountId: ctx.accountId, updatePlanned: true,
  });

  const results = { updated: 0, declinedClosed: 0 };
  // Re-fetched with a corrected date that now falls back in the closed period.
  await processTxn(
    { query: q }, ctx.ctx, ctx.link, sfTxn(sfId, '-310.00', closedPeriod.start_date), ctx.userId, results
  );

  assert.equal(results.updated, 0);
  assert.equal(results.declinedClosed, 1);

  const txn = await q('SELECT amount_cents, date, pay_period_id FROM transactions WHERE import_hash = $1', [importHash]);
  assert.equal(txn.rows[0].amount_cents, 25000, 'must not have moved amount');
  assert.equal(txn.rows[0].pay_period_id, openPeriod.id, 'must not have moved period - still in the open one');

  const openLi = await q(
    'SELECT cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [openPeriod.id, ctx.categoryId]
  );
  assert.equal(openLi.rows[0].cleared_amount_cents, 25000, 'the source open period\'s actual must be untouched');

  const pp = await q('SELECT closed_snapshot FROM pay_periods WHERE id = $1', [closedPeriod.id]);
  assert.deepEqual(pp.rows[0].closed_snapshot, snapshot, 'the closed destination must gain no transaction and no snapshot change');
});

// Regression guard: the closed-period check above must not over-block a
// legitimate restatement of a transaction that is (and stays) in an OPEN
// period - already covered end-to-end by the "amount change" test above,
// which asserts results.updated === 1 and the new amount lands. Restated
// here explicitly so the intent isn't lost among the closed-period cases.
test('processTxn restatement: an OPEN-period restatement is not blocked by the closed-period guard', async (t) => {
  const ctx = await seedSyncBudget();
  t.after(() => cleanup(ctx));

  const period = ctx.periods[ctx.periods.length - 1]; // current, open
  const sfId = 'txn-open-not-blocked';
  const importHash = `simplefin:${ctx.link.sf_account_id}:${sfId}`;

  await q(
    `INSERT INTO transactions (budget_id, pay_period_id, type, amount_cents, description, date, account_id, category_template_id, categorized_by, import_hash)
     VALUES ($1, $2, 'expense', 10000, 'Electric Co', $3, $4, $5, 'rule', $6)`,
    [ctx.budgetId, period.id, period.start_date, ctx.accountId, ctx.categoryId, importHash]
  );
  await clearLineItemForTransaction({ query: q }, ctx.template, {
    periodId: period.id, date: period.start_date, amountCents: 10000, accountId: ctx.accountId, updatePlanned: true,
  });

  const results = { updated: 0, declinedClosed: 0 };
  await processTxn(
    { query: q }, ctx.ctx, ctx.link, sfTxn(sfId, '-114.07', period.start_date), ctx.userId, results
  );

  assert.equal(results.declinedClosed, 0, 'an open-period restatement must not be counted as declined');
  assert.equal(results.updated, 1, 'an open-period restatement must still be applied');

  const txn = await q('SELECT amount_cents FROM transactions WHERE import_hash = $1', [importHash]);
  assert.equal(txn.rows[0].amount_cents, 11407);

  const li = await q(
    'SELECT cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [period.id, ctx.categoryId]
  );
  assert.equal(li.rows[0].cleared_amount_cents, 11407);
});

// ---------------------------------------------------------------------
// Tracking-from floor (docs/plans/simplefin-tracking-floor.md): processTxn
// must drop any synced transaction dated strictly before the mapped
// account's started_on, even though it falls inside the first pay period's
// window (that window is anchored on periodContaining(started_on) and can
// start earlier than started_on itself - see budget.js). Uses a real
// `SELECT * FROM accounts` row for ctx.accountsById so the comparison is
// exercised against started_on in whatever form Postgres actually returns
// it as, not an assumed shape.
// ---------------------------------------------------------------------

async function seedFloorBudget(startedOn) {
  const email = `floor-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { rows: user } = await q(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [email]
  );
  const userId = user[0].id;
  const budget = await createSoloBudget(userId);
  const budgetId = budget.id;

  const accountId = await getDefaultAccountId(budgetId);
  await q('UPDATE accounts SET started_on = $1 WHERE id = $2', [startedOn, accountId]);
  // Anchor the cadence well before started_on. ensureMaterialized's
  // first-period logic (budget.js) is `periodContaining(cfg,
  // started_on)` - the period CONTAINING started_on, aligned to the
  // cadence's own anchor_date - so with a 100-day-earlier anchor this
  // first materialized period starts a couple of days BEFORE started_on
  // itself. That gap (here, 2026-06-01/-02 for started_on=2026-06-03) is
  // exactly the leaky window this floor exists to close.
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'biweekly', $3)",
    [budgetId, accountId, addDays(startedOn, -100)]
  );
  await ensureMaterialized(budgetId);

  const { rows: conn } = await q(
    "INSERT INTO simplefin_connections (budget_id, access_url, label) VALUES ($1, 'enc:test', 'Test Bank') RETURNING id",
    [budgetId]
  );
  const { rows: link } = await q(
    `INSERT INTO simplefin_account_links (connection_id, sf_account_id, sf_name, account_id)
     VALUES ($1, 'sf-acct-floor', 'Checking', $2) RETURNING *`,
    [conn[0].id, accountId]
  );

  // Real `SELECT *` row, exactly as syncBudget builds ctx.accountsById -
  // proves the comparison against whatever form Postgres actually returns
  // started_on as (see the assertion below).
  const { rows: accountRows } = await q('SELECT * FROM accounts WHERE id = $1', [accountId]);
  const accountRow = accountRows[0];

  const ctx = {
    budget: { id: budgetId },
    templatesById: new Map(),
    accountsById: new Map([[accountId, accountRow]]),
    rules: [],
  };

  return { userId, budgetId, accountId, ctx, link: link[0], accountRow };
}

test('processTxn: started_on comes back from a real SELECT * as a plain YYYY-MM-DD string', async (t) => {
  const ctx = await seedFloorBudget('2026-06-03');
  t.after(() => cleanup(ctx));

  // This is the whole subtlety the fix depends on: this project sets a
  // global DATE type-parser override (server/db.js, OID 1082 -> identity),
  // so DATE columns come back as plain strings everywhere, including
  // `SELECT *` here - NOT as JS Date objects. If this ever regresses (the
  // override is removed, or a differently-configured pool is used), the
  // string comparison in processTxn would silently misbehave.
  assert.equal(typeof ctx.accountRow.started_on, 'string');
  assert.equal(ctx.accountRow.started_on, '2026-06-03');
});

test('processTxn: a transaction dated before started_on is dropped and counted skipped', async (t) => {
  const ctx = await seedFloorBudget('2026-06-03');
  t.after(() => cleanup(ctx));

  // '2026-06-02' is the actual leaky window this fix targets: with
  // started_on='2026-06-03' and the cadence anchored 100 days earlier, the
  // first MATERIALIZED pay period is periodContaining(started_on), which
  // here runs 2026-06-01 -> 2026-06-14 - i.e. it starts two days before
  // started_on. Pre-fix, a transaction dated 2026-06-01 or -02 would have
  // been inserted anyway because it falls inside that period's window.
  const results = { skipped: 0, added: 0 };
  await processTxn(
    { query: q }, ctx.ctx, ctx.link, sfTxn('txn-before-floor', '-42.00', '2026-06-02'), ctx.userId, results
  );

  assert.equal(results.skipped, 1, 'must be counted as skipped');
  assert.equal(results.added, 0, 'must not be inserted');
  const rows = await q('SELECT id FROM transactions WHERE budget_id = $1', [ctx.budgetId]);
  assert.equal(rows.rows.length, 0, 'no transaction row must land');
});

test('processTxn: a transaction dated exactly on started_on IS inserted (floor is strictly-before)', async (t) => {
  const ctx = await seedFloorBudget('2026-06-03');
  t.after(() => cleanup(ctx));

  const results = { skipped: 0, added: 0 };
  await processTxn(
    { query: q }, ctx.ctx, ctx.link, sfTxn('txn-on-floor', '-42.00', '2026-06-03'), ctx.userId, results
  );

  assert.equal(results.skipped, 0);
  assert.equal(results.added, 1);
  const rows = await q('SELECT date FROM transactions WHERE budget_id = $1', [ctx.budgetId]);
  assert.equal(rows.rows[0].date, '2026-06-03');
});

test('processTxn: a transaction dated after started_on IS inserted', async (t) => {
  const ctx = await seedFloorBudget('2026-06-03');
  t.after(() => cleanup(ctx));

  const results = { skipped: 0, added: 0 };
  await processTxn(
    { query: q }, ctx.ctx, ctx.link, sfTxn('txn-after-floor', '-42.00', '2026-06-05'), ctx.userId, results
  );

  assert.equal(results.skipped, 0);
  assert.equal(results.added, 1);
});

test('processTxn: a null started_on applies no floor - a pre-tracking-date within the first period still imports', async (t) => {
  const ctx = await seedFloorBudget('2026-06-03');
  t.after(() => cleanup(ctx));

  await q('UPDATE accounts SET started_on = NULL WHERE id = $1', [ctx.accountId]);
  // Refresh ctx.accountsById with the now-null row, exactly as syncBudget
  // would re-read it on its next sync. The pay period materialized above
  // (2026-06-01 -> 2026-06-14, back-dated to started_on before it was
  // nulled out) still exists - nulling started_on afterward does not
  // retroactively remove it, so the same 2026-06-02 date used in the
  // "before started_on" test above still has a period to land in here.
  const { rows: accountRows } = await q('SELECT * FROM accounts WHERE id = $1', [ctx.accountId]);
  ctx.ctx.accountsById.set(ctx.accountId, accountRows[0]);
  assert.equal(accountRows[0].started_on, null);

  const results = { skipped: 0, added: 0 };
  await processTxn(
    { query: q }, ctx.ctx, ctx.link, sfTxn('txn-no-floor', '-42.00', '2026-06-02'), ctx.userId, results
  );

  assert.equal(results.skipped, 0, 'no floor means this must not be skipped by the floor guard');
  assert.equal(results.added, 1);
});

test.after(() => pool.end());
