// Vendor invoices, payments, vendor ledger and AP ageing (/api/v1/purch/...). M3 task 5; 0031;
// architecture §6 "Vendor invoice posted" / "Vendor payment", §7.5; owner Q3, Q4, Q5 and "extra" (2026-11-25).
// Amounts are decimal strings (rule 10): money 2 decimals, quantities 4, unit prices 6.
import { z } from 'zod';
import { DebitNoteReason, VendorInvoiceType, type DebitNoteStatus, type VendorInvoiceStatus, type VendorPaymentStatus, type WhtBase } from '../../enums';
import { decimalString, unitRate } from '../master/masters';
import { ESignRequest, WitnessSignRequest } from '../core/esign';

const id = z.string().regex(/^\d+$/, 'Invalid id');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date: YYYY-MM-DD');
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const above0 = (s: z.ZodString, label: string) => s.refine((v) => /[1-9]/.test(v), `${label} must be above zero`);
const money = (label: string) => decimalString(16, 2, label);
const qty = above0(decimalString(14, 4, 'Quantity'), 'Quantity');

// ---------------------------------------------------------------- vendor invoices (fin.invoice.manage)

/**
 * GOODS line: a GRN line of the PO, the quantity billed and the vendor's unit price (invoice currency = PO currency).
 * CHARGES line: a POSTED landed cost (an original, not a correction) and the amount billed in its currency.
 * Both may carry a SALES_TAX code: the tax is round(amount × rate, 2), never typed.
 */
const invoiceLine = z
  .object({
    grnLineId: id.optional(),
    landedCostId: id.optional(),
    qty: qty.optional(),
    unitPrice: unitRate('Unit price').optional(),
    amount: above0(money('Amount'), 'Amount').optional(),
    taxCodeId: id.nullable().optional(),
  })
  .strict()
  .superRefine((l, ctx) => {
    if (!!l.grnLineId === !!l.landedCostId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['grnLineId'], message: 'A line names a GRN line or a landed cost' });
    }
    if (l.grnLineId && (!l.qty || l.unitPrice === undefined || l.amount)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['qty'], message: 'A goods line takes the quantity and unit price' });
    }
    if (l.landedCostId && (!l.amount || l.qty || l.unitPrice)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amount'], message: 'A charges line takes the amount billed' });
    }
  });
export type VendorInvoiceLineInput = z.infer<typeof invoiceLine>;

const invoiceHeader = {
  vendorInvoiceNo: z.string().trim().min(1, "The vendor's invoice number is required").max(60),
  invoiceDate: isoDate,
  notes: optText(1000),
  lines: z.array(invoiceLine).min(1, 'Add at least one line').max(200),
};

export const CreateVendorInvoiceRequest = z
  .object({ invoiceType: z.enum(VendorInvoiceType), poId: id.optional(), vendorId: id.optional(), ...invoiceHeader })
  .strict()
  .superRefine((v, ctx) => {
    if (v.invoiceType === 'GOODS' && !v.poId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['poId'], message: 'A goods invoice names its PO' });
    if (v.invoiceType === 'CHARGES' && (!v.vendorId || v.poId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vendorId'], message: 'A charges invoice names its vendor and no PO' });
    }
  });
export type CreateVendorInvoiceRequest = z.infer<typeof CreateVendorInvoiceRequest>;

export const UpdateVendorInvoiceRequest = z.object(invoiceHeader).strict();
export type UpdateVendorInvoiceRequest = z.infer<typeof UpdateVendorInvoiceRequest>;

/** Owner Q5: a Finance Manager releases an invoice in MATCH_EXCEPTION with an e-signature (APPROVED) and a reason. */
export const ReleaseVendorInvoiceRequest = z.object({ signature: ESignRequest }).strict();
export type ReleaseVendorInvoiceRequest = z.infer<typeof ReleaseVendorInvoiceRequest>;

