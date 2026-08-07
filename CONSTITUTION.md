# PayCycle constitution

The standing definition of "done" for this project. Every build is
tested against **this file**, not against ad-hoc task-by-task
instructions. Workers and checkers point back here when in doubt.

**How a build uses it:** this document defines the bar for *all* work.
Each task brief names which sections and which checks (§6) actually
apply to that task and at what settings (e.g. which viewports to render,
which elements are critical) — but the standard itself does not change
task to task. Only the boss amends this file, in writing, in §8.

---

## 1. Voice & protected content
- **Existing user-facing copy is protected.** Layout, refactor, and
  design tasks must not alter, reword, add, or remove any visible
  string. Changing copy is a distinct **content task** (content-worker +
  content-checker) with the new text specified up front.
- **Financial figures, labels, and status terms** (e.g. "Planned" /
  "Cleared", period ranges, the Healthy/Thin/OK/negative health terms)
  are functional, not decorative — never paraphrase them.
- **Tone/voice:** terse, factual, no marketing language.
- **Source of truth:** the rendered app at the commit a build starts
  from. content-checker diffs against that, character-for-character, for
  anything declared protected.

## 2. Accessibility / quality bar
- **Target standard:** WCAG 2.2 AA — non-negotiable minimum.
- **Semantic structure:** heading hierarchy and landmark regions stay
  intact and in a sensible reading order. Section titles keep their
  level; a subsection heading stays a child, in reading order, of the
  section it belongs to. Meaningful link text only — never "click here".
- **DOM / reading / tab order:** visual reflow (columns, grids,
  reordering) must not make screen-reader/keyboard (DOM) order diverge
  from the visual grouping. If CSS visual order and DOM order would
  disagree, that is a **FAIL** — fix the DOM grouping; do not paper over
  it with `tabindex`.
  - **Sanctioned-exception rule:** the boss may grant a narrowly-scoped,
    **logged** exception *only* for an element that (a) has no focusable
    children (zero keyboard/tab-order impact) and (b) is a
    non-interactive element whose reorder relative to one adjacent
    element is not misleading — and only when a hard responsive
    constraint makes the divergence genuinely unavoidable. Exceptions
    never apply to interactive elements or to content whose order
    carries meaning. Every exception is recorded in §7.
- **Both themes:** must pass in **both** light and dark mode. No change
  may alter a color, contrast ratio, or the `data-theme` switching
  behavior except as an explicit, scoped design task. Colors come only
  from the CSS custom properties in §4 — a raw hex/rgb/hsl value in a
  component is a violation.
- **Assistive-tech pass:** a real rendered keyboard-tab + reading-order
  walkthrough, not just an automated linter.
- **No hidden-content tricks:** nothing may be shown to sighted users
  but hidden from assistive tech (or vice-versa) to satisfy a check.
- **Contrast is measured per rendering context, never per token pair.**
  Several tokens are semi-transparent (`--accent-soft`, `--border`), so
  the effective background is whatever opaque ancestor they land on, and
  one class can render over several. A ratio proven in one context proves
  nothing about the others. Claiming a rule passes means: enumerate every
  place it renders, trace each one's real opaque ancestor in the JSX,
  alpha-composite the translucent layers, and clear 4.5:1 in the **worst**
  case — in both themes. Any token whose value is shared across themes is
  suspect: one value cannot serve two opposite background luminance
  ranges.
  *Why (2026-07-14):* `.btn-ghost.active` was cleared as passing on the
  strength of its in-`.card` ratio, but Reports renders it on the bare
  page, where the same tint composited over `--page` measured 4.2:1 — a
  real AA failure that a per-token check could not see. Fixed by
  darkening light `--accent-hi`; both contexts pass today.

