# Build plan — Phase 1

The pace depends on how many hours go in each day. Estimates assume ~8 focused hours/day with the agent (~32 working days total); at 4 hours/day expect about two months. Finish a milestone's **Done when** before starting the next. Track progress in `docs/progress.md`.

How to run a milestone with the agent (VS Code):
1. Open a fresh agent chat.
2. Type `/milestone M<n>` (custom command in `.claude/commands/milestone.md`), or paste the milestone's **Prompt**.
3. Let it plan first, review the plan, then let it build task by task.
4. Run `/check-rules` before marking the milestone done.

---

## M1 — Foundation (est. 4 days)
Tasks:
- [x] Docker Compose Postgres up; migrations run with `pnpm db:migrate`; seed with `pnpm db:seed`. Node 26 pinned (`.nvmrc`, `engines`).
- [x] Apply `0000_foundation.sql` (schemas, audit trigger, immutability trigger) — already in the starter.
- [x] `core` tables: companies, users, user_credentials (no audit trigger), sessions, auth_events (insert-only), roles, permissions, role_permissions, user_roles, approval_rules, approvals, e_signatures, status_history (insert-only), idempotency_keys, audit_log, number_series, fiscal_periods, attachments, settings.
- [x] Auth: login by username, refresh (httpOnly cookie, 12 h, rotate on use, reuse revokes session), logout, change password; argon2; complexity + last-5 reuse block; lockout after 5 failures until admin unlock; 90-day expiry and forced first-login change; auth_events for every event.
- [x] RBAC middleware `requirePermission(key)`; permission keys classed admin/view/action; seed roles from `docs/roles.md` (after review) plus the SYSTEM user and the first admin (`INITIAL_ADMIN_PASSWORD`).
- [x] Role administration guards: no self role changes; admin roles hold no action keys; qc.* / qa.* role changes need a QA Manager e-signature.
- [x] `core/esign` (verify password, store meaning + reason; wrong password counts toward lockout) and `core/transition` (allowed-moves map with a permission key per move + `core.status_history`).
- [x] `core/numbering` (`nextDocNo(docType)` with row lock; pattern tokens and FISCAL_YEAR / CALENDAR_YEAR / NEVER reset).
- [x] Approvals: rule lookup by doc type + measure (AMOUNT_PKR / PERCENT), sequential and parallel steps routed to roles (creator excluded), "my approvals" inbox endpoint.
- [x] `core/idempotency` (24 h keys, `DUPLICATE_REQUEST` on a different request) and attachments (storage interface, local-disk driver).
- [x] Fiscal periods: create, close and reopen (endpoints and service).
- [x] CI: GitHub Actions — install, typecheck, test with a Postgres 16 service container.
- [x] Web: login page, change password, 30-min idle logout, app layout with permission-driven sidebar, users (incl. unlock) and roles admin, approval rules, number series, fiscal periods, audit trail viewer, my approvals inbox, e-signature dialog.

Done when: login works; any change writes an `audit_log` row; `audit_log` never contains a password hash; a user without permission gets 403; e-signature with a wrong password is refused; `pnpm test` green locally and in CI.

Prompt:
> Read CLAUDE.md, docs/progress.md, docs/build-plan.md (M1) and docs/architecture.md §1–5. Plan M1 as a task list, wait for my OK, then build it task by task with tests.

## M2 — Masters and engines (est. 3 days)
Tasks:
- [x] Masters: uoms, uom_conversions, item_categories, items, customers, customer_addresses, vendors, approved_sources, warehouses, locations, products, master_formulas (+ lines, versioned, QA approval), price_lists, tax_codes.
- [x] Finance masters: accounts (seed a pharma chart of accounts), cost_centers, posting_rules, fiscal periods for FY2026-27 (Jul–Jun). (PLACEHOLDER chart, rules and tax codes seeded; FY2026-27 is created on the Fiscal periods page by the Finance Manager — decisions 18-11-2026.)
- [x] `inv` tables: lots (status history in `core.status_history`), stock_movements (immutable), stock_balances (CHECK qty >= 0), stock_reservations. (`0014_inventory.sql`, decisions 18-11-2026 M2 task 5.)
- [x] `engines/inventory`: `postMovement()`, `reserve()`, `fefoCandidates()`, lot-actual cost (no moving average; GL inventory = Σ ledger movement values, rounding per decisions 2026-11-18), toll stock at zero value. (`apps/api/src/engines/inventory`, `0015_movement_valuation.sql`.)
- [x] `engines/posting`: `postJournal()` (balanced, open period, posting_rules lookup), `reverse()`. (`apps/api/src/engines/posting`, rounding sweep `0016`; value-only adjustment and customer-return posting `0017`, owner 2026-11-18.)
- [x] Web: CRUD screens for all masters (shared DataTable / DocForm). (Task 9: masters, AVL with evidence, formula versions + lines, price lists, finance masters, journals; approvals show the AVL source / formula and attachments.)

