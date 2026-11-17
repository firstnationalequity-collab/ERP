# Progress

Current milestone: **M1 — Foundation**

| Milestone | Status | Started | Finished | Notes |
| --- | --- | --- | --- | --- |
| M1 Foundation | In progress | 17-11-2026 | | All 12 tasks and rules-review fixes A–F done; Done-when green locally; waiting for owner to confirm CI, then mark done + tag `m1` |
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

## Handoff (17-11-2026, end of M1 work)

**State:** M1 code complete at `30d55e5` on `main` (pushed). `pnpm typecheck` clean; 265 tests green (API 246, web 10, shared 9); web production build OK. Working tree clean.

**M1 "Done when" (re-run after the rules-review fixes):**

| Check | Result | Evidence (test names in `apps/api/src/__tests__`) |
| --- | --- | --- |
| Login works | ✅ | auth.test: signs in…, matches username case-insensitively, refuses a wrong password |
| Any change writes an `audit_log` row | ✅ | core-identity-db: audits the insert; audit-settings: shows any change with who/when/why (via API); seed: records the seed as SYSTEM; foundation-db |
| `audit_log` never contains a password hash | ✅ | core-identity-db: audit_log never contains it; auth: no password or token hash anywhere; audit-settings: never shows a hash |
| User without permission gets 403 | ✅ | access: CEO/QA/Planner refused user admin; esign-transition: QC Analyst, QA Manager, System Admin, CEO refused lot approval; approvals: refused without step role / admin-key role; attachments: refused at the route |
| Wrong e-signature password refused | ✅ | esign-transition: ESIGN_FAILED + counted, lockout on 5th; approvals: wrong password counted |
| `pnpm test` green locally **and in CI** | ✅ locally / **⏳ CI: owner to confirm** | Repo is private; the agent cannot see GitHub Actions |

**Rules review (`/check-rules`) findings — all fixed, one commit each:** A admin roles never approve (`204d264`) · B GMP approvals locked in code + Finance countersign for matrix changes (`ff55100`) · C attachment permission at the route (`87c9f48`) · D NUMERIC split, migration 0007 (`923dde9`) · E refusal-path tests (`6e971fe`) · F conventions + enum↔CHECK test (`30d55e5`).

**To close M1 (owner):** confirm the CI run for `30d55e5` is green at https://github.com/firstnationalequity-collab/ERP/actions → then the agent marks M1 done here and tags `m1`.

**Waiting for the owner (none blocks M1 close unless the owner says so):**
1. BATCH_CLOSE lock: implemented as "roles holding `prod.batch.approve_close`" (Production Manager, architecture §4), not a QA role as written in the review answer — confirm or change (one line in `GmpLockedApprovals`).
2. Reopening a fiscal period: also require a Finance Manager e-signature?
3. Must periods be closed in order (no August close while July is open)?
4. Block one user from holding both an admin role and a business-action role?
5. Attachments: allow "void with reason" for a wrong upload, or keep insert-only?
6. Item and master-formula ownership (`master.item.manage`, `master.formula.manage` unassigned) — needed before M2 masters.

**Local dev database notes:**
- First admin: username `admin`, temporary password given in chat; forced change at first login.
- Seeded before rules-review B, so the Finance Manager role there lacks `fin.approval_rules.countersign`: add it on the Roles page (no countersign needed). Fresh databases get it from the seed.

**Next milestone:** M2 — Masters and engines (`/milestone M2` in a fresh chat). Prerequisite: answer item 6 above.

