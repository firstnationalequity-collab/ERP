// Vendor payments (M3 task 5; 0031). Architecture §3 (approval matrix "Vendor payment": Finance Manager, creator
// cannot approve), §6 "Vendor payment"; owner Q4 (IAS 21) and "extra" (filer status, 2026-11-25); 0013 (WHT blocked
// while its rate is a placeholder).
//
// The AP Officer (fin.payment.manage) drafts a payment to one vendor, settling POSTED invoices in their currency
// (one currency per payment): DRAFT → PENDING_APPROVAL (submit: the approval matrix VENDOR_PAYMENT on the PKR paid)
// → APPROVED (Finance Manager, e-signature; the creator / submitter approves no step) → POSTED by the AP Officer on
// the payment date. A rejection returns it to DRAFT.
// WHT: the vendor's WHT section (a WITHHOLDING tax code) at its rate on the gross PKR paid; the vendor's filer
// status (ATL) and its checked-on date are copied onto the payment. A placeholder rate stops submit and posting
// (TAX_RATE_NOT_CONFIRMED). Foreign currency (owner Q4): the payment records the foreign amount settled and the PKR
// paid; AP is taken off at the invoices' carrying PKR and the difference is an exchange gain/loss.
// Journal: Dr AP (carrying) / Dr-Cr exchange difference / Cr bank (net) / Cr WHT payable.
import { Decimal } from 'decimal.js';
import {
  VendorPaymentStatus,
  type CreateVendorPaymentRequest,
  type Page,
  type PurchListQuery,
  type UpdateVendorPaymentRequest,
  type VendorPaymentDto,
} from '@albert/shared';
import { db, withTransaction, type Queryable, type Tx } from '../../db/client';
import { AppError } from '../../core/errors';
import { companyToday } from '../../core/dates';
import { txContext, type AuthContext } from '../../core/auth/auth.service';
import { defineTransitions, recordInitialStatus, transition, type Actor } from '../../core/transition/transition';
import { cancelApproval, latestApprovalIds, registerApprovalHandler, startApproval } from '../../core/approvals/approvals.service';
import { nextDocNo } from '../../core/settings/numbering.service';
import { journalsOfSource, postJournal, type JournalLineInput } from '../../engines/posting';
import { assertTaxRateConfirmed } from '../masters/catalog.service';
import { assertPurchVendor, purchTaxCodes, purchVendors, type PurchVendorRef } from '../masters/purch-refs.service';
import * as repo from './invoices.repo';
import { userNames } from './procurement.repo';

export const PAYMENT_TABLE = 'purch.vendor_payments';
export const PAYMENT_DOC_TYPE = 'VENDOR_PAYMENT'; // number series, journal source_type, approval matrix doc type

export const VendorPaymentMoves = defineTransitions<VendorPaymentStatus>({
  entityTable: PAYMENT_TABLE,
  statuses: VendorPaymentStatus,
  moves: [
    { from: null, to: 'DRAFT', permission: 'fin.payment.manage' },
    { from: 'DRAFT', to: 'PENDING_APPROVAL', permission: 'fin.payment.manage' },
    { from: 'PENDING_APPROVAL', to: 'APPROVED', permission: 'fin.payment.approve' },
    { from: 'PENDING_APPROVAL', to: 'DRAFT', permission: 'fin.payment.approve', reasonRequired: true },
    { from: 'APPROVED', to: 'POSTED', permission: 'fin.payment.manage' },
    { from: 'DRAFT', to: 'CANCELLED', permission: 'fin.payment.manage', reasonRequired: true },
    { from: 'PENDING_APPROVAL', to: 'CANCELLED', permission: 'fin.payment.manage', reasonRequired: true },
    { from: 'APPROVED', to: 'CANCELLED', permission: 'fin.payment.manage', reasonRequired: true },
  ],
});

const D = (v: string | number | null | undefined) => new Decimal(v ?? 0);
const money2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

