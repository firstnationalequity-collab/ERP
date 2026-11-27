// Vendor payments (M3 task 5; 0031; task 5b, 0032). Architecture §3 (approval matrix "Vendor payment": Finance
// Manager, creator cannot approve), §6 "Vendor payment"; owner Q4 (IAS 21) and "extra" (filer status, 2026-11-25);
// owner answers 2026-11-26 (WHT base and filer / non-filer rates, stale filer check, reference at posting, reversal).
//
// The AP Officer (fin.payment.manage) drafts a payment to one vendor, settling POSTED invoices in their currency
// (one currency per payment): DRAFT → PENDING_APPROVAL (submit: the approval matrix VENDOR_PAYMENT on the PKR paid)
// → APPROVED (Finance Manager, e-signature; the creator / submitter approves no step) → POSTED by the AP Officer on
// the payment date, with the bank reference or cheque number. A rejection returns it to DRAFT.
// WHT: the vendor's WHT section (a WITHHOLDING tax code). Its filer rate applies when the vendor's filer status (ATL),
// copied onto the payment when it is drafted and again at submit, is "filer"; otherwise (non-filer, or never checked)
// its non-filer rate. The base is the gross PKR paid (INCL_SALES_TAX) or the part of it that is not sales tax on the
// invoices settled (EXCL_SALES_TAX). Unconfirmed rates or base stop submit and posting (TAX_RATE_NOT_CONFIRMED). A
// filer status checked more than purch.vendor.filer_check_max_days before the approval (or never) is a warning the
// approver acknowledges (FILER_CHECK_STALE; stored on the payment).
// Foreign currency (owner Q4): the payment records the foreign amount settled and the PKR paid; AP is taken off at the
// invoices' carrying PKR and the difference is an exchange gain/loss.
// Journal: Dr AP (carrying) / Dr-Cr exchange difference / Cr bank (net) / Cr WHT payable.
// Reversal (bounced cheque, wrong payment): a Finance Manager (fin.payment.reverse), e-signature (REVERSED) + reason;
// the journal is mirrored on the reversal day and the invoices it settled are open again.
import { Decimal } from 'decimal.js';
import {
  FILER_CHECK_STALE,
  VendorPaymentStatus,
  type CreateVendorPaymentRequest,
  type Page,
  type PostVendorPaymentRequest,
  type PurchListQuery,
  type ReverseVendorDocumentRequest,
  type UpdateVendorPaymentRequest,
  type VendorPaymentDto,
  type WhtBase,
} from '@albert/shared';
import { db, withTransaction, type Queryable, type Tx } from '../../db/client';
import { AppError } from '../../core/errors';
import { companyToday } from '../../core/dates';
import { txContext, type AuthContext, type RequestMeta } from '../../core/auth/auth.service';
import { recordSignature, verifySignature } from '../../core/esign/esign.service';
import { defineTransitions, recordInitialStatus, transition, type Actor } from '../../core/transition/transition';
import { cancelApproval, latestApprovalIds, registerApprovalHandler, startApproval } from '../../core/approvals/approvals.service';
import { nextDocNo } from '../../core/settings/numbering.service';
import { journalsOfSource, postJournal, reverseJournal, type JournalLineInput, type SourceJournal } from '../../engines/posting';
import { assertTaxRateConfirmed } from '../masters/catalog.service';
import { assertPurchVendor, purchTaxCodes, purchVendors, type PurchTaxCodeRef, type PurchVendorRef } from '../masters/purch-refs.service';
import * as repo from './invoices.repo';
import { userNames } from '../../core/access/access.service';
import { filerCheckMaxDays } from './procurement.settings';

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
    // Owner 2026-11-26 (task 5b): bounced cheque, wrong payment.
    { from: 'POSTED', to: 'REVERSED', permission: 'fin.payment.reverse', esign: ['REVERSED'], reasonRequired: true },
  ],
});

const D = (v: string | number | null | undefined) => new Decimal(v ?? 0);
const money2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

async function lockPayment(tx: Tx, companyId: string, id: string): Promise<repo.PaymentRow> {
  const row = await repo.findPayment(tx, companyId, id, true);
  if (!row) throw new AppError('NOT_FOUND', 'Vendor payment not found');
  return row;
}

function assertStatus(row: repo.PaymentRow, ...allowed: VendorPaymentStatus[]): void {
  if (!allowed.includes(row.status)) {
    throw new AppError(['POSTED', 'CANCELLED', 'REVERSED'].includes(row.status) ? 'RECORD_LOCKED' : 'INVALID_TRANSITION',
      `Vendor payment ${row.docNo} is ${row.status}`, { status: row.status });
  }
}