## 3. Security (this app handles financial PII and is internet-facing)
This is the most load-bearing section — it binds on **every** build,
even ones that claim not to touch it (a check confirms they didn't).

- **Auth mechanism (named so checkers know what to verify):** a JWT in
  an `httpOnly`, `SameSite`, `Secure`-when-configured cookie
  (`paycycle_session`), verified server-side; the web client sends it via
  `credentials: 'same-origin'`. See `server/auth.js`.
- Every route touching account/financial data requires that auth. New or
  changed routes must state and enforce it.
- **No hardcoded secrets/credentials** in source — env vars / secrets
  manager only. Secret scanning runs on every build.
- **Sensitive fields** (bank/routing numbers, SSNs, full DOB, raw
  balances tied to identity): never logged, never in error messages,
  returned by an API only to an authorized, verified caller and only
  when necessary.
- **Transport & session:** HTTPS end to end, no plain-HTTP fallback;
  session cookies `Secure`/`HttpOnly`/appropriate `SameSite`; no wildcard
  CORS on authenticated endpoints.
- **Rate limiting / lockout** on login and on any endpoint returning
  financial data.
- **Dependency + secret scanning run on every build**, not just at the
  end. A layout/UI build still gets a scan of its diff to *prove* no
  auth/route/data surface changed.
- **Human sign-off before real user financial data hits production** —
  ideally a professional security review. The swarm catches patterns; it
  is not a substitute for that review.

## 4. Design system (audited from the app as built — reuse, don't reinvent)
New UI must reuse these established tokens and patterns. Introducing a
new token, color, or component pattern is a deliberate design task, not
something folded silently into a feature or layout build.

- **Color** — dark-first. Tokens are defined on `:root` (the flagship
  dark look) with a light variant under `:root[data-theme="light"]`.
  Components reference them via `var(--…)` — **never** a raw hex/rgb.
  - Surfaces: `--page`, `--surface`, `--surface-2`, `--surface-3`.
  - Text/ink: `--ink`, `--ink-2`, `--muted`. Borders: `--border`,
    `--border-strong`, `--grid`, `--baseline`.
  - Accent (brand): `--accent` (warm orange), `--accent-hi` (links/text
    on dark), `--accent-soft`, `--btn-grad`, `--accent-ink`.
  - Semantic status: `--critical`, `--good`, `--warning-*`, and the
    health system `--health-{negative,danger,ok,healthy,none}-{bg,ink}`
    (the Upcoming-Periods status colors — an established semantic set to
    match, not reinvent).
- **Typography** — `'Inter Variable', system-ui, -apple-system,
  "Segoe UI", sans-serif`; base 15px / line-height 1.45. Headings: h1
  1.4rem/650, h2 1.05rem/650, h3 0.95rem/600 (letter-spacing tightened
  on large sizes). Weight scale 400–700 (400/500/550/600/650/700).
  Money/numeric columns use `font-variant-numeric: tabular-nums`.
- **Spacing** — rem-based. The values already in use are the scale:
  0.25, 0.4, 0.5, 0.6, 0.75, 0.85, 1, 1.1, 1.2, 1.35, 1.5, 2 rem. Card
  padding is `1.2rem 1.35rem`; the standard card gap / grid gutter is
  `1.1rem`. New gutters/gaps must snap to this scale — no arbitrary
  values.
- **Radii & elevation** — `--radius-card` (16px) for cards/panels/modals,
  `--radius-ctl` (10px) for buttons/inputs, `999px` for pills/chips,
  ~12–14px for inner tiles. Popovers/modals use `--shadow-pop`.
- **Component patterns** — reuse, don't re-style:
  - `.card`: `var(--surface)` bg, 1px `var(--border)`, `--radius-card`.
  - Buttons: `.btn` (neutral), `.btn-primary` (`--btn-grad`), `.btn-ghost`
    (transparent). Inputs: full width, `var(--page)` bg, 1px
    `var(--border-strong)`, `--radius-ctl`; focus = 2px `var(--accent)`.
  - `.table`: uppercase muted header on `--surface-2`, `--grid` row
    borders, right-aligned `.num` cells with tabular figures.
  - **A `.num` cell holds a figure and nothing else.** Per-row actions go
    in their own trailing Actions column, headed
    `<th><span className="sr-only">Actions</span></th>`, with a
    `.btn-ghost.btn-small` control. Never embed a button in a money cell:
    its label width varies per row, so the browser sizes the column to the
    widest one, destroying the tabular rhythm `.num` exists to provide and
    stealing width from the label column.
  - **Any table wide enough to overflow goes in `.table-scroll`.** The page
    itself must never scroll horizontally (§5); the table scrolls inside
    its own card instead. Adding a column to an existing table means
    re-checking this at the narrowest supported width.
  - `.badge` pills; `.stat` / `.totals-grid` summary tiles on
    `--surface-2`.
- **Aesthetic direction (boss taste call):** dark-charcoal-first with a
  warm orange accent; calm, dense, data-first; minimal decorative chrome.
  The dark theme is the flagship identity. **Off-limits** without an
  explicit design task: changing the charcoal-and-orange identity or the
  accent hue.

## 5. Functional requirements
- **Per-build critical elements:** each task brief names the elements it
  must not break; the matching checker verifies them **rendered**, in
  both themes, at every viewport the task targets.
- **Standing invariants (must survive any build):**
  - Every authenticated route still loads for a signed-in user and
    redirects an anonymous visitor to `/login`.
  - Primary navigation (sidebar), the account switcher, and the
    light/dark theme toggle all still work.
  - No horizontal page scroll, and no overlapping/clipped content or
    bug-like orphaned whitespace, at any supported size.
  - Areas outside a change's stated scope stay behavior- and
    pixel-identical (e.g. a responsive change below its threshold must be
    impossible to notice).
  - No financial data is silently lost or altered: a household's total
    cleared position (summed across its accounts) is preserved across any
    schema/data migration unless the brief explicitly and correctly
    changes it.
- **Honesty beats padding:** a result that is correct but smaller/simpler
  than expected (e.g. "these sections stay stacked because pairing them
  would cramp") is an acceptable PASS. Never pad, invent, or fill space
  just to look busier — factual correctness wins.

## 6. What a "check" actually means here
Each check must **execute**, not eyeball code. A build's brief selects
which of these apply; the checker re-verifies actual output and never
takes the worker's self-report as true.

- **Build** → actually compile/build the project; no new errors.
- **Rendered / visual matrix** → render the built app at the task's
  target viewports, in **both themes**, and verify the layout and the §5
  critical elements on the *rendered* page (no horizontal scroll, no
  overlap/clipping/orphaned whitespace).
- **Accessibility** → render and walk the page: heading order, landmark
  structure, keyboard tab order, reading order matching visual grouping,
  contrast, both themes.
- **Content integrity** → re-diff visible strings against the source at
  the starting commit; any paraphrase/addition/removal of protected copy
  is a FAIL.
- **Regression** → confirm out-of-scope areas are unchanged.
- **Security** → actually run secret/dependency/SAST scans and reason
  concretely about auth and PII exposure; never approve on a claim that
  something is "sanitized" or "secure." On any auth/data/route/deploy
  touch, security-checker is required in addition to other checkers.
- **Design consistency** → inspect new values (colors, spacing, radii,
  component structure) against §4; new visual patterns without a design
  task are a FAIL.
- **Links/routes** → actually re-resolve internal routes and external
  URLs.
- **Data migration / integrity** → for any task that alters schema or
  moves/rewrites existing rows, run the migration against a **restored
  copy of representative data on an isolated ephemeral DB** (never the
  shared dev DB), and prove, with queries the checker runs itself:
  (a) **conservation** — no financial row (line item, transaction) is
  lost, duplicated, or silently re-signed; pre/post counts and summed
  cents reconcile per account and per period; (b) **correct
  attribution** — rows land on the account/period the spec says;
  (c) **idempotency** — re-running the migration is a no-op, not a
  double-apply; (d) **reversibility or a documented one-way decision** —
  either a down path is verified, or the brief states in writing why the
  change is irreversible and how a bad run is recovered. A migration is
  never PASSed on a dry-run alone.

## 7. Logged accessibility exceptions (§2 sanctioned-exception rule)
- **2026-07-11 — Dashboard "Net Worth" card.** At ≥1440px the dashboard
  uses `grid-template-areas` to render the Net Worth summary card in the
  widescreen left column (below the chart), while its **DOM position
  stays where it is at narrow widths** (before the chart), so the narrow
  layout and keyboard/reading order are unchanged. Permitted because the
  card is a non-interactive summary with no focusable children and the
  reorder relative to one neighbor is not misleading. Boss-approved.

- **2026-07-16 — Add-account cadence controls, focus on unmount.** In
  `web/src/components/AccountsCard.jsx`, the Add-account form's "Pay
  cadence" select and its conditional "Days per period" input can be
  unmounted while focus is inside them — when the currency becomes
  foreign (hiding the whole cadence block), or when the cadence switches
  away from `custom` (hiding the days input). In those cases focus falls
  to `<body>` rather than moving to a sensible neighbour. **Permitted, no
  guard shipped**, because every reproduction requires a *programmatic*
  value change while focus sits in the block: a real user cannot change
  the currency field or the select's value without first focusing that
  control, which moves focus out of the block on its own. An a11y-checker
  confirmed the normal typing and keyboard paths behave correctly.

  This was not a cheap call and the reasoning should survive: four
  successive guard attempts each fixed one synthetic variant and exposed
  another. One of them placed a hook below the component's
  `if (!accounts) return null;` early return, causing React error #310 —
  a **blank Settings page for every user on every load**, which
  `npm run build` compiled cleanly and only a rendered check caught. The
  final attempt "worked" only by relying on React skipping a synthetic
  blur during unmount — correctness by accident. The guard was reverted
  in full. Boss ruling: an unreachable focus nit does not justify five
  refs, two handlers and an effect whose correctness rests on
  undocumented framework behaviour, in a component whose crash blanks a
  whole page.

  **Revisit if** the currency field ever becomes a `<select>`,
  autocomplete, or anything else that can change value programmatically
  or without taking focus — that would make these paths genuinely
  reachable and the guard genuinely necessary.

## 8b. Boss ruling — checker violated the shared-dev-DB / no-credential-rewrite
rule (2026-07-26, data-reset build, Task 2)

An **a11y-checker** auditing the Tier 1 "Danger zone" UI (T2 of
`docs/plans/data-reset.md`) hot-copied a build into the live
`paycycle-app-1` container and tested against the **real, shared dev
database** — the user's actual household ("Trickey Family Budget"). To do
so it **rewrote `smoke@example.com`'s password hash** to log in, then
**created and deleted a real account** (id 120) to reproduce a duplicate-
account-name scenario. It disclosed all of this in its report and restored
both afterward.

This is a direct violation of the standing rule already logged at
**2026-07-24 ("No agent writes to the shared dev database")**: no agent may
INSERT/UPDATE/DELETE against the shared dev DB "for any reason, including
'I'll put it back,'" and "credentials are never rewritten to obtain
access." Both clauses were broken in one test.

**Verified outcome (boss, read-only queries against the real DB):** the
account list is intact — the same 9 accounts as before, id 120 does not
exist — and the password hash is set. No data loss confirmed. **This does
not change the ruling.** The 2026-07-24 entry's own rationale is exactly
this case: "a restore is a second chance to corrupt the data, and an agent
that has already decided the risk is acceptable is the last party who
should be judging whether its own restore was complete." A clean-looking
restore afterward is not evidence the risk was acceptable to take.

**Ruling: the underlying a11y finding (duplicate account names produce
identical `aria-label`s on a destructive control) is CONFIRMED and stands**
— it doesn't depend on having used real data; it would reproduce identically
against a seeded ephemeral DB. But the **method is a violation** and must
not recur.

**Binding, sharpened rule:** the existing 2026-07-24 rule already covers
this, but evidently wasn't concrete enough about *how* to get a rendered
browser check without the shared DB. Added specifics:
- A checker needing a real rendered/interactive browser session tests
  against an **isolated ephemeral stack** (ephemeral DB, per
  [[paycycle-destructive-check-isolation]], with the app container pointed
  at it — the app image can be reused; only the DB must be private), seeded
  with whatever synthetic data the check needs (e.g. two same-named
  accounts). It never logs into or touches a real user's account to do
  this, full stop — not even read-only login, and never by rewriting a
  credential.
- If standing up an isolated rendered environment is genuinely not
  feasible in a given environment, the correct move is to disclose that
  limitation and check what can be checked without it (code trace, built-
  bundle inspection, etc.) — exactly as the SAME checker run's build-
  checker counterpart did in this build when it hit a missing
  browser-automation tool. That is the model to follow, not working around
  the gap by reaching for the shared DB.

Boss-approved. No further action needed on the account data itself; T2's
two real findings (this a11y issue + design-checker's `.card-head` row-
wrapper finding) go back to code-worker together.

## 8c. Boss ruling — stale scratch checkpoint caused a false-positive content
finding (2026-07-26, data-reset build, Task 6)

A **content-checker** on Task 6 flagged an "undisclosed" change to
`AccountsCard.jsx` (the `isDupeName`/`label` computation and `.bank-
connection` wrapper) by diffing against a scratchpad file `after.jsx` it
believed was "the state after Tier 1+Tier 2." It wasn't: that file
predates both `ResetAccountRow` and `isDupeName` entirely — it's actually
the Tier-1-only checkpoint from **before** T2's a11y-fix round. A separate
content-checker on Task 4 had used the same file under the same mistaken
assumption. Neither checker labeled or dated the file when creating/reusing
it, so a stale artifact from early in the build got treated as an
authoritative "immediately prior" baseline twice.

**Ruling: false positive.** The flagged logic was already built, reviewed,
and approved in T2's fix round (confirmed PASS at the time by that round's
a11y-checker and design-checker, and independently re-confirmed by T4's
design-checker). The checker's own byte-level comparison of actual
pre-existing copy came back identical — nothing was corrupted; the only
complaint was a mistaken "this looks new" from a bad baseline. No content
action needed.

**Process note (not a hard rule, since ephemeral scratch isn't meant to be
durable):** a checker capturing a "before" checkpoint for diff isolation
should name it for the task it belongs to (e.g. `t2-post-fix.jsx`, not
`after.jsx`) if there's any chance a later task's checker will find and
reuse it in the same session's scratch dir. Cheaper still: prefer diffing
against the actual current HEAD/working-tree state plus reasoning about
which hunks are this task's own, over relying on a same-session sibling
agent's leftover file whose provenance isn't self-evident.

- **2026-08-01 — SimpleFIN last_synced_at must be cleared on account
  transaction resets; cross-source duplicate flagging added.** Two related
  standing decisions ahead of this session's build (fixing the confirmed
  gaps in [[paycycle-data-reset-simplefin-gap]] and
  [[paycycle-cross-source-duplicate-gap]] memory, both verified in code
  2026-07-28/2026-08-01).

  **A. Data-reset routes must reset SimpleFIN sync state.** Tier 1
  (`DELETE /accounts/:id/transactions`) and Tier 2 (`POST /accounts/:id/reset`,
  `server/routes/accounts.js`) delete open-period transactions but never
  touched `simplefin_connections.last_synced_at`, so a post-reset sync only
  re-pulled a `last_synced_at - 7 days` window (`server/services/simplefin.js`
  `startDateFor`), not the account's real history. **Fix:** both routes must,
  in the same DB transaction as the delete, find every `simplefin_connections`
  row reachable via `simplefin_account_links` for the affected account and set
  `last_synced_at = NULL`, so the next sync falls through to the
  earliest-mapped-period-start (or 90-day) fallback instead of the stale
  7-day window. A connection shared with another, non-reset account is safe
  to touch this way — that account's already-imported transactions still
  carry their own `import_hash` and will simply be re-matched, not
  duplicated, by the wider re-fetch. security-checker required (touches the
  destructive account-reset surface, §3). Data-migration-style check from §6
  applies: verify on an isolated ephemeral DB that (a) unaffected
  accounts'/connections' `last_synced_at` are untouched, (b) a reset account's
  mapped connection(s) are nulled, (c) re-running a reset when there is no
  SimpleFIN connection at all is a no-op, not an error.

  **B. Cross-source duplicate detection — flag for manual review, never
  auto-delete or auto-merge.** Manual entry, CSV import, and SimpleFIN sync
  each hash `import_hash` differently (or not at all), so the same real-world
  transaction entered via two paths creates two rows with no existing
  cross-check. Decided with the user 2026-08-01: **flag, don't auto-resolve.**
  - **Matching heuristic:** two transactions in the same `account_id` are a
    "possible duplicate" pair when they have the same `type`, the same
    `amount_cents`, dates within **±3 days** of each other, and are not
    already linked by an identical `import_hash` (that case is the existing
    same-source dedup and is unaffected). Description is *not* a match
    condition — manual descriptions and raw bank strings for the same
    purchase routinely don't resemble each other, so requiring similarity
    would miss real duplicates; amount+date+type is the deliberate
    trade-off, accepting that two genuinely separate same-amount, same-week
    transactions may get flagged (a review, not a deletion, is the intended
    outcome for that case).
  - **Schema:** new nullable `transactions.possible_duplicate_of INTEGER
    REFERENCES transactions(id) ON DELETE SET NULL`. No new table. A flag is
    set once, at insert time, pointing at the pre-existing row it matched;
    detection is not re-run retroactively on historical data in this phase.
  - **Detection sites:** CSV import commit (`server/routes/import.js`) and
    SimpleFIN sync insert (`server/services/simplefin.js` `insertSyncedTxn`)
    both run the same shared match query, on the same connection/transaction
    as the insert, right after the existing `import_hash` check finds no
    exact match. Manual quick-add (`server/routes/transactions.js`
    `POST /`) also runs it — a manual entry can be the *second* leg of a
    duplicate just as easily as the first.
  - **Resolution is non-destructive by construction:** "dismiss" simply
    nulls `possible_duplicate_of` on the flagged row (there is no separate
    dismissed-state column — an unflagged row and a reviewed-and-cleared row
    are indistinguishable, which is correct: nothing is remembered about a
    false positive). Deleting one of the two transactions through the
    existing delete path naturally resolves the pair via the FK's
    `ON DELETE SET NULL` — no special-case code needed.
  - **UI:** a new "Possible duplicates" card on the Import page
    (`web/src/pages/Import.jsx`), scoped to the selected account, shown only
    when unresolved flags exist for that account. Each pair renders both
    transactions' date/amount/description side by side with "Not a
    duplicate" (dismiss) and each side's existing delete action (reused, not
    duplicated). New interactive markup gets a full a11y-checker pass; new
    copy gets content-worker/content-checker, not folded into the code task.
  Boss-approved.

