# Roles and permissions — Phase 1

**Status: approved by the owner on 2026-11-17 (Review points below), with the later owner corrections listed there. `pnpm db:seed` syncs role bundles from this file (adds missing keys, never removes; decisions 2026-11-18).**

Source of truth for keys: `packages/shared/src/permissions.ts` (updated from this table in M1).
Design context: `docs/architecture.md` §3 and §4.

## Key classes

| Class | Meaning | Guard |
| --- | --- | --- |
| admin | Manage users, roles, settings | A role holding any admin key may hold only admin and view keys (never an action key); and a user holding such a role holds no role with an action key (owner 2026-11-19, Q4; 0022) |
| view | Read-only access to a module | CEO holds every view key and nothing else |
| action | Creates, changes, approves or posts business data | Never on an admin role. Changes to a role holding a QA-controlled key (`qaControlled` in `permissions.ts`: every `qc.*` / `qa.*` action key, `master.avl.approve`, `master.formula.approve`, `master.item.approve` and any future key that approves a GMP record) need a QA Manager e-signature |

## Key catalogue

"New" = added by the M1 Q&A (decisions log, Q14). "Accepted" = proposed by the agent for a decided rule, then accepted by the owner (2026-11-17).

| Key | Class | Description | Status |
| --- | --- | --- | --- |
| `core.user.manage` | admin | Create, change, deactivate, unlock users; assign roles | existing |
| `core.role.manage` | admin | Manage roles and permission bundles | existing |
| `core.settings.manage` | admin | Number series, approval rules, settings | existing |
| `core.audit.view` | view | View audit trail | existing |
| `core.approval.inbox` | view | See "my approvals" inbox (acting still needs the document's approve key) | new |
| `core.period.manage` | action | Create fiscal years and periods | new |
| `core.period.close` | action | Close and reopen fiscal periods | existing |
| `master.view` | view | View all masters | new |
| `master.item.manage` | action | Items (draft; activates non-GMP items), categories, UoM | existing |
| `master.item.approve` | action | Activate, deactivate and countersign GMP items (types RM, PM, API, EXCIPIENT, BULK, FG) | new (M2) |
| `master.customer.manage` | action | Create/edit customers (draft) | existing |
| `master.customer.approve` | action | Activate customers | existing |
| `master.vendor.manage` | action | Create/edit vendors (draft) | existing |
| `master.vendor.approve` | action | Activate vendors | existing |
| `master.avl.approve` | action | Add/block approved sources (QA) | existing |
| `master.formula.manage` | action | Draft master formulas | existing |
| `master.formula.approve` | action | Approve master formula versions (QA) | existing |
| `master.location.manage` | action | Warehouses and locations | existing |
| `master.product.manage` | action | Products; registration no., artwork version and quality-agreement date changes need a QA Manager countersign | new (M2) |
| `master.price.manage` | action | Price lists | new (M2) |
| `inv.stock.view` | view | View stock, lots, movements (inventory module view key) | existing |
| `inv.movement.post` | action | Put-away, transfers, issues | existing |
| `inv.adjustment.request` | action | Request stock adjustments | existing |
| `inv.adjustment.approve` | action | Approve stock adjustments | existing |
| `inv.label.print` | action | Print labels | existing |
| `inv.lot.dispose` | action | Move a REJECTED lot to DESTROYED / RETURNED (needs QA witness) | accepted (owner 2026-11-17) |
| `sales.view` | view | View quotations, orders, customer ledger | new |
| `sales.quotation.manage` | action | Create/edit quotations | existing |
| `sales.quotation.approve` | action | Approve quotations and discounts | existing |
| `sales.order.manage` | action | Create/confirm sales orders, delivery requests | existing |
| `sales.order.credit_override` | action | Release orders on credit hold | existing |
| `purch.view` | view | View PRs, POs, GRNs, vendor ledger | new |
| `purch.pr.manage` | action | Create purchase requisitions | existing |
| `purch.po.manage` | action | Create/edit purchase orders | existing |
| `purch.po.approve` | action | Approve purchase orders | existing |
| `purch.grn.post` | action | Post goods receipts | existing |
| `purch.grn.reverse` | action | Reverse a posted GRN whose lots are untouched (e-signature + reason) | new (owner 2026-11-25, answer 5; Warehouse Manager only) |
| `purch.landed_cost.manage` | action | Enter landed costs | existing |
| `qc.view` | view | View specs, samples, results, CoAs | new |
| `qc.spec.manage` | action | Draft specifications | existing |
| `qc.spec.approve` | action | Approve specifications | existing |
| `qc.result.enter` | action | Take samples, enter results | existing |
| `qc.result.review` | action | Review results | existing |
| `qc.lot.change_status` | action | Approve / reject material lots (RM, PM, API, EXCIPIENT) | existing (narrowed: HOLD moved to `qa.lot.hold`; FG and return lots decided by QA, owner 2026-11-18) |
| `qc.coa.issue` | action | Issue certificates of analysis | existing |
| `prod.view` | view | View production orders, stages, outputs | new |
| `prod.order.manage` | action | Create, release, cancel production orders | existing |
| `prod.stage.sign` | action | Execute and sign batch stages, record yield and resource hours | existing |
| `prod.output.verify` | action | Verify a signed output/yield entry with e-signature (checker ≠ doer); creates the FG lot in QUARANTINE and posts FG_OUTPUT. QA-controlled (owner Q17, 2026-11-19) | new (owner 2026-11-18) |
| `prod.batch.close` | action | Submit batch close (Supervisor) | existing |
| `prod.batch.approve_close` | action | Approve batch close with e-signature (Production Manager) | new |
| `qa.view` | view | View deviations and batch releases | new |
| `qa.deviation.manage` | action | Raise and investigate deviations | existing |
| `qa.deviation.close` | action | Close deviations | existing |
| `qa.batch.release` | action | Release or reject batches; release FG lots; re-release return lots (e-signature + assessment reason) | existing (owner 2026-11-18: also return-lot re-release) |
| `qa.lot.hold` | action | Place or lift HOLD on a lot | new |
| `qa.lot.witness` | action | Witness e-signature for lot destruction / return | accepted (owner 2026-11-17) |
| `qa.lot.reject_fg` | action | Reject finished-goods and return lots (HOLD → REJECTED), e-signature required; QA-controlled | new (owner 2026-11-18) |
| `qa.access.countersign` | action | E-signature countersign for role changes touching QA-controlled keys | accepted (owner 2026-11-17) |
| `qa.product.countersign` | action | Countersign product registration no., artwork version and quality-agreement changes | new (M2) |
| `qa.attachment.countersign` | action | E-sign the voiding of a file attached to a GMP record (AVL evidence, QC records, batch documents); QA Manager | new (owner 2026-11-25, answer 1) |
| `fg.view` | view | View delivery orders, gate passes, returns | new |
| `fg.delivery.manage` | action | Delivery orders, picking, returns receipt | existing |
| `fg.dispatch.post` | action | Post dispatch, gate pass | existing |
| `fg.gatepass.approve` | action | Approve gate passes | new |
| `fin.view` | view | View journals, invoices, receipts, payments, ledgers | new |
| `fin.journal.manage` | action | Journal vouchers | existing |
| `fin.invoice.manage` | action | Sales and vendor invoices | existing |
| `fin.receipt.manage` | action | Customer receipts | existing |
| `fin.payment.manage` | action | Create payments | existing |
| `fin.payment.approve` | action | Approve payments | existing |
| `fin.bank.reconcile` | action | Bank reconciliation | existing |
| `fin.rate.manage` | action | Maintain daily exchange rates (owner 2026-11-25, Q4) | new |
| `fin.approval_rules.countersign` | action | Countersign changes to the approval matrix (decision: rules review B) | new |
| `fin.master.manage` | action | Chart of accounts, cost centres, tax codes, posting rules | new (M2) |
| `fin.costing.view` | view | Batch cost and margin | existing |
| `fin.report.view` | view | Financial statements and ledgers | existing |
| `dash.ceo.view` | view | Executive dashboard | existing |

## Role → keys

Every role except SYSTEM also holds `core.approval.inbox` (not repeated below). Least privilege: managers get approve keys, not their team's create keys, unless the docs give them that work.

| # | Role | View keys | Action / admin keys |
| --- | --- | --- | --- |
| 1 | CEO / Director | **all view keys**: `core.audit.view`, `master.view`, `inv.stock.view`, `sales.view`, `purch.view`, `qc.view`, `prod.view`, `qa.view`, `fg.view`, `fin.view`, `fin.costing.view`, `fin.report.view`, `dash.ceo.view` | none |
| 2 | Sales Executive | `sales.view`, `master.view`, `inv.stock.view`, `fg.view` | `master.customer.manage`, `sales.quotation.manage`, `sales.order.manage` |
| 3 | Sales Manager | `sales.view`, `master.view`, `inv.stock.view`, `fg.view` | `sales.quotation.approve`, `master.customer.approve`, `master.product.manage`, `master.price.manage` |
| 4 | Accountant | `fin.view`, `fin.report.view`, `purch.view`, `master.view` | `fin.journal.manage`, `fin.invoice.manage`, `fin.bank.reconcile` |
| 5 | AR Officer | `fin.view`, `sales.view`, `fg.view`, `master.view` | `fin.invoice.manage`, `fin.receipt.manage` |
| 6 | AP Officer | `fin.view`, `purch.view`, `master.view` | `fin.payment.manage` |
| 7 | Finance Manager | `fin.view`, `fin.report.view`, `fin.costing.view`, `sales.view`, `purch.view`, `inv.stock.view`, `master.view` | `fin.payment.approve`, `sales.order.credit_override`, `sales.quotation.approve` (discount > 5% second step), `purch.po.approve`, `inv.adjustment.approve`, `core.period.manage`, `core.period.close`, `fin.approval_rules.countersign`, `fin.master.manage`, `fin.rate.manage` |
| 8 | Purchase Officer | `purch.view`, `master.view`, `inv.stock.view` | `purch.pr.manage`, `purch.po.manage`, `master.vendor.manage`, `purch.landed_cost.manage` |
| 9 | Purchase Manager | `purch.view`, `master.view`, `inv.stock.view` | `purch.po.approve`, `master.vendor.approve`, `master.item.manage` |
| 10 | Storekeeper | `inv.stock.view`, `purch.view`, `prod.view`, `fg.view`, `master.view` | `purch.grn.post`, `inv.movement.post`, `inv.label.print`, `fg.delivery.manage`, `fg.dispatch.post` |
| 11 | Warehouse Manager | `inv.stock.view`, `purch.view`, `prod.view`, `fg.view`, `master.view` | `inv.adjustment.request`, `purch.grn.reverse`, `fg.gatepass.approve`, `fg.delivery.manage` (returns), `inv.lot.dispose`, `master.location.manage`, `master.item.manage` |
| 12 | Planner | `prod.view`, `sales.view`, `inv.stock.view`, `master.view` | `prod.order.manage` |
| 13 | Production Operator | `prod.view` | `prod.stage.sign` |
| 14 | Production Supervisor | `prod.view`, `inv.stock.view` | `prod.stage.sign`, `prod.output.verify`, `prod.batch.close` |
| 15 | Production Manager | `prod.view`, `qa.view`, `inv.stock.view`, `master.view` | `prod.batch.approve_close`, `qa.deviation.manage`, `master.formula.manage` |
| 16 | QC Analyst | `qc.view`, `inv.stock.view`, `master.view` | `qc.result.enter`, `qc.spec.manage` |
| 17 | QC Manager | `qc.view`, `inv.stock.view`, `master.view` | `qc.result.review`, `qc.lot.change_status`, `qc.coa.issue`, `qc.spec.approve` |
| 18 | QA Officer | `qa.view`, `qc.view`, `prod.view`, `master.view` | `qa.deviation.manage` |
| 19 | QA Manager | `qa.view`, `qc.view`, `prod.view`, `inv.stock.view`, `master.view`, `core.audit.view` | `qa.deviation.manage`, `qa.deviation.close`, `qa.batch.release`, `qa.lot.hold`, `qa.lot.witness`, `qa.lot.reject_fg`, `qa.access.countersign`, `master.avl.approve`, `master.formula.approve`, `inv.adjustment.approve` (second approver for adjustments), `qa.product.countersign`, `master.item.approve`, `qa.attachment.countersign` |
| 20 | System Admin | `core.audit.view` | `core.user.manage`, `core.role.manage`, `core.settings.manage` (admin keys only) |
| — | SYSTEM (user, not a role) | — | none; cannot log in; actor for seeds and jobs |

## Review points

Approved by the owner on 2026-11-17 (decisions log):

1. The proposed keys `inv.lot.dispose`, `qa.lot.witness` and `qa.access.countersign` are accepted. The witness and countersign are checked by key, not by role name.
3. Assigning a user to, or removing a user from, a role that holds a QA-controlled key also needs a QA Manager countersign e-signature.
4. Sales Executive delivery requests come under `sales.order.manage`; there is no separate key.
5. The countersigner must be a different person from the admin who made the change. Nobody countersigns a change to their own roles.

Decided by the owner (corrected 18-11-2026; commit 04ef009 had recorded an agent default instead):

2. `master.item.manage` (items, categories, UoM) → **Warehouse Manager** and **Purchase Manager**. `master.formula.manage` (drafting master formulas) → **Production Manager**; the QA Manager approves (`master.formula.approve`). Segregation: no role holds both `master.formula.manage` and `master.formula.approve`, and no QA role holds `master.formula.manage` (QA does not draft what it approves). A test enforces both.

Decided by the owner 2026-11-18 (rule 1 clarification):

6. QC approves or rejects **material** lots (RM, PM, API, EXCIPIENT) with `qc.lot.change_status`. QA decides **finished-goods and return lots**: release (`qa.batch.release`), re-release of a return lot (`qa.batch.release`, e-signature + mandatory assessment reason) and reject (`qa.lot.reject_fg`, e-signature, QA Manager only). QC results on FG are input to QA's decision. Segregation: only the QA Manager holds `qa.lot.reject_fg`; no role holds both `qc.lot.change_status` and `qa.lot.reject_fg`. A test enforces both.
