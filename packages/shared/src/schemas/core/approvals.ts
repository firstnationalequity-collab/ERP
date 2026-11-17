// Approvals (docs/architecture.md §3; decisions Q12, Q13). Approve/reject are e-signatures (rule 8).
import { z } from 'zod';
import { ApprovalMeasure, type ApprovalStatus, type ApprovalStepStatus } from '../../enums';
import { ESignRequest } from './esign';

/** Decimal as a string ("500000.00"): money and percents never travel as JS numbers. */
const decimal = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/, 'Decimal number with up to 4 decimals');
const id = z.string().regex(/^\d+$/, 'Invalid id');

export const ApprovalDecisionRequest = z.object({ signature: ESignRequest }).strict();
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequest>;

export const ApprovalBand = z
  .object({
    /** Exclusive lower limit; omit for "up to". */
    lowerBound: decimal.nullable().optional(),
    /** Inclusive upper limit; omit for "above". */
    upperBound: decimal.nullable().optional(),
    /** One entry per step. Same stepNo = parallel ("and"); higher stepNo = after ("then"). */
    steps: z.array(z.object({ stepNo: z.number().int().min(1).max(9), roleId: id }).strict()).min(1).max(9),
  })
  .strict();
export type ApprovalBand = z.infer<typeof ApprovalBand>;

/** Replace the whole rule set of one document type. Pending approvals keep the steps they started with. */
export const SetApprovalRulesRequest = z
  .object({
    measure: z.enum(ApprovalMeasure),
    bands: z.array(ApprovalBand).min(1).max(20),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type SetApprovalRulesRequest = z.infer<typeof SetApprovalRulesRequest>;

export interface ApprovalRuleSetDto {
  docType: string;
  measure: ApprovalMeasure;
  bands: {
    lowerBound: string | null;
    upperBound: string | null;
    steps: { stepNo: number; roleId: string; roleCode: string; roleName: string }[];
  }[];
}

export interface ApprovalStepDto {
  id: string;
  stepNo: number;
  roleCode: string;
  roleName: string;
  status: ApprovalStepStatus;
  actedBy: string | null;
  actedAt: string | null;
}

export interface ApprovalDto {
  id: string;
  docType: string;
  docTable: string;
  docId: string;
  docNo: string | null;
  measure: ApprovalMeasure;
  amount: string | null;
  currency: string | null;
  exchangeRate: string | null;
  measuredValue: string | null;
  requestedBy: { id: string; username: string; fullName: string };
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
  steps: ApprovalStepDto[];
}

/** One line in "my approvals". */
export interface InboxItemDto {
  approvalId: string;
  stepId: string;
  stepNo: number;
  roleCode: string;
  docType: string;
  docNo: string | null;
  docId: string;
  measure: ApprovalMeasure;
  measuredValue: string | null;
  amount: string | null;
  currency: string | null;
  requestedBy: string;
  requestedAt: string;
}
