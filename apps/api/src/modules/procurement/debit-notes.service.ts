// Vendor debit notes (M3 task 5b; 0032; owner 2026-11-26, answer 7). Architecture §6 "Vendor debit note",
// "Rejected lot returned to vendor".
//
// A debit note is against a POSTED GOODS vendor invoice, in its currency and at its rate (AP comes off at the rate it
// was booked), DN-{FY}-{SEQ:5}. The Accountant (fin.debit_note.manage) enters it:
//   - PRICE_CLAIM: an amount off invoice lines;
//   - SHORT_SUPPLY: a quantity billed but not received (at most the quantity billed beyond the quantity received,
//     which the invoice booked to price variance);
//   - RETURN_TO_VENDOR: one REJECTED lot of an invoice line, at most the quantity billed and received.
// Amounts: quantity × the invoice unit price; tax as on the invoice line (its sales tax code and rate). Never more
// than the invoice line billed, nor than is open on the invoice (total − POSTED payments − POSTED notes).
// DRAFT → PENDING_APPROVAL (approval matrix DEBIT_NOTE on the PKR, Finance Manager; creator / submitter approve no
// step) → APPROVED → POSTED on the note's date (open period); a rejection returns it to DRAFT.
// Posting:
//   - PRICE_CLAIM / SHORT_SUPPLY (Accountant, fin.debit_note.manage): VENDOR_DEBIT_NOTE journal, Dr AP (vendor) /
//     Cr price variance (the invoice booked price differences and extra quantity there) / Cr input tax.
//   - RETURN_TO_VENDOR (Warehouse Manager, inv.lot.dispose, with the QA witness's e-signature; rule 1): the
//     RETURN_TO_VENDOR movement of the lot (linked on the line), and its LOT_RETURNED journal: Dr AP (vendor) / Cr
//     inventory (the lot's value) / Dr-Cr price variance (billed value − lot value) / Cr input tax. The lot becomes
//     RETURNED when it is empty.
import { Decimal } from 'decimal.js';
import {
  DebitNoteStatus,
  type CreateDebitNoteRequest,
  type DebitableDto,
  type DebitNoteDto,
  type DebitNoteLineInput,
  type DebitNoteListQuery,
  type DebitNoteReason,
  type Page,
  type PostDebitNoteRequest,
  type UpdateDebitNoteRequest,
} from '@albert/shared';
import { db, withTransaction, type Queryable, type Tx } from '../../db/client';
import { AppError } from '../../core/errors';
import { companyToday } from '../../core/dates';
import { txContext, type AuthContext, type RequestMeta } from '../../core/auth/auth.service';
import { verifyWitness } from '../../core/esign/esign.service';
import { defineTransitions, recordInitialStatus, transition } from '../../core/transition/transition';
import { cancelApproval, latestApprovalIds, registerApprovalHandler, startApproval } from '../../core/approvals/approvals.service';
import { nextDocNo } from '../../core/settings/numbering.service';
import { closeDisposedLot, disposalSubject, lockLotHolding, lotsByIds, postMovement } from '../../engines/inventory';
import { journalsOfSource, postJournal, postStockJournal, type JournalLineInput } from '../../engines/posting';
import { assertPurchVendor, purchItems, purchTaxCodes, purchVendors } from '../masters/purch-refs.service';
import * as grnRepo from './grns.repo';
import * as invRepo from './invoices.repo';
import * as repo from './debit-notes.repo';
import { userNames } from './procurement.repo';
import { splitByWeights } from './landed-costs.service';

export const DEBIT_NOTE_TABLE = 'purch.debit_notes';
export const DEBIT_NOTE_DOC_TYPE = 'DEBIT_NOTE'; // number series, journal source_type, movement ref_doc_type, approval matrix
const MANAGE_KEY = 'fin.debit_note.manage' as const;
const APPROVE_KEY = 'fin.debit_note.approve' as const;
const DISPOSE_KEY = 'inv.lot.dispose' as const;

