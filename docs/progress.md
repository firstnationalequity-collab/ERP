# Progress

Current milestone: **M3 — Procurement** (M2 done, tag `m2`)

| Milestone | Status | Started | Finished | Notes |
| --- | --- | --- | --- | --- |
| M1 Foundation | Done | 17-11-2026 | 18-11-2026 | All 12 tasks, rules-review fixes A–F, first-QA-Manager bootstrap; CI run #13 green on `04ef009`; tag `m1` |
| M2 Masters & engines | Done | 18-11-2026 | 19-11-2026 | All 10 tasks; rules-review fixes (disposal witness 0020, deactivation guards 0021); owner answers 19-11 recorded; CI green; tag `m2` |
| M3 Procurement | In progress | 25-11-2026 | | Tasks 1–4b + owner answers done (0022–0030); 5–6 open |
| M4 QC | Not started | | | |
| M5 Sales | Not started | | | |
| M6 Production | Not started | | | |
| M7 QA & Dispatch | Not started | | | |
| M8 Finance & FBR | Not started | | | |
| M9 Dashboard & traceability | Not started | | | |
| M10 Hardening & staging | Not started | | | |
| M11 UAT & go-live | Not started | | | |

## Handoff (26-11-2026, M3 in progress)

**State:** M3 started 25-11-2026. We work on `main`, one commit per task, pushed. API tests need the Docker DB (`docker compose up -d`). 642 tests green (600 API, 26 web, 16 shared). CLAUDE.md rules 1 and 10 reworded and workflow steps 7–10 added by the owner (25-11): commit + push per task, one or two tasks per chat, `docs/demo/M<n>.md` after screen tasks.

**M3 tasks** (details of done tasks: `docs/progress-log.md`, decisions.md rows dated 2026-11-25):
- [x] 1, 2, 2b, 2c, 2d. Owner decisions from M2 (0022); PR → PO with approval matrix, AVL block, rate table (0023); unit rates 6 decimals (0024); owner answers (0025); rules 1/10 + two-person GMP void (0026).
- [x] 3. GRN (0027): scan PO → DRAFT → post: lots in QUARANTINE (`ML26-00001`), RECEIPT at PO price × GRN-date rate, GRN_RECEIPT journal, QC sample request (stub `modules/qc`), PO PARTIALLY_RECEIVED / RECEIVED; tolerance `purch.grn.over_receipt_pct` (2) → OVER_RECEIPT; AVL source at posting; receiver ≠ PO creator / approver; labels PDF (pdfmake + bwip-js). Web: Procurement → Goods received (GRN). Demo: `docs/demo/M3.md`.
- [x] 3b. Owner answers to task 3 (0028): exchange rates NUMERIC(18,6); lot no. default kept (QA to confirm); GRN shelf-life setting `purch.grn.min_shelf_life_pct`; item `qc_required` (non-QC GRN lots APPROVED, no sample; change needs QA countersign); GRN cancel (DRAFT) and reverse (`purch.grn.reverse`, Warehouse Manager, e-sign, lots untouched else GRN_LOTS_IN_USE).
- [x] 4. Landed cost (0029): charge types (Finance, `fin.master.manage`; 8 seeded); charges on a GRN (`purch.landed_cost.manage`, PKR, basis VALUE / WEIGHT / GD_AMOUNTS). On a DRAFT GRN they post inside `postGrn` (LANDED_COST value adjustment per lot, under `purch.grn.post`); later bills post on their date (held share → lot, consumed → price variance). IMPORT_TAX event, ADVANCE_TAX role, account 1240. GRN with a posted charge → GRN_HAS_LANDED_COST. Web: Procurement → Landed costs + section in the GRN drawer.
- [x] 4b. Owner answers (0030): GRN reversal signs meaning REVERSED; charge currency (foreign amount × charge-date rate, refreshed at posting); correction charges (negative, linked, split held / variance at its date; Purchase Officer enters `/correct`, Finance Manager posts `/approve` with e-signature, new key `purch.landed_cost.correct`, creator ≠ signer, CORRECTION_EXCEEDS_CHARGE); GRN reversal undoes posted charges (REVERSED) — GRN_HAS_LANDED_COST removed. Web: currency on the charge form, Correct / Approve and post in the charge drawer.
- [ ] 5. Vendor invoice (3-way match, MATCH_EXCEPTION, CHARGES type, FX), payment with WHT, vendor ledger, AP ageing; PO → CLOSED.
- [ ] 6. Segregation sweep, end-to-end Done-when test, /check-rules, docs.

