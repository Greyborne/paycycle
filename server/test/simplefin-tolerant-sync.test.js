import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { fetchAccounts } from '../services/simplefin.js';

// Regression coverage for the "one flaky account fails the whole sync" bug.
// SimpleFIN's /accounts response returns `accounts` and `errors` together;
// `errors` is a list of soft per-account/per-connection notices, not
// necessarily fatal. fetchAccounts must return both, not throw, on a
// populated `errors` array - it must still throw on genuine hard failures
// (non-2xx HTTP, unparseable JSON).
//
// fetchAccounts goes through safeFetch, which is https-only and pins the
// resolved address (see simplefin-ssrf.test.js) - so these tests stand up a
// real local HTTPS server with a throwaway self-signed cert, rather than
// mocking at the network layer. `allowInsecureHosts` lets the pinning guard
// accept 127.0.0.1; `NODE_TLS_REJECT_UNAUTHORIZED=0` is scoped to this test
// file's own process only (node's test runner isolates each test file into
// its own process by default), so it does not weaken TLS verification for
// any other test file or for the running application.

let server;
let baseUrl;
let responder = () => ({ status: 200, body: '{}' });
let origAllowInsecure;
let origTlsReject;
let certDir;

test.before(async () => {
  certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-test-cert-'));
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1',
  ]);

  server = https.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
    (req, res) => {
      const { status, body } = responder();
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    }
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `https://127.0.0.1:${port}`;

  origAllowInsecure = config.simplefin.allowInsecureHosts;
  origTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  config.simplefin.allowInsecureHosts = true; // let the pinning guard accept 127.0.0.1
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // accept the throwaway self-signed cert
});

test.after(() => {
  config.simplefin.allowInsecureHosts = origAllowInsecure;
  if (origTlsReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = origTlsReject;
  server.close();
  fs.rmSync(certDir, { recursive: true, force: true });
});

test('returns both accounts and a non-empty errors array without throwing', async () => {
  responder = () => ({
    status: 200,
    body: JSON.stringify({
      accounts: [{ id: 'acct-1', name: 'Checking', currency: 'USD', transactions: [] }],
      errors: ['Bank X requires re-authentication.'],
    }),
  });
  const result = await fetchAccounts(baseUrl, null);
  assert.deepEqual(result.accounts, [{ id: 'acct-1', name: 'Checking', currency: 'USD', transactions: [] }]);
  assert.deepEqual(result.errors, ['Bank X requires re-authentication.']);
});

test('errors with empty accounts still returns (not throw) - caller decides what that means', async () => {
  responder = () => ({
    status: 200,
    body: JSON.stringify({ accounts: [], errors: ['Connection revoked.'] }),
  });
  const result = await fetchAccounts(baseUrl, null);
  assert.deepEqual(result, { accounts: [], errors: ['Connection revoked.'] });
});

test('a clean response with no errors returns an empty errors array', async () => {
  responder = () => ({
    status: 200,
    body: JSON.stringify({ accounts: [{ id: 'acct-1' }] }),
  });
  const result = await fetchAccounts(baseUrl, null);
  assert.deepEqual(result, { accounts: [{ id: 'acct-1' }], errors: [] });
});

test('`errlist` is accepted as the error array too', async () => {
  responder = () => ({
    status: 200,
    body: JSON.stringify({ accounts: [], errlist: ['old-style error field'] }),
  });
  const result = await fetchAccounts(baseUrl, null);
  assert.deepEqual(result.errors, ['old-style error field']);
});

test('a non-2xx HTTP status still throws', async () => {
  responder = () => ({ status: 500, body: 'internal error' });
  await assert.rejects(
    () => fetchAccounts(baseUrl, null),
    (err) => err.status === 502
  );
});

test('unparseable JSON still throws', async () => {
  responder = () => ({ status: 200, body: 'not json {' });
  await assert.rejects(
    () => fetchAccounts(baseUrl, null),
    (err) => err.status === 502
  );
});
