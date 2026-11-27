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

1. Only QC approves or rejects material lots. Only QA may place or lift HOLD and release batches/FG lots. QC approves or rejects material lots (RM, PM, API, EXCIPIENT). QA decides finished-goods and return lots: release, re-release or reject. QC results on FG are input to QA's decision (owner 2026-11-18). Warehouse Manager may only move a REJECTED lot to DESTROYED or RETURNED, with a QA witness e-signature. No other role, including CEO and admin, can change a lot or batch status.
2. Issue/reserve only APPROVED lots; dispatch only RELEASED FG lots. Checked in the service AND in the database.
3. No negative stock (CHECK constraint on `inv.stock_balances`).
4. Posted documents are immutable. Corrections are reversal documents. Posted rows are never updated or deleted.
5. Every stock movement and every invoice posts to the GL in the same database transaction, through `engines/posting`.
6. Database triggers write the audit trail on every business table; the application cannot bypass or switch it off.
7. Status changes only through explicit action endpoints using `core/transition` with an allowed-moves map; the map holds the permission key for each individual move.
8. E-signature actions re-verify the password and store a meaning (Reviewed, Approved, Released …) and a reason.
9. Segregation of duties (creator ≠ approver ≠ receiver; whoever creates a payment cannot approve it) is enforced in services and returns 403 with an error code.
10. Money amounts `NUMERIC(18,2)`; unit rates (unit prices, unit costs) `NUMERIC(18,6)` (owner 2026-11-25); quantities `NUMERIC(18,4)`; exchange rates `NUMERIC(18,6)` (owner 2026-11-25; 0028); percentages/assay `NUMERIC(9,4)`; `decimal.js` in TypeScript, never floating point. Base currency PKR; import POs may be in USD, EUR or CNY.
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
| Production Operator | Production | Execute and sign stages, record yield (doer) | Verify output (`prod.output.verify`), close or release batch, edit master formula |
| Production Supervisor | Production | Execute and sign stages; verify another user's output/yield entry (`prod.output.verify`, checker; creates the FG lot); submit batch close (`prod.batch.close`) | Verify own output entry, approve batch close, release batch |
| Production Manager | Production | Approve batch close with e-signature (`prod.batch.approve_close`), raise deviations | Release batch |
| QC Analyst | QC | Enter results, take samples | Approve own results |
| QC Manager | QC | Review results, approve/reject material lots (RM, PM, API, EXCIPIENT), issue CoA, approve specs | Release batch, place or lift HOLD, reject FG or return lots |
| QA Officer | QA | Raise and investigate deviations | Release batch, close deviations, enter QC results, create POs |
| QA Manager | QA | AVL approval, master formula approval, close deviations, place/lift lot HOLD, batch release, re-release or reject FG and return lots (`qa.lot.reject_fg`); QA witness for lot disposal; countersign role changes that touch QA-controlled keys | Enter QC results, create POs |
| System Admin | IT | Users, roles, settings, number series | Any business transaction or approval |

A seeded **SYSTEM** user (no roles, cannot log in) is the actor for seeds and background jobs.

**Role administration rules** (enforced in the service, each with a test):

- Nobody can change their own role assignments, and that includes System Admin.
- A role that holds an admin key (`core.user.manage`, `core.role.manage`, `core.settings.manage`) can never also hold an action key. Saving such a bundle is refused. The same holds per user: one user never holds both a role with an admin key and a role with an action key (owner 2026-11-19, Q4; service and DB, 0022).
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

Three status chains hold the system together: lot status (QC approves and rejects material lots; QA holds, releases, re-releases and rejects FG and return lots), batch status (owned by QA) and order status (owned by Sales and Finance). Each lives in one service function `transition(entity, from, to, actor)`. It works from the entity's allowed-moves map, where **every individual move carries its own permission key** (and whether it needs an e-signature). It checks that the move is allowed and that the actor holds that key, writes a row to `core.status_history` (entity\_table, entity\_id, from\_status, to\_status, actor, esign\_id, reason, at), and refuses everything else. The database also has a CHECK constraint on allowed values. Each module's map lists its keys when that module is built.

**Lot status** (`lots.status`): applies to every material and finished-goods lot.

