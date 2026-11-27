// Approvals (docs/architecture.md §3; decisions Q12, Q13). Approve/reject are e-signatures (rule 8).
import { z } from 'zod';
import { ApprovalMeasure, type ApprovalStatus, type ApprovalStepStatus } from '../../enums';
import type { PermissionKey } from '../../permissions';
import { ESignRequest, WitnessSignRequest } from './esign';
import type { AttachmentDto } from './attachments';

/**
 * GMP document types whose approvers are fixed in code (rules review B, option 2): every approver role
 * must hold the given key, so nobody can re-route a QC/QA decision through the approval matrix.
 * Add each future QC/QA document type here when its module is built.
 * BATCH_CLOSE follows architecture §4 (Production Manager approves the close; QA releases afterwards).
 */
export const GmpLockedApprovals: Readonly<Record<string, PermissionKey>> = {
  AVL: 'master.avl.approve',
  MASTER_FORMULA: 'master.formula.approve',
  BATCH_CLOSE: 'prod.batch.approve_close',
};

/** Key a Finance Manager countersign needs for any other approval-matrix change (rules review B, option 1). */
export const APPROVAL_MATRIX_COUNTERSIGN_KEY: PermissionKey = 'fin.approval_rules.countersign';

/** Decimal as a string ("500000.00"): money and percents never travel as JS numbers. */
const decimal = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/, 'Decimal number with up to 4 decimals');
const id = z.string().regex(/^\d+$/, 'Invalid id');

/**
 * `acknowledgements`: warnings the approver has read and accepts, by code, when the document raises one (e.g.
 * FILER_CHECK_STALE on a vendor payment, owner 2026-11-26); without it the approval is refused (ACKNOWLEDGEMENT_REQUIRED).
 */
export const ApprovalDecisionRequest = z
  .object({ signature: ESignRequest, acknowledgements: z.array(z.string().trim().regex(/^[A-Z_]{3,40}$/)).max(10).optional() })
  .strict();
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
    /** Finance Manager countersign; required for every doc type not in GmpLockedApprovals. */
    countersign: WitnessSignRequest.optional(),
  })
  .strict();
export type SetApprovalRulesRequest = z.infer<typeof SetApprovalRulesRequest>;

export interface ApprovalRuleSetDto {
  docType: string;
  measure: ApprovalMeasure;
  /** Set for GMP-locked doc types: every approver role must hold this key. */
  lockedToKey: PermissionKey | null;
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
  /** Files attached to the document (e.g. AVL evidence), shown on the e-signature screen. Empty if the
   *  document type takes no attachments or the viewer lacks its read key. */
  attachments: AttachmentDto[];
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
