---
description: Review the current milestone's code against the non-negotiable rules
---
Review the code changed in the current milestone (use `git diff` against the last milestone tag or recent commits) against the 12 non-negotiable rules in CLAUDE.md and the conventions there.

For each rule report: OK, or the file:line that breaks it and the fix.
Also check: every route has `requirePermission`; every status change goes through `core/transition`; no float arithmetic on money/qty; every posting action is in one transaction and uses the engines; tests exist for each refusal.

Do not change code in this command — list findings first, then ask whether to fix them.