| From | To | Who / trigger | Permission key | Condition |
| --- | --- | --- | --- | --- |
| (new) | APPROVED | GRN posted for an item with `qc_required` = false (owner 2026-11-25, answer 4; default false for every type except RM, PM, API, EXCIPIENT; changing it after DRAFT needs a QA countersign) | `purch.grn.post` | No QC sample request |
| (new) | QUARANTINE | GRN posted (Storekeeper) for an item that requires QC, or FG output verified (Production Supervisor, checker) | `purch.grn.post` / `prod.output.verify` | Automatic; QC sample request created. An FG lot starts at the provisional value of the materials issued to the batch so far (owner 2026-11-18, Q8). **FG output doer + checker (owner 2026-11-18, Option A):** the doer records output/yield and signs with `prod.stage.sign` (e-signature) — this creates nothing. A **different user** holding `prod.output.verify` (Production Supervisor only; never the Operator) verifies with e-signature; the same user → 403 `SEGREGATION_OF_DUTIES`. Two Supervisors may be doer and checker: the rule is different users, not different roles. The verify transaction creates the FG lot in QUARANTINE and posts FG_OUTPUT. Scope: the output/yield entry only (other stage steps: M6 list) |
| (new) | HOLD | Customer return received (Storekeeper / Warehouse Manager) | `fg.delivery.manage` | A new return lot linked to the original lot, numbered original + "-R" + sequence (e.g. `AP26-0001-R1`), at a returns area; never back into the released lot. Only QA moves it on: re-release or reject (rows below) (owner 2026-11-18, Q9) |
| QUARANTINE | UNDER\_TEST | QC Analyst takes sample | `qc.result.enter` | — |
| UNDER\_TEST | APPROVED | QC Manager, e-signature | `qc.lot.change_status` | **Material lots** only. All spec tests passed and reviewed. QC never approves or rejects an FG lot: QA releases it (UNDER\_TEST → RELEASED below; owner 2026-11-27) |
| UNDER\_TEST | REJECTED | QC Manager, e-signature | `qc.lot.change_status` | **Material lots** (every non-FG lot). Reason required. On a failed latest test, or without a failed test with a reason category (DAMAGED\_CONTAINER, LABELLING, SEAL\_BROKEN, CONTAMINATION, COA\_MISMATCH, VENDOR\_ISSUE, OTHER) and a description (owner 2026-11-27; 0038). Every entered result reviewed; whoever entered a result does not decide |
| QUARANTINE | REJECTED | QC Manager, e-signature | `qc.lot.change_status` | **Material lots** not sampled yet (e.g. a damaged container at receipt): reason category + description required; cancels the OPEN sample request (owner 2026-11-27; 0038) |
| UNDER\_TEST | HOLD | QC records a failed result on an **FG lot** (automatic with the result) | `qc.result.enter` (the QC result key) | **FG lots** only (owner 2026-11-18). QC never rejects an FG lot directly: QA rejects it (HOLD → REJECTED, `qa.lot.reject_fg`) after the OOS investigation. While a failed result is open, QA release is refused, unless the investigation closes it as invalid and a retest passes |
| APPROVED | HOLD | QA Manager | `qa.lot.hold` | Reason required |
| HOLD | APPROVED | QA Manager lifts hold, e-signature | `qa.lot.hold` | Reason required |
| HOLD | REJECTED | QC Manager, e-signature | `qc.lot.change_status` | **Material lots** only. Reason, reason category and description required (0038) |
| HOLD | REJECTED | QA Manager, e-signature | `qa.lot.reject_fg` | **FG and return lots** only. Reason required (owner 2026-11-18) |
| HOLD | RELEASED | QA Manager re-releases a **return lot**, e-signature | `qa.batch.release` | Return lots only; mandatory assessment reason (owner 2026-11-18) |
| APPROVED | RETEST\_DUE / EXPIRED | Nightly job (SYSTEM user) | (system job) | Retest or expiry date reached |
| RETEST\_DUE | UNDER\_TEST | QC Analyst | `qc.result.enter` | Re-sample; new assay updates the lot |
| REJECTED | DESTROYED / RETURNED | Warehouse Manager, plus QA Manager witness e-signature | `inv.lot.dispose` + witness `qa.lot.witness` | Stock moved out, value written off or debit note. The status changes in the same transaction as the DESTROY / RETURN_TO_VENDOR movement that empties the lot, with that movement's witness signature (one signature covers both; see **Disposal witness** below). Owner 2026-11-19 |
| UNDER\_TEST (FG only) | RELEASED | QA Manager via batch release, e-signature | `qa.batch.release` | Owner 2026-11-27: QA releases the FG lot directly from UNDER\_TEST (there is no QC APPROVED step for FG). Refused unless every test of the pinned spec has a reviewed, passing latest result and no failed result is open. See batch release below. Built in M6 / M7 |

**Disposal witness** (rule 1; owner 2026-11-19; migration 0020). How the witness is passed:

1. The disposal request carries the lot, the movement type (DESTROY or RETURN_TO_VENDOR), the quantity and `witness: { username, password, meaning: "WITNESSED", reason }`, entered by the QA witness at the Warehouse Manager's terminal, like the role-change countersign.
2. The service calls `verifyWitness` (core/esign) with the subject `"<TYPE> lot <lot id> qty <qty, 4 decimals>"` (`disposalSubject()`). The password is re-checked in its own transaction (a wrong password counts against the witness). The proof is single-use and valid for 2 minutes. The witness must be a different person from the poster.
3. In ONE transaction: `postMovement` (engines/inventory) refuses a proof whose subject names a different lot, type or quantity (`WITNESS_MISMATCH`), from the poster (`SEGREGATION_OF_DUTIES`) or from someone without `qa.lot.witness` (`FORBIDDEN`). It records the signature against the lot (`core.e_signatures`, with the subject) and stores its id on the movement (`witness_esign_id`). Then `postStockJournal` runs, and, if the lot is now empty, `closeDisposedLot` moves it REJECTED → DESTROYED / RETURNED through core/transition, with the same signature as the witness.
4. The database re-checks everything. A DESTROY / RETURN_TO_VENDOR row cannot be written without a WITNESSED signature for that lot, recorded in the same transaction, naming exactly that movement, by an active holder of `qa.lot.witness` who is not the poster. One signature serves one movement. A lot becomes DESTROYED / RETURNED only with the witness of a disposal of the matching type posted in that transaction. A commit that leaves a lot emptied by a disposal still REJECTED is refused (`LOT_NOT_CLOSED`).
5. Reversing a disposal row needs its own witness signature, with the subject `"REVERSE <TYPE> lot <id> qty <qty>"`, one disposal row per reversal. A DESTROYED / RETURNED lot never moves again, so only a partial disposal can be reversed.

A lot held at several locations is moved to one location first; each disposal movement has its own witness signature.

Only **APPROVED** material lots can be issued or reserved; only **RELEASED** FG lots can be picked for dispatch, and an FG lot made by production is dispatched only after its batch is closed (`BATCH_NOT_CLOSED`, enforced in the service and the database; owner 2026-11-18, Q8).

