---
description: Run a full-app design consistency sweep independent of any specific feature build. Finds and reports drift; optionally dispatches design-worker to fix it.
---

Run design-checker as a full-app sweep, not scoped to a recent diff.
Target: $ARGUMENTS (or the whole frontend if no specific area given).

1. If `CONSTITUTION.md` section 4 (Design system) is still a blank
   template, stop and populate it first by auditing the current UI
   yourself (as the boss) — this sweep needs a documented baseline to
   check against, not vibes.
2. Dispatch design-checker across the target area for a consolidated
   drift report, grouped by pattern (inconsistent spacing, inconsistent
   color usage, inconsistent component variants, generic/templated
   choices that don't match the app's identity), not a flat list of
   one-off findings.
3. Review the findings yourself. For each finding, decide: is this
   genuine drift to fix, or does it reveal that section 4 itself needs
   updating (i.e. two legitimate patterns exist and the constitution
   should document which is canonical)? Don't assume the checker is
   always right about which pattern should win — that's your call to
   make explicitly, same dispute-resolution discipline as anywhere else
   in this system.
4. For confirmed drift, dispatch design-worker to fix each item, then
   design-checker again to confirm the fix actually resolved it (not
   just that a change was made).
5. Produce a summary: what was found, what was fixed, and any section 4
   updates made as a result. This is the artifact the user reviews —
   they should see decisions and rationale, not just a diff.