export const DebitNoteMoves = defineTransitions<DebitNoteStatus>({
  entityTable: DEBIT_NOTE_TABLE,
  statuses: DebitNoteStatus,
  moves: [
    { from: null, to: 'DRAFT', permission: MANAGE_KEY },
    { from: 'DRAFT', to: 'PENDING_APPROVAL', permission: MANAGE_KEY },
    { from: 'PENDING_APPROVAL', to: 'APPROVED', permission: APPROVE_KEY },
    { from: 'PENDING_APPROVAL', to: 'DRAFT', permission: APPROVE_KEY, reasonRequired: true },
    { from: 'APPROVED', to: 'POSTED', permission: MANAGE_KEY },
    { from: 'DRAFT', to: 'CANCELLED', permission: MANAGE_KEY, reasonRequired: true },
    { from: 'PENDING_APPROVAL', to: 'CANCELLED', permission: MANAGE_KEY, reasonRequired: true },
    { from: 'APPROVED', to: 'CANCELLED', permission: MANAGE_KEY, reasonRequired: true },
  ],
});
/** A return note is posted by the Warehouse Manager's witnessed disposal (rule 1): its own key for the move. */
const ReturnPostMoves = defineTransitions<DebitNoteStatus>({
  entityTable: DEBIT_NOTE_TABLE,
  statuses: DebitNoteStatus,
  moves: [{ from: 'APPROVED', to: 'POSTED', permission: DISPOSE_KEY }],
});

const D = (v: string | number | null | undefined) => new Decimal(v ?? 0);
const money2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const side = (role: JournalLineInput['role'], amount: Decimal, dims: Partial<JournalLineInput> = {}): JournalLineInput[] =>
  amount.isZero() ? [] : [amount.gt(0) ? { role, ...dims, debit: amount.toFixed(2) } : { role, ...dims, credit: amount.abs().toFixed(2) }];

async function lockNote(tx: Tx, companyId: string, id: string): Promise<repo.DebitNoteRow> {
  const row = await repo.findNote(tx, companyId, id, true);
  if (!row) throw new AppError('NOT_FOUND', 'Debit note not found');
  return row;
}

function assertStatus(row: repo.DebitNoteRow, ...allowed: DebitNoteStatus[]): void {
  if (!allowed.includes(row.status)) {
    throw new AppError(row.status === 'POSTED' || row.status === 'CANCELLED' ? 'RECORD_LOCKED' : 'INVALID_TRANSITION',
      `Debit note ${row.docNo} is ${row.status}`, { status: row.status });
  }
}

// ---------------------------------------------------------------- approval hooks (approval matrix DEBIT_NOTE)

registerApprovalHandler(DEBIT_NOTE_DOC_TYPE, {
  async assertMayApprove(tx, approval, actor) {
    const n = await lockNote(tx, actor.companyId, approval.docId);
    if (actor.userId === n.createdBy || actor.userId === n.submittedBy) {
      throw new AppError('SEGREGATION_OF_DUTIES', 'Whoever creates or submits a debit note cannot approve it', { rule: 'debit note creator ≠ approver' });
    }
  },
  async onApproved(tx, approval, actor) {
    const n = await lockNote(tx, actor.companyId, approval.docId);
    await assertPurchVendor(tx, actor.companyId, n.vendorId);
    await transition(tx, DebitNoteMoves, { entityId: n.id, to: 'APPROVED', actor });
  },
  async onRejected(tx, approval, actor, reason) {
    const n = await lockNote(tx, actor.companyId, approval.docId);
    await transition(tx, DebitNoteMoves, { entityId: n.id, to: 'DRAFT', actor, reason });
  },
});

// ---------------------------------------------------------------- what an invoice line is and still allows

interface InvoiceLineRef {
  line: invRepo.InvoiceLineRow;
  grnLine: grnRepo.GrnLineRow;
  grnDocNo: string;
}

async function invoiceLineRefs(q: Queryable, companyId: string, invoiceId: string): Promise<Map<string, InvoiceLineRef>> {
  const lines = (await invRepo.linesOf(q, [invoiceId])).filter((l) => l.grnLineId);
  const grnLines = await grnRepo.grnLinesByIds(q, lines.map((l) => l.grnLineId!));
  const grns = await grnRepo.grnsByIds(q, companyId, grnLines.map((g) => g.grnId));
  const out = new Map<string, InvoiceLineRef>();
  for (const l of lines) {
    const gl = grnLines.find((g) => g.id === l.grnLineId);
    if (gl) out.set(l.id, { line: l, grnLine: gl, grnDocNo: grns.get(gl.grnId)?.docNo ?? '' });
  }
  return out;
}

/** Still open on an invoice for a new note: total − POSTED payments − POSTED notes − notes on their way. */
async function openOnInvoice(q: Queryable, invoice: invRepo.InvoiceRow, exceptNoteId?: string): Promise<Decimal> {
  const [paid, debited, pending] = await Promise.all([
    invRepo.paidOnInvoices(q, [invoice.id]),
    invRepo.debitedOnInvoices(q, [invoice.id]),
    repo.pendingOnInvoices(q, [invoice.id], exceptNoteId),
  ]);
  return D(invoice.totalAmount)
    .minus(D(paid.get(invoice.id)?.foreign))
    .minus(D(debited.get(invoice.id)?.foreign))
    .minus(D(pending.get(invoice.id)));
}

