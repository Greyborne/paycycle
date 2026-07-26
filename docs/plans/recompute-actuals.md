# Build spec — fix stale line-item actuals + Recalculate button

Status: in progress (2026-07-25, from `main` @ 8954c9d). Prod data fix.

## Root cause (confirmed)

`line_items.cleared_amount_cents` (the "Actual" column) is a cache = the
SUM of that period+template's transactions (`recomputeClearedAmount`,
budget.js:249; null when there are none). Two mutation paths change the
world without refreshing that cache, leaving orphaned actuals:

1. **Delete a transaction** — `transactions.js:84` runs DELETE and stops;
   the affected recurring line item's `cleared_amount_cents` is never
   recomputed. (The category-reassign path DOES recompute; plain delete
   doesn't.)
2. **Uncheck "cleared"** — `periods.js:401-404` updates
   `cleared`/`cleared_date`/`planned`/`account_id` but NOT
   `cleared_amount_cents`, so the Actual lingers after unchecking.

User hit this deleting everything to re-import from SimpleFIN: actuals
show for transactions that no longer exist, across periods they reopened.

## The invariant to enforce

`cleared_amount_cents` must always equal `recomputeClearedAmount(period,
template)` — it is purely derived from the transactions that currently
exist. The `cleared` boolean is a separate manual/auto reconciliation
flag and stays independent.

## Changes

### 1. Recompute on delete (server/routes/transactions.js)
Before deleting, capture the transaction's `pay_period_id` and
`category_template_id`. After DELETE, if `category_template_id` is set,
call `recomputeLineItemActual(dbc, pay_period_id, category_template_id)`
in the same DB transaction. (Harmless no-op for tag/uncategorized — no
line item row exists.) Closed periods are already blocked here
(transactions.js:83), so this only touches open periods.

### 2. Recompute on cleared toggle (server/routes/periods.js)
In the line-item PATCH non-forward path (periods.js:401), also set
`cleared_amount_cents` to `recomputeClearedAmount(period, template)` so
unchecking cleared with no remaining transactions shows "—", and the
value always reflects reality. Do NOT change the `cleared` bool
semantics. (The forward path at :375 rolls planned amounts; leave its
cleared handling as-is but keep the actual consistent there too if
trivial — otherwise scope to the common non-forward path and note it.)
Closed periods already blocked (periods.js:350).

### 3. Recalculate endpoint (non-destructive repair)
New authed route, budget-scoped, e.g. `POST /periods/recalculate` (or
/budget/recalculate — pick what fits the routing). For every line item in
every **non-closed** period of the budget, set `cleared_amount_cents =
recomputeClearedAmount(...)`. MUST skip closed periods (their
closed_snapshot is the frozen audited record — §5). Return
`{ recalculated: <line items visited>, corrected: <how many changed> }`.
This repairs ALL existing orphans (from both bugs above) without deleting
anything.

### 4. Frontend button (web/src/pages/Settings.jsx)
A "Maintenance" / "Data" section with a **Recalculate actuals** button
(single confirm — it's non-destructive, no type-to-confirm needed). On
success show e.g. "Recalculated N line items (M corrected)." Reuse
existing button/section/notice patterns and tokens (§4).

## Security / integrity (§3, §5 — this is financial data)

- The recalculate endpoint is authed + budget-scoped (IDOR-safe): it may
  only ever touch the caller's own budget's line items. Verify.
- It must NOT touch closed periods, NOT alter/delete any transaction, and
  NOT change `planned_amount_cents` or the `cleared` bool — only
  `cleared_amount_cents`, and only to the SUM of existing transactions.
- No financial data lost: transactions are read-only here; a household's
  cleared position is only ever corrected to match its own transactions.

## Verification

- Delete a transaction that had cleared a recurring item → its Actual
  drops to the new sum (or "—"); the stat totals follow.
- Uncheck cleared on an item whose transactions are gone → Actual shows
  "—".
- Seed an orphaned `cleared_amount_cents` (value present, zero matching
  transactions), run Recalculate → it becomes null/"—"; a legit actual
  (transactions present) is unchanged; a CLOSED period's line item is
  untouched.
- Checkers use an isolated ephemeral DB (destructive-integrity work —
  never the shared dev DB).

## Scope

server/routes/transactions.js, server/routes/periods.js,
server/services/budget.js (only if a helper is needed), the new route,
web/src/pages/Settings.jsx, and tests. No schema change.
