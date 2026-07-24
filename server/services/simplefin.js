import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { config } from '../config.js';
import { pool, q } from '../db.js';
import {
  getConfig, ensureMaterialized, loadTemplates, driftFor, clearLineItemForTransaction, setAmountGoingForward,
  getDefaultAccountId,
} from './budget.js';
import { decryptSecret, encryptSecret } from './secrets.js';
import { loadRules, firstMatchingCategory } from './rules.js';
import { HttpError } from '../validation.js';

// ---------------------------------------------------------------------
// SSRF guard (shared by the claim POST and the accounts GET). A setup
// token decodes to a URL the *server* fetches on an authenticated user's
// say-so, so this is the actual attack surface of this feature. Never put
// the URL, the access URL, or the response body into a thrown error
// message or a console line - the access URL embeds basic-auth
// credentials.
//
// Resolution is pinned: the hostname is resolved and validated exactly
// ONCE (resolvePinnedAddress), and the literal IP that was validated is
// the literal IP the socket connects to (via a custom
// `lookup` passed to https.request). This closes a DNS-rebinding TOCTOU -
// if validation and connection each did their own resolution (as
// `fetch()` does; it always re-resolves independently at connect time,
// ignoring any answer you already looked up), an attacker's nameserver
// could answer once with a public IP for the check and a second time with
// 169.254.169.254 / 127.0.0.1 / an internal address for the connect, and
// the guard would never see the address it actually ends up talking to.
// ---------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------
// Address check, BY VALUE. Two rounds of this guard were bypassed by
// reasoning about the textual spelling of an address (a regex on the
// dotted-quad form; a regex expecting `::ffff:` in front of a dotted
// quad, which `new URL()` had already re-spelled as compressed hex groups
// - e.g. `[::ffff:127.0.0.1]` normalizes to `[::ffff:7f00:1]` before
// `.hostname` ever sees it). Textual representations of an IP address are
// not canonical, and neither the URL parser nor the DNS resolver
// guarantees which spelling you get back. So: every address is parsed
// into its raw bytes (4 for IPv4, 16 for IPv6) before any decision is
// made, IPv4-mapped/-compatible/NAT64 v6 literals are unwrapped to their
// real 4-byte v4 destination BY BYTE PATTERN (not by string prefix), and
// every range check below is a numeric comparison against those bytes.
// `isDisallowedAddress` is the one function that decides "may I connect
// to this address" and every address - a dns.lookup answer or a literal
// IP host - goes through it on the same path (resolvePinnedAddress).
// ---------------------------------------------------------------------

function ipv4ToBytes(str) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(str);
  if (!m) return null;
  const bytes = m.slice(1, 5).map(Number);
  if (bytes.some((b) => b > 255)) return null;
  return bytes;
}

// Parses any valid textual IPv6 address (any legal `::` compression, any
// legal embedded IPv4 dotted-quad tail, an optional `%zone` suffix) into
// its 16 raw bytes.
function ipv6ToBytes(str) {
  if (!net.isIPv6(str)) return null;
  let s = str.split('%')[0]; // strip zone id, e.g. fe80::1%eth0

  // An embedded IPv4 dotted-quad tail (::ffff:127.0.0.1) is replaced with
  // two placeholder hex groups so the rest of the parser can treat the
  // whole thing as ordinary hex-group IPv6; the placeholder bytes are
  // overwritten with the real IPv4 bytes afterward.
  let v4Tail = null;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    v4Tail = ipv4ToBytes(tail);
    if (!v4Tail) return null;
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }

  let groups;
  if (s.includes('::')) {
    const [headStr, tailStr] = s.split('::');
    const head = headStr ? headStr.split(':') : [];
    const rest = tailStr ? tailStr.split(':') : [];
    const missing = 8 - (head.length + rest.length);
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...rest];
  } else {
    groups = s.split(':');
  }
  if (groups.length !== 8) return null;

  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const val = parseInt(g, 16);
    bytes.push((val >> 8) & 0xff, val & 0xff);
  }
  if (v4Tail) bytes.splice(12, 4, ...v4Tail);
  return bytes;
}