async function invoiceFor(q: Queryable, companyId: string, invoiceId: string, lock: boolean): Promise<invRepo.InvoiceRow> {
  const inv = lock ? (await invRepo.lockInvoices(q as Tx, companyId, [invoiceId]))[0] : await invRepo.findInvoice(q, companyId, invoiceId);
  if (!inv) throw new AppError('VALIDATION_FAILED', 'The invoice does not exist', { field: 'invoiceId' });
  if (inv.invoiceType !== 'GOODS' || inv.status !== 'POSTED') {
    throw new AppError('INVALID_TRANSITION', `A debit note is against a POSTED goods invoice; ${inv.docNo} is ${inv.invoiceType} ${inv.status}`, {
      status: inv.status,
    });
  }
  return inv;
}

/** The note's lines and totals from its input, checked against the invoice as it stands now. */
async function prepare(
  q: Queryable,
  companyId: string,
  invoice: invRepo.InvoiceRow,
  reason: DebitNoteReason,
  input: { dnDate: string; lines: DebitNoteLineInput[] },
  exceptNoteId?: string,
): Promise<{ lines: repo.DebitNoteLineValues[]; totals: Pick<repo.DebitNoteValues, 'goodsAmount' | 'taxAmount' | 'totalAmount' | 'totalPkr'> }> {
  if (input.dnDate > companyToday()) throw new AppError('VALIDATION_FAILED', 'The debit note date cannot be in the future', { field: 'dnDate' });
  if (input.dnDate < invoice.invoiceDate) {
    throw new AppError('VALIDATION_FAILED', `A debit note is dated on or after its invoice (${invoice.invoiceDate})`, { field: 'dnDate' });
  }
  if (reason === 'RETURN_TO_VENDOR' && input.lines.length !== 1) {
    throw new AppError('VALIDATION_FAILED', 'A return note returns one lot (one line)', { field: 'lines' });
  }
  const refs = await invoiceLineRefs(q, companyId, invoice.id);
  const debited = await repo.debitedOnInvoiceLines(q, [...refs.keys()], exceptNoteId);
  const lots = await lotsByIds(q, companyId, [...refs.values()].flatMap((r) => (r.grnLine.lotId ? [r.grnLine.lotId] : [])));
  const seen = new Set<string>();
  const drafts: Omit<repo.DebitNoteLineValues, 'amountPkr' | 'taxPkr'>[] = [];
  for (const [i, l] of input.lines.entries()) {
    const ref = refs.get(l.invoiceLineId);
    if (!ref) throw new AppError('VALIDATION_FAILED', `Line ${i + 1} names a line that is not on invoice ${invoice.docNo}`, { line: i + 1 });
    if (seen.has(ref.line.id)) throw new AppError('VALIDATION_FAILED', `Invoice line ${ref.line.lineNo} is on this note twice`, { line: i + 1 });
    seen.add(ref.line.id);
    const before = debited.get(ref.line.id);
    const unitPrice = D(ref.line.unitPrice);
    const billedQty = D(ref.line.qty);
    const matched = D(ref.line.matchedQty);
    let qty: Decimal | null = null;
    if (reason === 'PRICE_CLAIM') {
      if (!l.amount || l.qty) throw new AppError('VALIDATION_FAILED', 'A price claim takes the amount off each line', { line: i + 1 });
    } else {
      if (!l.qty || l.amount) throw new AppError('VALIDATION_FAILED', 'Give the quantity on each line', { line: i + 1 });
      qty = D(l.qty);
      const open = reason === 'SHORT_SUPPLY' ? billedQty.minus(matched).minus(D(before?.shortQty)) : matched.minus(D(before?.returnQty));
      if (qty.gt(open)) {
        throw new AppError(
          'AMOUNT_EXCEEDS_OPEN',
          reason === 'SHORT_SUPPLY'
            ? `Invoice line ${ref.line.lineNo} billed ${Decimal.max(billedQty.minus(matched), 0).toFixed(4)} beyond what was received; ${open.toFixed(4)} is still open for a short-supply claim`
            : `Invoice line ${ref.line.lineNo} billed and received ${matched.toFixed(4)}; ${open.toFixed(4)} can still be returned`,
          { line: i + 1, open: open.toFixed(4) },
        );
      }
    }
    const amount = qty ? money2(qty.times(unitPrice)) : D(l.amount);
    const amountOpen = D(ref.line.amount).minus(D(before?.amount));
    if (!amount.gt(0)) throw new AppError('VALIDATION_FAILED', `Line ${i + 1} comes to nothing`, { line: i + 1 });
    if (amount.gt(amountOpen)) {
      throw new AppError('AMOUNT_EXCEEDS_OPEN', `Invoice line ${ref.line.lineNo} has ${amountOpen.toFixed(2)} ${invoice.currency} left to debit; ${amount.toFixed(2)} is more`, {
        line: i + 1,
        open: amountOpen.toFixed(2),
      });
    }
    let lotId: string | null = null;
    if (reason === 'RETURN_TO_VENDOR') {
      lotId = ref.grnLine.lotId;
      const lot = lotId ? lots.get(lotId) : undefined;
      if (!lot || lot.status !== 'REJECTED') {
        throw new AppError('INVALID_TRANSITION', `Lot ${lot?.lotNo ?? ''} is ${lot?.status ?? 'missing'}; only a lot QC has REJECTED is returned to the vendor`, {
          line: i + 1,
          lotStatus: lot?.status ?? null,
        });
      }
    }
    drafts.push({
      lineNo: i + 1,
      invoiceLineId: ref.line.id,
      qty: qty ? qty.toFixed(4) : null,
      unitPrice: qty ? unitPrice.toFixed(6) : null,
      amount: amount.toFixed(2),
      taxCodeId: ref.line.taxCodeId,
      taxRate: D(ref.line.taxRate).toFixed(4),
      taxAmount: money2(amount.times(ref.line.taxRate).div(100)).toFixed(2),
      lotId,
    });
  }
  const goods = drafts.reduce((s, l) => s.plus(l.amount), D(0));
  const tax = drafts.reduce((s, l) => s.plus(l.taxAmount ?? 0), D(0));
  const total = goods.plus(tax);
  const open = await openOnInvoice(q, invoice, exceptNoteId);
  if (total.gt(open)) {
    throw new AppError('AMOUNT_EXCEEDS_OPEN', `${invoice.docNo} has ${open.toFixed(2)} ${invoice.currency} open (after payments and other debit notes); this note is ${total.toFixed(2)}`, {
      open: open.toFixed(2),
    });
  }
  // AP comes off at the invoice's rate; the PKR is split over the lines and their tax so it adds up exactly.
  const totalPkr = money2(total.times(invoice.exchangeRate));
  const pkr = splitByWeights(totalPkr, [...drafts.map((l) => D(l.amount)), ...drafts.map((l) => D(l.taxAmount))]);
  return {
    lines: drafts.map((l, i) => ({ ...l, amountPkr: pkr[i]!.toFixed(2), taxPkr: pkr[drafts.length + i]!.toFixed(2) })),
    totals: { goodsAmount: goods.toFixed(2), taxAmount: tax.toFixed(2), totalAmount: total.toFixed(2), totalPkr: totalPkr.toFixed(2) },
  };
}