**Expiry at use** (owner 2026-11-27; 0035): issue and reservation refuse a lot whose expiry or retest date is reached (`LOT_EXPIRED` / `LOT_RETEST_DUE`) even while it is still APPROVED; dispatch refuses an FG lot whose expiry is reached whatever its status. "Reached" = on or before the later of the movement date and today (Asia/Karachi). Service and database. The nightly job (M4 task 5) only updates statuses.

**QC sampling** (owner 2026-11-27; 0035, 0036): taking a sample (`qc.result.enter`) moves the lot QUARANTINE / RETEST_DUE → UNDER_TEST and posts SAMPLE_ISSUE rows (sample type TEST or RETENTION) out of the lot, only from a QUARANTINE / UNDER_TEST lot; a sample row is never reversed. The request pins the APPROVED spec version; results are insert-only with pass computed from the limits; reviewer ≠ analyst, e-signature REVIEWED.

**QC disposition** (M4 task 3; 0037; defaults in decisions.md 2026-11-27): the QC Manager (`qc.lot.change_status`) signs on the lot (APPROVED / REJECTED, reason = the signature reason); each decision is an insert-only `qc.dispositions` row and closes the sample request (SAMPLED → CLOSED). Approve: every pinned spec test has a reviewed result, the latest of each passed, expiry not reached; the latest assay / water results are written onto the lot (4 decimals); a reached retest date needs the next one. Reject (0038, owner 2026-11-27): from UNDER_TEST (all results reviewed), QUARANTINE (not sampled; cancels the OPEN request) or HOLD; a rejection no failed latest result supports needs a reason category (`QcRejectCategory`) and a description (`QC_REJECT_CATEGORY_REQUIRED`). Never an FG lot (`FG_LOT_QA_DECIDES`): QA releases a passing FG lot UNDER_TEST → RELEASED (M6 / M7). The decider entered none of the results. The DB refuses these lot moves, and any change of assay / water / retest date, without the disposition in the same transaction.

**Master statuses** (M2; through core/transition like every status, rule 7; decisions 2026-11-18):

| Record | Moves | Permission key | Condition |
| --- | --- | --- | --- |
| Item (`items.status`) | (new) → DRAFT → ACTIVE ⇄ INACTIVE | create: `master.item.manage`; moves: `master.item.approve` (QA) for GMP types RM, PM, API, EXCIPIENT, BULK, FG, else `master.item.manage` | The activator is neither the creator nor the last editor; a non-GMP item is not reactivated by the person who deactivated it; deactivation and reactivation need a reason. ACTIVE only while its UoM, category and tax code are active (0021). `is_active` is generated from the status |
| Customer, vendor (`status`) | (new) → DRAFT → ACTIVE ⇄ INACTIVE | create: `master.customer.manage` / `master.vendor.manage`; moves: `master.customer.approve` / `master.vendor.approve` | The activator differs from the creator; reason on deactivation and reactivation; sensitive edits on an active record need a countersign |
| Approved source / AVL (`approved_sources.status`) | (new) → PENDING → APPROVED or REJECTED; APPROVED → BLOCKED | create: `master.vendor.manage`; decide and block: `master.avl.approve` (QA) | Decided through the approval workflow with an e-signature, with evidence attached; blocking needs an e-signature (REJECTED) and a reason |
| Master formula (`master_formulas.status`) | (new) → DRAFT → PENDING_APPROVAL → APPROVED (or back to DRAFT on rejection, with a reason); APPROVED → OBSOLETE | draft and submit: `master.formula.manage`; decide: `master.formula.approve` (QA) | One APPROVED version per product; approving a new version makes the previous one OBSOLETE; the approver is not the drafter |

Simple masters (UoM, categories, tax codes, warehouses, locations, accounts, cost centres, posting rules, price lists, products, addresses) have an active/inactive switch, not a status: rule 7 does not apply to it, but each switch needs a reason (audit trail) and a master still in use cannot be switched off (owner 2026-11-19; migration 0021).

**Production order / batch** (`production_orders.status`):

| From | To | Who | Permission key | Condition |
| --- | --- | --- | --- | --- |
| PLANNED | RELEASED | Planner | `prod.order.manage` | Master formula version APPROVED; every required material has enough APPROVED stock; stock reserved |
| PLANNED | CANCELLED | Planner | `prod.order.manage` | Nothing issued |
| RELEASED | IN\_PROCESS | System | (issue posting service) | First material issue posted |
| IN\_PROCESS | AWAITING\_QA | Production Supervisor submits close (`prod.batch.close`, opens an approval step); Production Manager approves with e-signature | `prod.batch.approve_close` | All stages signed; yield and output recorded (FG lot already created in QUARANTINE at output). In the same transaction as the close journal, a value-only adjustment adds conversion cost and the true-up to the FG lot and marks its batch closed (owner 2026-11-18, Q8) |
| AWAITING\_QA | RELEASED\_FOR\_SALE | QA Manager, e-signature | `qa.batch.release` | FG lot UNDER\_TEST with every spec test's latest result reviewed and passing (the FG lot moves UNDER\_TEST → RELEASED in the same transaction; owner 2026-11-27); no OPEN deviation on the batch; no open failed QC result on the FG lot (owner 2026-11-18); checklist complete |
| AWAITING\_QA | REJECTED | QA Manager, e-signature | `qa.batch.release` | Reason required; FG lot set REJECTED |

**Quotation:** DRAFT → PENDING\_APPROVAL → APPROVED → SENT → ACCEPTED or LOST. An approved quotation is locked; a change creates a new version.

