// Integration tests for the yearly report's (GET /api/reports/summary)
// unscoped fill-in loop, which synthesizes months a household has no
// materialized pay_periods rows for yet, in server/routes/reports.js.
//
// Requires a real Postgres reachable via DATABASE_URL with the schema already
// migrated. Not part of the default `npm test` unit run — use
// `npm run test:integration` (or the ephemeral wrapper, which creates and
// drops its own throwaway database).
//
// Each test seeds its own isolated budget and deletes it afterwards (every
// budget-scoped table cascades from budgets), so runs never collide and
// leave no residue.
//
// The route is exercised through the REAL router handler — not a
// reimplementation — by pulling the actual function express registered for
// GET /summary off the imported router and invoking it with a minimal
// req/res, exactly like close-atomic.test.js does for the close route.

// This import must stay first: it throws before any connection/seed/query
// work happens if DATABASE_URL doesn't look like a local/throwaway database.
// See _env-guard.js for why.
import './_env-guard.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, q } from '../../db.js';
import reportRoutes from '../../routes/reports.js';
import prefixReportRoutes from './_reports-prefix-reference.js';
import { createSoloBudget, getDefaultAccountId } from '../../services/budget.js';
import { todayISO } from '../../services/schedule.js';

function findHandler(routerObj, method, path) {
  const layer = routerObj.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`no route registered for ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle;
}

const summaryHandler = findHandler(reportRoutes, 'get', '/summary');
// The pre-change (commit 7ccbf6e) handler, for the full-payload parity test
// below — see _reports-prefix-reference.js for provenance.
const prefixSummaryHandler = findHandler(prefixReportRoutes, 'get', '/summary');

function callHandler(handler, req) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const res = {
      status(code) { statusCode = code; return this; },
      json(body) { resolve({ status: statusCode, body }); },
    };
    Promise.resolve(handler(req, res, (err) => reject(err))).catch(reject);
  });
}

async function summaryReq({ budget, year, account }) {
  const query = { year: String(year) };
  if (account !== undefined) query.account = String(account);
  return callHandler(summaryHandler, { budget, query });
}

// Same as summaryReq, but against the literal pre-change (commit 7ccbf6e)
// handler — see _reports-prefix-reference.js.
async function prefixSummaryReq({ budget, year, account }) {
  const query = { year: String(year) };
  if (account !== undefined) query.account = String(account);
  return callHandler(prefixSummaryHandler, { budget, query });
}

async function makeUser() {
  const email = `reports-fillin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { rows: user } = await q(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [email]
  );
  return user[0].id;
}

async function cleanup(budgetId, userId) {
  await q('DELETE FROM budgets WHERE id = $1', [budgetId]);
  await q('DELETE FROM users WHERE id = $1', [userId]);
}

// A year with NO materialized periods at all for any account, so the entire
// year's output comes purely from the fill-in loop under test — nothing from
// the real-data SQL to worry about muddying comparisons. Far enough in the
// future that it can never collide with "today" (which would introduce a
// preHistory/cleared split the tests below don't want to reason about).
const FILLIN_YEAR = new Date().getUTCFullYear() + 5;

function sumEveryPeriodPlanned(body, templateId) {
  const cat = body.categories.find((c) => c.id === templateId);
  if (!cat) return 0;
  return cat.months.reduce((sum, m) => sum + m.planned, 0);
}

test('the bug: an every_period template on a monthly second account is counted 12x/yr in the household fill-in, not ~26x (biweekly default account)', async (t) => {
  const userId = await makeUser();
  const budget = await createSoloBudget(userId);
  t.after(() => cleanup(budget.id, userId));

  const defaultAccountId = await getDefaultAccountId(budget.id);
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'biweekly', $3)",
    [budget.id, defaultAccountId, `${FILLIN_YEAR}-01-01`]
  );

  const { rows: acct2 } = await q(
    "INSERT INTO accounts (budget_id, name, started_on) VALUES ($1, 'Monthly account', $2) RETURNING id",
    [budget.id, `${FILLIN_YEAR}-01-01`]
  );
  const monthlyAccountId = acct2[0].id;
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, day_1) VALUES ($1, $2, 'monthly', 1)",
    [budget.id, monthlyAccountId]
  );

  const { rows: cat } = await q(
    `INSERT INTO category_templates (budget_id, account_id, name, type, recurrence, category_type, sort_order)
     VALUES ($1, $2, 'Storage unit', 'expense', 'every_period', 'recurring', 0) RETURNING id`,
    [budget.id, monthlyAccountId]
  );
  await q(
    'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, 10000, $2)',
    [cat[0].id, `${FILLIN_YEAR}-01-01`]
  );

  const { status, body } = await summaryReq({ budget, year: FILLIN_YEAR });
  assert.equal(status, 200);

  const totalPlanned = sumEveryPeriodPlanned(body, cat[0].id);
  // 12 monthly periods in the year x $100 = $1200 (120000 cents). Before the
  // fix, this walked the biweekly default account's ~26 periods against this
  // template instead, overstating it to roughly 26 x $100 = $2600.
  assert.equal(totalPlanned, 120000, 'an every_period template on a monthly account must be counted once per its own monthly period (12x/yr), not the default account\'s biweekly period count (~26x/yr)');
});

