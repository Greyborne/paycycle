import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { pool, q } from '../db.js';
import { config } from '../config.js';
import { requireAuth, setSessionCookie, clearSessionCookie } from '../auth.js';
import { bad } from '../validation.js';
import { getMembership } from '../services/budget.js';
import { oidcEnabled, discovery, exchangeCode, verifyIdToken } from '../services/oidc.js';
import { emailEnabled } from '../services/mailer.js';
import { createAndSendReset } from '../services/passwordReset.js';

const router = Router();

// Rate limit auth endpoints that accept credentials/tokens or trigger email,
// to blunt brute-force and abuse. Not applied to /logout, /me, /config, or
// the OIDC routes.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});

// The client-facing user object flattens the household's settings so the
// frontend reads currency/thresholds in one place, plus household identity.
function publicUser(user, budget) {
  return {
    id: user.id,
    email: user.email,
    emailNotifications: user.email_notifications,
    currency: budget.currency,
    thresholdLowCents: budget.threshold_low_cents,
    driftThresholdCents: budget.drift_threshold_cents,
    thresholdHealthyCents: budget.threshold_healthy_cents,
    warningThresholdCents: budget.warning_threshold_cents,
    onboardingComplete: budget.onboarding_complete,
    household: { id: budget.id, name: budget.name, role: budget.role },
    isAdmin: config.adminEmails.includes(String(user.email).toLowerCase()),
  };
}

async function validInvite(client, code) {
  const { rows } = await client.query(
    'SELECT * FROM budget_invites WHERE upper(code) = upper($1) AND expires_at > now()',
    [code]
  );
  return rows[0] || null;
}

