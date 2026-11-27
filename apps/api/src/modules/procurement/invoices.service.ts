// Vendor invoices (M3 task 5; 0031). Architecture §6 "Vendor invoice posted", §7.5; owner Q3, Q4, Q5 (2026-11-25).
//
// The Accountant (fin.invoice.manage) enters a vendor's bill:
//   - GOODS: against GRN lines of one PO (POSTED receipts), quantity and the vendor's unit price, in the PO's
//     currency. 3-way match per line: price vs the PO line (setting purch.invoice.price_tolerance_pct) and the
//     cumulative quantity billed vs the GRN line (purch.invoice.qty_tolerance_pct). Inside both → POSTED; outside
//     either → MATCH_EXCEPTION (owner Q5), which a Finance Manager (fin.invoice.match_release) releases with an
//     e-signature and a reason, creator ≠ releaser, and then it posts; or returns to DRAFT.
//   - CHARGES: against POSTED landed costs (owner Q3): settles the landed-cost clearing account; "Pakistan Customs"
//     is an ordinary vendor billing the duties and import taxes. Billed in the charge's currency, never beyond what is
//     open (charge + posted corrections − already billed).
//   Sales tax on the bill: a SALES_TAX code per line, tax = round(amount × rate, 2) → input tax.
// IAS 21 (owner Q4): the invoice converts at Finance's rate on the invoice date (latest on or before, max age),
// refreshed at posting. Per GOODS line: GRNI cleared = the receipt value of the quantity matched (≤ received, not yet
// billed); rate difference = that quantity at the PO price at the invoice rate − GRNI cleared → exchange gain/loss;
// the rest (price difference, extra quantity, paisa) → price variance. Per CHARGES line: clearing taken off in
// proportion to what is open; the rest → exchange gain/loss. AP keeps the invoice currency and foreign amount.
// Posting date = invoice date (open period, rule 11). A fully received PO whose receipts are all billed → CLOSED.
// Reversal (M3 task 5b, owner 2026-11-26): a Finance Manager (fin.invoice.reverse) reverses a POSTED invoice that no
// payment and no debit note (neither cancelled nor reversed; owner 2026-11-27: debit note first) names, with an e-signature (REVERSED) and a
// reason: the journal is mirrored on the reversal day (open period), the GRN quantities and charges are open for
// billing again, and a CLOSED PO goes back to RECEIVED.
import { Decimal } from 'decimal.js';
import {
  VendorInvoiceStatus,
  type BillableDto,
  type CreateVendorInvoiceRequest,
  type Page,
  type PermissionKey,
  type ReleaseVendorInvoiceRequest,
  type ReverseVendorDocumentRequest,
  type UpdateVendorInvoiceRequest,
  type VendorInvoiceDto,
  type VendorInvoiceLineInput,
  type VendorInvoiceListQuery,
  type VendorInvoiceType,
} from '@albert/shared';
import { db, withTransaction, type Queryable, type Tx } from '../../db/client';
import { AppError } from '../../core/errors';
import { companyToday } from '../../core/dates';
import { txContext, type AuthContext, type RequestMeta } from '../../core/auth/auth.service';
import { recordSignature, verifySignature, type SignatureRecord } from '../../core/esign/esign.service';
import { defineTransitions, recordInitialStatus, transition, type Actor, type TransitionMap } from '../../core/transition/transition';
import { nextDocNo } from '../../core/settings/numbering.service';
import { lotsByIds, movementsOfDocument } from '../../engines/inventory';
import { journalsOfSource, postJournal, reverseJournal, type JournalLineInput, type SourceJournal } from '../../engines/posting';
import { rateOn } from '../finance/rates.service';
import { assertPurchVendor, purchItems, purchTaxCodes, purchVendors, type PurchVendorRef } from '../masters/purch-refs.service';
import * as grnRepo from './grns.repo';
import * as landedRepo from './landed-costs.repo';
import * as repo from './invoices.repo';
import { findPo, poLinesOf, userNames, type PoRow } from './procurement.repo';
import { closePoIfInvoiced, reopenPoAfterInvoiceReversal } from './orders.service';
import { invoiceTolerances } from './procurement.settings';
import { splitByWeights } from './landed-costs.service';

const GRN_DOC_TYPE = 'GRN'; // = grns.service GRN_DOC_TYPE (not imported: grns.service reads invoices for its reversal check)

export const INVOICE_TABLE = 'purch.vendor_invoices';
export const INVOICE_DOC_TYPE = 'VENDOR_INVOICE'; // number series, journal source_type
const MANAGE_KEY = 'fin.invoice.manage' as const;
const RELEASE_KEY = 'fin.invoice.match_release' as const;
const REVERSE_KEY = 'fin.invoice.reverse' as const;

const maps = new Map<PermissionKey, TransitionMap<VendorInvoiceStatus>>();
/**
 * One map per key (rule 7): fin.invoice.manage enters, posts (or holds in MATCH_EXCEPTION) and cancels;
 * fin.invoice.match_release releases a held invoice with an e-signature (it posts) or returns it to DRAFT;
 * fin.invoice.reverse reverses a posted one with an e-signature (owner 2026-11-26).
 */
export function vendorInvoiceMoves(key: typeof MANAGE_KEY | typeof RELEASE_KEY | typeof REVERSE_KEY): TransitionMap<VendorInvoiceStatus> {
  let map = maps.get(key);
  if (!map) {
    map = defineTransitions<VendorInvoiceStatus>({
      entityTable: INVOICE_TABLE,
      statuses: VendorInvoiceStatus,
      moves:
        key === MANAGE_KEY
          ? [
              { from: null, to: 'DRAFT', permission: key },
              { from: 'DRAFT', to: 'POSTED', permission: key },
              { from: 'DRAFT', to: 'MATCH_EXCEPTION', permission: key },
              { from: 'DRAFT', to: 'CANCELLED', permission: key, reasonRequired: true },
              { from: 'MATCH_EXCEPTION', to: 'CANCELLED', permission: key, reasonRequired: true },
            ]
          : key === RELEASE_KEY
            ? [
                { from: 'MATCH_EXCEPTION', to: 'POSTED', permission: key, esign: ['APPROVED'], reasonRequired: true },
                { from: 'MATCH_EXCEPTION', to: 'DRAFT', permission: key, reasonRequired: true },
              ]
            : [{ from: 'POSTED', to: 'REVERSED', permission: key, esign: ['REVERSED'], reasonRequired: true }],
    });
    maps.set(key, map);
  }
  return map;
}