**Next (new chat): task 5 vendor invoice.** Its CHARGES type settles clearing 2130 (owner Q3); posted landed costs carry the billing vendor on the clearing line (`purch.landed_costs.vendor_id`), and now a currency + foreign amount (match the invoice in that currency); a correction posts the opposite clearing line.

**Open questions for the owner** (agent defaults in decisions.md, 2026-11-25):
1. Task 4b defaults (decisions.md, task-4b "Choices the owner did not state" row): (a) key `purch.landed_cost.correct`, Finance Manager only; Purchase Officer enters, Finance Manager posts; (b) a correction is split in proportion to the original's allocation per GRN line; (c) it keeps the original's GRN / type / currency / basis / vendor, cannot be edited, cannot correct a correction, and corrections together may not exceed the original; (d) the rate is looked up again at posting; (e) GD amounts in the charge currency. OK?
3. Lot number ML{YY}-{SEQ:5}: owner confirming with QA.
4. Not testable yet: the "sample already taken" refusal (sample requests have only OPEN/CANCELLED until M4 adds sampling; the code and SQL refuse any other status).

**Rules the code already relies on (M3+):**
- A module posts stock in ONE `withTransaction`: `postMovement` (engines/inventory) then `postStockJournal` (engines/posting). Corrections: `reverseMovements` then `reverseStockJournal`. Transfers post no journal. Toll rows post nothing.
- Disposal (rule 1, `0020`): `verifyWitness(..., disposalSubject(type, lot, qty))` BEFORE the transaction; then in one transaction `postMovement({ witness })`, `postStockJournal`, and `closeDisposedLot` when the lot is empty. A reversal of a disposal needs its own witness (`disposalSubject(..., true)`).
- Masters still in use cannot be deactivated (`0021`, IN_USE). An item becomes ACTIVE only while its UoM, category and tax code are active.
- The actor must hold the event's key (`JournalPostingKeys`); a caller may name one of `JournalAlternativeKeys` (GRN posting posts LANDED_COST / IMPORT_TAX). Invoice, payment, conversion have no key yet; their module adds one.
- Never write `inv.stock_balances` (the ledger trigger keeps it). Lock lots and balances `FOR UPDATE` in the engine. Raw-SQL lot inserts need `source`. DISPATCH and SALES_RETURN need `customerId`.
- An FG lot is created only under `prod.output.verify` (QA-controlled since Q17). DISPATCH needs `closeBatchCost` first and an ACTIVE customer.
- The DB refuses, at COMMIT, any empty lot that still holds value; the rounding sweep in `postStockJournal` handles this.
- Test DBs have no fiscal periods; tests that post must create them. Reusable check: `glEqualsLedger()` in `posting-engine.test.ts`.
- Landed cost: `modules/procurement/landed-costs.service.ts`. LANDED_COST value adjustments only on GRN lots for a LANDED_COST document; `postStockJournal({ otherLines })` adds balanced non-inventory lines (price variance).
- Roles: `pnpm db:seed` adds keys from `docs/roles.md` that roles are missing. If it stops with `RoleBundleDriftError`, ask the owner per key and never remove keys yourself.

**Local dev DB:** migrated to 0029 and seeded (series LANDED_COST, account 1240, the 8 charge types). It has the `demo.<role>` users (password = `DEV_DEMO_PASSWORD` in `.env`) and FY 2026-27 periods OPEN. `demo.qa_manager` holds the QA countersign.
