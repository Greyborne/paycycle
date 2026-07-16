# Plan: account-first pay periods

**Status:** COMPLETE — all phases built and independently verified
(branch `account-first-periods`; 2026-07-15/16)
**Author:** boss session, 2026-07-15
**Problem:** Closing a pay period closes it for every bank account at once.
There is no way to close a period on one account while leaving another open.

## Outcome

Delivered. A pay period can now be closed for one bank account while another
stays open, each account runs on its own cadence, and both are drivable from
the UI. Every slice was built by a worker and independently re-verified by a
checker on isolated ephemeral databases.

| Phase | Scope | Commit |
|-------|-------|--------|
| 1a–3  | Migration 013, engine core, close/reopen, period locks | `ec9cd34` |
| 4 s1  | Per-account close/reopen UI + labeling + modal focus    | `96fa4f3` |
| 4b    | Per-account pay schedules in Settings                   | `2d05093` |
| 5     | Roll-up decisions + correctness cleanup                 | (this)   |

**Phase 5 was a correctness cleanup, not a build.** Two of its three planned
pieces already existed: the Net worth card already summed base-currency
accounts *including* credit (and since charging a card is recorded as an
expense that drives its balance negative, it already nets debt against
assets), and per-account warnings already shipped in `notifications.js`. What
Phase 5 actually fixed was damage phases 1a–1b had done:

- **Wrong-cadence projections.** `dashboard.js`, `notifications.js`, and
  `reports.js /summary` all passed the *default* account's cfg to a
  *per-account* `buildProjection`. Materialized periods were fine (they come
  from DB rows); the **future** projection was computed on the wrong cadence,
  quietly undermining phase 4b. Each now uses `getConfig(budgetId, accountId)`.
- **Garbled CSV export.** `/export/periods.csv` ran unscoped, emitting one row
  per account per period with interleaved running balances. Now per-account
  with a leading `account` column and per-account balance chains; `?account=`
  exports one.
- **Broken period-end nudge.** Used whichever account's projection ran last,
  counted uncleared items across all accounts, and collided notification keys.
  Now per-account throughout; the unscoped fallback is gone.
- **CSV formula injection (CWE-1236).** Putting account names into an export
  surfaced it: `csvEscape` didn't neutralize a leading `=`/`+`/`-`/`@`. Fixed
  in the shared helper, which also closed the **pre-existing** hole in
  `transactions.csv` (descriptions, category names). Negative amounts are
  excluded from neutralization via a plain-number test so exports stay numeric.
- **Notification links.** Were `/period/<start>` with no account, so a
  "Savings projected to go negative" alert opened whichever account was last
  selected. Links now carry `?account=`, and `PeriodDetail` honours it from
  the URL (switching the selected account to match).

### Decisions locked with the user during the build

1. **Fully independent per-account lifecycles**, not per-account close state
   inside shared periods.
2. **Different cadence per account** — this is what made the account the
   primary period entity and demoted "household" to a roll-up.
3. **Net worth: all accounts, assets minus liabilities**, credit as negative —
   satisfied by the existing natural math (no special-casing; a card you owe on
   is entered with a negative starting balance). No liability sign convention
   was added, so nothing reinterprets existing data.
4. **Foreign-currency accounts excluded** from the net-worth figure and listed
   separately — the app has no FX rate source and `accounts.js` states amounts
   never convert. A literal "all accounts" number would need a whole new
   capability (rate API, caching, staleness).
5. **Warnings per-account**, matching the code's own rationale: a healthy
   household total can hide an overdraft in one account.
6. **Settings lists every account's schedule** (single-account households keep
   the simpler UI — no added chrome for the common case).

### Known follow-ups (none blocking)

- `POST /:start/reopen` isn't wrapped in a transaction the way `close` is — a
  mid-sequence crash could leave a period partially reopened.
- No test covers the `scope=forward` path; a `$1`-placeholder bug shipped
  through it and was caught only by a live checker run.
- Unbounded integer ids from route params across ~7 route files (500 instead
  of 400 on malformed ids). `settings.js` has the reference guard.
- Pre-existing axe violations in the Settings "Bank accounts" table.
- `/summary`'s `realPeriods` overlap detection is still unscoped across
  accounts — latent until two accounts' materialized periods overlap in date.
- Migration 013 left empty period/config rows for foreign-currency accounts.
- `setAmountGoingForward`'s template SELECT has no defence-in-depth
  `budget_id` filter (safe today; both callers validate ownership first).

---

## Original plan (as approved)

---

## Why it happens today

Pay-period closing was built as a **household-wide** operation with no account
dimension.

- **The period row is per-household.** `pay_periods` is keyed
  `UNIQUE (budget_id, start_date)` — one row per household per period
  (`migrations/003_households.sql:62`). Close state lives directly on that row:
  `closed_at` and `closed_snapshot` are columns on `pay_periods`
  (`migrations/007_period_lifecycle.sql`). `POST /:start/close` sets `closed_at`
  once (`server/routes/periods.js`), so the period closes for every account
  simultaneously.