const D = (v: string | number | null | undefined) => new Decimal(v ?? 0);
const money2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------- reading

async function toDtos(q: Queryable, companyId: string, rows: repo.InvoiceRow[]): Promise<VendorInvoiceDto[]> {
  const ids = rows.map((r) => r.id);
  const lines = await repo.linesOf(q, ids);
  const grnLines = await grnRepo.grnLinesByIds(q, lines.flatMap((l) => (l.grnLineId ? [l.grnLineId] : [])));
  const [vendors, grns, charges, taxCodes, items, lots, paid, debited, names, pos] = await Promise.all([
    purchVendors(q, companyId, rows.map((r) => r.vendorId)),
    grnRepo.grnsByIds(q, companyId, grnLines.map((g) => g.grnId)),
    landedRepo.chargesByIds(q, companyId, lines.flatMap((l) => (l.landedCostId ? [l.landedCostId] : []))),
    purchTaxCodes(q, companyId, lines.flatMap((l) => (l.taxCodeId ? [l.taxCodeId] : []))),
    purchItems(q, companyId, grnLines.map((g) => g.itemId)),
    lotsByIds(q, companyId, grnLines.flatMap((g) => (g.lotId ? [g.lotId] : []))),
    repo.paidOnInvoices(q, ids),
    repo.debitedOnInvoices(q, ids),
    userNames(q, rows.flatMap((r) => [r.createdBy, ...(r.postedBy ? [r.postedBy] : []), ...(r.releasedBy ? [r.releasedBy] : []), ...(r.reversedBy ? [r.reversedBy] : [])])),
    Promise.all([...new Set(rows.flatMap((r) => (r.poId ? [r.poId] : [])))].map((p) => findPo(q, companyId, p))),
  ]);
  const types = await landedRepo.typesByIds(q, companyId, [...charges.values()].map((c) => c.chargeTypeId));
  const poById = new Map(pos.flatMap((p) => (p ? [[p.id, p] as const] : [])));
  const journals = new Map(
    await Promise.all(
      rows
        .filter((r) => r.status === 'POSTED' || r.status === 'REVERSED')
        .map(async (r) => [r.id, await journalsOfSource(q, companyId, INVOICE_DOC_TYPE, r.id)] as const),
    ),
  );
  const original = (js: SourceJournal[] | undefined) => js?.find((j) => j.reversalOf === null)?.docNo ?? null;
  const reversal = (js: SourceJournal[] | undefined) => js?.find((j) => j.reversalOf !== null)?.docNo ?? null;
  return rows.map((r) => {
    const v = vendors.get(r.vendorId);
    const p = paid.get(r.id);
    const dn = debited.get(r.id);
    return {
      id: r.id,
      docNo: r.docNo,
      invoiceType: r.invoiceType,
      vendorId: r.vendorId,
      vendorCode: v?.code ?? '',
      vendorName: v?.name ?? '',
      poId: r.poId,
      poDocNo: r.poId ? (poById.get(r.poId)?.docNo ?? null) : null,
      vendorInvoiceNo: r.vendorInvoiceNo,
      invoiceDate: r.invoiceDate,
      dueDate: r.dueDate,
      currency: r.currency,
      exchangeRate: r.exchangeRate,
      exchangeRateDate: r.exchangeRateDate,
      goodsAmount: r.goodsAmount,
      taxAmount: r.taxAmount,
      totalAmount: r.totalAmount,
      totalPkr: r.totalPkr,
      paidAmount: D(p?.foreign).toFixed(2),
      debitedAmount: D(dn?.foreign).toFixed(2),
      openAmount: r.status === 'POSTED' ? D(r.totalAmount).minus(D(p?.foreign)).minus(D(dn?.foreign)).toFixed(2) : '0.00',
      openPkr: r.status === 'POSTED' ? D(r.totalPkr).minus(D(p?.carrying)).minus(D(dn?.pkr)).toFixed(2) : '0.00',
      notes: r.notes,
      status: r.status,
      exceptionAt: r.exceptionAt ? r.exceptionAt.toISOString() : null,
      releasedByName: r.releasedBy ? (names.get(r.releasedBy) ?? '') : null,
      releasedAt: r.releasedAt ? r.releasedAt.toISOString() : null,
      releaseReason: r.releaseReason,
      postingDate: r.postingDate,
      postedByName: r.postedBy ? (names.get(r.postedBy) ?? '') : null,
      postedAt: r.postedAt ? r.postedAt.toISOString() : null,
      journalDocNo: original(journals.get(r.id)),
      reversedByName: r.reversedBy ? (names.get(r.reversedBy) ?? '') : null,
      reversedAt: r.reversedAt ? r.reversedAt.toISOString() : null,
      reversalDate: r.reversalDate,
      reversalReason: r.reversalReason,
      reversalJournalDocNo: reversal(journals.get(r.id)),
      createdBy: r.createdBy,
      createdByName: names.get(r.createdBy) ?? '',
      createdAt: r.createdAt.toISOString(),
      lines: lines
        .filter((l) => l.invoiceId === r.id)
        .map((l) => {
          const gl = l.grnLineId ? grnLines.find((g) => g.id === l.grnLineId) : undefined;
          const ch = l.landedCostId ? charges.get(l.landedCostId) : undefined;
          const item = gl ? items.get(gl.itemId) : undefined;
          return {
            id: l.id,
            lineNo: l.lineNo,
            grnLineId: l.grnLineId,
            grnDocNo: gl ? (grns.get(gl.grnId)?.docNo ?? null) : null,
            lotNo: gl?.lotId ? (lots.get(gl.lotId)?.lotNo ?? null) : null,
            landedCostId: l.landedCostId,
            landedCostDocNo: ch?.docNo ?? null,
            chargeTypeCode: ch ? (types.get(ch.chargeTypeId)?.code ?? null) : null,
            itemCode: item?.code ?? null,
            itemName: item?.name ?? (ch ? (types.get(ch.chargeTypeId)?.name ?? null) : null),
            qty: l.qty,
            unitPrice: l.unitPrice,
            amount: l.amount,
            taxCodeId: l.taxCodeId,
            taxCode: l.taxCodeId ? (taxCodes.get(l.taxCodeId)?.code ?? null) : null,
            taxRate: l.taxRate,
            taxAmount: l.taxAmount,
            poUnitPrice: l.poUnitPrice,
            priceDiffPct: l.priceDiffPct,
            qtyOver: l.qtyOver,
            inTolerance: l.inTolerance,
            amountPkr: l.amountPkr,
            taxPkr: l.taxPkr,
            clearedPkr: l.clearedPkr,
            matchedQty: l.matchedQty,
            priceVariancePkr: l.priceVariancePkr,
            exchangeDiffPkr: l.exchangeDiffPkr,
          };
        }),
    };
  });
}