const lineInputs = (lines: repo.DebitNoteLineRow[], reason: DebitNoteReason): DebitNoteLineInput[] =>
  lines.map((l) => (reason === 'PRICE_CLAIM' ? { invoiceLineId: l.invoiceLineId, amount: l.amount } : { invoiceLineId: l.invoiceLineId, qty: l.qty! }));

// ---------------------------------------------------------------- reading

async function toDtos(q: Queryable, companyId: string, rows: repo.DebitNoteRow[]): Promise<DebitNoteDto[]> {
  const ids = rows.map((r) => r.id);
  const lines = await repo.linesOf(q, ids);
  const invoiceLines = (await invRepo.linesOf(q, [...new Set(rows.map((r) => r.invoiceId))])).filter((l) => lines.some((x) => x.invoiceLineId === l.id));
  const grnLines = await grnRepo.grnLinesByIds(q, invoiceLines.flatMap((l) => (l.grnLineId ? [l.grnLineId] : [])));
  const [vendors, invoices, grns, items, lots, taxCodes, names, approvals] = await Promise.all([
    purchVendors(q, companyId, rows.map((r) => r.vendorId)),
    invRepo.invoicesByIds(q, companyId, rows.map((r) => r.invoiceId)),
    grnRepo.grnsByIds(q, companyId, grnLines.map((g) => g.grnId)),
    purchItems(q, companyId, grnLines.map((g) => g.itemId)),
    lotsByIds(q, companyId, lines.flatMap((l) => (l.lotId ? [l.lotId] : []))),
    purchTaxCodes(q, companyId, lines.flatMap((l) => (l.taxCodeId ? [l.taxCodeId] : []))),
    userNames(q, rows.flatMap((r) => [r.createdBy, r.submittedBy, r.postedBy].filter((u): u is string => u !== null))),
    latestApprovalIds(q, companyId, DEBIT_NOTE_TABLE, ids),
  ]);
  const journals = new Map(
    await Promise.all(rows.filter((r) => r.status === 'POSTED').map(async (r) => [r.id, await journalsOfSource(q, companyId, DEBIT_NOTE_DOC_TYPE, r.id)] as const)),
  );
  return rows.map((r) => {
    const v = vendors.get(r.vendorId);
    const inv = invoices.get(r.invoiceId);
    return {
      id: r.id,
      docNo: r.docNo,
      reason: r.reason,
      vendorId: r.vendorId,
      vendorCode: v?.code ?? '',
      vendorName: v?.name ?? '',
      invoiceId: r.invoiceId,
      invoiceDocNo: inv?.docNo ?? '',
      vendorInvoiceNo: inv?.vendorInvoiceNo ?? '',
      dnDate: r.dnDate,
      currency: r.currency,
      exchangeRate: r.exchangeRate,
      goodsAmount: r.goodsAmount,
      taxAmount: r.taxAmount,
      totalAmount: r.totalAmount,
      totalPkr: r.totalPkr,
      notes: r.notes,
      status: r.status,
      approvalId: approvals.get(r.id) ?? null,
      submittedByName: r.submittedBy ? (names.get(r.submittedBy) ?? '') : null,
      postingDate: r.postingDate,
      postedByName: r.postedBy ? (names.get(r.postedBy) ?? '') : null,
      postedAt: r.postedAt ? r.postedAt.toISOString() : null,
      journalDocNo: journals.get(r.id)?.find((j) => j.reversalOf === null && j.event !== 'ROUNDING_DIFFERENCE')?.docNo ?? null,
      createdBy: r.createdBy,
      createdByName: names.get(r.createdBy) ?? '',
      createdAt: r.createdAt.toISOString(),
      lines: lines
        .filter((l) => l.debitNoteId === r.id)
        .map((l) => {
          const il = invoiceLines.find((x) => x.id === l.invoiceLineId);
          const gl = il?.grnLineId ? grnLines.find((g) => g.id === il.grnLineId) : undefined;
          const item = gl ? items.get(gl.itemId) : undefined;
          return {
            id: l.id,
            lineNo: l.lineNo,
            invoiceLineId: l.invoiceLineId,
            invoiceLineNo: il?.lineNo ?? 0,
            itemCode: item?.code ?? null,
            itemName: item?.name ?? null,
            grnDocNo: gl ? (grns.get(gl.grnId)?.docNo ?? null) : null,
            lotId: l.lotId,
            lotNo: l.lotId ? (lots.get(l.lotId)?.lotNo ?? null) : null,
            qty: l.qty,
            unitPrice: l.unitPrice,
            amount: l.amount,
            taxCode: l.taxCodeId ? (taxCodes.get(l.taxCodeId)?.code ?? null) : null,
            taxRate: l.taxRate,
            taxAmount: l.taxAmount,
            amountPkr: l.amountPkr,
            taxPkr: l.taxPkr,
            movementId: l.movementId,
            stockValuePkr: l.stockValuePkr,
            priceVariancePkr: l.priceVariancePkr,
          };
        }),
    };
  });
}