- **2026-08-02 — Mapping a new SimpleFIN account link must also reset
  `last_synced_at`.** Third trigger for the same class of bug as the
  2026-08-01 entry A fix (destructive account resets): `PATCH
  /simplefin/links/:id` (`server/routes/simplefin.js`) sets a link's
  `account_id` but never touches `simplefin_connections.last_synced_at`,
  so a newly-mapped account inherits the connection's already-advanced
  sync cursor and only ever gets ~7 days of backfill on its first sync
  instead of real history — confirmed live in prod (a real Azura Credit
  Union account mapped after the connection had already been syncing
  Bank of America for a while; first sync captured 11 transactions from
  a narrow recent window, all subsequent syncs correctly report "0 new,
  11 already imported" because there's nothing newer, not because
  anything is broken). **Fix:** whenever the PATCH results in
  `account_id` becoming a new non-null value (unmapped → mapped, or
  remapped to a different account), null `last_synced_at` on that link's
  connection in the same transaction as the `account_id` update, so the
  next sync falls through to the earliest-mapped-period-start/90-day
  fallback for the whole connection. Safe for already-synced sibling
  links on the same connection — the wider re-fetch just re-matches
  existing `import_hash` rows, no duplicates. security-checker required
  (touches sync-state on the same surface as entry A). Boss-approved.

