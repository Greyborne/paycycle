# Build spec — SimpleFIN: honor the account tracking-from date

Status: in progress (2026-07-25, from `main` @ 18f1624). Prod bug fix.

## The bug

Sync has no hard floor on transaction dates. `insertSyncedTxn`
(server/services/simplefin.js:428) only checks *period coverage* — it
keeps a transaction if some pay period's window contains its date. But
the first period is anchored on `periodContaining(started_on)`
(budget.js:465), whose start can fall BEFORE the account's tracking-from
date (`accounts.started_on`). So a transaction dated before `started_on`
but inside that first period's window is inserted, inflating the first
period and cascading skew forward through frozen closed-period snapshots.

User expectation (confirmed 2026-07-25): sync should DROP any transaction
dated strictly before the mapped account's tracking-from date.

## The fix (backend only, no schema change)

Add a per-account tracking-from floor at the TOP of `processTxn`
(server/services/simplefin.js:506), after `toTxn`/the zero-amount check
and BEFORE the existing-row lookup — so it covers BOTH new inserts and
re-fetched restatements in one place:

```
const account = ctx.accountsById.get(link.account_id);
if (account?.started_on && t.date < account.started_on) {
  results.skipped += 1;
  return;
}
```

- `ctx.accountsById` is already built in `syncBudget` from
  `SELECT * FROM accounts` (so it carries `started_on::` — verify the row
  exposes it as a comparable `YYYY-MM-DD` string; `t.date` is the same
  ISO shape, so string comparison is correct).
- Per-account (not per-connection): a connection can hold accounts with
  different tracking dates, which is why the guard lives in the per-txn
  path, not in `startDateFor`.
- Null `started_on` → no floor (guard does not trigger).
- Reuse `results.skipped` (its meaning already covers "before the
  household's first period"); no new counter, no frontend change.
- Do NOT change `startDateFor`/the fetch window — the per-account guard is
  the authoritative enforcement; the wider fetch is harmless now that
  pre-tracking rows are dropped.

## Out of scope

Cleaning up ALREADY-imported pre-tracking rows in prod — the user will
delete those manually via the Transactions page (and reopen affected
closed periods to correct frozen snapshots). This fix only prevents
future leaks.

## Verification

- A test proving: with an account whose `started_on` is 2026-06-03, a
  synced transaction dated 2026-05-30 is NOT inserted (counted skipped),
  and one dated 2026-06-03 (and 2026-06-05) IS inserted. Model it on
  server/test/integration/line-item-actuals.test.js, which drives
  processTxn/insertSyncedTxn directly.
- `npm test` + `npm run test:integration:ephemeral` green, no regression.
- security-checker on the diff (financial sync); build-checker re-runs.

## Scope

`server/services/simplefin.js` and a test file. No route/frontend/schema
change.