**Sales order:** DRAFT → CONFIRMED (credit check passes) or ON\_CREDIT\_HOLD → CONFIRMED (Finance Manager) → PARTIALLY\_DISPATCHED → DISPATCHED → CLOSED. CANCELLED only while nothing is dispatched. Invoicing and payment are tracked as amounts (invoiced, paid) on the order, not extra statuses.

**Purchase order:** DRAFT → PENDING\_APPROVAL → APPROVED → PARTIALLY\_RECEIVED → RECEIVED → CLOSED; CANCELLED only before any receipt; cancelling frees its requisition lines (the requisition goes back CONVERTED → SUBMITTED, the PO line keeps the link as `released_pr_line_id`; owner 2026-11-25, answer 4; 0025). A rejected approval returns it to DRAFT; the creator and the submitter approve no step (0023). BULK / FG items are not bought unless setting `purch.allow_bulk_fg_purchase` is on (default off; owner 2026-11-25, answer 6).

**Purchase requisition** (owner 2026-11-25, Q6): DRAFT → SUBMITTED → CONVERTED (every line on a PO) or CANCELLED (nothing ordered); no approval. CONVERTED → SUBMITTED when a cancelled PO frees its lines (owner 2026-11-25, answer 4).

**All posting documents** (GRN, issue, delivery, invoice, receipt, payment, journal): DRAFT → POSTED, or POSTED → REVERSED by a new reversing document. A POSTED row is never updated except to mark it reversed.

## 5. Database schema

About 80 tables in 9 groups, all in one PostgreSQL schema per module (`core`, `inv`, `sales`, `purch`, `qc`, `prod`, `qa`, `fin`). Tables, constraints and triggers are created by hand-written SQL migrations. The Drizzle definitions are written to match them. Columns shown are the ones that carry business rules.

**Conventions for every table**

- Primary key `id BIGINT GENERATED ALWAYS AS IDENTITY`; documents also carry a human number (`doc_no`, e.g. `PO-2026-00042`) from `core.number_series`.
- `company_id` (FK to `core.companies`), `created_at`, `created_by`, `updated_at`, `updated_by` (FK to `core.users`) on all business tables. Seeds and jobs act as the SYSTEM user.
- Quantities `NUMERIC(18,4)`, money amounts `NUMERIC(18,2)`, unit prices and unit costs `NUMERIC(18,6)` (owner 2026-11-25; 0024), exchange rates `NUMERIC(18,6)` (owner 2026-11-25; 0028), percentages and assay `NUMERIC(9,4)`, dates `DATE`, timestamps `TIMESTAMPTZ` stored in UTC, shown in Asia/Karachi.
- Status columns are `TEXT` with a CHECK constraint. Masters are never hard-deleted: items, customers, vendors, AVL entries and formulas have a status (§4 Master statuses); the other masters have an `is_active` switch.
- Foreign keys everywhere, `ON DELETE RESTRICT`.