function toBytes(address) {
  if (net.isIPv4(address)) return ipv4ToBytes(address);
  if (net.isIPv6(address)) return ipv6ToBytes(address);
  return null;
}

function isDisallowedIPv4Bytes([a, b, c]) {
  if (a === 0) return true; // 0.0.0.0/8 - unspecified / "this network"
  if (a === 10) return true; // 10/8 - private
  if (a === 127) return true; // 127/8 - loopback
  if (a === 169 && b === 254) return true; // 169.254/16 - link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 - private
  if (a === 192 && b === 168) return true; // 192.168/16 - private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 - CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24 - IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 - benchmarking
  if (a >= 224 && a <= 239) return true; // 224/4 - multicast
  if (a >= 240) return true; // 240/4 - reserved, incl. 255.255.255.255 broadcast
  return false;
}

// If a 16-byte v6 address is really a v4 destination wearing a v6 costume
// (IPv4-mapped `::ffff:a.b.c.d`, IPv4-compatible `::a.b.c.d`, the NAT64
// well-known prefix `64:ff9b::/96`, IPv4-translated `::ffff:0:0/96`, or
// 6to4 `2002::/16`), detected by the actual byte pattern rather than by
// string prefix, return its unwrapped 4 v4 bytes; otherwise null.
function unwrapIPv4(b) {
  const headZero = (n) => b.slice(0, n).every((x) => x === 0);
  if (headZero(10) && b[10] === 0xff && b[11] === 0xff) return b.slice(12, 16); // ::ffff:a.b.c.d
  if (headZero(12)) return b.slice(12, 16); // ::a.b.c.d (also covers :: and ::1's numeric form)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) {
    return b.slice(12, 16); // 64:ff9b::/96 NAT64
  }
  if (headZero(8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) {
    return b.slice(12, 16); // ::ffff:0:0/96 IPv4-translated
  }
  if (b[0] === 0x20 && b[1] === 0x02) return b.slice(2, 6); // 2002::/16 6to4
  return null;
}

function isDisallowedIPv6Bytes(b) {
  if (b.every((x) => x === 0)) return true; // :: - unspecified
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 - loopback
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 - unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 - link-local
  if (b[0] === 0xff) return true; // ff00::/8 - multicast
  return false;
}

// The one function that decides "may I connect to this address" - used
// for every dns.lookup answer AND for a literal-IP host, on the same
// path (see resolvePinnedAddress). Operates on parsed bytes, never on the
// address's textual spelling.
export function isDisallowedAddress(address) {
  const bytes = toBytes(address);
  if (!bytes) return true; // couldn't parse as an IP at all -> fail closed
  if (bytes.length === 4) return isDisallowedIPv4Bytes(bytes);
  const v4 = unwrapIPv4(bytes);
  if (v4) return isDisallowedIPv4Bytes(v4);
  return isDisallowedIPv6Bytes(bytes);
}

