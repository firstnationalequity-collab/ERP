// Drizzle description of the `qc` schema. Source of truth: src/db/migrations/0027_grn.sql (sample requests), 0034 (specs).
import { boolean, integer, numeric, pgSchema, text } from 'drizzle-orm/pg-core';
import type { QcResultType, QcSpecStatus, SampleRequestStatus } from '@albert/shared';
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
