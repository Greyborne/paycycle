import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { config } from '../config.js';
import { pool, q } from '../db.js';
import { getConfig, ensureMaterialized } from './budget.js';

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

async function matchRule(clientDb, budgetId, description) {
  if (!description) return null;
  const { rows } = await clientDb.query(
    'SELECT pattern, category_template_id FROM import_rules WHERE budget_id = $1 ORDER BY length(pattern) DESC',
    [budgetId]
  );
  const lower = description.toLowerCase();
  for (const r of rows) {
    if (lower.includes(r.pattern.toLowerCase())) return r.category_template_id;
  }
  return null;
}

async function insertSyncedTxn(clientDb, budget, link, plaidTxn, userId, results) {
  const t = toTxn(plaidTxn);
  if (t.amountCents === 0) return;
  const { rows: period } = await clientDb.query(
    'SELECT id FROM pay_periods WHERE budget_id = $1 AND start_date <= $2 AND end_date >= $2 ORDER BY start_date DESC LIMIT 1',
    [budget.id, t.date]
  );
  if (!period.length) {
    results.skipped += 1; // before the household's first period, or future-dated
    return;
  }

  // Learned import rules auto-categorize; a match marks the period's line
  // item cleared with the actual amount, exactly like a confirmed CSV row.
  let categoryId = await matchRule(clientDb, budget.id, t.description);
  if (categoryId) {
    const { rows: cat } = await clientDb.query(
      'SELECT type FROM category_templates WHERE id = $1 AND budget_id = $2', [categoryId, budget.id]
    );
    if (!cat.length) categoryId = null;
    else t.type = cat[0].type;
  }

  const { rows: inserted } = await clientDb.query(
    `INSERT INTO transactions (budget_id, user_id, pay_period_id, category_template_id, type, amount_cents, description, date, import_hash, account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (budget_id, import_hash) WHERE import_hash IS NOT NULL DO NOTHING
     RETURNING id`,
    [budget.id, userId, period[0].id, categoryId, t.type, t.amountCents, t.description, t.date, t.hash, link.account_id]
  );
  if (!inserted.length) {
    results.duplicates += 1;
    return;
  }
  results.added += 1;
  if (categoryId) {
    const { rowCount } = await clientDb.query(
      `UPDATE line_items SET cleared = TRUE, cleared_date = $1, planned_amount_cents = $2, account_id = $3
       WHERE pay_period_id = $4 AND category_template_id = $5`,
      [t.date, t.amountCents, link.account_id, period[0].id, categoryId]
    );
    if (rowCount) results.cleared += 1;
  }
}

// Pull new/changed/removed transactions for every linked item of a budget,
// using Plaid's cursor-based sync so each change is seen exactly once.
export async function syncBudget(budget, userId) {
  const cfg = await getConfig(budget.id);
  if (!cfg) throw Object.assign(new Error('Complete setup first'), { status: 400 });
  await ensureMaterialized(budget.id, cfg);

  const { rows: items } = await q('SELECT * FROM plaid_items WHERE budget_id = $1', [budget.id]);
  const results = { added: 0, duplicates: 0, updated: 0, removed: 0, skipped: 0, cleared: 0, notReady: 0 };

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
            access_token: item.access_token,
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
          await insertSyncedTxn(clientDb, budget, link, txn, userId, results);
        }
        for (const txn of data.modified) {
          if (txn.pending) continue;
          const link = linkByPlaidAccount.get(txn.account_id);
          if (!link) continue;
          const t = toTxn(txn);
          const { rows: period } = await clientDb.query(
            'SELECT id FROM pay_periods WHERE budget_id = $1 AND start_date <= $2 AND end_date >= $2 ORDER BY start_date DESC LIMIT 1',
            [budget.id, t.date]
          );
          if (!period.length) continue;
          const { rowCount } = await clientDb.query(
            `UPDATE transactions SET amount_cents = $1, description = $2, date = $3, pay_period_id = $4
             WHERE budget_id = $5 AND import_hash = $6`,
            [t.amountCents, t.description, t.date, period[0].id, budget.id, t.hash]
          );
          if (rowCount) results.updated += 1;
          else await insertSyncedTxn(clientDb, budget, link, txn, userId, results);
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
