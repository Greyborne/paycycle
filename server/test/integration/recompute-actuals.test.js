// Integration tests for docs/plans/recompute-actuals.md: the two mutation
// paths that were leaving line_items.cleared_amount_cents orphaned (deleting
// a transaction, unchecking "cleared"), and the new POST /periods/recalculate
// repair endpoint's underlying recalculateOpenPeriodActuals (server/services/
// budget.js). Modeled on line-item-actuals.test.js: seeds an isolated budget
// per test and deletes it afterwards (every budget-scoped table cascades
// from budgets), so runs never collide and leave no residue.
//
// Requires a real Postgres reachable via DATABASE_URL with the schema already
// migrated. Not part of the default `npm test` unit run - use
// `npm run test:integration` (or the ephemeral-DB wrapper).

import './_env-guard.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, q } from '../../db.js';
import {
  createSoloBudget, ensureMaterialized, getDefaultAccountId, clearLineItemForTransaction,
  recomputeLineItemActual, recalculateOpenPeriodActuals,
} from '../../services/budget.js';
import { todayISO, addDays } from '../../services/schedule.js';

async function seedBudget() {
  const email = `recompute-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
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

// Mirrors exactly what transactions.js's DELETE /:id handler does (BEGIN;
// DELETE; recomputeLineItemActual if category_template_id was set; COMMIT) so
// this test exercises the real logic, not a paraphrase of it.
async function deleteTransactionLikeRoute(txnId) {
  const { rows } = await q(
    'SELECT pay_period_id, category_template_id FROM transactions WHERE id = $1', [txnId]
  );
  const txn = rows[0];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM transactions WHERE id = $1', [txnId]);
    if (txn.category_template_id && txn.pay_period_id) {
      await recomputeLineItemActual(client, txn.pay_period_id, txn.category_template_id);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

test('deleting a transaction that cleared a recurring line item drops cleared_amount_cents to the new sum', async (t) => {
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

  const before = await q(
    'SELECT cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [ctx.periodId, ctx.categoryId]
  );
  assert.equal(before.rows[0].cleared_amount_cents, 15000);

  await deleteTransactionLikeRoute(id1);

  const after = await q(
    'SELECT cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [ctx.periodId, ctx.categoryId]
  );
  assert.equal(after.rows[0].cleared_amount_cents, 5000, 'must drop to the sum of the one remaining transaction');
});

test('deleting the ONLY transaction that cleared a line item sets cleared_amount_cents to null', async (t) => {
  const ctx = await seedBudget();
  t.after(() => cleanup(ctx));

  const id1 = await insertTxn(ctx, 10000);
  await clearLineItemForTransaction({ query: q }, ctx.template, {
    periodId: ctx.periodId, date: todayISO(), amountCents: 10000, accountId: ctx.accountId,
  });

  await deleteTransactionLikeRoute(id1);

  const after = await q(
    'SELECT cleared_amount_cents, cleared FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [ctx.periodId, ctx.categoryId]
  );
  assert.equal(after.rows[0].cleared_amount_cents, null, 'zero remaining transactions must leave the column NULL, never 0');
  assert.equal(after.rows[0].cleared, true, 'the cleared bool is a separate manual/auto flag and must not be touched by delete');
});

test('unchecking cleared on a line item whose transactions are gone sets cleared_amount_cents to null', async (t) => {
  const ctx = await seedBudget();
  t.after(() => cleanup(ctx));

  const id1 = await insertTxn(ctx, 10000);
  await clearLineItemForTransaction({ query: q }, ctx.template, {
    periodId: ctx.periodId, date: todayISO(), amountCents: 10000, accountId: ctx.accountId,
  });
  // The transaction is gone (e.g. re-import wiped it) but the line item's
  // cleared flag and stale actual are still sitting there - exactly the
  // orphan this fix targets - until the user unchecks "cleared" by hand.
  await q('DELETE FROM transactions WHERE id = $1', [id1]);

  const stale = await q(
    'SELECT cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [ctx.periodId, ctx.categoryId]
  );
  assert.equal(stale.rows[0].cleared_amount_cents, 10000, 'sanity: the orphan exists before the fix runs');

  // Mirrors periods.js's PATCH /line-items/:id non-forward path: update
  // cleared/cleared_date, then recompute the actual from what's left.
  const { rows: li } = await q(
    'SELECT id FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [ctx.periodId, ctx.categoryId]
  );
  await q('UPDATE line_items SET cleared = FALSE, cleared_date = NULL WHERE id = $1', [li[0].id]);
  await recomputeLineItemActual({ query: q }, ctx.periodId, ctx.categoryId);

  const after = await q(
    'SELECT cleared, cleared_amount_cents FROM line_items WHERE id = $1', [li[0].id]
  );
  assert.equal(after.rows[0].cleared, false);
  assert.equal(after.rows[0].cleared_amount_cents, null, 'must show "—", not the stale 10000');
});

test('recalculate: an orphaned cleared_amount_cents in an OPEN period is corrected to null; a legit actual is unchanged; a CLOSED period is untouched', async (t) => {
  const ctx = await seedBudget();
  t.after(() => cleanup(ctx));

  // A second, LEGIT recurring category in the same period, with a real
  // transaction backing its cleared_amount_cents - must survive untouched.
  const { rows: cat2 } = await q(
    `INSERT INTO category_templates (budget_id, account_id, name, type, recurrence, category_type, sort_order)
     VALUES ($1, $2, 'Water', 'expense', 'every_period', 'recurring', 1) RETURNING id`,
    [ctx.budgetId, ctx.accountId]
  );
  const categoryId2 = cat2[0].id;
  await q(
    'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, $2, $3)',
    [categoryId2, 4000, addDays(todayISO(), -30)]
  );
  await ensureMaterialized(ctx.budgetId);
  const { rows: tRows2 } = await q('SELECT * FROM category_templates WHERE id = $1', [categoryId2]);
  await insertTxn(ctx, 3900, todayISO(), categoryId2);
  await clearLineItemForTransaction({ query: q }, tRows2[0], {
    periodId: ctx.periodId, date: todayISO(), amountCents: 3900, accountId: ctx.accountId,
  });

  // Orphan the FIRST category's line item: a cleared_amount_cents value
  // present with zero matching transactions (simulating the bug directly,
  // bypassing the two now-fixed mutation paths).
  await q(
    'UPDATE line_items SET cleared = TRUE, cleared_amount_cents = 25000, cleared_date = $1 WHERE pay_period_id = $2 AND category_template_id = $3',
    [todayISO(), ctx.periodId, ctx.categoryId]
  );

  // A CLOSED period with its own orphaned value - must be untouched by
  // recalculate no matter what.
  const { rows: closedPeriod } = await q(
    `INSERT INTO pay_periods (budget_id, account_id, start_date, end_date, closed_at, closed_snapshot)
     VALUES ($1, $2, $3, $4, now(), '{"total": 111}') RETURNING id`,
    [ctx.budgetId, ctx.accountId, addDays(todayISO(), -60), addDays(todayISO(), -46)]
  );
  await q(
    `INSERT INTO line_items (pay_period_id, category_template_id, planned_amount_cents, account_id, cleared, cleared_amount_cents)
     VALUES ($1, $2, $3, $4, TRUE, $5)`,
    [closedPeriod[0].id, ctx.categoryId, ctx.PLANNED, ctx.accountId, 99999]
  );

  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    result = await recalculateOpenPeriodActuals(client, ctx.budgetId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const orphanAfter = await q(
    'SELECT cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [ctx.periodId, ctx.categoryId]
  );
  assert.equal(orphanAfter.rows[0].cleared_amount_cents, null, 'the orphan must be corrected to null (0 matching transactions)');

  const legitAfter = await q(
    'SELECT cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [ctx.periodId, categoryId2]
  );
  assert.equal(legitAfter.rows[0].cleared_amount_cents, 3900, 'a legit actual backed by a real transaction must be unchanged');

  const closedAfter = await q(
    'SELECT cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [closedPeriod[0].id, ctx.categoryId]
  );
  assert.equal(closedAfter.rows[0].cleared_amount_cents, 99999, 'a CLOSED period line item must be completely untouched');

  assert.equal(result.corrected, 1, 'exactly one line item (the orphan) should have actually changed value');
  assert.ok(result.recalculated >= 2, 'recalculated must count every open-period line item visited, not just the corrected one');
});

test('recalculate only touches the calling budget - a second budget\'s orphan and legit actuals are both untouched', async (t) => {
  const ctx = await seedBudget();
  const other = await seedBudget();
  t.after(() => cleanup(ctx));
  t.after(() => cleanup(other));

  // Orphan in ctx's budget.
  await q(
    'UPDATE line_items SET cleared = TRUE, cleared_amount_cents = 25000, cleared_date = $1 WHERE pay_period_id = $2 AND category_template_id = $3',
    [todayISO(), ctx.periodId, ctx.categoryId]
  );
  // An identical orphan in the OTHER budget - must survive recalculating ctx.
  await q(
    'UPDATE line_items SET cleared = TRUE, cleared_amount_cents = 77777, cleared_date = $1 WHERE pay_period_id = $2 AND category_template_id = $3',
    [todayISO(), other.periodId, other.categoryId]
  );

  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    result = await recalculateOpenPeriodActuals(client, ctx.budgetId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const ctxAfter = await q(
    'SELECT cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [ctx.periodId, ctx.categoryId]
  );
  assert.equal(ctxAfter.rows[0].cleared_amount_cents, null, 'the calling budget\'s orphan must be corrected');

  const otherAfter = await q(
    'SELECT cleared_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [other.periodId, other.categoryId]
  );
  assert.equal(otherAfter.rows[0].cleared_amount_cents, 77777, 'a different budget\'s line item must be completely untouched (IDOR-safe)');

  assert.equal(result.corrected, 1);
});

test.after(() => pool.end());