async function lockPayment(tx: Tx, companyId: string, id: string): Promise<repo.PaymentRow> {
  const row = await repo.findPayment(tx, companyId, id, true);
  if (!row) throw new AppError('NOT_FOUND', 'Vendor payment not found');
  return row;
}

function assertStatus(row: repo.PaymentRow, ...allowed: VendorPaymentStatus[]): void {
  if (!allowed.includes(row.status)) {
    throw new AppError(row.status === 'POSTED' || row.status === 'CANCELLED' ? 'RECORD_LOCKED' : 'INVALID_TRANSITION',
      `Vendor payment ${row.docNo} is ${row.status}`, { status: row.status });
  }
}

// ---------------------------------------------------------------- approval hooks (approval matrix VENDOR_PAYMENT)

registerApprovalHandler(PAYMENT_DOC_TYPE, {
  async assertMayApprove(tx, approval, actor) {
    const p = await lockPayment(tx, actor.companyId, approval.docId);
    if (actor.userId === p.createdBy || actor.userId === p.submittedBy) {
      throw new AppError('SEGREGATION_OF_DUTIES', 'Whoever creates or submits a payment cannot approve it', { rule: 'payment creator ≠ payment approver' });
    }
  },
  async onApproved(tx, approval, actor) {
    const p = await lockPayment(tx, actor.companyId, approval.docId);
    await assertPurchVendor(tx, actor.companyId, p.vendorId);
    await transition(tx, VendorPaymentMoves, { entityId: p.id, to: 'APPROVED', actor });
  },
  async onRejected(tx, approval, actor, reason) {
    const p = await lockPayment(tx, actor.companyId, approval.docId);
    await transition(tx, VendorPaymentMoves, { entityId: p.id, to: 'DRAFT', actor, reason });
  },
});

// ---------------------------------------------------------------- reading

async function toDtos(q: Queryable, companyId: string, rows: repo.PaymentRow[]): Promise<VendorPaymentDto[]> {
  const ids = rows.map((r) => r.id);
  const allocs = await repo.allocationsOf(q, ids);
  const [vendors, invoices, taxCodes, names, approvals] = await Promise.all([
    purchVendors(q, companyId, rows.map((r) => r.vendorId)),
    repo.invoicesByIds(q, companyId, allocs.map((a) => a.invoiceId)),
    purchTaxCodes(q, companyId, rows.flatMap((r) => (r.whtTaxCodeId ? [r.whtTaxCodeId] : []))),
    userNames(q, rows.flatMap((r) => [r.createdBy, ...(r.submittedBy ? [r.submittedBy] : []), ...(r.postedBy ? [r.postedBy] : [])])),
    latestApprovalIds(q, companyId, PAYMENT_TABLE, ids),
  ]);
  const journals = new Map(
    await Promise.all(
      rows.filter((r) => r.status === 'POSTED').map(async (r) => [r.id, await journalsOfSource(q, companyId, PAYMENT_DOC_TYPE, r.id)] as const),
    ),
  );
  return rows.map((r) => {
    const v = vendors.get(r.vendorId);
    const tc = r.whtTaxCodeId ? taxCodes.get(r.whtTaxCodeId) : undefined;
    return {
      id: r.id,
      docNo: r.docNo,
      vendorId: r.vendorId,
      vendorCode: v?.code ?? '',
      vendorName: v?.name ?? '',
      paymentDate: r.paymentDate,
      currency: r.currency,
      foreignAmount: r.foreignAmount,
      pkrPaid: r.pkrPaid,
      whtTaxCodeId: r.whtTaxCodeId,
      whtTaxCode: tc?.code ?? null,
      whtRate: r.whtRate,
      whtAmount: r.whtAmount,
      whtRateUnconfirmed: !!tc?.isPlaceholder,
      netPaid: r.netPaid,
      payeeIsFiler: r.payeeIsFiler,
      payeeFilerCheckedOn: r.payeeFilerCheckedOn,
      carryingPkr: r.carryingPkr,
      exchangeDiffPkr: r.exchangeDiffPkr,
      reference: r.reference,
      notes: r.notes,
      status: r.status,
      approvalId: approvals.get(r.id) ?? null,
      submittedByName: r.submittedBy ? (names.get(r.submittedBy) ?? '') : null,
      postingDate: r.postingDate,
      postedByName: r.postedBy ? (names.get(r.postedBy) ?? '') : null,
      postedAt: r.postedAt ? r.postedAt.toISOString() : null,
      journalDocNo: journals.get(r.id)?.[0]?.docNo ?? null,
      createdBy: r.createdBy,
      createdByName: names.get(r.createdBy) ?? '',
      createdAt: r.createdAt.toISOString(),
      allocations: allocs
        .filter((a) => a.paymentId === r.id)
        .map((a) => {
          const inv = invoices.get(a.invoiceId);
          return {
            invoiceId: a.invoiceId,
            invoiceDocNo: inv?.docNo ?? '',
            vendorInvoiceNo: inv?.vendorInvoiceNo ?? '',
            invoiceDate: inv?.invoiceDate ?? '',
            dueDate: inv?.dueDate ?? '',
            amount: a.foreignAmount,
            carryingPkr: a.carryingPkr,
          };
        }),
    };
  });
}