| Group | Tables | Key columns and rules |
| --- | --- | --- |
| Core | `companies`, `users`, `user_credentials`, `sessions`, `auth_events`, `roles`, `permissions`, `role_permissions`, `user_roles`, `approval_rules`, `approvals`, `e_signatures`, `status_history`, `idempotency_keys`, `audit_log`, `number_series`, `fiscal_periods`, `attachments`, `settings` | `companies`: one row, Albert Pharmaceuticals. `users`: username (employee code, unique), email (optional), is\_system (SYSTEM user, cannot log in), is\_active, failed\_attempts, locked\_at, password\_changed\_at, must\_change\_password. No password hash on `users`. `user_credentials`: user, password\_hash, set\_at, is\_current; one row per password ever set (used to block reuse of the last 5); **no audit trigger**, so a hash never reaches `audit_log`. `sessions`: user, refresh-token family, current token hash, expires\_at (12 h), revoked\_at, revoke\_reason, IP, user agent. `auth_events`: insert-only; user, username tried, event LOGIN\_OK/LOGIN\_FAIL/LOGOUT/LOCKOUT/UNLOCK/PASSWORD\_CHANGE/ESIGN\_FAIL, IP, at. `audit_log`: table, record\_id, action, old\_data JSONB, new\_data JSONB, changed\_by, changed\_at, reason — insert-only, written by trigger. `e_signatures`: user, meaning, reason, record table/id, signed\_at, IP. `status_history`: entity\_table, entity\_id, from\_status, to\_status, actor, esign\_id, reason, at — insert-only. `idempotency_keys`: key, user, endpoint, request hash, stored response, created\_at; expire after 24 h. `approval_rules`: doc\_type, measure AMOUNT\_PKR/PERCENT/NONE, lower/upper limit as `lower_amount`/`upper_amount` NUMERIC(18,2) or `lower_percent`/`upper_percent` NUMERIC(9,4) (band = above lower, up to and including upper), step\_no (same number = "and", higher = "then"), role; never edited, replaced as a set. `approvals`: document, measure, amount + currency + exchange rate, `measured_amount` NUMERIC(18,2) or `measured_percent` NUMERIC(9,4), requested\_by, status; `approval_steps`: step\_no, role, status, acted\_by, esign. `number_series`: doc\_type, pattern (tokens `{PREFIX}` `{FY}` `{YYYY}` `{YY}` `{SEQ:n}`), reset FISCAL\_YEAR/CALENDAR\_YEAR/NEVER, current period key, next value. `fiscal_periods.status` OPEN/CLOSED; periods close and reopen in order (the CLOSED periods are always the earliest), and reopening needs a Finance Manager e-signature and a reason (owner 2026-11-19, Q2/Q3; 0022). `attachments`: record table/id, file name, content type, size, sha256, storage driver, storage key; never deleted, voided once with a reason (voided_at/by, void_reason; the file is kept; owner 2026-11-19, Q5; 0022); a file on a GMP record (AVL evidence, QC records, batch documents) is voided only with a QA Manager e-signature (`qa.attachment.countersign`, owner 2026-11-25, answer 1; 0025), never the requester's own (two people, SEGREGATION_OF_DUTIES; 0026) |
| Masters | `uoms`, `uom_conversions`, `item_categories`, `items`, `customers`, `customer_addresses`, `vendors`, `approved_sources`, `warehouses`, `locations`, `products`, `master_formulas`, `master_formula_lines`, `price_lists`, `price_list_lines`, `tax_codes` | `items.type` RM/PM/API/EXCIPIENT/BULK/FG/SPARE/CONSUMABLE; `items.status` DRAFT/ACTIVE/INACTIVE (is_active generated = ACTIVE); shelf\_life\_days, retest\_days, is\_controlled, storage\_zone, tax\_code\_id (sales tax per item, not one global rate). `approved_sources`: vendor + item + manufacturer + manufacturing site, status APPROVED/BLOCKED, approved\_by (QA). `products`: FG item, registration\_no, customer\_id (null = own brand), artwork version. `master_formulas`: product, version, batch\_size, status DRAFT/APPROVED/OBSOLETE. Lines: item, qty\_per\_batch, uom, is\_api, is\_filler, assay\_basis (AS\_IS/DRIED) |
| Inventory | `lots`, `stock_movements`, `stock_balances`, `stock_reservations`, `stock_adjustments`, `stock_adjustment_lines` | `lots`: item, lot\_no, mfr\_batch\_no, manufacturer, mfg/expiry/retest dates, assay\_pct, water\_pct, status, owner\_type OWN/CUSTOMER, owner\_customer\_id, unit\_cost. `stock_movements` is the immutable ledger: type, lot, from/to location, qty (signed), unit\_cost, value, ref\_doc\_type/id, reason\_code, posted\_at. `stock_balances` (lot, location, qty) is updated in the same transaction, with CHECK qty >= 0. Each ledger row touches one location (inbound: to\_location, qty > 0; outbound: from\_location, qty < 0; a transfer is an out + in pair); balances are written only by the ledger trigger; `stock_reservations` hold quantity per lot and document line and never exceed the lot's stock (decisions 18-11-2026, M2 task 5). Lot status history lives in `core.status_history` |
| Sales | `quotations`, `quotation_lines`, `sales_orders`, `sales_order_lines`, `delivery_orders`, `delivery_order_lines`, `gate_passes`, `sales_invoices`, `sales_invoice_lines`, `fbr_submissions`, `customer_receipts`, `receipt_allocations`, `sales_returns` | Order line links quotation version and price. Delivery lines carry lot\_id. `fbr_submissions`: invoice, request JSONB, response JSONB, fbr\_invoice\_no, status PENDING/SUCCESS/FAILED, attempts |
| Procurement | `purchase_requisitions`, `pr_lines`, `purchase_orders`, `po_lines`, `grns`, `grn_lines`, `landed_cost_types`, `landed_costs`, `landed_cost_inputs`, `landed_cost_allocations`, `vendor_invoices`, `vendor_invoice_lines`, `vendor_payments`, `payment_allocations` | PO: currency, exchange\_rate, incoterm. GRN line creates a lot. `landed_costs` (0029): GRN, charge type (capitalise flag, tax role), PKR amount, basis VALUE / WEIGHT / GD_AMOUNTS (inputs per PO line), allocations per GRN line (held → lot, consumed → price variance); charge types `pkr_only` (0031). `vendor_invoices` (0031): GOODS (one PO, lines = GRN lines) or CHARGES (lines = posted landed costs); currency, invoice-date rate, totals in the currency and total_pkr; lines keep the match result and the PKR split (cleared + price variance + exchange). `vendor_payments`: one vendor and currency, foreign amount settled, gross PKR paid, WHT section / rate / amount, net, filer status copied, carrying PKR and exchange difference; `payment_allocations` per invoice. Vendors: WHT section, filer (ATL) + checked-on date (0031) |
| QC | `qc_specs`, `qc_spec_tests`, `qc_samples`, `qc_results`, `coas` | Spec per item, versioned, approved by QC Manager. Test: name, method, min, max, text\_limit, unit, is\_assay, is\_water. Result: value, pass (computed), entered\_by, reviewed\_by. Original results are never updated; a re-test is a new row |
| Production | `production_orders`, `production_order_materials`, `batch_stages`, `stage_signoffs`, `production_outputs`, `resource_logs` | Order: batch\_no, product, formula version, batch\_size, customer\_id (toll), sales\_order\_line\_id. Materials: theoretical\_qty, adjusted\_qty, issued\_qty per lot. Output: FG lot, qty, yield\_pct. `resource_logs`: line, machine\_hours, labour\_hours |
| QA | `deviations`, `batch_releases` | Deviation: batch, class MINOR/MAJOR/CRITICAL, status OPEN/CLOSED, root cause, closed\_by. Release: production order, checklist JSONB, decision, e-signature id |
| Finance | `accounts`, `cost_centers`, `posting_rules`, `journal_entries`, `journal_lines`, `bank_accounts`, `bank_statement_lines`, `batch_costs`, `cost_rates` | Journal entry: date, period, source\_type/id, status, reversal\_of; manual journal vouchers (source MANUAL, no event) number from the `JV` series, system journals posted by modules from `SJ` and always name their source document and event. Lines: account, debit, credit, cost\_center, customer\_id, vendor\_id, production\_order\_id, tax\_code\_id; a line booking a WITHHOLDING code whose rate Finance has not confirmed (`is_placeholder`) cannot be posted (`TAX_RATE_NOT_CONFIRMED`); CHECK one of debit/credit is zero; trigger ensures entry balances. `cost_rates`: per line machine-hour rate, labour rate, overhead % |

