# PayCycle

**Self-hosted pay-period budgeting with dual balance tracking.** PayCycle
replaces the classic "budget spreadsheet with one column per paycheck" with a
proper web app: you record your recurring bills and income once, tick things
off as they clear your bank account, and PayCycle projects your estimated
balance years into the future — warning you *now* if a $10/month increase
means you'll go underwater in ten months.

> 📸 *Screenshots / demo GIF coming soon.*

## Why it exists

Most budget tools track what you *spent*. PayCycle tracks two balances per pay
period and the gap between them:

1. **Estimated running balance** — a forward projection assuming every planned
   income and expense happens as scheduled. This is the analytical core: it
   extends indefinitely into the future and recalculates instantly when any
   assumption changes.
2. **Actual account balance** — a running total of only the things you've
   marked **cleared** (actually posted to your bank), plus ad-hoc misc
   transactions.

Those two numbers are *supposed* to diverge — the divergence ("I look fine on
paper, but three bills haven't posted yet") is the signal.

### Features

- **Any pay schedule**: weekly, biweekly, semi-monthly (e.g. 1st & 15th),
  monthly (with sane day-31 handling), or a custom interval — configured in a
  first-run wizard and changeable later.
- **Effective-dated amounts**: when your electric bill goes from $250 to $260,
  you change it *once* with an effective date. Past periods keep their history;
  every future period recalculates from that date forward.
- **Unbounded projection without unbounded storage**: future periods are
  computed on the fly, never stored. Only past/current periods live in the
  database.
- **Early-warning flags**: the first future period projected below $0 (or a
  custom warning threshold) is called out prominently, not buried in a chart.
- **Color-coded balance health** with per-user thresholds (red / pink /
  light blue / solid blue — your risk tolerance, not ours).
- **Misc transactions**: one-off uncategorized amounts per period, income or
  expense, feeding the cleared totals — no formal category needed.
- **Live bank sync (Plaid)**: connect a bank through Plaid Link, map each
  bank account to a PayCycle account, and pull posted transactions on demand.
  Synced rows flow through the same pipeline as CSV imports — duplicate-safe
  (cursor + per-transaction hash), auto-categorized by your learned rules,
  and rule matches mark the period's line item cleared at the actual amount.
  Optional: the feature is hidden unless `PLAID_CLIENT_ID`/`PLAID_SECRET`
  are set (sandbox keys are free at dashboard.plaid.com).
- **CSV bank-statement import** with auto-categorization: map your bank's
  columns once, review suggested matches, and confirm. Matched rows mark the
  period's line item cleared (optionally snapping the planned amount to the
  actual figure); unmatched rows import as misc. Confirmed matches are learned
  as rules for the next import, and duplicate rows are detected automatically.
- **Reports & export**: yearly per-category × month rollups (planned or
  cleared basis) and one-click CSV export of all transactions or per-period
  totals.
- **Installable PWA**: add it to your phone's home screen; the app shell loads
  offline (your data still requires a connection to your server).
- **Multiple bank accounts**: track checking, savings, credit, or cash
  accounts per household. Cleared items, transactions, and imports are
  attributed to an account (a category can be pinned to the account it clears
  from), and the dashboard shows the total actual balance plus a per-account
  breakdown. The projection always covers the household's combined position.
- **In-app notifications**: a bell in the header surfaces bills due in the
  next 7 days that haven't cleared, projected negative/warning-threshold
  crossings, uncleared items when a period is about to end, and a nudge when
  nothing has been recorded for 10 days. Dismissals are per member, per
  instance — no email server required.
- **Email notifications (optional)**: point the server at any SMTP host and
  members can opt in (Settings → Notifications) to receive new notifications
  as email digests. Each instance is emailed at most once per user; without
  SMTP configured nothing changes.
- **Foreign-currency tracked accounts**: an account in a different currency
  (a EUR savings account in a USD household) keeps its balance in its own
  currency and stays outside period budget math — no exchange-rate guessing,
  no distorted projections. Its transactions are still recorded and visible.
