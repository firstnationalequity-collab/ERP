# Albert Pharma ERP — Phase 1 Architecture & Design

Nov 17, 2026 · @MAVRA

## 1. Scope and principles

Phase 1 builds the connected order-to-cash and factory chain: masters, inventory, sales, procurement, QC, production, QA release, dispatch, finance and FBR invoicing. It goes live on the cloud and runs in parallel with current registers; GMP validation (IQ/OQ/PQ) follows the build.

| Module | Phase 1 covers | Deferred |
| --- | --- | --- |
| Foundation | Users, roles, permissions, audit trail, e-signatures, number series, approval matrix, fiscal periods | SSO, periodic access review |
| Masters | Items, UoM, customers, vendors, approved sources (AVL), warehouses, locations, master formula (BOM) with versions, chart of accounts | Full specification library |
| Inventory & Warehouse | Lots, lot status, locations, immutable stock ledger, own vs customer-owned stock, FEFO, labels, adjustments | Balance integration, cycle counts |
| Sales | Customers, price lists, quotations with approval, sales orders, credit hold | Enquiry and feasibility workflow, costing-sheet versions |
| Procurement | PR, PO with value approval, AVL block, GRN to quarantine, landed cost, vendor invoice, 3-way match, payments with WHT | LC, WeBOC and shipment tracking, RFQ comparison |
| QC | Specs, auto sample on GRN and FG, results against limits, approve/reject lot, CoA PDF | OOS phases, stability, instruments |
| Production | Production order and batch number, release check, potency-adjusted issue, stage sign-off, yield, FG to quarantine | Electronic BMR depth, OEE, IPC detail |
| QA | Deviation log, batch release checklist with e-signature | CAPA, change control, SOPs, training |
| FG & Dispatch | Delivery order, FEFO pick by scan, gate pass, proof of delivery, returns to quarantine | DRAP Track & Trace events |
| Finance | GL, auto-posting, AR, AP, receipts, payments, bank reconciliation, batch costing, customer margin, TB, P&L, balance sheet | Fixed assets, budgets, IFRS notes |
| FBR | Real-time digital invoice via PRAL, sandbox first, FBR number on invoice | — |
| Dashboards | CEO view-only: sales, margin, cash, receivables, stock, batch pipeline | Approvals by CEO |

Later, as independent modules: HR & Payroll, Engineering, full QMS, R&D, MRP and scheduling, stability, serialization exchange.

**Non-negotiable rules.** `CLAUDE.md` in the repository root is the authority; this list is the same 12 rules in the same order.

1. Only QC approves or rejects material lots. Only QA may place or lift HOLD and release batches/FG lots. Warehouse Manager may only move a REJECTED lot to DESTROYED or RETURNED, with a QA witness e-signature. No other role, including CEO and admin, can change a lot or batch status.
2. Issue/reserve only APPROVED lots; dispatch only RELEASED FG lots. Checked in the service AND in the database.
3. No negative stock (CHECK constraint on `inv.stock_balances`).
4. Posted documents are immutable. Corrections are reversal documents. Posted rows are never updated or deleted.
5. Every stock movement and every invoice posts to the GL in the same database transaction, through `engines/posting`.
6. Database triggers write the audit trail on every business table; the application cannot bypass or switch it off.
7. Status changes only through explicit action endpoints using `core/transition` with an allowed-moves map; the map holds the permission key for each individual move.
8. E-signature actions re-verify the password and store a meaning (Reviewed, Approved, Released …) and a reason.
9. Segregation of duties (creator ≠ approver ≠ receiver; whoever creates a payment cannot approve it) is enforced in services and returns 403 with an error code.
10. Money `NUMERIC(18,2)`, quantities `NUMERIC(18,4)`, rates/assay `NUMERIC(9,4)`; `decimal.js` in TypeScript, never floating point. Base currency PKR; import POs may be in USD, EUR or CNY.
11. A closed fiscal period accepts no postings.
12. Customer-owned (toll) stock: quantity only, zero value, no GL entry.

**Assumptions:** one company (Albert Pharmaceuticals), held as the single row of `core.companies`, with `company_id` as a real foreign key on every business table; about 3 users per department, roughly 35 users; CEO has view-only access; cloud hosting; approval limits are placeholders until Finance confirms.

## 2. Tech stack and system architecture

The system is a **modular monolith** on PERN with TypeScript: one API deployable and one PostgreSQL database, split into modules with clear boundaries. Stock, quality status and GL must change together in one transaction, which microservices would make fragile at this size.

| Layer | Choice | Reason |
| --- | --- | --- |
| Language | TypeScript, strict mode, front and back | Types catch agent mistakes early |
| Database | PostgreSQL 16 | NUMERIC, constraints, triggers, row locks, JSONB |
| Data access | Drizzle ORM as the query builder. Hand-written SQL files in `apps/api/src/db/migrations` are the only migration source (tables, constraints, triggers); the Drizzle schema is written by hand to match them. No drizzle-kit | SQL-close, full transaction control, one source of truth for the schema |
| API | Node.js 26 (pinned in `.nvmrc` and `engines`; Docker images use the same major version), Express 4, Zod validation | One runtime version from laptop to production |
| Auth | JWT access token (15 min) + httpOnly refresh cookie (12 h, rotated on every use; reuse of an old refresh token revokes the whole session), sessions in `core.sessions`, argon2 password hashing; the web app logs out after 30 min idle | No shared logins, short sessions, stolen refresh tokens detected |
| Frontend | React 18, Vite, React Router, TanStack Query, Ant Design, React Hook Form + Zod | Dense tables and forms out of the box |
| Shared | `packages/shared`: Zod schemas, enums, permission keys | One definition for API and UI |
| Documents | PDF on the server (pdfmake): invoice, CoA, GRN, labels, gate pass | Consistent printouts |
| Barcodes | bwip-js for Code128/QR labels; USB scanners as keyboard input | No special hardware drivers |
| Background jobs | pg-boss (queue in Postgres) | FBR retries, nightly expiry and retest blocks |
| Tests | Vitest + Supertest against a real test database; Playwright end-to-end | Rules tested where they live |
| Logs and errors | pino structured logs, Sentry | Production troubleshooting |
| CI | GitHub Actions: install, typecheck, test against a PostgreSQL 16 service container | Every push proves the rules still hold |
| Hosting | Docker images (Node 26 base); managed PostgreSQL with point-in-time recovery; container service or VM behind Nginx with TLS; attachments behind a storage interface (local-disk driver from M1, S3-compatible driver in M10) | Cloud, backups handled by the provider |