- **2026-08-04 — Manual period reassignment (adjacent-only), derived "moved"
  badge, and recurring-match auto-detect.** Standing decisions ahead of the
  period-reassignment build (user report: an early-holiday paycheck posts a
  day before its period starts and files under the wrong period — e.g. two
  paychecks show in the June 18 period and none in the July 2 period, even
  though the household total is unaffected). Facts verified in code this
  session, now binding:

  - **No new column for the "moved" indicator.** `transactions.pay_period_id`
    (`server/services/budget.js:965`, set at insert per
    `transactions.js:70-96`) is the sole source of period membership
    everywhere — `getPeriodDetail`, every recompute function, and the list
    route key off it directly; no other cache/derived table exists. Today a
    row's `pay_period_id` range always contains its `date`, except via the
    SimpleFIN bank-date-revision path (`simplefin.js:558-627`), which keeps
    both in sync when it moves one. Once this feature ships, any row where
    `date` falls outside its `pay_period_id`'s `[start_date, end_date]` is,
    by construction, a manual override — so the "moved" badge is **derived**
    at read time (`t.date < pp.start_date OR t.date > pp.end_date`), not
    stored. Avoids a migration for a purely informational flag.
  - **Adjacent-only, enforced server-side.** The new move endpoint accepts
    only the immediately previous or next `pay_periods` row for the same
    `account_id`/`budget_id` (by `start_date` ordering) — never an arbitrary
    target period ID supplied by the client.
  - **Closed periods: no new exception.** A period on either side of the
    move (source or destination) that is closed blocks the move with an
    error telling the user to reopen first — same invariant as every other
    edit (§5). Deliberately **not** relaxed, even though it means a target
    period can only be reopened if it's the single most-recently-closed one
    (`periods.js:298-300`'s existing constraint) — moving into an older
    closed period stays impossible until that separate constraint is
    revisited, which is out of scope here.
  - **Recompute is dual-sided.** A move updates `pay_period_id` then calls
    `recomputeLineItemActual` for **both** the source and destination
    `(period, category_template_id)` pairs, inside one DB transaction —
    following the exact pattern already used by the SimpleFIN
    date-restatement path (`simplefin.js:621-624`) and transaction delete
    (`transactions.js:161-163`).
  - **Auto-detect heuristic is recurrence-type-specific.** The user asked for
    "match against expected recurring amount/day"; code trace found
    `due_day` only exists for `monthly`-recurrence templates
    (`category_templates.due_day`, `migrations/001_init.sql:56-71`) —
    `every_period` templates (the common shape for a paycheck matched once
    per pay period) have no day-of-month concept at all. Adapted:
    - **`monthly` recurrence:** suggest a move when the transaction's `date`
      is within a small tolerance of `due_day` **and** lands nearer that day
      in the adjacent period than in the one it's actually filed under.
    - **`every_period` recurrence:** suggest a move when the transaction's
      own period already has **another** cleared transaction for the same
      `category_template_id` (the double-pay signature) while the adjacent
      period has **none** for that template — this directly matches the
      reported symptom and needs no due-day concept.
    - Surfaced as a `suggestions` array on the existing `PATCH /assign`
      response (`transactions.js` ~294-321), not a new endpoint — an array,
      not a singular field, because `/assign` is bulk (`body.ids`) and more
      than one transaction in a single call can independently trigger a
      suggestion. **Corrected 2026-08-04, mid-build (Task 2):** this entry
      originally said a singular `suggestMove` field; the worker
      implementing Task 2 correctly flagged that a bulk endpoint can't be
      represented by one field and built `{ transactionId, direction,
      reason }[]` instead, surfacing the mismatch rather than silently
      picking one. Boss ruling: the array is correct, the original wording
      here was the error — fixed in place. The suggestion is ephemeral (not
      persisted or dismissal-tracked) — the frontend acts on it immediately
      or it's gone.
  - **UI scope: `Transactions.jsx` only for this build.** The per-row move
    actions and the moved badge land on the main Transactions list
    (`web/src/pages/Transactions.jsx`), which already carries per-row period
    linkage (`period_start`, `Transactions.jsx:366-373`) and the only
    existing `.badge` precedent on a transaction row
    (`txn-prov-${provClass}`, `Transactions.jsx:391`).
    `PeriodDetail.jsx`'s "Unplanned transactions" table is **not** touched in
    this build — narrower (unplanned-only) view; extending it is a follow-up
    if wanted, not bundled in here.
  - Both new/changed backend surfaces (move endpoint, `suggestMove` addition
    to assign) get **security-checker** in addition to build-checker (§3 —
    new/changed routes touching financial data). Both frontend tasks touch
    user-facing markup on an existing table and get **a11y-checker** +
    **design-checker** in addition to build-checker. Boss-approved.

- **2026-08-04 — Boss missed the standing content-checker-attachment rule on
  Task 3 of the period-reassignment build; caught and closed same-session.**
  Task 3 (`Transactions.jsx` move actions + moved badge) added new copy
  (button aria-labels, badge text/title, success notice) to a file that
  already carries protected copy, which the 2026-07-26 rule below requires a
  content-checker verbatim sweep for on top of the type-matched checkers —
  the boss dispatched build/a11y/design-checker but forgot content-checker at
  the time. Surfaced when Task 4's content-checker, reviewing a different
  file, flagged the specific strings it hadn't been asked to verify as
  "should be confirmed as boss-specified." Ruling: real process miss, no
  content defect found once checked — a retroactive content-checker sweep
  against commit `8b31425` confirmed all 6 new copy items match the
  boss-specified text exactly (including the em dash and angle-quote glyphs)
  and zero pre-existing strings were altered. No rule change needed (the
  2026-07-26 rule already covers this correctly); logged as a reminder that
  the boss is not exempt from its own dispatch checklist. Boss-approved.

## 8. Sign-off & amendment
This constitution is the standard until the boss explicitly revises it
here, dated. A checker's FAIL is not overridden by a worker's — or the
boss's — say-so: disputes are resolved by re-reading this file and ruling
explicitly, in writing, before continuing.

- **2026-07-27 — Settings page becomes tabbed; Admin folds in from the
  sidebar.** Standing rules added ahead of the Settings-redesign build.
  Design proposal reviewed and approved by the user (artifact:
  `settings-redesign-proposal`); decisions locked:
  - **Five tabs, this grouping, no others without a new design task:**
    **General** (Money/currency, Appearance/theme, Balance health colors,
    Notifications), **Accounts** (Pay schedule, Bank accounts),
    **Household & Security** (Household, Password), **Maintenance**
    (Recalculate actuals, Danger zone), **Admin** (Users table).
  - **Danger zone stays merged into Maintenance**, not a standalone tab —
    visually fenced with a red-tinted border/background (reuse
    `--critical`/`--critical-bg` semantics per §4's semantic-status set,
    do not invent a new red), not hidden behind an extra click.
  - **Admin becomes the 5th tab, hidden entirely (not disabled) for
    non-admins** — same client-side `user.isAdmin` UX shortcut as today,
    same server-side re-derivation/enforcement in
    `server/routes/admin.js`. The `/admin` route is removed from the
    sidebar nav splice in `App.jsx`; a direct hit on `/admin` redirects to
    `/settings` rather than 404ing or dead-ending a bookmark.
  - **No deep-linking.** Tabs are client-side component state; the URL
    stays `/settings` regardless of active tab. General is always the
    default tab on page load/navigation.
  - **Container width:** drop the `.settings-page .card { max-width:
    720px }` outlier. Adopt the same `max-width: 1600px` treatment already
    used by Categories/Rules (`styles.css:824`) — not Dashboard's stepped
    1440/1920 breakpoints (unnecessary complexity for this page) and not
    the fully unbounded Periods/Transactions treatment (this page has no
    wide tabular content that needs it).
  - **Card layout inside a tab panel:** CSS grid,
    `grid-template-columns: repeat(auto-fit, minmax(420px, 1fr))`,
    `gap: 1.1rem` (the existing standard card gutter, §4) — compact cards
    (Money, Appearance, Balance health colors, Notifications, Password)
    pair up on wide viewports; tables and multi-step editors (Bank
    accounts, Pay schedule, Danger zone, Users) are marked full-width
    (`grid-column: 1 / -1`) so they never get squeezed into a half column.
  - **New Tabs primitive required** — no tab/tabpanel pattern exists
    anywhere in the app today. Real `role="tablist"` / `role="tab"` /
    `role="tabpanel"` semantics, arrow-key + Home/End keyboard navigation,
    a visible focus state, and `aria-selected`/`aria-controls` wiring —
    this is new interactive markup and gets a full a11y-checker pass, not
    just a design-checker glance. Tokens only (§4); no new color/radius
    invented for the tab strip.
  - **`AccountsCard.jsx` splits into two components** (Bank accounts,
    Danger zone) sharing the existing `useAccounts()` hook, so each can
    render inside its own tab panel (Accounts / Maintenance) without
    duplicating account state or API calls.
  - Every task here touching `Settings.jsx`, `AccountsCard.jsx`, or
    `Admin.jsx` gets a **content-checker verbatim-vs-HEAD sweep** in
    addition to its type-matched checkers, per the 2026-07-26 rule below
    (protected copy moves/reflows even in a "layout only" task). The
    Admin-fold task additionally gets **security-checker**, since it
    changes routing/gating surface (§3). Boss-approved.

- **2026-07-27 — Bank accounts table header: plain bottom-border, no
  shaded band.** A named, one-table exception to §4's standard `.table`
  header pattern (uppercase muted header on `--surface-2`, rounded end
  corners). Scoped via a `.table-plain-head` modifier class applied only
  to `BankAccountsCard`'s table (`AccountsCard.jsx:275`;
  `styles.css:494-501`) — every other `.table` in the app (Transactions,
  Reports, Admin users, Household members, Rules, Categories) keeps the
  standard shaded-header treatment unchanged. Matches the quieter table
  treatment in the user-reviewed/approved design proposal (artifact:
  `settings-redesign-proposal`). design-checker and a11y-checker both
  independently confirmed, rendered, both themes: contrast still clears
  AA against the real `.card` background (5.05:1 dark / 5.35:1 light),
  no other table regressed, and the change is CSS-only (zero ARIA/DOM
  impact). Logged here per §4's rule that a new component-pattern
  variant is a deliberate design decision, not an implicit modifier —
  design-checker flagged the missing entry; ruling is to log the
  exception rather than revert, since the change is exactly what the
  approved proposal called for and both checkers passed it on the merits.
  Boss-approved.