export async function listVendorInvoices(auth: AuthContext, query: VendorInvoiceListQuery): Promise<Page<VendorInvoiceDto>> {
  const { rows, total } = await repo.listInvoices(
    db,
    auth.companyId,
    { status: query.status, search: query.search, vendorId: query.vendorId, poId: query.poId },
    { limit: query.pageSize, offset: (query.page - 1) * query.pageSize },
  );
  return { items: await toDtos(db, auth.companyId, rows), total, page: query.page, pageSize: query.pageSize };
}

export async function getVendorInvoice(auth: AuthContext, id: string): Promise<VendorInvoiceDto> {
  const row = await repo.findInvoice(db, auth.companyId, id);
  if (!row) throw new AppError('NOT_FOUND', 'Vendor invoice not found');
  const [dto] = await toDtos(db, auth.companyId, [row]);
  return dto!;
}

/** GOODS lines of an invoice, as received: the GRN line, its GRN, the PO line price and the GRNI its receipt booked. */
interface GoodsRef {
  grnLine: grnRepo.GrnLineRow;
  grn: grnRepo.GrnRow;
  poPrice: string;
}

async function goodsRefs(q: Queryable, companyId: string, grnLineIds: string[]): Promise<Map<string, GoodsRef>> {
  const lines = await grnRepo.grnLinesByIds(q, grnLineIds);
  const grns = await grnRepo.grnsByIds(q, companyId, lines.map((l) => l.grnId));
  const poLines = await poLinesOf(q, [...new Set([...grns.values()].map((g) => g.poId))]);
  const out = new Map<string, GoodsRef>();
  for (const l of lines) {
    const grn = grns.get(l.grnId);
    const pl = poLines.find((p) => p.id === l.poLineId);
    if (grn && pl) out.set(l.id, { grnLine: l, grn, poPrice: pl.unitPrice });
  }
  return out;
}

/** A charge's billing state (its currency and PKR): charged = original + POSTED corrections; billed on POSTED invoices. */
async function chargeStates(q: Queryable, companyId: string, ids: string[], exceptInvoiceId?: string) {
  const charges = await landedRepo.chargesByIds(q, companyId, ids);
  const corrections = await landedRepo.correctionsOf(q, [...charges.keys()]);
  const billed = await repo.chargesBilled(q, [...charges.keys()], exceptInvoiceId);
  const out = new Map<string, { charge: landedRepo.LandedCostRow; chargedForeign: Decimal; chargedPkr: Decimal; billedForeign: Decimal; billedPkr: Decimal }>();
  for (const c of charges.values()) {
    const posted = corrections.filter((x) => x.correctionOf === c.id && x.status === 'POSTED');
    out.set(c.id, {
      charge: c,
      chargedForeign: posted.reduce((s, x) => s.plus(x.foreignAmount), D(c.foreignAmount)),
      chargedPkr: posted.reduce((s, x) => s.plus(x.amount), D(c.amount)),
      billedForeign: D(billed.get(c.id)?.amount),
      billedPkr: D(billed.get(c.id)?.cleared),
    });
  }
  return out;
}

