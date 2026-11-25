// Procurement: purchase requisitions and purchase orders (/api/v1/purch/*). M3 task 2; 0023_procurement_pr_po.sql.
// Status changes are action endpoints (submit, cancel, convert); PATCH edits a DRAFT only.
// Money and quantities travel as decimal strings, never JS numbers (rule 10).
import { z } from 'zod';
import {
  Incoterm,
  PurchaseOrderType,
  type PurchaseOrderStatus,
  type PurchaseRequisitionStatus,
} from '../../enums';
import { decimalString } from '../master/masters';

const id = z.string().regex(/^\d+$/, 'Invalid id');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date: YYYY-MM-DD');
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const reason = z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500);
/** Quantity NUMERIC(18,4), above zero. */
const qty = decimalString(14, 4, 'Quantity').refine((v) => /[1-9]/.test(v), 'Quantity must be above zero');
/** Unit price NUMERIC(18,2), in the PO currency. */
const unitPrice = decimalString(16, 2, 'Unit price');
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Currency: 3-letter ISO code');

// ---------------------------------------------------------------- requisitions (owner Q6: no approval)

const prLine = z.object({ itemId: id, qty, notes: optText(500) }).strict();

const prFields = {
  prDate: isoDate,
  requiredBy: isoDate.nullable().optional(),
  department: optText(80),
  notes: optText(1000),
  lines: z.array(prLine).min(1, 'Add at least one line').max(999),
};

export const CreatePrRequest = z.object(prFields).strict();
export type CreatePrRequest = z.infer<typeof CreatePrRequest>;

/** Replaces the whole DRAFT (header and lines). */
export const UpdatePrRequest = CreatePrRequest;
export type UpdatePrRequest = CreatePrRequest;

/** Cancel a requisition or a purchase order. */
export const PurchActionRequest = z.object({ reason }).strict();
export type PurchActionRequest = z.infer<typeof PurchActionRequest>;

const poHeader = {
  poDate: isoDate,
  vendorId: id,
  poType: z.enum(PurchaseOrderType),
  currency,
  incoterm: z.enum(Incoterm).nullable().optional(),
  deliveryDate: isoDate.nullable().optional(),
  notes: optText(1000),
};

function checkPoHeader(v: { poType: PurchaseOrderType; currency: string; incoterm?: Incoterm | null }, ctx: z.RefinementCtx): void {
  if (v.poType === 'LOCAL' && v.currency !== 'PKR') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['currency'], message: 'A local PO is in PKR' });
  }
  if (v.poType === 'IMPORT' && !v.incoterm) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['incoterm'], message: 'An import PO needs an incoterm' });
  }
}

/** Turn SUBMITTED requisition lines into a new DRAFT PO for one vendor (the PR becomes CONVERTED once every line is ordered). */
export const ConvertPrRequest = z
  .object({
    ...poHeader,
    lines: z
      .array(z.object({ prLineId: id, unitPrice }).strict())
      .min(1, 'Pick at least one line')
      .max(999),
  })
  .strict()
  .superRefine(checkPoHeader);
export type ConvertPrRequest = z.infer<typeof ConvertPrRequest>;

// ---------------------------------------------------------------- purchase orders

const poLine = z.object({ itemId: id, qty, unitPrice, notes: optText(500) }).strict();

export const CreatePoRequest = z
  .object({ ...poHeader, lines: z.array(poLine).min(1, 'Add at least one line').max(999) })
  .strict()
  .superRefine(checkPoHeader);
export type CreatePoRequest = z.infer<typeof CreatePoRequest>;

/**
 * Replaces the whole DRAFT. Lines taken from a requisition are sent back with their `prLineId` (item fixed);
 * leaving one out releases that requisition line.
 */
export const UpdatePoRequest = z
  .object({
    ...poHeader,
    lines: z
      .array(poLine.extend({ prLineId: id.nullable().optional() }).strict())
      .min(1, 'Add at least one line')
      .max(999),
  })
  .strict()
  .superRefine(checkPoHeader);
export type UpdatePoRequest = z.infer<typeof UpdatePoRequest>;

export const PurchListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(100).optional(),
  status: z.string().trim().max(30).optional(),
  vendorId: id.optional(),
});
export type PurchListQuery = z.infer<typeof PurchListQuery>;

// ---------------------------------------------------------------- responses

interface ItemRef {
  itemId: string;
  itemCode: string;
  itemName: string;
  itemType: string;
  uomCode: string;
}

export interface PrLineDto extends ItemRef {
  id: string;
  lineNo: number;
  qty: string;
  notes: string | null;
  /** The PO this line was ordered on, if any. */
  poId: string | null;
  poDocNo: string | null;
}

export interface PrDto {
  id: string;
  docNo: string;
  prDate: string;
  requiredBy: string | null;
  department: string | null;
  notes: string | null;
  status: PurchaseRequisitionStatus;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  lines: PrLineDto[];
}

export interface PoLineDto extends ItemRef {
  id: string;
  lineNo: number;
  qty: string;
  unitPrice: string;
  lineAmount: string;
  receivedQty: string;
  prLineId: string | null;
  prDocNo: string | null;
  notes: string | null;
}

export interface PoDto {
  id: string;
  docNo: string;
  poDate: string;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  poType: PurchaseOrderType;
  currency: string;
  /** PKR per 1 unit, from Finance's rate on the PO date, set at submit (indicative: chooses the approval band). */
  exchangeRate: string | null;
  incoterm: Incoterm | null;
  deliveryDate: string | null;
  notes: string | null;
  totalAmount: string;
  /** totalAmount × exchangeRate, once submitted. */
  totalPkr: string | null;
  status: PurchaseOrderStatus;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  submittedBy: string | null;
  submittedAt: string | null;
  /** Latest approval of this PO (link to the approval screen). */
  approvalId: string | null;
  lines: PoLineDto[];
}
