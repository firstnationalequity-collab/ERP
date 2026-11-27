// Queries for purch.vendor_invoices, vendor_invoice_lines, vendor_payments, payment_allocations (0031).
// No business rules here; invoices.service.ts and payments.service.ts hold them.
import { and, asc, count, desc, eq, gt, ilike, inArray, lte, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { Queryable, Tx } from '../../db/client';
import { debitNotes, paymentAllocations, vendorInvoiceLines, vendorInvoices, vendorPayments } from '../../db/schema/purch';
import type { Paging } from './procurement.repo';

export type InvoiceRow = typeof vendorInvoices.$inferSelect;
export type InvoiceLineRow = typeof vendorInvoiceLines.$inferSelect;
export type PaymentRow = typeof vendorPayments.$inferSelect;
export type AllocationRow = typeof paymentAllocations.$inferSelect;

type Stamp = 'id' | 'companyId' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy';
export type InvoiceHeaderValues = Omit<
  typeof vendorInvoices.$inferInsert,
  | Stamp
  | 'status'
  | 'exceptionAt'
  | 'releasedBy'
  | 'releasedAt'
  | 'releaseReason'
  | 'postingDate'
  | 'postedBy'
  | 'postedAt'
  | 'reversedBy'
  | 'reversedAt'
  | 'reversalDate'
  | 'reversalReason'
>;
export type InvoiceLineValues = Pick<
  typeof vendorInvoiceLines.$inferInsert,
  'lineNo' | 'grnLineId' | 'landedCostId' | 'qty' | 'unitPrice' | 'amount' | 'taxCodeId' | 'taxRate' | 'taxAmount'
>;
export type InvoiceLineResult = Pick<
  typeof vendorInvoiceLines.$inferInsert,
  | 'poUnitPrice'
  | 'priceDiffPct'
  | 'qtyOver'
  | 'inTolerance'
  | 'amountPkr'
  | 'taxPkr'
  | 'clearedPkr'
  | 'matchedQty'
  | 'priceVariancePkr'
  | 'exchangeDiffPkr'
>;
export type PaymentValues = Omit<
  typeof vendorPayments.$inferInsert,
  | Stamp
  | 'status'
  | 'submittedBy'
  | 'submittedAt'
  | 'postingDate'
  | 'postedBy'
  | 'postedAt'
  | 'carryingPkr'
  | 'exchangeDiffPkr'
  | 'filerWarningAckBy'
  | 'filerWarningAckAt'
  | 'reversedBy'
  | 'reversedAt'
  | 'reversalDate'
  | 'reversalReason'
>;

/**
 * Was the document in force on `asOf`: POSTED (posted on or before), or REVERSED after that day (owner 2026-11-26:
 * the ageing as of a past date still shows an invoice or payment reversed later).
 */
function inForce(t: typeof vendorInvoices | typeof vendorPayments, asOf?: string): SQL {
  if (!asOf) return eq(t.status, 'POSTED');
  return and(lte(t.postingDate, asOf), or(eq(t.status, 'POSTED'), and(eq(t.status, 'REVERSED'), gt(t.reversalDate, asOf))))!;
}

// ---------------------------------------------------------------- invoices

export async function insertInvoice(tx: Tx, v: InvoiceHeaderValues): Promise<string> {
  const [row] = await tx.insert(vendorInvoices).values({ ...v, status: 'DRAFT' }).returning({ id: vendorInvoices.id });
  if (!row) throw new Error('vendor invoice insert returned nothing');
  return row.id;
}

export async function updateInvoice(tx: Tx, id: string, v: Partial<InvoiceHeaderValues>): Promise<void> {
  await tx.update(vendorInvoices).set(v).where(eq(vendorInvoices.id, id));
}

export async function findInvoice(q: Queryable, companyId: string, id: string, lock = false): Promise<InvoiceRow | undefined> {
  const query = q.select().from(vendorInvoices).where(and(eq(vendorInvoices.companyId, companyId), eq(vendorInvoices.id, id)));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

/** SELECT ... FOR UPDATE on several invoices, in id order (payments settle them). */
export async function lockInvoices(tx: Tx, companyId: string, ids: string[]): Promise<InvoiceRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(vendorInvoices)
    .where(and(eq(vendorInvoices.companyId, companyId), inArray(vendorInvoices.id, [...new Set(ids)])))
    .orderBy(asc(vendorInvoices.id))
    .for('update');
}

export async function invoicesByIds(q: Queryable, companyId: string, ids: string[]): Promise<Map<string, InvoiceRow>> {
  if (ids.length === 0) return new Map();
  const rows = await q.select().from(vendorInvoices).where(and(eq(vendorInvoices.companyId, companyId), inArray(vendorInvoices.id, [...new Set(ids)])));
  return new Map(rows.map((r) => [r.id, r]));
}

export async function listInvoices(
  q: Queryable,
  companyId: string,
  f: { status?: string; search?: string; vendorId?: string; poId?: string },
  paging: Paging,
): Promise<{ rows: InvoiceRow[]; total: number }> {
  const where: SQL[] = [eq(vendorInvoices.companyId, companyId)];
  if (f.status) where.push(eq(vendorInvoices.status, f.status as InvoiceRow['status']));
  if (f.vendorId) where.push(eq(vendorInvoices.vendorId, f.vendorId));
  if (f.poId) where.push(eq(vendorInvoices.poId, f.poId));
  if (f.search) {
    const like = `%${f.search}%`;
    where.push(or(ilike(vendorInvoices.docNo, like), ilike(vendorInvoices.vendorInvoiceNo, like))!);
  }
  const cond = and(...where);
  const rows = await q.select().from(vendorInvoices).where(cond).orderBy(desc(vendorInvoices.id)).limit(paging.limit).offset(paging.offset);
  const [c] = await q.select({ n: count() }).from(vendorInvoices).where(cond);
  return { rows, total: Number(c?.n ?? 0) };
}

/** Another invoice of this vendor, neither cancelled nor reversed, carries the same vendor invoice number. */
export async function invoiceNoTaken(q: Queryable, companyId: string, vendorId: string, no: string, exceptId?: string): Promise<string | null> {
  const where: SQL[] = [
    eq(vendorInvoices.companyId, companyId),
    eq(vendorInvoices.vendorId, vendorId),
    notInArray(vendorInvoices.status, ['CANCELLED', 'REVERSED']),
    sql`upper(trim(${vendorInvoices.vendorInvoiceNo})) = upper(trim(${no}))`,
  ];
  if (exceptId) where.push(ne(vendorInvoices.id, exceptId));
  const [row] = await q.select({ docNo: vendorInvoices.docNo }).from(vendorInvoices).where(and(...where)).limit(1);
  return row?.docNo ?? null;
}

export async function linesOf(q: Queryable, invoiceIds: string[]): Promise<InvoiceLineRow[]> {
  if (invoiceIds.length === 0) return [];
  return q
    .select()
    .from(vendorInvoiceLines)
    .where(inArray(vendorInvoiceLines.invoiceId, invoiceIds))
    .orderBy(asc(vendorInvoiceLines.invoiceId), asc(vendorInvoiceLines.lineNo));
}

export async function replaceLines(tx: Tx, invoiceId: string, rows: InvoiceLineValues[]): Promise<void> {
  await tx.delete(vendorInvoiceLines).where(eq(vendorInvoiceLines.invoiceId, invoiceId));
  if (rows.length) await tx.insert(vendorInvoiceLines).values(rows.map((r) => ({ ...r, invoiceId })));
}

export async function setLineResult(tx: Tx, lineId: string, v: InvoiceLineResult): Promise<void> {
  await tx.update(vendorInvoiceLines).set(v).where(eq(vendorInvoiceLines.id, lineId));
}

/** Billed on POSTED invoices per GRN line: quantity and GRNI cleared (other invoices than `exceptInvoiceId`). */
export async function invoicedOnGrnLines(
  q: Queryable,
  grnLineIds: string[],
  exceptInvoiceId?: string,
): Promise<Map<string, { qty: string; cleared: string }>> {
  if (grnLineIds.length === 0) return new Map();
  const where: SQL[] = [inArray(vendorInvoiceLines.grnLineId, [...new Set(grnLineIds)]), eq(vendorInvoices.status, 'POSTED')];
  if (exceptInvoiceId) where.push(ne(vendorInvoices.id, exceptInvoiceId));
  const rows = await q
    .select({
      grnLineId: vendorInvoiceLines.grnLineId,
      qty: sql<string>`coalesce(sum(${vendorInvoiceLines.qty}), 0)::text`,
      cleared: sql<string>`coalesce(sum(${vendorInvoiceLines.clearedPkr}), 0)::text`,
    })
    .from(vendorInvoiceLines)
    .innerJoin(vendorInvoices, eq(vendorInvoices.id, vendorInvoiceLines.invoiceId))
    .where(and(...where))
    .groupBy(vendorInvoiceLines.grnLineId);
  return new Map(rows.map((r) => [r.grnLineId!, { qty: r.qty, cleared: r.cleared }]));
}

/** Billed on POSTED invoices per landed cost (its currency) and the clearing taken off (PKR). */
export async function invoicedOnCharges(q: Queryable, chargeIds: string[], exceptInvoiceId?: string): Promise<Map<string, string>> {
  return new Map([...(await chargesBilled(q, chargeIds, exceptInvoiceId)).entries()].map(([k, v]) => [k, v.amount]));
}

export async function chargesBilled(
  q: Queryable,
  chargeIds: string[],
  exceptInvoiceId?: string,
): Promise<Map<string, { amount: string; cleared: string }>> {
  if (chargeIds.length === 0) return new Map();
  const where: SQL[] = [inArray(vendorInvoiceLines.landedCostId, [...new Set(chargeIds)]), eq(vendorInvoices.status, 'POSTED')];
  if (exceptInvoiceId) where.push(ne(vendorInvoices.id, exceptInvoiceId));
  const rows = await q
    .select({
      landedCostId: vendorInvoiceLines.landedCostId,
      amount: sql<string>`coalesce(sum(${vendorInvoiceLines.amount}), 0)::text`,
      cleared: sql<string>`coalesce(sum(${vendorInvoiceLines.clearedPkr}), 0)::text`,
    })
    .from(vendorInvoiceLines)
    .innerJoin(vendorInvoices, eq(vendorInvoices.id, vendorInvoiceLines.invoiceId))
    .where(and(...where))
    .groupBy(vendorInvoiceLines.landedCostId);
  return new Map(rows.map((r) => [r.landedCostId!, { amount: r.amount, cleared: r.cleared }]));
}

/** POSTED invoices of a vendor; with `asOf`, those in force on that day (posted by then, not reversed by then). */
export async function postedInvoices(q: Queryable, companyId: string, f: { vendorId?: string; asOf?: string }): Promise<InvoiceRow[]> {
  const where: SQL[] = [eq(vendorInvoices.companyId, companyId), inForce(vendorInvoices, f.asOf)];
  if (f.vendorId) where.push(eq(vendorInvoices.vendorId, f.vendorId));
  return q.select().from(vendorInvoices).where(and(...where)).orderBy(asc(vendorInvoices.dueDate), asc(vendorInvoices.id));
}

/** A PO's invoice lines on POSTED invoices, per PO line: quantity billed (for PO → CLOSED). */
export async function invoicedQtyByPoLine(q: Queryable, poId: string): Promise<Map<string, string>> {
  const rows = await q.execute<{ po_line_id: string; qty: string }>(sql`
    SELECT gl.po_line_id::text AS po_line_id, coalesce(sum(il.qty), 0)::text AS qty
      FROM purch.vendor_invoice_lines il
      JOIN purch.vendor_invoices i ON i.id = il.invoice_id
      JOIN purch.grn_lines gl ON gl.id = il.grn_line_id
      JOIN purch.grns g ON g.id = gl.grn_id
     WHERE i.po_id = ${poId} AND i.status = 'POSTED' AND g.status = 'POSTED'
     GROUP BY gl.po_line_id`);
  return new Map(rows.rows.map((r) => [r.po_line_id, r.qty]));
}

/** Invoices (neither CANCELLED nor REVERSED) naming one of these GRN lines or landed costs: a GRN reversal is refused. */
export async function invoicesNaming(q: Queryable, f: { grnLineIds: string[]; landedCostIds: string[] }): Promise<string[]> {
  const conds: SQL[] = [];
  if (f.grnLineIds.length) conds.push(inArray(vendorInvoiceLines.grnLineId, f.grnLineIds));
  if (f.landedCostIds.length) conds.push(inArray(vendorInvoiceLines.landedCostId, f.landedCostIds));
  if (conds.length === 0) return [];
  const rows = await q
    .selectDistinct({ docNo: vendorInvoices.docNo })
    .from(vendorInvoiceLines)
    .innerJoin(vendorInvoices, eq(vendorInvoices.id, vendorInvoiceLines.invoiceId))
    .where(and(notInArray(vendorInvoices.status, ['CANCELLED', 'REVERSED']), or(...conds)));
  return rows.map((r) => r.docNo);
}

/** Payments (neither CANCELLED nor REVERSED) and debit notes (not CANCELLED) naming an invoice: it is not reversed. */
export async function documentsOnInvoice(q: Queryable, invoiceId: string): Promise<{ payments: string[]; debitNotes: string[] }> {
  const pays = await q
    .selectDistinct({ docNo: vendorPayments.docNo })
    .from(paymentAllocations)
    .innerJoin(vendorPayments, eq(vendorPayments.id, paymentAllocations.paymentId))
    .where(and(eq(paymentAllocations.invoiceId, invoiceId), notInArray(vendorPayments.status, ['CANCELLED', 'REVERSED'])));
  const notes = await q
    .select({ docNo: debitNotes.docNo })
    .from(debitNotes)
    .where(and(eq(debitNotes.invoiceId, invoiceId), ne(debitNotes.status, 'CANCELLED')));
  return { payments: pays.map((p) => p.docNo), debitNotes: notes.map((n) => n.docNo) };
}

/** Taken off invoices by POSTED debit notes (posted on or before `asOf` when given): invoice currency and PKR. */
export async function debitedOnInvoices(
  q: Queryable,
  invoiceIds: string[],
  asOf?: string,
): Promise<Map<string, { foreign: string; pkr: string }>> {
  if (invoiceIds.length === 0) return new Map();
  const where: SQL[] = [inArray(debitNotes.invoiceId, [...new Set(invoiceIds)]), eq(debitNotes.status, 'POSTED')];
  if (asOf) where.push(lte(debitNotes.postingDate, asOf));
  const rows = await q
    .select({
      invoiceId: debitNotes.invoiceId,
      foreign: sql<string>`coalesce(sum(${debitNotes.totalAmount}), 0)::text`,
      pkr: sql<string>`coalesce(sum(${debitNotes.totalPkr}), 0)::text`,
    })
    .from(debitNotes)
    .where(and(...where))
    .groupBy(debitNotes.invoiceId);
  return new Map(rows.map((r) => [r.invoiceId, { foreign: r.foreign, pkr: r.pkr }]));
}

// ---------------------------------------------------------------- payments

export async function insertPayment(tx: Tx, v: PaymentValues): Promise<string> {
  const [row] = await tx.insert(vendorPayments).values({ ...v, status: 'DRAFT' }).returning({ id: vendorPayments.id });
  if (!row) throw new Error('vendor payment insert returned nothing');
  return row.id;
}

export async function updatePayment(tx: Tx, id: string, v: Partial<PaymentValues>): Promise<void> {
  await tx.update(vendorPayments).set(v).where(eq(vendorPayments.id, id));
}

export async function findPayment(q: Queryable, companyId: string, id: string, lock = false): Promise<PaymentRow | undefined> {
  const query = q.select().from(vendorPayments).where(and(eq(vendorPayments.companyId, companyId), eq(vendorPayments.id, id)));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

export async function listPayments(
  q: Queryable,
  companyId: string,
  f: { status?: string; search?: string; vendorId?: string },
  paging: Paging,
): Promise<{ rows: PaymentRow[]; total: number }> {
  const where: SQL[] = [eq(vendorPayments.companyId, companyId)];
  if (f.status) where.push(eq(vendorPayments.status, f.status as PaymentRow['status']));
  if (f.vendorId) where.push(eq(vendorPayments.vendorId, f.vendorId));
  if (f.search) {
    const like = `%${f.search}%`;
    where.push(or(ilike(vendorPayments.docNo, like), ilike(vendorPayments.reference, like))!);
  }
  const cond = and(...where);
  const rows = await q.select().from(vendorPayments).where(cond).orderBy(desc(vendorPayments.id)).limit(paging.limit).offset(paging.offset);
  const [c] = await q.select({ n: count() }).from(vendorPayments).where(cond);
  return { rows, total: Number(c?.n ?? 0) };
}

export async function allocationsOf(q: Queryable, paymentIds: string[]): Promise<AllocationRow[]> {
  if (paymentIds.length === 0) return [];
  return q.select().from(paymentAllocations).where(inArray(paymentAllocations.paymentId, paymentIds)).orderBy(asc(paymentAllocations.id));
}

export async function replaceAllocations(tx: Tx, paymentId: string, rows: { invoiceId: string; foreignAmount: string }[]): Promise<void> {
  await tx.delete(paymentAllocations).where(eq(paymentAllocations.paymentId, paymentId));
  if (rows.length) await tx.insert(paymentAllocations).values(rows.map((r) => ({ ...r, paymentId })));
}

export async function setAllocationCarrying(tx: Tx, allocationId: string, carryingPkr: string): Promise<void> {
  await tx.update(paymentAllocations).set({ carryingPkr }).where(eq(paymentAllocations.id, allocationId));
}

/** Settled per invoice by POSTED payments (with `asOf`: payments in force on that day): foreign amount and PKR carried. */
export async function paidOnInvoices(
  q: Queryable,
  invoiceIds: string[],
  asOf?: string,
): Promise<Map<string, { foreign: string; carrying: string }>> {
  if (invoiceIds.length === 0) return new Map();
  const where: SQL[] = [inArray(paymentAllocations.invoiceId, [...new Set(invoiceIds)]), inForce(vendorPayments, asOf)];
  const rows = await q
    .select({
      invoiceId: paymentAllocations.invoiceId,
      foreign: sql<string>`coalesce(sum(${paymentAllocations.foreignAmount}), 0)::text`,
      carrying: sql<string>`coalesce(sum(${paymentAllocations.carryingPkr}), 0)::text`,
    })
    .from(paymentAllocations)
    .innerJoin(vendorPayments, eq(vendorPayments.id, paymentAllocations.paymentId))
    .where(and(...where))
    .groupBy(paymentAllocations.invoiceId);
  return new Map(rows.map((r) => [r.invoiceId, { foreign: r.foreign, carrying: r.carrying }]));
}

/** Doc numbers of payments, invoices and debit notes, for the ledger. */
export async function docNos(
  q: Queryable,
  kind: 'invoice' | 'payment' | 'debit_note',
  ids: string[],
): Promise<Map<string, { docNo: string; currency: string; foreign: string }>> {
  if (ids.length === 0) return new Map();
  if (kind === 'debit_note') {
    const rows = await q
      .select({ id: debitNotes.id, docNo: debitNotes.docNo, currency: debitNotes.currency, foreign: debitNotes.totalAmount })
      .from(debitNotes)
      .where(inArray(debitNotes.id, [...new Set(ids)]));
    return new Map(rows.map((r) => [r.id, r]));
  }
  if (kind === 'invoice') {
    const rows = await q
      .select({ id: vendorInvoices.id, docNo: vendorInvoices.docNo, currency: vendorInvoices.currency, foreign: vendorInvoices.totalAmount })
      .from(vendorInvoices)
      .where(inArray(vendorInvoices.id, [...new Set(ids)]));
    return new Map(rows.map((r) => [r.id, r]));
  }
  const rows = await q
    .select({ id: vendorPayments.id, docNo: vendorPayments.docNo, currency: vendorPayments.currency, foreign: vendorPayments.foreignAmount })
    .from(vendorPayments)
    .where(inArray(vendorPayments.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r]));
}

/** The approver's acknowledgement of a stale filer status (owner 2026-11-26), written while the payment waits for approval. */
export async function setFilerAcknowledged(tx: Tx, paymentId: string, userId: string): Promise<void> {
  await tx.update(vendorPayments).set({ filerWarningAckBy: userId, filerWarningAckAt: new Date() }).where(eq(vendorPayments.id, paymentId));
}
