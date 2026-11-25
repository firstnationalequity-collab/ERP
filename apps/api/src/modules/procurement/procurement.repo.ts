// Queries for the purch schema (0023). No business rules here; services hold them.
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { users } from '../../db/schema/core';
import { poLines, prLines, purchaseOrders, purchaseRequisitions } from '../../db/schema/purch';

export type PrRow = typeof purchaseRequisitions.$inferSelect;
export type PrLineRow = typeof prLines.$inferSelect;
export type PoRow = typeof purchaseOrders.$inferSelect;
export type PoLineRow = typeof poLines.$inferSelect;

export interface Paging {
  limit: number;
  offset: number;
}

export async function userNames(q: Queryable, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await q.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ---------------------------------------------------------------- requisitions

export async function insertPr(
  q: Queryable,
  v: { docNo: string; prDate: string; requiredBy: string | null; department: string | null; notes: string | null },
): Promise<string> {
  const [row] = await q.insert(purchaseRequisitions).values({ ...v, status: 'DRAFT' }).returning({ id: purchaseRequisitions.id });
  if (!row) throw new Error('requisition insert returned no row');
  return row.id;
}

export async function updatePrHeader(
  q: Queryable,
  id: string,
  v: { prDate: string; requiredBy: string | null; department: string | null; notes: string | null },
): Promise<void> {
  await q.update(purchaseRequisitions).set(v).where(eq(purchaseRequisitions.id, id));
}

export async function findPr(q: Queryable, companyId: string, id: string, lock = false): Promise<PrRow | undefined> {
  const query = q
    .select()
    .from(purchaseRequisitions)
    .where(and(eq(purchaseRequisitions.companyId, companyId), eq(purchaseRequisitions.id, id)));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

export async function listPrs(
  q: Queryable,
  companyId: string,
  f: { status?: string; search?: string },
  paging: Paging,
): Promise<{ rows: PrRow[]; total: number }> {
  const where: SQL[] = [eq(purchaseRequisitions.companyId, companyId)];
  if (f.status) where.push(sql`${purchaseRequisitions.status} = ${f.status}`);
  if (f.search) {
    const s = `%${f.search}%`;
    const cond = or(ilike(purchaseRequisitions.docNo, s), ilike(purchaseRequisitions.department, s), ilike(purchaseRequisitions.notes, s));
    if (cond) where.push(cond);
  }
  const rows = await q
    .select()
    .from(purchaseRequisitions)
    .where(and(...where))
    .orderBy(desc(purchaseRequisitions.id))
    .limit(paging.limit)
    .offset(paging.offset);
  const [c] = await q.select({ n: count() }).from(purchaseRequisitions).where(and(...where));
  return { rows, total: Number(c?.n ?? 0) };
}

export async function prLinesOf(q: Queryable, prIds: string[]): Promise<PrLineRow[]> {
  if (prIds.length === 0) return [];
  return q.select().from(prLines).where(inArray(prLines.prId, prIds)).orderBy(asc(prLines.prId), asc(prLines.lineNo));
}

export async function prLinesByIds(q: Queryable, companyId: string, ids: string[]): Promise<(PrLineRow & { prDocNo: string })[]> {
  if (ids.length === 0) return [];
  const rows = await q
    .select({ l: prLines, prDocNo: purchaseRequisitions.docNo })
    .from(prLines)
    .innerJoin(purchaseRequisitions, eq(purchaseRequisitions.id, prLines.prId))
    .where(and(eq(prLines.companyId, companyId), inArray(prLines.id, ids)));
  return rows.map((r) => ({ ...r.l, prDocNo: r.prDocNo }));
}

export async function replacePrLines(
  q: Queryable,
  prId: string,
  lines: { lineNo: number; itemId: string; qty: string; notes: string | null }[],
): Promise<void> {
  await q.delete(prLines).where(eq(prLines.prId, prId));
  if (lines.length > 0) await q.insert(prLines).values(lines.map((l) => ({ ...l, prId })));
}

/** For each requisition line already on a PO: the PO id and number. */
export async function ordersOfPrLines(q: Queryable, prLineIds: string[]): Promise<Map<string, { poId: string; poDocNo: string }>> {
  if (prLineIds.length === 0) return new Map();
  const rows = await q
    .select({ prLineId: poLines.prLineId, poId: purchaseOrders.id, poDocNo: purchaseOrders.docNo })
    .from(poLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, poLines.poId))
    .where(inArray(poLines.prLineId, prLineIds));
  return new Map(rows.flatMap((r) => (r.prLineId ? [[r.prLineId, { poId: r.poId, poDocNo: r.poDocNo }] as const] : [])));
}

/** Lines of a requisition not yet on any PO. */
export async function unorderedPrLineCount(q: Queryable, prId: string): Promise<number> {
  const [c] = await q
    .select({ n: count() })
    .from(prLines)
    .leftJoin(poLines, eq(poLines.prLineId, prLines.id))
    .where(and(eq(prLines.prId, prId), isNull(poLines.id)));
  return Number(c?.n ?? 0);
}

// ---------------------------------------------------------------- purchase orders

export interface PoHeaderValues {
  poDate: string;
  vendorId: string;
  poType: PoRow['poType'];
  currency: string;
  incoterm: PoRow['incoterm'];
  deliveryDate: string | null;
  notes: string | null;
  totalAmount: string;
}

export async function insertPo(q: Queryable, v: PoHeaderValues & { docNo: string }): Promise<string> {
  const [row] = await q.insert(purchaseOrders).values({ ...v, status: 'DRAFT' }).returning({ id: purchaseOrders.id });
  if (!row) throw new Error('purchase order insert returned no row');
  return row.id;
}

export async function updatePoHeader(q: Queryable, id: string, v: PoHeaderValues): Promise<void> {
  await q.update(purchaseOrders).set(v).where(eq(purchaseOrders.id, id));
}

export async function findPo(q: Queryable, companyId: string, id: string, lock = false): Promise<PoRow | undefined> {
  const query = q.select().from(purchaseOrders).where(and(eq(purchaseOrders.companyId, companyId), eq(purchaseOrders.id, id)));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

export async function listPos(
  q: Queryable,
  companyId: string,
  f: { status?: string; search?: string; vendorId?: string },
  paging: Paging,
): Promise<{ rows: PoRow[]; total: number }> {
  const where: SQL[] = [eq(purchaseOrders.companyId, companyId)];
  if (f.status) where.push(sql`${purchaseOrders.status} = ${f.status}`);
  if (f.vendorId) where.push(eq(purchaseOrders.vendorId, f.vendorId));
  if (f.search) {
    const s = `%${f.search}%`;
    const cond = or(ilike(purchaseOrders.docNo, s), ilike(purchaseOrders.notes, s));
    if (cond) where.push(cond);
  }
  const rows = await q
    .select()
    .from(purchaseOrders)
    .where(and(...where))
    .orderBy(desc(purchaseOrders.id))
    .limit(paging.limit)
    .offset(paging.offset);
  const [c] = await q.select({ n: count() }).from(purchaseOrders).where(and(...where));
  return { rows, total: Number(c?.n ?? 0) };
}

export async function poLinesOf(q: Queryable, poIds: string[]): Promise<PoLineRow[]> {
  if (poIds.length === 0) return [];
  return q.select().from(poLines).where(inArray(poLines.poId, poIds)).orderBy(asc(poLines.poId), asc(poLines.lineNo));
}

export async function replacePoLines(
  q: Queryable,
  poId: string,
  lines: { lineNo: number; itemId: string; qty: string; unitPrice: string; lineAmount: string; prLineId: string | null; notes: string | null }[],
): Promise<void> {
  await q.delete(poLines).where(eq(poLines.poId, poId));
  if (lines.length > 0) await q.insert(poLines).values(lines.map((l) => ({ ...l, poId })));
}

export async function totalReceived(q: Queryable, poId: string): Promise<string> {
  const [row] = await q
    .select({ n: sql<string>`coalesce(sum(${poLines.receivedQty}), 0)::text` })
    .from(poLines)
    .where(eq(poLines.poId, poId));
  return row?.n ?? '0';
}
