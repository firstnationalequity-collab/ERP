// Landed cost (/api/v1/purch/landed-costs, /api/v1/purch/landed-cost-types). M3 task 4; 0029_landed_cost.sql;
// architecture §6 "Landed cost" (owner Q21, 2026-11-19) and decisions Q2/Q3 (2026-11-25).
// A charge is entered on one GRN. On a DRAFT GRN it is rolled into the lot cost when the GRN is posted; on a
// POSTED GRN it is a later bill, posted on its own date (POST /:id/post). Amounts are PKR decimal strings (rule 10).
import { z } from 'zod';
import { LandedCostBasis, LandedCostTaxRole, type LandedCostStatus } from '../../enums';
import { decimalString } from '../master/masters';
import { ESignRequest } from '../core/esign';

const id = z.string().regex(/^\d+$/, 'Invalid id');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date: YYYY-MM-DD');
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const amount = decimalString(16, 2, 'Amount').refine((v) => /[1-9]/.test(v), 'Amount must be above zero');
const typeCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/, 'Code: capital letters, digits and - _ only');
const name = z.string().trim().min(1, 'Name is required').max(200);

// ---------------------------------------------------------------- charge types (fin.master.manage)

/**
 * A capitalised type (duties, freight, insurance, clearing) goes into the lot cost and takes a default basis; a
 * type that is not capitalised names its tax role (INPUT_TAX: import-stage sales tax; ADVANCE_TAX: income tax at
 * import). Only a duty may use GD_AMOUNTS, and a duty does not use WEIGHT (owner Q21).
 */
export const CreateLandedCostTypeRequest = z
  .object({
    code: typeCode,
    name,
    capitalise: z.boolean(),
    taxRole: z.enum(LandedCostTaxRole).nullable().optional(),
    isDuty: z.boolean().default(false),
    defaultBasis: z.enum(LandedCostBasis).nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.capitalise && v.taxRole) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['taxRole'], message: 'A capitalised charge has no tax role' });
    if (!v.capitalise && !v.taxRole) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['taxRole'], message: 'Pick the tax account role' });
    if (v.capitalise && !v.defaultBasis) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultBasis'], message: 'Pick the default basis' });
    if (!v.capitalise && (v.isDuty || v.defaultBasis)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultBasis'], message: 'A tax charge is not allocated (no duty flag, no basis)' });
    }
    if (v.defaultBasis === 'GD_AMOUNTS' && !v.isDuty) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultBasis'], message: 'Only a duty uses GD amounts' });
    if (v.defaultBasis === 'WEIGHT' && v.isDuty) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultBasis'], message: 'A duty is allocated by GD amounts or value' });
  });
export type CreateLandedCostTypeRequest = z.infer<typeof CreateLandedCostTypeRequest>;

/** Name and default basis; the capitalise flag, tax role and duty flag are fixed at creation. */
export const UpdateLandedCostTypeRequest = z.object({ name: name.optional(), defaultBasis: z.enum(LandedCostBasis).optional() }).strict();
export type UpdateLandedCostTypeRequest = z.infer<typeof UpdateLandedCostTypeRequest>;

export interface LandedCostTypeDto {
  id: string;
  code: string;
  name: string;
  capitalise: boolean;
  taxRole: LandedCostTaxRole | null;
  isDuty: boolean;
  defaultBasis: LandedCostBasis | null;
  isActive: boolean;
}

// ---------------------------------------------------------------- charges (purch.landed_cost.manage)

/** Per PO line of the GRN: the GD amount (basis GD_AMOUNTS) or the weight in kg (basis WEIGHT). */
const chargeInput = z
  .object({
    poLineId: id,
    gdAmount: decimalString(16, 2, 'GD amount').nullable().optional(),
    weightKg: decimalString(14, 4, 'Weight').nullable().optional(),
  })
  .strict();
export type LandedCostInputDto = z.infer<typeof chargeInput>;

const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Currency: 3-letter ISO code');

