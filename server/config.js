import crypto from 'node:crypto';
import fs from 'node:fs';

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

// Parses TRUST_PROXY into what `app.set('trust proxy', ...)` should actually
// receive: a specific hop count (or `false`), never a bare `true`. A bare
// `true` tells Express to trust the entire X-Forwarded-For chain, which lets
// a client spoof its own "trusted" IP and bypass IP-based rate limiting.
function trustProxyHops(value) {
  if (value === undefined || value === '') return false;
  const normalized = String(value).trim().toLowerCase();
  if (['false', 'no', 'off', '0'].includes(normalized)) return false;
  // A plain positive integer means "trust this many proxy hops".
  if (/^[1-9][0-9]*$/.test(normalized)) return parseInt(normalized, 10);
  // Anything else truthy ("true"/"yes"/"on"/etc.) means "one reverse proxy" -
  // the safe default, rather than trusting the whole forwarded-for chain.
  return 1;
}

// Reads a value from `${name}_FILE` (Docker/Compose secret file) first, then
// falls back to the plain `${name}` env var. Lets a password contain any
// character - including `$` - without going through shell/.env interpolation.
function readSecret(name) {
  const f = process.env[`${name}_FILE`];
  if (f) return fs.readFileSync(f, 'utf8').replace(/\r?\n$/, '');
  return process.env[name];
}

export const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  // Back-compat: if DATABASE_URL is set, it wins outright (see server/db.js).
  // Otherwise the discrete `db` fields below are used - no URL-encoding
  // needed for special characters in the password.
  databaseUrl: process.env.DATABASE_URL || '',
  db: {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || process.env.POSTGRES_USER || 'paycycle',
    password: readSecret('PGPASSWORD') || readSecret('POSTGRES_PASSWORD') || 'paycycle',
    database: process.env.PGDATABASE || process.env.POSTGRES_DB || 'paycycle',
  },
  sessionSecret: process.env.SESSION_SECRET || '',
  allowRegistration: bool(process.env.ALLOW_REGISTRATION, true),
  adminEmails: (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  defaultCurrency: (process.env.DEFAULT_CURRENCY || 'USD').toUpperCase(),
  secureCookies: bool(process.env.SECURE_COOKIES, false),
  trustProxy: trustProxyHops(process.env.TRUST_PROXY),
  appUrl: (process.env.APP_URL || '').replace(/\/$/, ''),
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: readSecret('SMTP_PASS') || '',
    from: process.env.SMTP_FROM || 'PayCycle <paycycle@localhost>',
    intervalMinutes: parseInt(process.env.NOTIFICATION_EMAIL_INTERVAL_MINUTES || '60', 10),
  },
  simplefin: {
    enabled: process.env.BANK_SYNC_ENABLED === 'true',
    allowInsecureHosts: process.env.SIMPLEFIN_ALLOW_INSECURE_HOSTS === 'true',
  },
  oidc: {
    issuer: (process.env.OIDC_ISSUER || '').replace(/\/$/, ''),
    // Backchannel base for server-side calls (discovery/token/jwks) when the
    // public issuer URL isn't reachable from inside the container - e.g. a
    // Keycloak on the same compose network.
    internalIssuer: (process.env.OIDC_ISSUER_INTERNAL || '').replace(/\/$/, ''),
    clientId: process.env.OIDC_CLIENT_ID || '',
    clientSecret: process.env.OIDC_CLIENT_SECRET || '',
    providerName: process.env.OIDC_PROVIDER_NAME || 'SSO',
  },
};

if (!config.sessionSecret) {
  config.sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn(
    '[paycycle] SESSION_SECRET is not set - using a temporary random secret. ' +
    'Logins will not survive a restart; set SESSION_SECRET for real deployments.'
  );
}
