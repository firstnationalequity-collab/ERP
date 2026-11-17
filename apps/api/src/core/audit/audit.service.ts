// Audit trail viewer (docs/architecture.md §7.1). Read-only; core.audit.view is checked by the routes.
// The audit log itself is written only by database triggers (rule 6).
import type {
  AuditEntryDto,
  AuditFieldChange,
  AuditLogQuery,
  AuthEventDto,
  AuthEventQuery,
  ESignatureDto,
  Page,
  StatusHistoryDto,
} from '@albert/shared';
import { db } from '../../db/client';
import type { AuthContext } from '../auth/auth.service';
import * as repo from './audit.repo';

/** Bookkeeping columns that change on every update and say nothing on their own. */
const NOISE = new Set(['updated_at', 'updated_by']);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Field-by-field difference of an UPDATE row (old → new). */
export function fieldChanges(oldData: unknown, newData: unknown): AuditFieldChange[] {
  const o = asRecord(oldData);
  const n = asRecord(newData);
  if (!o || !n) return [];
  const keys = [...new Set([...Object.keys(o), ...Object.keys(n)])].filter((k) => !NOISE.has(k)).sort();
  return keys
    .filter((k) => JSON.stringify(o[k]) !== JSON.stringify(n[k]))
    .map((k) => ({ field: k, old: o[k] ?? null, new: n[k] ?? null }));
}

export async function listAudit(_auth: AuthContext, query: AuditLogQuery): Promise<Page<AuditEntryDto>> {
  const { page, pageSize, ...filter } = query;
  const { rows, total } = await repo.auditEntries(db, filter, pageSize, (page - 1) * pageSize);
  return {
    items: rows.map(({ a, username, fullName }) => ({
      id: a.id,
      table: a.tableName,
      recordId: a.recordId,
      action: a.action,
      changedAt: a.changedAt.toISOString(),
      changedBy: a.changedBy ? { id: a.changedBy, username: username ?? '', fullName: fullName ?? '' } : null,
      reason: a.reason,
      changes: a.action === 'UPDATE' ? fieldChanges(a.oldData, a.newData) : [],
      oldData: asRecord(a.oldData),
      newData: asRecord(a.newData),
    })),
    total,
    page,
    pageSize,
  };
}

export async function listAuditTables(): Promise<string[]> {
  return repo.auditTables(db);
}

export async function recordStatusHistory(auth: AuthContext, table: string, recordId: string): Promise<StatusHistoryDto[]> {
  const rows = await repo.statusHistoryOf(db, auth.companyId, table, recordId);
  return rows.map((r) => ({
    id: r.h.id,
    fromStatus: r.h.fromStatus,
    toStatus: r.h.toStatus,
    at: r.h.at.toISOString(),
    actor: { id: r.h.actorId, fullName: r.actorName },
    reason: r.h.reason,
    signature: r.signMeaning && r.signName ? { meaning: r.signMeaning, signerName: r.signName } : null,
    witness: r.witnessMeaning && r.witnessName ? { meaning: r.witnessMeaning, signerName: r.witnessName } : null,
  }));
}

export async function recordSignatures(auth: AuthContext, table: string, recordId: string): Promise<ESignatureDto[]> {
  const rows = await repo.signaturesOf(db, auth.companyId, table, recordId);
  return rows.map((s) => ({
    id: s.id,
    signerUsername: s.signerUsername,
    signerName: s.signerName,
    meaning: s.meaning,
    reason: s.reason,
    signedAt: s.signedAt.toISOString(),
  }));
}

export async function listAuthEvents(auth: AuthContext, query: AuthEventQuery): Promise<Page<AuthEventDto>> {
  const { page, pageSize, ...filter } = query;
  const { rows, total } = await repo.authEventRows(db, auth.companyId, filter, pageSize, (page - 1) * pageSize);
  return {
    items: rows.map((e) => ({
      id: e.id,
      at: e.at.toISOString(),
      event: e.event,
      username: e.username,
      userId: e.userId,
      actorId: e.actorId,
      ip: e.ip,
      details: e.details ?? null,
    })),
    total,
    page,
    pageSize,
  };
}
