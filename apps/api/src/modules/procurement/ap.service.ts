// Vendor ledger and AP ageing (M3 task 5; architecture §7.5 "vendor ledger and ageing"; owner 2026-11-25 extra:
// ageing on the vendor's payment terms).
//   - Vendor ledger: the GL's payables lines for the vendor (engines/posting vendorSubledger: every account the
//     ACCOUNTS_PAYABLE posting rules map to), with a running balance owed; invoice and payment lines show their
//     currency and foreign amount. Debit notes (VENDOR_DEBIT_NOTE, and LOT_RETURNED for returns) and reversals
//     (mirror entries) are lines of their own (owner 2026-11-26, task 5b).
//   - AP ageing as of a date: the invoices in force that day (posted on or before it, not reversed by then), less the
//     payments in force that day and the debit notes posted by then, by days past the due date (invoice date +
//     payment terms): not due, 1–30, 31–60, 61–90, over 90. PKR at the carrying amount (open foreign balances are
//     revalued in M8, owner Q4).
import { Decimal } from 'decimal.js';
import type { AgeingBuckets, ApAgeingDto, ApAgeingQuery, ApAgeingVendorDto, VendorLedgerDto, VendorLedgerQuery } from '@albert/shared';
import { db } from '../../db/client';
import { AppError } from '../../core/errors';
import { companyToday } from '../../core/dates';
import type { AuthContext } from '../../core/auth/auth.service';
import { vendorSubledger } from '../../engines/posting';
import { purchVendors } from '../masters/purch-refs.service';
import * as repo from './invoices.repo';
import { INVOICE_DOC_TYPE } from './invoices.service';
import { PAYMENT_DOC_TYPE } from './payments.service';
import { DEBIT_NOTE_DOC_TYPE } from './debit-notes.service';

const D = (v: string | number | null | undefined) => new Decimal(v ?? 0);
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export async function vendorLedger(auth: AuthContext, vendorId: string, query: VendorLedgerQuery): Promise<VendorLedgerDto> {
  const vendor = (await purchVendors(db, auth.companyId, [vendorId])).get(vendorId);
  if (!vendor) throw new AppError('NOT_FOUND', 'Vendor not found');
  if (query.from && query.to && query.from > query.to) throw new AppError('VALIDATION_FAILED', 'From is after to', { field: 'from' });
  const { opening, lines } = await vendorSubledger(db, auth.companyId, 'ACCOUNTS_PAYABLE', vendorId, { from: query.from, to: query.to });
  const ids = (type: string) => lines.flatMap((l) => (l.sourceType === type && l.sourceId ? [l.sourceId] : []));
  const [invoices, payments, notes] = await Promise.all([
    repo.docNos(db, 'invoice', ids(INVOICE_DOC_TYPE)),
    repo.docNos(db, 'payment', ids(PAYMENT_DOC_TYPE)),
    repo.docNos(db, 'debit_note', ids(DEBIT_NOTE_DOC_TYPE)),
  ]);
  const docs: Record<string, typeof invoices> = { [INVOICE_DOC_TYPE]: invoices, [PAYMENT_DOC_TYPE]: payments, [DEBIT_NOTE_DOC_TYPE]: notes };
  let balance = D(opening).neg(); // owed = credit − debit
  return {
    vendorId,
    vendorCode: vendor.code,
    vendorName: vendor.name,
    currency: vendor.currency,
    from: query.from ?? null,
    to: query.to ?? null,
    opening: balance.toFixed(2),
    lines: lines.map((l) => {
      balance = balance.plus(l.credit).minus(l.debit);
      const doc = l.sourceId ? docs[l.sourceType]?.get(l.sourceId) : undefined;
      return {
        date: l.entryDate,
        journalDocNo: l.docNo,
        sourceType: l.sourceType,
        sourceId: l.sourceId,
        sourceDocNo: doc?.docNo ?? null,
        narration: l.narration,
        debit: D(l.debit).toFixed(2),
        credit: D(l.credit).toFixed(2),
        balance: balance.toFixed(2),
        currency: doc?.currency ?? null,
        foreignAmount: doc ? D(doc.foreign).toFixed(2) : null,
      };
    }),
    closing: balance.toFixed(2),
  };
}