/** What can still be billed: the received GRN lines of a PO (GOODS) or a vendor's open landed costs (CHARGES). */
export async function billable(auth: AuthContext, f: { poId?: string; vendorId?: string }): Promise<BillableDto> {
  if (f.poId) {
    const po = await findPo(db, auth.companyId, f.poId);
    if (!po) throw new AppError('NOT_FOUND', 'Purchase order not found');
    const { rows: grns } = await grnRepo.listGrns(db, auth.companyId, { poId: po.id, status: 'POSTED' }, { limit: 500, offset: 0 });
    const lines = await grnRepo.grnLinesOf(db, grns.map((g) => g.id));
    const [poLines, invoiced, items, lots] = await Promise.all([
      poLinesOf(db, [po.id]),
      repo.invoicedOnGrnLines(db, lines.map((l) => l.id)),
      purchItems(db, auth.companyId, lines.map((l) => l.itemId)),
      lotsByIds(db, auth.companyId, lines.flatMap((l) => (l.lotId ? [l.lotId] : []))),
    ]);
    return {
      charges: [],
      goods: lines
        .map((l) => {
          const g = grns.find((x) => x.id === l.grnId)!;
          const billedQty = D(invoiced.get(l.id)?.qty);
          return {
            grnLineId: l.id,
            grnId: g.id,
            grnDocNo: g.docNo,
            grnDate: g.grnDate,
            lineNo: l.lineNo,
            itemCode: items.get(l.itemId)?.code ?? '',
            itemName: items.get(l.itemId)?.name ?? '',
            lotNo: l.lotId ? (lots.get(l.lotId)?.lotNo ?? '') : '',
            receivedQty: D(l.qty).toFixed(4),
            invoicedQty: billedQty.toFixed(4),
            openQty: Decimal.max(D(l.qty).minus(billedQty), 0).toFixed(4),
            poUnitPrice: D(poLines.find((p) => p.id === l.poLineId)?.unitPrice).toFixed(6),
            currency: po.currency,
          };
        })
        .filter((l) => D(l.openQty).gt(0)),
    };
  }
  const vendor = (await purchVendors(db, auth.companyId, [f.vendorId!])).get(f.vendorId!);
  if (!vendor) throw new AppError('NOT_FOUND', 'Vendor not found');
  const originals = await landedRepo.postedOriginalsForVendor(db, auth.companyId, vendor.id);
  const states = await chargeStates(db, auth.companyId, originals.map((c) => c.id));
  const types = await landedRepo.typesByIds(db, auth.companyId, originals.map((c) => c.chargeTypeId));
  const grns = await grnRepo.grnsByIds(db, auth.companyId, originals.map((c) => c.grnId));
  return {
    goods: [],
    charges: originals
      .map((c) => {
        const s = states.get(c.id)!;
        return {
          landedCostId: c.id,
          docNo: c.docNo,
          grnDocNo: grns.get(c.grnId)?.docNo ?? '',
          chargeTypeCode: types.get(c.chargeTypeId)?.code ?? '',
          chargeTypeName: types.get(c.chargeTypeId)?.name ?? '',
          chargeDate: c.chargeDate,
          currency: c.currency,
          chargedAmount: s.chargedForeign.toFixed(2),
          invoicedAmount: s.billedForeign.toFixed(2),
          openAmount: s.chargedForeign.minus(s.billedForeign).toFixed(2),
          reference: c.reference,
        };
      })
      .filter((c) => D(c.openAmount).gt(0)),
  };
}

// ---------------------------------------------------------------- writing

interface Header {
  type: VendorInvoiceType;
  vendor: PurchVendorRef;
  po: PoRow | null;
}

/** Checks the lines against what was received / charged now; the line values and the invoice currency. */
async function prepareLines(
  q: Queryable,
  companyId: string,
  h: Header,
  input: VendorInvoiceLineInput[],
  exceptInvoiceId?: string,
): Promise<{ lines: repo.InvoiceLineValues[]; currency: string }> {
  const taxCodes = await purchTaxCodes(q, companyId, input.flatMap((l) => (l.taxCodeId ? [l.taxCodeId] : [])));
  const tax = (l: VendorInvoiceLineInput, amount: Decimal) => {
    if (!l.taxCodeId) return { taxCodeId: null, taxRate: '0', taxAmount: '0.00' };
    const tc = taxCodes.get(l.taxCodeId);
    if (!tc || tc.kind !== 'SALES_TAX' || !tc.isActive) {
      throw new AppError('VALIDATION_FAILED', 'The tax on a vendor bill is an active sales tax code', { field: 'taxCodeId' });
    }
    return { taxCodeId: tc.id, taxRate: D(tc.rate).toFixed(4), taxAmount: money2(amount.times(tc.rate).div(100)).toFixed(2) };
  };
  const out: repo.InvoiceLineValues[] = [];
  if (h.type === 'GOODS') {
    const refs = await goodsRefs(q, companyId, input.map((l) => l.grnLineId!));
    const seen = new Set<string>();
    for (const [i, l] of input.entries()) {
      if (!l.grnLineId) throw new AppError('VALIDATION_FAILED', 'A goods invoice bills GRN lines', { line: i + 1 });
      const ref = refs.get(l.grnLineId);
      if (!ref || ref.grn.poId !== h.po!.id || ref.grn.status !== 'POSTED') {
        throw new AppError('VALIDATION_FAILED', `Line ${i + 1} names a GRN line that is not a posted receipt of PO ${h.po!.docNo}`, { line: i + 1 });
      }
      if (seen.has(l.grnLineId)) throw new AppError('VALIDATION_FAILED', `GRN line on line ${i + 1} is billed twice on this invoice`, { line: i + 1 });
      seen.add(l.grnLineId);
      const amount = money2(D(l.qty).times(l.unitPrice!));
      out.push({
        lineNo: i + 1,
        grnLineId: l.grnLineId,
        landedCostId: null,
        qty: D(l.qty).toFixed(4),
        unitPrice: D(l.unitPrice).toFixed(6),
        amount: amount.toFixed(2),
        ...tax(l, amount),
      });
    }
    return { lines: out, currency: h.po!.currency };
  }
  const states = await chargeStates(q, companyId, input.map((l) => l.landedCostId!), exceptInvoiceId);
  const currencies = new Set<string>();
  const seen = new Set<string>();
  for (const [i, l] of input.entries()) {
    if (!l.landedCostId) throw new AppError('VALIDATION_FAILED', 'A charges invoice bills landed costs', { line: i + 1 });
    const s = states.get(l.landedCostId);
    const c = s?.charge;
    if (!s || !c || c.status !== 'POSTED' || c.correctionOf) {
      throw new AppError('VALIDATION_FAILED', `Line ${i + 1} names a landed cost that is not a POSTED charge (bill the original, not a correction)`, { line: i + 1 });
    }
    if (c.vendorId && c.vendorId !== h.vendor.id) {
      throw new AppError('VALIDATION_FAILED', `${c.docNo} is billed by another vendor`, { line: i + 1, landedCostId: c.id });
    }
    if (seen.has(c.id)) throw new AppError('VALIDATION_FAILED', `${c.docNo} is billed twice on this invoice`, { line: i + 1 });
    seen.add(c.id);
    currencies.add(c.currency);
    const open = s.chargedForeign.minus(s.billedForeign);
    if (D(l.amount).gt(open)) {
      throw new AppError('AMOUNT_EXCEEDS_OPEN', `${c.docNo} has ${open.toFixed(2)} ${c.currency} open; ${D(l.amount).toFixed(2)} is more than that`, {
        line: i + 1,
        landedCostId: c.id,
        open: open.toFixed(2),
      });
    }
    const amount = D(l.amount);
    out.push({ lineNo: i + 1, grnLineId: null, landedCostId: c.id, qty: null, unitPrice: null, amount: amount.toFixed(2), ...tax(l, amount) });
  }
  if (currencies.size > 1) {
    throw new AppError('VALIDATION_FAILED', `One invoice is in one currency; these charges are in ${[...currencies].join(', ')}`, { field: 'lines' });
  }
  return { lines: out, currency: [...currencies][0]! };
}