test('single-cadence regression: a budget whose accounts all share one cadence is byte-identical to a plain single-account walk', async (t) => {
  const userId = await makeUser();
  const budget = await createSoloBudget(userId);
  t.after(() => cleanup(budget.id, userId));

  const defaultAccountId = await getDefaultAccountId(budget.id);
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'biweekly', $3)",
    [budget.id, defaultAccountId, `${FILLIN_YEAR}-01-01`]
  );

  const { rows: acct2 } = await q(
    "INSERT INTO accounts (budget_id, name, started_on) VALUES ($1, 'Second biweekly account', $2) RETURNING id",
    [budget.id, `${FILLIN_YEAR}-01-01`]
  );
  const secondAccountId = acct2[0].id;
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'biweekly', $3)",
    [budget.id, secondAccountId, `${FILLIN_YEAR}-01-01`]
  );

  const { rows: cat1 } = await q(
    `INSERT INTO category_templates (budget_id, name, type, recurrence, category_type, sort_order)
     VALUES ($1, 'Groceries', 'expense', 'every_period', 'recurring', 0) RETURNING id`,
    [budget.id]
  );
  await q(
    'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, 15000, $2)',
    [cat1[0].id, `${FILLIN_YEAR}-01-01`]
  );
  const { rows: cat2 } = await q(
    `INSERT INTO category_templates (budget_id, account_id, name, type, recurrence, category_type, sort_order)
     VALUES ($1, $2, 'Second account bill', 'expense', 'every_period', 'recurring', 1) RETURNING id`,
    [budget.id, secondAccountId]
  );
  await q(
    'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, 8000, $2)',
    [cat2[0].id, `${FILLIN_YEAR}-01-01`]
  );

  const { status, body } = await summaryReq({ budget, year: FILLIN_YEAR });
  assert.equal(status, 200);

  // Reference: sum what a single-account biweekly walk would produce for
  // each template independently, using the SAME account-scoped path
  // (?account=), which the spec requires to already be correct and
  // unchanged. Cross-check the unscoped totals equal the sum of the two
  // scoped totals — this is the "must not shift by a cent" property.
  const defaultScoped = await summaryReq({ budget, year: FILLIN_YEAR, account: defaultAccountId });
  const secondScoped = await summaryReq({ budget, year: FILLIN_YEAR, account: secondAccountId });

  const cat1Unscoped = sumEveryPeriodPlanned(body, cat1[0].id);
  const cat2Unscoped = sumEveryPeriodPlanned(body, cat2[0].id);
  const cat1ScopedDefault = sumEveryPeriodPlanned(defaultScoped.body, cat1[0].id);
  const cat2ScopedSecond = sumEveryPeriodPlanned(secondScoped.body, cat2[0].id);

  assert.equal(cat1Unscoped, cat1ScopedDefault, 'a single-cadence household\'s unscoped total must match the default account\'s own scoped total');
  assert.equal(cat2Unscoped, cat2ScopedSecond, 'a single-cadence household\'s unscoped total must match the second account\'s own scoped total');

  // Sanity: both accounts share the exact same cadence/anchor, so they walk
  // the same number of periods in the year - the two totals must be in
  // exactly the $150:$80 ratio of their per-period amounts, whatever that
  // period count turns out to be (deliberately not hardcoded here: a
  // biweekly walk anchored on Jan 1 can land 26 or 27 period-starts in a
  // given calendar year depending on where Dec 31 falls relative to the
  // 14-day cadence, so pinning a literal count would make this test fragile
  // to the anchor date rather than actually proving the property under
  // test).
  assert.ok(cat1Unscoped > 0 && cat2Unscoped > 0, 'both categories must have nonzero fill-in totals for this comparison to be meaningful');
  assert.equal(cat1Unscoped * 8000, cat2Unscoped * 15000, 'same-cadence accounts must produce totals in exactly the ratio of their per-period amounts');
});