**Request path:** route → Zod validation → authentication → permission check → service (business rules, one DB transaction) → repository → PostgreSQL, where triggers write the audit log. The UI never decides whether an action is allowed; it only hides buttons the API would refuse.

**Module boundaries:** each module owns its tables, routes, services and tests. A module calls another only through that module's exported service functions, never its tables directly. Two shared engines sit under all modules: the **inventory engine** (every stock movement) and the **posting engine** (every journal entry).

**Environments:** local (Docker Compose), staging (UAT, FBR sandbox, seeded test data) and production. Staging and production are identical images; configuration comes from environment variables.

**Open question:** cloud provider and region (data residency for DRAP and customer auditors). AWS Bahrain/Mumbai, Azure UAE, or a local Pakistani cloud are the realistic choices.

## 3. Roles, permissions and approvals

Access is permission-based: each action is a permission key (`purch.po.approve`, `qc.lot.change_status`, `qa.batch.release`), roles are bundles of keys, and one user may hold several roles. Every key is classed as **admin**, **view** or **action**. Each module has its own view key. The exact role → permission mapping is in `docs/roles.md`. Phase 1 has 20 roles for roughly 35 users.

| Role | Department | Can do | Cannot do |
| --- | --- | --- | --- |
| CEO / Director | Management | Every view key (all modules, reports, dashboards) and nothing else | Create, approve or post anything (Phase 1) |
| Sales Executive | Sales | Customers (draft), quotations, sales orders, delivery requests | Approve discounts, override credit |
| Sales Manager | Sales | Approve quotations and discounts within limit, approve customer master | Change prices after approval |
| Accountant | Finance | Journal vouchers, vendor invoices, bank reconciliation | Approve payments, close periods |
| AR Officer | Finance | Sales invoices, customer receipts | Approve payments |
| AP Officer | Finance | Payment drafts | Approve own payments |
| Finance Manager | Finance | Approve payments, credit overrides, top-band POs, adjustments; manage and close periods; costing | Change lot or batch status |
| Purchase Officer | Procurement | PRs, POs, vendor drafts, landed cost entry | Approve own PO, receive goods |
| Purchase Manager | Procurement | Approve POs within limit, approve vendor master | Add vendors to AVL |
| Storekeeper | Warehouse | Gate entry, GRN, put-away, issues, picking, dispatch, labels | Change lot status, adjust stock |
| Warehouse Manager | Warehouse | Request stock adjustments, gate pass approval, returns; move a REJECTED lot to DESTROYED / RETURNED (with QA witness e-signature) | Approve own adjustment; any other lot status change |
| Planner | Planning | Production orders, release orders to the floor | Issue material |
| Production Operator | Production | Execute and sign stages, record yield | Close or release batch, edit master formula |
| Production Supervisor | Production | Execute and sign stages; submit batch close (`prod.batch.close`) | Approve batch close, release batch |
| Production Manager | Production | Approve batch close with e-signature (`prod.batch.approve_close`), raise deviations | Release batch |
| QC Analyst | QC | Enter results, take samples | Approve own results |
| QC Manager | QC | Review results, approve/reject lots, issue CoA, approve specs | Release batch, place or lift HOLD |
| QA Officer | QA | Raise and investigate deviations | Release batch, close deviations, enter QC results, create POs |
| QA Manager | QA | AVL approval, master formula approval, close deviations, place/lift lot HOLD, batch release; QA witness for lot disposal; countersign role changes that touch QA-controlled keys | Enter QC results, create POs |
| System Admin | IT | Users, roles, settings, number series | Any business transaction or approval |

A seeded **SYSTEM** user (no roles, cannot log in) is the actor for seeds and background jobs.

**Role administration rules** (enforced in the service, each with a test):

- Nobody can change their own role assignments, and that includes System Admin.
- A role that holds an admin key (`core.user.manage`, `core.role.manage`, `core.settings.manage`) can never also hold an action key. Saving such a bundle is refused.
- Any change to a role that holds, or would hold, a QA-controlled key (`qaControlled: true` in `packages/shared/src/permissions.ts`: every `qc.*` / `qa.*` action key plus `master.avl.approve`, `master.formula.approve`, `master.item.approve` and any future key that approves a GMP record) needs a QA Manager e-signature; so does assigning a user to, or removing a user from, such a role. The rule reads the flag, not the key prefix.

**Approval matrix** (configurable table `approval_rules`; values are placeholders until Finance confirms; CEO can be added to any band later without code changes):

