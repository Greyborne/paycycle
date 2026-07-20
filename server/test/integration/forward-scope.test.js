// Integration test for the `scope=forward` path — setAmountGoingForward in
// server/services/budget.js. This function once had a `$1`-placeholder bug
// (its params array included an unreferenced budgetId, shifting every other
// placeholder) that made EVERY call reject with a 500; nothing caught it
// except a live checker run. It also once leaked stray line items into every
// OTHER account's open periods before the per-account scoping fix. This test
// guards both regressions directly.
//
// Requires a real Postgres reachable via DATABASE_URL with the schema already
// migrated (see the CI workflow, or run `npm run migrate` against a throwaway
// database first). Not part of the default `npm test` unit run — use
// `npm run test:integration`.
//
// Seeds its own isolated budget and deletes it afterwards (every
// budget-scoped table cascades from budgets), so runs never collide and
// leave no residue.

// This import must stay first: it throws before any connection/seed/query
// work happens if DATABASE_URL doesn't look like a local/throwaway database.
// See _env-guard.js for why.
import './_env-guard.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, q } from '../../db.js';
import {
  createSoloBudget, ensureMaterialized, getConfig, getDefaultAccountId, setAmountGoingForward,
} from '../../services/budget.js';
import { addDays, todayISO } from '../../services/schedule.js';

test('setAmountGoingForward: resolves, records history, rolls forward within its own account only, and never touches closed periods', async (t) => {
  const email = `fwd-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { rows: user } = await q(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [email]
  );
  const userId = user[0].id;
  const budget = await createSoloBudget(userId);
  const budgetId = budget.id;
  t.after(async () => {
    await q('DELETE FROM budgets WHERE id = $1', [budgetId]);
    await q('DELETE FROM users WHERE id = $1', [userId]);
  });

  const today = todayISO();
  const startedOn = addDays(today, -60);

  // Account A: the default account, biweekly cadence, anchored on today so a
  // period boundary lands there; backdated so several periods materialize.
  const accountA = await getDefaultAccountId(budgetId);
  await q('UPDATE accounts SET started_on = $1 WHERE id = $2', [startedOn, accountA]);
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'biweekly', $3)",
    [budgetId, accountA, today]
  );

  // Account B: a second base-currency account, monthly cadence — a genuinely
  // different schedule, so its period rows never line up with A's.
  const { rows: acctB } = await q(
    "INSERT INTO accounts (budget_id, name, started_on) VALUES ($1, 'Second account', $2) RETURNING id",
    [budgetId, startedOn]
  );
  const accountB = acctB[0].id;
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, day_1) VALUES ($1, $2, 'monthly', 1)",
    [budgetId, accountB]
  );

  // A recurring every_period category owned by account A, with an initial
  // amount effective at the start of tracking, so A's periods carry a line
  // item for it from materialization.
  const OLD_AMOUNT = 10000;
  const NEW_AMOUNT = 25000;
  const { rows: cat } = await q(
    `INSERT INTO category_templates (budget_id, account_id, name, type, recurrence, category_type, sort_order)
     VALUES ($1, $2, 'Groceries', 'expense', 'every_period', 'recurring', 0) RETURNING id`,
    [budgetId, accountA]
  );
  const categoryId = cat[0].id;
  await q(
    'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, $2, $3)',
    [categoryId, OLD_AMOUNT, startedOn]
  );

  await ensureMaterialized(budgetId);

  const { rows: periodsA } = await q(
    'SELECT id, start_date, end_date FROM pay_periods WHERE account_id = $1 ORDER BY start_date',
    [accountA]
  );
  assert.ok(periodsA.length >= 3, 'account A must have several materialized periods for this test to be meaningful');

  // Pick an effective date inside an earlier period (not the very first, not
  // the very last), so there is at least one open period on/after it left
  // over to roll forward, and a distinct one to close and freeze.
  const effectivePeriod = periodsA[Math.floor(periodsA.length / 2)];
  const effectiveDate = effectivePeriod.start_date;

  // Close that effective period BEFORE rolling forward — the regression this
  // guards is that a closed period must stay frozen at the OLD amount even
  // though it starts on/after the effective date.
  await q('UPDATE pay_periods SET closed_at = now() WHERE id = $1', [effectivePeriod.id]);

  const cfgA = await getConfig(budgetId, accountA);

  // 1. Must resolve without throwing (the direct $1-placeholder regression
  // guard: that bug made every call to this function reject), and the
  // returned touched-count must be > 0.
  const touched = await setAmountGoingForward(
    { query: q }, budgetId, cfgA, categoryId, NEW_AMOUNT, effectiveDate
  );
  assert.ok(touched > 0, 'setAmountGoingForward must report at least one period touched');

  // 2. History recorded at the effective period's start date with the new
  // amount.
  const { rows: hist } = await q(
    'SELECT amount_cents FROM category_amount_history WHERE category_template_id = $1 AND effective_start_date = $2',
    [categoryId, effectiveDate]
  );
  assert.equal(hist.length, 1, 'a history row must exist at the effective period start date');
  assert.equal(hist[0].amount_cents, NEW_AMOUNT);

  // 3. Rolled forward within account A: every OPEN period starting on/after
  // the effective period's start has the new amount.
  const { rows: openItemsA } = await q(
    `SELECT pp.start_date, li.planned_amount_cents FROM line_items li
     JOIN pay_periods pp ON pp.id = li.pay_period_id
     WHERE li.category_template_id = $1 AND pp.account_id = $2
       AND pp.closed_at IS NULL AND pp.start_date >= $3`,
    [categoryId, accountA, effectiveDate]
  );
  assert.ok(openItemsA.length > 0, 'at least one open period on/after the effective date must carry the item');
  for (const item of openItemsA) {
    assert.equal(item.planned_amount_cents, NEW_AMOUNT, `open period ${item.start_date} must carry the new amount`);
  }

  // 4. Account isolation: account B must have NO line item for A's category —
  // before the per-account fix, this function upserted a stray line item into
  // every other account's open periods.
  const { rows: leaked } = await q(
    `SELECT COUNT(*)::int AS n FROM line_items li
     JOIN pay_periods pp ON pp.id = li.pay_period_id
     WHERE li.category_template_id = $1 AND pp.account_id = $2`,
    [categoryId, accountB]
  );
  assert.equal(leaked[0].n, 0, 'account B must have zero line items for account A\'s category');

  // 5. Closed periods frozen: the period we closed (on/after the effective
  // date) must keep the OLD amount — setAmountGoingForward must never touch
  // closed periods.
  const { rows: closedItem } = await q(
    'SELECT planned_amount_cents FROM line_items WHERE category_template_id = $1 AND pay_period_id = $2',
    [categoryId, effectivePeriod.id]
  );
  assert.equal(closedItem.length, 1, 'the closed period must still have its line item');
  assert.equal(closedItem[0].planned_amount_cents, OLD_AMOUNT, 'a closed period must keep the OLD amount, never the rolled-forward one');
});

test.after(() => pool.end());
