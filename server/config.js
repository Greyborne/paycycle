import crypto from 'node:crypto';

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

export const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgres://paycycle:paycycle@localhost:5432/paycycle',
  sessionSecret: process.env.SESSION_SECRET || '',
  allowRegistration: bool(process.env.ALLOW_REGISTRATION, true),
  defaultCurrency: (process.env.DEFAULT_CURRENCY || 'USD').toUpperCase(),
  secureCookies: bool(process.env.SECURE_COOKIES, false),
  trustProxy: bool(process.env.TRUST_PROXY, false),
};

if (!config.sessionSecret) {
  config.sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn(
    '[paycycle] SESSION_SECRET is not set - using a temporary random secret. ' +
    'Logins will not survive a restart; set SESSION_SECRET for real deployments.'
  );
}
