// Drizzle description of the `purch` schema. Source of truth: src/db/migrations/0023_procurement_pr_po.sql.
import { date, integer, numeric, pgSchema, text } from 'drizzle-orm/pg-core';
import type { Incoterm, PurchaseOrderStatus, PurchaseOrderType, PurchaseRequisitionStatus } from '@albert/shared';
import { auditColumns, bigintString, companyId, identityId, tstz } from './columns';

export const purch = pgSchema('purch');

export const purchaseRequisitions = purch.table('purchase_requisitions', {
  id: identityId(),
  companyId: companyId(),
  docNo: text('doc_no').notNull(),
  prDate: date('pr_date', { mode: 'string' }).notNull(),
  requiredBy: date('required_by', { mode: 'string' }),
  department: text('department'),
  notes: text('notes'),
  status: text('status').$type<PurchaseRequisitionStatus>().notNull(),
  ...auditColumns(),
});

export const prLines = purch.table('pr_lines', {
  id: identityId(),
  companyId: companyId(),
  prId: bigintString('pr_id').notNull(),
  lineNo: integer('line_no').notNull(),
  itemId: bigintString('item_id').notNull(),
  qty: numeric('qty', { precision: 18, scale: 4 }).notNull(),
  notes: text('notes'),
  ...auditColumns(),
});

export const purchaseOrders = purch.table('purchase_orders', {
  id: identityId(),
  companyId: companyId(),
  docNo: text('doc_no').notNull(),
  poDate: date('po_date', { mode: 'string' }).notNull(),
  vendorId: bigintString('vendor_id').notNull(),
  poType: text('po_type').$type<PurchaseOrderType>().notNull(),
  currency: text('currency').notNull(),
  exchangeRate: numeric('exchange_rate', { precision: 9, scale: 4 }),
  exchangeRateDate: date('exchange_rate_date', { mode: 'string' }),
  incoterm: text('incoterm').$type<Incoterm>(),
  deliveryDate: date('delivery_date', { mode: 'string' }),
  notes: text('notes'),
  totalAmount: numeric('total_amount', { precision: 18, scale: 2 }).notNull().default('0'),
  submittedBy: bigintString('submitted_by'),
  submittedAt: tstz('submitted_at'),
  status: text('status').$type<PurchaseOrderStatus>().notNull(),
  ...auditColumns(),
});

export const poLines = purch.table('po_lines', {
  id: identityId(),
  companyId: companyId(),
  poId: bigintString('po_id').notNull(),
  lineNo: integer('line_no').notNull(),
  itemId: bigintString('item_id').notNull(),
  qty: numeric('qty', { precision: 18, scale: 4 }).notNull(),
  unitPrice: numeric('unit_price', { precision: 18, scale: 6 }).notNull(),
  lineAmount: numeric('line_amount', { precision: 18, scale: 2 }).notNull(),
  receivedQty: numeric('received_qty', { precision: 18, scale: 4 }).notNull().default('0'),
  prLineId: bigintString('pr_line_id'),
  releasedPrLineId: bigintString('released_pr_line_id'),
  notes: text('notes'),
  ...auditColumns(),
});