**Disposal columns** (0020): `core.e_signatures.subject` (what was signed for; NULL when only the record is signed) and `inv.stock_movements.witness_esign_id` (required on DESTROY / RETURN_TO_VENDOR rows, forbidden on all others, unique). See §4 **Disposal witness**.

**Database-enforced rules** (not only in code): balances never negative; a disposal has a QA witness signature (0020); journal entries balance; no insert into a closed period; no UPDATE/DELETE on posted rows, audit log, auth events, status history or stock movements (trigger raises an error).

## 6. Inventory ledger and GL posting rules

Every business event calls the inventory engine and the posting engine inside one transaction; if either fails, nothing is saved. Valuation is **lot-actual cost**: each lot carries its own unit cost (receipt price + allocated landed cost), and every issue, dispatch, adjustment and disposal is valued at that lot's cost. A lot's unit cost is a rate with 6 decimals (owner 2026-11-25; 0024); a movement is valued at qty × lot unit cost rounded half-up to 2 decimals; the movement that empties a lot takes the residual so the lot ends at exactly zero; an FG lot is booked at output at the given provisional value (unit cost = value ÷ quantity) and brought to the actual batch cost at batch close; the inventory GL balance always equals the sum of the ledger movement values (owner decision 2026-11-18, "Rounding of stock values"; DB guard 0015). A lot with zero quantity always has zero value: if a movement or reversal leaves paisa on an empty lot, the posting engine sweeps them to the Rounding difference account in the same transaction (owner decision 2026-11-18, "Rounding sweep"; DB guard 0016). There is no item-level moving average; an item's average cost for reports is computed from its lots (decision 18-11-2026; Finance to confirm under IAS 2). Customer-owned (toll) material moves in the stock ledger at zero value and creates **no** journal entry.

**Value-only adjustment** (owner decision 2026-11-18, Q8; DB guard 0017): a ledger row `VALUE_ADJUSTMENT` with quantity 0 and no location changes a lot's value (never its stock) and resets the lot's unit cost to its new value ÷ quantity, rounded half-up to 6 decimals. It is refused on a lot with zero quantity (`LOT_EMPTY`), when it would take the lot's value below zero (`LOT_VALUE_NEGATIVE`) and on customer-owned stock. Its reason decides its GL event: `BATCH_CLOSE` → FG cost adjustment; M3 landed cost reuses it with its own reason. A lot's unit cost changes only through such a row (checked at commit). Batch close is final: neither the adjustment nor the batch's output is reversed afterwards.

**Landed cost** (owner decision 2026-11-19, Q21; built in M3). Each landed-cost charge type carries a **capitalise yes/no** flag and its own account.
- **Capitalised** (into lot cost): customs duty, additional customs duty, regulatory duty, freight, insurance, clearing/handling. **Not capitalised**: import-stage sales tax (to the input tax account) and income tax collected at import (to the advance tax account).
- **Allocation** per charge type: duties by GRN line from the GD amounts when entered, else by value; freight and other charges by value (default) or by weight.
- **Charges known at receipt** are entered with the GRN, so the lot is received at its full cost. **Later bills** use the value-only adjustment above, with reason `LANDED_COST`: the lot's value rises by the share for the quantity it still holds. The share already consumed goes to a price-variance account (placeholder, Finance to confirm). If the lot is fully consumed, the whole charge goes there and the lot gets no row.
- The posting date is the charge's date, which must fall in an open period (rule 11).
- **Currency** (owner 2026-11-25): a charge carries a currency; non-PKR converts at the rate-table rate for the charge date (latest on or before, max age setting). Currency, foreign amount, rate and PKR amount are stored.
- **Corrections** (owner 2026-11-25): a new landed-cost document with a negative amount, linked to the original, allocated with the same basis and split between held stock and price variance at its date; never takes a lot's value below zero; reason + Finance Manager e-signature, creator ≠ signer. A GRN whose lots are untouched is reversed together with its posted charges (same transaction).

**FG lot valuation** (owner decision 2026-11-18, Q8, Option A): the FG lot is created in QUARANTINE when output is recorded at packing, valued at the actual cost of the materials issued to the batch so far. At batch close the difference between the actual batch cost and the value booked at output (conversion + true-up) is added to the lot as a value-only adjustment, in the same transaction as the close journal; stock that left the lot before close (e.g. samples) keeps its provisional value, and the adjustment applies to the stock still held.

Accounts are not hard-coded: `posting_rules` maps (event, account role, item category) to an account, so Finance can change the chart without code. Each event uses the account roles listed in `PostingEventRoles` (`packages/shared/src/enums.ts`); a rule with no item category is the default for every category. Journal entries are created DRAFT and posted only when balanced (≥ 2 lines, debits = credits); posted lines never change (decisions 18-11-2026, M2 task 4).

