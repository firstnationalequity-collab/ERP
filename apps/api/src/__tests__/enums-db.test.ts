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
} from '@albert/shared';
import { databaseUrl } from '../config/env';

const client = new pg.Client({ connectionString: databaseUrl });

/** The string literals allowed by the CHECK constraint(s) on `table.column`, from the column's IN (...) list. */
async function checkValues(table: string, column: string): Promise<string[]> {
  const { rows } = await client.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype = 'c' AND n.nspname = 'core' AND t.relname = $1`,
    [table],
  );
  // e.g. CHECK ((status = ANY (ARRAY['OPEN'::text, 'CLOSED'::text])))
  const own = rows.map((r) => r.def).find((d) => new RegExp(`\\(\\(?${column} = ANY \\(ARRAY\\[`).test(d));
  if (!own) throw new Error(`No IN-list CHECK on core.${table}.${column}`);
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
];

beforeAll(async () => {
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe('shared enums match the database CHECK constraints', () => {
  it.each(cases)('core.%s.%s', async (table, column, values) => {
    expect(await checkValues(table, column)).toEqual([...values].sort());
  });
});
