// Integration tests for POST /periods/:start/close being one atomic
// transaction (resolutions + adjustment insert + closed_at/closed_snapshot
// write), instead of the pre-fix three separate transaction scopes.
//
// Requires a real Postgres reachable via DATABASE_URL with the schema already
// migrated (see the CI workflow, or run `npm run migrate` against a throwaway
// database first). Not part of the default `npm test` unit run — use
// `npm run test:integration`.
//
// Each test seeds its own isolated budget and deletes it afterwards (every
// budget-scoped table cascades from budgets), so runs never collide and
// leave no residue.
//
// The close route is exercised through the REAL router handler — not a
// reimplementation of the close flow in this file — by pulling the actual
// function express registered for POST /:start/close off the imported
// router and invoking it with a minimal req/res. This runs the exact same
// code path a live HTTP request would, including its own pool.connect() /
// BEGIN / COMMIT.

// This import must stay first: it throws before any connection/seed/query
// work happens if DATABASE_URL doesn't look like a local/throwaway database.
// See _env-guard.js for why.
import './_env-guard.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, q } from '../../db.js';
import periodRoutes from '../../routes/periods.js';
import {
  buildProjection, clearedBalancesForPeriod, createSoloBudget, ensureMaterialized,
  getConfig, getDefaultAccountId, getLifecycle, materializePeriodAfter,
} from '../../services/budget.js';
import { addDays, periodContaining, todayISO } from '../../services/schedule.js';

