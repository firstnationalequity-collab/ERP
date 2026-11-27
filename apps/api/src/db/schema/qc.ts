// Drizzle description of the `qc` schema. Source of truth: src/db/migrations/0027_grn.sql (sample requests), 0034 (specs),
// 0036 (sampling, results, reviews), 0037 (dispositions), 0038 (rejection without a failed test).
import { sql } from 'drizzle-orm';
import { boolean, date, integer, numeric, pgSchema, text } from 'drizzle-orm/pg-core';
import type { QcRejectCategory, QcResultType, QcSpecStatus, SampleRequestStatus } from '@albert/shared';
import { auditColumns, bigintString, companyId, identityId, tstz } from './columns';

export const qc = pgSchema('qc');

export const sampleRequests = qc.table('sample_requests', {
  id: identityId(),
  companyId: companyId(),
  lotId: bigintString('lot_id').notNull(),
  refDocType: text('ref_doc_type').notNull(),
  refDocId: bigintString('ref_doc_id').notNull(),
  requestedAt: tstz('requested_at').notNull().defaultNow(),
  status: text('status').$type<SampleRequestStatus>().notNull(),
  // 0036: the sampling record (set once, OPEN → SAMPLED).
  specId: bigintString('spec_id'),
  sampledBy: bigintString('sampled_by'),
  sampledAt: tstz('sampled_at'),
  sampleLocationId: bigintString('sample_location_id'),
  testQty: numeric('test_qty', { precision: 18, scale: 4 }),
  retentionQty: numeric('retention_qty', { precision: 18, scale: 4 }),
  sampleNotes: text('sample_notes'),
  ...auditColumns(),
});

/** 0036: insert-only; pass is computed from the pinned limits (NUMERIC) or the analyst's judgement (TEXT). */
export const results = qc.table('results', {
  id: identityId(),
  companyId: companyId(),
  sampleRequestId: bigintString('sample_request_id').notNull(),
  specTestId: bigintString('spec_test_id').notNull(),
  resultType: text('result_type').$type<QcResultType>().notNull(),
  numericValue: numeric('numeric_value', { precision: 18, scale: 6 }),
  textValue: text('text_value'),
  passed: boolean('passed').notNull(),
  remarks: text('remarks'),
  enteredBy: bigintString('entered_by').notNull().default(sql`core.current_user_id()`),
  enteredAt: tstz('entered_at').notNull().defaultNow(),
  ...auditColumns(),
});

/** 0036: insert-only; reviewer ≠ analyst, REVIEWED e-signature on the sample request. */
export const resultReviews = qc.table('result_reviews', {
  id: identityId(),
  companyId: companyId(),
  resultId: bigintString('result_id').notNull(),
  reviewedBy: bigintString('reviewed_by').notNull().default(sql`core.current_user_id()`),
  reviewedAt: tstz('reviewed_at').notNull().defaultNow(),
  esignId: bigintString('esign_id').notNull(),
  ...auditColumns(),
});

export const specs = qc.table('specs', {
  id: identityId(),
  companyId: companyId(),
  itemId: bigintString('item_id').notNull(),
  version: integer('version').notNull(),
  reference: text('reference'),
  notes: text('notes'),
  status: text('status').$type<QcSpecStatus>().notNull(),
  submittedBy: bigintString('submitted_by'),
  approvedBy: bigintString('approved_by'),
  approvedAt: tstz('approved_at'),
  approvalEsignId: bigintString('approval_esign_id'),
  ...auditColumns(),
});

export const specTests = qc.table('spec_tests', {
  id: identityId(),
  companyId: companyId(),
  specId: bigintString('spec_id').notNull(),
  seq: integer('seq').notNull(),
  name: text('name').notNull(),
  method: text('method'),
  resultType: text('result_type').$type<QcResultType>().notNull(),
  minValue: numeric('min_value', { precision: 18, scale: 6 }),
  maxValue: numeric('max_value', { precision: 18, scale: 6 }),
  textLimit: text('text_limit'),
  unit: text('unit'),
  isAssay: boolean('is_assay').notNull().default(false),
  isWater: boolean('is_water').notNull().default(false),
  ...auditColumns(),
});

/** 0037: insert-only; the QC Manager's APPROVED / REJECTED decision on a lot, with their e-signature on the lot. */
export const dispositions = qc.table('dispositions', {
  id: identityId(),
  companyId: companyId(),
  lotId: bigintString('lot_id').notNull(),
  sampleRequestId: bigintString('sample_request_id'),
  fromStatus: text('from_status').$type<'QUARANTINE' | 'UNDER_TEST' | 'HOLD'>().notNull(),
  decision: text('decision').$type<'APPROVED' | 'REJECTED'>().notNull(),
  assayPct: numeric('assay_pct', { precision: 9, scale: 4 }),
  waterPct: numeric('water_pct', { precision: 9, scale: 4 }),
  retestDate: date('retest_date', { mode: 'string' }),
  reason: text('reason').notNull(),
  rejectCategory: text('reject_category').$type<QcRejectCategory>(),
  rejectDescription: text('reject_description'),
  esignId: bigintString('esign_id').notNull(),
  decidedBy: bigintString('decided_by').notNull().default(sql`core.current_user_id()`),
  decidedAt: tstz('decided_at').notNull().defaultNow(),
  ...auditColumns(),
});