// Create a user plus their household membership: joining via invite, or a
// fresh solo household. Returns null if the email is already taken.
async function provisionUser(client, { email, passwordHash, invite }) {
  const { rows: users } = await client.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (lower(email)) DO NOTHING RETURNING *`,
    [email, passwordHash]
  );
  if (!users.length) return null;
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
    await client.query(
      "INSERT INTO accounts (budget_id, name, is_default) VALUES ($1, 'Primary account', TRUE)",
      [rows[0].id]
    );
    budget = { ...rows[0], role: 'owner' };
  }
  return { user, budget };
}

// Register. With a valid inviteCode the new account joins that household
// directly (skipping onboarding) and is allowed even when open registration
// is disabled - so an admin can lock the server down but still invite family.
router.post('/register', authLimiter, async (req, res, next) => {
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
    const created = await provisionUser(client, { email, passwordHash: hash, invite });
    if (!created) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    await client.query('COMMIT');

    setSessionCookie(res, created.user.id);
    res.status(201).json({ user: publicUser(created.user, created.budget) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.post('/login', authLimiter, async (req, res, next) => {
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

// Self-service password change. Operates only on req.userId (no IDOR);
// requires the current password before writing a new hash; bumps
// password_changed_at (invalidating every other outstanding session) and
// immediately re-issues the session cookie so the caller making this
// request stays signed in.
router.post('/password', authLimiter, requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      bad('New password must be at least 8 characters');
    }
    const { rows } = await q('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
    if (!rows.length) return res.status(401).json({ error: 'Not signed in' });
    const ok = await bcrypt.compare(currentPassword || '', rows[0].password_hash);
    if (!ok) return res.status(400).json({ error: 'Your current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 10);
    await q(
      'UPDATE users SET password_hash = $1, password_changed_at = now() WHERE id = $2',
      [hash, req.userId]
    );
    setSessionCookie(res, req.userId);
    res.status(204).end();
  } catch (err) { next(err); }
});

// Request an emailed reset link. Always responds 200 { ok: true } regardless
// of whether the email exists or SMTP is configured, so the endpoint can't be
// used to enumerate accounts. Never logs the token or the email address.
router.post('/forgot', authLimiter, async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (typeof email === 'string' && email.trim() && emailEnabled()) {
      try {
        const { rows } = await q('SELECT id FROM users WHERE lower(email) = lower($1)', [email.trim()]);
        if (rows.length) {
          await createAndSendReset(req, { userId: rows[0].id, email: email.trim() });
        }
      } catch (err) {
        console.error('[paycycle] password reset email failed:', err.message);
      }
    } else if (!emailEnabled()) {
      console.warn('[paycycle] password reset requested but SMTP is not configured');
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Complete a reset with the emailed token. Public — the token itself is the
// credential. Single-use, 1-hour expiry, looked up by hash only.
router.post('/reset', authLimiter, async (req, res, next) => {
  try {
    const { token, newPassword } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      bad('New password must be at least 8 characters');
    }
    if (typeof token !== 'string' || !token) {
      bad('This reset link is invalid or has expired');
    }
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const { rows } = await q(
      `SELECT * FROM password_resets
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [hash]
    );
    if (!rows.length) bad('This reset link is invalid or has expired');
    const reset = rows[0];
    const newHash = await bcrypt.hash(newPassword, 10);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE users SET password_hash = $1, password_changed_at = now() WHERE id = $2',
        [newHash, reset.user_id]
      );
      // Invalidate this token (and any other outstanding tokens for the
      // same user) so a stale reset link can't be replayed.
      await client.query(
        'UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
        [reset.user_id]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

// Cancel a brand-new sign-up: permanently deletes the caller's own
// not-yet-onboarded account and household. Never accepts an id from the
// client - operates only on req.userId. Refuses once onboarding is
// complete, so this can't be used to nuke an established account.
router.delete('/account', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const budget = await getMembership(req.userId);
    if (!budget) return res.status(404).json({ error: 'No account found' });
    if (budget.onboarding_complete) {
      return res.status(409).json({ error: "Your account is already set up — it can't be cancelled here." });
    }

    await client.query('BEGIN');
    // Lock the budget row so a concurrent /household/join can't slip a new
    // member in between our count and the conditional delete below (that
    // INSERT takes an FK KEY SHARE lock on this row, which conflicts with
    // FOR UPDATE, so the two serialize instead of racing).
    await client.query('SELECT id FROM budgets WHERE id = $1 FOR UPDATE', [budget.id]);
    const { rows } = await client.query(
      'SELECT count(*)::int AS n FROM budget_members WHERE budget_id = $1',
      [budget.id]
    );
    if (rows[0].n === 1) {
      await client.query('DELETE FROM budgets WHERE id = $1', [budget.id]);
    }
    await client.query('DELETE FROM users WHERE id = $1', [req.userId]);
    await client.query('COMMIT');

    clearSessionCookie(res);
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Public config for the login page (no auth required).
router.get('/config', (req, res) => {
  res.json({
    registrationOpen: config.allowRegistration,
    oidc: oidcEnabled()
      ? { enabled: true, name: config.oidc.providerName }
      : { enabled: false },
    instance: config.instance,
  });
});

const OIDC_STATE_COOKIE = 'paycycle_oidc';

function oidcCallbackUrl(req) {
  const base = config.appUrl || `${req.protocol}://${req.get('host')}`;
  return `${base}/api/auth/oidc/callback`;
}

// Kick off the OIDC authorization-code flow. An optional ?invite=CODE rides
// along in the signed state cookie so a new user can join a household (and
// bypass ALLOW_REGISTRATION=false) exactly like password registration.
router.get('/oidc/start', async (req, res, next) => {
  try {
    if (!oidcEnabled()) return res.status(404).json({ error: 'Single sign-on is not configured' });
    const doc = await discovery();
    const state = crypto.randomBytes(16).toString('hex');
    const nonce = crypto.randomBytes(16).toString('hex');
    const invite = typeof req.query.invite === 'string' ? req.query.invite.trim().slice(0, 64) : '';
    res.cookie(
      OIDC_STATE_COOKIE,
      jwt.sign({ state, nonce, invite }, config.sessionSecret, { expiresIn: '10m' }),
      { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: 600_000, path: '/' }
    );
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.oidc.clientId);
    url.searchParams.set('redirect_uri', oidcCallbackUrl(req));
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    res.redirect(url.toString());
  } catch (err) {
    next(err);
  }
});

router.get('/oidc/callback', async (req, res) => {
  const fail = (message) => res.redirect(`/login?error=${encodeURIComponent(message)}`);
  try {
    if (!oidcEnabled()) return fail('Single sign-on is not configured');
    const raw = req.cookies?.[OIDC_STATE_COOKIE];
    res.clearCookie(OIDC_STATE_COOKIE, { path: '/' });
    let state;
    try {
      state = jwt.verify(raw, config.sessionSecret);
    } catch {
      return fail('Sign-in session expired — please try again');
    }
    if (req.query.error) return fail(`The identity provider reported: ${req.query.error}`);
    if (!req.query.code || req.query.state !== state.state) {
      return fail('Sign-in was interrupted — please try again');
    }

    const tokens = await exchangeCode(String(req.query.code), oidcCallbackUrl(req));
    const claims = await verifyIdToken(tokens.id_token, state.nonce);
    const email = claims.email;
    if (!email) return fail('Your identity provider did not share an email address');
    if (claims.email_verified === false) return fail('Your email address is not verified with the identity provider');

    const { rows: existing } = await q('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
    let userId;
    if (existing.length) {
      userId = existing[0].id;
    } else {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const invite = state.invite ? await validInvite(client, state.invite) : null;
        if (state.invite && !invite) {
          await client.query('ROLLBACK');
          return fail('That invite code is invalid or has expired');
        }
        if (!invite && !config.allowRegistration) {
          await client.query('ROLLBACK');
          return fail('Registration is disabled on this server — ask for a household invite code');
        }
        // No usable password: this account signs in through the provider.
        const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
        const created = await provisionUser(client, { email, passwordHash: hash, invite });
        if (!created) {
          await client.query('ROLLBACK');
          return fail('Could not create your account — please try again');
        }
        await client.query('COMMIT');
        userId = created.user.id;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    setSessionCookie(res, userId);
    res.redirect('/');
  } catch (err) {
    console.error('[paycycle] oidc callback failed:', err.message);
    return fail('Sign-in failed — please try again');
  }
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