const chargeFields = {
  chargeTypeId: id,
  /** Owner 2026-11-25 (4b): a charge carries a currency; non-PKR converts at Finance's rate for the charge date. */
  currency: currency.default('PKR'),
  /** Bill / GD date. A later bill posts on this date (open period); a charge entered with a DRAFT GRN posts with it. */
  chargeDate: isoDate,
  amount,
  /** Capitalised types only; default: the type's default basis. */
  basis: z.enum(LandedCostBasis).nullable().optional(),
  /** Who bills it (customs, forwarder, clearing agent): put on the clearing line. */
  vendorId: id.nullable().optional(),
  reference: optText(60),
  notes: optText(1000),
  inputs: z.array(chargeInput).max(999).default([]),
};

export const CreateLandedCostRequest = z.object({ grnId: id, ...chargeFields }).strict();
export type CreateLandedCostRequest = z.infer<typeof CreateLandedCostRequest>;

/** Replaces the whole DRAFT (the GRN stays the same). */
export const UpdateLandedCostRequest = z.object(chargeFields).strict();
export type UpdateLandedCostRequest = z.infer<typeof UpdateLandedCostRequest>;

/**
 * Correction (owner 2026-11-25, 4b): a new document with a negative amount (in the original's currency), linked to
 * the original and allocated like it. Entered under purch.landed_cost.manage; a Finance Manager posts it (/approve).
 */
export const CreateLandedCostCorrectionRequest = z
  .object({
    chargeDate: isoDate,
    amount: z.string().trim().regex(/^-\d{1,16}(\.\d{1,2})?$/, 'A correction amount is below zero, up to 16 digits and 2 decimals').refine((v) => /[1-9]/.test(v), 'A correction amount is below zero'),
    reason: z.string().trim().min(3, 'Give the reason for the correction (at least 3 characters)').max(500),
    reference: optText(60),
  })
  .strict();
export type CreateLandedCostCorrectionRequest = z.infer<typeof CreateLandedCostCorrectionRequest>;

/** The Finance Manager posts a correction with their own e-signature (meaning APPROVED). */
export const ApproveLandedCostCorrectionRequest = z.object({ signature: ESignRequest }).strict();
export type ApproveLandedCostCorrectionRequest = z.infer<typeof ApproveLandedCostCorrectionRequest>;

export const LandedCostListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(100).optional(),
  status: z.string().trim().max(30).optional(),
  grnId: id.optional(),
});
export type LandedCostListQuery = z.infer<typeof LandedCostListQuery>;

export interface LandedCostAllocationDto {
  grnLineId: string;
  lineNo: number;
  itemCode: string;
  lotId: string;
  lotNo: string;
  amount: string;
  /** What the lot still held at posting. */
  heldQty: string;
  /** Into the lot's value (value-only adjustment). */
  heldAmount: string;
  /** The consumed share: to price variance. */
  varianceAmount: string;
}

export interface LandedCostDto {
  id: string;
  docNo: string;
  grnId: string;
  grnDocNo: string;
  grnStatus: string;
  chargeTypeId: string;
  chargeTypeCode: string;
  chargeTypeName: string;
  capitalise: boolean;
  chargeDate: string;
  /** PKR amount (foreign amount × rate, 2 decimals). */
  amount: string;
  currency: string;
  foreignAmount: string;
  exchangeRate: string;
  exchangeRateDate: string;
  /** A correction: the original it corrects, and why. */
  correctionOfId: string | null;
  correctionOfDocNo: string | null;
  correctionReason: string | null;
  corrections: { id: string; docNo: string; status: LandedCostStatus; foreignAmount: string; amount: string }[];
  basis: LandedCostBasis | null;
  vendorId: string | null;
  vendorName: string | null;
  reference: string | null;
  notes: string | null;
  /** Entered while the GRN was DRAFT: posted with it, into the receipt cost. */
  withGrn: boolean;
  status: LandedCostStatus;
  postingDate: string | null;
  postedByName: string | null;
  postedAt: string | null;
  journalDocNo: string | null;
  createdByName: string;
  createdAt: string;
  inputs: { poLineId: string; poLineNo: number; itemCode: string; gdAmount: string | null; weightKg: string | null }[];
  allocations: LandedCostAllocationDto[];
}
