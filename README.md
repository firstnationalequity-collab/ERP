# Albert Pharma ERP

Integrated ERP for Albert Pharmaceuticals — PostgreSQL, Express, React, Node (TypeScript).
Design: `docs/architecture.md` · Plan: `docs/build-plan.md` · Progress: `docs/progress.md` · Agent rules: `CLAUDE.md`.

## Prerequisites
- Node.js 26 (pinned in `.nvmrc`), pnpm 10 (`npm i -g pnpm`)
- Docker Desktop (for the local PostgreSQL)
- VS Code with the Claude Code extension

## First run
```bash
cp .env.example .env          # then set real secrets
pnpm install
pnpm db:up                    # starts PostgreSQL 16 in Docker (also creates albert_erp_test)
pnpm db:migrate               # applies apps/api/src/db/migrations/*.sql
pnpm test                     # health test + database guard tests
pnpm dev                      # API on :4000, web on :5173
```
Open http://localhost:5173 — it should say "API status: ok".

## Seeding
- `pnpm db:seed` — the real seed, safe everywhere (idempotent; acts as SYSTEM): permissions, roles from
  `docs/roles.md`, number series, placeholder approval matrix, PLACEHOLDER chart / posting rules / tax codes, and the
  first admin from `INITIAL_ADMIN_PASSWORD` (forced change at first login).
- `pnpm db:seed:dev` — **local development only.** Refuses unless `NODE_ENV=development` and the database name in
  `DATABASE_URL` does not contain "prod". Runs `db:seed`, then:
  - creates one demo user per role, named `demo.<role code in lower case>` (e.g. `demo.finance_manager`,
    `demo.qa_manager`, `demo.storekeeper`), all with the password in `DEV_DEMO_PASSWORD` (`.env`) and no forced
    password change;
  - signs in as `demo.finance_manager` and creates the FY 2026-27 periods through the normal periods service, so
    each period's first status is recorded under that person (rule 7), then signs out.

  Running it again changes nothing. Never set `DEV_DEMO_PASSWORD` on staging or production.

## Building with the agent
1. Open this folder in VS Code and start a Claude Code chat.
2. Run `/milestone M1`. The agent reads the docs, proposes a plan, and waits for your OK.
3. Approve, let it build task by task; review each change.
4. Run `/check-rules` before you close a milestone, then commit:
   `git commit -m "M1: foundation"` and tag it `git tag m1`.
5. Next session: `/milestone M2`, and so on. `docs/progress.md` keeps the agent oriented between sessions.

Tips:
- One milestone per chat session keeps the agent focused; start a fresh chat for each milestone.
- If the agent wants to change a rule in CLAUDE.md, it must ask you first — say no unless you agree.
- Commit after every finished task so you can roll back a bad change.

## Layout
```
apps/api        Express API (modules, engines, migrations, tests)
apps/web        React app (Ant Design)
packages/shared Enums, permission keys, error codes, Zod schemas
docs/           Architecture, build plan, progress, decisions
.claude/        Agent slash commands (/milestone, /check-rules)
infra/          Local DB init
```
