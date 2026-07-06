import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

// Generic OIDC authorization-code login (Google, GitHub via OIDC proxies,
// Keycloak, Authentik, ...). Enabled only when issuer + client id + secret
// are all configured.
export const oidcEnabled = () =>
  Boolean(config.oidc.issuer && config.oidc.clientId && config.oidc.clientSecret);

const backchannelBase = () => config.oidc.internalIssuer || config.oidc.issuer;

let discoveryCache = null;

export async function discovery() {
  if (discoveryCache && Date.now() - discoveryCache.at < 3600_000) return discoveryCache.doc;
  const res = await fetch(`${backchannelBase()}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
  const doc = await res.json();
  // The browser must reach the authorization endpoint via its public URL,
  // but server-side calls (token, jwks) may need the internal base.
  if (config.oidc.internalIssuer) {
    for (const key of ['token_endpoint', 'jwks_uri', 'userinfo_endpoint']) {
      if (doc[key]) doc[key] = doc[key].replace(config.oidc.issuer, config.oidc.internalIssuer);
    }
  }
  discoveryCache = { at: Date.now(), doc };
  return doc;
}

let jwksCache = null;

async function signingKey(kid) {
  const refresh = async () => {
    const doc = await discovery();
    const res = await fetch(doc.jwks_uri);
    if (!res.ok) throw new Error(`OIDC JWKS fetch failed (${res.status})`);
    jwksCache = { at: Date.now(), keys: (await res.json()).keys || [] };
  };
  if (!jwksCache || Date.now() - jwksCache.at > 3600_000) await refresh();
  let key = jwksCache.keys.find((k) => k.kid === kid);
  if (!key) {
    await refresh(); // key rotation
    key = jwksCache.keys.find((k) => k.kid === kid);
  }
  if (!key) throw new Error('OIDC signing key not found');
  return crypto.createPublicKey({ key, format: 'jwk' });
}

export async function exchangeCode(code, redirectUri) {
  const doc = await discovery();
  const res = await fetch(doc.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OIDC token exchange failed (${res.status}) ${detail.slice(0, 200)}`);
  }
  return res.json();
}

export async function verifyIdToken(idToken, expectedNonce) {
  const [headerB64] = idToken.split('.');
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
  const key = await signingKey(header.kid);
  const claims = jwt.verify(idToken, key, {
    algorithms: ['RS256'],
    audience: config.oidc.clientId,
    issuer: config.oidc.issuer,
  });
  if (expectedNonce && claims.nonce !== expectedNonce) throw new Error('OIDC nonce mismatch');
  return claims;
}
