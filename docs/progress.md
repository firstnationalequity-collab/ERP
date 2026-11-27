# Progress

Current milestone: **M4 — QC** (in progress; M3 done, tag `m3`)

| Milestone | Status | Started | Finished | Notes |
| --- | --- | --- | --- | --- |
| M1 Foundation | Done | 17-11-2026 | 18-11-2026 | All 12 tasks, rules-review fixes A–F, first-QA-Manager bootstrap; CI run #13 green on `04ef009`; tag `m1` |
| M2 Masters & engines | Done | 18-11-2026 | 19-11-2026 | All 10 tasks; rules-review fixes (disposal witness 0020, deactivation guards 0021); owner answers 19-11 recorded; CI green; tag `m2` |
| M3 Procurement | Done | 25-11-2026 | 27-11-2026 | Tasks 1–6 + owner answers (0022–0033); check-rules fixes; CI run 45948188562 green on `900b052`; tag `m3` |
| M4 QC | In progress | 27-11-2026 | | Tasks 1–2 done (0034–0036), owner corrections in |
| M5 Sales | Not started | | | |
| M6 Production | Not started | | | |
| M7 QA & Dispatch | Not started | | | |
| M8 Finance & FBR | Not started | | | |
| M9 Dashboard & traceability | Not started | | | |
| M10 Hardening & staging | Not started | | | |
| M11 UAT & go-live | Not started | | | |

## Handoff (27-11-2026, M4 in progress: tasks 1–2 done)

**State:** We work on `main`, one commit per task, pushed. API tests need the Docker DB (`docker compose up -d`). `pnpm typecheck` clean; 732 tests green after task 2 (677 API, 28 web, 27 shared). M3 is tagged `m3` (details in `docs/progress-log.md`).
**Working rule (owner 27-11, CLAUDE.md 11–12):** don't wait for answers; build the recommended answer, add a line to `docs/verification-list.md` and a PENDING OWNER row in decisions.md; stop only for a rule change, a hard-to-migrate structure change, or a failure you cannot fix.

**M4 plan** (build-plan M4; decisions.md 2026-11-27 rows):
- [x] 1. Specs (0034): `qc.specs` / `qc.spec_tests`, DRAFT → PENDING_APPROVAL → APPROVED (QC Manager e-sign) → OBSOLETE; approver ≠ drafter / submitter (service + DB); `/api/v1/qc/specs`; web QC → Specifications; `specs.test.ts`. `approvedSpec()` exported for sampling.
- [x] 2. Sample queue, results, review (0036) + owner corrections 27-11 (0035): sampling posts SAMPLE_ISSUE (TEST / RETENTION) with a QC_SAMPLE journal (6400 placeholder), lot → UNDER_TEST, spec pinned; expiry / retest checked at issue, reserve and dispatch (LOT_EXPIRED / LOT_RETEST_DUE, service + DB); `qc.results` / `qc.result_reviews` insert-only; reviewer ≠ analyst, REVIEWED e-sign per sample; failed FG result → HOLD. `/api/v1/qc/samples`; web Sample queue, Results review; `samples.test.ts`, engine tests, M2 GL = ledger walk covers SAMPLE_ISSUE.
- [ ] 3. Disposition (reads results via `qc.results` + reviews; request SAMPLED → a closing status to add): APPROVED / REJECTED with e-sign (`qc.lot.change_status`); approve needs the latest reviewed result of every test passing; writes assay / water to the lot; FG lots refused (QA decides); HOLD → REJECTED material lots only. Page: Lot disposition.
- [ ] 4. Re-test as new row (`retest_of`, reason; original never edited, DB) and CoA PDF (pdfmake, `qc.coa.issue`, stored attachment with sha256, `qc.coas`, series COA-{FY}-{SEQ:5}).
- [ ] 5. Nightly pg-boss job (statuses only; use-time expiry checks already in 0035; new `jobs/` runner started in server.ts, 00:30 Asia/Karachi, SYSTEM): APPROVED → EXPIRED (expiry reached) / RETEST_DUE (retest reached, opens a RETEST sample request); RETEST_DUE → EXPIRED when expiry reached.
- [ ] 6. Close-out: Done-when test (quarantined lot issuable only after QC approval; rejected lot moves only by destroy / return), carried-over test "GRN reversal refused once a sample is taken", /check-rules, demo/M4.md, docs.

**Next (new chat):** M4 task 3 (disposition).

**Open questions for the owner:** see `docs/verification-list.md` (QC section has the M4 defaults; standing go-live items under Finance / QA / Management).

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

**Local dev DB:** migrated to 0036 and seeded (6400 + QC_SAMPLE rules added) (FINANCE_MANAGER has `fin.debit_note.reverse`). `demo.<role>` users (password = `DEV_DEMO_PASSWORD` in `.env`), FY 2026-27 periods OPEN, `demo.qa_manager` holds the QA countersign. Demo data loaded 27-11 (`pnpm db:seed:demo-data`: PO-2627-00001 APPROVED, PO-2627-00002 waiting for demo.finance_manager).