Done when: a test receipt posts a stock movement AND a balanced journal in one transaction; a forced error rolls back both; negative stock is refused by the DB. (Test: `apps/api/src/__tests__/m2-done-when.test.ts`, also toll = no journal and GL inventory = Σ ledger values after every movement type.)

## M3 — Procurement (est. 3 days)
- [ ] Owner decisions 2026-11-19 carried in from M2 (small changes to M1 core): period reopen needs a Finance Manager e-signature + reason, and periods close/reopen in order (Q2, Q3); one user may not hold both an admin role and an action role (Q4); attachments "void with reason", file kept (Q5).
- [ ] PR → PO (local/import, currency, exchange rate) with approval matrix; AVL block for GMP items.
- [ ] GRN by scan from PO → lots in QUARANTINE, labels (bwip-js), QC sample request auto-created.
- [ ] Landed cost (owner Q21, architecture §6 "Landed cost"): charge types with a capitalise flag and their own account (duties, freight, insurance, clearing capitalised; import sales tax → input tax, income tax at import → advance tax); allocation per charge type (duties by GRN line from GD amounts, else by value; freight/other by value or weight); known charges entered with the GRN (lot received at full cost); later bills → VALUE_ADJUSTMENT reason LANDED_COST for the share still held, consumed share (or all, if fully consumed) → price variance (placeholder); posting date = charge date, open period. Tests for each, incl. a partly and a fully consumed lot.
- [ ] Vendor invoice with 3-way match (tolerance settings); payment with WHT; vendor ledger and ageing.
- [ ] Segregation: PO creator ≠ approver ≠ GRN receiver; payment creator ≠ approver.

Done when: PO → GRN → invoice → payment posts the GL exactly as architecture §6; non-AVL vendor PO refused.

## M4 — QC (est. 2 days)
- [ ] Specs + tests (versioned, QC Manager approval); sample queue; result entry; review (reviewer ≠ analyst).
- [ ] Disposition: APPROVED / REJECTED with e-signature; writes assay/water to lot.
- [ ] Re-test as new row (original never edited); CoA PDF.
- [ ] Nightly pg-boss job: APPROVED → RETEST_DUE / EXPIRED.
- [ ] FG lot failing QC (owner 2026-11-18, architecture §4): recording a failed result on an FG lot moves it UNDER_TEST → HOLD automatically under `qc.result.enter`; QC never rejects an FG lot (`qc.lot.change_status` refuses FG lots). Tests: failed FG result → HOLD; QC Manager rejecting an FG lot refused.

Done when: a quarantined lot becomes issuable only after QC approval; a rejected lot cannot move except destroy/return.

## M5 — Sales (est. 2 days)
- [ ] Customers (NTN/STRN/CNIC, credit limit, terms), price lists.
- [ ] Quotation with cost sheet (RM/PM, conversion, overhead, margin per 1,000), discount approval, versioning.
- [ ] Sales order with credit check (open AR + unbilled orders + this order); credit-hold queue for Finance Manager.
- [ ] Quality-agreement block on contract products.

Done when: an over-limit order waits on ON_CREDIT_HOLD until the Finance Manager approves.

## M6 — Production (est. 3 days)
- [ ] Production order (batch number series), release check (approved formula, approved stock, reservation).
- [ ] Material requirement with potency adjustment + filler compensation (architecture §6).
- [ ] Issue by scan (APPROVED lots only, FEFO), returns from floor.
- [ ] Stages in order with sign-off; IPC notes; yield; resource hours. Output/yield has a doer and a checker (owner 2026-11-18, Option A; architecture §4): the doer records output/yield and signs (`prod.stage.sign`, e-signature) — record status SIGNED, nothing created; a different user holding `prod.output.verify` (Production Supervisor; two Supervisors may be doer and checker) verifies with e-signature — same user → 403 `SEGREGATION_OF_DUTIES` — and that transaction creates the FG lot in QUARANTINE at the provisional value of the materials issued so far (Q8) and posts FG_OUTPUT. Key, role grant, engine keys and the "Operator never holds `prod.output.verify`" test built in M2. Tests: doer = checker refused; Operator cannot verify; signing alone creates no lot.
- [ ] Checker steps (owner Q18, 2026-11-19), starting list: weighing/dispensing of every material, line clearance, yield. Confirm with the Production Manager and QA at M6 start (line clearance may be IPQA, not a supervisor).
- [ ] Conversion cost when the whole FG lot left before batch close (`closeBatchCost` refuses with `LOT_EMPTY`): post it to a production-variance expense account (owner Q11, 2026-11-19; placeholder, Finance to confirm).
- [ ] Batch close (Production Manager e-signature): conversion absorbed into WIP (CONVERSION_ABSORB journal under `prod.batch.approve_close`, owner Q13), and in the same transaction `closeBatchCost` adds conversion + true-up to the FG lot as a value-only adjustment (Dr FG inventory / Cr WIP) and marks the batch closed; the FG lot cannot be dispatched before that (engines built in M2).

