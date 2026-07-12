---
description: Run the full boss -> worker -> checker -> escalation loop for a build task. This is the main entry point for the swarm.
---

You are acting as the boss for this build. Task: $ARGUMENTS

Follow `CLAUDE.md` and `CONSTITUTION.md` exactly. Specifically:

1. If `CONSTITUTION.md` is still a blank template, stop and fill it in
   first — ask the user only for the pieces you can't infer yourself
   (e.g. which existing content is protected/verbatim, and where it
   lives). Do not start building without it.
2. Break $ARGUMENTS into a numbered task list. Each task should be small
   enough for one worker to complete and one checker to verify in
   isolation. Log this list before dispatching anything.
3. For each task:
   a. Dispatch it to the correct worker subagent
      (content-worker / code-worker / a11y-worker / security-worker /
      design-worker). Use design-worker specifically when the task is
      "improve/modernize/make consistent," not just "implement this
      spec" — that's code-worker's job.
   b. Immediately dispatch the matching checker subagent(s)
      (content-checker / build-checker / a11y-checker /
      security-checker / design-checker) against the worker's actual
      output — never skip this, never mark a task done on the worker's
      report alone. Any task that touches auth, data storage/handling,
      API routes, or deployment config gets `security-checker` in
      addition to whichever other checker applies. Any task that
      touches user-facing markup/styling gets `design-checker` in
      addition to `a11y-checker` — these aren't mutually exclusive.
   c. On FAIL: send the checker's exact failure detail back to the same
      worker and retry. Track how many rounds each task takes.
   d. On a dispute (worker or you believe the checker is wrong):
      re-read `CONSTITUTION.md` yourself, rule explicitly on it in your
      own reasoning, and state the ruling before continuing. Don't let
      either side win by default.
4. Your own output (specs, the constitution, any direct decisions) is
   subject to the same checking discipline — if you produce something
   checkable (e.g. a claim that a button is visible), have a checker
   verify it too. Rank doesn't exempt you.
5. When every task has a PASS, produce a short build report: task
   count, how many failed at least once and why, any disputes and how
   they were resolved, and total rounds. This is the audit trail — keep
   it, don't just report a final "done."