- Each rule has a `measure`: `AMOUNT_PKR` or `PERCENT`. Import POs are converted to PKR at the PO's exchange rate before the band is looked up.
- "**then**" means sequential steps: step 2 opens only after step 1 is approved. "**and**" means both must approve, in any order.
- Each step goes to a **role**. Anyone holding that role can act, except the document's creator (segregation). Pending steps show in the "my approvals" inbox (`core.approval.inbox`, held by every user).
- A step never goes to a role holding an admin key (System Admin approves nothing).
- **GMP document types are locked in code** (`GmpLockedApprovals`): AVL and master formula can only be approved by roles holding `master.avl.approve` / `master.formula.approve` (QA Manager), batch close by roles holding `prod.batch.approve_close` (Production Manager). New QC/QA document types are added to this list.
- **Every other change to the matrix needs a Finance Manager countersign** (`fin.approval_rules.countersign`), by a different person from the admin who makes it.

| Document | Measure | Band | Approver |
| --- | --- | --- | --- |
| Purchase order | AMOUNT\_PKR | up to 500,000 | Purchase Manager |
| Purchase order | AMOUNT\_PKR | 500,000.01 to 5,000,000 | Finance Manager |
| Purchase order | AMOUNT\_PKR | above 5,000,000 | Purchase Manager then Finance Manager (two steps) |
| Quotation discount | PERCENT | up to 5% off list | Sales Manager |
| Quotation discount | PERCENT | above 5% | Sales Manager then Finance Manager |
| Sales order over credit limit | AMOUNT\_PKR | any excess | Finance Manager |
| Vendor payment | AMOUNT\_PKR | any amount | Finance Manager (creator cannot approve) |
| Stock adjustment or write-off | AMOUNT\_PKR | any value | Finance Manager and QA Manager (both, any order) |
| Vendor added to AVL | — | — | QA Manager |
| Master formula version | — | — | QA Manager |

**Segregation checks enforced by the API:** PO creator ≠ PO approver; PO approver ≠ GRN receiver; payment creator ≠ payment approver; QC result entered by ≠ reviewed by; adjustment requester ≠ approver. Each check returns a clear error naming the rule.

## 4. Status machines

Three status chains hold the system together: lot status (QC approves and rejects; QA holds and releases), batch status (owned by QA) and order status (owned by Sales and Finance). Each lives in one service function `transition(entity, from, to, actor)`. It works from the entity's allowed-moves map, where **every individual move carries its own permission key** (and whether it needs an e-signature). It checks that the move is allowed and that the actor holds that key, writes a row to `core.status_history` (entity\_table, entity\_id, from\_status, to\_status, actor, esign\_id, reason, at), and refuses everything else. The database also has a CHECK constraint on allowed values. Each module's map lists its keys when that module is built.

**Lot status** (`lots.status`): applies to every material and finished-goods lot.

| From | To | Who / trigger | Permission key | Condition |
| --- | --- | --- | --- | --- |
| (new) | QUARANTINE | GRN posted, or FG output recorded | (posting service) | Automatic; QC sample request created |
| QUARANTINE | UNDER\_TEST | QC Analyst takes sample | `qc.result.enter` | — |
| UNDER\_TEST | APPROVED | QC Manager, e-signature | `qc.lot.change_status` | All spec tests passed and reviewed |
| UNDER\_TEST | REJECTED | QC Manager, e-signature | `qc.lot.change_status` | Any test failed; reason required |
| APPROVED | HOLD | QA Manager | `qa.lot.hold` | Reason required |
| HOLD | APPROVED | QA Manager lifts hold, e-signature | `qa.lot.hold` | Reason required |
| HOLD | REJECTED | QC Manager, e-signature | `qc.lot.change_status` | Reason required (only QC rejects) |
| APPROVED | RETEST\_DUE / EXPIRED | Nightly job (SYSTEM user) | (system job) | Retest or expiry date reached |
| RETEST\_DUE | UNDER\_TEST | QC Analyst | `qc.result.enter` | Re-sample; new assay updates the lot |
| REJECTED | DESTROYED / RETURNED | Warehouse Manager, plus QA Manager witness e-signature | `inv.lot.dispose` + witness `qa.lot.witness` | Stock moved out, value written off or debit note |
| QC APPROVED (FG only) | RELEASED | QA Manager via batch release | `qa.batch.release` | See batch release below |

Only **APPROVED** material lots can be issued or reserved; only **RELEASED** FG lots can be picked for dispatch.

**Production order / batch** (`production_orders.status`):

| From | To | Who | Permission key | Condition |
| --- | --- | --- | --- | --- |
| PLANNED | RELEASED | Planner | `prod.order.manage` | Master formula version APPROVED; every required material has enough APPROVED stock; stock reserved |
| PLANNED | CANCELLED | Planner | `prod.order.manage` | Nothing issued |
| RELEASED | IN\_PROCESS | System | (issue posting service) | First material issue posted |
| IN\_PROCESS | AWAITING\_QA | Production Supervisor submits close (`prod.batch.close`, opens an approval step); Production Manager approves with e-signature | `prod.batch.approve_close` | All stages signed; yield and output recorded; FG lot created in QUARANTINE |
| AWAITING\_QA | RELEASED\_FOR\_SALE | QA Manager, e-signature | `qa.batch.release` | FG lot QC APPROVED; no OPEN deviation on the batch; checklist complete |
| AWAITING\_QA | REJECTED | QA Manager, e-signature | `qa.batch.release` | Reason required; FG lot set REJECTED |

**Quotation:** DRAFT → PENDING\_APPROVAL → APPROVED → SENT → ACCEPTED or LOST. An approved quotation is locked; a change creates a new version.

**Sales order:** DRAFT → CONFIRMED (credit check passes) or ON\_CREDIT\_HOLD → CONFIRMED (Finance Manager) → PARTIALLY\_DISPATCHED → DISPATCHED → CLOSED. CANCELLED only while nothing is dispatched. Invoicing and payment are tracked as amounts (invoiced, paid) on the order, not extra statuses.