/**
 * Owner 2026-11-26 (task 5b): a Finance Manager reverses a POSTED vendor invoice (nothing paid or debited against it)
 * or a POSTED payment (bounced cheque, wrong payment) with an e-signature, meaning REVERSED, and a reason.
 */
export const ReverseVendorDocumentRequest = z.object({ signature: ESignRequest }).strict();
export type ReverseVendorDocumentRequest = z.infer<typeof ReverseVendorDocumentRequest>;

export const VendorInvoiceListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(100).optional(),
  status: z.string().trim().max(30).optional(),
  vendorId: id.optional(),
  poId: id.optional(),
});
export type VendorInvoiceListQuery = z.infer<typeof VendorInvoiceListQuery>;

export interface VendorInvoiceLineDto {
  id: string;
  lineNo: number;
  grnLineId: string | null;
  grnDocNo: string | null;
  lotNo: string | null;
  landedCostId: string | null;
  landedCostDocNo: string | null;
  chargeTypeCode: string | null;
  itemCode: string | null;
  itemName: string | null;
  qty: string | null;
  unitPrice: string | null;
  amount: string;
  taxCodeId: string | null;
  taxCode: string | null;
  taxRate: string;
  taxAmount: string;
  /** The 3-way match (GOODS), as computed when the invoice was posted or held. */
  poUnitPrice: string | null;
  priceDiffPct: string | null;
  qtyOver: string | null;
  inTolerance: boolean | null;
  /** Posting result in PKR: amount = cleared (GRNI / clearing) + price variance + exchange difference. */
  amountPkr: string | null;
  taxPkr: string | null;
  clearedPkr: string | null;
  matchedQty: string | null;
  priceVariancePkr: string | null;
  exchangeDiffPkr: string | null;
}

export interface VendorInvoiceDto {
  id: string;
  docNo: string;
  invoiceType: VendorInvoiceType;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  poId: string | null;
  poDocNo: string | null;
  vendorInvoiceNo: string;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  exchangeRate: string;
  exchangeRateDate: string;
  goodsAmount: string;
  taxAmount: string;
  totalAmount: string;
  totalPkr: string;
  /** Settled by POSTED payments, taken off by POSTED debit notes, and what is left (invoice currency; PKR at the carrying amount). */
  paidAmount: string;
  debitedAmount: string;
  openAmount: string;
  openPkr: string;
  notes: string | null;
  status: VendorInvoiceStatus;
  exceptionAt: string | null;
  releasedByName: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  postingDate: string | null;
  postedByName: string | null;
  postedAt: string | null;
  journalDocNo: string | null;
  /** REVERSED (owner 2026-11-26): who, when, the reversal's date, reason and journal. */
  reversedByName: string | null;
  reversedAt: string | null;
  reversalDate: string | null;
  reversalReason: string | null;
  reversalJournalDocNo: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  lines: VendorInvoiceLineDto[];
}

/** What can still be billed: GRN lines of a PO (GOODS) or open landed costs of a vendor (CHARGES). */
export const BillableQuery = z
  .object({ poId: id.optional(), vendorId: id.optional() })
  .strict()
  .refine((q) => !!q.poId !== !!q.vendorId, { message: 'Name a PO (goods) or a vendor (charges)' });
export type BillableQuery = z.infer<typeof BillableQuery>;

export interface BillableGrnLineDto {
  grnLineId: string;
  grnId: string;
  grnDocNo: string;
  grnDate: string;
  lineNo: number;
  itemCode: string;
  itemName: string;
  lotNo: string;
  receivedQty: string;
  invoicedQty: string;
  openQty: string;
  poUnitPrice: string;
  currency: string;
}
export interface BillableChargeDto {
  landedCostId: string;
  docNo: string;
  grnDocNo: string;
  chargeTypeCode: string;
  chargeTypeName: string;
  chargeDate: string;
  currency: string;
  /** Original + posted corrections. */
  chargedAmount: string;
  invoicedAmount: string;
  openAmount: string;
  reference: string | null;
}
export interface BillableDto {
  goods: BillableGrnLineDto[];
  charges: BillableChargeDto[];
}

