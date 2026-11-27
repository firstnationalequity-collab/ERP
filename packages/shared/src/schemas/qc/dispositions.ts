// QC lot disposition API (/api/v1/qc/lots): requests (Zod) and responses (DTOs). M4 task 3; rules mirror
// apps/api/src/db/migrations/0037_qc_disposition.sql. The QC Manager (qc.lot.change_status) approves or rejects a
// material lot with an e-signature on the lot; an FG lot is QA's decision. Values travel as decimal strings (rule 10).
import { z } from 'zod';
import { QcRejectCategory, type LotStatus, type QcResultType, type SampleRequestStatus } from '../../enums';
import { ESignRequest } from '../core/esign';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date: YYYY-MM-DD');

export const DispositionListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(100).optional(),
  /**
   * UNDER_TEST: sampled lots waiting for approval / rejection; HOLD: material lots QA put on hold (QC may reject);
   * QUARANTINE: lots not sampled yet (QC may reject one without a test, e.g. a damaged container; 0038). The default
   * list is UNDER_TEST and HOLD.
   */
  status: z.enum(['QUARANTINE', 'UNDER_TEST', 'HOLD']).optional(),
});
export type DispositionListQuery = z.infer<typeof DispositionListQuery>;

/**
 * UNDER_TEST → APPROVED. The e-signature meaning is APPROVED; its reason is the decision's reason. `retestDate`: the
 * next retest date, required when the lot's retest date is reached (a re-test), otherwise optional.
 */
export const ApproveLotRequest = z.object({ retestDate: isoDate.nullable().optional(), signature: ESignRequest }).strict();
export type ApproveLotRequest = z.infer<typeof ApproveLotRequest>;

/**
 * QUARANTINE / UNDER_TEST / HOLD → REJECTED. The e-signature meaning is REJECTED; its reason is the rejection reason.
 * `category` + `description`: required when no failed latest result supports the rejection (owner 2026-11-27; 0038),
 * optional otherwise (given together).
 */
export const RejectLotRequest = z
  .object({
    category: z.enum(QcRejectCategory).optional(),
    description: z.string().trim().min(10, 'Describe what was found (at least 10 characters)').max(2000).optional(),
    signature: ESignRequest,
  })
  .strict()
  .refine((v) => (v.category === undefined) === (v.description === undefined), { message: 'Give the reason category and the description together', path: ['description'] });
export type RejectLotRequest = z.infer<typeof RejectLotRequest>;

/** One test of the pinned spec with its latest result (a re-test is a newer row, task 4). */
export interface DispositionTestDto {
  specTestId: string;
  name: string;
  resultType: QcResultType;
  /** "98.0 – 102.0 %", "≤ 0.5 %" or the text limit. */
  limit: string;
  isAssay: boolean;
  isWater: boolean;
  resultId: string | null;
  value: string | null;
  passed: boolean | null;
  reviewed: boolean;
}

export interface DispositionDto {
  id: string;
  fromStatus: LotStatus;
  decision: 'APPROVED' | 'REJECTED';
  assayPct: string | null;
  waterPct: string | null;
  retestDate: string | null;
  reason: string;
  rejectCategory: QcRejectCategory | null;
  rejectDescription: string | null;
  decidedBy: string;
  decidedByName: string;
  decidedAt: string;
  sampleRequestId: string | null;
}

export interface DispositionLotDto {
  lotId: string;
  lotNo: string;
  lotStatus: LotStatus;
  itemId: string;
  itemCode: string;
  itemName: string;
  itemType: string;
  expiryDate: string | null;
  retestDate: string | null;
  assayPct: string | null;
  waterPct: string | null;
  /** The request the decision closes: SAMPLED (UNDER_TEST lots) or OPEN (QUARANTINE lots, cancelled by a rejection). */
  sampleRequestId: string | null;
  sampleStatus: SampleRequestStatus | null;
  specId: string | null;
  specVersion: number | null;
  /** Tests without a result, results not yet reviewed, tests whose latest result failed. */
  missingCount: number;
  unreviewedCount: number;
  failedCount: number;
  /** What the QC Manager may do now, and why not. */
  canApprove: boolean;
  canReject: boolean;
  blockers: string[];
  /** No failed latest result supports a rejection: rejecting needs a reason category and a description. */
  rejectNeedsCategory: boolean;
  /** The lot's retest date is reached: approving it needs the next retest date. */
  retestDateRequired: boolean;
  /** Detail only. */
  tests?: DispositionTestDto[];
  /** Assay / water the approval would write (4 decimals), detail only. */
  approvalAssayPct?: string | null;
  approvalWaterPct?: string | null;
  history?: DispositionDto[];
}
