// Vendor invoices, payments, vendor ledger and AP ageing (/api/v1/purch/...). M3 task 5; 0031;
// architecture §6 "Vendor invoice posted" / "Vendor payment", §7.5; owner Q3, Q4, Q5 and "extra" (2026-11-25).
// Amounts are decimal strings (rule 10): money 2 decimals, quantities 4, unit prices 6.
import { z } from 'zod';
import { VendorInvoiceType, type VendorInvoiceStatus, type VendorPaymentStatus } from '../../enums';
import { decimalString, unitRate } from '../master/masters';
import { ESignRequest } from '../core/esign';

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
  /** Settled by POSTED payments, and what is left (invoice currency; PKR at the carrying amount). */
  paidAmount: string;
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
  /** The WHT code's rate is still a placeholder: the payment cannot be submitted or posted (TAX_RATE_NOT_CONFIRMED). */
  whtRateUnconfirmed: boolean;
  netPaid: string;
  payeeIsFiler: boolean | null;
  payeeFilerCheckedOn: string | null;
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
  createdBy: string;
  createdByName: string;
  createdAt: string;
  allocations: PaymentAllocationDto[];
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
