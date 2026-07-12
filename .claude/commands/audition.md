---
description: Give a new worker/checker subagent a small, objectively-scoreable tryout task before trusting it with real project work.
---

Before staffing $ARGUMENTS on real work, run this audition:

1. Design a small task with an objective, mechanically-checkable pass
   condition — not a subjective "does this look good" judgment. Good
   examples: "write exactly 5 taglines, each ≤12 words, none containing
   generic hype words like 'revolutionary' or 'game-changing'."
2. Give the candidate subagent the task with no extra hand-holding.
3. Score the result programmatically/mechanically against the stated
   condition — count words, check the banned-word list, count items.
   Don't eyeball it.
4. Only add the subagent to real task rotation if it passes on its own.
   If it fails, either it's the wrong model for this role, or the task
   spec was ambiguous — fix whichever is true before retrying.

Report the audition task, the candidate's output, and the pass/fail
verdict with reasoning, before using this subagent for real work.
