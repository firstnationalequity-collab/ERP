---
description: Start or continue a build milestone (e.g. /milestone M1)
argument-hint: M<number>
---
We are working on milestone $ARGUMENTS of the Albert Pharma ERP.

1. Read CLAUDE.md, docs/progress.md (milestone table + Handoff), the $ARGUMENTS section of docs/build-plan.md, and only the parts of docs/architecture.md and docs/decisions.md it depends on (grep for sections; never read a whole doc or docs/progress-log.md).
2. Check what already exists in the code for this milestone.
3. Write a numbered plan of the remaining tasks (files, tables, endpoints, tests). Stop and wait for my OK.
4. After my OK, build one task at a time: migration/schema → service + tests (happy path and every refusal) → routes → web.
5. After each task run `pnpm typecheck` and `pnpm test`; fix failures without weakening rules.
6. Tick finished tasks in docs/build-plan.md and update the docs/progress.md Handoff (under 80 lines); append one line per task to the end of docs/progress-log.md.