**Purchase order:** DRAFT → PENDING\_APPROVAL → APPROVED → PARTIALLY\_RECEIVED → RECEIVED → CLOSED; CANCELLED only before any receipt.

**All posting documents** (GRN, issue, delivery, invoice, receipt, payment, journal): DRAFT → POSTED, or POSTED → REVERSED by a new reversing document. A POSTED row is never updated except to mark it reversed.

## 5. Database schema

About 80 tables in 9 groups, all in one PostgreSQL schema per module (`core`, `inv`, `sales`, `purch`, `qc`, `prod`, `qa`, `fin`). Tables, constraints and triggers are created by hand-written SQL migrations. The Drizzle definitions are written to match them. Columns shown are the ones that carry business rules.

**Conventions for every table**

- Primary key `id BIGINT GENERATED ALWAYS AS IDENTITY`; documents also carry a human number (`doc_no`, e.g. `PO-2026-00042`) from `core.number_series`.
- `company_id` (FK to `core.companies`), `created_at`, `created_by`, `updated_at`, `updated_by` (FK to `core.users`) on all business tables. Seeds and jobs act as the SYSTEM user.
- Quantities `NUMERIC(18,4)`, money `NUMERIC(18,2)`, rates and assay `NUMERIC(9,4)`, dates `DATE`, timestamps `TIMESTAMPTZ` stored in UTC, shown in Asia/Karachi.
- Status columns are `TEXT` with a CHECK constraint; masters use `is_active`, never hard delete.
- Foreign keys everywhere, `ON DELETE RESTRICT`.

| Group | Tables | Key columns and rules |
| --- | --- | --- |
| Core | `companies`, `users`, `user_credentials`, `sessions`, `auth_events`, `roles`, `permissions`, `role_permissions`, `user_roles`, `approval_rules`, `approvals`, `e_signatures`, `status_history`, `idempotency_keys`, `audit_log`, `number_series`, `fiscal_periods`, `attachments`, `settings` | `companies`: one row, Albert Pharmaceuticals. `users`: username (employee code, unique), email (optional), is\_system (SYSTEM user, cannot log in), is\_active, failed\_attempts, locked\_at, password\_changed\_at, must\_change\_password. No password hash on `users`. `user_credentials`: user, password\_hash, set\_at, is\_current; one row per password ever set (used to block reuse of the last 5); **no audit trigger**, so a hash never reaches `audit_log`. `sessions`: user, refresh-token family, current token hash, expires\_at (12 h), revoked\_at, revoke\_reason, IP, user agent. `auth_events`: insert-only; user, username tried, event LOGIN\_OK/LOGIN\_FAIL/LOGOUT/LOCKOUT/UNLOCK/PASSWORD\_CHANGE/ESIGN\_FAIL, IP, at. `audit_log`: table, record\_id, action, old\_data JSONB, new\_data JSONB, changed\_by, changed\_at, reason — insert-only, written by trigger. `e_signatures`: user, meaning, reason, record table/id, signed\_at, IP. `status_history`: entity\_table, entity\_id, from\_status, to\_status, actor, esign\_id, reason, at — insert-only. `idempotency_keys`: key, user, endpoint, request hash, stored response, created\_at; expire after 24 h. `approval_rules`: doc\_type, measure AMOUNT\_PKR/PERCENT/NONE, lower/upper limit as `lower_amount`/`upper_amount` NUMERIC(18,2) or `lower_percent`/`upper_percent` NUMERIC(9,4) (band = above lower, up to and including upper), step\_no (same number = "and", higher = "then"), role; never edited, replaced as a set. `approvals`: document, measure, amount + currency + exchange rate, `measured_amount` NUMERIC(18,2) or `measured_percent` NUMERIC(9,4), requested\_by, status; `approval_steps`: step\_no, role, status, acted\_by, esign. `number_series`: doc\_type, pattern (tokens `{PREFIX}` `{FY}` `{YYYY}` `{YY}` `{SEQ:n}`), reset FISCAL\_YEAR/CALENDAR\_YEAR/NEVER, current period key, next value. `fiscal_periods.status` OPEN/CLOSED. `attachments`: record table/id, file name, content type, size, sha256, storage driver, storage key |
| Masters | `uoms`, `uom_conversions`, `item_categories`, `items`, `customers`, `customer_addresses`, `vendors`, `approved_sources`, `warehouses`, `locations`, `products`, `master_formulas`, `master_formula_lines`, `price_lists`, `price_list_lines`, `tax_codes` | `items.type` RM/PM/API/EXCIPIENT/BULK/FG/SPARE/CONSUMABLE; `items.status` DRAFT/ACTIVE/INACTIVE (is_active generated = ACTIVE); shelf\_life\_days, retest\_days, is\_controlled, storage\_zone, tax\_code\_id (sales tax per item, not one global rate). `approved_sources`: vendor + item + manufacturer + manufacturing site, status APPROVED/BLOCKED, approved\_by (QA). `products`: FG item, registration\_no, customer\_id (null = own brand), artwork version. `master_formulas`: product, version, batch\_size, status DRAFT/APPROVED/OBSOLETE. Lines: item, qty\_per\_batch, uom, is\_api, is\_filler, assay\_basis (AS\_IS/DRIED) |
| Inventory | `lots`, `stock_movements`, `stock_balances`, `stock_reservations`, `stock_adjustments`, `stock_adjustment_lines` | `lots`: item, lot\_no, mfr\_batch\_no, manufacturer, mfg/expiry/retest dates, assay\_pct, water\_pct, status, owner\_type OWN/CUSTOMER, owner\_customer\_id, unit\_cost. `stock_movements` is the immutable ledger: type, lot, from/to location, qty (signed), unit\_cost, value, ref\_doc\_type/id, reason\_code, posted\_at. `stock_balances` (lot, location, qty) is updated in the same transaction, with CHECK qty >= 0. Each ledger row touches one location (inbound: to\_location, qty > 0; outbound: from\_location, qty < 0; a transfer is an out + in pair); balances are written only by the ledger trigger; `stock_reservations` hold quantity per lot and document line and never exceed the lot's stock (decisions 18-11-2026, M2 task 5). Lot status history lives in `core.status_history` |
| Sales | `quotations`, `quotation_lines`, `sales_orders`, `sales_order_lines`, `delivery_orders`, `delivery_order_lines`, `gate_passes`, `sales_invoices`, `sales_invoice_lines`, `fbr_submissions`, `customer_receipts`, `receipt_allocations`, `sales_returns` | Order line links quotation version and price. Delivery lines carry lot\_id. `fbr_submissions`: invoice, request JSONB, response JSONB, fbr\_invoice\_no, status PENDING/SUCCESS/FAILED, attempts |
| Procurement | `purchase_requisitions`, `pr_lines`, `purchase_orders`, `po_lines`, `grns`, `grn_lines`, `landed_costs`, `landed_cost_allocations`, `vendor_invoices`, `vendor_invoice_lines`, `vendor_payments`, `payment_allocations` | PO: currency, exchange\_rate, incoterm. GRN line creates a lot. `landed_costs`: GRN, type FREIGHT/DUTY/CLEARING/INSURANCE/OTHER, amount, basis VALUE/QTY. Payment: gross, WHT section, WHT amount, net |
| QC | `qc_specs`, `qc_spec_tests`, `qc_samples`, `qc_results`, `coas` | Spec per item, versioned, approved by QC Manager. Test: name, method, min, max, text\_limit, unit, is\_assay, is\_water. Result: value, pass (computed), entered\_by, reviewed\_by. Original results are never updated; a re-test is a new row |
| Production | `production_orders`, `production_order_materials`, `batch_stages`, `stage_signoffs`, `production_outputs`, `resource_logs` | Order: batch\_no, product, formula version, batch\_size, customer\_id (toll), sales\_order\_line\_id. Materials: theoretical\_qty, adjusted\_qty, issued\_qty per lot. Output: FG lot, qty, yield\_pct. `resource_logs`: line, machine\_hours, labour\_hours |
| QA | `deviations`, `batch_releases` | Deviation: batch, class MINOR/MAJOR/CRITICAL, status OPEN/CLOSED, root cause, closed\_by. Release: production order, checklist JSONB, decision, e-signature id |
| Finance | `accounts`, `cost_centers`, `posting_rules`, `journal_entries`, `journal_lines`, `bank_accounts`, `bank_statement_lines`, `batch_costs`, `cost_rates` | Journal entry: date, period, source\_type/id, status, reversal\_of; manual journal vouchers (source MANUAL, no event) number from the `JV` series, system journals posted by modules from `SJ` and always name their source document and event. Lines: account, debit, credit, cost\_center, customer\_id, vendor\_id, production\_order\_id, tax\_code\_id; a line booking a WITHHOLDING code whose rate Finance has not confirmed (`is_placeholder`) cannot be posted (`TAX_RATE_NOT_CONFIRMED`); CHECK one of debit/credit is zero; trigger ensures entry balances. `cost_rates`: per line machine-hour rate, labour rate, overhead % |

