# Progress

Current milestone: **M1 — Foundation**

| Milestone | Status | Started | Finished | Notes |
| --- | --- | --- | --- | --- |
| M1 Foundation | In progress | 17-11-2026 | | Plan approved; tasks 0–3 of 12 done |
| M2 Masters & engines | Not started | | | |
| M3 Procurement | Not started | | | |
| M4 QC | Not started | | | |
| M5 Sales | Not started | | | |
| M6 Production | Not started | | | |
| M7 QA & Dispatch | Not started | | | |
| M8 Finance & FBR | Not started | | | |
| M9 Dashboard & traceability | Not started | | | |
| M10 Hardening & staging | Not started | | | |
| M11 UAT & go-live | Not started | | | |

## Log
<!-- Agent: add one line per working session: date · milestone · what was finished · what is next -->
- 17-11-2026 · M1 · Docs updated from the M1 Q&A (decisions Q1–Q18, `docs/roles.md`); plan approved. Task 0 done (test-DB reset with *_test guard, @types/node 26, new env vars and error codes). Task 1 done (`0001_core_identity.sql`: companies, users, user_credentials, sessions, auth_events, permissions, roles, role_permissions, user_roles + DB guards; Drizzle `schema/core.ts`; 18 DB tests). 26/26 tests green. · Next: task 2 (permissions.ts with classes + seed) — role seeding waits for the owner of `master.item.manage` / `master.formula.manage`.
- 17-11-2026 · M1 · Task 2 done: `permissions.ts` with classes (67 keys), shared password policy, seed (`db/seed/run.ts`, `db/seed/roles.ts`): permissions sync, 20 roles from `docs/roles.md`, first admin from `INITIAL_ADMIN_PASSWORD`; roles.md ↔ seed consistency test. 43/43 tests green; `pnpm db:seed` run twice on dev (second run: no changes). `master.item.manage` / `master.formula.manage` left unassigned pending owner. Nothing committed yet (git identity not set). · Next: task 3 (auth).
- 17-11-2026 · M1 · Task 3 done: `core/auth` (service, repo, tokens, middleware, routes under `/api/v1/core/auth`: login, refresh, logout, me, change-password; `unlockUser` service — its route comes with the user admin in task 4). 23 auth tests incl. lockout, unlock, token reuse, fixed 12 h session, forced/expired password gate, last-5 reuse; mutation-checked. 66/66 tests green. Logger redacts tokens, cookies and passwords. · Next: task 4 (RBAC `requirePermission`, users/roles admin with Q1 guards and QA countersign — countersign needs the e-signature from task 5, so task 5's `core/esign` is built first).