export async function listDebitNotes(auth: AuthContext, query: DebitNoteListQuery): Promise<Page<DebitNoteDto>> {
  const { rows, total } = await repo.listNotes(
    db,
    auth.companyId,
    { status: query.status, search: query.search, vendorId: query.vendorId, invoiceId: query.invoiceId },
    { limit: query.pageSize, offset: (query.page - 1) * query.pageSize },
  );
  return { items: await toDtos(db, auth.companyId, rows), total, page: query.page, pageSize: query.pageSize };
}

export async function getDebitNote(auth: AuthContext, id: string): Promise<DebitNoteDto> {
  const row = await repo.findNote(db, auth.companyId, id);
  if (!row) throw new AppError('NOT_FOUND', 'Debit note not found');
  const [dto] = await toDtos(db, auth.companyId, [row]);
  return dto!;
}

/** For the debit-note form: each line of a POSTED goods invoice and what can still be debited on it. */
export async function debitable(auth: AuthContext, invoiceId: string): Promise<DebitableDto> {
  const invoice = await invoiceFor(db, auth.companyId, invoiceId, false);
  const refs = await invoiceLineRefs(db, auth.companyId, invoice.id);
  const debited = await repo.debitedOnInvoiceLines(db, [...refs.keys()]);
  const [items, lots, taxCodes] = await Promise.all([
    purchItems(db, auth.companyId, [...refs.values()].map((r) => r.grnLine.itemId)),
    lotsByIds(db, auth.companyId, [...refs.values()].flatMap((r) => (r.grnLine.lotId ? [r.grnLine.lotId] : []))),
    purchTaxCodes(db, auth.companyId, [...refs.values()].flatMap((r) => (r.line.taxCodeId ? [r.line.taxCodeId] : []))),
  ]);
  return {
    invoiceId: invoice.id,
    docNo: invoice.docNo,
    currency: invoice.currency,
    openAmount: (await openOnInvoice(db, invoice)).toFixed(2),
    lines: [...refs.values()].map(({ line, grnLine, grnDocNo }) => {
      const d = debited.get(line.id);
      const lot = grnLine.lotId ? lots.get(grnLine.lotId) : undefined;
      const matched = D(line.matchedQty);
      return {
        invoiceLineId: line.id,
        lineNo: line.lineNo,
        itemCode: items.get(grnLine.itemId)?.code ?? '',
        itemName: items.get(grnLine.itemId)?.name ?? '',
        grnDocNo,
        lotId: grnLine.lotId,
        lotNo: lot?.lotNo ?? '',
        lotStatus: lot?.status ?? null,
        qty: D(line.qty).toFixed(4),
        matchedQty: matched.toFixed(4),
        unitPrice: D(line.unitPrice).toFixed(6),
        amount: D(line.amount).toFixed(2),
        taxCode: line.taxCodeId ? (taxCodes.get(line.taxCodeId)?.code ?? null) : null,
        taxRate: D(line.taxRate).toFixed(4),
        debitedAmount: D(d?.amount).toFixed(2),
        shortQtyOpen: Decimal.max(D(line.qty).minus(matched).minus(D(d?.shortQty)), 0).toFixed(4),
        returnQtyOpen: Decimal.max(matched.minus(D(d?.returnQty)), 0).toFixed(4),
        amountOpen: Decimal.max(D(line.amount).minus(D(d?.amount)), 0).toFixed(2),
      };
    }),
  };
}

