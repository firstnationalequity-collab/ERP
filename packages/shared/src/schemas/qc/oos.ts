// OOS investigations API (/api/v1/qc/oos): requests (Zod) and responses (DTOs). M4 task 4b (owner 2026-11-27); rules
// mirror apps/api/src/db/migrations/0040_qc_oos_coa_versions.sql. An investigation opens automatically when a failed
// result is reviewed; a holder of qc.oos.close (QC Manager), never the analyst of the failed result, closes it with an
// e-signature (meaning APPROVED; the reason is the conclusion) as INVALIDATED (assignable cause) or CONFIRMED.
import { z } from 'zod';
import { OosCauseCategory, OosOutcome, OosStatus } from '../../enums';
import { ESignRequest } from '../core/esign';

export const OosListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  status: z.enum(OosStatus).optional(),
  /** OOS number, lot number, or the item's code / name. */
  search: z.string().trim().max(100).optional(),
  lotId: z.string().regex(/^\d+$/, 'Invalid id').optional(),
});
export type OosListQuery = z.infer<typeof OosListQuery>;

/** Close the investigation. INVALIDATED needs the assignable cause (category + description). */
export const CloseOosRequest = z
  .object({
    outcome: z.enum(OosOutcome),
    causeCategory: z.enum(OosCauseCategory).optional(),
    causeDescription: z.string().trim().min(10, 'Describe the investigation findings (at least 10 characters)').max(2000).optional(),
    signature: ESignRequest,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.outcome === 'INVALIDATED') {
      if (!v.causeCategory) ctx.addIssue({ code: 'custom', path: ['causeCategory'], message: 'An invalidated result names its assignable cause' });
      if (!v.causeDescription) ctx.addIssue({ code: 'custom', path: ['causeDescription'], message: 'Describe the assignable cause' });
    } else if (v.causeCategory) {
      ctx.addIssue({ code: 'custom', path: ['causeCategory'], message: 'A confirmed failure has no assignable cause category' });
    }
  });
export type CloseOosRequest = z.infer<typeof CloseOosRequest>;

/** The OOS investigation of a result, as shown next to it. */
export interface OosRefDto {
  id: string;
  docNo: string;
  status: OosStatus;
  outcome: OosOutcome | null;
}

export interface OosDto extends OosRefDto {
  resultId: string;
  sampleRequestId: string;
  lotId: string;
  lotNo: string;
  lotStatus: string;
  itemCode: string;
  itemName: string;
  itemType: string;
  specTestId: string;
  testName: string;
  limit: string;
  /** The failed result (value as entered) and who entered it (the analyst never closes the investigation). */
  resultValue: string | null;
  resultRemarks: string | null;
  enteredBy: string;
  enteredByName: string;
  enteredAt: string;
  openedBy: string;
  openedByName: string;
  openedAt: string;
  causeCategory: OosCauseCategory | null;
  causeDescription: string | null;
  conclusion: string | null;
  closedBy: string | null;
  closedByName: string | null;
  closedAt: string | null;
  /** The re-test of the result, once entered (INVALIDATED only). */
  retestResultId: string | null;
  /** The signed-in user may close it (holds qc.oos.close and did not enter the result). */
  canClose: boolean;
}
