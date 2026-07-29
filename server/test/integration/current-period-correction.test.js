// Integration tests for PUT /settings/schedule/:accountId/current-period
// (server/routes/settings.js) - the one-off correction of the CURRENT
// (open, not-yet-closed) period's own start/end date, for a fat-fingered
// anchor day. Distinct from PUT /settings/schedule/:accountId, which edits
// pay_period_configs and never touches a real pay_periods row.
//
// Exercises the real route handler by mounting settings.js's router on a
// minimal express app with a stub auth middleware, mirroring
// account-delete.test.js's pattern.
//
// Requires a real Postgres reachable via DATABASE_URL with the schema
// already migrated. Not part of the default `npm test` unit run - use
// `npm run test:integration` (or the ephemeral-DB wrapper,
// `npm run test:integration:ephemeral`).
//
// Each test seeds its own isolated budget and deletes it afterwards (every
// budget-scoped table cascades from budgets), so runs never collide and
// leave no residue.

import './_env-guard.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { pool, q } from '../../db.js';
import { HttpError } from '../../validation.js';
import { createSoloBudget, ensureMaterialized, getDefaultAccountId, recalculateOpenPeriodActuals } from '../../services/budget.js';
import { addDays, todayISO } from '../../services/schedule.js';
import settingsRoutes from '../../routes/settings.js';

async function startTestServer(budget, userId) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.budget = budget;
    req.userId = userId;
    next();
  });
  app.use('/settings', settingsRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err.message || 'Internal server error' });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function correctCurrentPeriod(server, accountId, startDate) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/settings/schedule/${accountId}/current-period`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// Seeds a fresh solo budget with a biweekly default account whose tracking
// starts `daysAgo` days ago, materializes it, then marks every period except
// the last (most recent) one closed - a realistic "sequential close" history
// with one open current period and a real, closed previous period.
async function seedWithHistory({ daysAgo }) {
  const email = `cur-period-fix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { rows: user } = await q(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [email]
  );
  const userId = user[0].id;
  const budget = await createSoloBudget(userId);
  const budgetId = budget.id;
  const accountId = await getDefaultAccountId(budgetId);

  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'biweekly', $3)",
    [budgetId, accountId, todayISO()]
  );
  await q('UPDATE accounts SET started_on = $1 WHERE id = $2', [addDays(todayISO(), -daysAgo), accountId]);
  await ensureMaterialized(budgetId);

  const { rows: periods } = await q(
    'SELECT id, start_date, end_date FROM pay_periods WHERE account_id = $1 ORDER BY start_date',
    [accountId]
  );
  assert.ok(periods.length >= 2, 'expected at least two materialized periods for this test to be meaningful');
  const current = periods[periods.length - 1];
  const previous = periods[periods.length - 2];
  for (const p of periods.slice(0, -1)) {
    await q('UPDATE pay_periods SET closed_at = now(), closed_snapshot = $1 WHERE id = $2', [
      JSON.stringify({ total: 0 }), p.id,
    ]);
  }

  // A recurring category so line_items exist, plus one transaction on the
  // open period, so conservation checks have something nontrivial to check.
  const { rows: cat } = await q(
    `INSERT INTO category_templates (budget_id, name, type, recurrence, category_type, sort_order)
     VALUES ($1, 'Paycheck', 'income', 'every_period', 'recurring', 0) RETURNING id`,
    [budgetId]
  );
  await q(
    'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, 150000, $2)',
    [cat[0].id, addDays(todayISO(), -daysAgo)]
  );
  await ensureMaterialized(budgetId); // top up line items for the category just added
  await q(
    `INSERT INTO transactions (budget_id, pay_period_id, type, amount_cents, description, date, account_id, category_template_id, categorized_by)
     VALUES ($1, $2, 'income', 150000, 'Paycheck', $3, $4, $5, 'manual')`,
    [budgetId, current.id, current.start_date, accountId, cat[0].id]
  );
  // Real inserts always go through clearLineItemForTransaction/assignCategory,
  // which recompute cleared_amount_cents at insert time - this raw SQL insert
  // bypasses that, so recompute it explicitly here to give the "before"
  // snapshot below a realistic (not stale-NULL) starting state.
  await recalculateOpenPeriodActuals({ query: q }, budgetId);

  return { budgetId, userId, budget, accountId, current, previous, categoryId: cat[0].id };
}

