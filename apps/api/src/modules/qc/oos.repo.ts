// Queries behind oos.service.ts. No business rules here.
import { and, count, desc, eq, inArray, or, type SQL } from 'drizzle-orm';
import type { OosStatus } from '@albert/shared';
import type { Queryable, Tx } from '../../db/client';
import { oosInvestigations, results } from '../../db/schema/qc';

export type OosRow = typeof oosInvestigations.$inferSelect;
export type NewOos = Pick<typeof oosInvestigations.$inferInsert, 'docNo' | 'resultId' | 'sampleRequestId' | 'lotId' | 'specTestId'>;

export async function insertOos(tx: Tx, values: NewOos): Promise<OosRow> {
  const [row] = await tx.insert(oosInvestigations).values({ ...values, status: 'OPEN' }).returning();
  if (!row) throw new Error('OOS insert returned nothing');
  return row;
}

export async function findOos(q: Queryable, companyId: string, id: string, lock = false): Promise<OosRow | undefined> {
  const query = q.select().from(oosInvestigations).where(and(eq(oosInvestigations.companyId, companyId), eq(oosInvestigations.id, id)));
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

export async function oosOfResults(q: Queryable, resultIds: string[]): Promise<OosRow[]> {
  if (resultIds.length === 0) return [];
  return q.select().from(oosInvestigations).where(inArray(oosInvestigations.resultId, resultIds));
}

export async function oosOfLots(q: Queryable, companyId: string, lotIds: string[], status?: OosStatus): Promise<OosRow[]> {
  if (lotIds.length === 0) return [];
  return q
    .select()
    .from(oosInvestigations)
    .where(and(eq(oosInvestigations.companyId, companyId), inArray(oosInvestigations.lotId, lotIds), status ? eq(oosInvestigations.status, status) : undefined))
    .orderBy(oosInvestigations.id);
}

export function oosWhere(companyId: string, f: { status?: OosStatus; docNo?: string; lotIds?: string[] }): SQL | undefined {
  const match: SQL[] = [];
  if (f.docNo !== undefined) match.push(eq(oosInvestigations.docNo, f.docNo.toUpperCase()));
  if (f.lotIds !== undefined && f.lotIds.length > 0) match.push(inArray(oosInvestigations.lotId, f.lotIds));
  return and(
    eq(oosInvestigations.companyId, companyId),
    f.status ? eq(oosInvestigations.status, f.status) : undefined,
    f.docNo === undefined && f.lotIds === undefined ? undefined : match.length > 0 ? or(...match) : eq(oosInvestigations.id, '0'),
  );
}

/** Open ones first, then newest first. */
export async function listOos(q: Queryable, where: SQL | undefined, paging: { offset: number; limit: number }): Promise<OosRow[]> {
  return q.select().from(oosInvestigations).where(where).orderBy(desc(eq(oosInvestigations.status, 'OPEN')), desc(oosInvestigations.id)).offset(paging.offset).limit(paging.limit);
}

export async function countOos(q: Queryable, where: SQL | undefined): Promise<number> {
  const [row] = await q.select({ n: count() }).from(oosInvestigations).where(where);
  return row?.n ?? 0;
}

/** The re-test rows of these results (each result is re-tested at most once). */
export async function retestsOf(q: Queryable, resultIds: string[]): Promise<{ id: string; retestOf: string }[]> {
  if (resultIds.length === 0) return [];
  const rows = await q.select({ id: results.id, retestOf: results.retestOf }).from(results).where(inArray(results.retestOf, resultIds));
  return rows.flatMap((r) => (r.retestOf ? [{ id: r.id, retestOf: r.retestOf }] : []));
}

export async function resultsByIds(q: Queryable, ids: string[]) {
  if (ids.length === 0) return [];
  return q.select().from(results).where(inArray(results.id, ids));
}