**Database-enforced rules** (not only in code): balances never negative; journal entries balance; no insert into a closed period; no UPDATE/DELETE on posted rows, audit log, auth events, status history or stock movements (trigger raises an error).

## 6. Inventory ledger and GL posting rules

Every business event calls the inventory engine and the posting engine inside one transaction; if either fails, nothing is saved. Valuation is **lot-actual cost**: each lot carries its own unit cost (receipt price + allocated landed cost), and every issue, dispatch, adjustment and disposal is valued at that lot's cost. A movement is valued at qty × lot unit cost rounded half-up to 2 decimals; the movement that empties a lot takes the residual so the lot ends at exactly zero; an FG lot is booked at the exact batch cost; the inventory GL balance always equals the sum of the ledger movement values (owner decision 2026-11-18, "Rounding of stock values"; DB guard 0015). There is no item-level moving average; an item's average cost for reports is computed from its lots (decision 18-11-2026; Finance to confirm under IAS 2). Customer-owned (toll) material moves in the stock ledger at zero value and creates **no** journal entry.

Accounts are not hard-coded: `posting_rules` maps (event, account role, item category) to an account, so Finance can change the chart without code. Each event uses the account roles listed in `PostingEventRoles` (`packages/shared/src/enums.ts`); a rule with no item category is the default for every category. Journal entries are created DRAFT and posted only when balanced (≥ 2 lines, debits = credits); posted lines never change (decisions 18-11-2026, M2 task 4).