// Strip the [ ] wrapper a URL literal-IPv6 host is given in
// (`https://[::1]/` -> hostname `[::1]`), which `dns.promises.lookup`
// itself does not accept - without this, every bracketed-IPv6-literal
// request would fail closed on a DNS error rather than actually being
// checked against the IPv6 blocklist above.
function bareHost(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

// Resolves `hostname` exactly once, validates every address it returned
// (unless the escape hatch is set), and returns the single address the
// caller must then pin the actual connection to.
async function resolvePinnedAddress(hostname) {
  const bare = bareHost(hostname);
  let addrs;
  try {
    addrs = await dns.promises.lookup(bare, { all: true });
  } catch {
    throw new HttpError(400, 'Could not resolve that host');
  }
  if (!addrs.length) throw new HttpError(400, 'Could not resolve that host');
  if (!config.simplefin.allowInsecureHosts) {
    for (const { address } of addrs) {
      if (isDisallowedAddress(address)) {
        throw new HttpError(400, 'Refused to connect to a private or reserved network address');
      }
    }
  }
  return addrs[0];
}

// Reads a Node http.IncomingMessage body up to a byte cap, destroying the
// connection rather than buffering an unbounded stream.
function readCapped(res, cap) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    res.on('data', (chunk) => {
      total += chunk.length;
      if (total > cap) {
        res.destroy();
        reject(new HttpError(502, 'Response from the bank sync provider was too large'));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', () => reject(new HttpError(502, 'Could not reach the bank sync provider')));
  });
}

// https-only, no redirects, resolved host must not be loopback / private /
// link-local / unique-local / unspecified (v4 and v6, including a literal
// IP given directly as the host), 10s timeout, 10MB response cap. `url` may
// carry HTTP basic-auth credentials (SimpleFIN access URLs do); those are
// pulled off the URL and sent as an Authorization header instead of being
// left in the request line.
export async function safeFetch(url, options = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, 'Invalid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new HttpError(400, 'Only https URLs are allowed');
  }

  const pinned = await resolvePinnedAddress(parsed.hostname);

  const headers = { ...(options.headers || {}) };
  if (parsed.username || parsed.password) {
    const user = decodeURIComponent(parsed.username);
    const pass = decodeURIComponent(parsed.password);
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
  const hostHeader = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  headers.Host = hostHeader;

  // Node's http(s).request `timeout` option only starts a per-socket idle
  // timer and does not reliably fire while a connection is still hung in
  // the TLS handshake (verified: a request to a TCP listener that never
  // speaks TLS sat well past its configured timeout with no 'timeout'
  // event). An AbortController tied to a hard wall-clock timer aborts the
  // request unconditionally regardless of what phase it's stuck in.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await new Promise((resolve, reject) => {
      const req = https.request({
        // `hostname`/`port` below are only used by Node to build the request
        // line and defaults; the actual TCP connection is forced onto
        // `pinned.address` by the custom `lookup` - the same address that
        // was just validated above, not a fresh (and potentially different)
        // DNS answer.
        hostname: bareHost(parsed.hostname),
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method || 'GET',
        headers,
        servername: bareHost(parsed.hostname), // correct TLS SNI regardless of which literal IP we connect to
        // Node's net.connect happy-eyeballs path (used by https.request)
        // calls this with `{ all: true }` and expects an array back in that
        // case, rather than the plain (err, address, family) shape
        // dns.lookup normally uses - handle both so the pinned address is
        // honored either way.
        lookup: (_host, opts, cb) => {
          if (opts && opts.all) return cb(null, [{ address: pinned.address, family: pinned.family }]);
          cb(null, pinned.address, pinned.family);
        },
        signal: controller.signal,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          reject(new HttpError(502, 'Bank sync provider returned a redirect, which is not allowed'));
          return;
        }
        readCapped(res, MAX_BODY_BYTES).then(
          (text) => resolve({ status: res.statusCode, text }),
          reject
        );
      });
      req.on('error', (err) => {
        if (err.name === 'AbortError') {
          reject(new HttpError(502, 'Request to the bank sync provider timed out'));
          return;
        }
        reject(err instanceof HttpError ? err : new HttpError(502, 'Could not reach the bank sync provider'));
      });
      if (options.body != null) req.end(options.body);
      else req.end();
    });
  } finally {
    clearTimeout(timer);
  }
}

// A setup token is a base64-encoded claim URL. POST an empty body to it; a
// 200 body is the access URL (itself a credential - embeds basic-auth
// user:pass). A 403 means the token was already used or never existed.
export async function claimSetupToken(setupToken) {
  let claimUrl;
  try {
    claimUrl = Buffer.from(setupToken, 'base64').toString('utf8');
    new URL(claimUrl); // eslint-disable-line no-new -- validates it decoded to a URL
  } catch {
    throw new HttpError(400, 'That setup token is invalid.');
  }

  const { status, text } = await safeFetch(claimUrl, { method: 'POST', body: '' });
  if (status === 403) {
    throw new HttpError(400, 'That setup token has already been used or is invalid.');
  }
  if (status < 200 || status >= 300) {
    throw new HttpError(502, 'Could not claim that setup token.');
  }
  const accessUrl = text.trim();
  try {
    const check = new URL(accessUrl);
    if (check.protocol !== 'https:') throw new Error('not https');
  } catch {
    throw new HttpError(400, 'That setup token is invalid.');
  }
  return accessUrl;
}

