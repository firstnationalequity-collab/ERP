# Progress

Current milestone: **M3 — Procurement** (M2 done, tag `m2`)

| Milestone | Status | Started | Finished | Notes |
| --- | --- | --- | --- | --- |
| M1 Foundation | Done | 17-11-2026 | 18-11-2026 | All 12 tasks, rules-review fixes A–F, first-QA-Manager bootstrap; CI run #13 green on `04ef009`; tag `m1` |
| M2 Masters & engines | Done | 18-11-2026 | 19-11-2026 | All 10 tasks; rules-review fixes (disposal witness 0020, deactivation guards 0021); owner answers 19-11 recorded; CI green; tag `m2` |
| M3 Procurement | In progress | 25-11-2026 | | Tasks 1–2b done (0022–0024); 2c, 3–6 open |
| M4 QC | Not started | | | |
| M5 Sales | Not started | | | |
| M6 Production | Not started | | | |
| M7 QA & Dispatch | Not started | | | |
| M8 Finance & FBR | Not started | | | |
| M9 Dashboard & traceability | Not started | | | |
| M10 Hardening & staging | Not started | | | |
| M11 UAT & go-live | Not started | | | |

## Handoff (25-11-2026, M3 in progress)

**State:** M3 started 25-11-2026. Plan approved by the owner with answers Q1–Q6 and extra changes (decisions.md rows dated 2026-11-25; build-plan M3 bullets carry them). We work on `main`, one commit per task, pushed. API tests need the Docker DB (`docker compose up -d`). 586 tests green (544 API, 26 web, 16 shared). Owner answered the six task-1/2 questions on 25-11 (decisions.md rows "M3 owner answers 1–6").

**M3 tasks** (chunks agreed with the owner: 1–2 in the first chat; 2b, 2c, 3 in the second; 4, then 5–6 in new chats):
- [x] 1. Owner decisions from M2 (0022): periods close/reopen in order (`PERIOD_OUT_OF_ORDER`), reopen needs a Finance Manager e-signature (APPROVED); one user never holds an admin role and an action role (service + DB; dev DB checked: no violators); attachments void with reason (`POST /core/attachment-files/:id/void`, file kept, voided files do not count as evidence).
- [x] 2. PR → PO (0023): requisitions (no approval), POs local/import with approval matrix (`PO` doc type, PKR value at Finance’s rate on the PO date), AVL block (service + DB on submit and approve), creator/submitter approve no step (new `assertMayApprove` hook in the approvals engine), cancel before receipt; daily rate table `fin.exchange_rates` (`fin.rate.manage`, `rateOn()` for other modules, RATE_MISSING); web: Requisitions, Purchase orders, Exchange rates.
- [x] 2b. Unit rates 6 decimals (owner answer 5; 0024): lot/movement unit cost, PO and price-list unit price NUMERIC(18,6); amounts stay 2 decimals; derived unit costs (FG output, value adjustment) round to 6 in engine + DB guards; CLAUDE.md rule 10; shared `unitRate`, web `formatRate`; 0.035 PKR label tests (valuation, engine + DB guard, PO).
- [ ] 2c. Owner answers 1, 3, 4, 6: GMP attachment void needs a QA Manager e-signature; rate = latest on/before date within `fin.rate.max_age_days` (3); PO cancel frees requisition lines; setting `purch.allow_bulk_fg_purchase` (false).
- [ ] 3. GRN to quarantine, labels, QC sample request stub.
- [ ] 4. Landed cost (incl. IMPORT_TAX event, advance tax account).
- [ ] 5. Vendor invoice (3-way match, MATCH_EXCEPTION, CHARGES type, FX), payment with WHT, vendor ledger, AP ageing.
- [ ] 6. Segregation sweep, end-to-end Done-when test, /check-rules, docs.

**Next: task 2c, then task 3** (stop after 3; task 4 in a new chat). Task 3 adds the receipt moves to `PurchaseOrderMoves` (APPROVED → PARTIALLY_RECEIVED → RECEIVED, CLOSED) under `purch.grn.post`; GRN updates `po_lines.received_qty` (0023 already allows only that column after DRAFT). GRN converts at `rateOn(…, grnDate)` (latest rate within max age after 2c); AVL check at posting is per item + vendor + manufacturer (`purch-refs.service` needs a manufacturer variant).

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

**Local dev DB:** migrated to 0024 and seeded. It has the `demo.<role>` users (password = `DEV_DEMO_PASSWORD` in `.env`) and FY 2026-27 periods OPEN. `demo.qa_manager` holds the QA countersign.
