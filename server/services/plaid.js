import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { config } from '../config.js';
import { pool, q } from '../db.js';
import {
  getConfig, ensureMaterialized, loadTemplates, driftFor, clearLineItemForTransaction, setAmountGoingForward,
  getDefaultAccountId,
} from './budget.js';
import { decryptSecret, encryptSecret, isEncrypted } from './secrets.js';
import { loadRules, firstMatchingCategory } from './rules.js';

// Bank sync is optional: without PLAID_CLIENT_ID/PLAID_SECRET the feature is
// hidden and no Plaid code runs.
export const plaidEnabled = () => Boolean(config.plaid.clientId && config.plaid.secret);

let client = null;
export function plaidClient() {
  if (!client) {
    client = new PlaidApi(new Configuration({
      basePath: PlaidEnvironments[config.plaid.env] || PlaidEnvironments.sandbox,
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': config.plaid.clientId,
          'PLAID-SECRET': config.plaid.secret,
        },
      },
    }));
  }
  return client;
}

// Plaid's sign convention: positive amount = money leaving the account.
function toTxn(plaidTxn) {
  const cents = Math.round(Math.abs(plaidTxn.amount) * 100);
  return {
    type: plaidTxn.amount >= 0 ? 'expense' : 'income',
    amountCents: cents,
    description: (plaidTxn.merchant_name || plaidTxn.name || '').trim() || null,
    date: plaidTxn.date,
    hash: `plaid:${plaidTxn.transaction_id}`,
  };
}

// One-time boot pass: encrypt any legacy plaintext access tokens.
export async function encryptLegacyTokens() {
  const { rows } = await q('SELECT id, access_token FROM plaid_items');
  let n = 0;
  for (const r of rows) {
    if (isEncrypted(r.access_token)) continue;
    await q('UPDATE plaid_items SET access_token = $1 WHERE id = $2', [encryptSecret(r.access_token), r.id]);
    n++;
  }
  return n;
}

// Resolve (and cache on ctx) the pay-period config for a template's own
// account, since a template's account may run a different cadence than the
// household's default account whose cfg was loaded for the whole sync.
async function cfgForTemplate(ctx, template) {
  const acctId = template.account_id ?? ctx.defaultAccountId;
  if (!ctx.cfgByAccount.has(acctId)) {
    ctx.cfgByAccount.set(acctId, await getConfig(ctx.budget.id, acctId));
  }
  return ctx.cfgByAccount.get(acctId) || ctx.cfg;
}

async function insertSyncedTxn(clientDb, ctx, link, plaidTxn, userId, results) {
  const { budget } = ctx;
  const t = toTxn(plaidTxn);
  if (t.amountCents === 0) return;
  const { rows: period } = await clientDb.query(
    'SELECT id, closed_at FROM pay_periods WHERE budget_id = $1 AND account_id = $3 AND start_date <= $2 AND end_date >= $2 ORDER BY start_date DESC LIMIT 1',
    [budget.id, t.date, link.account_id]
  );
  if (!period.length) {
    results.skipped += 1; // before the household's first period, or future-dated
    return;
  }
  const periodClosed = Boolean(period[0].closed_at);

  // Categorization rules auto-match (first match in user order wins). A
  // recurring match marks the period's line item cleared with the actual
  // amount, exactly like a confirmed CSV row; a tag match just labels it.
  // In a CLOSED (frozen) period a recurring match is left uncategorized for
  // review instead — reconciliation there requires reopening.
  let categoryId = firstMatchingCategory(ctx.rules, {
    description: t.description,
    amountCents: t.amountCents,
    account: ctx.accountsById.get(link.account_id) || null,
  });
  let template = categoryId ? ctx.templatesById.get(categoryId) : null;
  if (template && periodClosed && template.category_type === 'recurring') {
    template = null;
    results.inClosed += 1;
  }
  if (!template) categoryId = null;
  else t.type = template.type;

  const { rows: inserted } = await clientDb.query(
    `INSERT INTO transactions (budget_id, user_id, pay_period_id, category_template_id, type, amount_cents, description, date, import_hash, account_id, categorized_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (budget_id, import_hash) WHERE import_hash IS NOT NULL DO NOTHING
     RETURNING id`,
    [budget.id, userId, period[0].id, categoryId, t.type, t.amountCents, t.description, t.date, t.hash, link.account_id,
     categoryId ? 'rule' : null]
  );
  if (!inserted.length) {
    results.duplicates += 1;
    return;
  }
  results.added += 1;
  if (template && template.category_type === 'recurring') {
    const drift = driftFor(budget, template, t.amountCents, t.date);
    const { cleared, moved } = await clearLineItemForTransaction(clientDb, template, {
      periodId: period[0].id,
      date: t.date,
      amountCents: t.amountCents,
      accountId: link.account_id,
      updatePlanned: true,
    });
    if (cleared) results.cleared += 1;
    if (moved) results.moved += 1;
    // A material difference from plan auto-updates the recurring amount going
    // forward, exactly like a confirmed CSV import.
    if (drift && ctx.cfg) {
      const templateCfg = await cfgForTemplate(ctx, template);
      await setAmountGoingForward(clientDb, budget.id, templateCfg, template.id, t.amountCents, t.date);
      results.drift.push(drift);
      results.replanned += 1;
    }
  }
}

