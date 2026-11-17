# Decisions log

Record every design choice not already covered by `architecture.md`. Newest first.

| Date | Decision | Why | Decided by |
| --- | --- | --- | --- |
| 2026-11-17 | Modular monolith on PostgreSQL + Express + React + Node, TypeScript strict | Stock, quality status and GL must change in one transaction | Team |
| 2026-11-17 | Moving weighted-average valuation per item, cost held on lot | Simple, auditable; PDF allows choice | Team |
| 2026-11-17 | CEO view-only in Phase 1; approval matrix configurable so CEO can be added later | Business request | Team |
| 2026-11-17 | Approval limits are placeholders (PO ≤500k Purchase Mgr; ≤5M Finance Mgr; >5M both) | Finance to confirm | Team |
| 2026-11-17 | Drizzle ORM; triggers/constraints in hand-written SQL migrations | Full control of transactions and DB rules | Team |
