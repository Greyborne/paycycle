import crypto from 'node:crypto';
import { Router } from 'express';
import { pool, q } from '../db.js';
import { bad, HttpError } from '../validation.js';
import { createSoloBudget } from '../services/budget.js';

const router = Router();

function requireOwner(req) {
  if (req.budgetRole !== 'owner') throw new HttpError(403, 'Only the household owner can do that');
}

// Generate a short, unambiguous invite code (no 0/O/1/I).
function inviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(10), (b) => alphabet[b % alphabet.length]).join('');
}

router.get('/', async (req, res, next) => {
  try {
    const { rows: members } = await q(
      `SELECT u.id, u.email, m.role, m.created_at AS joined_at
       FROM budget_members m JOIN users u ON u.id = m.user_id
       WHERE m.budget_id = $1 ORDER BY m.created_at`,
      [req.budget.id]
    );
    let invites = [];
    if (req.budgetRole === 'owner') {
      const { rows } = await q(
        'SELECT id, code, expires_at, created_at FROM budget_invites WHERE budget_id = $1 AND expires_at > now() ORDER BY created_at DESC',
        [req.budget.id]
      );
      invites = rows;
    }
    res.json({
      id: req.budget.id,
      name: req.budget.name,
      role: req.budgetRole,
      members: members.map((m) => ({ id: m.id, email: m.email, role: m.role, joinedAt: m.joined_at })),
      invites: invites.map((i) => ({ id: i.id, code: i.code, expiresAt: i.expires_at })),
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/', async (req, res, next) => {
  try {
    const name = req.body?.name;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) bad('A household name is required (max 80 chars)');
    await q('UPDATE budgets SET name = $1 WHERE id = $2', [name.trim(), req.budget.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Create an invite code, valid for 7 days.
router.post('/invites', async (req, res, next) => {
  try {
    requireOwner(req);
    const { rows } = await q(
      `INSERT INTO budget_invites (budget_id, code, created_by, expires_at)
       VALUES ($1, $2, $3, now() + interval '7 days') RETURNING id, code, expires_at`,
      [req.budget.id, inviteCode(), req.userId]
    );
    res.status(201).json({ invite: { id: rows[0].id, code: rows[0].code, expiresAt: rows[0].expires_at } });
  } catch (err) {
    next(err);
  }
});

router.delete('/invites/:id', async (req, res, next) => {
  try {
    requireOwner(req);
    const { rowCount } = await q(
      'DELETE FROM budget_invites WHERE id = $1 AND budget_id = $2',
      [Number(req.params.id), req.budget.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Invite not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Detach a user from their current household. If they were the only member,
// the household and all its data are deleted; if they owned it with others
// remaining, the longest-standing member becomes owner.
async function detachFromCurrent(client, userId, budgetId) {
  await client.query('DELETE FROM budget_members WHERE user_id = $1', [userId]);
  const { rows: remaining } = await client.query(
    'SELECT id, role FROM budget_members WHERE budget_id = $1 ORDER BY created_at, id',
    [budgetId]
  );
  if (!remaining.length) {
    await client.query('DELETE FROM budgets WHERE id = $1', [budgetId]);
  } else if (!remaining.some((m) => m.role === 'owner')) {
    await client.query("UPDATE budget_members SET role = 'owner' WHERE id = $1", [remaining[0].id]);
  }
}

// Join another household by invite code. Leaves the current one; when the
// caller is its only member that deletes the old household's data, so the
// client must send confirm: true if the current budget has any periods.
router.post('/join', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!code) bad('An invite code is required');
    const { rows: invites } = await q(
      'SELECT * FROM budget_invites WHERE upper(code) = $1 AND expires_at > now()',
      [code]
    );
    if (!invites.length) bad('That invite code is invalid or has expired');
    const target = invites[0];
    if (target.budget_id === req.budget.id) bad('You are already in that household');

    const { rows: memberCount } = await q(
      'SELECT COUNT(*)::int AS n FROM budget_members WHERE budget_id = $1', [req.budget.id]
    );
    const { rows: periodCount } = await q(
      'SELECT COUNT(*)::int AS n FROM pay_periods WHERE budget_id = $1', [req.budget.id]
    );
    const soleWithData = memberCount[0].n === 1 && periodCount[0].n > 0;
    if (soleWithData && req.body?.confirm !== true) {
      return res.status(409).json({
        error: 'Joining will permanently delete your current household and all its data',
        needsConfirm: true,
      });
    }

    await client.query('BEGIN');
    await detachFromCurrent(client, req.userId, req.budget.id);
    await client.query(
      'INSERT INTO budget_members (budget_id, user_id, role) VALUES ($1, $2, $3)',
      [target.budget_id, req.userId, 'member']
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Leave the household. The caller gets a fresh empty household of their own.
router.post('/leave', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows: memberCount } = await q(
      'SELECT COUNT(*)::int AS n FROM budget_members WHERE budget_id = $1', [req.budget.id]
    );
    if (memberCount[0].n === 1) bad('You are the only member — this is already your own household');
    await client.query('BEGIN');
    await detachFromCurrent(client, req.userId, req.budget.id);
    await createSoloBudget(req.userId, client);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Remove a member (owner only). They get a fresh empty household.
router.delete('/members/:userId', async (req, res, next) => {
  const client = await pool.connect();
  try {
    requireOwner(req);
    const targetId = Number(req.params.userId);
    if (targetId === req.userId) bad('Use "leave" to remove yourself');
    const { rows } = await q(
      'SELECT * FROM budget_members WHERE budget_id = $1 AND user_id = $2',
      [req.budget.id, targetId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Member not found' });
    await client.query('BEGIN');
    await client.query('DELETE FROM budget_members WHERE budget_id = $1 AND user_id = $2', [req.budget.id, targetId]);
    await createSoloBudget(targetId, client);
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
