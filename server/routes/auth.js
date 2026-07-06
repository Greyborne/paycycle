import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool, q } from '../db.js';
import { config } from '../config.js';
import { requireAuth, setSessionCookie, clearSessionCookie } from '../auth.js';
import { bad } from '../validation.js';
import { getMembership } from '../services/budget.js';

const router = Router();

// The client-facing user object flattens the household's settings so the
// frontend reads currency/thresholds in one place, plus household identity.
function publicUser(user, budget) {
  return {
    id: user.id,
    email: user.email,
    currency: budget.currency,
    thresholdLowCents: budget.threshold_low_cents,
    thresholdHealthyCents: budget.threshold_healthy_cents,
    warningThresholdCents: budget.warning_threshold_cents,
    onboardingComplete: budget.onboarding_complete,
    household: { id: budget.id, name: budget.name, role: budget.role },
  };
}

async function validInvite(client, code) {
  const { rows } = await client.query(
    'SELECT * FROM budget_invites WHERE code = $1 AND expires_at > now()',
    [code]
  );
  return rows[0] || null;
}

// Register. With a valid inviteCode the new account joins that household
// directly (skipping onboarding) and is allowed even when open registration
// is disabled - so an admin can lock the server down but still invite family.
router.post('/register', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { email, password, inviteCode } = req.body || {};
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) bad('A valid email address is required');
    if (typeof password !== 'string' || password.length < 8) bad('Password must be at least 8 characters');

    await client.query('BEGIN');
    let invite = null;
    if (inviteCode) {
      invite = await validInvite(client, String(inviteCode).trim());
      if (!invite) bad('That invite code is invalid or has expired');
    } else if (!config.allowRegistration) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Registration is disabled on this server' });
    }

    const hash = await bcrypt.hash(password, 10);
    const { rows: users } = await client.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)
       ON CONFLICT (lower(email)) DO NOTHING RETURNING *`,
      [email, hash]
    );
    if (!users.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    const user = users[0];

    let budget;
    if (invite) {
      await client.query(
        'INSERT INTO budget_members (budget_id, user_id, role) VALUES ($1, $2, $3)',
        [invite.budget_id, user.id, 'member']
      );
      const { rows } = await client.query('SELECT * FROM budgets WHERE id = $1', [invite.budget_id]);
      budget = { ...rows[0], role: 'member' };
    } else {
      const name = `${email.split('@')[0]}'s household`;
      const { rows } = await client.query(
        'INSERT INTO budgets (name, currency) VALUES ($1, $2) RETURNING *',
        [name, config.defaultCurrency]
      );
      await client.query(
        'INSERT INTO budget_members (budget_id, user_id, role) VALUES ($1, $2, $3)',
        [rows[0].id, user.id, 'owner']
      );
      budget = { ...rows[0], role: 'owner' };
    }
    await client.query('COMMIT');

    setSessionCookie(res, user.id);
    res.status(201).json({ user: publicUser(user, budget) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const { rows } = await q('SELECT * FROM users WHERE lower(email) = lower($1)', [email || '']);
    const ok = rows.length && (await bcrypt.compare(password || '', rows[0].password_hash));
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    setSessionCookie(res, rows[0].id);
    const budget = await getMembership(rows[0].id);
    res.json({ user: publicUser(rows[0], budget) });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await q('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!rows.length) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Account no longer exists' });
    }
    const budget = await getMembership(req.userId);
    res.json({ user: publicUser(rows[0], budget), registrationOpen: config.allowRegistration });
  } catch (err) {
    next(err);
  }
});

export default router;
export { publicUser };
