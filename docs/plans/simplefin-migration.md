# SimpleFIN migration — replace Plaid bank sync

**Status:** approved for build 2026-07-21. Decision recorded 2026-07-09.
**Outcome:** Plaid is removed entirely. SimpleFIN Bridge is the only bank-sync provider.

## Why

PayCycle is self-hosted software run by individuals. Plaid requires a business
Production application, underwriting review, per-item billing paid by the app
operator, and a compliance posture — none of which a single self-hoster can
satisfy. SimpleFIN Bridge was built for this case: the end user signs up with
SimpleFIN directly, pays for it themselves, and pastes a setup token into their
own PayCycle instance. Nothing is required of the PayCycle operator.

## The consequential difference

Plaid credentials were **server-wide** (`PLAID_CLIENT_ID`/`PLAID_SECRET`), so the
feature was hidden unless the operator configured them. SimpleFIN credentials are
**per household** (a setup token the user obtains and pastes). Therefore:

- All `PLAID_*` env vars are deleted; no `SIMPLEFIN_*` replacement is required
  for the feature to *work* once turned on — SimpleFIN credentials are
  per-household (a pasted setup token), not server-wide.
- The connect flow is a paste-a-token form, not a hosted JS widget. **The
  `cdn.plaid.com` script tag goes away** — no third-party script loads in the
  browser at all.

  **2026-07-23 update — reverses the "always visible" decision above.**
  Bank sync now ships **off by default**, gated by `BANK_SYNC_ENABLED=true`
  (the same idiom as `SIMPLEFIN_ALLOW_INSECURE_HOSTS`, strict `=== 'true'`).
  The rationale for making it env-gated after all is operational, not
  technical: the operator wants to ship the feature code dark and switch it
  on deliberately later rather than have it live the moment this branch
  merges. Every `/api/simplefin/*` route except `GET /status` 404s (not 403)
  when the flag is off, enforced by router-level middleware so no future
  route can forget the check. `GET /status` always returns 200 so the
  frontend knows whether to render, but reports `{ enabled: false,
  connections: [] }` and does not touch the database when disabled — it only
  reports `enabled: true` (with real connection data) once the flag is on.

## Protocol facts this build depends on

Verified against <https://www.simplefin.org/protocol.html> on 2026-07-21.

- A **setup token** is a base64-encoded claim URL. Decode it, `POST` to that URL
  with an empty body; a 200 returns an **access URL** of the form
  `https://user:pass@host/path`. A 403 means already-claimed or non-existent.
- `GET {accessUrl}/accounts` with query params `start-date` / `end-date` (unix
  epoch seconds), `pending=1` (we never set it), `balances-only=1`, `account`.
- Response: `{ "errors"|"errlist": [...], "accounts": [ { id, name, currency,
  balance, "balance-date", org?: { name, domain }, transactions?: [ { id,
  posted, amount, description, transacted_at?, pending? } ] } ] }`.
  Treat both `errors` and `errlist` as the error array; treat `org` as optional.
- **Amounts are decimal strings. Positive = deposit, negative = withdrawal.**
  This is the *opposite* of Plaid's convention — Plaid used positive for money
  leaving. Getting this backwards silently inverts every transaction, so it is a
  named check below.
- `posted` and `transacted_at` are unix epoch **seconds**.
- **SimpleFIN has no cursor and no deletion feed.** There is no equivalent of
  Plaid's `transactionsSync` added/modified/removed triple. Syncing is a date
  window pulled repeatedly, deduped by `import_hash`.
- Demo access URL for testing: `https://demo:demo@beta-bridge.simplefin.org/simplefin`.

## Locked design decisions

1. **Schema (migration `014_simplefin.sql`).** `DROP TABLE plaid_account_links,
   plaid_items` and create:
   - `simplefin_connections(id, budget_id → budgets ON DELETE CASCADE, access_url
     TEXT NOT NULL (encrypted at rest), label TEXT, last_synced_at TIMESTAMPTZ,
     created_by, created_at)`, indexed on `budget_id`.
   - `simplefin_account_links(id, connection_id → simplefin_connections ON DELETE
     CASCADE, sf_account_id TEXT NOT NULL, sf_name TEXT, sf_org_name TEXT,
     sf_currency TEXT, account_id → accounts ON DELETE SET NULL, UNIQUE
     (connection_id, sf_account_id))`.
   - Org name lives on the **link**, not the connection: one SimpleFIN access URL
     can expose accounts from several institutions. There is no `mask` — SimpleFIN
     does not provide one.
   - **This is a one-way migration.** Plaid access tokens are worthless once the
     Plaid client is gone, and no household can be carrying live Plaid items in
     practice (Production access required a business application). No down path
     is provided. Recovery from a bad run is a database restore. Recorded here in
     writing per CONSTITUTION §6(d).
   - `transactions` rows are **not touched**. Historical `plaid:*` `import_hash`
     values stay exactly as they are; they simply stop matching anything.

2. **`import_hash` format:** `simplefin:{sf_account_id}:{txn_id}`. Keyed on the
   SimpleFIN account id, *not* our link row id, so deleting and re-adding a
   connection does not re-import history as new rows.

3. **Sync window.** No cursor exists. On each sync, per connection:
   - `start-date` = `last_synced_at − 7 days` (overlap absorbs late-posting), or
     on first sync the earliest `pay_periods.start_date` among that connection's
     mapped accounts, falling back to `now − 90 days`.
   - `end-date` omitted. `pending` never requested; any row arriving with
     `pending: true` or `posted` falsy is skipped.
   - Re-fetch overlap is safe because `ON CONFLICT (budget_id, import_hash) DO
     NOTHING` already dedupes, and the modified-row path updates in place.
   - `last_synced_at` is only advanced when the fetch succeeded with no
     connection-level errors.