// ---------------------------------------------------------------- vendor payments (fin.payment.manage / approve)

const allocation = z.object({ invoiceId: id, amount: above0(money('Amount'), 'Amount') }).strict();

const paymentFields = {
  paymentDate: isoDate,
  /** Gross PKR paid (bank + WHT) for a foreign-currency payment; for PKR it equals the amount settled. */
  pkrPaid: above0(money('PKR paid'), 'PKR paid').optional(),
  reference: optText(60),
  notes: optText(1000),
  allocations: z.array(allocation).min(1, 'Settle at least one invoice').max(200),
};
/** Owner 2026-11-26: posting needs the bank reference or cheque number; it may be given here if the draft had none. */
export const PostVendorPaymentRequest = z.object({ reference: z.string().trim().min(1).max(60).optional() }).strict();
export type PostVendorPaymentRequest = z.infer<typeof PostVendorPaymentRequest>;
export const CreateVendorPaymentRequest = z.object({ vendorId: id, ...paymentFields }).strict();
export type CreateVendorPaymentRequest = z.infer<typeof CreateVendorPaymentRequest>;
export const UpdateVendorPaymentRequest = z.object(paymentFields).strict();
export type UpdateVendorPaymentRequest = z.infer<typeof UpdateVendorPaymentRequest>;

export interface PaymentAllocationDto {
  invoiceId: string;
  invoiceDocNo: string;
  vendorInvoiceNo: string;
  invoiceDate: string;
  dueDate: string;
  amount: string;
  carryingPkr: string | null;
}
export interface VendorPaymentDto {
  id: string;
  docNo: string;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  paymentDate: string;
  currency: string;
  foreignAmount: string;
  pkrPaid: string;
  whtTaxCodeId: string | null;
  whtTaxCode: string | null;
  whtRate: string;
  whtAmount: string;
  /** The WHT code's rates or base are not confirmed by Finance: the payment cannot be submitted or posted (TAX_RATE_NOT_CONFIRMED). */
  whtRateUnconfirmed: boolean;
  /** Owner 2026-11-26: the code's base (incl. / excl. sales tax) and the PKR the WHT is worked out on. */
  whtBase: WhtBase | null;
  whtBasePkr: string;
  netPaid: string;
  /** The vendor's filer status (ATL), copied at draft and submit: the filer rate applies only when true. */
  payeeIsFiler: boolean | null;
  payeeFilerCheckedOn: string | null;
  /**
   * The filer status was checked more than setting purch.vendor.filer_check_max_days ago (or never): the approver
   * acknowledges the warning (FILER_CHECK_STALE) when approving.
   */
  filerCheckStale: boolean;
  filerCheckMaxDays: number;
  filerWarningAckByName: string | null;
  filerWarningAckAt: string | null;
  carryingPkr: string | null;
  exchangeDiffPkr: string | null;
  reference: string | null;
  notes: string | null;
  status: VendorPaymentStatus;
  approvalId: string | null;
  submittedByName: string | null;
  postingDate: string | null;
  postedByName: string | null;
  postedAt: string | null;
  journalDocNo: string | null;
  reversedByName: string | null;
  reversedAt: string | null;
  reversalDate: string | null;
  reversalReason: string | null;
  reversalJournalDocNo: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  allocations: PaymentAllocationDto[];
}

/** The warning code an approver acknowledges for a stale filer status (ApprovalDecisionRequest.acknowledgements). */
export const FILER_CHECK_STALE = 'FILER_CHECK_STALE';

// ---------------------------------------------------------------- debit notes (fin.debit_note.manage / approve; 0032)