Done when: release blocked if any material is not approved; API quantity computed from assay 98.2% in a test.

## M7 — QA and Dispatch (est. 2 days)
- [ ] Deviations (raise, investigate, close); batch release checklist + e-signature; release refused with open deviation or FG not QC-approved.
- [ ] Delivery order from SO, FEFO pick by scan, gate pass, proof of delivery, customer returns into a new HOLD return lot `<lot>-R<n>` at a returns area (`createReturnLot` + SALES_RETURN, posting built in M2; owner 2026-11-18, Q9); every dispatch and return names the customer, and a return never exceeds what went to that customer (built in M2, 0018); QA moves return lots on.
- [ ] Lot decisions by QA (owner 2026-11-18, rule 1 clarification; keys and role segregation tests built in M2): return lot HOLD → RELEASED (`qa.batch.release`, e-signature, mandatory assessment reason); FG / return lot HOLD → REJECTED (`qa.lot.reject_fg`, QA Manager, e-signature); material lot HOLD → REJECTED stays `qc.lot.change_status`. The lot transition map refuses each key on the other kind of lot; HTTP tests for each move and each refusal (QC Manager rejecting an FG lot, QA rejecting a material lot, re-release without reason).
- [ ] FG lot after a failed QC result (owner 2026-11-18, architecture §4/§7.8): QA rejects it (HOLD → REJECTED, `qa.lot.reject_fg`) after the OOS investigation; QA release is refused while a failed result is open, unless the investigation closes it as invalid and a retest passes. Tests for each.
- [ ] Dispatch posts stock out + COGS and creates the sales invoice draft; dispatch only to an ACTIVE customer (engine + DB built in M2, 0019).

Done when: unreleased FG cannot be picked; QA release blocked by an open deviation.

## M8 — Finance and FBR (est. 3 days)
- [ ] Sales invoice (own product / toll conversion), FBR submission service + retry job (sandbox), FBR number + QR on PDF.
- [ ] Receipts with WHT, allocations; journal vouchers; bank reconciliation.
- [ ] Batch cost (`batch_costs`), customer margin, period close.
- [ ] Reports: TB, P&L, balance sheet, AR/AP ageing, sales-tax register.

Done when: an invoice receives an FBR sandbox number; trial balance balances.

## M9 — CEO dashboard and traceability (est. 2 days)
- [ ] View-only dashboard (architecture §7.12); traceability screen forward/backward.
- [ ] Dashboard shows reopened fiscal periods (who, when, why) (owner Q2, 2026-11-19).

Done when: dashboard figures reconcile with the ledgers; trace returns in under 5 s.

## M10 — Hardening and staging (est. 3 days)
- [ ] Security review (auth, permissions on every route, rate limit, headers), backups + tested restore, Dockerfiles, staging deploy, Sentry.

Done when: restore from backup tested; staging identical to production setup.

## M11 — UAT and go-live (est. 5 days)
- [ ] Excel import templates + importers for masters and opening stock by lot/status, opening balances (AR, AP, GL).
- [ ] UAT scripts for each department; Playwright acceptance tests (below); parallel run.

### Acceptance tests
- [ ] Imported API lot, assay 98.2% → sample → approve → potency-adjusted dispense, filler reduced.
- [ ] Issue from QUARANTINE refused (`LOT_NOT_APPROVED`).
- [ ] Customer-supplied API at zero value consumed in a contract batch; no GL entry for it.
- [ ] Full batch with out-of-limit yield → deviation → QA release blocked until closed.
- [ ] Dispatch released batch → FBR sandbox invoice number printed.
- [ ] Trace a raw-material lot forward to customers and back.
- [ ] Batch actual cost vs quotation; customer margin.
- [ ] QC re-test shows full audit trail (old/new values).
- [ ] PO creator cannot approve own PO.
- [ ] Posting into a closed period refused.
