# Build spec — SimpleFIN tolerant sync + surfaced errors

Status: in progress (2026-07-25, from `main` @ 2720df5). Prod bug fix.

## The bug (diagnosed from prod symptom)

SimpleFIN's `/accounts` response returns `accounts` AND `errors` together.
Per the protocol, `errors` is a list of human-readable per-account /
per-connection notices; other accounts in the same response are still
good. `fetchAccounts` (server/services/simplefin.js:356-359) throws a
generic 502 the moment `errors` is non-empty — discarding every good
account AND the real error text. Result: one flaky account fails the
whole "Sync now", and the user can't see why (screenshot: "The bank sync
provider reported an error for this connection.").

Account list still renders because it's served from cached
`simplefin_account_links` (stored at claim time), not a live fetch; only
"Sync now" does the live fetch that carries the `errors` array.

## Decided behavior (user ruling 2026-07-25)

Sync the good accounts, warn about the rest. Do NOT keep the
all-or-nothing abort.

## Changes

1. **`fetchAccounts`** returns `{ accounts, errors }` instead of throwing
   on a non-empty `errors` array. It STILL throws on genuine hard
   failures: non-2xx HTTP (`Could not fetch accounts…`), unparseable JSON
   (`…unexpected response`), invalid URL. A populated `errors` array is no
   longer, by itself, fatal.
2. **`syncBudget`** collects each connection's `errors` into a
   `results.warnings` array (structured: connection label + the real
   SimpleFIN message strings), processes the accounts that came back as
   today, continues to the next connection instead of throwing, and
   advances `last_synced_at` for any connection whose fetch succeeded
   (HTTP-ok + parseable), even with soft errors.
3. **`/claim`** consumes the new `{accounts, errors}` shape: store the
   good accounts as today. If `accounts` is non-empty, succeed (include
   any `errors` as a claim-time warning). If `accounts` is empty AND
   `errors` present, THAT is a real failure for a brand-new connection —
   throw 502 **with the real error text** so the user sees why claiming
   found nothing (this is the one place a surfaced-but-still-block makes
   sense: there is nothing to keep).
4. **`BankSync.jsx`** on a successful sync shows `r.warnings` distinctly
   (a warning style, not the red `.form-error` and not the green success
   line) with the real per-connection message(s). Success counts still
   show. Hard failures still surface via the existing `.form-error`.

## Security (§3 — REQUIRED, this is financial sync)

- The real SimpleFIN error text now flows to the authenticated household
  user (their own data — acceptable). Do NOT add server-side logging of
  account names/masks/balances to get it there; returning it in the
  authed response is the mechanism, no new logs.
- No route/auth change: `/simplefin/sync` and `/claim` keep their existing
  auth. Only the response body shape grows (adds `warnings`).
- No change to the SSRF guard, the access-URL encryption, or `safeFetch`.

## Verification

- Unit test: `fetchAccounts` with a mocked response containing BOTH
  accounts and a non-empty `errors` array returns both and does NOT throw;
  non-2xx still throws; errors-with-empty-accounts behavior per rule 3.
- Behavior test: `syncBudget` across two connections where one returns an
  error + good accounts — the good accounts' transactions are processed,
  `warnings` is populated, the other connection is unaffected, and the
  errored connection's window still advances.
- Rendered: BankSync shows the warning on a successful-with-warnings sync,
  both themes.
- security-checker on the diff; build-checker re-runs the suite.

## Scope

`server/services/simplefin.js`, `server/routes/simplefin.js`,
`web/src/components/BankSync.jsx`, and a test file. No schema change.
