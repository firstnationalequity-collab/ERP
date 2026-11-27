// QC sample queue, sampling, results and review API (/api/v1/qc/samples): requests (Zod) and responses (DTOs).
// M4 task 2. Rules mirror apps/api/src/db/migrations/0035 (SAMPLE_ISSUE) and 0036. Quantities and values travel as
// decimal strings (rule 10).
import { z } from 'zod';
import { LotStatus, QcResultType, SampleRequestStatus } from '../../enums';
import { ESignRequest } from '../core/esign';
import type { SpecTestDto } from './specs';
import type { OosRefDto } from './oos';

const id = z.string().regex(/^\d+$/, 'Invalid id');
const optText = (max: number) => z.string().trim().max(max).nullable().optional();

/** A quantity NUMERIC(18,4) > 0. */
const positiveQty = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'Quantity: a number with up to 4 decimals')
  .refine((v) => !/^0*(\.0*)?$/.test(v), 'Quantity must be greater than zero');

/** A numeric result NUMERIC(18,6): may be negative. */
export const resultValue = z
  .string()
  .trim()
  .regex(/^-?\d{1,12}(\.\d{1,6})?$/, 'Result: a number with up to 12 digits and 6 decimals');

export const SampleListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(100).optional(),
  status: z.enum(SampleRequestStatus).optional(),
  /** SAMPLED requests with results not yet reviewed (the review queue). */
  toReview: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
export type SampleListQuery = z.infer<typeof SampleListQuery>;

/**
 * Take the sample (owner 2026-11-27): the test quantity, and any retention / reserve quantity, leave the lot at this
 * location as SAMPLE_ISSUE movements; the lot becomes UNDER_TEST. Dated today (company time zone).
 */
export const TakeSampleRequest = z
  .object({
    locationId: id,
    testQty: positiveQty,
    retentionQty: positiveQty.nullable().optional(),
    notes: optText(1000),
  })
  .strict();
export type TakeSampleRequest = z.infer<typeof TakeSampleRequest>;

export const ResultInput = z
  .object({
    specTestId: id,
    /** NUMERIC tests. */
    numericValue: resultValue.nullable().optional(),
    /** TEXT tests: what was observed, and whether it complies with the text limit (the analyst judges). */
    textValue: optText(500),
    complies: z.boolean().nullable().optional(),
    remarks: optText(1000),
  })
  .strict();
export type ResultInput = z.infer<typeof ResultInput>;

export const EnterResultsRequest = z.object({ results: z.array(ResultInput).min(1).max(100) }).strict();
export type EnterResultsRequest = z.infer<typeof EnterResultsRequest>;

/**
 * Re-test (M4 task 4; 0039): a NEW result for the same test of the same sample, repeating the test's latest result
 * (which is never edited). `reason` says why (10–500 characters). Values as in ResultInput.
 */
export const RetestResultRequest = z
  .object({
    numericValue: resultValue.nullable().optional(),
    textValue: optText(500),
    complies: z.boolean().nullable().optional(),
    remarks: optText(1000),
    reason: z.string().trim().min(10, 'Say why the test is repeated (at least 10 characters)').max(500),
  })
  .strict();
export type RetestResultRequest = z.infer<typeof RetestResultRequest>;

/** Review every result of the sample not yet reviewed (or the ones named), with one REVIEWED e-signature. */
export const ReviewResultsRequest = z.object({ resultIds: z.array(id).min(1).max(100).optional(), signature: ESignRequest }).strict();
export type ReviewResultsRequest = z.infer<typeof ReviewResultsRequest>;

export interface SampleLocationDto {
  locationId: string;
  locationCode: string;
  qty: string;
}

export interface ResultDto {
  id: string;
  specTestId: string;
  resultType: QcResultType;
  numericValue: string | null;
  textValue: string | null;
  passed: boolean;
  remarks: string | null;
  enteredBy: string;
  enteredAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  /** Re-test rows (0039): the result this one repeats, and why. */
  retestOf: string | null;
  retestReason: string | null;
  /** A newer re-test of this test exists: this row is no longer the test's latest result. */
  superseded: boolean;
  /** 0040: the OOS investigation of this (failed, reviewed) result; invalidated = closed as INVALIDATED. */
  oos: OosRefDto | null;
  invalidated: boolean;
  /** A re-test of a failed result: the OOS investigation that invalidated the original. */
  retestOos: OosRefDto | null;
  /** This row may be re-tested now: it is the test's latest and either passed or was invalidated by its OOS. */
  canRetest: boolean;
}

export interface SampleRequestDto {
  id: string;
  status: SampleRequestStatus;
  refDocType: string;
  refDocId: string;
  requestedAt: string;
  lotId: string;
  lotNo: string;
  lotStatus: LotStatus;
  itemId: string;
  itemCode: string;
  itemName: string;
  itemType: string;
  expiryDate: string | null;
  retestDate: string | null;
  specId: string | null;
  specVersion: number | null;
  sampledBy: string | null;
  sampledAt: string | null;
  sampleLocationId: string | null;
  testQty: string | null;
  retentionQty: string | null;
  sampleNotes: string | null;
  /** Results entered (all rows) / tests whose latest result failed / results not yet reviewed. */
  resultCount: number;
  failedCount: number;
  unreviewedCount: number;
  /** Display names of sampledBy and of every analyst / reviewer on the results. */
  userNames: Record<string, string>;
  /** Detail only: the pinned spec's tests (or the current APPROVED spec's while OPEN), results, and where the lot holds stock. */
  tests?: SpecTestDto[];
  results?: ResultDto[];
  locations?: SampleLocationDto[];
}
