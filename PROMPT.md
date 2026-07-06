# Prompt for Fable 5: Build "PayCycle" — Self-Hosted Budget Tracker

## Context / Vision

I'm replacing a highly complex personal Google Sheets budget tracker with a proper self-hosted web application. This will eventually be published as an **open-source, public Docker Hub image** for the self-hosting community — not just a personal tool. Build it accordingly: no hardcoded personal data, no assumptions specific to one household, configurable branding, and documentation good enough for a stranger to deploy it with zero hand-holding.

Working name: **PayCycle** (riffing on FlowCast, an earlier project of mine — feel free to propose alternatives if something clearer fits once you see the full picture).

This is a **Phase 1 exact-functional-parity build.** Match the spreadsheet's actual behavior faithfully first. A "Phase 2 ideas" section at the bottom lists enhancements that are explicitly *out of scope* for the initial build but should inform architecture decisions so they're easy to bolt on later.

---

## What the Spreadsheet Actually Does

The source is a Google Sheets biweekly pay-period budget/checkbook register. It uses a spreadsheet-native pattern — **one pair of columns per pay period, repeated across the sheet** — to simulate a time series. **Do not replicate that as literal database columns.** Translate it into a normalized relational model (see Data Model section). The behavior to preserve is described below in plain terms.

### Core concept: dual balance tracking

The whole point of this tool is tracking **two parallel balances per pay period**:

1. **Planned/Estimated Running Balance** — a forward projection assuming all planned income and expenses happen as scheduled.
2. **Actual Account Balance** — a running total based only on transactions the user has manually marked "cleared" (i.e., actually posted to their bank account).

These two numbers are meant to diverge — that divergence is the signal the user watches (e.g., "I'm projected to be fine, but my actual cleared balance says otherwise because three bills haven't posted yet").

### Pay periods — user-configurable, set during onboarding

My personal cadence is biweekly (every 14 days), but this needs to support other common pay schedules since this is going to be a public tool. **New users configure this during a first-run setup wizard, before they can use the rest of the app.** Support at minimum:

