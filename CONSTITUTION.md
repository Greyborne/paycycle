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

## 8. Sign-off & amendment
This constitution is the standard until the boss explicitly revises it
here, dated. A checker's FAIL is not overridden by a worker's — or the
boss's — say-so: disputes are resolved by re-reading this file and ruling
explicitly, in writing, before continuing.

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