- **2026-07-26 — Manual "add" moves to account-locked drawers
  (Categories + Transactions), and manual creation may assign a recurring
  category.** Standing rules added ahead of the Reports-default /
  Categories-drawer / Transactions-add build. Decisions locked with the
  user:
  - **Account-locked authoring is now the app-wide pattern** (already true
    for rules and new categories). Create drawers fix to the top-bar
    account and list only that account's categories/tags. The new
    Categories and Transactions add-drawers both follow it.
  - **Categories:** the inline blank add-rows at the foot of the Expense
    and Income cards are replaced by an "+ Add" button in each card
    header, opening a shared create drawer with an **Expense⇄Income toggle
    seeded by the card clicked** (Expense card → expense, switchable to
    income, and vice-versa). The drawer keeps the existing fields
    (name, recurring-vs-tag, cadence, amount) and creates the category in
    the selected account. No backend change.
  - **Transactions:** the page gains an "+ Add transaction" button opening
    a drawer that can create a transaction of ANY kind — assigned to a
    recurring category, to a tag, or uncategorized (misc). A recurring
    assignment **records the actual and clears that bill's line item for
    the period it falls in, via the SAME `assignCategory` /
    `clearLineItemForTransaction` path used when categorizing an existing
    transaction** (single source of truth — do not duplicate clearing
    logic). To allow this, `POST /transactions` is relaxed: the guard that
    rejected recurring categories ("recurring categories are assigned on
    the Transactions page") is lifted, but the server still (a) validates
    the recurring category is owned by the transaction's account
    (`templateOwnsAccount`) and rejects a mismatch, and (b) honors the
    existing closed-period and drift behavior. The pay-period page's
    existing tag-only add drawer is left unchanged.
  - **Reports** opens scoped to the selected account (initial
    `scope='account'`); the "All accounts" toggle stays available.
  - Every task here that touches a file carrying protected copy
    (`Categories.jsx`, `Transactions.jsx`) gets a **content-checker
    verbatim-vs-HEAD sweep** in addition to its type-matched checker, per
    the rule immediately below. Boss-approved.

- **2026-07-26 — A code/refactor task that moves or reformats a
  protected copy string still owes a verbatim content check.** Caught at
  the end of the account-scoped Rules build. Task 2 (a code task, checked
  by build/a11y/design — no content-checker) extracted the rules-page
  markup into new helpers and, in reflowing the JSX, silently flattened a
  curly apostrophe in the `MatchPreview` empty string (`aren’t` → `aren't`,
  U+2019 → U+0027). It passed all three of its checkers because none of
  them diffs visible strings against HEAD character-for-character — that
  is the content-checker's job, and content-checker is only auto-attached
  to content-worker tasks. The regression surfaced only because a later
  content task happened to sweep the file. Rule this sets: when a
  code/design/a11y task **touches a file that contains protected copy**
  (§1) — even if its brief is "layout/refactor only" — the boss attaches a
  **content-checker verbatim sweep vs HEAD** to that task, not just the
  type-matched checker. Reformatting is exactly how protected copy dies
  quietly: no one decided to change the words, so no content check was
  scheduled. Separately logged this build: content-worker's Edit tooling
  could not emit curly-quote codepoints (U+201C/U+201D) across two rounds;
  once wording is already decided, inserting specified Unicode is a
  mechanical byte-edit the boss may route to a code-worker (scripted
  insertion) with content-checker still verifying verbatim — that is not
  paraphrase and does not violate rule 3. Boss-approved.

- **2026-07-26 — Categorization rules are account-scoped through their
  category, and the Rules UI must reflect that.** Standing rules added
  ahead of the account-scoped/grouped Rules-page build. Facts of the
  engine, verified in code this session and now binding as the standard:
  - A `category_rules` row is stored per **budget**, not per account. The
    account a rule actually affects is determined by its **category's
    owning account** — `template.account_id ?? getDefaultAccountId()`,
    the backend `templateOwnsAccount` predicate. During rule application
    (`POST /transactions/recategorize`) a rule that matches a transaction
    but resolves to a category owned by a *different* account than the
    transaction's own is **skipped** (`skippedOtherAccount`), leaving the
    transaction uncategorized — it does not fall through to the next rule.
  - The `account_contains` / `institution_contains` /
    `account_number_contains` fields are a *secondary within-account
    filter* on the transaction's account metadata — never the scope. UI
    must present them as such (an in-row detail), and must never use them
    as the axis that decides which account a rule belongs to.
  - **Grouping axis = the category's owning account.** The Rules page
    groups and sorts by that resolved account, honoring the global
    `useAccount()` selector, mirroring the existing `inAccount` pattern in
    `web/src/pages/Categories.jsx` (`(c.accountId ?? defaultId) ===
    selectedId`). The selected account's group is expanded on top; other
    accounts are collapsed groups with a count.
  - **Authoring is account-locked.** New rules are created only for the
    focused account, via a side drawer (adapt `RuleDrawer.jsx`), whose
    category dropdown lists only that account's categories. The category
    dropdown on existing rule rows is likewise constrained to the row's
    own owning account, so no rule can be edited into a cross-account
    ("can never fire") state. A visible "can never fire" flag remains as a
    safety net for any pre-existing rows already in that state, not as a
    routine path.
  - **Reorder is global under the hood, group-scoped in the UI.**
    `sort_order` stays budget-wide (first-match-wins is global); the ↑/↓
    controls reorder a rule only against its group-mates. No schema
    change. Because cross-account rules cannot fire on each other's
    transactions, relative order between accounts is functionally
    irrelevant and must not be exposed. Boss-approved.

- **2026-07-24 — A design-system token that fails contrast *uniformly*
  is a design task, not a feature-build blocker.** Ruling made during the
  unplanned-transactions build. An a11y-checker correctly measured that
  `.btn-primary`'s white text on the `--btn-grad` orange gradient is
  ~2.9–3.8:1 — a real AA failure for normal-weight text, in both themes.
  But the failure is a property of the app-wide accent token, identical
  on every primary button already in production (Login, onboarding, every
  form); the task under review merely *reused* `.btn-primary` unchanged,
  as §4 requires. Fixing it means darkening the flagship orange or
  switching button text to dark ink — both change every button app-wide
  and both alter the accent identity §2 and §4 place off-limits *without a
  dedicated design task*. Making the one new button an exception would be
  its own §4 consistency violation.

  Boss ruling: **overruled as a blocker for the feature build; escalated
  as a standalone design task.** The checker was right about the fact and
  right to surface it — a valid finding is not the same as a valid blocker
  for *this* task. General rule this sets: when a checker's contrast (or
  other visual) FAIL lands on an unchanged, correctly-reused design-system
  token whose defect is uniform across its existing uses, the feature
  build does not own the fix; the boss logs it and routes it to a scoped
  design task. This is the deliberate flip side of the 2026-07-14 §2 note
  — that one caught a token passing in one context but failing in a new
  one (context-specific, and the new use *did* own it); this one is a
  token failing everywhere alike (systemic, and no single use owns it).
  Distinguish the two by asking: does this rendering context fail while
  other uses of the same token pass? If yes, the build owns it. If it
  fails everywhere identically, it is a design-task escalation. Escalated
  via a background task the same day. Boss-approved.