| Event | Stock effect | Debit | Credit |
| --- | --- | --- | --- |
| GRN posted (own stock) | + lot in QUARANTINE at PO price | Inventory (RM/PM/API by category) | GRNI — goods received not invoiced |
| Landed cost added (capitalised charge types, Q21) | With the GRN: part of the lot's receipt cost. Later bill: value-only row (reason LANDED_COST) on the lot for the share still held | Inventory (share still held); Price variance (share consumed, or all of it if the lot is fully consumed) | Landed-cost clearing / customs & freight payable |
| Import taxes (not capitalised, Q21) — event `IMPORT_TAX` (0029) | — | Input sales tax (import stage); Advance income tax (collected at import) | Landed-cost clearing |
| Vendor invoice posted — GOODS (3-way match; 0031) | — | GRNI (receipt value of the quantity matched); Input sales tax; Price variance (price difference, extra quantity); Exchange gain/loss (matched qty × PO price × invoice rate − GRNI; owner Q4) — either side | Accounts payable (vendor), at the invoice-date rate |
| Vendor invoice posted — CHARGES (owner Q3; 0031) | — | Landed-cost clearing (in proportion to what is open on the charge); Input sales tax; Exchange gain/loss — either side | Accounts payable (vendor) |
| Vendor payment (0031) | — | Accounts payable (the invoices' carrying PKR); Exchange gain/loss (PKR paid − carrying; owner Q4) — either side | Bank (net); WHT payable (vendor's WHT section: filer or non-filer rate × the code's base, 0032; refused while the rates or base are not confirmed) |
| Vendor debit note — PRICE_CLAIM / SHORT_SUPPLY, event `VENDOR_DEBIT_NOTE` (owner 2026-11-26; 0032) | — | Accounts payable (vendor; at the invoice's rate) | Price variance; Input sales tax (at the invoice line's rate) |
| Material issued to batch | − lot, + batch WIP | WIP (production order) | Inventory |
| Material returned from floor | + lot | Inventory | WIP |
| Conversion absorbed at batch close | — | WIP | Labour absorbed; Machine overhead absorbed |
| FG output verified (checker, `prod.output.verify`) | + FG lot in QUARANTINE at the provisional value (materials issued so far) | FG inventory | WIP |
| FG cost adjustment at batch close (owner Q8) | Value-only row: lot value + (actual batch cost − value booked at output) | FG inventory (WIP if the batch cost is lower) | WIP (FG inventory if lower) |
| Dispatch posted | − FG lot (batch closed) | Cost of goods sold | FG inventory |
| Customer return received — `SALES_RETURN_RECEIPT` (owner Q9) | + new return lot in HOLD at a returns area; value = original lot's unit cost × returned qty, same rounding (reverses the COGS taken at dispatch). Toll stock: zero value, no journal | FG inventory | Cost of goods sold |
| Sales invoice (own product) | — | Accounts receivable | Sales revenue; Output sales tax |
| Sales invoice (toll conversion) | — | Accounts receivable | Conversion revenue; Output sales tax |
| Customer receipt | — | Bank; WHT receivable (deducted by customer) | Accounts receivable |
| Stock adjustment / write-off | ± lot | Inventory loss expense (or Inventory) | Inventory (or Inventory gain) |
| Rejected lot destroyed (QA witness, §4) | − lot; when empty, the lot becomes DESTROYED in the same transaction | Rejection write-off expense | Inventory |
| Rejected lot returned to vendor (QA witness, §4) | − lot; when empty, the lot becomes RETURNED in the same transaction | Accounts payable (debit note, RETURN_TO_VENDOR: billed value + input tax) | Inventory (the lot's value); Price variance (billed − lot value, either side); Input sales tax (0032) |
| QC sample taken — event `QC_SAMPLE` (owner 2026-11-27; 0035) | − lot (SAMPLE_ISSUE, TEST or RETENTION) from a QUARANTINE / UNDER_TEST lot, at the lot cost; toll stock zero, no journal | QC sample expense (placeholder 6400) | Inventory |
| Rounding sweep (empty lot left with paisa) | Value-only row, lot value to zero | Inventory (paisa below zero) or Rounding difference (paisa above zero) | Rounding difference or Inventory |
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
- Exchange rates (owner 2026-11-25, Q4): `fin.exchange_rates`, one rate per currency and day (PKR per 1 unit, NUMERIC(18,6) since 0028, with its source), kept by the Finance Manager (`fin.rate.manage`), audited. A document uses the latest rate on or before its own date, no older than setting `fin.rate.max_age_days` (default 3), and copies the rate and its date; older or none → RATE\_MISSING (owner 2026-11-25, answer 3). The PO takes it at submit to choose the approval band (indicative); the GRN and the invoice convert at their own dates.
- Vendor invoice (M3 task 5, 0031; owner Q3, Q4, Q5): entered and posted by the Accountant (`fin.invoice.manage`) on the invoice date. GOODS bills GRN lines of one PO in its currency; per line the price is matched to the PO line (setting `purch.invoice.price_tolerance_pct`, default 2) and the cumulative quantity billed to the GRN line (`purch.invoice.qty_tolerance_pct`, default 0). Outside either → MATCH_EXCEPTION: a Finance Manager (`fin.invoice.match_release`) releases it with an e-signature and a reason (creator ≠ releaser), which posts it, or returns it to DRAFT. CHARGES bills posted landed costs of the vendor ("Pakistan Customs" is an ordinary vendor), in the charge's currency, never beyond what is open (AMOUNT_EXCEEDS_OPEN). The same vendor invoice number is entered once per vendor. A fully received PO whose receipts are all billed moves to CLOSED; a GRN on an invoice is no longer reversed (IN_USE). Charge types CD, ACD, RD, IMPORT_ST, IMPORT_IT are PKR only and GD amounts are in PKR (owner 2026-11-26; CURRENCY_NOT_ALLOWED).
- Vendor payment (M3 task 5, 0031): the AP Officer (`fin.payment.manage`) drafts it against POSTED invoices of one vendor and currency (foreign: the PKR paid is entered), submits it to the approval matrix (VENDOR_PAYMENT, Finance Manager; creator and submitter approve no step), and posts it on the payment date once APPROVED, with the bank reference / cheque number (0032). WHT = the WHT code's filer (ATL) or non-filer rate, by the vendor's filer status copied onto the payment (never checked = non-filer), × the code's base (gross PKR incl. or excl. sales tax, per code); TAX_RATE_NOT_CONFIRMED until Finance has confirmed the rates and the base. A filer status checked more than setting `purch.vendor.filer_check_max_days` (30) before the approval is a warning the approver acknowledges (ACKNOWLEDGEMENT_REQUIRED). Vendor ledger = the GL payables lines of the vendor; AP ageing = open invoices by days past the due date (invoice date + payment terms), as of a date: the payments and debit notes in force that day.
- Reversals (owner 2026-11-26 / 2026-11-27; 0032, 0033): a Finance Manager reverses a POSTED vendor invoice (`fin.invoice.reverse`), payment (`fin.payment.reverse`) or debit note (`fin.debit_note.reverse`) with an e-signature (REVERSED) and a reason; the journal is mirrored on the reversal day (an open period, rule 11). The unwinding order is payment / debit note → invoice: an invoice is not reversed while a payment or debit note in force names it (IN_USE). A reversed invoice frees its GRN lines, charges and vendor number and re-opens a CLOSED PO to RECEIVED; a reversed payment or debit note re-opens the invoice amounts.
- Debit notes (owner 2026-11-26; 0032), DN-{FY}-{SEQ:5}, against a POSTED GOODS invoice, at its rate, dated on or after it: PRICE_CLAIM (amount per line, excl. tax; tax at the line's rate), SHORT_SUPPLY (quantity billed beyond what was received), RETURN_TO_VENDOR (one REJECTED lot, posted by the Warehouse Manager with a QA witness; rule 1). DRAFT → PENDING_APPROVAL (matrix DEBIT_NOTE, Finance Manager; creator / submitter ≠ approver) → APPROVED → POSTED. Never more than is open on the line or the invoice (AMOUNT_EXCEEDS_OPEN). Reversal of a return also reverses its movement (stock back into the lot, QA witness, 0020) while the lot is still REJECTED; a lot the return emptied is RETURNED and never moves again (LOT_RETURN_NOT_REVERSIBLE).

- GRN (owner 2026-11-25; 0028): refuses expired material, a retest date passed and an mfg date after the GRN date; setting `purch.grn.min_shelf_life_pct` (default 0 = off) refuses a line whose remaining shelf life ((expiry − GRN date) ÷ (expiry − mfg), or ÷ the item's shelf life without an mfg date) is below that percent (SHELF\_LIFE\_TOO\_SHORT). A DRAFT GRN is cancelled with a reason (`purch.grn.post`). A POSTED GRN is reversed (`purch.grn.reverse`, Warehouse Manager, e-signature + reason) only while every lot is untouched (no sample taken, no movement but the receipt, no status change, no reservation), else GRN\_LOTS\_IN\_USE (route: QC rejection, then return to vendor). The reversal mirrors the receipts and the GRN\_RECEIPT journal (dated the reversal day), cancels the sample requests, gives back the PO quantities and restores the PO status in one transaction; the lot record stays at zero stock and is out of the QC queue.

### 7.6 QC

- Screens: specifications, sample queue, result entry, review queue, lot disposition, CoA print.
- Rules: sample auto-created on GRN and on FG output; pass/fail computed from limits; a failed result on an FG lot moves the lot UNDER_TEST → HOLD automatically under `qc.result.enter` — QC never rejects an FG lot, QA does (`qa.lot.reject_fg`) after the OOS investigation (owner 2026-11-18, §4); reviewer must differ from the analyst; disposition writes assay and water onto the lot; a failed result cannot be edited, only re-tested as a new row with a reason.

### 7.7 Production

- Screens: production orders, release check (shows any material short or not approved), material requirement with potency calculation, issue by scan, stage execution (sign each stage in order), output and yield, batch close, resource hours.
- Rules: batch number format set in number series (e.g. `AP26-0001`); output/yield has a doer and a checker (§4, owner 2026-11-18): the doer signs (`prod.stage.sign`), a different user verifies (`prod.output.verify`), and only the verification creates the FG lot and posts FG_OUTPUT; stages follow the formula's routing and cannot be signed out of order; yield outside the product's range (e.g. 98–101%) requires a deviation before close.

### 7.8 QA

- Screens: deviations (raise, investigate, close), batch release queue and checklist, AVL approvals, master formula approvals.
- Rules: release button disabled — and the API refuses — while any deviation on the batch is OPEN, any test of the FG lot's pinned spec lacks a reviewed, passing latest result (QC never approves an FG lot; QA releases it from UNDER\_TEST, owner 2026-11-27), or a failed QC result on the FG lot is open (unless the OOS investigation closed it as invalid and a retest passed; owner 2026-11-18). An FG lot whose failure is confirmed is rejected by QA (HOLD → REJECTED, `qa.lot.reject_fg`).

### 7.9 Finished Goods and Dispatch

- Screens: delivery orders from sales orders, FEFO pick list, pick by scan, gate pass, proof of delivery, returns receipt.
- Rules: only RELEASED FG lots; a dispatch goes only to an ACTIVE customer (`CUSTOMER_NOT_ACTIVE`, engine + DB, 0019; owner 2026-11-18), while a return may come from an inactive one; dispatch posting creates the stock move, the COGS entry and the sales invoice draft; returns go into a new HOLD return lot linked to the original lot, at a returns area, valued at the original unit cost (§4, §6; owner 2026-11-18, Q9); a return never exceeds what was dispatched to that customer from the original lot (incl. its re-released return lots) less that customer's earlier returns, so every dispatch and return movement names the customer (0018); QA then re-releases the return lot (`qa.batch.release`, e-signature, mandatory assessment reason) or rejects it (`qa.lot.reject_fg`, e-signature, QA Manager only); the credit note (revenue, tax, receivable) is the sales module's.

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