/**
 * A line takes an invoice line of the debit note's invoice. PRICE_CLAIM: the amount off (invoice currency).
 * SHORT_SUPPLY and RETURN_TO_VENDOR: the quantity; the amount is quantity × the invoice unit price. Tax follows the
 * invoice line's tax code. A RETURN_TO_VENDOR note has one line (one lot, one witnessed movement).
 */
const debitNoteLine = z
  .object({ invoiceLineId: id, qty: qty.optional(), amount: above0(money('Amount'), 'Amount').optional() })
  .strict()
  .refine((l) => !!l.qty !== !!l.amount, { message: 'A line takes the quantity (short supply, return) or the amount (price claim)', path: ['qty'] });
export type DebitNoteLineInput = z.infer<typeof debitNoteLine>;

const debitNoteFields = {
  dnDate: isoDate,
  notes: optText(1000),
  lines: z.array(debitNoteLine).min(1, 'Add at least one line').max(200),
};
export const CreateDebitNoteRequest = z
  .object({ invoiceId: id, reason: z.enum(DebitNoteReason), ...debitNoteFields })
  .strict()
  .superRefine((v, ctx) => {
    const wantsQty = v.reason !== 'PRICE_CLAIM';
    if (v.lines.some((l) => !!l.qty !== wantsQty)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines'], message: wantsQty ? 'Give the quantity on each line' : 'Give the amount on each line' });
    }
    if (v.reason === 'RETURN_TO_VENDOR' && v.lines.length !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines'], message: 'A return note returns one lot (one line)' });
    }
  });
export type CreateDebitNoteRequest = z.infer<typeof CreateDebitNoteRequest>;
export const UpdateDebitNoteRequest = z.object(debitNoteFields).strict();
export type UpdateDebitNoteRequest = z.infer<typeof UpdateDebitNoteRequest>;

/**
 * Posting a RETURN_TO_VENDOR note is the Warehouse Manager's disposal (inv.lot.dispose): the location the lot leaves and
 * the QA witness signature (qa.lot.witness) for the movement, entered at the same terminal (rule 1, 0020).
 */
export const PostDebitNoteRequest = z.object({ locationId: id.optional(), witness: WitnessSignRequest.optional() }).strict();
export type PostDebitNoteRequest = z.infer<typeof PostDebitNoteRequest>;

/**
 * Owner 2026-11-27: a Finance Manager reverses a POSTED debit note with an e-signature (meaning REVERSED) and a reason.
 * A return note also reverses its return movement (stock back into the REJECTED lot), which needs the QA witness
 * signature for that movement (rule 1, 0020), entered at the same terminal.
 */
export const ReverseDebitNoteRequest = z.object({ signature: ESignRequest, witness: WitnessSignRequest.optional() }).strict();
export type ReverseDebitNoteRequest = z.infer<typeof ReverseDebitNoteRequest>;

export const DebitNoteListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(100).optional(),
  status: z.string().trim().max(30).optional(),
  vendorId: id.optional(),
  invoiceId: id.optional(),
});
export type DebitNoteListQuery = z.infer<typeof DebitNoteListQuery>;

export interface DebitNoteLineDto {
  id: string;
  lineNo: number;
  invoiceLineId: string;
  invoiceLineNo: number;
  itemCode: string | null;
  itemName: string | null;
  grnDocNo: string | null;
  lotId: string | null;
  lotNo: string | null;
  qty: string | null;
  unitPrice: string | null;
  amount: string;
  taxCode: string | null;
  taxRate: string;
  taxAmount: string;
  amountPkr: string | null;
  taxPkr: string | null;
  /** RETURN_TO_VENDOR: the movement posted and the stock value it took off the lot; the rest of the PKR → price variance. */
  movementId: string | null;
  stockValuePkr: string | null;
  priceVariancePkr: string | null;
}
export interface DebitNoteDto {
  id: string;
  docNo: string;
  reason: DebitNoteReason;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  invoiceId: string;
  invoiceDocNo: string;
  vendorInvoiceNo: string;
  dnDate: string;
  currency: string;
  exchangeRate: string;
  goodsAmount: string;
  taxAmount: string;
  totalAmount: string;
  totalPkr: string;
  notes: string | null;
  status: DebitNoteStatus;
  approvalId: string | null;
  submittedByName: string | null;
  postingDate: string | null;
  postedByName: string | null;
  postedAt: string | null;
  journalDocNo: string | null;
  /** REVERSED (owner 2026-11-27): who, when, the reversal's date, reason and journal. */
  reversedByName: string | null;
  reversedAt: string | null;
  reversalDate: string | null;
  reversalReason: string | null;
  reversalJournalDocNo: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  lines: DebitNoteLineDto[];
}

