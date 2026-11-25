// Drizzle description of the `qc` schema. Source of truth: src/db/migrations/0027_grn.sql (M3 stub; M4 extends).
import { pgSchema, text } from 'drizzle-orm/pg-core';
import type { SampleRequestStatus } from '@albert/shared';
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