// ---------------------------------------------------------------- writing

export async function createDebitNote(auth: AuthContext, input: CreateDebitNoteRequest): Promise<DebitNoteDto> {
  const id = await withTransaction(txContext(auth, 'enter debit note'), async (tx) => {
    const invoice = await invoiceFor(tx, auth.companyId, input.invoiceId, true);
    await assertPurchVendor(tx, auth.companyId, invoice.vendorId);
    const { lines, totals } = await prepare(tx, auth.companyId, invoice, input.reason, input);
    const noteId = await repo.insertNote(tx, {
      docNo: await nextDocNo(tx, DEBIT_NOTE_DOC_TYPE, input.dnDate),
      reason: input.reason,
      vendorId: invoice.vendorId,
      invoiceId: invoice.id,
      dnDate: input.dnDate,
      currency: invoice.currency,
      exchangeRate: invoice.exchangeRate,
      notes: input.notes?.trim() || null,
      ...totals,
    });
    await recordInitialStatus(tx, DebitNoteMoves, { entityId: noteId, to: 'DRAFT', actor: auth });
    await repo.replaceLines(tx, noteId, lines);
    return noteId;
  });
  return getDebitNote(auth, id);
}

export async function updateDebitNote(auth: AuthContext, id: string, input: UpdateDebitNoteRequest): Promise<DebitNoteDto> {
  await withTransaction(txContext(auth, 'edit debit note'), async (tx) => {
    const row = await lockNote(tx, auth.companyId, id);
    assertStatus(row, 'DRAFT');
    const invoice = await invoiceFor(tx, auth.companyId, row.invoiceId, true);
    const { lines, totals } = await prepare(tx, auth.companyId, invoice, row.reason, input, id);
    await repo.replaceLines(tx, id, lines);
    await repo.updateNote(tx, id, { dnDate: input.dnDate, notes: input.notes?.trim() || null, ...totals });
  });
  return getDebitNote(auth, id);
}

/** Re-checks the stored note against the invoice now (amounts open, lot status). */
async function recheck(tx: Tx, companyId: string, row: repo.DebitNoteRow): Promise<{ invoice: invRepo.InvoiceRow; lines: repo.DebitNoteLineRow[] }> {
  const invoice = await invoiceFor(tx, companyId, row.invoiceId, true);
  await assertPurchVendor(tx, companyId, row.vendorId);
  const lines = await repo.linesOf(tx, [row.id]);
  await prepare(tx, companyId, invoice, row.reason, { dnDate: row.dnDate, lines: lineInputs(lines, row.reason) }, row.id);
  return { invoice, lines };
}