async function snapshot(budgetId) {
  const { rows: periods } = await q(
    'SELECT COUNT(*)::int AS n FROM pay_periods WHERE budget_id = $1', [budgetId]
  );
  const { rows: items } = await q(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(li.planned_amount_cents), 0)::bigint AS planned_sum,
            COALESCE(SUM(li.cleared_amount_cents), 0)::bigint AS cleared_sum
     FROM line_items li JOIN pay_periods pp ON pp.id = li.pay_period_id WHERE pp.budget_id = $1`,
    [budgetId]
  );
  const { rows: txns } = await q(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_cents), 0)::bigint AS sum
     FROM transactions WHERE budget_id = $1`,
    [budgetId]
  );
  return {
    periodCount: periods[0].n,
    lineItemCount: items[0].n, plannedSum: Number(items[0].planned_sum), clearedSum: Number(items[0].cleared_sum),
    txnCount: txns[0].n, txnSum: Number(txns[0].sum),
  };
}

async function cleanup(ctx) {
  await q('DELETE FROM budgets WHERE id = $1', [ctx.budgetId]);
  await q('DELETE FROM users WHERE id = $1', [ctx.userId]);
}

test('PUT current-period: shifts the open period start in place, preserves conservation, and is idempotent', async (t) => {
  const ctx = await seedWithHistory({ daysAgo: 40 });
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const before = await snapshot(ctx.budgetId);
  const newStart = addDays(ctx.current.start_date, 1);

  const { status, body } = await correctCurrentPeriod(server, ctx.accountId, newStart);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.period.start, newStart);
  assert.equal(body.period.end, addDays(newStart, 13), 'biweekly: end must be start + 13 days');
  assert.equal(body.period.id, ctx.current.id, 'must update the SAME row in place, not create a new one');

  const { rows: rowsAfter } = await q('SELECT * FROM pay_periods WHERE id = $1', [ctx.current.id]);
  assert.equal(rowsAfter[0].start_date, newStart);
  assert.equal(rowsAfter[0].end_date, addDays(newStart, 13));

  const after = await snapshot(ctx.budgetId);
  assert.equal(after.periodCount, before.periodCount, 'no period row created or destroyed');
  assert.equal(after.lineItemCount, before.lineItemCount, 'no line item created or destroyed');
  assert.equal(after.plannedSum, before.plannedSum, 'planned cents conserved');
  assert.equal(after.clearedSum, before.clearedSum, 'cleared cents conserved');
  assert.equal(after.txnCount, before.txnCount, 'no transaction created or destroyed');
  assert.equal(after.txnSum, before.txnSum, 'transaction cents conserved');

  // The transaction dated on the OLD start (now the day before the new
  // start) stays attributed to this same period row - its pay_period_id FK
  // was never touched by the boundary UPDATE.
  const { rows: txnRow } = await q(
    'SELECT pay_period_id FROM transactions WHERE budget_id = $1 AND category_template_id = $2',
    [ctx.budgetId, ctx.categoryId]
  );
  assert.equal(txnRow[0].pay_period_id, ctx.current.id, 'existing transaction stays attributed to the corrected row');

  // Idempotency (same date): re-invoking with the identical, already-applied
  // startDate is a safe no-op - no duplicate row, no double shift.
  const { status: status2, body: body2 } = await correctCurrentPeriod(server, ctx.accountId, newStart);
  assert.equal(status2, 200, JSON.stringify(body2));
  assert.equal(body2.period.start, newStart);
  const afterRepeat = await snapshot(ctx.budgetId);
  assert.deepEqual(afterRepeat, after, 'repeating the same correction must not change anything');

  // Idempotency (different date): a second, further correction succeeds
  // cleanly and shifts the SAME row again, not a new one.
  const newerStart = addDays(newStart, 1);
  const { status: status3, body: body3 } = await correctCurrentPeriod(server, ctx.accountId, newerStart);
  assert.equal(status3, 200, JSON.stringify(body3));
  assert.equal(body3.period.id, ctx.current.id);
  assert.equal(body3.period.start, newerStart);
  assert.equal(body3.period.end, addDays(newerStart, 13));
  const finalCount = await snapshot(ctx.budgetId);
  assert.equal(finalCount.periodCount, before.periodCount, 'a second distinct correction still must not create a new row');
});

test('PUT current-period: rejects a startDate colliding with an existing (account, start_date) row', async (t) => {
  const ctx = await seedWithHistory({ daysAgo: 40 });
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const { status, body } = await correctCurrentPeriod(server, ctx.accountId, ctx.previous.start_date);
  assert.equal(status, 400, JSON.stringify(body));
  assert.match(body.error, /already starts on that date/i);

  // Nothing was changed by the rejected attempt.
  const { rows: rowsAfter } = await q('SELECT start_date, end_date FROM pay_periods WHERE id = $1', [ctx.current.id]);
  assert.equal(rowsAfter[0].start_date, ctx.current.start_date);
  assert.equal(rowsAfter[0].end_date, ctx.current.end_date);
});

