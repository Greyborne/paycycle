import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { q } from './db.js';

const COOKIE_NAME = 'paycycle_session';
const MAX_AGE_DAYS = 30;

export function setSessionCookie(res, userId) {
  const token = jwt.sign({ sub: String(userId) }, config.sessionSecret, {
    expiresIn: `${MAX_AGE_DAYS}d`,
  });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    maxAge: MAX_AGE_DAYS * 86400000,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// Verifies the session cookie AND that it predates the user's most recent
// password change, so changing (or resetting) a password invalidates every
// other outstanding session. Compared at second granularity so the freshly
// re-issued cookie from a self-change (iat == changed, floored to the same
// second) is not falsely invalidated.
export async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    const payload = jwt.verify(token, config.sessionSecret);
    const { rows } = await q('SELECT password_changed_at FROM users WHERE id = $1', [Number(payload.sub)]);
    if (!rows.length) { clearSessionCookie(res); return res.status(401).json({ error: 'Account no longer exists' }); }
    const changedSec = Math.floor(new Date(rows[0].password_changed_at).getTime() / 1000);
    if (typeof payload.iat === 'number' && payload.iat < changedSec) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Session expired — please sign in again' });
    }
    req.userId = Number(payload.sub);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }
}

// Resolve the caller's household: sets req.budget (budgets row) and
// req.budgetRole. Mount after requireAuth on every budget-scoped route.
export function attachBudget(getMembership) {
  return async (req, res, next) => {
    try {
      const membership = await getMembership(req.userId);
      req.budget = membership;
      req.budgetRole = membership.role;
      next();
    } catch (err) {
      next(err);
    }
  };
}