| Event | Stock effect | Debit | Credit |
| --- | --- | --- | --- |
| GRN posted (own stock) | + lot in QUARANTINE at PO price | Inventory (RM/PM/API by category) | GRNI — goods received not invoiced |
| Landed cost added | Lot unit cost raised by allocated share | Inventory (or Price Variance if already consumed) | Landed-cost clearing / customs & freight payable |
| Vendor invoice posted | — | GRNI; Input sales tax; Price variance if invoice ≠ PO | Accounts payable (vendor) |
| Vendor payment | — | Accounts payable | Bank; WHT payable |
| Material issued to batch | − lot, + batch WIP | WIP (production order) | Inventory |
| Material returned from floor | + lot | Inventory | WIP |
| Conversion absorbed at batch close | — | WIP | Labour absorbed; Machine overhead absorbed |
| FG output recorded | + FG lot in QUARANTINE at actual batch cost | FG inventory | WIP |
| Dispatch posted | − FG lot | Cost of goods sold | FG inventory |
| Sales invoice (own product) | — | Accounts receivable | Sales revenue; Output sales tax |
| Sales invoice (toll conversion) | — | Accounts receivable | Conversion revenue; Output sales tax |
| Customer receipt | — | Bank; WHT receivable (deducted by customer) | Accounts receivable |
| Stock adjustment / write-off | ± lot | Inventory loss expense (or Inventory) | Inventory (or Inventory gain) |
| Rejected lot destroyed | − lot | Rejection write-off expense | Inventory |
| Rejected lot returned to vendor | − lot | Accounts payable (debit note) | Inventory |
| Any reversal | Mirror of the original | Original credits | Original debits |

**Potency-adjusted API quantity** (production issue): for each API line, `adjusted_qty = theoretical_qty × 100 ÷ assay_on_basis`, where assay on dried basis uses `assay_pct × (100 − water_pct) ÷ 100` when the formula line says DRIED. The filler line marked `is_filler` is reduced by the total API excess so batch weight stays constant. The system computes this; the operator never types the quantity.

**Actual batch cost** = materials at the actual issued quantity and lot cost (net of returns) + machine hours × line rate + labour hours × labour rate + overhead %. Stored in `batch_costs` with a breakdown, compared with the quotation cost sheet and the standard cost. **Customer margin** = invoiced revenue − COGS of the batches dispatched to that customer, by period.

## 7. Module specs

Each module below lists its screens and the rules its services must enforce; endpoints follow the conventions in section 8. Every list screen has search, filters, paging and Excel export.

### 7.1 Foundation

- Screens: login, change password, users (including unlock), roles and permissions, approval rules, number series, fiscal periods, audit trail viewer (filter by table, record, user, date), my approvals inbox.
- Login is by username (the employee code); email is optional.
- Passwords: at least 10 characters, with upper case, lower case and a digit, and must not contain the username. The last 5 passwords cannot be reused. A change is forced every 90 days and at first login.
- Lockout: after 5 failed attempts. A wrong password in the e-signature dialog counts toward those 5. The account stays locked until an admin unlocks it.
- Every login (ok or failed), logout, lockout, unlock, password change and e-signature failure is written to the insert-only `core.auth_events`.
- Sessions: access token 15 min; refresh token 12 h, rotated on every use. Presenting an already-used refresh token revokes the whole session. The web app logs out after 30 min idle.
- First admin: created by the seed from `INITIAL_ADMIN_PASSWORD`, with a forced change at first login. The seed refuses to run in production if that variable is not set. The SYSTEM user cannot log in.
- Role administration: see §3 (nobody changes their own roles; admin roles hold no action keys; qc.\* / qa.\* role changes need a QA Manager e-signature).
- The e-signature dialog asks for password, meaning and reason. Every approval lands in the approver's inbox with a count badge.
- Number series: the pattern uses the tokens `{PREFIX}` `{FY}` `{YYYY}` `{YY}` `{SEQ:n}`, and the reset is FISCAL\_YEAR, CALENDAR\_YEAR or NEVER. The fiscal year runs July to June, and `{FY}` for FY 2026-27 is `2627`. Defaults: documents `{PREFIX}-{FY}-{SEQ:5}` resetting each fiscal year (e.g. `PO-2627-00042`); batch numbers `AP{YY}-{SEQ:4}` resetting each calendar year (e.g. `AP26-0001`). Both are editable by the admin. A number is taken under a row lock inside the business transaction, so a rollback leaves no gap.
- Attachments: upload, list and download against any record, behind a storage interface. The local-disk driver ships in M1; the S3-compatible driver comes in M10.
- Idempotency: a posting action's `Idempotency-Key` is stored with the user, endpoint, request hash and response for 24 hours. The same key with the same request returns the stored response. The same key with a different request is refused with `DUPLICATE_REQUEST`.

### 7.2 Masters

- Screens: items, categories, UoM, customers, vendors, approved sources (AVL), warehouses and locations, products, master formulas, price lists, chart of accounts, cost centres, posting rules, tax codes.
- Rules: items are created DRAFT; GMP items (RM, PM, API, EXCIPIENT, BULK, FG) are activated, deactivated and reactivated only by QA (`master.item.approve`), non-GMP items by another item keeper (`master.item.manage`); the activator is neither the creator nor the last editor; after DRAFT a GMP item's shelf life, retest period, storage zone and controlled flag change only with a QA countersign; customer and vendor need NTN or CNIC; vendor activation by Purchase Manager, AVL entry by QA Manager; master formula editable only in DRAFT, approved by QA Manager, only one APPROVED version per product at a time; a contract product cannot be ordered until its quality agreement is marked signed (`products.quality_agreement_signed_on`).

### 7.3 Inventory and Warehouse

- Screens: gate entry, stock by item / lot / location, lot card (status history, movements, where used), transfers, put-away by scan, stock adjustment request and approval, label printing, near-expiry and retest report, customer-owned stock report.
- Rules: lot status changes only through the QC/QA endpoints and the Warehouse Manager's disposal action (REJECTED → DESTROYED/RETURNED with a QA witness), per rule 1; FEFO suggestion on every pick (earliest expiry first, APPROVED only); scan of lot label must match the suggested or an allowed lot; transfer to a location must match the item's storage zone.
- Traceability screen: from any lot, forward to batches, FG lots, deliveries and customers; backward from any FG lot to every material lot. Target under 5 seconds.

### 7.4 Sales