4. **Deletions are not supported, by protocol.** The `removed` counter is dropped
   from the result object and from the UI summary sentence. This is a real
   capability loss versus Plaid and is documented in the README, not papered over.

5. **Amount parsing must not go through binary floating point.** Parse the decimal
   string to integer cents directly (sign, split on `.`, pad/truncate the
   fractional part to 2 digits). `Math.round(parseFloat(x) * 100)` is a FAIL.

6. **Currency.** A SimpleFIN account whose `currency` is not the household base
   currency may not be mapped. The existing mapping rule already restricts targets
   to `currency IS NULL AND NOT archived` accounts; keep it.

7. **SSRF is the new attack surface and must be mitigated in this build.** An
   authenticated user supplies a token that decodes to an arbitrary URL which the
   *server* then fetches. Required, in a shared helper used by both the claim and
   the accounts fetch:
   - scheme must be `https:` (reject `http:`, `file:`, everything else);
   - resolve the hostname and reject loopback, private, link-local, unique-local,
     and unspecified addresses (IPv4 and IPv6), including literal-IP hosts;
   - do **not** follow redirects (`redirect: 'error'`);
   - request timeout (10s) and a response body size cap (10 MB);
   - never echo the fetched URL, the access URL, or the response body into an API
     error message or a log line.
   - Optional escape hatch for self-hosters running their own bridge:
     `SIMPLEFIN_ALLOW_INSECURE_HOSTS=true` relaxes the private-address block only.
     Default off.

8. **The access URL is a credential** (it embeds basic-auth user:pass). Store it
   with the existing `encryptSecret` from `server/services/secrets.js`. It is
   never returned by any API response and never logged. The setup token is used
   once and never stored.

9. **Reused unchanged:** the whole downstream pipeline — period resolution by
   account, `firstMatchingCategory` rules, `clearLineItemForTransaction`,
   `driftFor`/`setAmountGoingForward`, the closed-period rule that leaves a
   recurring match uncategorized. The per-template `cfgForTemplate` helper and its
   always-use-the-template's-own-account-config behavior carry over verbatim.

## Files

| Action | Path |
| --- | --- |
| add | `migrations/014_simplefin.sql` |
| add | `server/services/simplefin.js` |
| add | `server/routes/simplefin.js` |
| delete | `server/services/plaid.js`, `server/routes/plaid.js` |
| edit | `server/config.js` (drop `plaid` block), `server/index.js` (mount, drop `encryptLegacyTokens` boot pass) |
| edit | `package.json` (drop the `plaid` dependency) |
| edit | `docker-compose.yml` (drop `PLAID_*`) |
| rewrite | `web/src/components/BankSync.jsx` |
| edit | `README.md` |

## API surface (all under `/api/simplefin`, budget-scoped + authenticated)

- `GET  /status` → `{ enabled, connections: [ { id, label, lastSyncedAt,
  accounts: [ { id, sfAccountId, name, org, currency, accountId } ] } ] }`.
  `enabled` reflects `BANK_SYNC_ENABLED`; when false, `connections` is always
  `[]` and no other route below is reachable (404).
- `POST /claim` `{ setupToken }` → claims, stores connection + links, `201 { connectionId }`
- `PATCH /links/:id` `{ accountId | null }` → map/unmap (same rules as before)
- `POST /sync` → result counters
- `DELETE /connections/:id` → `204`

## Phases

Each phase is a worker task followed by its checkers. Phases run **in sequence**,
never in parallel — the migration is destructive and the checkers share a
database (see the Phase 2b incident).

- **Phase 1 — backend.** Migration, service, routes, Plaid removal.
  Checkers: build-checker (must run the migration on an **isolated ephemeral DB**
  per CONSTITUTION §6, via `npm run test:integration:ephemeral`'s DB, never the
  shared dev DB) + security-checker (SSRF mitigation, credential-at-rest,
  auth on every new route, no secret in logs/errors, dependency scan).
- **Phase 2 — frontend.** Rewrite `BankSync.jsx` for the paste-token flow.
  Checkers: build-checker, a11y-checker (rendered, both themes), design-checker
  (§4 tokens only — the new form must reuse `.card` / `.btn-primary` / input
  patterns and introduce no new token).
- **Phase 3 — docs.** README bank-sync section and env table.
  Checker: content-checker.

## Copy changes (CONSTITUTION §1 — specified up front, not paraphrased)

Every visible string below is a **deliberate replacement**, because the provider
named in the old copy no longer exists in the product. Nothing else in the app
changes wording.

Card intro paragraph, replacing the Plaid sentence:

> Connect your bank through SimpleFIN and pull posted transactions straight into
> your budget. Learned import rules categorize them automatically; matched bills
> are marked cleared.

Setup help text, shown above the token field when no connection exists:

> Get a setup token from your SimpleFIN Bridge account, then paste it below. The
> token is used once and never stored — PayCycle keeps only the access URL it
> returns, encrypted.

Field label: `Setup token`. Button: `Connect a bank` / `+ Connect another bank`.
Success message after claiming:

> Bank connected — choose which PayCycle account each bank account syncs into,
> then hit Sync.

Sync summary sentence (drops the removed-count clause, which no longer exists):

> Sync complete: {added} new, {cleared} line items cleared, {updated} updated{, N already imported}{, N recurring plan(s) updated going forward}{, N outside your recorded periods}.

Disconnect confirm, unchanged in meaning:

> Disconnect this bank? Already-synced transactions stay in your budget.

The `{environment} mode` badge is **removed** — SimpleFIN has no sandbox/production
environment distinction.
