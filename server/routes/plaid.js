import { Router } from 'express';
import { q } from '../db.js';
import { decryptSecret, encryptSecret } from '../services/secrets.js';
import { config } from '../config.js';
import { bad, requireId } from '../validation.js';
import { plaidEnabled, plaidClient, syncBudget } from '../services/plaid.js';

const router = Router();

router.get('/status', async (req, res, next) => {
  try {
    if (!plaidEnabled()) return res.json({ enabled: false, items: [] });
    const { rows: items } = await q(
      'SELECT id, institution_name, last_synced_at, created_at FROM plaid_items WHERE budget_id = $1 ORDER BY id',
      [req.budget.id]
    );
    const { rows: links } = await q(
      `SELECT l.* FROM plaid_account_links l
       JOIN plaid_items i ON i.id = l.plaid_item_id WHERE i.budget_id = $1 ORDER BY l.id`,
      [req.budget.id]
    );
    res.json({
      enabled: true,
      environment: config.plaid.env,
      items: items.map((i) => ({
        id: i.id,
        institution: i.institution_name,
        lastSyncedAt: i.last_synced_at,
        accounts: links.filter((l) => l.plaid_item_id === i.id).map((l) => ({
          id: l.id,
          plaidAccountId: l.plaid_account_id,
          name: l.plaid_name,
          mask: l.plaid_mask,
          accountId: l.account_id,
        })),
      })),
    });
  } catch (err) {
    next(err);
  }
});

function requirePlaid() {
  if (!plaidEnabled()) bad('Bank sync is not configured on this server');
}

router.post('/link-token', async (req, res, next) => {
  try {
    requirePlaid();
    const { data } = await plaidClient().linkTokenCreate({
      user: { client_user_id: String(req.userId) },
      client_name: 'PayCycle',
      products: ['transactions'],
      country_codes: config.plaid.countryCodes,
      language: 'en',
    });
    res.json({ linkToken: data.link_token });
  } catch (err) {
    next(err);
  }
});

// Exchange the public token from a completed Link flow, store the item, and
// return its bank accounts so the user can map them to PayCycle accounts.
router.post('/exchange', async (req, res, next) => {
  try {
    requirePlaid();
    const publicToken = req.body?.publicToken;
    if (typeof publicToken !== 'string' || !publicToken) bad('publicToken is required');

    const { data: exchange } = await plaidClient().itemPublicTokenExchange({ public_token: publicToken });
    const { data: accounts } = await plaidClient().accountsGet({ access_token: exchange.access_token });
    const institution = req.body?.institutionName
      || accounts.item?.institution_name
      || accounts.item?.institution_id
      || 'Bank';

    const { rows: item } = await q(
      `INSERT INTO plaid_items (budget_id, item_id, access_token, institution_name, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (item_id) DO UPDATE SET access_token = $3
       RETURNING id`,
      [req.budget.id, exchange.item_id, encryptSecret(exchange.access_token), institution, req.userId]
    );
    for (const acct of accounts.accounts) {
      await q(
        `INSERT INTO plaid_account_links (plaid_item_id, plaid_account_id, plaid_name, plaid_mask)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (plaid_item_id, plaid_account_id) DO NOTHING`,
        [item[0].id, acct.account_id, acct.name, acct.mask]
      );
    }
    res.status(201).json({ itemId: item[0].id });
  } catch (err) {
    next(err);
  }
});

// Map a bank account to one of ours (base currency only), or null to stop
// syncing it.
router.patch('/links/:id', async (req, res, next) => {
  try {
    requirePlaid();
    const id = requireId(req.params.id, 'bank account');
    const { rows: link } = await q(
      `SELECT l.id FROM plaid_account_links l JOIN plaid_items i ON i.id = l.plaid_item_id
       WHERE l.id = $1 AND i.budget_id = $2`,
      [id, req.budget.id]
    );
    if (!link.length) return res.status(404).json({ error: 'Bank account not found' });
    let accountId = null;
    if (req.body?.accountId !== undefined && req.body.accountId !== null) {
      const { rows: acct } = await q(
        'SELECT id FROM accounts WHERE id = $1 AND budget_id = $2 AND currency IS NULL AND NOT archived',
        [req.body.accountId, req.budget.id]
      );
      if (!acct.length) bad('Bank accounts can only sync into active household-currency accounts');
      accountId = req.body.accountId;
    }
    await q('UPDATE plaid_account_links SET account_id = $1 WHERE id = $2', [accountId, id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/sync', async (req, res, next) => {
  try {
    requirePlaid();
    res.json(await syncBudget(req.budget, req.userId));
  } catch (err) {
    next(err);
  }
});

router.delete('/items/:id', async (req, res, next) => {
  try {
    requirePlaid();
    const id = requireId(req.params.id, 'bank connection');
    const { rows } = await q(
      'SELECT * FROM plaid_items WHERE id = $1 AND budget_id = $2',
      [id, req.budget.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Bank connection not found' });
    try {
      await plaidClient().itemRemove({ access_token: decryptSecret(rows[0].access_token) });
    } catch {
      // The item may already be revoked on Plaid's side; still remove ours.
    }
    await q('DELETE FROM plaid_items WHERE id = $1', [rows[0].id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
