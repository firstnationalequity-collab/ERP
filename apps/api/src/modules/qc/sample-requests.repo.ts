// Queries behind sample-requests.service.ts and samples.service.ts. No business rules here.
import { and, asc, count, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { SampleRequestStatus } from '@albert/shared';
import type { Queryable, Tx } from '../../db/client';
import { resultReviews, results, sampleRequests } from '../../db/schema/qc';

export type SampleRequestRow = typeof sampleRequests.$inferSelect;
export type ResultRow = typeof results.$inferSelect;
export type NewResult = Pick<typeof results.$inferInsert, 'sampleRequestId' | 'specTestId' | 'resultType' | 'numericValue' | 'textValue' | 'passed' | 'remarks'> &
  Partial<Pick<typeof results.$inferInsert, 'retestOf' | 'retestReason'>>;
export interface ResultWithReview extends ResultRow {
  reviewedBy: string | null;
  reviewedAt: Date | null;
}

export async function insertSampleRequest(tx: Tx, values: { lotId: string; refDocType: string; refDocId: string }): Promise<SampleRequestRow> {
  const [row] = await tx.insert(sampleRequests).values({ ...values, status: 'OPEN' }).returning();
  if (!row) throw new Error('sample request insert returned nothing');
  return row;
}

export async function byLots(q: Queryable, companyId: string, lotIds: string[], lock = false): Promise<SampleRequestRow[]> {
  if (lotIds.length === 0) return [];
  const query = q
    .select()
    .from(sampleRequests)
    .where(and(eq(sampleRequests.companyId, companyId), inArray(sampleRequests.lotId, lotIds)))
    .orderBy(sampleRequests.id);
  return lock ? query.for('update') : query;
}

export async function findRequest(q: Queryable, companyId: string, id: string, lock = false): Promise<SampleRequestRow | undefined> {
  const query = q.select().from(sampleRequests).where(and(eq(sampleRequests.companyId, companyId), eq(sampleRequests.id, id)));
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/** Requests with at least one result that has no review (the review queue). */
const hasUnreviewed = sql`EXISTS (SELECT 1 FROM qc.results r LEFT JOIN qc.result_reviews v ON v.result_id = r.id
                                   WHERE r.sample_request_id = ${sampleRequests.id} AND v.id IS NULL)`;

export function requestWhere(companyId: string, f: { status?: SampleRequestStatus; lotIds?: string[]; toReview?: boolean }): SQL | undefined {
  return and(
    eq(sampleRequests.companyId, companyId),
    f.status ? eq(sampleRequests.status, f.status) : undefined,
    f.lotIds ? inArray(sampleRequests.lotId, f.lotIds.length > 0 ? f.lotIds : ['0']) : undefined,
    f.toReview === true ? hasUnreviewed : f.toReview === false ? sql`NOT ${hasUnreviewed}` : undefined,
  );
}

/** Oldest first: the queue is worked in the order goods arrived. */
export async function listRequests(q: Queryable, where: SQL | undefined, paging: { offset: number; limit: number }): Promise<SampleRequestRow[]> {
  return q.select().from(sampleRequests).where(where).orderBy(asc(sampleRequests.id)).offset(paging.offset).limit(paging.limit);
}

export async function countRequests(q: Queryable, where: SQL | undefined): Promise<number> {
  const [row] = await q.select({ n: count() }).from(sampleRequests).where(where);
  return row?.n ?? 0;
}

export async function resultsOf(q: Queryable, requestIds: string[]): Promise<ResultWithReview[]> {
  if (requestIds.length === 0) return [];
  const rows = await q
    .select({ r: results, reviewedBy: resultReviews.reviewedBy, reviewedAt: resultReviews.reviewedAt })
    .from(results)
    .leftJoin(resultReviews, eq(resultReviews.resultId, results.id))
    .where(inArray(results.sampleRequestId, requestIds))
    .orderBy(asc(results.id));
  return rows.map(({ r, reviewedBy, reviewedAt }) => ({ ...r, reviewedBy, reviewedAt }));
}

export async function unreviewedResults(tx: Tx, requestId: string): Promise<ResultRow[]> {
  const rows = await tx
    .select({ r: results })
    .from(results)
    .leftJoin(resultReviews, eq(resultReviews.resultId, results.id))
    .where(and(eq(results.sampleRequestId, requestId), isNull(resultReviews.id)))
    .orderBy(asc(results.id));
  return rows.map(({ r }) => r);
}

export async function insertResults(tx: Tx, rows: NewResult[]): Promise<ResultRow[]> {
  return tx.insert(results).values(rows).returning();
}

export async function insertReviews(tx: Tx, rows: { resultId: string; esignId: string }[]): Promise<void> {
  await tx.insert(resultReviews).values(rows);
}