/** Header values from the lines: totals, rate on the invoice date, due date from the vendor's terms. */
async function headerValues(
  q: Queryable,
  companyId: string,
  h: Header,
  input: { vendorInvoiceNo: string; invoiceDate: string; notes?: string | null },
  lines: repo.InvoiceLineValues[],
  currency: string,
  exceptInvoiceId?: string,
): Promise<repo.InvoiceHeaderValues> {
  if (input.invoiceDate > companyToday()) throw new AppError('VALIDATION_FAILED', 'The invoice date cannot be in the future', { field: 'invoiceDate' });
  const taken = await repo.invoiceNoTaken(q, companyId, h.vendor.id, input.vendorInvoiceNo, exceptInvoiceId);
  if (taken) {
    throw new AppError('ALREADY_EXISTS', `${h.vendor.code} invoice ${input.vendorInvoiceNo} is already entered (${taken})`, { field: 'vendorInvoiceNo' });
  }
  const { rate, rateDate } = await rateOn(q, companyId, currency, input.invoiceDate);
  const goods = lines.reduce((s, l) => s.plus(l.amount), D(0));
  const taxTotal = lines.reduce((s, l) => s.plus(l.taxAmount ?? 0), D(0));
  const total = goods.plus(taxTotal);
  return {
    docNo: '',
    invoiceType: h.type,
    vendorId: h.vendor.id,
    poId: h.po?.id ?? null,
    vendorInvoiceNo: input.vendorInvoiceNo.trim(),
    invoiceDate: input.invoiceDate,
    dueDate: addDays(input.invoiceDate, h.vendor.paymentTermsDays),
    currency,
    exchangeRate: D(rate).toFixed(6),
    exchangeRateDate: rateDate,
    goodsAmount: goods.toFixed(2),
    taxAmount: taxTotal.toFixed(2),
    totalAmount: total.toFixed(2),
    totalPkr: money2(total.times(rate)).toFixed(2),
    notes: input.notes?.trim() || null,
  };
}

