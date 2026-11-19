# Progress

Current milestone: **M2 — Masters & engines** (M1 done, tag `m1`)

| Milestone | Status | Started | Finished | Notes |
| --- | --- | --- | --- | --- |
| M1 Foundation | Done | 17-11-2026 | 18-11-2026 | All 12 tasks, rules-review fixes A–F, first-QA-Manager bootstrap; CI run #13 green on `04ef009`; tag `m1` |
| M2 Masters & engines | In progress | 18-11-2026 | | Tasks 1–9 done; task 10 next |
| M3 Procurement | Not started | | | |
| M4 QC | Not started | | | |
| M5 Sales | Not started | | | |
| M6 Production | Not started | | | |
| M7 QA & Dispatch | Not started | | | |
| M8 Finance & FBR | Not started | | | |
| M9 Dashboard & traceability | Not started | | | |
| M10 Hardening & staging | Not started | | | |
| M11 UAT & go-live | Not started | | | |

## Handoff (19-11-2026, M2 in progress)

**State:** M2 tasks 1–9 are done; task 10 is in progress. 550 tests green (511 API, 24 web, 15 shared). API tests need the Docker DB (`docker compose up -d`). We work on `main` with one commit per task. History and the detailed notes from tasks 3–9 are in `docs/progress-log.md`: grep it, never read it whole.

| # | M2 task (scope: build-plan.md M2) | Status |
| --- | --- | --- |
| 1–3c | Shared keys; masters schema `0008`, service and routes; party guards `0009`; roles correction `0010`; item activation `0011`; `qaControlled` flag | ✅ |
| 4–4a | Finance masters `0012`; JV/SJ journal series and WHT block `0013`; `pnpm db:seed:dev` | ✅ |
| 5–6 | Inventory schema `0014`; `engines/inventory` with valuation `0015` (owner Option A rounding) | ✅ |
| 7–7a | `engines/posting` and rounding sweep `0016`; owner Q8/Q9: value adjustment, batch cost close, sales returns `0017` | ✅ |
| 8–8b | Done-when test `m2-done-when.test.ts`; return limit per customer `0018`; FG doer + checker (`prod.output.verify`); dispatch only to an ACTIVE customer `0019` | ✅ |
| 9 | Web: DataTable/DocForm, all master, finance and journal screens | ✅ |
| 10 | Owner Q19 Excel numbers ✅; `/check-rules` since `m1` ✅ with fixes: disposal QA witness `0020` (A) and deactivation guards `0021` (B, rule 7 scope); docs, CI and the open-question list next | in progress |

**For task 10:**
- The Done-when checks are in the build-plan M2 section. They are automated in `apps/api/src/__tests__/m2-done-when.test.ts` (5 tests, mutation-checked).
- Task 9 screens were smoke-tested through the Vite proxy but never clicked through in a browser. The dev DB has no master data yet, so the owner should try the screens. The web bundle is about 1.6 MB (antd); code splitting is M10 work.

**Rules the code already relies on (M3+):**
- A module posts stock in ONE `withTransaction`: `postMovement` (engines/inventory) then `postStockJournal` (engines/posting). Corrections: `reverseMovements` then `reverseStockJournal`. Transfers post no journal. Toll rows post nothing.
- Disposal (rule 1, `0020`): `verifyWitness(..., disposalSubject(type, lot, qty))` BEFORE the transaction; then in one transaction `postMovement({ witness })`, `postStockJournal`, and `closeDisposedLot` when the lot is empty. A reversal of a disposal needs its own witness (`disposalSubject(..., true)`).
- Masters still in use cannot be deactivated (`0021`, IN_USE). An item becomes ACTIVE only while its UoM, category and tax code are active.
- The actor must hold the event's key (`JournalPostingKeys`). Non-stock events (invoice, payment, landed cost, conversion) have no key yet; their module adds one.
- Never write `inv.stock_balances` (the ledger trigger keeps it). Lock lots and balances `FOR UPDATE` in the engine. Raw-SQL lot inserts need `source`. DISPATCH and SALES_RETURN need `customerId`.
- An FG lot is created only under `prod.output.verify`. DISPATCH needs `closeBatchCost` first and an ACTIVE customer.
- The DB refuses, at COMMIT, any empty lot that still holds value; the rounding sweep in `postStockJournal` handles this.
- Test DBs have no fiscal periods; tests that post must create them. Reusable check: `glEqualsLedger()` in `posting-engine.test.ts`.
- M3 landed cost: the value-only adjustment is not designed. Ask the owner when M3 starts, and do not reuse `ROUNDING_SWEEP` for it.
- Roles: `pnpm db:seed` adds keys from `docs/roles.md` that roles are missing. If it stops with `RoleBundleDriftError`, ask the owner per key and never remove keys yourself.

**Open questions for the owner (not blocking M2; resolved 7–10, 12, 14–16, 19 are archived in progress-log.md):**
1. BATCH_CLOSE lock is "roles holding `prod.batch.approve_close`" (Production Manager). Confirm or change.
2. Reopening a fiscal period: also require a Finance Manager e-signature?
3. Must periods be closed in order?
4. Block one user from holding both an admin role and a business-action role?
5. Attachments: allow "void with reason", or keep insert-only?
6. Finance to confirm: chart of accounts and default posting rules (PLACEHOLDER: 35 accounts incl. 5400, one stock account for all categories), WHT rates per section (posting WHT is blocked until each is confirmed), lot-actual costing under IAS 2, approval limits.
11. (d) still PENDING for M6. Likely, but not confirmed: conversion goes to a production-variance expense account (placeholder; Finance to confirm).
13. M6 note: the conversion journal (CONVERSION_ABSORB) has no posting key yet; M6 adds it with batch close.
17. `prod.output.verify` is not QA-controlled (granting it needs no QA Manager countersign). Agent default, PENDING OWNER (decisions.md).
18. M6: which other stage steps need a checker (at least API dispensing/weighing)? Owner to decide when M6 starts.
20. Disposal details (decisions 2026-11-19, agent default, PENDING OWNER): (a) reversing a disposal row needs its own QA witness; (b) one witness signature per movement, so a lot at several locations is moved to one location first.

**Local dev DB:** migrated to 0021 and seeded. It has the `demo.<role>` users (password = `DEV_DEMO_PASSWORD` in `.env`) and FY 2026-27 periods OPEN. `demo.qa_manager` holds the QA countersign.
