import { Router } from 'express';
import { pool, q } from '../db.js';
import { config } from '../config.js';
import { encryptSecret } from '../services/secrets.js';
import { bad, requireId } from '../validation.js';
import { claimSetupToken, fetchAccounts, syncBudget } from '../services/simplefin.js';

const router = Router();

// Bank sync is opt-in (BANK_SYNC_ENABLED=true). When disabled, every route
// below except GET /status 404s - not 403, so a disabled feature is
// indistinguishable from a route that doesn't exist. GET /status is the sole
// exception: it always responds 200 so the frontend can decide whether to
// render, but leaks nothing when disabled (no DB query, no connection data).
router.use((req, res, next) => {
  if (config.simplefin.enabled) return next();
  if (req.method === 'GET' && req.path === '/status') {
    return res.json({ enabled: false, connections: [] });
  }
  return res.status(404).end();
});

router.get('/status', async (req, res, next) => {
  try {
    const { rows: connections } = await q(
      'SELECT id, label, last_synced_at, created_at FROM simplefin_connections WHERE budget_id = $1 ORDER BY id',
      [req.budget.id]
    );
    const { rows: links } = await q(
      `SELECT l.* FROM simplefin_account_links l
       JOIN simplefin_connections c ON c.id = l.connection_id WHERE c.budget_id = $1 ORDER BY l.id`,
      [req.budget.id]
    );
    res.json({
      enabled: true,
      connections: connections.map((c) => ({
        id: c.id,
        label: c.label,
        lastSyncedAt: c.last_synced_at,
        accounts: links.filter((l) => l.connection_id === c.id).map((l) => ({
          id: l.id,
          sfAccountId: l.sf_account_id,
          name: l.sf_name,
          org: l.sf_org_name,
          currency: l.sf_currency,
          accountId: l.account_id,
        })),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Claim a one-time setup token, then discover this access URL's bank
// accounts (balances only - no transaction history needed until an
// account is mapped) and store them as unmapped links. The access URL
// itself is a credential and is never in the response.
router.post('/claim', async (req, res, next) => {
  try {
    const setupToken = req.body?.setupToken;
    if (typeof setupToken !== 'string' || !setupToken.trim() || setupToken.length > 4096) {
      bad('setupToken is required');
    }
    const accessUrl = await claimSetupToken(setupToken.trim());
    const accounts = await fetchAccounts(accessUrl, null, { balancesOnly: true });

    const clientDb = await pool.connect();
    try {
      await clientDb.query('BEGIN');
      const { rows: conn } = await clientDb.query(
        'INSERT INTO simplefin_connections (budget_id, access_url, created_by) VALUES ($1, $2, $3) RETURNING id',
        [req.budget.id, encryptSecret(accessUrl), req.userId]
      );
      for (const acct of accounts) {
        await clientDb.query(
          `INSERT INTO simplefin_account_links (connection_id, sf_account_id, sf_name, sf_org_name, sf_currency)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (connection_id, sf_account_id) DO NOTHING`,
          [conn[0].id, acct.id, acct.name || null, acct.org?.name || null, acct.currency || null]
        );
      }
      await clientDb.query('COMMIT');
      res.status(201).json({ connectionId: conn[0].id });
    } catch (err) {
      await clientDb.query('ROLLBACK');
      throw err;
    } finally {
      clientDb.release();
    }
  } catch (err) {
    next(err);
  }
});

// Map a bank account to one of ours (base currency only), or null to stop
// syncing it.
router.patch('/links/:id', async (req, res, next) => {
  try {
    const id = requireId(req.params.id, 'bank account');
    const { rows: link } = await q(
      `SELECT l.id FROM simplefin_account_links l JOIN simplefin_connections c ON c.id = l.connection_id
       WHERE l.id = $1 AND c.budget_id = $2`,
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
    await q('UPDATE simplefin_account_links SET account_id = $1 WHERE id = $2', [accountId, id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/sync', async (req, res, next) => {
  try {
    res.json(await syncBudget(req.budget, req.userId));
  } catch (err) {
    next(err);
  }
});

router.delete('/connections/:id', async (req, res, next) => {
  try {
    const id = requireId(req.params.id, 'bank connection');
    const { rows } = await q(
      'SELECT id FROM simplefin_connections WHERE id = $1 AND budget_id = $2',
      [id, req.budget.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Bank connection not found' });
    await q('DELETE FROM simplefin_connections WHERE id = $1', [rows[0].id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
