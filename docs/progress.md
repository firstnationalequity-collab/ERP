# Progress

Current milestone: **M3 — Procurement** (M2 done, tag `m2`)

| Milestone | Status | Started | Finished | Notes |
| --- | --- | --- | --- | --- |
| M1 Foundation | Done | 17-11-2026 | 18-11-2026 | All 12 tasks, rules-review fixes A–F, first-QA-Manager bootstrap; CI run #13 green on `04ef009`; tag `m1` |
| M2 Masters & engines | Done | 18-11-2026 | 19-11-2026 | All 10 tasks; rules-review fixes (disposal witness 0020, deactivation guards 0021); owner answers 19-11 recorded; CI green; tag `m2` |
| M3 Procurement | In progress | 25-11-2026 | | Tasks 1–3 done (0022–0027); 4–6 open |
| M4 QC | Not started | | | |
| M5 Sales | Not started | | | |
| M6 Production | Not started | | | |
| M7 QA & Dispatch | Not started | | | |
| M8 Finance & FBR | Not started | | | |
| M9 Dashboard & traceability | Not started | | | |
| M10 Hardening & staging | Not started | | | |
| M11 UAT & go-live | Not started | | | |

## Handoff (25-11-2026, M3 in progress)

**State:** M3 started 25-11-2026. We work on `main`, one commit per task, pushed. API tests need the Docker DB (`docker compose up -d`). 610 tests green (568 API, 26 web, 16 shared). CLAUDE.md rules 1 and 10 reworded and workflow steps 7–10 added by the owner (25-11): commit + push per task, one or two tasks per chat, `docs/demo/M<n>.md` after screen tasks.

**M3 tasks** (details of done tasks: `docs/progress-log.md`, decisions.md rows dated 2026-11-25):
- [x] 1, 2, 2b, 2c, 2d. Owner decisions from M2 (0022); PR → PO with approval matrix, AVL block, rate table (0023); unit rates 6 decimals (0024); owner answers (0025); rules 1/10 + two-person GMP void (0026).
- [x] 3. GRN (0027): scan PO → DRAFT → post: lots in QUARANTINE (`ML26-00001`), RECEIPT at PO price × GRN-date rate, GRN_RECEIPT journal, QC sample request (stub `modules/qc`), PO PARTIALLY_RECEIVED / RECEIVED; tolerance `purch.grn.over_receipt_pct` (2) → OVER_RECEIPT; AVL source at posting; receiver ≠ PO creator / approver; labels PDF (pdfmake + bwip-js). Web: Procurement → Goods received (GRN). Demo: `docs/demo/M3.md`.
- [ ] 4. Landed cost (owner split 25-11): charge types (capitalise flag, own account), then extend GRN posting so known charges entered beforehand roll into the lot cost (DRAFT charges on the GRN, `purch.landed_cost.manage`; Q2); later bills → VALUE_ADJUSTMENT LANDED_COST; IMPORT_TAX event, advance tax account.
- [ ] 5. Vendor invoice (3-way match, MATCH_EXCEPTION, CHARGES type, FX), payment with WHT, vendor ledger, AP ageing; PO → CLOSED.
- [ ] 6. Segregation sweep, end-to-end Done-when test, /check-rules, docs.

**Next (new chat): task 4 landed cost, then stop.** GRN posting is `postGrn` in `modules/procurement/grns.service.ts`: one `postStockJournal` per GRN; the lot unit cost is set at `createLot`, so known charges must be allocated before `createLot` (or add a LANDED_COST value adjustment in the same transaction). Rule-10 mismatch to settle with the owner first (below).

**Open questions for the owner:**
1. Rule 10 now says exchange rates NUMERIC(18,6), but `fin.exchange_rates.rate`, `purch.purchase_orders.exchange_rate`, `core.approvals.exchange_rate` (and the shared `exchangeRate` Zod: 4 decimals; architecture §5/§7.5) are NUMERIC(9,4). Not changed. The new GRN column is (18,6). Widen the three to (18,6)?
2. Material lot number format `ML26-00001` (agent default).
3. GRN refuses expired / retest-due material and mfg after the GRN date (agent default).
4. SPARE / CONSUMABLE lots also go to QUARANTINE with a QC sample request (as architecture §4 says): keep, or let non-GMP items skip QC?
5. GRN reversal (wrong receipt, lot untouched) and cancelling a DRAFT GRN are not built: wanted?

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

**Local dev DB:** migrated to 0027 and seeded (series GRN and MATERIAL_LOT added; QA Manager holds `qa.attachment.countersign`). It has the `demo.<role>` users (password = `DEV_DEMO_PASSWORD` in `.env`) and FY 2026-27 periods OPEN. `demo.qa_manager` holds the QA countersign.