- **Shared household budgets**: every budget belongs to a household. Invite a
  partner with a 7-day invite code — they can enter it while registering (this
  works even when open registration is disabled) or from Settings on an
  existing account. Members share everything (periods, categories, balances);
  transactions record who entered them. Owners manage invites and members.
- **Multi-user** with email/password auth and no external dependencies —
  separate households never see each other's data.
- **Single sign-on (optional)**: plug in any OIDC provider — Google,
  Keycloak, Authentik — and a "Continue with …" button appears on the login
  page. Accounts link by verified email; new SSO sign-ups respect
  `ALLOW_REGISTRATION` and household invite codes, and a backchannel URL
  override supports providers running on the same Docker network.

## Quick start (docker compose)

```bash
git clone https://github.com/YOUR_USER/paycycle.git
cd paycycle
cp .env.example .env
# edit .env: set SESSION_SECRET (openssl rand -hex 32) and POSTGRES_PASSWORD
docker compose up -d
```

Open `http://localhost:8080`, create an account, and walk through the setup
wizard. That's it — the app container runs database migrations automatically
on startup.

To update: `git pull && docker compose up -d --build`.

### Using a prebuilt image

If you don't want to build locally, replace the `build: .` line in
`docker-compose.yml` with a published image (multi-arch, amd64 + arm64 — runs
on a Raspberry Pi):

```yaml
  app:
    image: YOUR_DOCKERHUB_USER/paycycle:latest
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://paycycle:paycycle@localhost:5432/paycycle` | Postgres connection string. The compose file wires this to the bundled `db` service. |
| `SESSION_SECRET` | *(random per boot)* | **Set this.** Secret for signing session tokens. If unset, a temporary one is generated and all logins are invalidated on restart. |
| `PORT` | `8080` | Port the app listens on inside the container. |
| `ALLOW_REGISTRATION` | `true` | Set `false` to disable open sign-ups after creating your own account. Household invite codes still work, so family can always join. |
| `DEFAULT_CURRENCY` | `USD` | Currency preselected during onboarding (any ISO 4217 code — each user picks their own). |
| `SECURE_COOKIES` | `false` | Set `true` when serving over HTTPS (behind a reverse proxy). |
| `TRUST_PROXY` | `false` | Set `true` when running behind a reverse proxy so client IPs resolve correctly. |
| `TZ` | container default | Timezone used to decide "today" for pay-period boundaries. Set to your local zone, e.g. `America/New_York`. |
| `APP_URL` | *(empty)* | Public URL of your instance, used for links inside notification emails, e.g. `https://paycycle.example.com`. |
| `SMTP_HOST` | *(empty)* | SMTP server for emailed notifications. Leave empty to disable email entirely (in-app notifications always work). |
| `SMTP_PORT` | `587` | SMTP port. |
| `SMTP_SECURE` | `false` | Set `true` for implicit TLS (usually port 465). |
| `SMTP_USER` / `SMTP_PASS` | *(empty)* | SMTP credentials, if your server needs them. |
| `SMTP_FROM` | `PayCycle <paycycle@localhost>` | From address on notification emails. |
| `NOTIFICATION_EMAIL_INTERVAL_MINUTES` | `60` | How often the server checks for notifications to email. |
| `PLAID_CLIENT_ID` / `PLAID_SECRET` | *(empty)* | Plaid API keys for live bank sync. Leave empty to hide the feature. |
| `PLAID_ENV` | `sandbox` | `sandbox`, `development`, or `production`. In sandbox, connect any bank with the test login `user_good` / `pass_good`. |
| `PLAID_COUNTRY_CODES` | `US` | Comma-separated country codes for Plaid Link. |
| `OIDC_ISSUER` | *(empty)* | OIDC issuer URL for single sign-on, e.g. `https://accounts.google.com`. Register your client with redirect URI `<APP_URL>/api/auth/oidc/callback`. Leave empty to hide SSO. |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | *(empty)* | Credentials from your OIDC provider. |
| `OIDC_PROVIDER_NAME` | `SSO` | Label on the login button ("Continue with Google"). |
| `OIDC_ISSUER_INTERNAL` | *(empty)* | Optional backchannel base URL when the public issuer isn't reachable from inside the container (e.g. `http://keycloak:8080/realms/main` on the same compose network). |
| `POSTGRES_PASSWORD` | `paycycle` | (compose only) Password for the bundled Postgres container. |
| `PAYCYCLE_PORT` | `8080` | (compose only) Host port the app is published on. |