/** For the debit-note form: what can still be debited on each line of a POSTED GOODS invoice. */
export interface DebitableLineDto {
  invoiceLineId: string;
  lineNo: number;
  itemCode: string;
  itemName: string;
  grnDocNo: string;
  lotId: string | null;
  lotNo: string;
  lotStatus: string | null;
  qty: string;
  matchedQty: string;
  unitPrice: string;
  amount: string;
  taxCode: string | null;
  taxRate: string;
  /** On POSTED debit notes and on notes not yet posted (DRAFT, PENDING_APPROVAL, APPROVED). */
  debitedAmount: string;
  shortQtyOpen: string;
  returnQtyOpen: string;
  amountOpen: string;
}
export interface DebitableDto {
  invoiceId: string;
  docNo: string;
  currency: string;
  /** Still open on the invoice (total − POSTED payments − POSTED debit notes): a note never takes more. */
  openAmount: string;
  lines: DebitableLineDto[];
}

/** A vendor's POSTED invoice with something still open (the payment screen). */
export interface OpenInvoiceDto {
  invoiceId: string;
  docNo: string;
  vendorInvoiceNo: string;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  totalAmount: string;
  openAmount: string;
  openPkr: string;
}

// ---------------------------------------------------------------- vendor ledger and AP ageing (purch.view / fin.view)

export const VendorLedgerQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() }).strict();
export type VendorLedgerQuery = z.infer<typeof VendorLedgerQuery>;

export interface VendorLedgerLineDto {
  date: string;
  journalDocNo: string;
  sourceType: string;
  sourceId: string | null;
  sourceDocNo: string | null;
  narration: string;
  /** PKR on the payables account: debit reduces what is owed, credit adds to it. */
  debit: string;
  credit: string;
  /** Owed after this line (credit − debit, running). */
  balance: string;
  currency: string | null;
  foreignAmount: string | null;
}
export interface VendorLedgerDto {
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  currency: string;
  from: string | null;
  to: string | null;
  opening: string;
  closing: string;
  lines: VendorLedgerLineDto[];
}

export const ApAgeingQuery = z.object({ asOf: isoDate.optional(), vendorId: id.optional() }).strict();
export type ApAgeingQuery = z.infer<typeof ApAgeingQuery>;

/** Buckets by days past the due date (invoice date + the vendor's payment terms), in PKR at the carrying amount. */
export interface AgeingBuckets {
  notDue: string;
  d1to30: string;
  d31to60: string;
  d61to90: string;
  over90: string;
  total: string;
}
export interface ApAgeingInvoiceDto {
  invoiceId: string;
  docNo: string;
  vendorInvoiceNo: string;
  invoiceDate: string;
  dueDate: string;
  daysPastDue: number;
  currency: string;
  openAmount: string;
  openPkr: string;
}
export interface ApAgeingVendorDto extends AgeingBuckets {
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  paymentTermsDays: number;
  invoices: ApAgeingInvoiceDto[];
}
export interface ApAgeingDto {
  asOf: string;
  vendors: ApAgeingVendorDto[];
  totals: AgeingBuckets;
}