- **Weekly** — every 7 days from a start date
- **Biweekly** — every 14 days from a start date (my case)
- **Semi-monthly** — two fixed days per month (e.g., the 1st and the 15th) — note this is *not* a fixed interval; the gap between the 15th and the next 1st is different from the gap between the 1st and the 15th, so the generator needs to handle variable-length periods
- **Monthly** — one period per calendar month, anchored to a day-of-month (with sane handling for months that don't have that day, e.g. "the 31st")
- **Custom interval** — arbitrary number of days, for anyone whose schedule doesn't fit the above

Store this as a `pay_period_config` per user (type + anchor date(s)/day-of-month as appropriate), and generate periods programmatically from it — never as pre-built rows. Periods should be generated indefinitely into the future as needed by the projection engine (see below), not capped at a fixed count.

Setup wizard (first-run only) should also collect: starting actual balance, currency, and initial category templates (or let them skip and add categories later).

### Per pay period, two sections: Expenses and Income

**Expenses** (15 line-item slots in the source sheet — but this should be a **user-managed, unlimited list** of expense categories, not a hardcoded 15):
- Each line item has: a **category name**, a **planned amount** for this period, and a **"cleared" checkbox** (has this actually posted to the bank yet?).
- **Total Planned Expenses** = sum of all planned amounts for the period.
- **Total Cleared Expenses** = sum of amounts where "cleared" is checked, **plus** the period's total from Misc Transactions (see below).

**Income** (5 line-item slots in the source — same deal, should be user-managed/unlimited):
- Same shape: category name, planned amount, cleared checkbox.
- **Income Planned Total** = sum of planned income amounts.
- There's also a separate small bucket of **Misc Income Transactions** (raw dollar amounts, no category, entered ad hoc) — **Misc Income Total** = sum of those.
- **Total Cleared Income** = sum of cleared income line items + Misc Income Total.

### Misc (uncategorized) Transactions — separate ledger

The source sheet has a **whole separate tab** just for miscellaneous/uncategorized transactions per pay period — a flat list where the user just types dollar amounts (positive or negative) with no category, for one-off things they don't want to set up a formal line item for. Each period's misc transactions are summed and that sum feeds into the Expenses total for that period (see "Misc_Trans" row above). **In the new app this should just be transactions with no category assigned** — not a separate data structure. A transaction is a transaction; "uncategorized" is just a null/empty category field.

### The math, spelled out

For a given pay period:

```
Total Planned Expenses   = SUM(planned amount for every expense line item)
Total Cleared Expenses   = SUM(planned amount WHERE cleared = true, for expense line items)
                            + SUM(all misc/uncategorized transaction amounts this period)

Income Planned Total     = SUM(planned amount for every income line item)
Misc Income Total        = SUM(misc income transaction amounts this period)
Total Cleared Income     = SUM(planned amount WHERE cleared = true, for income line items)
                            + Misc Income Total

Monthly Loss/Gain        = (Income Planned Total + Misc Income Total) - Total Planned Expenses
                            [note: this is a "planned" metric — it does NOT use cleared totals]

Est. Running Balance (this period) =
    (Income Planned Total + Misc Income Total)
    - (Misc/uncategorized expense total + Total Planned Expenses)
    + Est. Running Balance (previous period)

Actual Acc. Balance (current) =
    Total Cleared Income - Total Cleared Expenses
    + Actual Acc. Balance (previous real period)
```

**This Estimated Running Balance projection is the core feature of the entire application — not a secondary display.** Everything else in the app exists to feed this. Here's the actual use case, in my own words, so the projection engine is designed correctly:

> I record my recurring bills and income once — e.g., electric bill, $250/month, due the 5th. The app should then project my estimated balance forward indefinitely (12, 24+ months) assuming that recurring pattern holds. If my electric bill goes up to $260, I update *that one category*, and the projection for every future period recalculates automatically from the date of that change forward — I should never have to manually edit dozens of future periods by hand (that manual-copy problem is exactly the spreadsheet limitation I'm escaping). The value of this is early warning: if a $10/month increase means I'll go negative in 10 months, I want to see that trend *now*, not discover it in month 10.

This means:

- **Category templates need effective-dated amounts, not a single static planned amount.** When a user changes a recurring category's amount, that becomes a new "effective as of [date]" record — historical/already-cleared periods keep their original amount, and every future projected period picks up the new amount from that date forward. Model this as an amount-history table (`category_id`, `amount`, `effective_start_date`) rather than overwriting a single field.
- **Future periods are virtual/computed, not database rows.** Don't materialize a real `pay_periods` + `line_items` row for every period 24 months out. Only real/near-term periods (past and current, where the user actually interacts with cleared checkboxes and real transactions) need to be materialized. Everything beyond that is calculated on the fly by the projection engine, purely from the current set of recurring category templates and their effective amounts as of each future date. This keeps the projection horizon unbounded without unbounded storage.
- **The projection should re-run live** whenever a category amount, frequency, or start/end date changes, so the forward chart always reflects the latest assumptions.
- **Flag threshold crossings automatically** — e.g., surface the first future period where the projected balance goes below $0 (or below a user-configurable warning threshold) as a clear, prominent "heads up" rather than something the user has to notice by scrolling a chart.

### Where "Actual Balance" needs to live in the UI

Unlike the spreadsheet (which showed a running actual-balance row under every single period out of sheer necessity), **the actual/cleared balance only needs one clear, current display** — it doesn't need to appear per-period throughout the whole projection. Show it prominently once (e.g., a "Current Actual Balance: $X" figure in the main dashboard header, computed from the most recent period where cleared transactions exist) rather than repeating it at the bottom of every period view. The estimated/projected balance is what deserves the full historical-and-forward timeline treatment (chart, per-period breakdown, threshold warnings) since that's the analytical tool being used here.

### Color-coded balance health (conditional formatting to replicate)

Both the Est. Running Balance and Monthly Loss/Gain figures are visually color-coded by threshold. Replicate this as a badge/highlight in the UI:

| Range | Color | Meaning |
|---|---|---|
| < $0 | Red | Negative — over budget / balance underwater |
| $0.01 – $199.99 | Pink/Magenta | Dangerously thin |
| $200 – $999.99 | Light blue | OK, but thin |
| ≥ $1000 | Solid blue | Healthy buffer |
| (blank/not yet entered) | Grey | No data for this period yet |

Make the exact thresholds configurable per user in settings (not hardcoded) — these are personal risk tolerances, and this is going to be a public tool used by people with very different budgets.

### Currency & date formatting

- Currency: 2 decimal places, standard USD-style formatting (`$#,##0.00`). Support other currencies as a user setting since this will be public — don't hardcode USD.
- Dates: pay period boundaries only need date (no time component).

---

## Data Model (replacing the spreadsheet's column-per-period pattern)

Rough shape — adjust as needed, but the key principle is **periods and line items are rows, not columns**:

- `users` — auth, profile, currency/locale/balance-threshold preferences, onboarding-complete flag
- `pay_period_configs` — user_id, cadence type (weekly/biweekly/semi-monthly/monthly/custom), anchor date(s) or day-of-month(s), custom interval days (if applicable)
- `pay_periods` — user_id, start_date, end_date, `is_materialized` (real vs. purely virtual/projected), sequence order — real periods get created as they're reached; future periods beyond the current one are computed on demand by the projection engine rather than pre-populated in bulk
- `category_templates` — user_id, name, type (expense/income), recurrence (which pay periods this applies to — e.g. every period, or a specific day-of-month for monthly-style bills that don't align to pay period boundaries), active/archived flag, sort order (this replaces the fixed 15-expense/5-income rows — the user should be able to add/remove/reorder/rename these freely)
- `category_amount_history` — category_template_id, amount, effective_start_date (the mechanism that lets a user update "electric is now $260" once and have it apply to every future projected period from that date forward, while past periods keep their original amount)
- `line_items` — pay_period_id, category_template_id, planned_amount (snapshot at materialization time, from the amount effective on that date), cleared (bool), cleared_date (nullable, nice-to-have) — only exists for materialized (real) periods
- `transactions` — pay_period_id, amount, description (nullable), category (nullable — null means "misc/uncategorized," replacing the separate Misc_Trans tab and Misc Income rows as one unified concept), type (expense/income), date — only exists for materialized (real) periods

Derived/computed values (period totals, running balances) should be **computed on read** (or cached/materialized if performance demands it) rather than stored as duplicated state, to avoid drift.

---

## Application Requirements

### Multi-user & auth
- Multi-user with authentication — each user has their own private budget data.
- You decide the auth mechanism appropriate for a self-hosted public product (e.g., built-in email/password, with the door left open for OAuth later). Whatever you choose, it needs to work for a stranger self-hosting this with zero external dependencies required to get started.
- No multi-tenancy/shared-household budgets needed yet — that's a Phase 2 idea (see below).

### Core screens (minimum for parity)
1. **Onboarding / first-run setup wizard** — pay period cadence configuration, starting actual balance, currency, initial category templates (skippable).
2. **Dashboard** — current actual balance (shown once, prominently), current pay period's planned vs. cleared totals, and the estimated-balance projection chart extending well into the future (12-24 months), with color-coded health indicators and automatic flagging of the first future period that crosses into negative/warning territory.
3. **Pay period detail view** — expense line items and income line items with editable planned amounts + cleared checkboxes (for real/materialized periods only); misc/uncategorized transactions list for that period; period totals.
4. **Category management** — add/edit/archive/reorder expense and income category templates, including editing a category's recurring amount (which creates a new effective-dated entry rather than overwriting history).
5. **Settings** — currency, balance color thresholds, pay period cadence (editable post-onboarding too, in case circumstances change).
6. **Transaction entry** — quick-add for misc/uncategorized transactions.

### Non-functional / packaging requirements
- **Dockerized**, deployable via `docker-compose` (app container + Postgres container + named volumes for persistent data).
- Must build cleanly as a **publishable Docker Hub image** — multi-arch (amd64 + arm64, since a lot of self-hosters run this on a Raspberry Pi or similar) if feasible.
- All configuration via environment variables (DB connection string, JWT/session secret, initial admin bootstrap, port, currency default, etc.) — no hardcoded secrets or personal defaults anywhere in the codebase.
- Include a proper `README.md` aimed at a stranger self-hosting this: what it does, screenshots/GIF placeholder, `docker-compose.yml` quick start, environment variable reference, how to back up the Postgres volume.
- Health check endpoint for container orchestration.
- Since this may go fully open source: include a permissive license file (MIT unless you have a reason to suggest otherwise) and a basic CONTRIBUTING note.
- Postgres for the database (chosen for multi-user reliability over SQLite).
- You have full discretion on the rest of the stack (frontend framework, backend framework, ORM, etc.) — pick something you can build cleanly and maintainably; this doesn't need to match any of my existing projects.

---

## Explicitly Out of Scope for Phase 1 (but design so these are easy to add later)

- Bank sync / Plaid or similar live transaction import
- CSV import of bank statements with auto-categorization
- Shared/household multi-user budgets (multiple users viewing/editing the same budget)
- Reporting/analytics beyond the basic trend chart (category spend-over-time breakdowns, yearly rollups, export to CSV/PDF)
- Notifications/reminders (e.g., "bill due soon," "you haven't marked anything cleared in 10 days")
- Mobile app / PWA installability
- Multi-currency accounts within a single user (one currency per user is fine for now)
- OAuth login providers

Flag any of these where a Phase 1 architecture decision would make Phase 2 meaningfully harder, and propose the lower-friction alternative.

---

## Deliverable

Working Dockerized app with `docker-compose.yml`, seed/migration scripts for the Postgres schema, README, and a short summary of any assumptions or deviations you made from this spec and why.
