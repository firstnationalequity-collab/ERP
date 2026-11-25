// Goods received notes (/api/v1/purch/grns). M3 task 3; 0027_grn.sql; architecture §6 "GRN posted", §7.5.
// A DRAFT GRN receives lines of one APPROVED / PARTIALLY_RECEIVED PO; posting (POST /:id/post) creates the lots in
// QUARANTINE, the receipt movements and journal, and a QC sample request per lot. PATCH edits a DRAFT only.
// Quantities and rates travel as decimal strings, never JS numbers (rule 10).
import { z } from 'zod';
import type { GrnStatus, SampleRequestStatus } from '../../enums';
import { ESignRequest } from '../core/esign';
import { decimalString } from '../master/masters';

const id = z.string().regex(/^\d+$/, 'Invalid id');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date: YYYY-MM-DD');
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const optDate = isoDate.nullable().optional();
/** Quantity NUMERIC(18,4), above zero. */
const qty = decimalString(14, 4, 'Quantity').refine((v) => /[1-9]/.test(v), 'Quantity must be above zero');

const grnLine = z
  .object({
    poLineId: id,
    qty,
    /** Number of containers (drums, bags, boxes): one label each. */
    containers: z.number().int().min(1, 'At least 1 container').max(999).default(1),
    /** GMP materials (RM, PM, API, EXCIPIENT): the APPROVED source (manufacturer + site) the goods come from. */
    approvedSourceId: id.nullable().optional(),
    /** Other items: the manufacturer, if known (a GMP line takes it from its source). */
    manufacturer: optText(200),
    manufacturingSite: optText(200),
    mfrBatchNo: optText(60),
    mfgDate: optDate,
    expiryDate: optDate,
    retestDate: optDate,
    notes: optText(500),
  })
  .strict();
export type GrnLineInput = z.infer<typeof grnLine>;

const grnHeader = {
  grnDate: isoDate,
  /** Where the goods are put (a quarantine area). */
  locationId: id,
  deliveryNoteNo: optText(60),
  notes: optText(1000),
  lines: z.array(grnLine).min(1, 'Add at least one line').max(999),
};

export const CreateGrnRequest = z.object({ poId: id, ...grnHeader }).strict();
export type CreateGrnRequest = z.infer<typeof CreateGrnRequest>;

/** Replaces the whole DRAFT (header and lines); the PO stays the same. */
export const UpdateGrnRequest = z.object(grnHeader).strict();
export type UpdateGrnRequest = z.infer<typeof UpdateGrnRequest>;

/**
 * Reverse a POSTED GRN (owner 2026-11-25, answer 5): purch.grn.reverse (Warehouse Manager), own e-signature with
 * meaning APPROVED; the signature's reason is the reversal reason. Only while every lot is untouched.
 */
export const GrnReverseRequest = z.object({ signature: ESignRequest }).strict();
export type GrnReverseRequest = z.infer<typeof GrnReverseRequest>;

// ---------------------------------------------------------------- responses

export interface GrnSampleRequestDto {
  id: string;
  status: SampleRequestStatus;
  requestedAt: string;
}

export interface GrnLineDto {
  id: string;
  lineNo: number;
  poLineId: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  itemType: string;
  uomCode: string;
  qty: string;
  containers: number;
  /** PO price, in the PO currency (6 decimals). */
  unitPrice: string;
  /** PKR per base unit = unit price × GRN rate, 6 decimals; set at posting. */
  unitCost: string | null;
  /** PKR value received = round(qty × unit cost, 2); set at posting. */
  valuePkr: string | null;
  approvedSourceId: string | null;
  manufacturer: string | null;
  manufacturingSite: string | null;
  mfrBatchNo: string | null;
  mfgDate: string | null;
  expiryDate: string | null;
  retestDate: string | null;
  lotId: string | null;
  lotNo: string | null;
  lotStatus: string | null;
  sampleRequest: GrnSampleRequestDto | null;
  notes: string | null;
}

export interface GrnDto {
  id: string;
  docNo: string;
  grnDate: string;
  poId: string;
  poDocNo: string;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  currency: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  deliveryNoteNo: string | null;
  notes: string | null;
  /** PKR per 1 unit: Finance's latest rate on or before the GRN date, copied at posting. */
  exchangeRate: string | null;
  exchangeRateDate: string | null;
  /** Sum of the lines' PKR values, once posted. */
  totalPkr: string | null;
  status: GrnStatus;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  postedBy: string | null;
  postedByName: string | null;
  postedAt: string | null;
  /** The GRN_RECEIPT journal (SJ number), once posted. */
  journalId: string | null;
  journalDocNo: string | null;
  /** The mirror journal, once the GRN is REVERSED. */
  reversalJournalDocNo: string | null;
  lines: GrnLineDto[];
}

/** For the GRN screen: what each open line of a PO may still receive, and the APPROVED sources to pick from. */
export interface PoReceiptLineDto {
  poLineId: string;
  lineNo: number;
  itemId: string;
  itemCode: string;
  itemName: string;
  itemType: string;
  uomCode: string;
  orderedQty: string;
  receivedQty: string;
  /** ordered − received (not below 0). */
  openQty: string;
  /** ordered × (1 + tolerance) − received: the most this line may still receive. */
  maxQty: string;
  unitPrice: string;
  /** GMP material: a source must be picked. */
  needsSource: boolean;
  /** API: manufacturer batch, mfg, expiry and retest dates are required. */
  needsDates: boolean;
  sources: { id: string; manufacturer: string; manufacturingSite: string }[];
}

export interface PoReceiptDto {
  poId: string;
  poDocNo: string;
  poStatus: string;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  currency: string;
  overReceiptPct: number;
  lines: PoReceiptLineDto[];
}