## Health check

`GET /healthz` returns `{"status":"ok"}` (HTTP 200) when the app and its
database connection are healthy, 503 otherwise. The Docker image ships with a
`HEALTHCHECK` wired to it, so `docker ps` and orchestrators see readiness.

## Backing up your data

All persistent state lives in the `paycycle-db` named volume. To back up:

```bash
docker compose exec db pg_dump -U paycycle paycycle | gzip > paycycle-backup-$(date +%F).sql.gz
```

To restore into a fresh install:

```bash
gunzip -c paycycle-backup-YYYY-MM-DD.sql.gz | docker compose exec -T db psql -U paycycle paycycle
```

Automate the dump with cron; the app never needs to stop for a backup.

## How the numbers work

For each pay period (matching the original spreadsheet semantics):

```
Total planned expenses = Σ planned amounts of expense line items
Total cleared expenses = Σ planned amounts of CLEARED expense items
                       + Σ misc expense transactions this period

Planned income         = Σ planned amounts of income line items
Misc income            = Σ misc income transactions this period
Total cleared income   = Σ planned amounts of CLEARED income items + misc income

Period loss/gain       = (planned income + misc income) − total planned expenses

Estimated balance(p)   = (planned income + misc income)
                       − (total planned expenses + misc expenses)
                       + estimated balance(p−1)

Actual balance         = starting balance
                       + Σ over real periods (cleared income − cleared expenses)
```

Past and current periods are real database rows whose line-item amounts are
**frozen snapshots** (editable per period without touching the template).
Future periods are computed live from your category templates and their
effective-dated amounts. Notes on the edges:

- Adding a category mid-period adds it to the current period immediately;
  changing a template amount affects future periods only (edit the current
  period's line item directly if you want it to change too).
- Archiving a category removes it from all future periods but leaves recorded
  history — including the current period's snapshot — intact.
- Changing your pay schedule keeps all recorded periods as-is and applies the
  new cadence from the next period forward.
- Monthly categories (e.g. "rent, due the 1st") land in whichever pay period
  contains that day of month; day 31 falls back to the last day of short months.
- Accounts split only the *actual* side: each account's balance is its
  starting balance plus the cleared items and misc transactions attributed to
  it, and the sum across accounts always equals the household's actual
  balance. Archiving an account hides it from pickers but keeps its history
  in the totals.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). Stack: Node.js + Express + Postgres
(raw SQL, no ORM), React + Vite frontend, everything in integer cents.

```bash
npm install && npm run dev        # API on :8080 (needs a local Postgres)
cd web && npm install && npm run dev   # UI on :5173, proxying /api
npm test                          # schedule/projection engine tests
```

## Roadmap

The entire original Phase 2 list has shipped: CSV import with
auto-categorization, reports/exports, PWA installability, shared household
budgets, multiple bank accounts, in-app + email notifications,
foreign-currency tracked accounts, Plaid bank sync, and OIDC single sign-on.

Ideas beyond the original scope: scheduled automatic bank sync, richer
analytics (category trends, sankey flows), budget goal tracking, and CSV/PDF
report exports per category.

Household semantics: each user belongs to exactly one household at a time.
Leaving (or being removed from) a household gives that user a fresh empty
budget; joining another household as the sole member of a budget with data
deletes that old budget after an explicit confirmation. When an owner leaves,
the longest-standing member is promoted automatically.

One accounting note for importers: a transaction linked to a category is
treated as the *record of that line item clearing* — the line item's amount
carries the value and the transaction does not additionally count as misc, so
nothing is double-counted.

## License

[MIT](LICENSE)