/** Owner 2026-11-26 (answer 4): the filer status was checked more than the setting's days before `today`, or never. */
function filerStale(row: Pick<repo.PaymentRow, 'whtTaxCodeId' | 'payeeFilerCheckedOn'>, maxDays: number, today = companyToday()): boolean {
  if (!row.whtTaxCodeId) return false;
  return row.payeeFilerCheckedOn === null || daysBetween(row.payeeFilerCheckedOn, today) > maxDays;
}

// ---------------------------------------------------------------- approval hooks (approval matrix VENDOR_PAYMENT)

registerApprovalHandler(PAYMENT_DOC_TYPE, {
  async assertMayApprove(tx, approval, actor, acknowledgements) {
    const p = await lockPayment(tx, actor.companyId, approval.docId);
    if (actor.userId === p.createdBy || actor.userId === p.submittedBy) {
      throw new AppError('SEGREGATION_OF_DUTIES', 'Whoever creates or submits a payment cannot approve it', { rule: 'payment creator ≠ payment approver' });
    }
    const maxDays = await filerCheckMaxDays(tx, actor.companyId);
    if (filerStale(p, maxDays)) {
      if (!acknowledgements.includes(FILER_CHECK_STALE)) {
        throw new AppError(
          'ACKNOWLEDGEMENT_REQUIRED',
          p.payeeFilerCheckedOn
            ? `The vendor's filer status on ${p.docNo} was checked on ${p.payeeFilerCheckedOn}, more than ${maxDays} days ago; acknowledge it to approve`
            : `The vendor's filer status on ${p.docNo} was never checked (the non-filer rate applies); acknowledge it to approve`,
          { warning: FILER_CHECK_STALE, checkedOn: p.payeeFilerCheckedOn, maxDays },
        );
      }
      await repo.setFilerAcknowledged(tx, p.id, actor.userId);
    }
  },
  async onApproved(tx, approval, actor) {
    const p = await lockPayment(tx, actor.companyId, approval.docId);
    await assertPurchVendor(tx, actor.companyId, p.vendorId);
    await transition(tx, VendorPaymentMoves, { entityId: p.id, to: 'APPROVED', actor });
  },
  async onRejected(tx, approval, actor, reason) {
    const p = await lockPayment(tx, actor.companyId, approval.docId);
    await transition(tx, VendorPaymentMoves, { entityId: p.id, to: 'DRAFT', actor, reason, alsoSet: { filer_warning_ack_by: null, filer_warning_ack_at: null } });
  },
});

// ---------------------------------------------------------------- reading

