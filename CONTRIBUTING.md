# Contributing to PayCycle

Thanks for your interest! PayCycle is a small, focused project — contributions
are welcome, especially bug fixes, deployment improvements, and Phase 2
features (see the roadmap section of the README).

## Reporting bugs & requesting features

Open an issue using the [bug report](https://github.com/Greyborne/paycycle/issues/new?template=bug_report.yml)
or [feature request](https://github.com/Greyborne/paycycle/issues/new?template=feature_request.yml)
template ([search existing issues](https://github.com/Greyborne/paycycle/issues?q=is%3Aissue)
first). For anything non-trivial, please open an issue before writing code so we
can agree on the approach. Security vulnerabilities go through
[SECURITY.md](SECURITY.md), **not** public issues.

## Development setup

```bash
# 1. Start a local Postgres
docker run -d --name paycycle-dev-db \
  -e POSTGRES_USER=paycycle -e POSTGRES_PASSWORD=paycycle -e POSTGRES_DB=paycycle \
  -p 5432:5432 postgres:16-alpine

# 2. Backend (runs migrations automatically, serves on :8080)
npm install
npm run dev

# 3. Frontend dev server with API proxy (serves on :5173)
cd web && npm install && npm run dev
```

## Tests

```bash
npm test              # unit tests for the schedule/projection engine (no DB)
npm run test:integration   # budget-engine tests against a real Postgres
```

`test:integration` needs a migrated database reachable via `DATABASE_URL` (the
dev Postgres above works — run `npm run migrate` against it first). CI runs both
suites; see `.github/workflows/ci.yml`.

Please add tests for any change to the pay-period date math or the projection
engine — those are the parts users trust with their money.

## Guidelines

- Keep money as integer cents end to end; never floats.
- Dates are plain `YYYY-MM-DD` strings; no timezone conversions in domain logic.
- Derived values (totals, running balances) are computed on read, not stored.
- No personal defaults or hardcoded secrets — everything configurable via env.

## Pull requests

Fork, branch, and open a PR against `main` with a short description of what
changed and why. Run `npm test` and `npm run build:web` before submitting.
