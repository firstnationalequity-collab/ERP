// Drizzle description of the `fin` schema. Source of truth: src/db/migrations/0012_finance_masters.sql.
import { sql } from 'drizzle-orm';
import { boolean, date, integer, numeric, pgSchema, text } from 'drizzle-orm/pg-core';
import type { AccountRole, AccountType, PostingEvent, PostingStatus } from '@albert/shared';
import { auditColumns, bigintString, companyId, identityId, tstz } from './columns';

export const fin = pgSchema('fin');

export const accounts = fin.table('accounts', {
  id: identityId(),
  companyId: companyId(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  type: text('type').$type<AccountType>().notNull(),
  parentId: bigintString('parent_id'),
  isPostable: boolean('is_postable').notNull().default(true),
  isPlaceholder: boolean('is_placeholder').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

export const costCenters = fin.table('cost_centers', {
  id: identityId(),
  companyId: companyId(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

export const postingRules = fin.table('posting_rules', {
  id: identityId(),
  companyId: companyId(),
  event: text('event').$type<PostingEvent>().notNull(),
  accountRole: text('account_role').$type<AccountRole>().notNull(),
  itemCategoryId: bigintString('item_category_id'),
  accountId: bigintString('account_id').notNull(),
  isPlaceholder: boolean('is_placeholder').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

export const journalEntries = fin.table('journal_entries', {
  id: identityId(),
  companyId: companyId(),
  docNo: text('doc_no').notNull(),
  entryDate: date('entry_date', { mode: 'string' }).notNull(),
  /** Set by the guard trigger from entry_date; never sent by the application. */
  periodId: bigintString('period_id').notNull().default(sql`NULL`),
  sourceType: text('source_type').notNull(),
  sourceId: bigintString('source_id'),
  event: text('event').$type<PostingEvent>(),
  narration: text('narration').notNull(),
  status: text('status').$type<PostingStatus>().notNull(),
  postedAt: tstz('posted_at'),
  postedBy: bigintString('posted_by'),
  reversalOf: bigintString('reversal_of'),
  reversalId: bigintString('reversal_id'),
  reversedAt: tstz('reversed_at'),
  reversedBy: bigintString('reversed_by'),
  ...auditColumns(),
});

export const journalLines = fin.table('journal_lines', {
  id: identityId(),
  companyId: companyId(),
  entryId: bigintString('entry_id').notNull(),
  lineNo: integer('line_no').notNull(),
  accountId: bigintString('account_id').notNull(),
  debit: numeric('debit', { precision: 18, scale: 2 }).notNull().default('0'),
  credit: numeric('credit', { precision: 18, scale: 2 }).notNull().default('0'),
  costCenterId: bigintString('cost_center_id'),
  customerId: bigintString('customer_id'),
  vendorId: bigintString('vendor_id'),
  productionOrderId: bigintString('production_order_id'),
  narration: text('narration'),
  ...auditColumns(),
});
