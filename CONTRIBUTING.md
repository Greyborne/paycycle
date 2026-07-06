# Contributing to PayCycle

Thanks for your interest! PayCycle is a small, focused project — contributions
are welcome, especially bug fixes, deployment improvements, and Phase 2
features (see the roadmap section of the README).

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
npm test          # unit tests for the schedule/projection engine
```

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
