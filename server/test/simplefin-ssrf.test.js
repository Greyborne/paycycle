import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dns from 'node:dns';
import { config } from '../config.js';
import { isDisallowedAddress, safeFetch } from '../services/simplefin.js';

// Regression coverage for the SSRF address guard in services/simplefin.js.
// Two rounds of this guard were bypassed by reasoning about the TEXTUAL
// SPELLING of an address (a regex on the dotted-quad form, then a regex
// expecting a literal `::ffff:` string prefix that `new URL()` had already
// re-spelled as compressed hex groups). isDisallowedAddress now parses every
// address into raw bytes before deciding, so every spelling of the same
// underlying address must agree. This test asserts that directly, with no
// network and no DNS - the check function is pure.

test('rejects loopback, in every spelling', () => {
  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(isDisallowedAddress(addr), true, addr);
  }
});

test('rejects unspecified, in every spelling', () => {
  for (const addr of ['0.0.0.0', '::']) {
    assert.equal(isDisallowedAddress(addr), true, addr);
  }
});

test('rejects link-local / cloud metadata, in every spelling', () => {
  for (const addr of ['169.254.169.254', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe']) {
    assert.equal(isDisallowedAddress(addr), true, addr);
  }
});

test('rejects RFC1918 private ranges, in every spelling', () => {
  for (const addr of [
    '10.0.0.1', '::ffff:10.0.0.1', '::ffff:a00:1',
    '192.168.1.1', '::ffff:c0a8:101',
    '172.16.0.1', '172.31.255.255',
  ]) {
    assert.equal(isDisallowedAddress(addr), true, addr);
  }
});

test('rejects CGNAT (100.64/10)', () => {
  assert.equal(isDisallowedAddress('100.64.0.1'), true);
});

test('rejects IETF protocol assignments (192.0.0.0/24)', () => {
  assert.equal(isDisallowedAddress('192.0.0.1'), true);
  assert.equal(isDisallowedAddress('192.0.1.1'), false); // just outside the /24, must not be over-blocked
});

test('rejects benchmarking range (198.18.0.0/15)', () => {
  assert.equal(isDisallowedAddress('198.18.0.1'), true);
  assert.equal(isDisallowedAddress('198.19.255.255'), true);
  assert.equal(isDisallowedAddress('198.17.255.255'), false); // just below the /15
  assert.equal(isDisallowedAddress('198.20.0.0'), false); // just above the /15
});

test('rejects multicast (224.0.0.0/4)', () => {
  assert.equal(isDisallowedAddress('224.0.0.1'), true);
  assert.equal(isDisallowedAddress('239.255.255.255'), true);
});

test('rejects reserved (240.0.0.0/4) and the broadcast address', () => {
  assert.equal(isDisallowedAddress('240.0.0.1'), true);
  assert.equal(isDisallowedAddress('255.255.255.255'), true);
});

test('rejects IPv6 unique-local, link-local, and multicast', () => {
  for (const addr of ['fc00::1', 'fe80::1', 'ff02::1']) {
    assert.equal(isDisallowedAddress(addr), true, addr);
  }
});

test('rejects a v4 destination smuggled through the NAT64 well-known prefix', () => {
  assert.equal(isDisallowedAddress('64:ff9b::7f00:1'), true); // 64:ff9b::/96 + 127.0.0.1
});

test('rejects a v4 destination smuggled through the IPv4-translated prefix (::ffff:0:0/96)', () => {
  // Distinct byte layout from IPv4-mapped: bytes 0-7 zero, 8-9 = 0xff, 10-11
  // = 0x00, then the 4 v4 bytes - not to be conflated with ::ffff:a.b.c.d.
  assert.equal(isDisallowedAddress('::ffff:0:7f00:1'), true); // + 127.0.0.1 (loopback)
  assert.equal(isDisallowedAddress('::ffff:0:a9fe:a9fe'), true); // + 169.254.169.254 (metadata)
});

test('rejects a v4 destination smuggled through the 6to4 prefix (2002::/16)', () => {
  // bytes 0-1 = 0x20 0x02, bytes 2-5 = the embedded v4 address.
  assert.equal(isDisallowedAddress('2002:7f00:1::'), true); // + 127.0.0.1 (loopback)
  assert.equal(isDisallowedAddress('2002:a9fe:a9fe::'), true); // + 169.254.169.254 (metadata)
});

test('does not over-block: a genuine public address survives every new unwrap path', () => {
  // 93.184.216.34, re-embedded through each of the five v4-in-v6 forms.
  for (const addr of [
    '93.184.216.34',
    '::ffff:93.184.216.34',
    '::93.184.216.34',
    '64:ff9b::5db8:d822',
    '::ffff:0:5db8:d822',
    '2002:5db8:d822::',
  ]) {
    assert.equal(isDisallowedAddress(addr), false, addr);
  }
});

test('rejects malformed / unparseable input (fails closed)', () => {
  for (const addr of ['not-an-ip', '999.999.999.999', '']) {
    assert.equal(isDisallowedAddress(addr), true, addr);
  }
});

test('accepts a normal public address, v4 and v6', () => {
  assert.equal(isDisallowedAddress('93.184.216.34'), false);
  assert.equal(isDisallowedAddress('2606:2800:220:1:248:1893:25c8:1946'), false);
});

test('a zone id does not alter classification, either direction', () => {
  assert.equal(isDisallowedAddress('fe80::1%eth0'), true); // still link-local, zone id or not
  assert.equal(isDisallowedAddress('2606:2800:220:1:248:1893:25c8:1946%1'), false); // still public, zone id or not
});

// ---------------------------------------------------------------------
// Architecture test: proves the address that was VALIDATED is the address
// the socket actually connects to (resolvePinnedAddress -> safeFetch's
// custom `lookup` hook). Every test above only exercises the pure
// classifier, isDisallowedAddress; none of them would catch a regression
// where validation and the real connect were decoupled again (e.g. by
// swapping back to global fetch(), which always re-resolves its own DNS at
// connect time and ignores any answer already looked up - the exact shape
// of this guard's round-1 bypass, a DNS-rebinding TOCTOU).
//
// Technique: two local-only TCP listeners, on different loopback addresses
// but the SAME port, stand in for "the address that was validated" (A,
// 127.0.0.1) and "the address a decoupled connect step would be re-resolved
// to" (B, 127.0.0.2). `dns.promises.lookup` (called once, by
// resolvePinnedAddress) is mocked to answer with A; the callback-style
// `dns.lookup` (what Node's http/net machinery falls back to internally
// ONLY when no custom `lookup` option is supplied to https.request - i.e.
// exactly what happens if pinning is ever removed) is mocked to answer with
// B instead. A correctly pinned implementation hands the already-validated
// address straight to https.request's `lookup` option and never calls the
// callback-style dns.lookup at all, so only A ever sees a connection. Note:
// this requires importing `dns` as the *default* export (`import dns from
// 'node:dns'`, matching how services/simplefin.js itself imports it) rather
// than `import * as dns` - the ESM namespace object is a distinct object
// from the CJS module.exports singleton Node's internals actually consult,
// so mutating properties on the namespace object silently does nothing.
// `allowInsecureHosts` is set so this test isolates the *pinning wiring*
// from the *range check* (already covered above) and doesn't need a
// publicly-routable address.
// ---------------------------------------------------------------------
test('pins the actual TCP connection to the address that was validated', async (t) => {
  let hitsValidated = 0;
  let hitsDecoupled = 0;
  const validatedListener = net.createServer((socket) => { hitsValidated += 1; socket.destroy(); });
  const decoupledListener = net.createServer((socket) => { hitsDecoupled += 1; socket.destroy(); });
  await new Promise((resolve) => validatedListener.listen(0, '127.0.0.1', resolve));
  const sharedPort = validatedListener.address().port;
  await new Promise((resolve, reject) => {
    decoupledListener.on('error', reject);
    decoupledListener.listen(sharedPort, '127.0.0.2', resolve);
  });

  const origPromiseLookup = dns.promises.lookup;
  const origCallbackLookup = dns.lookup;
  const origAllowInsecure = config.simplefin.allowInsecureHosts;

  // Both loopback addresses would normally be rejected by the guard; that
  // range check is covered elsewhere, so it's disabled here to isolate the
  // pinning wiring itself.
  config.simplefin.allowInsecureHosts = true;
  dns.promises.lookup = async () => [{ address: '127.0.0.1', family: 4 }]; // -> validatedListener
  dns.lookup = (_hostname, opts, cb) => {
    if (opts && opts.all) return cb(null, [{ address: '127.0.0.2', family: 4 }]);
    cb(null, '127.0.0.2', 4); // -> decoupledListener, if anything still calls the un-pinned resolver
  };

  t.after(() => {
    dns.promises.lookup = origPromiseLookup;
    dns.lookup = origCallbackLookup;
    config.simplefin.allowInsecureHosts = origAllowInsecure;
    validatedListener.close();
    decoupledListener.close();
  });

  try {
    await safeFetch(`https://pin-test.invalid:${sharedPort}/accounts`, { method: 'GET' });
  } catch {
    // A plain TCP listener can't complete a TLS handshake - safeFetch is
    // expected to error out. What matters is *which* socket it dialed.
  }
  // Give any wrongly-routed connection a moment to land.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(hitsValidated, 1, 'the socket must connect to the address that was validated');
  assert.equal(hitsDecoupled, 0, 'the socket must never be dialed via a fresh, unvalidated resolution');
});