export async function listVendorPayments(auth: AuthContext, query: PurchListQuery): Promise<Page<VendorPaymentDto>> {
  const { rows, total } = await repo.listPayments(
    db,
    auth.companyId,
    { status: query.status, search: query.search, vendorId: query.vendorId },
    { limit: query.pageSize, offset: (query.page - 1) * query.pageSize },
  );
  return { items: await toDtos(db, auth.companyId, rows), total, page: query.page, pageSize: query.pageSize };
}

export async function getVendorPayment(auth: AuthContext, id: string): Promise<VendorPaymentDto> {
  const row = await repo.findPayment(db, auth.companyId, id);
  if (!row) throw new AppError('NOT_FOUND', 'Vendor payment not found');
  const [dto] = await toDtos(db, auth.companyId, [row]);
  return dto!;
}

// ---------------------------------------------------------------- writing

type PaymentFields = UpdateVendorPaymentRequest;

/** What is still open on each invoice (POSTED payments only), in its currency and at its carrying PKR. */
async function openOf(q: Queryable, invoices: repo.InvoiceRow[]): Promise<Map<string, { foreign: Decimal; pkr: Decimal }>> {
  const paid = await repo.paidOnInvoices(q, invoices.map((i) => i.id));
  return new Map(
    invoices.map((i) => [i.id, { foreign: D(i.totalAmount).minus(D(paid.get(i.id)?.foreign)), pkr: D(i.totalPkr).minus(D(paid.get(i.id)?.carrying)) }]),
  );
}