// Full-payload parity: the property test 2 above is really trying to prove
// ("a single-cadence household must not shift by a cent") is checked there
// only via reduced per-category annual totals, which cannot catch a bug that
// moves a category's contribution to the wrong MONTH while preserving its
// annual sum (e.g. an off-by-one in month indexing during the per-account
// merge). For a month-by-month report, month attribution is the product, so
// this test diffs the ENTIRE response body - every month of every category,
// not a sum - between the real post-change handler and a literal copy of the
// pre-change (commit 7ccbf6e) handler (_reports-prefix-reference.js), run
// against the exact same seeded data.
//
// This is a genuine before/after comparison, not an internal-consistency
// argument like test 2's cross-check - and it deliberately does NOT hardcode
// any period count (the old and new handlers walk their own schedules
// however many periods that produces; only their outputs need to agree).
//
// Restricted, per the boss's ruling, to a budget with NO archived and NO
// foreign-currency accounts, and where every account shares the exact same
// cadence AND anchor (not just the same cadence type): fixes 2 and 3
// (archived/foreign-currency exclusion) are deliberate behavior changes the
// pre-change handler cannot be expected to match, and even a shared cadence
// TYPE with a different anchor would make the pre-change handler compute the
// wrong (default-account-anchored) periods for the second account's
// templates - a real difference this fix intentionally corrects, not a
// month-attribution bug. With truly identical schedules across both
// accounts, though, the pre- and post-change walks cover exactly the same
// periods, so genuinely nothing in scope should differ - full stop.
test('full-payload parity: for a single-cadence (same cadence AND anchor), no-archived, no-foreign-currency budget, the new handler\'s entire response is byte-identical to the pre-change handler\'s', async (t) => {
  const userId = await makeUser();
  const budget = await createSoloBudget(userId);
  t.after(() => cleanup(budget.id, userId));

  const defaultAccountId = await getDefaultAccountId(budget.id);
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'biweekly', $3)",
    [budget.id, defaultAccountId, `${FILLIN_YEAR}-01-01`]
  );

  const { rows: acct2 } = await q(
    "INSERT INTO accounts (budget_id, name, started_on) VALUES ($1, 'Second account (same schedule)', $2) RETURNING id",
    [budget.id, `${FILLIN_YEAR}-01-01`]
  );
  const secondAccountId = acct2[0].id;
  // Identical cadence AND anchor to the default account - a truly
  // single-schedule household, just split across two accounts.
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'biweekly', $3)",
    [budget.id, secondAccountId, `${FILLIN_YEAR}-01-01`]
  );

  // A mix of every_period and monthly templates, owned by both the default
  // account (no account_id) and the second account, income and expense -
  // enough variety that a month-attribution bug in the merge would show up
  // as a value in the wrong array slot rather than happening to cancel out.
  const templates = [
    { name: 'Groceries', account_id: null, type: 'expense', recurrence: 'every_period', due_day: null, amount: 15000 },
    { name: 'Paycheck', account_id: null, type: 'income', recurrence: 'every_period', due_day: null, amount: 220000 },
    { name: 'Rent', account_id: null, type: 'expense', recurrence: 'monthly', due_day: 1, amount: 180000 },
    { name: 'Second account bill', account_id: secondAccountId, type: 'expense', recurrence: 'every_period', due_day: null, amount: 8000 },
    { name: 'Second account income', account_id: secondAccountId, type: 'income', recurrence: 'every_period', due_day: null, amount: 50000 },
    { name: 'Second account subscription', account_id: secondAccountId, type: 'expense', recurrence: 'monthly', due_day: 20, amount: 1999 },
  ];
  for (const tpl of templates) {
    const { rows: cat } = await q(
      `INSERT INTO category_templates (budget_id, account_id, name, type, recurrence, due_day, category_type, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, 'recurring', 0) RETURNING id`,
      [budget.id, tpl.account_id, tpl.name, tpl.type, tpl.recurrence, tpl.due_day]
    );
    await q(
      'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, $2, $3)',
      [cat[0].id, tpl.amount, `${FILLIN_YEAR}-01-01`]
    );
  }

  const post = await summaryReq({ budget, year: FILLIN_YEAR });
  const pre = await prefixSummaryReq({ budget, year: FILLIN_YEAR });

  assert.equal(post.status, 200);
  assert.equal(pre.status, 200);

  // Sanity: this must be a nontrivial comparison, not two empty payloads
  // agreeing vacuously.
  assert.ok(post.body.categories.length >= templates.length, 'the response must actually contain the seeded categories');
  const anyNonzero = post.body.categories.some((c) => c.months.some((m) => m.planned !== 0));
  assert.ok(anyNonzero, 'at least one month must carry a nonzero planned amount for this comparison to be meaningful');

  // The real assertion: full-payload deep equality, month-by-month.
  assert.deepEqual(post.body, pre.body, 'the new per-account handler must produce a byte-identical response to the pre-change handler for a single-schedule, no-archived, no-foreign-currency household');
});