async function headerOf(q: Queryable, companyId: string, type: VendorInvoiceType, ids: { poId?: string | null; vendorId?: string }): Promise<Header> {
  if (type === 'GOODS') {
    const po = await findPo(q, companyId, ids.poId!);
    if (!po) throw new AppError('VALIDATION_FAILED', 'Purchase order does not exist', { field: 'poId' });
    if (!['APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(po.status)) {
      throw new AppError('INVALID_TRANSITION', `Purchase order ${po.docNo} is ${po.status}; goods are billed on an approved, receiving or received PO`, {
        status: po.status,
      });
    }
    return { type, po, vendor: await assertPurchVendor(q, companyId, po.vendorId) };
  }
  return { type, po: null, vendor: await assertPurchVendor(q, companyId, ids.vendorId!) };
}

export async function createVendorInvoice(auth: AuthContext, input: CreateVendorInvoiceRequest): Promise<VendorInvoiceDto> {
  const id = await withTransaction(txContext(auth, 'enter vendor invoice'), async (tx) => {
    const h = await headerOf(tx, auth.companyId, input.invoiceType, input);
    const { lines, currency } = await prepareLines(tx, auth.companyId, h, input.lines);
    const values = await headerValues(tx, auth.companyId, h, input, lines, currency);
    const invoiceId = await repo.insertInvoice(tx, { ...values, docNo: await nextDocNo(tx, INVOICE_DOC_TYPE, input.invoiceDate) });
    await recordInitialStatus(tx, vendorInvoiceMoves(MANAGE_KEY), { entityId: invoiceId, to: 'DRAFT', actor: auth });
    await repo.replaceLines(tx, invoiceId, lines);
    return invoiceId;
  });
  return getVendorInvoice(auth, id);
}

async function lockInvoice(tx: Tx, companyId: string, id: string): Promise<repo.InvoiceRow> {
  const row = await repo.findInvoice(tx, companyId, id, true);
  if (!row) throw new AppError('NOT_FOUND', 'Vendor invoice not found');
  return row;
}

function assertStatus(row: repo.InvoiceRow, ...allowed: VendorInvoiceStatus[]): void {
  if (!allowed.includes(row.status)) {
    throw new AppError(row.status === 'POSTED' || row.status === 'CANCELLED' ? 'RECORD_LOCKED' : 'INVALID_TRANSITION',
      `Vendor invoice ${row.docNo} is ${row.status}`, { status: row.status });
  }
}

export async function updateVendorInvoice(auth: AuthContext, id: string, input: UpdateVendorInvoiceRequest): Promise<VendorInvoiceDto> {
  await withTransaction(txContext(auth, 'edit vendor invoice'), async (tx) => {
    const row = await lockInvoice(tx, auth.companyId, id);
    assertStatus(row, 'DRAFT');
    const h = await headerOf(tx, auth.companyId, row.invoiceType, { poId: row.poId, vendorId: row.vendorId });
    const { lines, currency } = await prepareLines(tx, auth.companyId, h, input.lines, id);
    const { docNo: _docNo, ...values } = await headerValues(tx, auth.companyId, h, input, lines, currency, id);
    await repo.updateInvoice(tx, id, values);
    await repo.replaceLines(tx, id, lines);
  });
  return getVendorInvoice(auth, id);
}

export async function cancelVendorInvoice(auth: AuthContext, id: string, reason: string): Promise<VendorInvoiceDto> {
  await withTransaction(txContext(auth, `cancel vendor invoice: ${reason}`), async (tx) => {
    const row = await lockInvoice(tx, auth.companyId, id);
    assertStatus(row, 'DRAFT', 'MATCH_EXCEPTION');
    await transition(tx, vendorInvoiceMoves(MANAGE_KEY), { entityId: id, to: 'CANCELLED', actor: auth, reason });
  });
  return getVendorInvoice(auth, id);
}

/** Owner Q5: a held invoice goes back to the Accountant to correct (Finance Manager, reason). */
export async function returnVendorInvoice(auth: AuthContext, id: string, reason: string): Promise<VendorInvoiceDto> {
  await withTransaction(txContext(auth, `return vendor invoice: ${reason}`), async (tx) => {
    const row = await lockInvoice(tx, auth.companyId, id);
    assertStatus(row, 'MATCH_EXCEPTION');
    await transition(tx, vendorInvoiceMoves(RELEASE_KEY), { entityId: id, to: 'DRAFT', actor: auth, reason, alsoSet: { exception_at: null } });
  });
  return getVendorInvoice(auth, id);
}

// ---------------------------------------------------------------- match and posting

interface Computed {
  rate: { rate: string; rateDate: string; totalPkr: string };
  results: Map<string, repo.InvoiceLineResult>;
  allInTolerance: boolean;
  journal: JournalLineInput[];
  /** GOODS: quantity billed per PO line after this invoice (PO → CLOSED). */
  poId: string | null;
}

/**
 * The 3-way match and the posting split, from the invoice as stored and the books as they are now (rate refreshed,
 * lines re-checked: a receipt reversed or a charge billed elsewhere since stops it).
 */
async function compute(tx: Tx, companyId: string, row: repo.InvoiceRow): Promise<Computed> {
  const lines = await repo.linesOf(tx, [row.id]);
  const h = await headerOf(tx, companyId, row.invoiceType, { poId: row.poId, vendorId: row.vendorId });
  // Re-check against what is received / open now (the stored lines are the input).
  await prepareLines(
    tx,
    companyId,
    h,
    lines.map((l) =>
      l.grnLineId
        ? { grnLineId: l.grnLineId, qty: l.qty!, unitPrice: l.unitPrice!, taxCodeId: l.taxCodeId }
        : { landedCostId: l.landedCostId!, amount: l.amount, taxCodeId: l.taxCodeId },
    ),
    row.id,
  );
  const { rate, rateDate } = await rateOn(tx, companyId, row.currency, row.invoiceDate);
  const totalPkr = money2(D(row.totalAmount).times(rate));
  // PKR per line and its tax, exactly adding up to the AP credit (largest remainder).
  const weights = [...lines.map((l) => D(l.amount)), ...lines.map((l) => D(l.taxAmount))];
  const pkr = splitByWeights(totalPkr, weights);
  const results = new Map<string, repo.InvoiceLineResult>();
  const journal: JournalLineInput[] = [];
  const vendor = { vendorId: row.vendorId };
  let allInTolerance = true;

  if (row.invoiceType === 'GOODS') {
    const tol = await invoiceTolerances(tx, companyId);
    const refs = await goodsRefs(tx, companyId, lines.map((l) => l.grnLineId!));
    const before = await repo.invoicedOnGrnLines(tx, lines.map((l) => l.grnLineId!), row.id);
    const items = await purchItems(tx, companyId, [...refs.values()].map((r) => r.grnLine.itemId));
    const receipts = new Map<string, Decimal>(); // GRN line → receipt value (the GRNI its receipt credited)
    for (const grnId of new Set([...refs.values()].map((r) => r.grn.id))) {
      const moves = await movementsOfDocument(tx, companyId, { refDocType: GRN_DOC_TYPE, refDocId: grnId });
      for (const r of [...refs.values()].filter((x) => x.grn.id === grnId)) {
        receipts.set(r.grnLine.id, moves.filter((m) => m.movementType === 'RECEIPT' && m.lotId === r.grnLine.lotId).reduce((s, m) => s.plus(m.value), D(0)));
      }
    }
    lines.forEach((l, i) => {
      const ref = refs.get(l.grnLineId!)!;
      const grnQty = D(ref.grnLine.qty);
      const prevQty = D(before.get(l.grnLineId!)?.qty);
      const prevCleared = D(before.get(l.grnLineId!)?.cleared);
      const qty = D(l.qty);
      const poPrice = D(ref.poPrice);
      // Match (owner Q5; DB: purch.invoice_line_in_tolerance).
      const diffPct = poPrice.isZero() ? (D(l.unitPrice).isZero() ? D(0) : D(100)) : D(l.unitPrice).minus(poPrice).abs().times(100).div(poPrice);
      const priceOk = poPrice.isZero() ? D(l.unitPrice).isZero() : !diffPct.gt(tol.pricePct);
      const qtyOk = prevQty.plus(qty).lte(grnQty.times(D(1).plus(D(tol.qtyPct).div(100))));
      const inTolerance = priceOk && qtyOk;
      allInTolerance &&= inTolerance;
      // Posting split (owner Q4).
      const matched = Decimal.min(qty, Decimal.max(grnQty.minus(prevQty), 0));
      const receipt = receipts.get(l.grnLineId!) ?? D(0);
      const cleared = matched.isZero()
        ? D(0)
        : prevQty.plus(matched).gte(grnQty)
          ? receipt.minus(prevCleared)
          : money2(receipt.times(prevQty.plus(matched)).div(grnQty)).minus(prevCleared);
      const amountPkr = pkr[i]!;
      const fx = row.currency === 'PKR' ? D(0) : money2(matched.times(poPrice).times(rate)).minus(cleared);
      const pv = amountPkr.minus(cleared).minus(fx);
      results.set(l.id, {
        poUnitPrice: poPrice.toFixed(6),
        priceDiffPct: Decimal.min(diffPct, D('99999.9999')).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
        qtyOver: Decimal.max(prevQty.plus(qty).minus(grnQty), 0).toFixed(4),
        inTolerance,
        amountPkr: amountPkr.toFixed(2),
        taxPkr: pkr[lines.length + i]!.toFixed(2),
        clearedPkr: cleared.toFixed(2),
        matchedQty: matched.toFixed(4),
        priceVariancePkr: pv.toFixed(2),
        exchangeDiffPkr: fx.toFixed(2),
      });
      const category = items.get(ref.grnLine.itemId)?.categoryId ?? null;
      journal.push(side('GRNI', cleared, { itemCategoryId: category }), side('PRICE_VARIANCE', pv, { itemCategoryId: category }), side('EXCHANGE_DIFFERENCE', fx, {}));
    });
  } else {
    const states = await chargeStates(tx, companyId, lines.map((l) => l.landedCostId!), row.id);
    lines.forEach((l, i) => {
      const s = states.get(l.landedCostId!)!;
      const openForeign = s.chargedForeign.minus(s.billedForeign);
      const openPkr = s.chargedPkr.minus(s.billedPkr);
      const amount = D(l.amount);
      const cleared = amount.equals(openForeign) ? openPkr : money2(openPkr.times(amount).div(openForeign));
      const amountPkr = pkr[i]!;
      const fx = amountPkr.minus(cleared);
      results.set(l.id, {
        poUnitPrice: null,
        priceDiffPct: null,
        qtyOver: null,
        inTolerance: true,
        amountPkr: amountPkr.toFixed(2),
        taxPkr: pkr[lines.length + i]!.toFixed(2),
        clearedPkr: cleared.toFixed(2),
        matchedQty: null,
        priceVariancePkr: '0.00',
        exchangeDiffPkr: fx.toFixed(2),
      });
      journal.push(side('LANDED_COST_CLEARING', cleared, s.charge.vendorId ? { vendorId: s.charge.vendorId } : {}), side('EXCHANGE_DIFFERENCE', fx, {}));
    });
  }
  lines.forEach((l, i) => {
    if (l.taxCodeId) journal.push(side('INPUT_TAX', pkr[lines.length + i]!, { taxCodeId: l.taxCodeId }));
  });
  journal.push(side('ACCOUNTS_PAYABLE', totalPkr.neg(), vendor));
  return {
    rate: { rate: D(rate).toFixed(6), rateDate, totalPkr: totalPkr.toFixed(2) },
    results,
    allInTolerance,
    journal: mergeLines(journal),
    poId: row.poId,
  };
}

/** A journal leg: positive = debit, negative = credit, zero = nothing. */
function side(role: JournalLineInput['role'], amount: Decimal, dims: Partial<JournalLineInput>): JournalLineInput {
  return amount.gte(0) ? { role, ...dims, debit: amount.toFixed(2) } : { role, ...dims, credit: amount.abs().toFixed(2) };
}

/** Nets legs of the same role / category / tax code / vendor into one line; drops zeros. */
function mergeLines(lines: JournalLineInput[]): JournalLineInput[] {
  const net = new Map<string, { line: JournalLineInput; amount: Decimal }>();
  for (const l of lines) {
    const key = [l.role, l.itemCategoryId ?? '', l.taxCodeId ?? '', l.vendorId ?? ''].join('|');
    const amount = D(l.debit).minus(D(l.credit));
    const found = net.get(key);
    if (found) found.amount = found.amount.plus(amount);
    else net.set(key, { line: { role: l.role, itemCategoryId: l.itemCategoryId, taxCodeId: l.taxCodeId, vendorId: l.vendorId }, amount });
  }
  return [...net.values()]
    .filter((x) => !x.amount.isZero())
    .map(({ line, amount }) => {
      const out: JournalLineInput = { role: line.role };
      if (line.itemCategoryId) out.itemCategoryId = line.itemCategoryId;
      if (line.taxCodeId) out.taxCodeId = line.taxCodeId;
      if (line.vendorId) out.vendorId = line.vendorId;
      return amount.gt(0) ? { ...out, debit: amount.toFixed(2) } : { ...out, credit: amount.abs().toFixed(2) };
    });
}

async function writeResults(tx: Tx, c: Computed): Promise<void> {
  for (const [lineId, r] of c.results) await repo.setLineResult(tx, lineId, r);
}

async function postComputed(
  tx: Tx,
  actor: Actor,
  key: typeof MANAGE_KEY | typeof RELEASE_KEY,
  row: repo.InvoiceRow,
  c: Computed,
  release?: { signature: SignatureRecord; reason: string },
): Promise<void> {
  await repo.updateInvoice(tx, row.id, { exchangeRate: c.rate.rate, exchangeRateDate: c.rate.rateDate, totalPkr: c.rate.totalPkr });
  await writeResults(tx, c);
  const vendor = (await purchVendors(tx, actor.companyId, [row.vendorId])).get(row.vendorId);
  await postJournal(tx, actor, {
    event: 'VENDOR_INVOICE',
    key,
    sourceType: INVOICE_DOC_TYPE,
    sourceId: row.id,
    date: row.invoiceDate,
    narration: `Vendor invoice ${row.docNo} (${vendor?.code ?? ''} ${row.vendorInvoiceNo})${row.currency !== 'PKR' ? ` ${row.totalAmount} ${row.currency} @ ${c.rate.rate}` : ''}`,
    lines: c.journal,
  });
  const now = new Date().toISOString();
  await transition(tx, vendorInvoiceMoves(key), {
    entityId: row.id,
    to: 'POSTED',
    actor,
    ...(release ? { signature: release.signature, reason: release.reason } : {}),
    alsoSet: {
      posting_date: row.invoiceDate,
      posted_by: actor.userId,
      posted_at: now,
      ...(release ? { released_by: actor.userId, released_at: now, release_reason: release.reason } : {}),
    },
  });
  if (c.poId) await closePoIfInvoiced(tx, actor, c.poId, await repo.invoicedQtyByPoLine(tx, c.poId), key);
}

/**
 * The Accountant posts: inside the tolerances it posts on the invoice date; outside, it is held in MATCH_EXCEPTION with
 * the match result on each line (owner Q5), for a Finance Manager.
 */
export async function postVendorInvoice(auth: AuthContext, id: string): Promise<VendorInvoiceDto> {
  await withTransaction(txContext(auth, 'post vendor invoice'), async (tx) => {
    const row = await lockInvoice(tx, auth.companyId, id);
    assertStatus(row, 'DRAFT');
    const c = await compute(tx, auth.companyId, row);
    if (!c.allInTolerance) {
      await repo.updateInvoice(tx, row.id, { exchangeRate: c.rate.rate, exchangeRateDate: c.rate.rateDate, totalPkr: c.rate.totalPkr });
      await writeResults(tx, c);
      await transition(tx, vendorInvoiceMoves(MANAGE_KEY), {
        entityId: id,
        to: 'MATCH_EXCEPTION',
        actor: auth,
        reason: 'Outside the 3-way match tolerances',
        alsoSet: { exception_at: new Date().toISOString() },
      });
      return;
    }
    await postComputed(tx, auth, MANAGE_KEY, row, c);
  });
  return getVendorInvoice(auth, id);
}

/** Owner Q5: a Finance Manager releases a held invoice with an e-signature (APPROVED) and a reason; creator ≠ releaser. */
export async function releaseVendorInvoice(auth: AuthContext, id: string, input: ReleaseVendorInvoiceRequest, meta: RequestMeta): Promise<VendorInvoiceDto> {
  if (input.signature.meaning !== 'APPROVED') throw new AppError('VALIDATION_FAILED', 'Releasing an invoice needs the meaning APPROVED');
  const pre = await repo.findInvoice(db, auth.companyId, id);
  if (pre && pre.createdBy === auth.userId) {
    throw new AppError('SEGREGATION_OF_DUTIES', `You entered ${pre.docNo}; another person releases it`, { rule: 'invoice creator ≠ releaser' });
  }
  const proof = await verifySignature(auth, input.signature, meta);
  await withTransaction(txContext(auth, `release vendor invoice: ${input.signature.reason}`), async (tx) => {
    const row = await lockInvoice(tx, auth.companyId, id);
    assertStatus(row, 'MATCH_EXCEPTION');
    if (row.createdBy === auth.userId) {
      throw new AppError('SEGREGATION_OF_DUTIES', `You entered ${row.docNo}; another person releases it`, { rule: 'invoice creator ≠ releaser' });
    }
    const c = await compute(tx, auth.companyId, row);
    const signature = await recordSignature(tx, proof, { table: INVOICE_TABLE, id }, ['APPROVED']);
    await postComputed(tx, auth, RELEASE_KEY, row, c, { signature, reason: input.signature.reason });
  });
  return getVendorInvoice(auth, id);
}

// ---------------------------------------------------------------- reversal (owner 2026-11-26, task 5b)

/**
 * A Finance Manager reverses a POSTED invoice with an e-signature (REVERSED) and a reason, only while no payment and
 * no debit note names it: its journal is mirrored on the reversal day, what it billed is open again (GRN quantities,
 * landed costs) and a CLOSED PO re-opens to RECEIVED. The DB (0032) re-checks.
 */
export async function reverseVendorInvoice(auth: AuthContext, id: string, input: ReverseVendorDocumentRequest, meta: RequestMeta): Promise<VendorInvoiceDto> {
  if (input.signature.meaning !== 'REVERSED') throw new AppError('VALIDATION_FAILED', 'Reversing an invoice needs the meaning REVERSED');
  const proof = await verifySignature(auth, input.signature, meta);
  const reason = input.signature.reason;
  await withTransaction(txContext(auth, `reverse vendor invoice: ${reason}`), async (tx) => {
    const row = await lockInvoice(tx, auth.companyId, id);
    if (row.status !== 'POSTED') {
      throw new AppError(row.status === 'REVERSED' || row.status === 'CANCELLED' ? 'RECORD_LOCKED' : 'INVALID_TRANSITION',
        `Vendor invoice ${row.docNo} is ${row.status}; only a POSTED invoice is reversed`, { status: row.status });
    }
    const on = await repo.documentsOnInvoice(tx, id);
    if (on.payments.length) {
      throw new AppError('IN_USE', `${row.docNo} is paid on ${on.payments.join(', ')}; reverse or cancel the payment first`, { payments: on.payments });
    }
    if (on.debitNotes.length) {
      throw new AppError('IN_USE', `${row.docNo} has debit note ${on.debitNotes.join(', ')}; reverse the debit note first`, { debitNotes: on.debitNotes });
    }
    const entry = (await journalsOfSource(tx, auth.companyId, INVOICE_DOC_TYPE, id)).find((j) => j.status === 'POSTED' && j.reversalOf === null);
    if (!entry) throw new AppError('VALIDATION_FAILED', `${row.docNo} has no posted journal to reverse`);
    const date = companyToday();
    await reverseJournal(tx, auth, { entryId: entry.id, date, reason: `${row.docNo} reversed: ${reason}` });
    const signature = await recordSignature(tx, proof, { table: INVOICE_TABLE, id }, ['REVERSED']);
    await transition(tx, vendorInvoiceMoves(REVERSE_KEY), {
      entityId: id,
      to: 'REVERSED',
      actor: auth,
      signature,
      reason,
      alsoSet: { reversed_by: auth.userId, reversed_at: new Date().toISOString(), reversal_date: date, reversal_reason: reason },
    });
    if (row.poId) await reopenPoAfterInvoiceReversal(tx, auth, row.poId, row.docNo);
  });
  return getVendorInvoice(auth, id);
}

/** For the GRN reversal: the invoices (neither cancelled nor reversed) that bill this GRN's lines or charges. */
export async function invoicesOfGrn(q: Queryable, grnLineIds: string[], landedCostIds: string[]): Promise<string[]> {
  return repo.invoicesNaming(q, { grnLineIds, landedCostIds });
}

