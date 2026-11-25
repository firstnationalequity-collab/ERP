// Queries for purch.grns / purch.grn_lines (0027). No business rules here; grns.service.ts holds them.
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Queryable, Tx } from '../../db/client';
import { grnLines, grns, poLines } from '../../db/schema/purch';
import type { Paging } from './procurement.repo';

export type GrnRow = typeof grns.$inferSelect;
export type GrnLineRow = typeof grnLines.$inferSelect;

export interface GrnHeaderValues {
  grnDate: string;
  locationId: string;
  deliveryNoteNo: string | null;
  notes: string | null;
}

export type GrnLineValues = Omit<typeof grnLines.$inferInsert, 'id' | 'companyId' | 'grnId' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy'>;

export async function insertGrn(
  tx: Tx,
  v: GrnHeaderValues & { docNo: string; poId: string; vendorId: string; currency: string },
): Promise<string> {
  const [row] = await tx.insert(grns).values({ ...v, status: 'DRAFT' }).returning({ id: grns.id });
  if (!row) throw new Error('GRN insert returned nothing');
  return row.id;
}

export async function updateGrnHeader(tx: Tx, id: string, v: GrnHeaderValues): Promise<void> {
  await tx.update(grns).set(v).where(eq(grns.id, id));
}

export async function findGrn(q: Queryable, companyId: string, id: string, lock = false): Promise<GrnRow | undefined> {
  const query = q.select().from(grns).where(and(eq(grns.companyId, companyId), eq(grns.id, id)));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

export async function listGrns(
  q: Queryable,
  companyId: string,
  f: { status?: string; search?: string; vendorId?: string; poId?: string },
  paging: Paging,
): Promise<{ rows: GrnRow[]; total: number }> {
  const where: SQL[] = [eq(grns.companyId, companyId)];
  if (f.status) where.push(sql`${grns.status} = ${f.status}`);
  if (f.vendorId) where.push(eq(grns.vendorId, f.vendorId));
  if (f.poId) where.push(eq(grns.poId, f.poId));
  if (f.search) {
    const s = `%${f.search}%`;
    const cond = or(ilike(grns.docNo, s), ilike(grns.deliveryNoteNo, s), ilike(grns.notes, s));
    if (cond) where.push(cond);
  }
  const rows = await q.select().from(grns).where(and(...where)).orderBy(desc(grns.id)).limit(paging.limit).offset(paging.offset);
  const [c] = await q.select({ n: count() }).from(grns).where(and(...where));
  return { rows, total: Number(c?.n ?? 0) };
}

export async function grnLinesOf(q: Queryable, grnIds: string[]): Promise<GrnLineRow[]> {
  if (grnIds.length === 0) return [];
  return q.select().from(grnLines).where(inArray(grnLines.grnId, grnIds)).orderBy(asc(grnLines.grnId), asc(grnLines.lineNo));
}

export async function replaceGrnLines(tx: Tx, grnId: string, rows: GrnLineValues[]): Promise<void> {
  await tx.delete(grnLines).where(eq(grnLines.grnId, grnId));
  if (rows.length > 0) await tx.insert(grnLines).values(rows.map((r) => ({ ...r, grnId })));
}

/** At posting, while the GRN is still DRAFT: the lot made for the line and its PKR unit cost. */
export async function setLineLot(tx: Tx, lineId: string, v: { lotId: string; unitCost: string }): Promise<void> {
  await tx.update(grnLines).set(v).where(eq(grnLines.id, lineId));
}

/** The PO's lines, locked (posting adds to received_qty). */
export async function lockPoLines(tx: Tx, poId: string) {
  return tx.select().from(poLines).where(eq(poLines.poId, poId)).orderBy(asc(poLines.lineNo)).for('update');
}

export async function addReceived(tx: Tx, poLineId: string, qty: string): Promise<void> {
  await tx
    .update(poLines)
    .set({ receivedQty: sql`${poLines.receivedQty} + ${qty}::numeric` })
    .where(eq(poLines.id, poLineId));
}