/** Checks the allocations against the vendor's POSTED invoices as they are now; the payment values. */
async function prepare(
  q: Queryable,
  companyId: string,
  vendor: PurchVendorRef,
  input: PaymentFields,
  invoices: repo.InvoiceRow[],
): Promise<Omit<repo.PaymentValues, 'docNo'>> {
  if (input.paymentDate > companyToday()) throw new AppError('VALIDATION_FAILED', 'The payment date cannot be in the future', { field: 'paymentDate' });
  const byId = new Map(invoices.map((i) => [i.id, i]));
  const open = await openOf(q, invoices);
  const seen = new Set<string>();
  const currencies = new Set<string>();
  let foreign = D(0);
  for (const [i, a] of input.allocations.entries()) {
    const inv = byId.get(a.invoiceId);
    if (!inv || inv.vendorId !== vendor.id || inv.status !== 'POSTED') {
      throw new AppError('VALIDATION_FAILED', `Allocation ${i + 1} names an invoice that is not a POSTED invoice of ${vendor.code}`, { line: i + 1 });
    }
    if (seen.has(inv.id)) throw new AppError('VALIDATION_FAILED', `${inv.docNo} is settled twice on this payment`, { line: i + 1 });
    seen.add(inv.id);
    currencies.add(inv.currency);
    const left = open.get(inv.id)!.foreign;
    if (D(a.amount).gt(left)) {
      throw new AppError('AMOUNT_EXCEEDS_OPEN', `${inv.docNo} has ${left.toFixed(2)} ${inv.currency} open; ${D(a.amount).toFixed(2)} is more than that`, {
        invoiceId: inv.id,
        open: left.toFixed(2),
      });
    }
    foreign = foreign.plus(a.amount);
  }
  if (currencies.size !== 1) {
    throw new AppError('VALIDATION_FAILED', `One payment settles invoices of one currency (here ${[...currencies].join(', ')})`, { field: 'allocations' });
  }
  const currency = [...currencies][0]!;
  let pkrPaid: Decimal;
  if (currency === 'PKR') {
    if (input.pkrPaid && !D(input.pkrPaid).equals(foreign)) {
      throw new AppError('VALIDATION_FAILED', 'A PKR payment pays exactly what it settles', { field: 'pkrPaid' });
    }
    pkrPaid = foreign;
  } else {
    if (!input.pkrPaid) throw new AppError('VALIDATION_FAILED', `Give the PKR paid for ${foreign.toFixed(2)} ${currency}`, { field: 'pkrPaid' });
    pkrPaid = D(input.pkrPaid);
  }
  // WHT: the vendor's section at its rate, on the gross PKR (agent default, Finance to confirm the base).
  let whtRate = D(0);
  if (vendor.whtTaxCodeId) {
    const tc = (await purchTaxCodes(q, companyId, [vendor.whtTaxCodeId])).get(vendor.whtTaxCodeId);
    if (!tc) throw new AppError('VALIDATION_FAILED', `The WHT section of ${vendor.code} does not exist`);
    whtRate = D(tc.rate);
  }
  const wht = money2(pkrPaid.times(whtRate).div(100));
  if (!pkrPaid.minus(wht).gt(0)) throw new AppError('VALIDATION_FAILED', 'Nothing would be paid after WHT', { field: 'pkrPaid' });
  return {
    vendorId: vendor.id,
    paymentDate: input.paymentDate,
    currency,
    foreignAmount: foreign.toFixed(2),
    pkrPaid: pkrPaid.toFixed(2),
    whtTaxCodeId: vendor.whtTaxCodeId,
    whtRate: whtRate.toFixed(4),
    whtAmount: wht.toFixed(2),
    netPaid: pkrPaid.minus(wht).toFixed(2),
    payeeIsFiler: vendor.isFiler,
    payeeFilerCheckedOn: vendor.filerCheckedOn,
    reference: input.reference?.trim() || null,
    notes: input.notes?.trim() || null,
  };
}

const allocationRows = (input: PaymentFields) => input.allocations.map((a) => ({ invoiceId: a.invoiceId, foreignAmount: D(a.amount).toFixed(2) }));

export async function createVendorPayment(auth: AuthContext, input: CreateVendorPaymentRequest): Promise<VendorPaymentDto> {
  const id = await withTransaction(txContext(auth, 'draft vendor payment'), async (tx) => {
    const vendor = await assertPurchVendor(tx, auth.companyId, input.vendorId);
    const invoices = await repo.lockInvoices(tx, auth.companyId, input.allocations.map((a) => a.invoiceId));
    const values = await prepare(tx, auth.companyId, vendor, input, invoices);
    const paymentId = await repo.insertPayment(tx, { ...values, docNo: await nextDocNo(tx, PAYMENT_DOC_TYPE, input.paymentDate) });
    await recordInitialStatus(tx, VendorPaymentMoves, { entityId: paymentId, to: 'DRAFT', actor: auth });
    await repo.replaceAllocations(tx, paymentId, allocationRows(input));
    return paymentId;
  });
  return getVendorPayment(auth, id);
}

