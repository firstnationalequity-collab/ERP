# Progress

Current milestone: **M3 — Procurement** (M2 done, tag `m2`)

| Milestone | Status | Started | Finished | Notes |
| --- | --- | --- | --- | --- |
| M1 Foundation | Done | 17-11-2026 | 18-11-2026 | All 12 tasks, rules-review fixes A–F, first-QA-Manager bootstrap; CI run #13 green on `04ef009`; tag `m1` |
| M2 Masters & engines | Done | 18-11-2026 | 19-11-2026 | All 10 tasks; rules-review fixes (disposal witness 0020, deactivation guards 0021); owner answers 19-11 recorded; CI green; tag `m2` |
| M3 Procurement | Tasks done; awaiting owner OK to tag | 25-11-2026 | | Tasks 1–6 done (0022–0033); CI run 45947146671 green on `24339ac`; not tagged |
| M4 QC | Not started | | | |
| M5 Sales | Not started | | | |
| M6 Production | Not started | | | |
| M7 QA & Dispatch | Not started | | | |
| M8 Finance & FBR | Not started | | | |
| M9 Dashboard & traceability | Not started | | | |
| M10 Hardening & staging | Not started | | | |
| M11 UAT & go-live | Not started | | | |

## Handoff (27-11-2026, M3 close-out done, CI green, waiting for the owner's go to tag `m3`)

**State:** We work on `main`, one commit per task, pushed. API tests need the Docker DB (`docker compose up -d`). 680 tests green locally (638 API, 26 web, 16 shared); `pnpm typecheck` clean. CI run 45947146671 green on `24339ac` (task 6; it covers 5c, whose own run was superseded). Do not tag `m3` until the owner says so.

**M3 tasks** (details: `docs/progress-log.md`; decisions.md rows 2026-11-25 to 2026-11-27):
- [x] 1–2d. M2 carry-in (0022); PR → PO, approval matrix, AVL block, rate table (0023); unit rates 6 dp (0024); owner answers (0025, 0026).
- [x] 3, 3b. GRN (0027, 0028): lots QUARANTINE / APPROVED (`qc_required`), RECEIPT + GRN_RECEIPT journal, QC sample request, over-receipt and shelf-life settings, labels, cancel / reverse.
- [x] 4, 4b, 4c. Landed cost (0029–0031): charge types, allocation bases, with-GRN and later bills, IMPORT_TAX, currency, corrections, PKR-only duty types.
- [x] 5, 5b. Vendor invoice (3-way match, MATCH_EXCEPTION release), CHARGES invoices, payments with WHT (filer / non-filer, base per code), ledger, ageing; invoice / payment reversal; debit notes (0031, 0032). Demo data command.
- [x] 5c. Owner answers 27-11 (0033): debit-note reversal (Finance Manager, e-sign REVERSED, `fin.debit_note.reverse`; a return reverses its movement with a QA witness while the lot is REJECTED, else LOT_RETURN_NOT_REVERSIBLE); unwinding order DN → invoice; PERIOD_CLOSED endpoint tests for the three reversals.
- [x] 6. Close-out: Done-when test, segregation sweep, /check-rules, docs.

**Done-when evidence (build-plan M3):**
- "PO → GRN → invoice → payment posts the GL exactly as §6": `__tests__/m3-done-when.test.ts` › "posts every journal of the chain…". Import USD PO → approve → GRN of a GMP API (approved source, lot QUARANTINE, sample OPEN) with duty + freight (capitalised) and import ST / IT → GOODS invoice at 282 (GRNI 280,000; price variance 2,820; exchange 2,000) → CHARGES invoices (customs 76,600; forwarder 14,000) → 3 payments (USD with 3,030 exchange loss; customs; forwarder with 4% WHT 560). Each of the 11 journals is checked line by line: the §6 roles of its event mapped to accounts through the posting rules, amounts, entry date, vendor dimension, balanced. `glEqualsLedger()` after each stage; GRNI, landed-cost clearing and AP net to zero; ledgers closed at 0.00; ageing empty.
- "Non-AVL vendor PO refused": same file (AVL_NOT_APPROVED, nothing saved) and `procurement.test.ts` (PO approval with a source blocked meanwhile, service + DB).
- Segregation sweep (same file, one describe): PO creator ≠ approver (created + submitted, and created only), PO creator ≠ GRN receiver, PO approver ≠ GRN receiver, payment creator ≠ approver, each with a person holding both roles; also in `grn.test.ts`, `procurement.test.ts`, `vendor-invoice.test.ts` (DB guards).
- /check-rules (since `m2`): no breach of rules 1–12 found. Routes all guarded; status changes only through `core/transition`; no float arithmetic on money / qty / rates (only day counts); each posting in one transaction through the engines; every refusal code thrown by the M3 services is asserted in a test. Nits reported to the owner (not changed): `core.users` read directly by `procurement.repo.ts` and `finance/rates.repo.ts` for display names; `permissions.ts` / `enums.ts` call the matrix "VENDOR_DEBIT_NOTE" (it is `DEBIT_NOTE`); `VendorInvoicesPage.tsx` compares `Number(l.qtyOver) > 0` for display.
- Docs: architecture §6 rows (debit note, return, payment WHT) and §7.5 (payments, reversals, debit notes) brought up to the code; roles.md, decisions.md, demo/M3.md (step 19 + refusals).