## Log
<!-- Agent: add one line per working session: date · milestone · what was finished · what is next -->
- 17-11-2026 · M1 · Docs updated from the M1 Q&A (decisions Q1–Q18, `docs/roles.md`); plan approved. Task 0 done (test-DB reset with *_test guard, @types/node 26, new env vars and error codes). Task 1 done (`0001_core_identity.sql`: companies, users, user_credentials, sessions, auth_events, permissions, roles, role_permissions, user_roles + DB guards; Drizzle `schema/core.ts`; 18 DB tests). 26/26 tests green. · Next: task 2 (permissions.ts with classes + seed) — role seeding waits for the owner of `master.item.manage` / `master.formula.manage`.
- 17-11-2026 · M1 · Task 2 done: `permissions.ts` with classes (67 keys), shared password policy, seed (`db/seed/run.ts`, `db/seed/roles.ts`): permissions sync, 20 roles from `docs/roles.md`, first admin from `INITIAL_ADMIN_PASSWORD`; roles.md ↔ seed consistency test. 43/43 tests green; `pnpm db:seed` run twice on dev (second run: no changes). `master.item.manage` / `master.formula.manage` left unassigned pending owner. Nothing committed yet (git identity not set). · Next: task 3 (auth).
- 17-11-2026 · M1 · Task 3 done: `core/auth` (service, repo, tokens, middleware, routes under `/api/v1/core/auth`: login, refresh, logout, me, change-password; `unlockUser` service — its route comes with the user admin in task 4). 23 auth tests incl. lockout, unlock, token reuse, fixed 12 h session, forced/expired password gate, last-5 reuse; mutation-checked. 66/66 tests green. Logger redacts tokens, cookies and passwords. · Next: task 4 (RBAC `requirePermission`, users/roles admin with Q1 guards and QA countersign — countersign needs the e-signature from task 5, so task 5's `core/esign` is built first).
- 17-11-2026 · M1 · Code pushed to GitHub (firstnationalequity-collab/ERP). Task 5 done: `0002_esign_transition.sql` (e_signatures, status_history, `core.require_transition` DB guard), `core/esign` (verify in own tx so failures count; single-use 2-min proof; witness), `core/transition` (per-move permission key, e-sign meaning, reason, witness; row lock; SYSTEM-only moves). 30 tests on a stand-in lot table with the real §4 lot moves (rule 1: admin/CEO/QA cannot approve; only QA holds; only QC rejects; disposal needs QA witness); mutation-checked. 96/96 green. · Next: task 4 (RBAC + users/roles admin with QA countersign).
- 17-11-2026 · M1 · Task 4 done: `requirePermission` / `requireAnyPermission`; `core/access` (service, repo, routes): users (list, create with temp password, edit, activate/deactivate, unlock, reset password, set roles) and roles (list, create, edit, set bundle, activate/deactivate), permissions catalogue — all under `/api/v1/core` behind authenticate + requireCurrentPassword. Q1 guards with QA countersign, LAST_ADMIN, no self-deactivate/reset. 37 HTTP tests; mutation-checked (self-role change also held by the DB guard). 133/133 green. · Next: task 6 (numbering + fiscal periods).
- 17-11-2026 · M1 · Task 6 done: `0003_numbering_periods.sql` (number_series + counters, fiscal_periods with no-overlap constraint, `core.assert_period_open`, `core.require_open_period` DB guard); shared fiscal calendar + pattern rules; `nextDocNo` (PO-2627-00001, AP26-0001; FY/calendar reset by document date; Asia/Karachi today); number-series admin; fiscal years/periods with close/reopen via core/transition. 22 tests incl. 20-way concurrency, rollback without gap, close waiting for an in-flight posting; mutation-checked. Dev seeded with PO and BATCH series. 161/161 green. · Next: task 7 (approvals).
- 17-11-2026 · M1 · Task 7 done: `0004_approvals.sql` (approval_rules, approvals, approval_steps; requester-cannot-approve and one-step-per-person in the DB; status via core/transition); approval engine (`startApproval`, `cancelApproval`, approve/reject as e-signatures, "then"/"and", routing to roles, module handlers), inbox + count, approval-rules admin; §3 matrix seeded as placeholders. 29 tests incl. every PO band boundary, USD conversion with exact decimals, FM+QA parallel, one person cannot fill both steps, rollback when the module fails; mutation-checked. Fixed 3 ordering bugs found by the DB guards; local dev DB rebuilt. 190/190 green. · Next: task 8 (idempotency + attachments).
- 17-11-2026 · M1 · Task 8 done: `0005_idempotency_attachments.sql`; `idempotent()` middleware (claim, replay, 409 on different request or in progress, 5xx releases, per user, 24 h expiry, passwords never hashed or stored), optional on approve/reject; storage interface + local-disk driver (random write-once keys, no path escape); attachments upload/list/download with allow-list, 20 MB limit, SHA-256 re-checked on download, insert-only + audited, per-module targets. 19 tests incl. double-click race and tampered file; mutation-checked. 209/209 green. · Next: task 9 (audit trail and settings read APIs).
- 17-11-2026 · M1 · Task 9 done: `0006_settings_audit_indexes.sql` (core.settings + audit indexes) — all 19 M1 core tables now exist (build-plan item ticked). Audit viewer API (audit log with field-level changes, tables, status history, e-signatures, auth events; Karachi-day date filters) behind core.audit.view; settings registry + list/update with reason. 13 tests incl. the Done-when "any change writes an audit_log row" through the API; mutation-checked. 222/222 green. · Next: task 10 (CI), then task 11 (web), task 12 (Done-when checks).
- 17-11-2026 · M1 · Task 10 done: GitHub Actions CI (Node from .nvmrc, frozen lockfile, typecheck, tests on postgres:16). Simulating CI on a fresh clone + empty database found that `.gitignore` (`storage/`) had hidden `core/storage/storage.ts` since task 8 — fixed and committed; clean clone then passed 222/222. Repo is private, so the first Actions run must be checked by the owner. · Next: task 11 (web screens).
- 17-11-2026 · M1 · Task 11 done: web app — API client (in-memory token, silent refresh, retry on 401, idempotency keys), auth context with 30-min idle logout, login, forced/voluntary change password with live policy check, permission-driven layout with inbox badge, ESignModal with QA countersign, pages: home, my approvals (approve/reject e-signed), users, roles, approval rules, number series, fiscal periods, audit trail (changes with field diffs, record history drawer, sign-in events). 10 web unit tests; vite build OK; smoke test of real API + Vite proxy (login, cookie path, forced change block, refresh, logout). Local dev DB has first admin (temporary password given to the owner in chat). 232/232 tests green. · Next: task 12 (Done-when checks + /check-rules).
- 17-11-2026 · M1 · Task 12: Done-when checks run with evidence; /check-rules found A–F; owner chose fixes (B = options 1+2, D = migration split). Fixed and pushed one commit each (A 204d264, B ff55100, C 87c9f48, D 923dde9, E 6e971fe, F 30d55e5); Done-when re-run: all green locally, 265 tests. Handoff written. · Next: owner confirms CI → mark M1 done, tag m1; then M2.