export async function updateVendorPayment(auth: AuthContext, id: string, input: UpdateVendorPaymentRequest): Promise<VendorPaymentDto> {
  await withTransaction(txContext(auth, 'edit vendor payment'), async (tx) => {
    const row = await lockPayment(tx, auth.companyId, id);
    assertStatus(row, 'DRAFT');
    const vendor = await assertPurchVendor(tx, auth.companyId, row.vendorId);
    const invoices = await repo.lockInvoices(tx, auth.companyId, input.allocations.map((a) => a.invoiceId));
    const values = await prepare(tx, auth.companyId, vendor, input, invoices);
    await repo.replaceAllocations(tx, id, allocationRows(input));
    await repo.updatePayment(tx, id, values);
  });
  return getVendorPayment(auth, id);
}

/** Re-checks the payment as stored (allocations, WHT section and rate as the vendor has them now). */
async function recheck(tx: Tx, companyId: string, row: repo.PaymentRow): Promise<{ vendor: PurchVendorRef; allocs: repo.AllocationRow[]; invoices: repo.InvoiceRow[] }> {
  const vendor = await assertPurchVendor(tx, companyId, row.vendorId);
  const allocs = await repo.allocationsOf(tx, [row.id]);
  const invoices = await repo.lockInvoices(tx, companyId, allocs.map((a) => a.invoiceId));
  const now = await prepare(
    tx,
    companyId,
    vendor,
    { paymentDate: row.paymentDate, pkrPaid: row.pkrPaid, reference: row.reference, notes: row.notes, allocations: allocs.map((a) => ({ invoiceId: a.invoiceId, amount: a.foreignAmount })) },
    invoices,
  );
  if (now.whtTaxCodeId !== row.whtTaxCodeId || !D(now.whtRate).equals(row.whtRate) || !D(now.whtAmount).equals(row.whtAmount)) {
    throw new AppError('VALIDATION_FAILED', `The WHT section or rate of ${vendor.code} changed since ${row.docNo} was drafted; cancel it and draft it again`, {
      field: 'whtTaxCodeId',
    });
  }
  // 0013 / owner 2026-11-18: no WHT is booked until Finance confirms the rate.
  if (row.whtTaxCodeId) await assertTaxRateConfirmed(tx, companyId, row.whtTaxCodeId);
  return { vendor, allocs, invoices };
}

/** Submit for approval (approval matrix VENDOR_PAYMENT, on the gross PKR paid). */
export async function submitVendorPayment(auth: AuthContext, id: string): Promise<VendorPaymentDto> {
  await withTransaction(txContext(auth, 'submit vendor payment'), async (tx) => {
    const row = await lockPayment(tx, auth.companyId, id);
    assertStatus(row, 'DRAFT');
    const { vendor } = await recheck(tx, auth.companyId, row);
    // The vendor's filer status as it stands when the payment goes for approval.
    await repo.updatePayment(tx, id, { payeeIsFiler: vendor.isFiler, payeeFilerCheckedOn: vendor.filerCheckedOn });
    await transition(tx, VendorPaymentMoves, {
      entityId: id,
      to: 'PENDING_APPROVAL',
      actor: auth,
      alsoSet: { submitted_by: auth.userId, submitted_at: new Date().toISOString() },
    });
    await startApproval(tx, auth, {
      docType: PAYMENT_DOC_TYPE,
      docTable: PAYMENT_TABLE,
      docId: id,
      docNo: row.docNo,
      value: { measure: 'AMOUNT_PKR', amount: row.pkrPaid },
    });
  });
  return getVendorPayment(auth, id);
}