async function toDtos(q: Queryable, companyId: string, rows: repo.PaymentRow[]): Promise<VendorPaymentDto[]> {
  const ids = rows.map((r) => r.id);
  const allocs = await repo.allocationsOf(q, ids);
  const [vendors, invoices, taxCodes, names, approvals, maxDays] = await Promise.all([
    purchVendors(q, companyId, rows.map((r) => r.vendorId)),
    repo.invoicesByIds(q, companyId, allocs.map((a) => a.invoiceId)),
    purchTaxCodes(q, companyId, rows.flatMap((r) => (r.whtTaxCodeId ? [r.whtTaxCodeId] : []))),
    userNames(
      q,
      rows.flatMap((r) => [r.createdBy, r.submittedBy, r.postedBy, r.filerWarningAckBy, r.reversedBy].filter((u): u is string => u !== null)),
    ),
    latestApprovalIds(q, companyId, PAYMENT_TABLE, ids),
    filerCheckMaxDays(q, companyId),
  ]);
  const journals = new Map(
    await Promise.all(
      rows
        .filter((r) => r.status === 'POSTED' || r.status === 'REVERSED')
        .map(async (r) => [r.id, await journalsOfSource(q, companyId, PAYMENT_DOC_TYPE, r.id)] as const),
    ),
  );
  const docOf = (js: SourceJournal[] | undefined, reversal: boolean) => js?.find((j) => (j.reversalOf !== null) === reversal)?.docNo ?? null;
  const name = (u: string | null) => (u ? (names.get(u) ?? '') : null);
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
      whtRateUnconfirmed: !!tc && (tc.isPlaceholder || !tc.whtBaseConfirmed),
      whtBase: r.whtBase,
      whtBasePkr: r.whtBasePkr ?? r.pkrPaid,
      netPaid: r.netPaid,
      payeeIsFiler: r.payeeIsFiler,
      payeeFilerCheckedOn: r.payeeFilerCheckedOn,
      filerCheckStale: ['DRAFT', 'PENDING_APPROVAL'].includes(r.status) && filerStale(r, maxDays),
      filerCheckMaxDays: maxDays,
      filerWarningAckByName: name(r.filerWarningAckBy),
      filerWarningAckAt: r.filerWarningAckAt ? r.filerWarningAckAt.toISOString() : null,
      carryingPkr: r.carryingPkr,
      exchangeDiffPkr: r.exchangeDiffPkr,
      reference: r.reference,
      notes: r.notes,
      status: r.status,
      approvalId: approvals.get(r.id) ?? null,
      submittedByName: name(r.submittedBy),
      postingDate: r.postingDate,
      postedByName: name(r.postedBy),
      postedAt: r.postedAt ? r.postedAt.toISOString() : null,
      journalDocNo: docOf(journals.get(r.id), false),
      reversedByName: name(r.reversedBy),
      reversedAt: r.reversedAt ? r.reversedAt.toISOString() : null,
      reversalDate: r.reversalDate,
      reversalReason: r.reversalReason,
      reversalJournalDocNo: docOf(journals.get(r.id), true),
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

/**
 * What is still open on each invoice (POSTED payments and POSTED debit notes taken off), in its currency and at its
 * carrying PKR.
 */
async function openOf(q: Queryable, invoices: repo.InvoiceRow[]): Promise<Map<string, { foreign: Decimal; pkr: Decimal }>> {
  const ids = invoices.map((i) => i.id);
  const [paid, debited] = await Promise.all([repo.paidOnInvoices(q, ids), repo.debitedOnInvoices(q, ids)]);
  return new Map(
    invoices.map((i) => [
      i.id,
      {
        foreign: D(i.totalAmount).minus(D(paid.get(i.id)?.foreign)).minus(D(debited.get(i.id)?.foreign)),
        pkr: D(i.totalPkr).minus(D(paid.get(i.id)?.carrying)).minus(D(debited.get(i.id)?.pkr)),
      },
    ]),
  );
}

/** The payee's filer status the WHT rate follows: the vendor's now (draft, submit) or the one copied at submit (posting). */
interface Payee {
  isFiler: boolean | null;
  filerCheckedOn: string | null;
}

/**
 * WHT (owner 2026-11-26): the filer rate for a payee on the ATL, else the non-filer rate (TAX_RATE_NOT_CONFIRMED when
 * Finance has not given it); on the gross PKR or, for EXCL_SALES_TAX, on the PKR share of what is not sales tax:
 * round(PKR paid × Σ round(allocation × goods ÷ total, 2) ÷ foreign settled, 2). The DB (0032) recomputes it the same way.
 */
function withholding(
  tc: PurchTaxCodeRef | undefined,
  payee: Payee,
  pkrPaid: Decimal,
  foreign: Decimal,
  allocations: { amount: Decimal; invoice: repo.InvoiceRow }[],
): { rate: Decimal; base: WhtBase | null; basePkr: Decimal; amount: Decimal } {
  if (!tc) return { rate: D(0), base: null, basePkr: pkrPaid, amount: D(0) };
  const rate = payee.isFiler === true ? tc.rate : tc.nonFilerRate;
  if (rate === null) {
    throw new AppError('TAX_RATE_NOT_CONFIRMED', `Withholding tax ${tc.code} has no non-filer rate yet; Finance must give it before a non-filer is paid`, {
      taxCode: tc.code,
      unconfirmed: 'NON_FILER_RATE',
    });
  }
  const base = tc.whtBase ?? 'INCL_SALES_TAX';
  const exclTax = allocations.reduce((s, a) => s.plus(money2(a.amount.times(a.invoice.goodsAmount).div(a.invoice.totalAmount))), D(0));
  const basePkr = base === 'INCL_SALES_TAX' ? pkrPaid : money2(pkrPaid.times(exclTax).div(foreign));
  return { rate: D(rate), base, basePkr, amount: money2(basePkr.times(rate).div(100)) };
}

/** Checks the allocations against the vendor's POSTED invoices as they are now; the payment values. */
async function prepare(
  q: Queryable,
  companyId: string,
  vendor: PurchVendorRef,
  payee: Payee,
  input: PaymentFields,
  invoices: repo.InvoiceRow[],
): Promise<Omit<repo.PaymentValues, 'docNo'>> {
  if (input.paymentDate > companyToday()) throw new AppError('VALIDATION_FAILED', 'The payment date cannot be in the future', { field: 'paymentDate' });
  const byId = new Map(invoices.map((i) => [i.id, i]));
  const open = await openOf(q, invoices);
  const seen = new Set<string>();
  const currencies = new Set<string>();
  const settled: { amount: Decimal; invoice: repo.InvoiceRow }[] = [];
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
    settled.push({ amount: D(a.amount), invoice: inv });
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
  let tc: PurchTaxCodeRef | undefined;
  if (vendor.whtTaxCodeId) {
    tc = (await purchTaxCodes(q, companyId, [vendor.whtTaxCodeId])).get(vendor.whtTaxCodeId);
    if (!tc) throw new AppError('VALIDATION_FAILED', `The WHT section of ${vendor.code} does not exist`);
  }
  const wht = withholding(tc, payee, pkrPaid, foreign, settled);
  if (!pkrPaid.minus(wht.amount).gt(0)) throw new AppError('VALIDATION_FAILED', 'Nothing would be paid after WHT', { field: 'pkrPaid' });
  return {
    vendorId: vendor.id,
    paymentDate: input.paymentDate,
    currency,
    foreignAmount: foreign.toFixed(2),
    pkrPaid: pkrPaid.toFixed(2),
    whtTaxCodeId: vendor.whtTaxCodeId,
    whtRate: wht.rate.toFixed(4),
    whtAmount: wht.amount.toFixed(2),
    whtBase: wht.base,
    whtBasePkr: wht.basePkr.toFixed(2),
    netPaid: pkrPaid.minus(wht.amount).toFixed(2),
    payeeIsFiler: payee.isFiler,
    payeeFilerCheckedOn: payee.filerCheckedOn,
    reference: input.reference?.trim() || null,
    notes: input.notes?.trim() || null,
  };
}

const allocationRows = (input: PaymentFields) => input.allocations.map((a) => ({ invoiceId: a.invoiceId, foreignAmount: D(a.amount).toFixed(2) }));
const vendorPayee = (v: PurchVendorRef): Payee => ({ isFiler: v.isFiler, filerCheckedOn: v.filerCheckedOn });

export async function createVendorPayment(auth: AuthContext, input: CreateVendorPaymentRequest): Promise<VendorPaymentDto> {
  const id = await withTransaction(txContext(auth, 'draft vendor payment'), async (tx) => {
    const vendor = await assertPurchVendor(tx, auth.companyId, input.vendorId);
    const invoices = await repo.lockInvoices(tx, auth.companyId, input.allocations.map((a) => a.invoiceId));
    const values = await prepare(tx, auth.companyId, vendor, vendorPayee(vendor), input, invoices);
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
    const values = await prepare(tx, auth.companyId, vendor, vendorPayee(vendor), input, invoices);
    await repo.replaceAllocations(tx, id, allocationRows(input));
    await repo.updatePayment(tx, id, values);
  });
  return getVendorPayment(auth, id);
}

/** The payment as stored, recomputed against the invoices now and the given payee status. */
async function recompute(tx: Tx, companyId: string, row: repo.PaymentRow, payee: Payee) {
  const vendor = await assertPurchVendor(tx, companyId, row.vendorId);
  const allocs = await repo.allocationsOf(tx, [row.id]);
  const invoices = await repo.lockInvoices(tx, companyId, allocs.map((a) => a.invoiceId));
  const values = await prepare(
    tx,
    companyId,
    vendor,
    payee,
    {
      paymentDate: row.paymentDate,
      pkrPaid: row.pkrPaid,
      reference: row.reference,
      notes: row.notes,
      allocations: allocs.map((a) => ({ invoiceId: a.invoiceId, amount: a.foreignAmount })),
    },
    invoices,
  );
  return { vendor, allocs, invoices, values };
}

/** Submit for approval (approval matrix VENDOR_PAYMENT, on the gross PKR paid), with the vendor's filer status now. */
export async function submitVendorPayment(auth: AuthContext, id: string): Promise<VendorPaymentDto> {
  await withTransaction(txContext(auth, 'submit vendor payment'), async (tx) => {
    const row = await lockPayment(tx, auth.companyId, id);
    assertStatus(row, 'DRAFT');
    const vendor = await assertPurchVendor(tx, auth.companyId, row.vendorId);
    // Still DRAFT: the WHT follows the vendor's section and filer status as they stand now.
    const { values } = await recompute(tx, auth.companyId, row, vendorPayee(vendor));
    // 0013 / owner 2026-11-26: no WHT goes for approval until Finance confirms the rates and the base.
    if (values.whtTaxCodeId) await assertTaxRateConfirmed(tx, auth.companyId, values.whtTaxCodeId);
    await repo.updatePayment(tx, id, values);
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
      value: { measure: 'AMOUNT_PKR', amount: values.pkrPaid },
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

/**
 * Posts an APPROVED payment on its date (open period) with its bank reference / cheque number (owner 2026-11-26):
 * AP at the carrying PKR, exchange difference, bank, WHT.
 */
export async function postVendorPayment(auth: AuthContext, id: string, input: PostVendorPaymentRequest = {}): Promise<VendorPaymentDto> {
  await withTransaction(txContext(auth, 'post vendor payment'), async (tx) => {
    let row = await lockPayment(tx, auth.companyId, id);
    assertStatus(row, 'APPROVED');
    const reference = row.reference ?? input.reference?.trim() ?? null;
    if (input.reference && row.reference && input.reference.trim() !== row.reference) {
      throw new AppError('VALIDATION_FAILED', `${row.docNo} already carries reference ${row.reference}`, { field: 'reference' });
    }
    if (!reference) {
      throw new AppError('VALIDATION_FAILED', `Give the bank reference or cheque number of ${row.docNo} before posting it`, { field: 'reference' });
    }
    if (!row.reference) {
      await repo.updatePayment(tx, id, { reference });
      row = { ...row, reference };
    }
    // The rate follows the filer status the payment was approved with.
    const { vendor, allocs, invoices, values } = await recompute(tx, auth.companyId, row, { isFiler: row.payeeIsFiler, filerCheckedOn: row.payeeFilerCheckedOn });
    if (values.whtTaxCodeId !== row.whtTaxCodeId || !D(values.whtRate).equals(row.whtRate) || !D(values.whtAmount).equals(row.whtAmount)
        || values.whtBase !== row.whtBase) {
      throw new AppError('VALIDATION_FAILED', `The WHT section, rate or base of ${vendor.code} changed since ${row.docNo} was approved; cancel it and draft it again`, {
        field: 'whtTaxCodeId',
      });
    }
    if (row.whtTaxCodeId) await assertTaxRateConfirmed(tx, auth.companyId, row.whtTaxCodeId);
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
      narration: `Vendor payment ${row.docNo} to ${vendor.code}${row.currency !== 'PKR' ? ` (${row.foreignAmount} ${row.currency})` : ''} ref ${reference}`,
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

/**
 * Owner 2026-11-26 (task 5b): a Finance Manager reverses a POSTED payment (bounced cheque, wrong payment) with an
 * e-signature (REVERSED) and a reason. The journal is mirrored on the reversal day (open period); the invoices it
 * settled are open again (only POSTED payments count). The DB (0032) re-checks.
 */
export async function reverseVendorPayment(auth: AuthContext, id: string, input: ReverseVendorDocumentRequest, meta: RequestMeta): Promise<VendorPaymentDto> {
  if (input.signature.meaning !== 'REVERSED') throw new AppError('VALIDATION_FAILED', 'Reversing a payment needs the meaning REVERSED');
  const proof = await verifySignature(auth, input.signature, meta);
  const reason = input.signature.reason;
  await withTransaction(txContext(auth, `reverse vendor payment: ${reason}`), async (tx) => {
    const row = await lockPayment(tx, auth.companyId, id);
    if (row.status !== 'POSTED') {
      throw new AppError(['REVERSED', 'CANCELLED'].includes(row.status) ? 'RECORD_LOCKED' : 'INVALID_TRANSITION',
        `Vendor payment ${row.docNo} is ${row.status}; only a POSTED payment is reversed`, { status: row.status });
    }
    const entry = (await journalsOfSource(tx, auth.companyId, PAYMENT_DOC_TYPE, id)).find((j) => j.status === 'POSTED' && j.reversalOf === null);
    if (!entry) throw new AppError('VALIDATION_FAILED', `${row.docNo} has no posted journal to reverse`);
    const date = companyToday();
    await reverseJournal(tx, auth, { entryId: entry.id, date, reason: `${row.docNo} reversed: ${reason}` });
    const signature = await recordSignature(tx, proof, { table: PAYMENT_TABLE, id }, ['REVERSED']);
    await transition(tx, VendorPaymentMoves, {
      entityId: id,
      to: 'REVERSED',
      actor: auth,
      signature,
      reason,
      alsoSet: { reversed_by: auth.userId, reversed_at: new Date().toISOString(), reversal_date: date, reversal_reason: reason },
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
