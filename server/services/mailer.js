import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { q } from '../db.js';
import { notificationsForUser } from './notifications.js';

// Email delivery is entirely optional: without SMTP_HOST the app never sends
// anything and the per-user opt-in is hidden in the UI.
export const emailEnabled = () => Boolean(config.smtp.host);

let transport = null;
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transport;
}

// One-off transactional send (e.g. password reset), independent of the
// per-user notification digest below.
export async function sendMail({ to, subject, text }) {
  if (!emailEnabled()) throw new Error('email is not configured');
  await getTransport().sendMail({ from: config.smtp.from, to, subject, text });
}

function fmtAmount(cents, currency) {
  if (cents === null || cents === undefined) return '';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function digestBody(items, budget) {
  const lines = items.map((n) => {
    const amount = n.amountCents !== null ? ` (${fmtAmount(n.amountCents, budget.currency)})` : '';
    const link = config.appUrl ? `\n  ${config.appUrl}${n.link}` : '';
    return `• [${n.severity.toUpperCase()}] ${n.title}${amount}${link}`;
  });
  return [
    `Heads up from PayCycle for "${budget.name}":`,
    '',
    ...lines,
    '',
    config.appUrl ? `Open PayCycle: ${config.appUrl}` : '',
    'You can turn these emails off under Settings → Notifications.',
  ].filter((l) => l !== null).join('\n');
}

// Send each opted-in user a digest of notifications they have not been
// emailed about yet. Each instance (key) is emailed at most once per user.
export async function sendPendingNotificationEmails() {
  const { rows: users } = await q(
    'SELECT id, email FROM users WHERE email_notifications'
  );
  let sent = 0;
  for (const user of users) {
    const { rows: b } = await q(
      `SELECT b.* FROM budgets b JOIN budget_members m ON m.budget_id = b.id
       WHERE m.user_id = $1 AND b.onboarding_complete`,
      [user.id]
    );
    if (!b.length) continue;
    try {
      const items = await notificationsForUser(user.id, b[0]);
      if (!items.length) continue;
      const { rows: already } = await q(
        'SELECT key FROM notification_emails WHERE user_id = $1 AND key = ANY($2)',
        [user.id, items.map((n) => n.key)]
      );
      const emailed = new Set(already.map((r) => r.key));
      const fresh = items.filter((n) => !emailed.has(n.key));
      if (!fresh.length) continue;

      await getTransport().sendMail({
        from: config.smtp.from,
        to: user.email,
        subject: `PayCycle: ${fresh[0].title}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''}`,
        text: digestBody(fresh, b[0]),
      });
      for (const n of fresh) {
        await q(
          'INSERT INTO notification_emails (user_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [user.id, n.key]
        );
      }
      sent += 1;
    } catch (err) {
      console.error(`[paycycle] notification email to ${user.email} failed:`, err.message);
    }
  }
  return sent;
}

export function startEmailScheduler() {
  if (!emailEnabled()) return;
  const interval = Math.max(1, config.smtp.intervalMinutes) * 60_000;
  console.log(`[paycycle] notification emails enabled via ${config.smtp.host} (checking every ${config.smtp.intervalMinutes} min)`);
  const run = () => sendPendingNotificationEmails().catch((err) => {
    console.error('[paycycle] notification email run failed:', err.message);
  });
  setTimeout(run, 30_000);
  setInterval(run, interval).unref();
}
