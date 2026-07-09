// Integration test for the budget engine's line-item materialization.
//
// Requires a real Postgres reachable via DATABASE_URL with the schema already
// migrated (see the CI workflow, or run `npm run migrate` against a throwaway
// database first). It is intentionally NOT part of the default `npm test`
// unit run, which stays dependency-free — use `npm run test:integration`.
//
// Each test seeds its own isolated budget and deletes it afterwards (every
// budget-scoped table cascades from budgets), so runs never collide and leave
// no residue.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, q } from '../../db.js';
import { createSoloBudget, ensureMaterialized, getConfig } from '../../services/budget.js';
import { addDays, monthlyOccurrences, parseISO, periodContaining, todayISO } from '../../services/schedule.js';

// Seed a fresh biweekly household whose tracking starts `daysAgo` days before
// today, then materialize periods up through today. Returns the budget id and
// its config.
async function seedBudget({ daysAgo }) {
  const email = `mat-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { rows: user } = await q(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [email]
  );
  const budget = await createSoloBudget(user[0].id);
  // Anchor the schedule on today so a period boundary lands there; backdate
  // the default account so materialization reaches back `daysAgo` days.
  await q(
    "INSERT INTO pay_period_configs (budget_id, cadence, anchor_date) VALUES ($1, 'biweekly', $2)",
    [budget.id, todayISO()]
  );
  await q(
    'UPDATE accounts SET started_on = $1 WHERE budget_id = $2',
    [addDays(todayISO(), -daysAgo), budget.id]
  );
  const cfg = await getConfig(budget.id);
  await ensureMaterialized(budget.id, cfg);
  return { budgetId: budget.id, cfg, userId: user[0].id };
}

async function cleanup(budgetId, userId) {
  await q('DELETE FROM budgets WHERE id = $1', [budgetId]);
  await q('DELETE FROM users WHERE id = $1', [userId]);
}

test('a monthly category added after materialization lands in the open period containing its due day', async (t) => {
  // Track two biweekly periods of history, so the earliest open period sits
  // well before today's period.
  const { budgetId, cfg, userId } = await seedBudget({ daysAgo: 28 });
  t.after(() => cleanup(budgetId, userId));

  // A day-of-month whose occurrence falls ~20 days ago is guaranteed to sit in
  // an earlier open period than today's — the real-world case (added on the
  // 8th, due on the 15th, current period Jul 1–14).
  const dueDate = addDays(todayISO(), -20);
  const dueDay = parseISO(dueDate).d;
  const targetStart = periodContaining(cfg, dueDate).start;
  const currentStart = periodContaining(cfg, todayISO()).start;
  assert.notEqual(targetStart, currentStart, 'due day must fall in an earlier period than today for this test to be meaningful');

  // Create the category exactly as the categories route does: template + one
  // effective-dated amount, then call ensureMaterialized (its post-create step).
  const { rows: cat } = await q(
    `INSERT INTO category_templates (budget_id, name, type, recurrence, due_day, category_type, sort_order)
     VALUES ($1, 'Parker Bill Transfer', 'income', 'monthly', $2, 'recurring', 0) RETURNING id`,
    [budgetId, dueDay]
  );
  await q(
    'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, 44000, $2)',
    [cat[0].id, addDays(todayISO(), -28)]
  );
  await ensureMaterialized(budgetId, cfg);

  // Contract: the $440 item appears in exactly the open periods whose date
  // range contains an occurrence of the due day — no more, no fewer. Before
  // the fix, only today's period was topped up, so earlier periods that
  // bracket the due day silently missed the item.
  const { rows: periods } = await q(
    'SELECT start_date, end_date FROM pay_periods WHERE budget_id = $1 AND closed_at IS NULL ORDER BY start_date',
    [budgetId]
  );
  const { rows: items } = await q(
    `SELECT pp.start_date, li.planned_amount_cents FROM line_items li
     JOIN pay_periods pp ON pp.id = li.pay_period_id
     WHERE li.category_template_id = $1`,
    [cat[0].id]
  );
  const amountByStart = new Map(items.map((i) => [i.start_date, i.planned_amount_cents]));

  let earlierPopulated = 0;
  for (const p of periods) {
    const hasOccurrence = monthlyOccurrences(dueDay, p.start_date, p.end_date).length > 0;
    if (hasOccurrence) {
      assert.equal(amountByStart.get(p.start_date), 44000, `${p.start_date} contains the due day and must carry the $440 item`);
      if (p.start_date !== currentStart) earlierPopulated += 1;
    } else {
      assert.equal(amountByStart.has(p.start_date), false, `${p.start_date} has no due-day occurrence and must have no item`);
    }
  }
  assert.ok(earlierPopulated >= 1, 'the fix must back-fill at least one earlier (non-today) open period');
});

test('a closed period is never back-filled by a later category', async (t) => {
  const { budgetId, cfg, userId } = await seedBudget({ daysAgo: 28 });
  t.after(() => cleanup(budgetId, userId));

  // Close the earliest period, freezing its snapshot.
  const dueDate = addDays(todayISO(), -20);
  const dueDay = parseISO(dueDate).d;
  const targetPeriod = periodContaining(cfg, dueDate);
  await q(
    'UPDATE pay_periods SET closed_at = now() WHERE budget_id = $1 AND start_date = $2',
    [budgetId, targetPeriod.start]
  );

  const { rows: cat } = await q(
    `INSERT INTO category_templates (budget_id, name, type, recurrence, due_day, category_type, sort_order)
     VALUES ($1, 'Late Add', 'income', 'monthly', $2, 'recurring', 0) RETURNING id`,
    [budgetId, dueDay]
  );
  await q(
    'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, 12300, $2)',
    [cat[0].id, addDays(todayISO(), -28)]
  );
  await ensureMaterialized(budgetId, cfg);

  const { rows: item } = await q(
    `SELECT 1 FROM line_items li
     JOIN pay_periods pp ON pp.id = li.pay_period_id
     WHERE li.category_template_id = $1 AND pp.start_date = $2`,
    [cat[0].id, targetPeriod.start]
  );
  assert.equal(item.length, 0, 'a frozen (closed) period must not gain new line items');
});

test.after(() => pool.end());