// GET {accessUrl}/accounts. Both `errors` and `errlist` are treated as the
// error array (the protocol uses either); `org` is optional per account.
export async function fetchAccounts(accessUrl, startDateUnix, { balancesOnly = false } = {}) {
  let url;
  try {
    url = new URL(`${String(accessUrl).replace(/\/$/, '')}/accounts`);
  } catch {
    throw new HttpError(400, 'Invalid bank sync connection.');
  }
  if (startDateUnix != null) url.searchParams.set('start-date', String(startDateUnix));
  if (balancesOnly) url.searchParams.set('balances-only', '1');

  const { status, text } = await safeFetch(url.toString(), { method: 'GET' });
  if (status < 200 || status >= 300) {
    throw new HttpError(502, 'Could not fetch accounts from the bank sync provider.');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(502, 'Bank sync provider returned an unexpected response.');
  }
  const errors = data.errors || data.errlist;
  if (errors && errors.length) {
    throw new HttpError(502, 'The bank sync provider reported an error for this connection.');
  }
  return data.accounts || [];
}

// Parses a SimpleFIN decimal-string amount into a *signed* integer number
// of cents, without ever going through binary floating point. Handles a
// leading sign, a missing fractional part, and more than two fractional
// digits (truncated toward zero after the sign is taken). Bounded to the
// same magnitude requireCents (server/validation.js) enforces on every
// other cents value in the app, so an absurd/malformed provider value
// fails with a proper 502 here rather than an unhandled Postgres INTEGER
// range error deeper in the pipeline.
const MAX_ABS_CENTS = 1e12;

export function parseAmountCents(raw) {
  const str = String(raw).trim();
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(str);
  if (!m) throw new HttpError(502, 'Unrecognized amount format from bank sync provider');
  // Guard the whole-dollar digit count before parseInt, so a huge value
  // can't lose precision past Number.MAX_SAFE_INTEGER before the range
  // check below gets to see it.
  if (m[2].length > 15) throw new HttpError(502, 'Amount from bank sync provider is out of range');
  const sign = m[1] === '-' ? -1 : 1;
  const whole = parseInt(m[2], 10);
  const fracDigits = (m[3] || '').slice(0, 2).padEnd(2, '0');
  const frac = parseInt(fracDigits, 10);
  const cents = sign * (whole * 100 + frac);
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_ABS_CENTS) {
    throw new HttpError(502, 'Amount from bank sync provider is out of range');
  }
  return cents;
}

