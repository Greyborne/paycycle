import jwt from 'jsonwebtoken';
import { config } from './config.js';

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

export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    const payload = jwt.verify(token, config.sessionSecret);
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