- **2026-07-24 — No agent runs a destructive git command on work it did
  not create.** Added the same day as the entry below, after an
  **a11y-checker** needed a temporary named export to mount a component
  in a test harness, made the edit, and then "cleanly reverted" it with
  `git checkout web/src/pages/PeriodDetail.jsx`. That command does not
  revert *your* edit — it reverts *the file*, and the file also held the
  entire uncommitted task-2 change it had just spent 80 tool calls
  verifying. The change was destroyed. A second checker independently
  noticed the diff had vanished mid-run and, correctly, flagged it
  instead of assuming it had imagined it.

  Binding on every agent:
  - Never run `git checkout <path>`, `git restore`, `git stash`,
    `git reset`, or `git clean` against a file you did not create in
    this task. The working tree is shared and usually holds other
    agents' uncommitted work.
  - To undo your OWN temporary edit, reverse it with the same editing
    tool you used to make it — an Edit that restores the exact prior
    text. If you cannot state precisely what you changed, you cannot
    safely undo it, and you must report that instead of guessing.
  - Checkers: prefer verification that does not require editing source
    at all. Needing to modify the code under test to test it is a signal
    to change method, not to edit and revert.

  Note this is *not* a rule against test harnesses — the harness itself
  was good practice and produced a real, well-evidenced result under an
  auth constraint. The failure was purely the cleanup command. Boss-approved.