/** Submit for approval (approval matrix DEBIT_NOTE, on the PKR the note takes off AP). */
export async function submitDebitNote(auth: AuthContext, id: string): Promise<DebitNoteDto> {
  await withTransaction(txContext(auth, 'submit debit note'), async (tx) => {
    const row = await lockNote(tx, auth.companyId, id);
    assertStatus(row, 'DRAFT');
    await recheck(tx, auth.companyId, row);
    await transition(tx, DebitNoteMoves, {
      entityId: id,
      to: 'PENDING_APPROVAL',
      actor: auth,
      alsoSet: { submitted_by: auth.userId, submitted_at: new Date().toISOString() },
    });
    await startApproval(tx, auth, {
      docType: DEBIT_NOTE_DOC_TYPE,
      docTable: DEBIT_NOTE_TABLE,
      docId: id,
      docNo: row.docNo,
      value: { measure: 'AMOUNT_PKR', amount: row.totalPkr },
    });
  });
  return getDebitNote(auth, id);
}

export async function cancelDebitNote(auth: AuthContext, id: string, reason: string): Promise<DebitNoteDto> {
  await withTransaction(txContext(auth, `cancel debit note: ${reason}`), async (tx) => {
    const row = await lockNote(tx, auth.companyId, id);
    assertStatus(row, 'DRAFT', 'PENDING_APPROVAL', 'APPROVED');
    if (row.status === 'PENDING_APPROVAL') await cancelApproval(tx, auth, DEBIT_NOTE_TABLE, id, reason);
    await transition(tx, DebitNoteMoves, { entityId: id, to: 'CANCELLED', actor: auth, reason });
  });
  return getDebitNote(auth, id);
}

/**
 * Posts an APPROVED note on its date (open period). A price claim / short supply posts its VENDOR_DEBIT_NOTE journal
 * (fin.debit_note.manage). A return is the Warehouse Manager's disposal (inv.lot.dispose) with the QA witness's
 * signature for the movement: the RETURN_TO_VENDOR movement, linked on the line, and its LOT_RETURNED journal.
 */
export async function postDebitNote(auth: AuthContext, id: string, input: PostDebitNoteRequest, meta: RequestMeta): Promise<DebitNoteDto> {
  const pre = await repo.findNote(db, auth.companyId, id);
  if (!pre) throw new AppError('NOT_FOUND', 'Debit note not found');
  if (pre.reason === 'RETURN_TO_VENDOR') return postReturn(auth, pre, input, meta);
  if (input.witness || input.locationId) throw new AppError('VALIDATION_FAILED', 'Only a return note moves stock (location and witness)');
  if (!auth.permissions.has(MANAGE_KEY)) {
    throw new AppError('FORBIDDEN', `Posting a ${pre.reason} debit note needs ${MANAGE_KEY}`, { permission: MANAGE_KEY });
  }
  await withTransaction(txContext(auth, 'post debit note'), async (tx) => {
    const row = await lockNote(tx, auth.companyId, id);
    assertStatus(row, 'APPROVED');
    const { invoice, lines } = await recheck(tx, auth.companyId, row);
    const categories = await lineCategories(tx, auth.companyId, invoice.id, lines);
    const journal: JournalLineInput[] = [{ role: 'ACCOUNTS_PAYABLE', vendorId: row.vendorId, debit: D(row.totalPkr).toFixed(2) }];
    for (const l of lines) {
      journal.push(...side('PRICE_VARIANCE', D(l.amountPkr).neg(), { itemCategoryId: categories.get(l.id) ?? null }));
      if (l.taxCodeId) journal.push(...side('INPUT_TAX', D(l.taxPkr).neg(), { taxCodeId: l.taxCodeId }));
      await repo.setLineResult(tx, l.id, { priceVariancePkr: D(l.amountPkr).toFixed(2) });
    }
    await postJournal(tx, auth, {
      event: 'VENDOR_DEBIT_NOTE',
      sourceType: DEBIT_NOTE_DOC_TYPE,
      sourceId: id,
      date: row.dnDate,
      narration: `Debit note ${row.docNo} (${row.reason}) on ${invoice.docNo}${row.currency !== 'PKR' ? ` ${row.totalAmount} ${row.currency} @ ${row.exchangeRate}` : ''}`,
      lines: journal,
    });
    await transition(tx, DebitNoteMoves, {
      entityId: id,
      to: 'POSTED',
      actor: auth,
      alsoSet: { posting_date: row.dnDate, posted_by: auth.userId, posted_at: new Date().toISOString() },
    });
  });
  return getDebitNote(auth, id);
}

