// Queries behind sample-requests.service.ts. No business rules here.
import { and, eq, inArray } from 'drizzle-orm';
import type { Queryable, Tx } from '../../db/client';
import { sampleRequests } from '../../db/schema/qc';

export type SampleRequestRow = typeof sampleRequests.$inferSelect;

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