- **The lifecycle is computed household-wide.** `getLifecycle` picks "current"
  as the earliest budget row with `closed_at IS NULL`
  (`server/services/budget.js`). One lifecycle per household, not per account.
- **Accounts only split the "actual" side.** By design
  (`migrations/004_accounts_notifications.sql`), accounts divide starting
  balances and which account each cleared line item / transaction hits. The
  period lifecycle was never given the same treatment.

**What de-risks the change:** per-account reconciliation math already exists.
`buildProjection({ accountId })` produces a fully account-scoped chain — both
estimated and cleared balance per account (`server/services/budget.js:483`) —
and `clearedBalancesForPeriod` already writes a per-account snapshot map. Line
items and transactions already carry `account_id`.

---

## Decisions (locked with the user)

1. **Independence:** fully independent per-account lifecycles — each account
   advances its own current period, keeps its own closed history.
2. **Different cadences:** yes. The user has income streams that arrive on
   different schedules; each account gets its own cadence + anchor, not a shared
   household cadence. This is the decision that makes the account the primary
   period entity and demotes "household" to a roll-up.
3. **Household view:** keep a **Net worth card** showing all accounts.
4. **Net worth definition:** all accounts, **assets minus liabilities** (credit
   as negative).
5. **Warnings:** **per-account** — each account alerts on its own projected
   balance. The net-worth card is informational only.

### Guiding shift

The **account** becomes the primary period entity; "household" becomes a pure
roll-up. Because a period row will belong to one account, closing it is
inherently per-account — the earlier "join table" idea is dropped.

---

## Phases

### Phase 1 — Re-platform the period engine onto accounts
- `pay_period_configs`: add `account_id`; each account carries its own cadence +
  anchor. Migrate the single household config → one per existing account.
- `pay_periods`: add `account_id`, key `(account_id, start_date)`.
  `closed_at`/`closed_snapshot` stay on the row and are now per-account by
  construction.
- Migration: split each existing household period into one row per account,
  reassigning line items & transactions by their `account_id`.
- `ensureMaterialized` / `materializePeriodAfter` / `syncLineItems` become
  per-account.

### Phase 2 — Lifecycle & close engine, per account
- `getLifecycle(budgetId, cfg, accountId)`; current/latest-closed read from that
  account's rows.
- Close/reopen scoped to the account: uncleared filter by `account_id`,
  carry-forward within the account, close-out **adjustment** targets the account
  (not the hard-coded default at `server/routes/periods.js:224`), snapshot is a
  single scoped value.

### Phase 3 — Period-lock enforcement becomes per-account
Every "is this period closed?" gate keys off the row's account:
- transactions (`server/routes/transactions.js:56`, `:82`, the `period_closed`
  flags at `:109/:166/:222`)
- imports / Plaid (`server/routes/import.js:119`, `server/services/plaid.js:66`)
- `clearLineItemForTransaction` & forward-scope skips
  (`server/services/budget.js:230`, `:296`)
- categories' uncleared query (`server/routes/categories.js:186`)

### Phase 4 — Views go account-pivoted
Period routes already thread `?account=` / `resolveAccountId` /
`getPeriodDetail(...accountId)`, so scaffolding exists. Make
`status`/`canReopen`/`closedAt` read per-account state; `/current` per selected
account; `web/src/pages/PeriodDetail.jsx` + any dashboard current-period banner
require an explicit account.

### Phase 5 — Household roll-up & warnings
- **Net worth card:** all accounts, assets minus liabilities (credit negative).
  Two computations — a "now" number from `accountBalances`
  (`server/services/budget.js:88`), and a combined forward line that projects
  each account on its own timeline and aggregates on a shared calendar axis
  (non-aligned periods can no longer be summed period-by-period).
- **Warnings:** per-account, rewired from the household lifecycle.
  Notifications move from household lifecycle → per-account.

**Open implementation detail (resolve at Phase-5 spec time, non-blocking):**
foreign-currency accounts are excluded today (`currency IS NULL`). True net
worth including them needs an FX rate source. Likely resolution: net worth in
base currency, foreign accounts either converted (if a rate is available) or
shown segregated.

---

## Sequencing & build mechanics

- **1 → 2 → 3 strictly sequential** (each depends on the prior). **4 and 5
  overlap** once 2 lands.
- Shipped through the swarm: each phase spec'd as isolated `code-worker` tasks,
  `build-checker`-verified; `security-checker` on Phase 3
  (transactions/imports).
- **Destructive close/reopen tests run on an isolated ephemeral DB, not the
  shared dev DB, and are not parallelized** (per the Phase-2b incident rule).
- **Phase 1's data migration is the highest-risk step** — it gets a dry-run +
  row-count reconciliation before it is trusted.

---

## Model tiering for this build

Boss (this session): expensive model — spec + judging only.
Workers: cheapest model that does the job without thrashing the checker loop.
Checkers: mid-tier for mechanical re-verification.

This build is backend Node/SQL (data-model migration + lifecycle logic), so the
relevant agents are `code-worker`, `build-checker`, and `security-checker`;
content/a11y/design agents are barely involved.