- **2026-07-24 — No agent writes to the shared dev database.** Added
  during the unplanned-transactions build, after a **worker** (not a
  checker) verified delete-persistence by deleting a real seeded
  transaction from the shared dev DB and resetting a seeded user's
  password hash to get through the login form. It disclosed and restored
  both, but could not restore one field (`import_hash`), so the restore
  was *not* actually lossless — which is the whole point.

  The existing isolation rule was written for checkers of destructive
  features. It binds on **every agent, worker and checker alike, on every
  task**, and it is now written down as such:

  - No agent may INSERT, UPDATE or DELETE against the shared dev DB
    (the compose `db` container behind `:8080`), for any reason,
    including "I'll put it back."
  - Read-only queries against it are fine.
  - Verifying behavior that requires mutation — deletes, state after a
    write, login as a seeded user — is done against an **isolated
    ephemeral DB** (`npm run test:integration:ephemeral` is the existing
    path), or with a client-side fixture, or not at all. "Not at all,
    and I said so" is an acceptable, honest result under §5.
  - Credentials are never rewritten to obtain access. An agent that
    cannot log in reports that it could not log in.

  Rationale: a restore is a second chance to corrupt the data, and an
  agent that has already decided the risk is acceptable is the last
  party who should be judging whether its own restore was complete.
  Boss-approved.

- **2026-07-23 — Table actions and horizontal overflow.** Added two §4
  component-pattern rules ahead of the planned-vs-actual build
  (`docs/plans/planned-vs-actual.md`), both from defects that build
  actually produced. A "Plan {amount} going forward" button was first
  built inside the Actual `.num` cell; because its label embeds a
  formatted amount, its width varied per row and sized the whole column,
  contradicting the tabular-figures rule. Separately, going from three
  columns to five made the period table overflow 375px and scroll the
  **page** — caught only because the checker built the pre-change version
  and measured it, proving a regression rather than assuming one. Both
  rules are written as prohibitions because in each case the mistake
  looked reasonable while being made. Boss-approved.

  Not settled here: `AccountsCard.jsx` centers its Actions cell and
  `Transactions.jsx` does not. Both are permitted; pick one when either
  table is next touched rather than churning a passing table now.

- **2026-07-15 — Account-first pay periods.** Added §6 "Data migration /
  integrity" check and the §5 no-silent-financial-loss invariant ahead of
  the account-first periods build (`docs/plans/account-first-periods.md`),
  whose Phase 1 re-platforms `pay_periods`/`pay_period_configs` onto a
  per-account model and migrates existing rows. Boss-approved.
