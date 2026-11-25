# Progress

Current milestone: **M3 — Procurement** (M2 done, tag `m2`)

| Milestone | Status | Started | Finished | Notes |
| --- | --- | --- | --- | --- |
| M1 Foundation | Done | 17-11-2026 | 18-11-2026 | All 12 tasks, rules-review fixes A–F, first-QA-Manager bootstrap; CI run #13 green on `04ef009`; tag `m1` |
| M2 Masters & engines | Done | 18-11-2026 | 19-11-2026 | All 10 tasks; rules-review fixes (disposal witness 0020, deactivation guards 0021); owner answers 19-11 recorded; CI green; tag `m2` |
| M3 Procurement | In progress | 25-11-2026 | | Task 1 done (0022); tasks 2–6 open |
| M4 QC | Not started | | | |
| M5 Sales | Not started | | | |
| M6 Production | Not started | | | |
| M7 QA & Dispatch | Not started | | | |
| M8 Finance & FBR | Not started | | | |
| M9 Dashboard & traceability | Not started | | | |
| M10 Hardening & staging | Not started | | | |
| M11 UAT & go-live | Not started | | | |

## Handoff (25-11-2026, M3 in progress)

**State:** M3 started 25-11-2026. Plan approved by the owner with answers Q1–Q6 and extra changes (decisions.md rows dated 2026-11-25; build-plan M3 bullets carry them). We work on `main`, one commit per task, pushed. API tests need the Docker DB (`docker compose up -d`). 560 tests green (520 API, 24 web, 16 shared).

**M3 tasks** (chunks agreed with the owner: 1–2 in the first chat, 3–4 and 5–6 in new chats):
- [x] 1. Owner decisions from M2 (0022): periods close/reopen in order (`PERIOD_OUT_OF_ORDER`), reopen needs a Finance Manager e-signature (APPROVED); one user never holds an admin role and an action role (service + DB; dev DB checked: no violators); attachments void with reason (`POST /core/attachment-files/:id/void`, file kept, voided files do not count as evidence).
- [ ] 2. PR → PO with approval matrix, AVL block, daily rate table.
- [ ] 3. GRN to quarantine, labels, QC sample request stub.
- [ ] 4. Landed cost (incl. IMPORT_TAX event, advance tax account).
- [ ] 5. Vendor invoice (3-way match, MATCH_EXCEPTION, CHARGES type, FX), payment with WHT, vendor ledger, AP ageing.
- [ ] 6. Segregation sweep, end-to-end Done-when test, /check-rules, docs.

**Open questions for the owner** (agent defaults, decisions.md 2026-11-25, "PENDING OWNER"):
1. Who may void an attachment: the holder of the record type's write key (the key that uploads it)?
2. Inactive roles count for the admin/action rule (so reactivating a role cannot bypass it)?

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
