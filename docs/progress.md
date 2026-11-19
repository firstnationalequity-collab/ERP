# Progress

Current milestone: **M2 — Masters & engines** (M1 done, tag `m1`)

| Milestone | Status | Started | Finished | Notes |
| --- | --- | --- | --- | --- |
| M1 Foundation | Done | 17-11-2026 | 18-11-2026 | All 12 tasks, rules-review fixes A–F, first-QA-Manager bootstrap; CI run #13 green on `04ef009`; tag `m1` |
| M2 Masters & engines | In progress | 18-11-2026 | | Tasks 1–10 done; waiting for owner answers, then tag `m2` |
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

**State:** M2 tasks 1–10 are done and pushed; the `m2` tag waits for the owner to answer the open questions below. 550 tests green (511 API, 24 web, 15 shared). API tests need the Docker DB (`docker compose up -d`). We work on `main` with one commit per task. History and the detailed notes from tasks 3–9 are in `docs/progress-log.md`: grep it, never read it whole.

| # | M2 task (scope: build-plan.md M2) | Status |
| --- | --- | --- |
| 1–3c | Shared keys; masters schema `0008`, service and routes; party guards `0009`; roles correction `0010`; item activation `0011`; `qaControlled` flag | ✅ |
| 4–4a | Finance masters `0012`; JV/SJ journal series and WHT block `0013`; `pnpm db:seed:dev` | ✅ |
| 5–6 | Inventory schema `0014`; `engines/inventory` with valuation `0015` (owner Option A rounding) | ✅ |
| 7–7a | `engines/posting` and rounding sweep `0016`; owner Q8/Q9: value adjustment, batch cost close, sales returns `0017` | ✅ |
| 8–8b | Done-when test `m2-done-when.test.ts`; return limit per customer `0018`; FG doer + checker (`prod.output.verify`); dispatch only to an ACTIVE customer `0019` | ✅ |
| 9 | Web: DataTable/DocForm, all master, finance and journal screens | ✅ |
| 10 | Owner Q19 Excel numbers; `/check-rules` since `m1` with fixes A (disposal QA witness `0020`) and B (deactivation guards `0021`); docs match code; Done-when evidence and open questions below; CI green on the final commit | ✅ (tag `m2` waits for the owner) |

**M2 Done-when evidence** (build-plan M2; all in CI). Main file: `apps/api/src/__tests__/m2-done-when.test.ts` (DW):
- Receipt posts a movement AND a balanced journal in one transaction: DW 1; `posting-engine.test.ts` "posts a receipt and its journal in one transaction".
- A forced error rolls back both: DW 2 (error after both; journal failure after the movement); `posting-engine.test.ts` "a failure in the journal rolls back the movement", "an actor without the event key posts nothing", "refuses a journal that does not match the movements".
- Negative stock refused by the DB: DW 3 (engine, ledger trigger, CHECK `stock_balance_not_negative`); `inventory-db.test.ts` "never lets stock go negative (rule 3)".
- Also in the same file: toll = zero value, no journal (DW 4); GL inventory = Σ ledger values after every movement type, now including witnessed disposals (DW 5).
- Tasks: masters `masters.test.ts`, `masters-db.test.ts`, `items-db.test.ts`; finance masters `finance-masters.test.ts`, `finance-db.test.ts`; inv tables `inventory-db.test.ts`; engines `inventory-engine.test.ts`, `valuation.test.ts`, `posting-engine.test.ts`, `fg-cost-returns.test.ts`, `journals.test.ts`; web `masters-ui.test.ts` (helpers only: screens never clicked through in a browser, owner to try them).

**Rules the code already relies on (M3+):**
- A module posts stock in ONE `withTransaction`: `postMovement` (engines/inventory) then `postStockJournal` (engines/posting). Corrections: `reverseMovements` then `reverseStockJournal`. Transfers post no journal. Toll rows post nothing.
- Disposal (rule 1, `0020`): `verifyWitness(..., disposalSubject(type, lot, qty))` BEFORE the transaction; then in one transaction `postMovement({ witness })`, `postStockJournal`, and `closeDisposedLot` when the lot is empty. A reversal of a disposal needs its own witness (`disposalSubject(..., true)`).
- Masters still in use cannot be deactivated (`0021`, IN_USE). An item becomes ACTIVE only while its UoM, category and tax code are active.
- The actor must hold the event's key (`JournalPostingKeys`). Non-stock events (invoice, payment, landed cost, conversion) have no key yet; their module adds one.
- Never write `inv.stock_balances` (the ledger trigger keeps it). Lock lots and balances `FOR UPDATE` in the engine. Raw-SQL lot inserts need `source`. DISPATCH and SALES_RETURN need `customerId`.
- An FG lot is created only under `prod.output.verify`. DISPATCH needs `closeBatchCost` first and an ACTIVE customer.
- The DB refuses, at COMMIT, any empty lot that still holds value; the rounding sweep in `postStockJournal` handles this.
- Test DBs have no fiscal periods; tests that post must create them. Reusable check: `glEqualsLedger()` in `posting-engine.test.ts`.
- M3 landed cost: see open question 21. Do not reuse `ROUNDING_SWEEP` for it.
- Roles: `pnpm db:seed` adds keys from `docs/roles.md` that roles are missing. If it stops with `RoleBundleDriftError`, ask the owner per key and never remove keys yourself.

**Open questions for the owner** (recommended answer; M3 = blocks M3; resolved ones are archived in progress-log.md):
1. BATCH_CLOSE lock = roles holding `prod.batch.approve_close` (Production Manager). Rec: confirm. M6, not M3.
2. Reopening a fiscal period also needs a Finance Manager e-signature? Rec: yes, with a reason. Not M3.
3. Close periods in order? Rec: yes. Close only the earliest OPEN period and reopen only the latest CLOSED one. Not M3.
4. Block one user from holding both an admin role and an action role? Rec: yes, same rule as for roles. Not M3.
5. Attachments: "void with reason" or insert-only? Rec: void with reason (file kept and audited, never deleted). Not M3.
6. Finance to confirm the chart of accounts, posting rules, WHT rates, lot-actual costing (IAS 2) and approval limits (placeholders today). Rec: confirm before UAT. M3 can be built on placeholders, but WHT stays blocked until each rate is confirmed. Not M3.
11. (d) Conversion goes to a production-variance expense account? Rec: yes (placeholder until Finance confirms). M6.
13. The CONVERSION_ABSORB journal key. Rec: `prod.batch.approve_close` (it posts at batch close). M6.
17. Is `prod.output.verify` QA-controlled? Rec: change the agent default to YES (it verifies a GMP batch record). Not M3.
18. Which other stage steps need a checker? Rec: dispensing/weighing of every material, line clearance, yield. M6.
20. Disposal: (a) a reversal needs its own witness; (b) one witness signature per movement. Rec: confirm both. Not M3.
21. M3 landed cost: the value-only adjustment design. Rec: VALUE_ADJUSTMENT with reason LANDED_COST, allocated by value; the share already consumed goes to price variance (architecture §6). **Blocks M3.**

**Local dev DB:** migrated to 0021 and seeded. It has the `demo.<role>` users (password = `DEV_DEMO_PASSWORD` in `.env`) and FY 2026-27 periods OPEN. `demo.qa_manager` holds the QA countersign.
