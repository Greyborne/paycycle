import { Router } from 'express';
import { pool, q } from '../db.js';
import { bad, parseCadenceConfig, requireCents, requireCurrency, requireDate, requireId } from '../validation.js';
import { accountBalances, getConfig, getDefaultAccountId, recomputeLineItemActual } from '../services/budget.js';
import { periodContaining, todayISO } from '../services/schedule.js';

const router = Router();

const TYPES = ['checking', 'savings', 'credit', 'cash', 'other'];

function publicAccount(a) {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    currency: a.currency, // null = household base currency
    startingBalanceCents: a.starting_balance_cents,
    balanceCents: a.balance_cents,
    isDefault: a.is_default,
    archived: a.archived,
    sortOrder: a.sort_order,
    startedOn: a.started_on ?? null,
    institution: a.institution ?? null,
    numberMask: a.number_mask ?? null,
    source: a.source ?? 'manual',
  };
}

// Snap a requested tracking-start date to the pay period that contains it
// (defaulting to today's period), so an account's start always lands on a
// real period boundary.
async function resolveStartedOn(budget, raw) {
  const cfg = await getConfig(budget.id);
  const date = raw ? requireDate(raw, 'startedOn') : todayISO();
  return cfg ? periodContaining(cfg, date).start : date;
}

// Normalize a requested currency against the household's base: base currency
// is stored as NULL; anything else marks the account as a foreign-currency
// tracked account (own unit, outside period budget math).
// Only the last 4 digits of an account number are ever stored.
function normalizeMask(value) {
  if (value === undefined || value === null) return null;
  const digits = String(value).replace(/\D/g, '');
  return digits ? digits.slice(-4) : null;
}

function normalizeText(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : null;
}

function normalizeCurrency(value, budget) {
  if (value === undefined || value === null || value === '') return null;
  const code = requireCurrency(value);
  return code === budget.currency ? null : code;
}

