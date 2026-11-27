// Queries behind dispositions.service.ts. No business rules here.
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Queryable, Tx } from '../../db/client';
import { dispositions } from '../../db/schema/qc';

export type DispositionRow = typeof dispositions.$inferSelect;
export type NewDisposition = Pick<
  typeof dispositions.$inferInsert,
  'lotId' | 'sampleRequestId' | 'fromStatus' | 'decision' | 'assayPct' | 'waterPct' | 'retestDate' | 'reason' | 'rejectCategory' | 'rejectDescription' | 'esignId'
>;

export async function insertDisposition(tx: Tx, values: NewDisposition): Promise<DispositionRow> {
  const [row] = await tx.insert(dispositions).values(values).returning();
  if (!row) throw new Error('disposition insert returned nothing');
  return row;
}

export async function dispositionsOfLots(q: Queryable, companyId: string, lotIds: string[]): Promise<DispositionRow[]> {
  if (lotIds.length === 0) return [];
  return q
    .select()
    .from(dispositions)
    .where(and(eq(dispositions.companyId, companyId), inArray(dispositions.lotId, lotIds)))
    .orderBy(asc(dispositions.id));
}
