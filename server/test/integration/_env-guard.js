// Refuses to run integration tests against anything that isn't recognizably
// a throwaway/local database. Import this FIRST in every integration test
// file (before importing ../../db.js or anything that pulls it in), so the
// throw happens at module-evaluation time - before any pool is queried, any
// row is seeded, or any connection is opened.
//
// Why this exists: these tests seed and then hard-DELETE real rows in
// users/budgets (see the cleanup() in each file). The blast radius is scoped
// to rows the test itself created, but nothing previously checked *which*
// database DATABASE_URL actually points at before running that DELETE. A
// stale exported DATABASE_URL from a deploy session (or copy/paste from a
// prod .env) would make `npm run test:integration` silently create and
// delete real rows in production. This project has already had one incident
// where a destructive check ran against a shared, non-ephemeral database
// (see MEMORY: "Destructive-check isolation") - this guard is the same
// lesson applied to these three files.
//
// Recognized as safe, no opt-in needed - EITHER of:
//   (a) DATABASE_URL (or PGHOST, if DATABASE_URL is unset) resolves to
//       localhost / 127.0.0.1 / ::1 - this covers CI's ephemeral
//       postgres:16-alpine service container (.github/workflows/ci.yml pins
//       DATABASE_URL to postgres://...@localhost:5432/paycycle). Admits
//       regardless of database name.
//   (b) the resolved DATABASE NAME contains "test", "ephemeral", or
//       "scratch" (case-insensitive) AND the resolved host is a private /
//       loopback / link-local address literal (RFC1918 IPv4, IPv4
//       link-local 169.254/16, IPv6 ULA fc00::/7, or IPv6 link-local
//       fe80::/10). This covers the realistic local dev workflow on this
//       machine, where Postgres port 5432 is NOT published to the host
//       (docker-compose.yml sets PGHOST: db) and the only way to reach it
//       locally is over the bridge IP or a network-namespace trick, so (a)
//       alone would reject the normal day-to-day case and train everyone to
//       reach for the override instead.
//
// Why (b) needs BOTH conditions, not just the name: a marker in the db name
// is a naming convention, not a technical guarantee of disposability -
// nothing stops a long-lived shared staging/pre-prod database, reachable
// over a public or arbitrary hostname, from being named "paycycle_test".
// Name-only admission would seed and hard-DELETE rows there with zero human
// confirmation. Requiring the host to also be a private/loopback/link-local
// literal means only something reachable exclusively from inside this
// machine's own private network can be admitted this way - a publicly
// routable target like prod-db.internal is refused even with a marker name.
//
// This is NOT the blanket-RFC1918-allowlist that was previously rejected.
// That proposal would have let a private/bridge IP address admit a run on
// its own, with no name check at all - and real production databases (RDS
// in a VPC, k8s ClusterIP services, internal load balancers) commonly
// resolve to private IP space too, so that alone would readmit exactly the
// "prod reachable over an internal network" case this guard exists to
// catch. Here the name marker is still mandatory; "private host" is only an
// additional constraint layered on top of it, never an alternative to it.
//
// The host classification only looks at the literal you were given - no DNS
// resolution is attempted (a hostname could resolve differently moment to
// moment, which would make the guard non-deterministic and easy to defeat
// by DNS trickery). A bare hostname that is not an IP literal and not one of
// the loopback names therefore fails closed under (b), even if it would
// privately resolve to an RFC1918 address - only literal loopback names and
// literal private/link-local IP addresses are trusted.
//
// Anything matching neither (a) nor (b) is refused unless the caller
// explicitly opts in with ALLOW_INTEGRATION_TESTS=1 - for someone with a
// legitimately unusual setup who has manually confirmed the target is
// disposable. Note this override does NOT check the host or name at all, so
// treat it as a deliberate one-off, not something to export persistently -
// a persistent export would re-admit the exact stale-prod-URL scenario this
// guard exists to prevent.
//
// Fails CLOSED: DATABASE_URL unset or unparseable, or a host/name pair that
// matches neither (a) nor (b), is treated as "not proven safe" and refused.

import { isIP } from 'node:net';
import { config } from '../../config.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const DISPOSABLE_NAME_MARKERS = ['test', 'ephemeral', 'scratch'];

function target() {
  if (config.databaseUrl) {
    try {
      const url = new URL(config.databaseUrl);
      // WHATWG URL keeps IPv6 hostnames bracketed (e.g. "[::1]") - strip the
      // brackets so it compares/classifies the same as the bare literal.
      const host = url.hostname.replace(/^\[|\]$/g, '');
      return { host, database: url.pathname.replace(/^\//, '') };
    } catch {
      return { host: null, database: null }; // unparseable - treated as unrecognized below
    }
  }
  return { host: config.db.host, database: config.db.database };
}

// Classifies a literal host as private/loopback/link-local WITHOUT any DNS
// resolution - only what's directly readable from the string itself.
function isPrivateOrLoopbackHost(host) {
  if (!host) return false;
  if (LOOPBACK_HOSTS.has(host)) return true;

  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local)
    return false;
  }
  if (version === 6) {
    const firstGroup = host.toLowerCase().split(':')[0];
    if (/^f[cd]/.test(firstGroup)) return true; // fc00::/7 (ULA)
    if (/^fe[89ab]/.test(firstGroup)) return true; // fe80::/10 (link-local)
    return false;
  }
  return false; // not an IP literal at all (e.g. a DNS hostname) - not trusted
}

const { host, database } = target();
const isLoopbackHost = !!host && LOOPBACK_HOSTS.has(host);
const hasDisposableName =
  !!database && DISPOSABLE_NAME_MARKERS.some((marker) => database.toLowerCase().includes(marker));
const admittedByPrivateNamedDb = hasDisposableName && isPrivateOrLoopbackHost(host);
const allowedByOverride = process.env.ALLOW_INTEGRATION_TESTS === '1';

if (!allowedByOverride && !isLoopbackHost && !admittedByPrivateNamedDb) {
  throw new Error(
    `Refusing to run integration tests: DATABASE_URL/PGHOST resolves to ` +
    `host ${host ? `"${host}"` : '(unparseable or unset)'}, database ` +
    `${database ? `"${database}"` : '(unparseable or unset)'}, and neither ` +
    `condition below is satisfied:\n` +
    `  (a) host is localhost / 127.0.0.1 / ::1, OR\n` +
    `  (b) database name contains "test", "ephemeral", or "scratch" AND ` +
    `host is a private/link-local IP literal (10.0.0.0/8, 172.16.0.0/12, ` +
    `192.168.0.0/16, 169.254.0.0/16, fc00::/7, or fe80::/10) - a plain ` +
    `hostname does not qualify here, only an IP literal.\n\n` +
    `These tests seed rows and then hard-DELETE them - do not point this ` +
    `at a real database.\n\n` +
    `To fix, either:\n` +
    `  - point DATABASE_URL at a local/CI Postgres, e.g.\n` +
    `      DATABASE_URL=postgres://paycycle:paycycle@localhost:5432/paycycle npm run test:integration\n` +
    `  - or use a disposable database, named with a marker, over a private ` +
    `IP such as the docker bridge, e.g.\n` +
    `      DATABASE_URL=postgres://paycycle:paycycle@172.20.0.2:5432/paycycle_test npm run test:integration\n\n` +
    `If you have a legitimately unusual setup and have manually confirmed ` +
    `the target database is disposable, opt in explicitly (not something ` +
    `to export persistently - it bypasses both checks above):\n` +
    `  ALLOW_INTEGRATION_TESTS=1 npm run test:integration`
  );
}