test('monthly recurrence is cadence-independent: a monthly template on a differently-cadenced account totals the same regardless of the fix', async (t) => {
  const userId = await makeUser();
  const budget = await createSoloBudget(userId);
  t.after(() => cleanup(budget.id, userId));

  const defaultAccountId = await getDefaultAccountId(budget.id);
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'biweekly', $3)",
    [budget.id, defaultAccountId, `${FILLIN_YEAR}-01-01`]
  );

  const { rows: acct2 } = await q(
    "INSERT INTO accounts (budget_id, name, started_on) VALUES ($1, 'Monthly account', $2) RETURNING id",
    [budget.id, `${FILLIN_YEAR}-01-01`]
  );
  const monthlyAccountId = acct2[0].id;
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, day_1) VALUES ($1, $2, 'monthly', 1)",
    [budget.id, monthlyAccountId]
  );

  const { rows: cat } = await q(
    `INSERT INTO category_templates (budget_id, account_id, name, type, recurrence, due_day, category_type, sort_order)
     VALUES ($1, $2, 'Rent', 'expense', 'monthly', 15, 'recurring', 0) RETURNING id`,
    [budget.id, monthlyAccountId]
  );
  await q(
    'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, 200000, $2)',
    [cat[0].id, `${FILLIN_YEAR}-01-01`]
  );

  const { status, body } = await summaryReq({ budget, year: FILLIN_YEAR });
  assert.equal(status, 200);

  const totalPlanned = sumEveryPeriodPlanned(body, cat[0].id);
  // The due day (the 15th) occurs exactly once per calendar month regardless
  // of which account's periods are walked to find it, so this must total
  // 12 x $2000 = $24000 either before or after the fix.
  assert.equal(totalPlanned, 12 * 200000, 'a monthly template must total the same regardless of which cadence walks the calendar for it');
});