// Pull the real handler function off the router for a given method+path, the
// same object express would call. Route paths here are literal patterns
// ('/:start/close'), not per-request expansions.
function findHandler(method, path) {
  const layer = periodRoutes.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`no route registered for ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle;
}

const closeHandler = findHandler('post', '/:start/close');

// Invoke a route handler exactly as express would, minus the HTTP layer:
// resolves with {status, body} on res.json/res.status().json(), rejects with
// whatever error the handler passes to next(). requireAuth/attachBudget are
// not involved here (those are separately-tested middleware) — req.budget is
// supplied directly, matching what attachBudget would have set.
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

async function closeReq({ budget, accountId, start, resolutions = {}, discrepancy }) {
  return callHandler(closeHandler, {
    budget,
    query: { account: String(accountId) },
    params: { start },
    body: { resolutions, discrepancy },
  });
}

// Seed a fresh solo budget with a biweekly default account anchored on today
// (so a period boundary lands there and "today" sits inside the first open
// period), onboarding marked complete (loadContext requires it), and three
// recurring expense categories whose line items land uncleared in the
// current period — one for each resolution kind under test.
//
// daysAgo defaults to 0 (the account starts today) so exactly one period
// materializes and it is unambiguously both "today's period" and the
// lifecycle-current one (the earliest not-yet-closed period) — no closed
// history to complicate which period close-out will act on.
//
// driftAmount (default 0, off) seeds one *prior* biweekly period containing
// a single uncleared expense item of that amount, then closes that period
// directly via SQL (bypassing the close route entirely, same technique
// materialize.test.js uses) — leaving the item forever uncleared. This is
// the only way this ledger model produces a genuinely nonzero
// est-vs-cleared discrepancy at close time: resolving every uncleared item
// in the CURRENT period (clear/carry/remove, in any combination) always
// nets to a zero contribution to the current period's own discrepancy —
// clearing an item shifts clearedBalance down by its amount but leaves
// est unchanged (planned already counted it whether cleared or not), while
// carrying/removing shifts est up by its amount but leaves clearedBalance
// unchanged (never cleared) — so after full resolution the two effects
// exactly cancel and the *only* thing left in "est - clearedBalance" is
// drift carried over from history, i.e. exactly one prior period's
// permanently-uncleared item. Requires daysAgo >= 14 (one full cadence
// period) so the prior period is real and distinct from the current one.
async function seedScenario({
  daysAgo = 0, amounts = { clear: 5000, carry: 3000, remove: 2000 }, driftAmount = 0,
} = {}) {
  if (driftAmount && daysAgo < 14) throw new Error('driftAmount requires daysAgo >= 14 so a prior period exists to carry it');
  const email = `close-atomic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { rows: user } = await q(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [email]
  );
  const userId = user[0].id;
  const created = await createSoloBudget(userId);
  const { rows: budgetRows } = await q(
    'UPDATE budgets SET onboarding_complete = TRUE WHERE id = $1 RETURNING *',
    [created.id]
  );
  const budget = budgetRows[0];
  const accountId = await getDefaultAccountId(budget.id);
  const today = todayISO();
  await q(
    "INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date) VALUES ($1, $2, 'biweekly', $3)",
    [budget.id, accountId, today]
  );
  // Backdate the default account so materialization reaches back `daysAgo`
  // days and today sits inside a real (non-first) period.
  const startedOn = addDays(today, -daysAgo);
  await q('UPDATE accounts SET started_on = $1 WHERE budget_id = $2', [startedOn, budget.id]);

  const cfg = await getConfig(budget.id, accountId);
  const currentPeriod = periodContaining(cfg, today);

  let driftCatId = null;
  if (driftAmount) {
    // Bounded to the prior period only (start_date/end_date), so it never
    // materializes a line item anywhere near the current period under test.
    const priorPeriod = periodContaining(cfg, addDays(currentPeriod.start, -1));
    const { rows: driftCat } = await q(
      `INSERT INTO category_templates (budget_id, name, type, recurrence, category_type, sort_order, start_date, end_date)
       VALUES ($1, 'drift item', 'expense', 'every_period', 'recurring', 0, $2, $3) RETURNING id`,
      [budget.id, priorPeriod.start, priorPeriod.end]
    );
    driftCatId = driftCat[0].id;
    await q(
      'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, $2, $3)',
      [driftCatId, driftAmount, startedOn]
    );
  }

  const catIds = {};
  for (const [kind, amount] of Object.entries(amounts)) {
    // Every one of these three is bounded to start with the CURRENT period
    // (start_date = currentPeriod.start) — with daysAgo > 0 (driftAmount
    // scenarios materialize a prior period too) an unbounded `every_period`
    // category would also generate its own uncleared occurrence in that
    // prior period, which then gets silently frozen along with the drift
    // item when the prior period is closed, corrupting the drift amount the
    // test thinks it's building. The carry/remove categories are ALSO capped
    // to end with the current period (end_date = currentPeriod.end), so they
    // generate no line item of their own when the next period is later
    // materialized — without that cap, an `every_period` category always
    // regenerates its own occurrence in the next period regardless of
    // anything this test does, and carrying/removing this period's
    // occurrence would land on top of (or be compared against) that
    // unrelated occurrence instead of a clean slate. The clear category has
    // no such upper cap because this test never inspects its behavior
    // beyond the period being closed.
    const capped = kind !== 'clear';
    const { rows: cat } = await q(
      `INSERT INTO category_templates (budget_id, name, type, recurrence, category_type, sort_order, start_date, end_date)
       VALUES ($1, $2, 'expense', 'every_period', 'recurring', 0, $3, $4) RETURNING id`,
      [budget.id, `${kind} item`, currentPeriod.start, capped ? currentPeriod.end : null]
    );
    catIds[kind] = cat[0].id;
    await q(
      'INSERT INTO category_amount_history (category_template_id, amount_cents, effective_start_date) VALUES ($1, $2, $3)',
      [cat[0].id, amount, startedOn]
    );
  }

  await ensureMaterialized(budget.id);

  if (driftAmount) {
    // Freeze the prior period with its drift item still uncleared — a
    // direct SQL close (not the route), the same technique
    // materialize.test.js uses for "a closed period is never back-filled".
    // This intentionally skips the route's own resolution/snapshot
    // machinery: it is standing in for legacy/pre-existing closed-without-
    // reconciliation history (migration 008's bulk-closed periods are a
    // real-world example), which is what actually produces carried-forward
    // drift, not anything this test is otherwise exercising.
    const priorStart = periodContaining(cfg, addDays(currentPeriod.start, -1)).start;
    await q(
      'UPDATE pay_periods SET closed_at = now() WHERE budget_id = $1 AND account_id = $2 AND start_date = $3',
      [budget.id, accountId, priorStart]
    );
  }

  const lifecycle = await getLifecycle(budget.id, cfg, accountId);
  const start = lifecycle.currentStart;
  assert.equal(start, currentPeriod.start, 'the lifecycle-current period must be the one this scenario built categories against');
  const { rows: periodRows } = await q(
    'SELECT * FROM pay_periods WHERE budget_id = $1 AND account_id = $2 AND start_date = $3',
    [budget.id, accountId, start]
  );
  const periodRow = periodRows[0];
  assert.ok(periodRow, 'the current period must be materialized for this test to be meaningful');

  const items = {};
  for (const kind of Object.keys(amounts)) {
    const { rows } = await q(
      'SELECT * FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
      [periodRow.id, catIds[kind]]
    );
    assert.equal(rows.length, 1, `the ${kind} category must have materialized exactly one line item in the current period`);
    items[kind] = rows[0];
  }

  return { budget, accountId, cfg, start, periodRow, catIds, items, userId };
}