function unixToDateUTC(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

// SimpleFIN's sign convention: negative amount = withdrawal = expense,
// positive = deposit = income. This is the opposite of Plaid's, which used
// positive for money leaving the account.
function toTxn(sfAccountId, sfTxn) {
  const signedCents = parseAmountCents(sfTxn.amount);
  return {
    type: signedCents < 0 ? 'expense' : 'income',
    amountCents: Math.abs(signedCents),
    description: (sfTxn.description || '').trim() || null,
    date: unixToDateUTC(sfTxn.posted),
    hash: `simplefin:${sfAccountId}:${sfTxn.id}`,
  };
}

// Resolve (and cache on ctx) the pay-period config for a template's own
// account, since a template's account may run a different cadence than the
// household's default account whose cfg was loaded for the whole sync.
async function cfgForTemplate(ctx, template) {
  const acctId = template.account_id ?? ctx.defaultAccountId;
  if (!ctx.cfgByAccount.has(acctId)) {
    ctx.cfgByAccount.set(acctId, await getConfig(ctx.budget.id, acctId));
  }
  return ctx.cfgByAccount.get(acctId) || ctx.cfg;
}

async function insertSyncedTxn(clientDb, ctx, link, t, userId, results) {
  const { budget } = ctx;
  if (t.amountCents === 0) return;
  const { rows: period } = await clientDb.query(
    'SELECT id, closed_at FROM pay_periods WHERE budget_id = $1 AND account_id = $3 AND start_date <= $2 AND end_date >= $2 ORDER BY start_date DESC LIMIT 1',
    [budget.id, t.date, link.account_id]
  );
  if (!period.length) {
    results.skipped += 1; // before the household's first period, or future-dated
    return;
  }
  const periodClosed = Boolean(period[0].closed_at);

  // Categorization rules auto-match (first match in user order wins). A
  // recurring match marks the period's line item cleared with the actual
  // amount, exactly like a confirmed CSV row; a tag match just labels it.
  // In a CLOSED (frozen) period a recurring match is left uncategorized for
  // review instead - reconciliation there requires reopening.
  let categoryId = firstMatchingCategory(ctx.rules, {
    description: t.description,
    amountCents: t.amountCents,
    account: ctx.accountsById.get(link.account_id) || null,
  });
  let template = categoryId ? ctx.templatesById.get(categoryId) : null;
  if (template && periodClosed && template.category_type === 'recurring') {
    template = null;
    results.inClosed += 1;
  }
  if (!template) categoryId = null;
  else t.type = template.type;

  const { rows: inserted } = await clientDb.query(
    `INSERT INTO transactions (budget_id, user_id, pay_period_id, category_template_id, type, amount_cents, description, date, import_hash, account_id, categorized_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (budget_id, import_hash) WHERE import_hash IS NOT NULL DO NOTHING
     RETURNING id`,
    [budget.id, userId, period[0].id, categoryId, t.type, t.amountCents, t.description, t.date, t.hash, link.account_id,
     categoryId ? 'rule' : null]
  );
  if (!inserted.length) {
    results.duplicates += 1;
    return;
  }
  results.added += 1;
  if (template && template.category_type === 'recurring') {
    const drift = driftFor(budget, template, t.amountCents, t.date);
    const { cleared, moved } = await clearLineItemForTransaction(clientDb, template, {
      periodId: period[0].id,
      date: t.date,
      amountCents: t.amountCents,
      accountId: link.account_id,
      updatePlanned: true,
    });
    if (cleared) results.cleared += 1;
    if (moved) results.moved += 1;
    // A material difference from plan auto-updates the recurring amount going
    // forward, exactly like a confirmed CSV import.
    if (drift && ctx.cfg) {
      const templateCfg = await cfgForTemplate(ctx, template);
      await setAmountGoingForward(clientDb, budget.id, templateCfg, template.id, t.amountCents, t.date);
      results.drift.push(drift);
      results.replanned += 1;
    }
  }
}

// SimpleFIN has no cursor and no removal feed - a re-fetched date window is
// deduped by import_hash. A conflict on that hash means the row already
// exists: if the re-fetched values differ from what we stored, update in
// place (and re-resolve its pay period); otherwise it's a plain repeat.
async function processTxn(clientDb, ctx, link, sfTxn, userId, results) {
  const { budget } = ctx;
  const t = toTxn(link.sf_account_id, sfTxn);
  if (t.amountCents === 0) return;

  const { rows: existing } = await clientDb.query(
    'SELECT amount_cents, description, date FROM transactions WHERE budget_id = $1 AND import_hash = $2',
    [budget.id, t.hash]
  );

  if (existing.length) {
    const cur = existing[0];
    const changed = cur.amount_cents !== t.amountCents || (cur.description || null) !== t.description || cur.date !== t.date;
    if (!changed) {
      results.duplicates += 1;
      return;
    }
    const { rows: period } = await clientDb.query(
      'SELECT id FROM pay_periods WHERE budget_id = $1 AND account_id = $3 AND start_date <= $2 AND end_date >= $2 ORDER BY start_date DESC LIMIT 1',
      [budget.id, t.date, link.account_id]
    );
    if (!period.length) return; // now outside recorded periods; leave the existing row as-is
    await clientDb.query(
      `UPDATE transactions SET amount_cents = $1, description = $2, date = $3, pay_period_id = $4
       WHERE budget_id = $5 AND import_hash = $6`,
      [t.amountCents, t.description, t.date, period[0].id, budget.id, t.hash]
    );
    results.updated += 1;
    return;
  }

  await insertSyncedTxn(clientDb, ctx, link, t, userId, results);
}

// start-date for a connection's sync window: last_synced_at minus a 7-day
// overlap (absorbs late-posting transactions - safe because of the
// import_hash dedupe above), or on first sync the earliest pay period start
// among that connection's mapped accounts, falling back to 90 days ago.
async function startDateFor(budgetId, connection, mappedAccountIds) {
  if (connection.last_synced_at) {
    return Math.floor(new Date(connection.last_synced_at).getTime() / 1000) - 7 * 24 * 3600;
  }
  if (mappedAccountIds.length) {
    const { rows } = await q(
      'SELECT MIN(start_date) AS min_start FROM pay_periods WHERE budget_id = $1 AND account_id = ANY($2::int[])',
      [budgetId, mappedAccountIds]
    );
    if (rows[0]?.min_start) {
      return Math.floor(new Date(`${rows[0].min_start}T00:00:00Z`).getTime() / 1000);
    }
  }
  return Math.floor(Date.now() / 1000) - 90 * 24 * 3600;
}

// Pull posted transactions for every mapped account of every connection of
// a budget, over each connection's own date window (see startDateFor).
export async function syncBudget(budget, userId) {
  const cfg = await getConfig(budget.id);
  if (!cfg) throw new HttpError(400, 'Complete setup first');
  await ensureMaterialized(budget.id, cfg);

  const { rows: connections } = await q('SELECT * FROM simplefin_connections WHERE budget_id = $1', [budget.id]);
  const results = { added: 0, duplicates: 0, updated: 0, skipped: 0, cleared: 0, moved: 0, inClosed: 0, replanned: 0, drift: [] };
  const { rows: accountRows } = await q('SELECT * FROM accounts WHERE budget_id = $1', [budget.id]);
  const defaultAccountId = await getDefaultAccountId(budget.id);
  const ctx = {
    budget,
    cfg,
    defaultAccountId,
    cfgByAccount: new Map([[defaultAccountId, cfg]]),
    rules: await loadRules(budget.id),
    templatesById: new Map((await loadTemplates(budget.id, { includeArchived: true })).map((t) => [t.id, t])),
    accountsById: new Map(accountRows.map((a) => [a.id, a])),
  };

  for (const connection of connections) {
    const { rows: links } = await q(
      'SELECT * FROM simplefin_account_links WHERE connection_id = $1 AND account_id IS NOT NULL', [connection.id]
    );
    if (!links.length) continue; // nothing mapped yet, nothing to sync
    const linkBySfAccount = new Map(links.map((l) => [l.sf_account_id, l]));

    const startDate = await startDateFor(budget.id, connection, links.map((l) => l.account_id));
    const accounts = await fetchAccounts(decryptSecret(connection.access_url), startDate);

    const clientDb = await pool.connect();
    try {
      await clientDb.query('BEGIN');
      for (const acct of accounts) {
        const link = linkBySfAccount.get(acct.id);
        if (!link) continue;
        for (const txn of acct.transactions || []) {
          if (txn.pending || !txn.posted) continue; // only posted transactions enter the books
          await processTxn(clientDb, ctx, link, txn, userId, results);
        }
      }
      // fetchAccounts already threw on a connection-level error, so reaching
      // here means a clean fetch - safe to advance the sync window.
      await clientDb.query('UPDATE simplefin_connections SET last_synced_at = now() WHERE id = $1', [connection.id]);
      await clientDb.query('COMMIT');
    } catch (err) {
      await clientDb.query('ROLLBACK');
      throw err;
    } finally {
      clientDb.release();
    }
  }
  return results;
}