router.get('/', async (req, res, next) => {
  try {
    const rows = await accountBalances(req.budget.id);
    res.json({ accounts: rows.map(publicAccount) });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { name, type } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) bad('name is required');
    if (type !== undefined && !TYPES.includes(type)) bad(`type must be one of ${TYPES.join(', ')}`);
    const starting = requireCents(req.body.startingBalanceCents ?? 0, 'startingBalanceCents');
    const currency = normalizeCurrency(req.body.currency, req.budget);
    const startedOn = await resolveStartedOn(req.budget, req.body.startedOn);

    // Base-currency accounts budget on the pay-period cadence and need their
    // own config row (migration 013). Foreign-currency (tracked) accounts
    // never budget, so they get none - any requested cadence for one is
    // silently ignored.
    //
    // Validate the cadence choice BEFORE writing anything: parseCadenceConfig
    // can throw (e.g. bad intervalDays), and that must leave zero rows behind
    // rather than an orphaned, unconfigured account.
    let explicitCfg = null;
    if (currency === null && req.body.cadence !== undefined) {
      // User picked this account's own cadence rather than inheriting the
      // default account's. Derivation rules (anchor = this account's
      // tracking-from date, `startedOn`):
      //   weekly/biweekly -> anchorDate = startedOn
      //   custom          -> anchorDate = startedOn, intervalDays from body
      //   monthly         -> day1 = day-of-month of startedOn
      //   semimonthly     -> day1 = 1, day2 = 15 (common default; refine
      //                      later in Settings -> Pay schedule)
      // Built as a plain cadence body and run through the same
      // parseCadenceConfig validation used elsewhere, so invalid input
      // (e.g. missing/out-of-range intervalDays for custom) is rejected
      // consistently.
      const cadence = req.body.cadence;
      const cadenceBody = { cadence };
      if (cadence === 'weekly' || cadence === 'biweekly') {
        cadenceBody.anchorDate = startedOn;
      } else if (cadence === 'custom') {
        cadenceBody.anchorDate = startedOn;
        cadenceBody.intervalDays = req.body.intervalDays;
      } else if (cadence === 'monthly') {
        cadenceBody.day1 = Number(startedOn.slice(8, 10));
      } else if (cadence === 'semimonthly') {
        cadenceBody.day1 = 1;
        cadenceBody.day2 = 15;
      }
      explicitCfg = parseCadenceConfig(cadenceBody);
    }

    await client.query('BEGIN');
    const { rows: maxOrder } = await client.query(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM accounts WHERE budget_id = $1',
      [req.budget.id]
    );
    const { rows: inserted } = await client.query(
      `INSERT INTO accounts (budget_id, name, type, starting_balance_cents, sort_order, currency, institution, number_mask, started_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [req.budget.id, name.trim(), type || 'checking', starting, maxOrder[0].next, currency,
       normalizeText(req.body.institution), normalizeMask(req.body.numberMask), startedOn]
    );

    if (currency === null) {
      if (explicitCfg) {
        await client.query(
          `INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date, day_1, day_2, interval_days)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (account_id) DO NOTHING`,
          [req.budget.id, inserted[0].id, explicitCfg.cadence, explicitCfg.anchor_date,
           explicitCfg.day_1, explicitCfg.day_2, explicitCfg.interval_days]
        );
      } else {
        // No cadence chosen: keep legacy behaviour and inherit the
        // household's default account's cadence rather than starting
        // unconfigured.
        const defaultAccountId = await getDefaultAccountId(req.budget.id);
        const defaultCfg = await getConfig(req.budget.id, defaultAccountId);
        if (defaultCfg) {
          await client.query(
            `INSERT INTO pay_period_configs (budget_id, account_id, cadence, anchor_date, day_1, day_2, interval_days)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (account_id) DO NOTHING`,
            [req.budget.id, inserted[0].id, defaultCfg.cadence, defaultCfg.anchor_date,
             defaultCfg.day_1, defaultCfg.day_2, defaultCfg.interval_days]
          );
        }
      }
    }
    await client.query('COMMIT');
    const rows = await accountBalances(req.budget.id);
    res.status(201).json({ accounts: rows.map(publicAccount) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.patch('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = requireId(req.params.id, 'account');
    const { rows: existing } = await q(
      'SELECT * FROM accounts WHERE id = $1 AND budget_id = $2', [id, req.budget.id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Account not found' });
    const a = existing[0];
    const body = req.body || {};

    const name = body.name !== undefined
      ? (typeof body.name === 'string' && body.name.trim() ? body.name.trim() : bad('name cannot be empty'))
      : a.name;
    if (body.type !== undefined && !TYPES.includes(body.type)) bad(`type must be one of ${TYPES.join(', ')}`);
    const type = body.type ?? a.type;
    const starting = body.startingBalanceCents !== undefined
      ? requireCents(body.startingBalanceCents, 'startingBalanceCents') : a.starting_balance_cents;
    // Editing the start date only re-anchors the label and future category
    // defaults; it never rewrites existing line items.
    const startedOn = body.startedOn !== undefined
      ? await resolveStartedOn(req.budget, body.startedOn) : a.started_on;
    const archived = body.archived !== undefined ? Boolean(body.archived) : a.archived;
    const makeDefault = body.isDefault === true && !a.is_default;
    if (a.is_default && archived) bad('Make another account the default before archiving this one');
    if (makeDefault && archived) bad('An archived account cannot be the default');

    let currency = a.currency;
    if (body.currency !== undefined) {
      currency = normalizeCurrency(body.currency, req.budget);
      if (currency !== a.currency) {
        // Amounts never convert - only allow re-denominating an account that
        // has no budget history attached.
        const { rows: items } = await q(
          'SELECT 1 FROM line_items WHERE account_id = $1 LIMIT 1', [id]
        );
        if (items.length) bad('This account has cleared budget items and cannot change currency');
      }
    }
    if (currency !== null && (makeDefault || a.is_default)) {
      bad('The default account must use the household currency');
    }

    await client.query('BEGIN');
    if (makeDefault) {
      await client.query(
        'UPDATE accounts SET is_default = FALSE WHERE budget_id = $1 AND is_default',
        [req.budget.id]
      );
    }
    await client.query(
      `UPDATE accounts SET name = $1, type = $2, starting_balance_cents = $3, archived = $4,
         is_default = $5, currency = $6, started_on = $8 WHERE id = $7`,
      [name, type, starting, archived, makeDefault || a.is_default, currency, id, startedOn]
    );
    await client.query('COMMIT');
    const rows = await accountBalances(req.budget.id);
    res.json({ accounts: rows.map(publicAccount) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Tier 1 data-reset: wipe every transaction for this account, but only the
// ones sitting in an OPEN pay period — closed periods are the frozen
// audited record (§5/§6) and must never be touched by this route, so the
// delete is scoped through pay_periods.closed_at IS NULL, not just
// account_id. Afterward, every recurring line item that lost a transaction
// must have its cleared_amount_cents recomputed (same single-item pattern
// as transactions.js's DELETE /:id, just looped over every distinct
// (pay_period_id, category_template_id) pair touched by this wipe).
router.delete('/:id/transactions', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = requireId(req.params.id, 'account');
    const { rows: existing } = await q(
      'SELECT id FROM accounts WHERE id = $1 AND budget_id = $2', [id, req.budget.id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Account not found' });

    await client.query('BEGIN');
    // Every distinct line item this wipe will orphan, so it can be
    // recomputed after the delete. Only recurring-category transactions
    // have a matching line item; tag/misc transactions need no recompute.
    const { rows: affected } = await client.query(
      `SELECT DISTINCT t.pay_period_id, t.category_template_id
       FROM transactions t
       JOIN pay_periods pp ON pp.id = t.pay_period_id
       WHERE t.account_id = $1 AND pp.closed_at IS NULL AND t.category_template_id IS NOT NULL`,
      [id]
    );
    const { rowCount: deleted } = await client.query(
      `DELETE FROM transactions
       WHERE account_id = $1
         AND pay_period_id IN (
           SELECT id FROM pay_periods WHERE account_id = $1 AND closed_at IS NULL
         )`,
      [id]
    );
    for (const row of affected) {
      await recomputeLineItemActual(client, row.pay_period_id, row.category_template_id);
    }
    await client.query('COMMIT');
    res.json({ deleted });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Tier 2 data-reset: "fresh start, keep structure." Wipes this account's
// OPEN pay_periods (transactions cascade-delete with them via
// transactions.pay_period_id ON DELETE CASCADE, and so do their line_items
// via line_items.pay_period_id ON DELETE CASCADE - see migrations/001_init.sql),
// then re-dates accounts.started_on. Closed periods - their transactions,
// line_items, and closed_snapshot - are NEVER deleted or altered here, full
// stop; that is the one invariant this route may never trade away, no
// matter what the request body says. Categories/category_rules/
// category_amount_history are untouched by design (kept on purpose).
router.post('/:id/reset', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = requireId(req.params.id, 'account');
    const { rows: existing } = await q(
      'SELECT id FROM accounts WHERE id = $1 AND budget_id = $2', [id, req.budget.id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Account not found' });

    const body = req.body || {};
    const closedPeriods = body.closedPeriods === 'confirm' ? 'confirm' : 'block';
    const startedOn = await resolveStartedOn(req.budget, body.startedOn);

    // Find the earliest closed period for this account, if any. Closed
    // periods are never touched by this route regardless of `closedPeriods`
    // - that flag only controls whether a nonsensical request (re-dating the
    // tracking start to at/before an already-closed period) is allowed to
    // proceed anyway, not whether closed data can be touched.
    const { rows: earliestClosed } = await q(
      `SELECT start_date FROM pay_periods
       WHERE account_id = $1 AND closed_at IS NOT NULL
       ORDER BY start_date ASC LIMIT 1`,
      [id]
    );
    if (earliestClosed.length && startedOn <= earliestClosed[0].start_date) {
      if (closedPeriods !== 'confirm') {
        bad(`This account has a closed period starting ${earliestClosed[0].start_date}; ` +
          `startedOn must be after that date. Pass closedPeriods: 'confirm' to acknowledge and proceed ` +
          `(the closed period itself is never touched).`);
      }
      // Acknowledged: proceed, but the closed period(s) are still left
      // completely alone below - only the open tail is ever wiped.
    }

    await client.query('BEGIN');
    const { rowCount: deletedTransactions } = await client.query(
      `DELETE FROM transactions
       WHERE account_id = $1
         AND pay_period_id IN (
           SELECT id FROM pay_periods WHERE account_id = $1 AND closed_at IS NULL
         )`,
      [id]
    );
    // Deleting the open pay_periods rows cascades to their line_items
    // (and to any remaining transactions on them) automatically.
    const { rowCount: deletedPeriods } = await client.query(
      `DELETE FROM pay_periods WHERE account_id = $1 AND closed_at IS NULL`,
      [id]
    );
    await client.query('UPDATE accounts SET started_on = $1 WHERE id = $2', [startedOn, id]);
    await client.query('COMMIT');
    res.json({ deletedTransactions, deletedPeriods, startedOn });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Tier 3 data-reset: hard-delete the account itself (for closing a real
// bank account). Unlike Tiers 1/2, this DELIBERATELY takes this account's
// CLOSED periods down with it too - the account is going away entirely, so
// its frozen snapshots have nowhere left to live. This is the one place in
// the app where a closed period is not immutable; see docs/plans/data-reset.md
// Tier 3 and CONSTITUTION.md's note on this build. There is no down path:
// recovering from an unwanted delete is a full database restore, not an
// in-app undo.
//
// Cascade graph relied on below (verified against migrations/*.sql, not
// assumed):
//   - pay_period_configs.account_id -> accounts ON DELETE CASCADE (013)
//   - pay_periods.account_id        -> accounts ON DELETE CASCADE (013)
//   - line_items.pay_period_id      -> pay_periods ON DELETE CASCADE (001)
//     (line_items.account_id is ON DELETE SET NULL, but moot here - the
//     parent pay_periods row is gone first via the above)
//   - transactions.pay_period_id    -> pay_periods ON DELETE CASCADE (001)
//     (transactions.account_id is ON DELETE SET NULL, likewise moot)
//   - category_templates.account_id -> accounts ON DELETE SET NULL (004)
//   - simplefin_account_links.account_id -> accounts ON DELETE SET NULL (014)
// So a single `DELETE FROM accounts` removes every pay_period_config/
// pay_period/line_item/transaction that belonged to this account (closed
// periods included), unassigns any category_templates it owned (they fall
// back to the household's default account automatically via the existing
// `template.account_id ?? getDefaultAccountId()` read-time pattern used
// throughout server/services/budget.js - no new fallback code needed), and
// silently un-syncs any linked SimpleFIN account. category_rules are never
// touched directly - they're budget-owned and only reference a category,
// which itself just fell back to the default account.
router.delete('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = requireId(req.params.id, 'account');
    const { rows: existing } = await q(
      'SELECT id FROM accounts WHERE id = $1 AND budget_id = $2', [id, req.budget.id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Account not found' });

    await client.query('BEGIN');
    // Lock this row first, before re-checking is-default/is-only-account,
    // so a concurrent PATCH that flips another account's is_default (or
    // archives the last sibling account) can't race this delete and leave
    // the budget with zero accounts or no default. Mirrors the FOR UPDATE
    // fix in server/routes/auth.js's DELETE /account.
    await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [id]);

    const { rows: current } = await client.query(
      'SELECT is_default, archived FROM accounts WHERE id = $1 AND budget_id = $2',
      [id, req.budget.id]
    );
    if (!current.length) return res.status(404).json({ error: 'Account not found' });
    const a = current[0];

    const { rows: countRows } = await client.query(
      'SELECT count(*)::int AS n FROM accounts WHERE budget_id = $1', [req.budget.id]
    );
    if (countRows[0].n === 1) bad('A household must have at least one account');

    // Same guard as the PATCH /:id archive path (line ~188): a live default
    // account can't be removed out from under the household. Require the
    // caller to make another account default first.
    if (a.is_default && !a.archived) bad('Make another account the default before deleting this one');

    await client.query('DELETE FROM accounts WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

export default router;
