# Albert Pharma ERP — agent rules

Production ERP for Albert Pharmaceuticals, a DRAP-regulated GMP plant (tablets, capsules, toll manufacturing) in Pakistan.
Real users, real money, real audits. Correctness beats speed. Never fake data, never stub a business rule.

## Read first, every session
1. `docs/progress.md` — which milestone we are on and what is already done.
2. `docs/build-plan.md` — the current milestone's tasks and "Done when" checks.
3. `docs/architecture.md` — the full design (rules, statuses, schema, posting rules, module specs).
4. `docs/decisions.md` — choices made during the build.
5. `docs/roles.md` — roles and their permission keys (when touching permissions or roles).

Work only on the current milestone. If something needed is missing from the docs, ask before inventing it.

## Stack
pnpm monorepo, TypeScript strict everywhere.
- Node 26 everywhere (`.nvmrc`, `engines`, Docker images on the same major).
- `apps/api`: Express 4, Drizzle ORM (query builder only), PostgreSQL 16, Zod, pg-boss, pino, Vitest + Supertest.
- Migrations: hand-written SQL in `apps/api/src/db/migrations` is the only migration source. The Drizzle schema is written to match it. No drizzle-kit.
- `apps/web`: React 18, Vite, Ant Design, TanStack Query, React Router, React Hook Form + Zod.
- `packages/shared`: Zod schemas, enums, permission keys — the single source used by API and web.

## Non-negotiable rules
1. Only QC approves or rejects material lots. Only QA may place or lift HOLD and release batches/FG lots. Warehouse Manager may only move a REJECTED lot to DESTROYED or RETURNED, with a QA witness e-signature. No other role, including CEO and admin, can change a lot or batch status.
2. Issue/reserve only APPROVED lots; dispatch only RELEASED FG lots. Check in the service AND in the DB.
3. No negative stock (CHECK constraint on `inv.stock_balances`).
4. Posted documents are immutable. Corrections are reversal documents. Never UPDATE/DELETE posted rows.
5. Every stock movement and invoice posts to the GL in the SAME transaction via `engines/posting`.
6. Audit trail is written by DB triggers on every business table. Never bypass or disable it.
7. Status changes only through explicit action endpoints using `core/transition` with an allowed-moves map; the map holds the permission key for each individual move, and every move writes `core.status_history`.
8. E-signature actions re-verify the password and store meaning + reason (`core/esign`).
9. Segregation of duties (creator ≠ approver ≠ receiver) lives in services and returns 403 with an error code.
10. Money `NUMERIC(18,2)`, quantities `NUMERIC(18,4)`, rates/assay `NUMERIC(9,4)`. Use `decimal.js` in TS. Never JS floats for money or quantity.
11. Closed fiscal periods reject postings.
12. Customer-owned (toll) stock: quantity only, zero value, no GL entry.

## Code layout
`routes` (validate + permission) → `service` (business rules, one transaction) → `repo` (queries only).
Modules talk to each other only through exported service functions — never another module's tables.
All stock changes go through `engines/inventory`. All journals go through `engines/posting`.
DB schemas per module: `core`, `inv`, `sales`, `purch`, `qc`, `prod`, `qa`, `fin`.

## Conventions
- REST under `/api/v1/<module>/<resource>`. Actions: `POST /:id/submit | /approve | /reject | /post | /reverse | /release`. Never change status with PATCH.
- Error shape `{ error: { code, message, details } }`; codes SCREAMING_SNAKE (`LOT_NOT_APPROVED`). Throw `AppError` from `core/errors`.
- HTTP: 400 validation, 401, 403 permission/segregation, 404, 409 state conflict, 422 business rule, 500 `FILE_INTEGRITY_FAILED` (a stored file no longer matches its checksum: never served).
- `Idempotency-Key` header on every posting action.
- `SELECT ... FOR UPDATE` on lots and balances inside posting transactions.
- Every table: `id BIGINT GENERATED ALWAYS AS IDENTITY`, `company_id` (FK `core.companies`), `created_at/by`, `updated_at/by` (FK `core.users`). Documents get `doc_no` from `core.number_series`. Seeds and jobs act as the SYSTEM user.
- `Idempotency-Key` is stored in `core.idempotency_keys` (24 h). The same key with a different request returns `DUPLICATE_REQUEST`.
- Password hashes live only in `core.user_credentials`, which has no audit trigger. A hash must never reach `audit_log`, logs or API responses.
- Role administration: nobody changes their own role assignments; a role holding an admin key never holds an action key; changes to roles with `qc.*` / `qa.*` action keys need a QA Manager e-signature.
- Timestamps UTC in DB (`TIMESTAMPTZ`); display Asia/Karachi; dates DD-MM-YYYY; currency PKR.
- Permission keys only from `packages/shared/src/permissions.ts`.
- Status values only from `packages/shared/src/enums.ts`, mirrored by DB CHECK constraints.

## Workflow for every task
1. Read the milestone section in `docs/build-plan.md` and the matching parts of `docs/architecture.md`.
2. Hand-written SQL migration first (tables, constraints, triggers in `apps/api/src/db/migrations`), then the matching Drizzle schema.
3. Service with tests for every rule: the happy path AND each refusal.
4. Routes, then web pages.
5. `pnpm typecheck` and `pnpm test` must pass before you say "done".
6. Tick the finished tasks in `docs/progress.md`; record any design choice in `docs/decisions.md`.

## Never
- Never add features outside the current milestone without asking.
- Never weaken a rule or delete a test to make tests pass. Fix the code or ask.
- Never commit secrets. Config comes from env vars validated in `apps/api/src/config/env.ts`.
- Never use `any`, `@ts-ignore`, or disable lint rules to get past an error.
- Never run destructive DB commands (drop, truncate, reset) against anything except the local/test database.