**Next (new chat):** owner decides on tagging `m3` and on the three check-rules nits; then `/milestone M4`.

**Open questions for the owner** (agent defaults in decisions.md):
1. Task 5 defaults (decisions.md 2026-11-26 "choices the owner did not state", items a–n; (g) and (n) superseded by 5b): release key and flow, tolerances 2% price / 0% qty, posting date = invoice date, GRNI / variance / exchange split, CHARGES rules, payment flow, auto PO close, series VI-/VP-. Recommendation: confirm as built. Does not block M4.
2. Lot number ML{YY}-{SEQ:5}: owner confirming with QA. Recommendation: keep (a series setting; changeable without code). Does not block M4.
3. A debit note whose return emptied the lot (RETURNED) cannot be reversed (LOT_RETURN_NOT_REVERSIBLE). If the vendor sends those goods back, how is it recorded? Recommendation: a new receipt (GRN) creating a new lot in QUARANTINE with QC sampling; a RETURNED lot never reopens (rule 1). Does not block M4.
4. Carry-over, not a question: the "sample already taken" GRN-reversal refusal becomes testable in M4 (sampling); add the test there.

**Rules the code already relies on (M3+):**
- A module posts stock in ONE `withTransaction`: `postMovement` then `postStockJournal`. Corrections: `reverseMovements` then `reverseStockJournal` (it compares the journal's INVENTORY lines, so a journal with `otherLines` is mirrored whole; pass `key` for an alternative reversal key). Transfers post no journal. Toll rows post nothing.
- Disposal (rule 1, `0020`): `verifyWitness(..., disposalSubject(type, lot, qty))` BEFORE the transaction; then `postMovement({ witness })`, `postStockJournal`, `closeDisposedLot` when the lot is empty. Reversing a disposal needs its own witness (`disposalSubject(..., true)`); a DESTROYED / RETURNED lot never moves again.
- Masters still in use cannot be deactivated (`0021`, IN_USE). An item becomes ACTIVE only while its UoM, category and tax code are active.
- The actor must hold the event's key (`JournalPostingKeys`; alternatives `JournalAlternativeKeys`; reversal keys `JournalReversalKeys` / `JournalReversalAlternativeKeys`).
- Payables: AP lines carry `vendorId` (also GRNI on receipts and WHT payable). Open = invoice total − POSTED payments − POSTED debit notes; as of a date: documents in force that day (`inForce`).
- Unwinding order: payment / debit note → invoice → GRN (each refuses IN_USE while the later document is in force).
- Never write `inv.stock_balances`. Lock lots and balances `FOR UPDATE` in the engine. Raw-SQL lot inserts need `source`. DISPATCH and SALES_RETURN need `customerId`.
- An FG lot is created only under `prod.output.verify`. DISPATCH needs `closeBatchCost` first and an ACTIVE customer.
- The DB refuses, at COMMIT, any empty lot that still holds value; the rounding sweep in `postStockJournal` handles this.
- Test DBs have no fiscal periods; tests that post must create them. `glEqualsLedger()` and the §6 role check `expectJournal()` are in `__tests__/m3-done-when.test.ts`.
- Roles: `pnpm db:seed` adds keys from `docs/roles.md` that roles are missing. If it stops with `RoleBundleDriftError`, ask the owner per key and never remove keys yourself.

**Local dev DB:** migrated to 0033 and seeded (FINANCE_MANAGER has `fin.debit_note.reverse`). `demo.<role>` users (password = `DEV_DEMO_PASSWORD` in `.env`), FY 2026-27 periods OPEN, `demo.qa_manager` holds the QA countersign. Demo data loaded 27-11 (`pnpm db:seed:demo-data`: PO-2627-00001 APPROVED, PO-2627-00002 waiting for demo.finance_manager).
