// Read-only queries over the audit trail, status history, e-signatures and auth events.
import { and, asc, count, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { env } from '../../config/env';
import type { Queryable } from '../../db/client';
import { auditLog, authEvents, eSignatures, statusHistory, users } from '../../db/schema/core';

/** Start of a business day ('YYYY-MM-DD') in the company time zone, as a timestamptz. */
const dayStart = (date: string) => sql`(${date}::date)::timestamp AT TIME ZONE ${env.COMPANY_TIMEZONE}`;
/** Start of the day after `date` in the company time zone. */
const dayAfter = (date: string) => sql`((${date}::date + 1))::timestamp AT TIME ZONE ${env.COMPANY_TIMEZONE}`;

export interface AuditFilter {
  table?: string;
  recordId?: string;
  userId?: string;
  action?: 'INSERT' | 'UPDATE' | 'DELETE';
  from?: string;
  to?: string;
}

function auditConditions(f: AuditFilter): SQL | undefined {
  const c: SQL[] = [];
  if (f.table) c.push(eq(auditLog.tableName, f.table));
  if (f.recordId) c.push(eq(auditLog.recordId, f.recordId));
  if (f.userId) c.push(eq(auditLog.changedBy, f.userId));
  if (f.action) c.push(eq(auditLog.action, f.action));
  if (f.from) c.push(gte(auditLog.changedAt, dayStart(f.from)));
  if (f.to) c.push(lt(auditLog.changedAt, dayAfter(f.to)));
  return c.length ? and(...c) : undefined;
}

export async function auditEntries(q: Queryable, f: AuditFilter, limit: number, offset: number) {
  const where = auditConditions(f);
  const rows = await q
    .select({ a: auditLog, username: users.username, fullName: users.fullName })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.changedBy))
    .where(where)
    .orderBy(desc(auditLog.changedAt), desc(auditLog.id))
    .limit(limit)
    .offset(offset);
  const [total] = await q.select({ n: count() }).from(auditLog).where(where);
  return { rows, total: total?.n ?? 0 };
}

export async function auditTables(q: Queryable): Promise<string[]> {
  const rows = await q.selectDistinct({ t: auditLog.tableName }).from(auditLog).orderBy(asc(auditLog.tableName));
  return rows.map((r) => r.t);
}

export async function statusHistoryOf(q: Queryable, companyId: string, table: string, recordId: string) {
  const sign = alias(eSignatures, 'sign');
  const witness = alias(eSignatures, 'witness');
  return q
    .select({
      h: statusHistory,
      actorName: users.fullName,
      signMeaning: sign.meaning,
      signName: sign.signerName,
      witnessMeaning: witness.meaning,
      witnessName: witness.signerName,
    })
    .from(statusHistory)
    .innerJoin(users, eq(users.id, statusHistory.actorId))
    .leftJoin(sign, eq(sign.id, statusHistory.esignId))
    .leftJoin(witness, eq(witness.id, statusHistory.witnessEsignId))
    .where(and(eq(statusHistory.companyId, companyId), eq(statusHistory.entityTable, table), eq(statusHistory.entityId, recordId)))
    .orderBy(asc(statusHistory.id));
}

export async function signaturesOf(q: Queryable, companyId: string, table: string, recordId: string) {
  return q
    .select()
    .from(eSignatures)
    .where(and(eq(eSignatures.companyId, companyId), eq(eSignatures.recordTable, table), eq(eSignatures.recordId, recordId)))
    .orderBy(asc(eSignatures.id));
}

export interface AuthEventFilter {
  userId?: string;
  event?: string;
  from?: string;
  to?: string;
}

export async function authEventRows(q: Queryable, companyId: string, f: AuthEventFilter, limit: number, offset: number) {
  const c: SQL[] = [eq(authEvents.companyId, companyId)];
  if (f.userId) c.push(eq(authEvents.userId, f.userId));
  if (f.event) c.push(eq(authEvents.event, f.event as typeof authEvents.$inferSelect.event));
  if (f.from) c.push(gte(authEvents.at, dayStart(f.from)));
  if (f.to) c.push(lt(authEvents.at, dayAfter(f.to)));
  const where = and(...c);
  const rows = await q.select().from(authEvents).where(where).orderBy(desc(authEvents.at), desc(authEvents.id)).limit(limit).offset(offset);
  const [total] = await q.select({ n: count() }).from(authEvents).where(where);
  return { rows, total: total?.n ?? 0 };
}