async function cleanup(budgetId, userId) {
  await q('DELETE FROM budgets WHERE id = $1', [budgetId]);
  await q('DELETE FROM users WHERE id = $1', [userId]);
}

// These three top-level tests are `await`ed (rather than left to node:test's
// default concurrent scheduling) because the atomicity-regression test
// temporarily monkey-patches the process-wide `pool.connect` — if the
// value-parity test's real close() call happened to start executing while
// that patch was still installed, it would spuriously throw the injected
// failure too. Awaiting each test in turn guarantees no interleaving.
await test('successful close: clear/carry/remove all apply, response body and closed_snapshot.resolutions match the documented shape', async (t) => {
  const { budget, accountId, cfg, start, periodRow, catIds, items, userId } = await seedScenario();
  t.after(() => cleanup(budget.id, userId));

  const resolutions = {
    [items.clear.id]: 'clear',
    [items.carry.id]: 'carry',
    [items.remove.id]: 'remove',
  };
  // 'accept' sidesteps the discrepancy-adjustment path entirely so this test
  // stays focused on resolution-kind correctness; discrepancy math itself is
  // covered by the value-parity test below.
  const { status, body } = await closeReq({ budget, accountId, start, resolutions, discrepancy: 'accept' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.nextStart > start, 'nextStart must be the period after the one just closed');
  assert.ok(body.snapshot, 'response must include the frozen snapshot');
  assert.equal(typeof body.snapshot.total, 'number');

  // closed_at + closed_snapshot persisted, and the persisted snapshot is
  // exactly what was returned in the response (same object, not recomputed
  // differently on read).
  const { rows: closed } = await q('SELECT * FROM pay_periods WHERE id = $1', [periodRow.id]);
  assert.ok(closed[0].closed_at, 'period must be marked closed');
  assert.deepEqual(closed[0].closed_snapshot, body.snapshot, 'persisted snapshot must match the response body exactly');

  // resolutions log: one entry per uncleared item, in the documented shape
  // that reopen (server/routes/periods.js:279) replays.
  const log = body.snapshot.resolutions;
  assert.equal(log.length, 3);
  const byAction = Object.fromEntries(log.map((e) => [e.action, e]));
  assert.equal(byAction.clear.itemId, items.clear.id);
  assert.equal(byAction.carry.item.categoryTemplateId, catIds.carry);
  assert.equal(byAction.carry.item.plannedAmountCents, items.carry.planned_amount_cents);
  assert.equal(byAction.remove.item.categoryTemplateId, catIds.remove);
  assert.equal(byAction.remove.item.plannedAmountCents, items.remove.planned_amount_cents);

  // clear: the item stays in the closed period, now cleared.
  const { rows: clearedRow } = await q('SELECT * FROM line_items WHERE id = $1', [items.clear.id]);
  assert.equal(clearedRow.length, 1, 'a cleared item must still exist in the closed period');
  assert.equal(clearedRow[0].cleared, true);

  // carry: gone from the closed period, present in the next period at the
  // same amount (next period had no pre-existing item for this category, so
  // the ON CONFLICT increment is equivalent to a plain insert here).
  const { rows: carryGone } = await q('SELECT * FROM line_items WHERE id = $1', [items.carry.id]);
  assert.equal(carryGone.length, 0, 'the carried item must be gone from the closed period');
  const { rows: nextPeriod } = await q(
    'SELECT id FROM pay_periods WHERE budget_id = $1 AND account_id = $2 AND start_date = $3',
    [budget.id, accountId, body.nextStart]
  );
  const { rows: carriedIntoNext } = await q(
    'SELECT planned_amount_cents FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [nextPeriod[0].id, catIds.carry]
  );
  assert.equal(carriedIntoNext.length, 1, 'the carried item must land in the next period');
  assert.equal(carriedIntoNext[0].planned_amount_cents, items.carry.planned_amount_cents);

  // remove: gone from the closed period, and not resurrected in the next one.
  const { rows: removeGone } = await q('SELECT * FROM line_items WHERE id = $1', [items.remove.id]);
  assert.equal(removeGone.length, 0, 'the removed item must be gone from the closed period');
  const { rows: removedInNext } = await q(
    'SELECT 1 FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
    [nextPeriod[0].id, catIds.remove]
  );
  assert.equal(removedInNext.length, 0, 'a removed item must not be resurrected in the next period');
});

// The regression test for the actual bug: inject a failure on the
// closed_at/closed_snapshot UPDATE, wherever in the process it actually
// runs, and confirm nothing survives.
//
// This has to intercept at TWO layers, not one, precisely because "wherever
// it actually runs" differs between pre-fix and post-fix code:
//   - post-fix: that UPDATE runs via the close transaction's own client
//     (`client.query(...)`), so the injection must hook client.query.
//   - pre-fix: that UPDATE runs via the plain pool (`q()` -> `pool.query()`),
//     a completely separate, already-auto-committed call made AFTER the
//     resolutions' own transaction has already committed — so a
//     client.query-only hook never fires against pre-fix code at all (it
//     doesn't reach that UPDATE through a `pool.connect()`-derived client
//     the hook can see), and pre-fix code sails through as if nothing were
//     wrong. An earlier version of this test only hooked client.query and
//     was FAIL'd by build-checker for exactly that gap: it failed
//     pre-fix, but only on "expected rejection, got none" — the run never
//     got far enough to actually observe surviving mutations, so it didn't
//     prove what its own comment claimed. Hooking pool.query too closes
//     that gap: now the SAME injected failure fires against pre-fix code as
//     well, at the point where it actually tries to write closed_at, and
//     this test's residue assertions below get to run for real and find
//     real orphaned state (a committed resolution, or a committed
//     adjustment row, with closed_at still NULL) — not just an absent
//     rejection.
//
// What this test now actually proves, precisely: whichever code path the
// route takes to reach the closed_at/closed_snapshot write, if that write
// fails, NOTHING from this close survives — not the resolutions, not the
// adjustment row, not the carry. Post-fix that's because it's all one
// transaction that rolls back together. Pre-fix it demonstrably is NOT
// true (this same test fails against it — see the recorded pre-fix run in
// the task report), which is the bug this whole change exists to fix.
await test('close failing after resolutions but before closed_at leaves zero mutations (atomicity regression)', async (t) => {
  const { budget, accountId, cfg, start, periodRow, catIds, items, userId } = await seedScenario();
  t.after(() => cleanup(budget.id, userId));

  // Snapshot the exact pre-close state we must find unchanged afterward.
  const { rows: beforeItems } = await q(
    'SELECT id, pay_period_id, category_template_id, planned_amount_cents, cleared, account_id FROM line_items WHERE pay_period_id = $1 ORDER BY id',
    [periodRow.id]
  );
  const resolutions = {
    [items.clear.id]: 'clear',
    [items.carry.id]: 'carry',
    [items.remove.id]: 'remove',
  };

  const INJECTED_MESSAGE = 'INJECTED FAILURE: closed_at write blocked for atomicity test';
  const matchesClosedAtWrite = (text) => typeof text === 'string' && text.includes('UPDATE pay_periods SET closed_at');

  // Layer 1: wrap pool.query() — what every plain q() call (and pg-pool's
  // own internal implementation of q()-issued statements) goes through.
  // This is the layer that actually catches pre-fix code: pre-fix, the
  // closed_at/closed_snapshot write runs via plain q() (a separate,
  // already-auto-committed call made after the resolutions' own
  // transaction has already committed), never through a client this test
  // otherwise controls. Without this layer, pre-fix code sails straight
  // through the close and this test can only fail on "expected a
  // rejection, got none" — it never reaches the residue assertions below,
  // so it never actually demonstrates the bug (this is exactly the gap
  // build-checker found in an earlier version of this test).
  const realPoolQuery = pool.query.bind(pool);
  pool.query = (...args) => {
    if (matchesClosedAtWrite(args[0])) throw new Error(INJECTED_MESSAGE);
    return realPoolQuery(...args);
  };

  // Layer 2: wrap pool.connect() so the close transaction's OWN client also
  // throws on the same UPDATE — after every resolution write has already
  // run on that same (uncommitted) connection. This is what catches
  // post-fix code, where that write runs via `client.query(...)` inside
  // the single transaction, not via q(). This is the real route's real
  // client, not a simulation.
  //
  // Three things this must get right, all discovered the hard way while
  // writing this test:
  //
  // 1. pg-pool's own `pool.query()` (layer 1 above, which is ALSO active
  //    right now, wrapping every plain q() call including ones made by
  //    unrelated code mid-test) is itself implemented as
  //    `this.connect((err, client) => {...})` for any statement layer 1
  //    passes through — i.e. it calls `pool.connect` in CALLBACK style,
  //    not the promise style the close route uses
  //    (`const client = await pool.connect()`). An override that
  //    unconditionally treats its argument list as empty and returns a
  //    promise silently swallows that callback, and every in-flight q()
  //    anywhere in the process hangs forever. So this must stay a
  //    dual-mode shim exactly like the real pool.connect: callback calls
  //    pass straight through untouched (those connections never run the
  //    closed_at UPDATE themselves — layer 1 already caught that text
  //    before pool.query got this far — only the route's own explicit
  //    connect does), and only the no-argument promise-style call gets the
  //    wrapped client.
  // 2. Once wrapping the promise-style client's query method, it must
  //    forward every argument, not just (text, params) — client.query can
  //    also be invoked in callback style internally, and dropping a
  //    callback hangs that caller the same way as (1).
  // 3. pg-pool reuses idle Client objects across unrelated later connects,
  //    and the wrapper above mutates the client INSTANCE, not the pool —
  //    so restoring `pool.connect` alone (below) is not enough. If this
  //    specific client is released back to the pool still wrapped, the
  //    very next unrelated close() anywhere in the process (e.g. the next
  //    test) can reuse that same idle connection and spuriously throw the
  //    injected failure too. Restoring client.query on release() closes
  //    that hole regardless of success/failure/how the client is used.
  const realConnect = pool.connect.bind(pool);
  pool.connect = (cb) => {
    if (typeof cb === 'function') return realConnect(cb);
    return (async () => {
      const client = await realConnect();
      const realQuery = client.query.bind(client);
      const realRelease = client.release.bind(client);
      client.query = (...args) => {
        if (matchesClosedAtWrite(args[0])) throw new Error(INJECTED_MESSAGE);
        return realQuery(...args);
      };
      client.release = (...args) => {
        client.query = realQuery;
        client.release = realRelease;
        return realRelease(...args);
      };
      return client;
    })();
  };
  try {
    await assert.rejects(
      () => closeReq({ budget, accountId, start, resolutions, discrepancy: 'accept' }),
      new RegExp(INJECTED_MESSAGE),
      'the injected failure must propagate out of the route, not be swallowed'
    );
  } finally {
    pool.query = realPoolQuery;
    pool.connect = realConnect;
  }

  // 1. Period still open.
  const { rows: periodAfter } = await q('SELECT * FROM pay_periods WHERE id = $1', [periodRow.id]);
  assert.equal(periodAfter[0].closed_at, null, 'the period must still be open after a failed close');
  assert.equal(periodAfter[0].closed_snapshot, null, 'no snapshot must have been written');

  // 2. Line items byte-identical to pre-close state — clear/carry/remove must
  // all have rolled back together with the failed closed_at write.
  const { rows: afterItems } = await q(
    'SELECT id, pay_period_id, category_template_id, planned_amount_cents, cleared, account_id FROM line_items WHERE pay_period_id = $1 ORDER BY id',
    [periodRow.id]
  );
  assert.deepEqual(afterItems, beforeItems, 'line items in the target period must be exactly as they were before the failed close');

  // 3. No orphan "Close-out adjustment" row. This close never took the
  // adjust path (discrepancy: 'accept'), so none should exist regardless,
  // but this is the exact row category the pre-fix bug could leave dangling.
  const { rows: adjustmentTemplates } = await q(
    `SELECT id FROM category_templates WHERE budget_id = $1 AND name = 'Close-out adjustment'`,
    [budget.id]
  );
  assert.equal(adjustmentTemplates.length, 0, 'no Close-out adjustment category template must have been created');

  // 4. The carry target (next period) must not have gained the carried item —
  // materializePeriodAfter running ahead of the guarded transaction is
  // expected (it's an idempotent, harmless upsert per the route's own
  // comment), but the carry itself must not have landed there.
  const { rows: nextPeriod } = await q(
    'SELECT id FROM pay_periods WHERE budget_id = $1 AND account_id = $2 AND start_date > $3 ORDER BY start_date LIMIT 1',
    [budget.id, accountId, start]
  );
  if (nextPeriod.length) {
    const { rows: carriedIntoNext } = await q(
      'SELECT 1 FROM line_items WHERE pay_period_id = $1 AND category_template_id = $2',
      [nextPeriod[0].id, catIds.carry]
    );
    assert.equal(carriedIntoNext.length, 0, 'the carry item must not have landed in the next period');
  }
});

// Value-parity / silent-wrongness guard: the discrepancy and frozen snapshot
// computed *inside* the close transaction must equal the values you get by
// applying the same resolutions directly (auto-committing, exactly the
// pre-fix code's step 1), then reading them back on a plain pool connection
// (exactly the pre-fix code's steps 2/3 — which, unlike the atomicity bug,
// DID read correct values, because by then the resolutions were already
// committed). If buildProjection/clearedBalancesForPeriod were ever called
// inside the new single transaction WITHOUT threading `client`, they would
// read the pre-resolution numbers instead — the ones computed BEFORE
// resolving clear/carry/remove, i.e. what a caller reading the pool (which
// cannot see this transaction's still-uncommitted writes) would get — and
// this test would catch it.
//
// Getting a scenario where that distinction is even observable took working
// out this ledger's actual reconciliation math (see seedScenario's
// driftAmount doc comment): resolving every uncleared item in the CURRENT
// period always nets to a ZERO net contribution to that period's own
// discrepancy (clearing shifts clearedBalance but not est; carrying/removing
// shifts est but not clearedBalance; full resolution makes those cancel).
// So a fresh scenario with no prior history reconciles to a discrepancy of
// exactly 0 post-resolution regardless of dbc threading, which would make
// this test pass even against broken code — worthless. driftAmount seeds one
// permanently-uncleared item in a PRIOR closed period, which is what
// actually produces a nonzero post-resolution discrepancy (drift inherited
// from history, per the route's own comment) — and, critically, the
// pre-resolution figure still differs from it by exactly the current
// period's clear+carry+remove total, so the two really are distinguishable.
await test('discrepancy and frozen snapshot computed in-transaction match a reference computed after committing the same resolutions', async (t) => {
  const amounts = { clear: 5000, carry: 3000, remove: 2000 };
  const driftAmount = 7500;
  const reference = await seedScenario({ daysAgo: 14, amounts, driftAmount });
  const live = await seedScenario({ daysAgo: 14, amounts, driftAmount });
  t.after(() => Promise.all([
    cleanup(reference.budget.id, reference.userId),
    cleanup(live.budget.id, live.userId),
  ]));

  // Sanity: both scenarios are structurally identical (same relative dates,
  // same amounts, same drift), so their pre-resolution numbers must already
  // match — otherwise the two are not a valid twin pair.
  const preRef = await buildProjection(reference.budget, reference.cfg, { months: 12, accountId: reference.accountId });
  const preLive = await buildProjection(live.budget, live.cfg, { months: 12, accountId: live.accountId });
  const preEntryRef = preRef.entries.find((e) => e.start === reference.start);
  const preEntryLive = preLive.entries.find((e) => e.start === live.start);
  const preDiscrepancyRef = (preEntryRef?.estBalance ?? 0) - (preEntryRef?.clearedBalance ?? 0);
  const preDiscrepancyLive = (preEntryLive?.estBalance ?? 0) - (preEntryLive?.clearedBalance ?? 0);
  assert.equal(preDiscrepancyLive, preDiscrepancyRef, 'twin scenarios must start numerically identical');
  // The prior period's permanently-uncleared drift item must actually be
  // driving this — without it, pre-resolution discrepancy would be 0.
  assert.equal(preDiscrepancyRef, -driftAmount - (amounts.clear + amounts.carry + amounts.remove),
    'pre-resolution discrepancy must equal the drift plus every still-uncleared current-period item');

  // --- Reference: apply the exact same mutations the route applies for
  // clear/carry/remove, via plain q() (each statement auto-commits — this is
  // the pre-fix code's already-committed-by-the-time-it-reads shape), then
  // read discrepancy + snapshot on the plain pool.
  const refItems = reference.items;
  // ensureMaterialized only ever materializes through today's period (it
  // never proactively builds one ahead), so the carry target does not exist
  // yet — build it the exact same way the route does, via
  // materializePeriodAfter (an idempotent, self-contained-transaction
  // upsert; see server/routes/periods.js's comment on why it's safe to run
  // ahead of the close transaction itself).
  const refNext = await materializePeriodAfter(reference.budget.id, reference.accountId, reference.cfg, {
    start: reference.periodRow.start_date, end: reference.periodRow.end_date,
  });
  await q('UPDATE line_items SET cleared = TRUE, cleared_date = $1 WHERE id = $2', [todayISO(), refItems.clear.id]);
  await q(
    `INSERT INTO line_items (pay_period_id, category_template_id, planned_amount_cents, account_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (pay_period_id, category_template_id)
     DO UPDATE SET planned_amount_cents = line_items.planned_amount_cents + EXCLUDED.planned_amount_cents`,
    [refNext.id, refItems.carry.category_template_id, refItems.carry.planned_amount_cents, refItems.carry.account_id]
  );
  await q('DELETE FROM line_items WHERE id = $1', [refItems.carry.id]);
  await q('DELETE FROM line_items WHERE id = $1', [refItems.remove.id]);

  const postRef = await buildProjection(reference.budget, reference.cfg, { months: 12, accountId: reference.accountId });
  const postEntryRef = postRef.entries.find((e) => e.start === reference.start);
  const referenceDiscrepancy = (postEntryRef?.estBalance ?? 0) - (postEntryRef?.clearedBalance ?? 0);
  const referenceSnapshot = await clearedBalancesForPeriod(reference.budget, reference.cfg, reference.start, reference.accountId);

  // The scenario really does shift the discrepancy, AND the post-resolution
  // value is genuinely nonzero (purely the carried-forward drift) —
  // otherwise this test would pass even if dbc threading were broken.
  const totalShift = amounts.clear + amounts.carry + amounts.remove;
  assert.equal(referenceDiscrepancy, preDiscrepancyRef + totalShift, 'resolving these three items must shift the discrepancy by exactly their combined amount');
  assert.notEqual(referenceDiscrepancy, preDiscrepancyRef, 'pre- and post-resolution discrepancy must genuinely differ for this test to prove anything');
  assert.equal(referenceDiscrepancy, -driftAmount, 'post-resolution discrepancy must equal exactly the carried-forward drift, nothing from the current period');

  // --- Live: the real route, in one transaction.
  const liveItems = live.items;
  const resolutions = {
    [liveItems.clear.id]: 'clear',
    [liveItems.carry.id]: 'carry',
    [liveItems.remove.id]: 'remove',
  };
  const { body } = await closeReq({
    budget: live.budget, accountId: live.accountId, start: live.start, resolutions, discrepancy: 'adjust',
  });

  assert.equal(body.snapshot.total, referenceSnapshot.total, 'the in-transaction frozen snapshot must match the reference computed after committing the same resolutions');

  // The route's discrepancy is recorded as the "Close-out adjustment" line
  // item's amount (its sign is implied by the category type). Confirm it
  // equals the reference discrepancy magnitude and direction.
  const { rows: adjItem } = await q(
    `SELECT li.planned_amount_cents, ct.type FROM line_items li
     JOIN category_templates ct ON ct.id = li.category_template_id
     WHERE li.pay_period_id = $1 AND ct.name = 'Close-out adjustment'`,
    [live.periodRow.id]
  );
  assert.equal(adjItem.length, 1, 'an adjustment line item must have been created for a nonzero discrepancy');
  const liveDiscrepancy = adjItem[0].type === 'expense' ? adjItem[0].planned_amount_cents : -adjItem[0].planned_amount_cents;
  assert.equal(liveDiscrepancy, referenceDiscrepancy, 'the route-computed discrepancy must match the reference value');
});

test.after(() => pool.end());
