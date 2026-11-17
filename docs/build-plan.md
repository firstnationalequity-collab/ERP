# Build plan — Phase 1

The pace depends on how many hours go in each day. Estimates assume ~8 focused hours/day with the agent (~30 working days total); at 4 hours/day expect about two months. Finish a milestone's **Done when** before starting the next. Track progress in `docs/progress.md`.

How to run a milestone with the agent (VS Code):
1. Open a fresh agent chat.
2. Type `/milestone M<n>` (custom command in `.claude/commands/milestone.md`), or paste the milestone's **Prompt**.
3. Let it plan first, review the plan, then let it build task by task.
4. Run `/check-rules` before marking the milestone done.

---

## M1 — Foundation (est. 2 days)
Tasks:
- [ ] Docker Compose Postgres up; migrations run with `pnpm db:migrate`; seed with `pnpm db:seed`.
- [ ] Apply `0000_foundation.sql` (schemas, audit trigger, immutability trigger) — already in the starter.
- [ ] `core` tables: users, roles, permissions, role_permissions, user_roles, approval_rules, approvals, e_signatures, audit_log, number_series, fiscal_periods, attachments, settings.
- [ ] Auth: login, refresh (httpOnly cookie), logout, change password; argon2; lockout after 5 failures; 90-day expiry.
- [ ] RBAC middleware `requirePermission(key)`; seed roles from architecture §3 with permission bundles.
- [ ] `core/esign` (verify password, store meaning + reason) and `core/transition` (allowed-moves map + history).
- [ ] `core/numbering` (`nextDocNo(docType)` with row lock, per fiscal year).
- [ ] Approvals: rule lookup by doc type + amount, approval steps, "my approvals" inbox endpoint.
- [ ] Web: login page, app layout with permission-driven sidebar, users/roles admin, audit trail viewer.

Done when: login works; any change writes an `audit_log` row; a user without permission gets 403; e-signature with a wrong password is refused; `pnpm test` green.

Prompt:
> Read CLAUDE.md, docs/progress.md, docs/build-plan.md (M1) and docs/architecture.md §1–5. Plan M1 as a task list, wait for my OK, then build it task by task with tests.

## M2 — Masters and engines (est. 3 days)
Tasks:
- [ ] Masters: uoms, uom_conversions, item_categories, items, customers, customer_addresses, vendors, approved_sources, warehouses, locations, products, master_formulas (+ lines, versioned, QA approval), price_lists, tax_codes.
- [ ] Finance masters: accounts (seed a pharma chart of accounts), cost_centers, posting_rules, fiscal periods for FY2026-27 (Jul–Jun).
- [ ] `inv` tables: lots, lot_status_history, stock_movements (immutable), stock_balances (CHECK qty >= 0), stock_reservations.
- [ ] `engines/inventory`: `postMovement()`, `reserve()`, `fefoCandidates()`, moving-average cost update, toll stock at zero value.
- [ ] `engines/posting`: `postJournal()` (balanced, open period, posting_rules lookup), `reverse()`.
- [ ] Web: CRUD screens for all masters (shared DataTable / DocForm).

Done when: a test receipt posts a stock movement AND a balanced journal in one transaction; a forced error rolls back both; negative stock is refused by the DB.

## M3 — Procurement (est. 3 days)
- [ ] PR → PO (local/import, currency, exchange rate) with approval matrix; AVL block for GMP items.
- [ ] GRN by scan from PO → lots in QUARANTINE, labels (bwip-js), QC sample request auto-created.
- [ ] Landed cost entry + allocation (value/qty basis) into lot cost.
- [ ] Vendor invoice with 3-way match (tolerance settings); payment with WHT; vendor ledger and ageing.
- [ ] Segregation: PO creator ≠ approver ≠ GRN receiver; payment creator ≠ approver.

Done when: PO → GRN → invoice → payment posts the GL exactly as architecture §6; non-AVL vendor PO refused.

## M4 — QC (est. 2 days)
- [ ] Specs + tests (versioned, QC Manager approval); sample queue; result entry; review (reviewer ≠ analyst).
- [ ] Disposition: APPROVED / REJECTED with e-signature; writes assay/water to lot.
- [ ] Re-test as new row (original never edited); CoA PDF.
- [ ] Nightly pg-boss job: APPROVED → RETEST_DUE / EXPIRED.

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
- [ ] Stages in order with sign-off; IPC notes; output → FG lot in QUARANTINE; yield; resource hours.
- [ ] Batch close (Production Manager e-signature); conversion absorbed into WIP.

Done when: release blocked if any material is not approved; API quantity computed from assay 98.2% in a test.

## M7 — QA and Dispatch (est. 2 days)
- [ ] Deviations (raise, investigate, close); batch release checklist + e-signature; release refused with open deviation or FG not QC-approved.
- [ ] Delivery order from SO, FEFO pick by scan, gate pass, proof of delivery, returns to QUARANTINE.
- [ ] Dispatch posts stock out + COGS and creates the sales invoice draft.

Done when: unreleased FG cannot be picked; QA release blocked by an open deviation.

## M8 — Finance and FBR (est. 3 days)
- [ ] Sales invoice (own product / toll conversion), FBR submission service + retry job (sandbox), FBR number + QR on PDF.
- [ ] Receipts with WHT, allocations; journal vouchers; bank reconciliation.
- [ ] Batch cost (`batch_costs`), customer margin, period close.
- [ ] Reports: TB, P&L, balance sheet, AR/AP ageing, sales-tax register.

Done when: an invoice receives an FBR sandbox number; trial balance balances.

## M9 — CEO dashboard and traceability (est. 2 days)
- [ ] View-only dashboard (architecture §7.12); traceability screen forward/backward.

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
