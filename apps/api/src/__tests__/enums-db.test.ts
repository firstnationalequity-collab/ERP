// CLAUDE.md: "Status values only from packages/shared/src/enums.ts, mirrored by DB CHECK constraints".
// This reads each CHECK constraint from PostgreSQL and compares its values with the shared enum, so the
// code and the database cannot drift apart (rules review F).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApprovalMeasure,
  ApprovalStatus,
  ApprovalStepStatus,
  AuditAction,
  AuthEventType,
  FiscalPeriodStatus,
  IdempotencyStatus,
  NumberSeriesReset,
  PermissionClass,
  SessionRevokeReason,
  SignatureMeaning,
  StorageDriver,
  ItemStatus,
  ItemType,
  PartyStatus,
  ApprovedSourceStatus,
  FormulaStatus,
  AssayBasis,
  StorageZone,
  TaxKind,
  AddressType,
  AccountType,
  PostingEvent,
  AccountRole,
  PostingStatus,
  LotStatus,
  StockOwner,
  StockMovementType,
  LotSource,
} from '@albert/shared';
import { databaseUrl } from '../config/env';

const client = new pg.Client({ connectionString: databaseUrl });

/** The string literals allowed by the CHECK constraint(s) on `table.column`, from the column's IN (...) list. */
async function checkValues(qualified: string, column: string): Promise<string[]> {
  const { rows } = await client.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype = 'c' AND n.nspname = $1 AND t.relname = $2`,
    qualified.includes('.') ? qualified.split('.') : ['core', qualified],
  );
  // e.g. CHECK ((status = ANY (ARRAY['OPEN'::text, 'CLOSED'::text])))
  // Anchored at the start, so a CHECK that only mentions the column inside a CASE or an OR is not taken for its list.
  const own = rows.map((r) => r.def).find((d) => new RegExp(`^CHECK \\(\\(?${column} = ANY \\(ARRAY\\[`).test(d));
  if (!own) throw new Error(`No IN-list CHECK on ${qualified}.${column}`);
  return [...own.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!).sort();
}

const cases: [string, string, readonly string[]][] = [
  ['approvals', 'status', ApprovalStatus],
  ['approvals', 'measure', ApprovalMeasure],
  ['approval_rules', 'measure', ApprovalMeasure],
  ['approval_steps', 'status', ApprovalStepStatus],
  ['audit_log', 'action', AuditAction],
  ['auth_events', 'event', AuthEventType],
  ['fiscal_periods', 'status', FiscalPeriodStatus],
  ['idempotency_keys', 'status', IdempotencyStatus],
  ['number_series', 'reset', NumberSeriesReset],
  ['permissions', 'class', PermissionClass],
  ['sessions', 'revoke_reason', SessionRevokeReason],
  ['e_signatures', 'meaning', SignatureMeaning],
  ['attachments', 'storage_driver', StorageDriver],
  ['master.items', 'type', ItemType],
  ['master.items', 'storage_zone', StorageZone],
  ['master.items', 'status', ItemStatus],
  ['master.locations', 'storage_zone', StorageZone],
  ['master.tax_codes', 'kind', TaxKind],
  ['master.customers', 'status', PartyStatus],
  ['master.vendors', 'status', PartyStatus],
  ['master.customer_addresses', 'type', AddressType],
  ['master.approved_sources', 'status', ApprovedSourceStatus],
  ['master.master_formulas', 'status', FormulaStatus],
  ['master.master_formula_lines', 'assay_basis', AssayBasis],
  ['fin.accounts', 'type', AccountType],
  ['fin.posting_rules', 'event', PostingEvent],
  ['fin.posting_rules', 'account_role', AccountRole],
  ['fin.journal_entries', 'event', PostingEvent],
  ['fin.journal_entries', 'status', PostingStatus],
  ['inv.lots', 'status', LotStatus],
  ['inv.lots', 'owner_type', StockOwner],
  ['inv.lots', 'source', LotSource],
  ['inv.stock_movements', 'movement_type', StockMovementType],
];

beforeAll(async () => {
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe('shared enums match the database CHECK constraints', () => {
  it.each(cases)('%s.%s', async (table, column, values) => {
    expect(await checkValues(table, column)).toEqual([...values].sort());
  });
});
