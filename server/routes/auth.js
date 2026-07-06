import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool, q } from '../db.js';
import { config } from '../config.js';
import { requireAuth, setSessionCookie, clearSessionCookie } from '../auth.js';
import { bad } from '../validation.js';
import { getMembership } from '../services/budget.js';
import { oidcEnabled, discovery, exchangeCode, verifyIdToken } from '../services/oidc.js';

const router = Router();

// The client-facing user object flattens the household's settings so the
// frontend reads currency/thresholds in one place, plus household identity.
function publicUser(user, budget) {
  return {
    id: user.id,
    email: user.email,
    emailNotifications: user.email_notifications,
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

// Public config for the login page (no auth required).
router.get('/config', (req, res) => {
  res.json({
    registrationOpen: config.allowRegistration,
    oidc: oidcEnabled()
      ? { enabled: true, name: config.oidc.providerName }
      : { enabled: false },
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
