# Progress

Current milestone: **M3 — Procurement** (M2 done, tag `m2`)

| Milestone | Status | Started | Finished | Notes |
| --- | --- | --- | --- | --- |
| M1 Foundation | Done | 17-11-2026 | 18-11-2026 | All 12 tasks, rules-review fixes A–F, first-QA-Manager bootstrap; CI run #13 green on `04ef009`; tag `m1` |
| M2 Masters & engines | Done | 18-11-2026 | 19-11-2026 | All 10 tasks; rules-review fixes (disposal witness 0020, deactivation guards 0021); owner answers 19-11 recorded; CI green; tag `m2` |
| M3 Procurement | Not started | | | |
| M4 QC | Not started | | | |
| M5 Sales | Not started | | | |
| M6 Production | Not started | | | |
| M7 QA & Dispatch | Not started | | | |
| M8 Finance & FBR | Not started | | | |
| M9 Dashboard & traceability | Not started | | | |
| M10 Hardening & staging | Not started | | | |
| M11 UAT & go-live | Not started | | | |

## Handoff (19-11-2026, M2 done, M3 next)

**State:** M2 is done and tagged `m2`: 551 tests green (511 API, 24 web, 16 shared), CI green. API tests need the Docker DB (`docker compose up -d`). We work on `main` with one commit per task. The M2 task table, Done-when evidence and answered questions are in `docs/progress-log.md` ("M2 close-out archive"): grep it, never read it whole.

**Next: M3 Procurement** (build-plan M3; start with `/milestone M3` in a new chat).
- First task: the owner decisions carried in from M2 (build-plan M3, first line): period reopen with Finance Manager e-signature + reason, periods closed and reopened in order (Q2, Q3); no user with both an admin role and an action role (Q4); attachments "void with reason" (Q5). These change M1 core code, so read decisions.md 2026-11-19 first.
- Landed cost is fully decided (Q21): architecture §6 "Landed cost".
- Build on the PLACEHOLDER chart and tax codes (Q6). WHT posting stays blocked until Finance confirms each rate.
- Task 9 screens have never been clicked through in a browser; the owner should try them. The web bundle is about 1.6 MB (antd); code splitting is M10 work.

**Rules the code already relies on (M3+):**
- A module posts stock in ONE `withTransaction`: `postMovement` (engines/inventory) then `postStockJournal` (engines/posting). Corrections: `reverseMovements` then `reverseStockJournal`. Transfers post no journal. Toll rows post nothing.
- Disposal (rule 1, `0020`): `verifyWitness(..., disposalSubject(type, lot, qty))` BEFORE the transaction; then in one transaction `postMovement({ witness })`, `postStockJournal`, and `closeDisposedLot` when the lot is empty. A reversal of a disposal needs its own witness (`disposalSubject(..., true)`).
- Masters still in use cannot be deactivated (`0021`, IN_USE). An item becomes ACTIVE only while its UoM, category and tax code are active.
- The actor must hold the event's key (`JournalPostingKeys`). Non-stock events (invoice, payment, landed cost, conversion) have no key yet; their module adds one.
- Never write `inv.stock_balances` (the ledger trigger keeps it). Lock lots and balances `FOR UPDATE` in the engine. Raw-SQL lot inserts need `source`. DISPATCH and SALES_RETURN need `customerId`.
- An FG lot is created only under `prod.output.verify` (QA-controlled since Q17). DISPATCH needs `closeBatchCost` first and an ACTIVE customer.
- The DB refuses, at COMMIT, any empty lot that still holds value; the rounding sweep in `postStockJournal` handles this.
- Test DBs have no fiscal periods; tests that post must create them. Reusable check: `glEqualsLedger()` in `posting-engine.test.ts`.
- Landed cost (owner Q21): architecture §6 "Landed cost" and build-plan M3. Do not reuse `ROUNDING_SWEEP` for it.
- Roles: `pnpm db:seed` adds keys from `docs/roles.md` that roles are missing. If it stops with `RoleBundleDriftError`, ask the owner per key and never remove keys yourself.

**Open questions for the owner:** none.

**Local dev DB:** migrated to 0021 and seeded. It has the `demo.<role>` users (password = `DEV_DEMO_PASSWORD` in `.env`) and FY 2026-27 periods OPEN. `demo.qa_manager` holds the QA countersign.