// Pull new/changed/removed transactions for every linked item of a budget,
// using Plaid's cursor-based sync so each change is seen exactly once.
export async function syncBudget(budget, userId) {
  const cfg = await getConfig(budget.id);
  if (!cfg) throw Object.assign(new Error('Complete setup first'), { status: 400 });
  await ensureMaterialized(budget.id, cfg);

  const { rows: items } = await q('SELECT * FROM plaid_items WHERE budget_id = $1', [budget.id]);
  const results = { added: 0, duplicates: 0, updated: 0, removed: 0, skipped: 0, cleared: 0, moved: 0, inClosed: 0, notReady: 0, replanned: 0, drift: [] };
  const { rows: accountRows } = await q('SELECT * FROM accounts WHERE budget_id = $1', [budget.id]);
  const defaultAccountId = await getDefaultAccountId(budget.id);
  const ctx = {
    budget,
    cfg,
    defaultAccountId,
    cfgByAccount: new Map([[defaultAccountId, cfg]]),
    rules: await loadRules(budget.id),
    templatesById: new Map((await loadTemplates(budget.id, { includeArchived: true })).map((t) => [t.id, t])),
    accountsById: new Map(accountRows.map((a) => [a.id, a])),
  };

  for (const item of items) {
    const { rows: links } = await q(
      'SELECT * FROM plaid_account_links WHERE plaid_item_id = $1 AND account_id IS NOT NULL', [item.id]
    );
    const linkByPlaidAccount = new Map(links.map((l) => [l.plaid_account_id, l]));

    let cursor = item.cursor || undefined;
    let hasMore = true;
    const clientDb = await pool.connect();
    try {
      await clientDb.query('BEGIN');
      while (hasMore) {
        let data;
        try {
          ({ data } = await plaidClient().transactionsSync({
            access_token: decryptSecret(item.access_token),
            cursor,
            count: 500,
          }));
        } catch (err) {
          // A brand-new item takes a little while to prepare transactions.
          if (err.response?.data?.error_code === 'PRODUCT_NOT_READY') {
            results.notReady += 1;
            hasMore = false;
            break;
          }
          throw err;
        }
        for (const txn of data.added) {
          if (txn.pending) continue; // only posted transactions enter the books
          const link = linkByPlaidAccount.get(txn.account_id);
          if (!link) continue;
          await insertSyncedTxn(clientDb, ctx, link, txn, userId, results);
        }
        for (const txn of data.modified) {
          if (txn.pending) continue;
          const link = linkByPlaidAccount.get(txn.account_id);
          if (!link) continue;
          const t = toTxn(txn);
          const { rows: period } = await clientDb.query(
            'SELECT id FROM pay_periods WHERE budget_id = $1 AND account_id = $3 AND start_date <= $2 AND end_date >= $2 ORDER BY start_date DESC LIMIT 1',
            [budget.id, t.date, link.account_id]
          );
          if (!period.length) continue;
          const { rowCount } = await clientDb.query(
            `UPDATE transactions SET amount_cents = $1, description = $2, date = $3, pay_period_id = $4
             WHERE budget_id = $5 AND import_hash = $6`,
            [t.amountCents, t.description, t.date, period[0].id, budget.id, t.hash]
          );
          if (rowCount) results.updated += 1;
          else await insertSyncedTxn(clientDb, ctx, link, txn, userId, results);
        }
        for (const removed of data.removed) {
          const { rowCount } = await clientDb.query(
            'DELETE FROM transactions WHERE budget_id = $1 AND import_hash = $2',
            [budget.id, `plaid:${removed.transaction_id}`]
          );
          if (rowCount) results.removed += 1;
        }
        cursor = data.next_cursor;
        hasMore = data.has_more;
      }
      if (cursor && !results.notReady) {
        await clientDb.query(
          'UPDATE plaid_items SET cursor = $1, last_synced_at = now() WHERE id = $2',
          [cursor, item.id]
        );
      }
      await clientDb.query('COMMIT');
    } catch (err) {
      await clientDb.query('ROLLBACK');
      throw err;
    } finally {
      clientDb.release();
    }
  }
  return results;
}