const zero = (): Record<keyof AgeingBuckets, Decimal> => ({
  notDue: D(0),
  d1to30: D(0),
  d31to60: D(0),
  d61to90: D(0),
  over90: D(0),
  total: D(0),
});
const bucketOf = (pastDue: number): Exclude<keyof AgeingBuckets, 'total'> =>
  pastDue <= 0 ? 'notDue' : pastDue <= 30 ? 'd1to30' : pastDue <= 60 ? 'd31to60' : pastDue <= 90 ? 'd61to90' : 'over90';
const fixed = (b: Record<keyof AgeingBuckets, Decimal>): AgeingBuckets => ({
  notDue: b.notDue.toFixed(2),
  d1to30: b.d1to30.toFixed(2),
  d31to60: b.d31to60.toFixed(2),
  d61to90: b.d61to90.toFixed(2),
  over90: b.over90.toFixed(2),
  total: b.total.toFixed(2),
});

export async function apAgeing(auth: AuthContext, query: ApAgeingQuery): Promise<ApAgeingDto> {
  const asOf = query.asOf ?? companyToday();
  const invoices = await repo.postedInvoices(db, auth.companyId, { vendorId: query.vendorId, asOf });
  const paid = await repo.paidOnInvoices(db, invoices.map((i) => i.id), asOf);
  const debited = await repo.debitedOnInvoices(db, invoices.map((i) => i.id), asOf);
  const vendors = await purchVendors(db, auth.companyId, invoices.map((i) => i.vendorId));
  const byVendor = new Map<string, { buckets: Record<keyof AgeingBuckets, Decimal>; dto: ApAgeingVendorDto }>();
  const totals = zero();
  for (const inv of invoices) {
    const openForeign = D(inv.totalAmount).minus(D(paid.get(inv.id)?.foreign)).minus(D(debited.get(inv.id)?.foreign));
    if (!openForeign.gt(0)) continue;
    const openPkr = D(inv.totalPkr).minus(D(paid.get(inv.id)?.carrying)).minus(D(debited.get(inv.id)?.pkr));
    const v = vendors.get(inv.vendorId);
    let entry = byVendor.get(inv.vendorId);
    if (!entry) {
      entry = {
        buckets: zero(),
        dto: {
          vendorId: inv.vendorId,
          vendorCode: v?.code ?? '',
          vendorName: v?.name ?? '',
          paymentTermsDays: v?.paymentTermsDays ?? 0,
          invoices: [],
          ...fixed(zero()),
        },
      };
      byVendor.set(inv.vendorId, entry);
    }
    const pastDue = days(inv.dueDate, asOf);
    const bucket = bucketOf(pastDue);
    entry.buckets[bucket] = entry.buckets[bucket].plus(openPkr);
    entry.buckets.total = entry.buckets.total.plus(openPkr);
    totals[bucket] = totals[bucket].plus(openPkr);
    totals.total = totals.total.plus(openPkr);
    entry.dto.invoices.push({
      invoiceId: inv.id,
      docNo: inv.docNo,
      vendorInvoiceNo: inv.vendorInvoiceNo,
      invoiceDate: inv.invoiceDate,
      dueDate: inv.dueDate,
      daysPastDue: Math.max(pastDue, 0),
      currency: inv.currency,
      openAmount: openForeign.toFixed(2),
      openPkr: openPkr.toFixed(2),
    });
  }
  return {
    asOf,
    vendors: [...byVendor.values()].map((e) => ({ ...e.dto, ...fixed(e.buckets) })).sort((a, b) => a.vendorCode.localeCompare(b.vendorCode)),
    totals: fixed(totals),
  };
}