- Screens: customers, quotations (with cost sheet: materials, conversion, overhead, margin per 1,000 units), sales orders, credit-hold queue, order book, delivery requests, customer ledger and ageing.
- Rules: price comes from the approved quotation or price list; credit check on confirm = open AR + unbilled confirmed orders + this order vs credit limit; over limit → ON\_CREDIT\_HOLD for the Finance Manager.

### 7.5 Procurement

- Screens: purchase requisitions, purchase orders (local and import), PO approval, GRN (from PO, by scan), landed cost entry and allocation, vendor invoice with 3-way match, payment proposal and approval, vendor ledger and ageing.
- Rules: PO line for a GMP material bought from vendors (RM, PM, API, EXCIPIENT; `AvlItemTypes`) requires an APPROVED approved-source row for vendor + item; GRN quantity cannot exceed PO open quantity + tolerance (setting, default 2%); GRN captures manufacturer batch, mfg, expiry and retest dates (required for API); invoice match tolerance on price and quantity is a setting; WHT section and rate per vendor.

### 7.6 QC

- Screens: specifications, sample queue, result entry, review queue, lot disposition, CoA print.
- Rules: sample auto-created on GRN and on FG output; pass/fail computed from limits; reviewer must differ from the analyst; disposition writes assay and water onto the lot; a failed result cannot be edited, only re-tested as a new row with a reason.

### 7.7 Production

- Screens: production orders, release check (shows any material short or not approved), material requirement with potency calculation, issue by scan, stage execution (sign each stage in order), output and yield, batch close, resource hours.
- Rules: batch number format set in number series (e.g. `AP26-0001`); stages follow the formula's routing and cannot be signed out of order; yield outside the product's range (e.g. 98–101%) requires a deviation before close.

### 7.8 QA

- Screens: deviations (raise, investigate, close), batch release queue and checklist, AVL approvals, master formula approvals.
- Rules: release button disabled — and the API refuses — while any deviation on the batch is OPEN or the FG lot is not QC APPROVED.

### 7.9 Finished Goods and Dispatch

- Screens: delivery orders from sales orders, FEFO pick list, pick by scan, gate pass, proof of delivery, returns receipt.
- Rules: only RELEASED FG lots; dispatch posting creates the stock move, the COGS entry and the sales invoice draft; returns go to QUARANTINE.

### 7.10 Finance

- Screens: chart of accounts, journal vouchers, sales invoices, receipts, vendor invoices, payments, bank reconciliation, period close, batch cost sheet, trial balance, P&L, balance sheet, AR/AP ageing, customer margin, sales-tax register.
- Rules: invoice only for dispatched quantity; an invoice is final only after FBR returns an invoice number (stored and printed with the FBR QR code); period close checks no DRAFT documents in the period.

### 7.11 FBR integration

- A service `fbr.submitInvoice(invoiceId)` builds the PRAL Digital Invoicing payload (seller and buyer NTN/STRN, province, HS code, quantity, value, sales tax rate) and posts it.
- On success it stores the FBR invoice number; on failure a pg-boss job retries with backoff and the invoice shows FAILED with the error for Finance.
- Sandbox and production credentials come from environment variables; the HS code and sales tax rate live on the item.

### 7.12 CEO dashboard (view only)

- Tiles and charts: sales and margin this month vs last, order book, receivables ageing, cash in bank, stock value by category, batches by status (in process, awaiting QA, released), near-expiry stock value, top 10 customers by margin.

## 8. API, folder structure and conventions

One pnpm monorepo with three packages: the API, the web app and a shared package of schemas and enums.

```
albert-erp/
├─ CLAUDE.md
├─ docs/                      # architecture, build plan, progress, decisions, roles
├─ .nvmrc                     # Node 26
├─ .github/workflows/ci.yml   # install, typecheck, test (Postgres 16 service)
├─ docker-compose.yml         # postgres + api + web for local work
├─ packages/shared/src/
│  ├─ enums/                  # LotStatus, BatchStatus, ItemType ...
│  ├─ permissions.ts          # every permission key, one place
│  └─ schemas/<module>/       # Zod request/response schemas
├─ apps/api/src/
│  ├─ app.ts, server.ts
│  ├─ config/                 # env parsing with Zod
│  ├─ db/
│  │  ├─ schema/<module>.ts   # Drizzle tables, written to match the SQL
│  │  ├─ migrations/          # hand-written SQL only: tables, constraints, triggers
│  │  └─ seed/                # roles, permissions, chart of accounts, demo data
│  ├─ core/                   # auth, rbac, audit, esign, transition, approvals, numbering, idempotency, storage, errors
│  ├─ engines/
│  │  ├─ inventory/           # postMovement(), reserve(), fefo()
│  │  └─ posting/             # postJournal(), reverse()
│  ├─ modules/<module>/
│  │  ├─ <module>.routes.ts
│  │  ├─ <module>.service.ts  # all business rules
│  │  ├─ <module>.repo.ts     # queries only
│  │  └─ __tests__/
│  └─ jobs/                   # fbr-retry, nightly-retest-expiry
└─ apps/web/src/
   ├─ api/                    # typed client per module
   ├─ components/             # DataTable, DocForm, StatusTag, ESignModal, ScanInput
   ├─ layouts/                # sidebar by permission
   └─ pages/<module>/
```

**API conventions**