test('PUT current-period: rejects a startDate that overlaps the immediately-previous real period', async (t) => {
  const ctx = await seedWithHistory({ daysAgo: 40 });
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  // One day inside the previous (closed) period's range, but not equal to
  // its own start_date - a distinct overlap case from the collision test.
  const overlapping = ctx.previous.end_date;
  const { status, body } = await correctCurrentPeriod(server, ctx.accountId, overlapping);
  assert.equal(status, 400, JSON.stringify(body));
  assert.match(body.error, /overlaps the previous pay period/i);

  const { rows: rowsAfter } = await q('SELECT start_date, end_date FROM pay_periods WHERE id = $1', [ctx.current.id]);
  assert.equal(rowsAfter[0].start_date, ctx.current.start_date, 'unchanged after rejected overlap attempt');
});

test('PUT current-period: rejects when there is no open current period to correct', async (t) => {
  const ctx = await seedWithHistory({ daysAgo: 40 });
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  // Close the one remaining open period directly, so no real row is "the
  // current period" any more - getLifecycle's own contract (closed_at IS
  // NULL required to be "current") means it now resolves to a future,
  // not-yet-materialized virtual period, which has no row to correct.
  await q('UPDATE pay_periods SET closed_at = now(), closed_snapshot = $1 WHERE id = $2', [
    JSON.stringify({ total: 0 }), ctx.current.id,
  ]);

  const { status, body } = await correctCurrentPeriod(server, ctx.accountId, addDays(ctx.current.start_date, 1));
  assert.equal(status, 400, JSON.stringify(body));
  assert.match(body.error, /not recorded yet|already closed/i);
});

test('PUT current-period: rejects an invalid startDate', async (t) => {
  const ctx = await seedWithHistory({ daysAgo: 40 });
  const server = await startTestServer(ctx.budget, ctx.userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await cleanup(ctx);
  });

  const { status, body } = await correctCurrentPeriod(server, ctx.accountId, 'not-a-date');
  assert.equal(status, 400, JSON.stringify(body));
});

test('PUT current-period: after a correction, ensureMaterialized walks forward from the corrected row\'s new end_date, never overlapping it', async (t) => {
  // A fresh account whose only materialized period is exactly [today-13,
  // today] (biweekly), so its end sits precisely at "today" and there is no
  // real period before it.
  const email = `cur-period-fwd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { rows: user } = await q(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]
  );
  const userId = user[0].id;
  const budget = await createSoloBudget(userId);
  const budgetId = budget.id;
  const accountId = await getDefaultAccountId(budgetId);
  const anchor = addDays(todayISO(), -13);
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'biweekly', $3)",
    [budgetId, accountId, anchor]
  );
  await q('UPDATE accounts SET started_on = $1 WHERE id = $2', [anchor, accountId]);
  await ensureMaterialized(budgetId);

  const server = await startTestServer(budget, userId);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await q('DELETE FROM budgets WHERE id = $1', [budgetId]);
    await q('DELETE FROM users WHERE id = $1', [userId]);
  });

  const { rows: before } = await q('SELECT id, start_date, end_date FROM pay_periods WHERE account_id = $1', [accountId]);
  assert.equal(before.length, 1, 'setup must produce exactly one period covering today');
  assert.equal(before[0].end_date, todayISO());

  // Correct the anchor by one day earlier (the user's real payday was one
  // day earlier than what they configured): shifts start AND end one day
  // earlier, so the corrected period now ends the day BEFORE today.
  const correctedStart = addDays(anchor, -1);
  const { status, body } = await correctCurrentPeriod(server, accountId, correctedStart);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.period.end, addDays(todayISO(), -1));

  // pay_period_configs.anchor_date must be untouched - only the one real row
  // was corrected, per the brief.
  const { rows: cfgRow } = await q('SELECT anchor_date FROM pay_period_configs WHERE account_id = $1', [accountId]);
  assert.equal(cfgRow[0].anchor_date, anchor, 'anchor_date must be left exactly as configured');

  // ensureMaterialized must now walk forward from the CORRECTED row's own
  // end_date to cover today again, creating a new period that starts the
  // day right after it - never overlapping the corrected row.
  await ensureMaterialized(budgetId);
  const { rows: after } = await q(
    'SELECT id, start_date, end_date FROM pay_periods WHERE account_id = $1 ORDER BY start_date', [accountId]
  );
  assert.ok(after.length >= 2, 'a new period must be materialized to cover today again');
  const correctedRow = after.find((p) => p.id === before[0].id);
  assert.equal(correctedRow.start_date, correctedStart);
  assert.equal(correctedRow.end_date, addDays(todayISO(), -1));
  const nextRow = after.find((p) => p.start_date > correctedRow.start_date);
  assert.ok(nextRow, 'a following period must exist');
  assert.equal(nextRow.start_date, addDays(correctedRow.end_date, 1), 'the next period must start immediately after the corrected end_date, with no gap or overlap');
  assert.ok(nextRow.end_date >= todayISO(), 'the newly materialized period must reach at least through today');
});

test.after(() => pool.end());