/** The item category of each note line (price variance is booked by category, like the invoice). */
async function lineCategories(tx: Tx, companyId: string, invoiceId: string, lines: repo.DebitNoteLineRow[]): Promise<Map<string, string>> {
  const invoiceLines = await invRepo.linesOf(tx, [invoiceId]);
  const grnLines = await grnRepo.grnLinesByIds(tx, invoiceLines.flatMap((l) => (l.grnLineId ? [l.grnLineId] : [])));
  const items = await purchItems(tx, companyId, grnLines.map((g) => g.itemId));
  const out = new Map<string, string>();
  for (const l of lines) {
    const il = invoiceLines.find((x) => x.id === l.invoiceLineId);
    const gl = il?.grnLineId ? grnLines.find((g) => g.id === il.grnLineId) : undefined;
    const cat = gl ? items.get(gl.itemId)?.categoryId : undefined;
    if (cat) out.set(l.id, cat);
  }
  return out;
}

async function postReturn(auth: AuthContext, pre: repo.DebitNoteRow, input: PostDebitNoteRequest, meta: RequestMeta): Promise<DebitNoteDto> {
  if (!auth.permissions.has(DISPOSE_KEY)) {
    throw new AppError('FORBIDDEN', `A return to the vendor is posted by the Warehouse Manager (${DISPOSE_KEY}) with a QA witness`, { permission: DISPOSE_KEY });
  }
  if (!input.locationId) throw new AppError('VALIDATION_FAILED', 'Name the location the lot leaves', { field: 'locationId' });
  if (!input.witness) throw new AppError('WITNESS_REQUIRED', 'A return to the vendor needs the QA witness e-signature (qa.lot.witness)', { permission: 'qa.lot.witness' });
  const [line] = await repo.linesOf(db, [pre.id]);
  if (!line?.lotId || !line.qty) throw new AppError('VALIDATION_FAILED', `${pre.docNo} has no lot to return`);
  // Rule 1 / 0020: the QA witness signs for exactly this movement, at this terminal, before the transaction.
  const witness = await verifyWitness(auth, input.witness, meta, disposalSubject('RETURN_TO_VENDOR', line.lotId, line.qty));
  await withTransaction(txContext(auth, `return to vendor on debit note ${pre.docNo}`), async (tx) => {
    const row = await lockNote(tx, auth.companyId, pre.id);
    assertStatus(row, 'APPROVED');
    const { invoice, lines } = await recheck(tx, auth.companyId, row);
    const l = lines[0]!;
    const movement = await postMovement(tx, auth, {
      type: 'RETURN_TO_VENDOR',
      lotId: l.lotId!,
      locationId: input.locationId!,
      qty: l.qty!,
      date: row.dnDate,
      refDocType: DEBIT_NOTE_DOC_TYPE,
      refDocId: row.id,
      witness,
    });
    const stockValue = D(movement.value).abs();
    const variance = D(l.amountPkr).minus(stockValue);
    await repo.setLineResult(tx, l.id, { movementId: movement.id, stockValuePkr: stockValue.toFixed(2), priceVariancePkr: variance.toFixed(2) });
    // The movement gives Dr AP / Cr inventory at the lot's value; the rest of what the vendor billed for it goes to
    // price variance, and the input tax claimed on it is reversed.
    const otherLines: JournalLineInput[] = [
      ...side('ACCOUNTS_PAYABLE', variance.plus(l.taxPkr), { vendorId: row.vendorId }),
      ...side('PRICE_VARIANCE', variance.neg(), { itemCategoryId: movement.itemCategoryId }),
      ...(l.taxCodeId ? side('INPUT_TAX', D(l.taxPkr).neg(), { taxCodeId: l.taxCodeId }) : []),
    ];
    await postStockJournal(tx, auth, {
      movements: [movement],
      narration: `Debit note ${row.docNo}: lot ${movement.lotNo} returned to the vendor (invoice ${invoice.docNo})`,
      dimensions: { vendorId: row.vendorId },
      ...(otherLines.length ? { otherLines } : {}),
    });
    if (D((await lockLotHolding(tx, auth, l.lotId!)).qty).isZero()) await closeDisposedLot(tx, auth, movement);
    await transition(tx, ReturnPostMoves, {
      entityId: row.id,
      to: 'POSTED',
      actor: auth,
      alsoSet: { posting_date: row.dnDate, posted_by: auth.userId, posted_at: new Date().toISOString() },
    });
  });
  return getDebitNote(auth, pre.id);
}