test('archived exclusion: an archived account\'s every_period template is dropped from fill-in months, but its already-recorded real-month line items survive', async (t) => {
  const userId = await makeUser();
  const budget = await createSoloBudget(userId);
  t.after(() => cleanup(budget.id, userId));

  const defaultAccountId = await getDefaultAccountId(budget.id);
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'biweekly', $3)",
    [budget.id, defaultAccountId, `${FILLIN_YEAR}-01-01`]
  );

  const { rows: acct2 } = await q(
    "INSERT INTO accounts (budget_id, name, started_on) VALUES ($1, 'Closed account', $2) RETURNING id",
    [budget.id, `${FILLIN_YEAR}-01-01`]
  );
  const archivedAccountId = acct2[0].id;
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'biweekly', $3)",
    [budget.id, archivedAccountId, `${FILLIN_YEAR}-01-01`]
  );

  const { rows: cat } = await q(
    `INSERT INTO category_templates (budget_id, account_id, name, type, recurrence, category_type, sort_order)
     VALUES ($1, $2, 'Old subscription', 'expense', 'every_period', 'recurring', 0) RETURNING id`,
    [budget.id, archivedAccountId]
  );
  await q(
    'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, 500, $2)',
    [cat[0].id, `${FILLIN_YEAR}-01-01`]
  );

  // Give the archived account one real (materialized) period with a real
  // cleared line item, so removing it from the fill-in must not also erase
  // this already-recorded history.
  const { rows: period } = await q(
    `INSERT INTO pay_periods (budget_id, account_id, start_date, end_date)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [budget.id, archivedAccountId, `${FILLIN_YEAR}-01-01`, `${FILLIN_YEAR}-01-14`]
  );
  await q(
    `INSERT INTO line_items (pay_period_id, category_template_id, planned_amount_cents, cleared)
     VALUES ($1, $2, 500, TRUE)`,
    [period[0].id, cat[0].id]
  );

  // Now archive the account.
  await q('UPDATE accounts SET archived = TRUE WHERE id = $1', [archivedAccountId]);

  const { status, body } = await summaryReq({ budget, year: FILLIN_YEAR });
  assert.equal(status, 200);

  const catEntry = body.categories.find((c) => c.id === cat[0].id);
  assert.ok(catEntry, 'the category must still appear (it has a real recorded line item in January)');
  // January (the real materialized month) must still carry the recorded $5.
  assert.equal(catEntry.months[0].planned, 500, 'the real, already-recorded January line item must survive archiving');
  assert.equal(catEntry.months[0].cleared, 500, 'the real, already-recorded January cleared amount must survive archiving');
  // Every other (fill-in) month must be untouched by the archived account's
  // template.
  for (let m = 1; m < 12; m += 1) {
    assert.equal(catEntry.months[m].planned, 0, `month ${m + 1} must not carry a fill-in contribution from an archived account`);
  }
});

test('foreign-currency exclusion: a foreign-currency account\'s every_period template does not appear in fill-in months', async (t) => {
  const userId = await makeUser();
  const budget = await createSoloBudget(userId);
  t.after(() => cleanup(budget.id, userId));

  const defaultAccountId = await getDefaultAccountId(budget.id);
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'biweekly', $3)",
    [budget.id, defaultAccountId, `${FILLIN_YEAR}-01-01`]
  );

  const { rows: acct2 } = await q(
    "INSERT INTO accounts (budget_id, name, currency, started_on) VALUES ($1, 'EUR account', 'EUR', $2) RETURNING id",
    [budget.id, `${FILLIN_YEAR}-01-01`]
  );
  const eurAccountId = acct2[0].id;
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'biweekly', $3)",
    [budget.id, eurAccountId, `${FILLIN_YEAR}-01-01`]
  );

  const { rows: cat } = await q(
    `INSERT INTO category_templates (budget_id, account_id, name, type, recurrence, category_type, sort_order)
     VALUES ($1, $2, 'Euro rent', 'expense', 'every_period', 'recurring', 0) RETURNING id`,
    [budget.id, eurAccountId]
  );
  await q(
    'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, 90000, $2)',
    [cat[0].id, `${FILLIN_YEAR}-01-01`]
  );

  const { status, body } = await summaryReq({ budget, year: FILLIN_YEAR });
  assert.equal(status, 200);

  const catEntry = body.categories.find((c) => c.id === cat[0].id);
  assert.ok(!catEntry || catEntry.months.every((m) => m.planned === 0), 'a foreign-currency account\'s every_period template must not contribute to any fill-in month');
});

test('real months untouched: a budget with materialized periods produces identical values for every real month before and after', async (t) => {
  const userId = await makeUser();
  const budget = await createSoloBudget(userId);
  t.after(() => cleanup(budget.id, userId));

  const defaultAccountId = await getDefaultAccountId(budget.id);
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'biweekly', $3)",
    [budget.id, defaultAccountId, `${FILLIN_YEAR}-01-01`]
  );

  const { rows: cat } = await q(
    `INSERT INTO category_templates (budget_id, name, type, recurrence, category_type, sort_order)
     VALUES ($1, 'Paycheck', 'income', 'every_period', 'recurring', 0) RETURNING id`,
    [budget.id]
  );

  // Materialize a real January period with a real line item, entirely via
  // direct SQL (same technique materialize.test.js uses), independent of the
  // fill-in loop under test.
  const { rows: period } = await q(
    `INSERT INTO pay_periods (budget_id, account_id, start_date, end_date)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [budget.id, defaultAccountId, `${FILLIN_YEAR}-01-01`, `${FILLIN_YEAR}-01-14`]
  );
  await q(
    `INSERT INTO line_items (pay_period_id, category_template_id, planned_amount_cents, cleared)
     VALUES ($1, $2, 250000, TRUE)`,
    [period[0].id, cat[0].id]
  );

  const { status, body } = await summaryReq({ budget, year: FILLIN_YEAR });
  assert.equal(status, 200);

  const catEntry = body.categories.find((c) => c.id === cat[0].id);
  assert.ok(catEntry);
  // The real January row comes straight from the SQL this change must not
  // touch: exactly the recorded $2500, both planned and cleared.
  assert.equal(catEntry.months[0].planned, 250000);
  assert.equal(catEntry.months[0].cleared, 250000);
});

test.after(() => pool.end());
