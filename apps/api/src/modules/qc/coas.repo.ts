// Queries behind coas.service.ts. No business rules here.
import { and, count, desc, eq, inArray, or, type SQL } from 'drizzle-orm';
import type { Queryable, Tx } from '../../db/client';
import { coas, dispositions } from '../../db/schema/qc';

export type CoaRow = typeof coas.$inferSelect;
export type NewCoa = Pick<typeof coas.$inferInsert, 'docNo' | 'lotId' | 'dispositionId' | 'sampleRequestId' | 'fileName' | 'sha256' | 'esignId'> &
  Partial<Pick<typeof coas.$inferInsert, 'version' | 'supersedesId' | 'reissueReason'>>;

export async function insertCoa(tx: Tx, values: NewCoa): Promise<CoaRow> {
  const [row] = await tx.insert(coas).values(values).returning();
  if (!row) throw new Error('coa insert returned nothing');
  return row;
}

export async function coaExists(q: Queryable, id: string): Promise<boolean> {
  const rows = await q.select({ id: coas.id }).from(coas).where(eq(coas.id, id));
  return rows.length > 0;
}

export async function findCoa(q: Queryable, companyId: string, id: string, lock = false): Promise<CoaRow | undefined> {
  const query = q.select().from(coas).where(and(eq(coas.companyId, companyId), eq(coas.id, id)));
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/** The versions that supersede these certificates (0040; at most one each). */
export async function successorsOf(q: Queryable, ids: string[]): Promise<{ id: string; supersedesId: string }[]> {
  if (ids.length === 0) return [];
  const rows = await q.select({ id: coas.id, supersedesId: coas.supersedesId }).from(coas).where(inArray(coas.supersedesId, ids));
  return rows.flatMap((r) => (r.supersedesId ? [{ id: r.id, supersedesId: r.supersedesId }] : []));
}

export function coaWhere(companyId: string, f: { docNo?: string; lotIds?: string[] }): SQL | undefined {
  const match: SQL[] = [];
  if (f.docNo !== undefined) match.push(eq(coas.docNo, f.docNo.toUpperCase()));
  if (f.lotIds !== undefined && f.lotIds.length > 0) match.push(inArray(coas.lotId, f.lotIds));
  if (f.docNo === undefined && f.lotIds === undefined) return eq(coas.companyId, companyId);
  return and(eq(coas.companyId, companyId), match.length > 0 ? or(...match) : eq(coas.id, '0'));
}

export async function listCoas(q: Queryable, where: SQL | undefined, paging: { offset: number; limit: number }): Promise<CoaRow[]> {
  return q.select().from(coas).where(where).orderBy(desc(coas.id)).offset(paging.offset).limit(paging.limit);
}

export async function countCoas(q: Queryable, where: SQL | undefined): Promise<number> {
  const [row] = await q.select({ n: count() }).from(coas).where(where);
  return row?.n ?? 0;
}

export async function coasOfDispositions(q: Queryable, companyId: string, dispositionIds: string[]): Promise<CoaRow[]> {
  if (dispositionIds.length === 0) return [];
  return q.select().from(coas).where(and(eq(coas.companyId, companyId), inArray(coas.dispositionId, dispositionIds)));
}

export async function findDisposition(q: Queryable, companyId: string, id: string) {
  const [row] = await q.select().from(dispositions).where(and(eq(dispositions.companyId, companyId), eq(dispositions.id, id)));
  return row;
}