- Base path `/api/v1/<module>/<resource>`; list `GET` with `?page&pageSize&sort&filter`; read `GET /:id`; create `POST`; update `PATCH /:id` (DRAFT only).
- Actions are explicit endpoints: `POST /:id/submit`, `/approve`, `/reject`, `/post`, `/reverse`, `/release`. Never change status with PATCH.
- Every posting action takes an `Idempotency-Key` header so a double click does not post twice.
- Errors: `{ "error": { "code": "LOT_NOT_APPROVED", "message": "...", "details": {...} } }` with HTTP 400 (validation), 401, 403 (permission or segregation), 404, 409 (state conflict), 422 (business rule).
- Actions that need an e-signature take `{ password, meaning, reason }` in the body; the API verifies the password again.
- Row locking: posting services `SELECT ... FOR UPDATE` the lots and balances they touch, so two storekeepers cannot issue the same stock.

**Frontend conventions:** one `DataTable` and one `DocForm` component used everywhere; status shown with a coloured `StatusTag` (QUARANTINE yellow, APPROVED green, REJECTED red, as in the warehouse); the menu shows only what the user's permissions allow; all dates DD-MM-YYYY, amounts with thousand separators, PKR.

## 9. CLAUDE.md for the coding agent

`CLAUDE.md` in the repository root is the authority for the agent rules. It holds the same 12 non-negotiable rules as §1, the stack, the code layout, the conventions, the per-task workflow and the "Never" list. The agent reads it at the start of every session. The detail lives in this document, `docs/roles.md` (role → permission mapping), `docs/build-plan.md`, `docs/progress.md` and `docs/decisions.md`. There are no per-module spec files. To avoid two copies drifting apart, `CLAUDE.md` is not reproduced here; change it there and record the change in `docs/decisions.md`.

## 10. Build plan and acceptance tests

The build is split into 11 milestones in the order of the chain, so each one ends with something testable end to end. **The timeline depends on how many hours you put in each day:** the days below assume about 8 focused hours a day with the agent and add up to roughly 32 working days. At half that pace, plan on about two months. Move to the next milestone only when the current one's "Done when" passes, and keep the last milestone for testing, data migration and go-live, not new features.

| Milestone | Est. days at 8 h/day | Build | Done when |
| --- | --- | --- | --- |
| M1 Foundation | 4 | Repo, Docker, CI (GitHub Actions), config, DB conventions, audit triggers, companies, auth with sessions and auth events, RBAC with role-admin guards, e-signature, status transitions, number series, approvals inbox, idempotency, attachments (local disk), fiscal periods | Login works; audit row written on any change; no password hash in the audit log; permission refusal tested; wrong e-signature password refused |
| M2 Masters & engines | 3 | Masters (items, UoM, customers, vendors, AVL, locations, formulas, chart of accounts, posting rules); inventory engine and posting engine | A manual stock receipt posts a movement and a balanced journal in one transaction |
| M3 Procurement | 3 | Procurement: PR, PO with approval, GRN to quarantine, labels, landed cost, vendor invoice, 3-way match, payment with WHT | PO → GRN → invoice → payment posts correct GL |
| M4 QC | 2 | QC: specs, auto samples, results, review, disposition, CoA; nightly retest/expiry job | Quarantined lot approved by QC becomes issuable; rejected lot cannot move |
| M5 Sales | 2 | Sales: quotation with cost sheet and approval, sales order, credit hold | Over-limit order waits for Finance Manager |
| M6 Production | 3 | Production: order, release check, potency issue by scan, stages, output, yield, resource hours | Batch cannot release with unapproved material; API quantity computed from assay |
| M7 QA & Dispatch | 2 | QA: deviations, batch release; FG & dispatch: delivery, FEFO pick, gate pass, returns | Release blocked by open deviation; unreleased FG cannot be picked |
| M8 Finance & FBR | 3 | Finance: sales invoice, FBR sandbox, receipts, bank reconciliation, batch cost, period close, reports | Invoice gets an FBR sandbox number; TB balances |
| M9 Dashboard & traceability | 2 | CEO dashboard, traceability screen, report polish | Dashboard figures match the ledgers |
| M10 Hardening & staging | 3 | Security review, backups and restore test, cloud deployment to staging | Restore from backup tested; staging matches production setup |
| M11 UAT & go-live | 5 | UAT with each department, opening balances migration, go-live in parallel run | Acceptance tests below pass in staging with real master data |

**Acceptance tests** (adapted from the PDF's demonstration scenarios; each is a Playwright test plus a manual UAT script):

- [ ] Receive an imported API lot with assay 98.2%, sample, approve and dispense it; the system computes the potency-adjusted quantity and reduces the filler.
- [ ] Try to issue a lot still in QUARANTINE; the system refuses with LOT\_NOT\_APPROVED.
- [ ] Receive customer-supplied API at zero value and consume it in a contract batch; no GL entry for the material.
- [ ] Run a full batch with a yield outside limits, raise a deviation, and show QA release blocked until the deviation is closed.
- [ ] Dispatch a released batch and issue an FBR sandbox digital invoice with the FBR number printed.
- [ ] Trace one raw-material lot forward to customers and back in under 5 minutes (target under 5 seconds on screen).
- [ ] Show the actual cost of one batch against its quotation and the margin for that customer.
- [ ] Change a QC result through a re-test and show the full audit trail with old and new values.
- [ ] PO creator tries to approve their own PO; the system refuses.
- [ ] Post into a closed period; the system refuses.

**Before day 1, outside the code:**

- [ ] Apply for FBR Digital Invoicing access through PRAL or a licensed integrator (sandbox credentials needed by week 4).
- [ ] Contact a serialization line vendor; 2D codes have been mandatory since 9 October 2026 and need line hardware.
- [ ] Finance confirms approval limits, chart of accounts and WHT sections and rates (filer / non-filer, company); no WHT posts until each rate is confirmed.
- [ ] Departments send master data in Excel templates: items, customers, vendors, AVL, formulas, opening stock by lot with status.
- [ ] Choose cloud provider and region.
