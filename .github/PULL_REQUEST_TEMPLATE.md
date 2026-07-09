<!--
Thanks for contributing to PayCycle! Keep the description short and focused.
For anything non-trivial, please open an issue first to agree on the approach.
-->

## What & why

<!-- What does this change, and what problem does it solve? Link the issue it
closes, e.g. "Closes #12". -->

## How it was tested

<!-- How did you verify it works? Commands run, scenarios exercised. -->

## Checklist

- [ ] `npm test` passes
- [ ] `npm run build:web` succeeds
- [ ] Added/updated tests for changes to the schedule or projection engine (the money math)
- [ ] Money stays integer cents; dates stay timezone-free `YYYY-MM-DD` strings
- [ ] No hardcoded secrets or personal defaults — everything configurable via env
