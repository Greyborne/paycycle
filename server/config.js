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
  appUrl: (process.env.APP_URL || '').replace(/\/$/, ''),
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'PayCycle <paycycle@localhost>',
    intervalMinutes: parseInt(process.env.NOTIFICATION_EMAIL_INTERVAL_MINUTES || '60', 10),
  },
  plaid: {
    clientId: process.env.PLAID_CLIENT_ID || '',
    secret: process.env.PLAID_SECRET || '',
    env: (process.env.PLAID_ENV || 'sandbox').toLowerCase(),
    countryCodes: (process.env.PLAID_COUNTRY_CODES || 'US').split(',').map((c) => c.trim().toUpperCase()),
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
