import crypto from 'node:crypto';
import { q } from '../db.js';
import { sendMail } from './mailer.js';
import { config } from '../config.js';

// Base URL for links in outbound email: prefer the configured APP_URL,
// falling back to whatever the incoming request looks like it was served on.
export function resetBaseUrl(req) {
  return config.appUrl || `${req.protocol}://${req.get('host')}`;
}

// Generate a reset token, store only its SHA-256 hash (1-hour expiry), and
// email the reset link to the given address. Shared by the self-service
// /auth/forgot flow and the admin-triggered send-reset action — callers are
// responsible for deciding *whether* to call this (e.g. anti-enumeration
// checks, emailEnabled() gating) and for catching/logging failures.
export async function createAndSendReset(req, { userId, email }) {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await q(
    "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [userId, hash]
  );
  const link = `${resetBaseUrl(req)}/reset?token=${token}`;
  await sendMail({
    to: email,
    subject: 'Reset your PayCycle password',
    text: `We received a request to reset your PayCycle password.\n\n` +
      `Reset it here: ${link}\n\n` +
      `This link expires in 1 hour. If you didn't request this, you can ignore this email.`,
  });
}
