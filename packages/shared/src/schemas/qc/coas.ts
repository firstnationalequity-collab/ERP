// Certificates of analysis API (/api/v1/qc/coas): requests (Zod) and responses (DTOs). M4 task 4; rules mirror
// apps/api/src/db/migrations/0039_qc_retest_coa.sql. A holder of qc.coa.issue issues one certificate per QC approval of
// a material lot (its latest disposition, the lot APPROVED now) with an e-signature (meaning APPROVED); the PDF is
// stored with its SHA-256 and re-checked on every download. Finished-goods certificates follow QA release (M7).
import { z } from 'zod';
import type { CoaVersionStatus } from '../../enums';
import { ESignRequest } from '../core/esign';

export const CoaListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(100).optional(),
});
export type CoaListQuery = z.infer<typeof CoaListQuery>;

/** Issue the certificate for the lot's current QC approval. */
export const IssueCoaRequest = z.object({ lotId: z.string().regex(/^\d+$/, 'Invalid id'), signature: ESignRequest }).strict();
export type IssueCoaRequest = z.infer<typeof IssueCoaRequest>;

/**
 * Correct a certificate (owner 2026-11-27; 0040): a new version of the same number, signed (meaning APPROVED) by a
 * holder of qc.coa.issue; the signature's reason is the re-issue reason. The previous version becomes SUPERSEDED.
 */
export const ReissueCoaRequest = z.object({ signature: ESignRequest }).strict();
export type ReissueCoaRequest = z.infer<typeof ReissueCoaRequest>;

export interface CoaDto {
  id: string;
  docNo: string;
  /** 0040: version 1 is the first issue; a re-issue is the next version of the same number. */
  version: number;
  status: CoaVersionStatus;
  supersedesId: string | null;
  supersededById: string | null;
  reissueReason: string | null;
  lotId: string;
  lotNo: string;
  itemCode: string;
  itemName: string;
  dispositionId: string;
  sampleRequestId: string;
  fileName: string;
  sha256: string;
  /** The stored PDF (download through /qc/coas/:id/pdf). */
  attachmentId: string | null;
  issuedBy: string;
  issuedByName: string;
  issuedAt: string;
}

/** An APPROVED material lot whose current QC approval has no certificate yet. */
export interface CoaCandidateDto {
  lotId: string;
  lotNo: string;
  itemCode: string;
  itemName: string;
  dispositionId: string;
  approvedAt: string;
  approvedByName: string;
}