export async function cancelVendorPayment(auth: AuthContext, id: string, reason: string): Promise<VendorPaymentDto> {
  await withTransaction(txContext(auth, `cancel vendor payment: ${reason}`), async (tx) => {
    const row = await lockPayment(tx, auth.companyId, id);
    assertStatus(row, 'DRAFT', 'PENDING_APPROVAL', 'APPROVED');
    if (row.status === 'PENDING_APPROVAL') await cancelApproval(tx, auth satisfies Actor, PAYMENT_TABLE, id, reason);
    await transition(tx, VendorPaymentMoves, { entityId: id, to: 'CANCELLED', actor: auth, reason });
  });
  return getVendorPayment(auth, id);
}

/** Posts an APPROVED payment on its date (open period): AP at the carrying PKR, exchange difference, bank, WHT. */
export async function postVendorPayment(auth: AuthContext, id: string): Promise<VendorPaymentDto> {
  await withTransaction(txContext(auth, 'post vendor payment'), async (tx) => {
    const row = await lockPayment(tx, auth.companyId, id);
    assertStatus(row, 'APPROVED');
    const { vendor, allocs, invoices } = await recheck(tx, auth.companyId, row);
    const open = await openOf(tx, invoices);
    let carrying = D(0);
    for (const a of allocs) {
      const o = open.get(a.invoiceId)!;
      // The whole open amount takes the whole open PKR; a part takes its share (owner Q4).
      const c = D(a.foreignAmount).equals(o.foreign) ? o.pkr : money2(o.pkr.times(a.foreignAmount).div(o.foreign));
      await repo.setAllocationCarrying(tx, a.id, c.toFixed(2));
      carrying = carrying.plus(c);
    }
    const fx = D(row.pkrPaid).minus(carrying);
    const lines: JournalLineInput[] = [
      { role: 'ACCOUNTS_PAYABLE', vendorId: row.vendorId, debit: carrying.toFixed(2) },
      ...(fx.isZero() ? [] : [fx.gt(0) ? { role: 'EXCHANGE_DIFFERENCE' as const, debit: fx.toFixed(2) } : { role: 'EXCHANGE_DIFFERENCE' as const, credit: fx.abs().toFixed(2) }]),
      { role: 'BANK', credit: D(row.netPaid).toFixed(2) },
      ...(D(row.whtAmount).isZero() ? [] : [{ role: 'WHT_PAYABLE' as const, vendorId: row.vendorId, taxCodeId: row.whtTaxCodeId!, credit: D(row.whtAmount).toFixed(2) }]),
    ];
    await postJournal(tx, auth, {
      event: 'VENDOR_PAYMENT',
      sourceType: PAYMENT_DOC_TYPE,
      sourceId: id,
      date: row.paymentDate,
      narration: `Vendor payment ${row.docNo} to ${vendor.code}${row.currency !== 'PKR' ? ` (${row.foreignAmount} ${row.currency})` : ''}${row.reference ? ` ref ${row.reference}` : ''}`,
      lines,
    });
    await transition(tx, VendorPaymentMoves, {
      entityId: id,
      to: 'POSTED',
      actor: auth,
      alsoSet: {
        carrying_pkr: carrying.toFixed(2),
        exchange_diff_pkr: fx.toFixed(2),
        posting_date: row.paymentDate,
        posted_by: auth.userId,
        posted_at: new Date().toISOString(),
      },
    });
  });
  return getVendorPayment(auth, id);
}

/** For the payment screen: a vendor's POSTED invoices with something still open. */
export async function openInvoicesOfVendor(auth: AuthContext, vendorId: string) {
  const invoices = await repo.postedInvoices(db, auth.companyId, { vendorId });
  const open = await openOf(db, invoices);
  return invoices
    .filter((i) => open.get(i.id)!.foreign.gt(0))
    .map((i) => ({
      invoiceId: i.id,
      docNo: i.docNo,
      vendorInvoiceNo: i.vendorInvoiceNo,
      invoiceDate: i.invoiceDate,
      dueDate: i.dueDate,
      currency: i.currency,
      totalAmount: i.totalAmount,
      openAmount: open.get(i.id)!.foreign.toFixed(2),
      openPkr: open.get(i.id)!.pkr.toFixed(2),
    }));
}
