---
description: Start or continue a build milestone (e.g. /milestone M1)
argument-hint: M<number>
---
We are working on milestone $ARGUMENTS of the Albert Pharma ERP.

1. Read CLAUDE.md, docs/progress.md, docs/decisions.md, the $ARGUMENTS section of docs/build-plan.md, and the parts of docs/architecture.md it depends on.
2. Check what already exists in the code for this milestone.
3. Write a numbered plan of the remaining tasks (files, tables, endpoints, tests). Stop and wait for my OK.
4. After my OK, build one task at a time: migration/schema → service + tests (happy path and every refusal) → routes → web.
5. After each task run `pnpm typecheck` and `pnpm test`; fix failures without weakening rules.
6. Tick finished tasks in docs/build-plan.md and update docs/progress.md (status + a log line).
