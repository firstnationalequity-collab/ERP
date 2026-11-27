// Queries for purch.debit_notes and debit_note_lines (0032). No business rules here; debit-notes.service.ts holds them.
import { and, asc, count, desc, eq, ilike, inArray, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { Queryable, Tx } from '../../db/client';
import { debitNoteLines, debitNotes } from '../../db/schema/purch';
import type { Paging } from './procurement.repo';

export type DebitNoteRow = typeof debitNotes.$inferSelect;
export type DebitNoteLineRow = typeof debitNoteLines.$inferSelect;

type Stamp = 'id' | 'companyId' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy';
export type DebitNoteValues = Omit<
  typeof debitNotes.$inferInsert,
  Stamp | 'status' | 'submittedBy' | 'submittedAt' | 'postingDate' | 'postedBy' | 'postedAt'
>;
export type DebitNoteLineValues = Pick<
  typeof debitNoteLines.$inferInsert,
  'lineNo' | 'invoiceLineId' | 'qty' | 'unitPrice' | 'amount' | 'taxCodeId' | 'taxRate' | 'taxAmount' | 'amountPkr' | 'taxPkr' | 'lotId'
>;

export async function insertNote(tx: Tx, v: DebitNoteValues): Promise<string> {
  const [row] = await tx.insert(debitNotes).values({ ...v, status: 'DRAFT' }).returning({ id: debitNotes.id });
  if (!row) throw new Error('debit note insert returned nothing');
  return row.id;
}

export async function updateNote(tx: Tx, id: string, v: Partial<DebitNoteValues>): Promise<void> {
  await tx.update(debitNotes).set(v).where(eq(debitNotes.id, id));
}

export async function findNote(q: Queryable, companyId: string, id: string, lock = false): Promise<DebitNoteRow | undefined> {
  const query = q.select().from(debitNotes).where(and(eq(debitNotes.companyId, companyId), eq(debitNotes.id, id)));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

export async function listNotes(
  q: Queryable,
  companyId: string,
  f: { status?: string; search?: string; vendorId?: string; invoiceId?: string },
  paging: Paging,
): Promise<{ rows: DebitNoteRow[]; total: number }> {
  const where: SQL[] = [eq(debitNotes.companyId, companyId)];
  if (f.status) where.push(eq(debitNotes.status, f.status as DebitNoteRow['status']));
  if (f.vendorId) where.push(eq(debitNotes.vendorId, f.vendorId));
  if (f.invoiceId) where.push(eq(debitNotes.invoiceId, f.invoiceId));
  if (f.search) where.push(or(ilike(debitNotes.docNo, `%${f.search}%`))!);
  const cond = and(...where);
  const rows = await q.select().from(debitNotes).where(cond).orderBy(desc(debitNotes.id)).limit(paging.limit).offset(paging.offset);
  const [c] = await q.select({ n: count() }).from(debitNotes).where(cond);
  return { rows, total: Number(c?.n ?? 0) };
}

export async function linesOf(q: Queryable, noteIds: string[]): Promise<DebitNoteLineRow[]> {
  if (noteIds.length === 0) return [];
  return q.select().from(debitNoteLines).where(inArray(debitNoteLines.debitNoteId, noteIds)).orderBy(asc(debitNoteLines.debitNoteId), asc(debitNoteLines.lineNo));
}

export async function replaceLines(tx: Tx, noteId: string, rows: DebitNoteLineValues[]): Promise<void> {
  await tx.delete(debitNoteLines).where(eq(debitNoteLines.debitNoteId, noteId));
  if (rows.length) await tx.insert(debitNoteLines).values(rows.map((r) => ({ ...r, debitNoteId: noteId })));
}

export async function setLineResult(
  tx: Tx,
  lineId: string,
  v: { movementId?: string; stockValuePkr?: string; priceVariancePkr: string },
): Promise<void> {
  await tx.update(debitNoteLines).set(v).where(eq(debitNoteLines.id, lineId));
}

/**
 * Debited per invoice line on other notes that count (POSTED, and those on their way: PENDING_APPROVAL, APPROVED):
 * amount, and the quantity by reason.
 */
export async function debitedOnInvoiceLines(
  q: Queryable,
  invoiceLineIds: string[],
  exceptNoteId?: string,
): Promise<Map<string, { amount: string; shortQty: string; returnQty: string }>> {
  if (invoiceLineIds.length === 0) return new Map();
  const where: SQL[] = [inArray(debitNoteLines.invoiceLineId, [...new Set(invoiceLineIds)]), notInArray(debitNotes.status, ['DRAFT', 'CANCELLED'])];
  if (exceptNoteId) where.push(ne(debitNotes.id, exceptNoteId));
  const rows = await q
    .select({
      invoiceLineId: debitNoteLines.invoiceLineId,
      amount: sql<string>`coalesce(sum(${debitNoteLines.amount}), 0)::text`,
      shortQty: sql<string>`coalesce(sum(${debitNoteLines.qty}) FILTER (WHERE ${debitNotes.reason} = 'SHORT_SUPPLY'), 0)::text`,
      returnQty: sql<string>`coalesce(sum(${debitNoteLines.qty}) FILTER (WHERE ${debitNotes.reason} = 'RETURN_TO_VENDOR'), 0)::text`,
    })
    .from(debitNoteLines)
    .innerJoin(debitNotes, eq(debitNotes.id, debitNoteLines.debitNoteId))
    .where(and(...where))
    .groupBy(debitNoteLines.invoiceLineId);
  return new Map(rows.map((r) => [r.invoiceLineId, { amount: r.amount, shortQty: r.shortQty, returnQty: r.returnQty }]));
}

/** Notes on their way (PENDING_APPROVAL, APPROVED) per invoice, invoice currency: kept within what is open. */
export async function pendingOnInvoices(q: Queryable, invoiceIds: string[], exceptNoteId?: string): Promise<Map<string, string>> {
  if (invoiceIds.length === 0) return new Map();
  const where: SQL[] = [inArray(debitNotes.invoiceId, [...new Set(invoiceIds)]), inArray(debitNotes.status, ['PENDING_APPROVAL', 'APPROVED'])];
  if (exceptNoteId) where.push(ne(debitNotes.id, exceptNoteId));
  const rows = await q
    .select({ invoiceId: debitNotes.invoiceId, amount: sql<string>`coalesce(sum(${debitNotes.totalAmount}), 0)::text` })
    .from(debitNotes)
    .where(and(...where))
    .groupBy(debitNotes.invoiceId);
  return new Map(rows.map((r) => [r.invoiceId, r.amount]));
}
