// Drizzle description of the `inv` schema. Source of truth: src/db/migrations/0014_inventory.sql (+ 0015–0018).
// Only the inventory engine (engines/inventory) writes these tables; balances are kept by the ledger trigger.
import { date, numeric, pgSchema, text } from 'drizzle-orm/pg-core';
import type { LotSource, LotStatus, StockMovementType, StockOwner } from '@albert/shared';
import { auditColumns, bigintString, companyId, identityId, tstz } from './columns';

export const inv = pgSchema('inv');

export const lots = inv.table('lots', {
  id: identityId(),
  companyId: companyId(),
  itemId: bigintString('item_id').notNull(),
  lotNo: text('lot_no').notNull(),
  mfrBatchNo: text('mfr_batch_no'),
  manufacturer: text('manufacturer'),
  mfgDate: date('mfg_date', { mode: 'string' }),
  expiryDate: date('expiry_date', { mode: 'string' }),
  retestDate: date('retest_date', { mode: 'string' }),
  assayPct: numeric('assay_pct', { precision: 9, scale: 4 }),
  waterPct: numeric('water_pct', { precision: 9, scale: 4 }),
  status: text('status').$type<LotStatus>().notNull(),
  ownerType: text('owner_type').$type<StockOwner>().notNull().default('OWN'),
  ownerCustomerId: bigintString('owner_customer_id'),
  /** Lot-actual cost per base unit (decision M2 Q2); always 0 for customer-owned stock (rule 12). */
  unitCost: numeric('unit_cost', { precision: 18, scale: 6 }).notNull().default('0'),
  /** GRN, PRODUCTION_OUTPUT or SALES_RETURN (0017); never changes. */
  source: text('source').$type<LotSource>().notNull(),
  /** SALES_RETURN lots only: the original lot (0017). */
  parentLotId: bigintString('parent_lot_id'),
  /** PRODUCTION_OUTPUT lots: set by the batch close; dispatch waits for it (owner 2026-11-18, Q8). */
  batchClosedAt: tstz('batch_closed_at'),
  ...auditColumns(),
});

/** Immutable stock ledger: insert only. One location per row; qty and value signed (+ in, − out). */
export const stockMovements = inv.table('stock_movements', {
  id: identityId(),
  companyId: companyId(),
  movementType: text('movement_type').$type<StockMovementType>().notNull(),
  movementDate: date('movement_date', { mode: 'string' }).notNull(),
  lotId: bigintString('lot_id').notNull(),
  fromLocationId: bigintString('from_location_id'),
  toLocationId: bigintString('to_location_id'),
  qty: numeric('qty', { precision: 18, scale: 4 }).notNull(),
  unitCost: numeric('unit_cost', { precision: 18, scale: 6 }).notNull(),
  value: numeric('value', { precision: 18, scale: 2 }).notNull(),
  refDocType: text('ref_doc_type').notNull(),
  refDocId: bigintString('ref_doc_id').notNull(),
  reasonCode: text('reason_code'),
  reversalOf: bigintString('reversal_of'),
  /** DISPATCH / SALES_RETURN only (required there): the customer the goods went to or came back from (0018). */
  customerId: bigintString('customer_id'),
  /** DESTROY / RETURN_TO_VENDOR only, required there: the QA witness e-signature (0020). */
  witnessEsignId: bigintString('witness_esign_id'),
  postedAt: tstz('posted_at').notNull().defaultNow(),
  ...auditColumns(),
});

/** Kept by the ledger trigger (inv.apply_stock_movement); never written by the application. */
export const stockBalances = inv.table('stock_balances', {
  id: identityId(),
  companyId: companyId(),
  lotId: bigintString('lot_id').notNull(),
  locationId: bigintString('location_id').notNull(),
  qty: numeric('qty', { precision: 18, scale: 4 }).notNull().default('0'),
  ...auditColumns(),
});

/** Quantity held for a document line; open while qty > 0 (no status column). */
export const stockReservations = inv.table('stock_reservations', {
  id: identityId(),
  companyId: companyId(),
  lotId: bigintString('lot_id').notNull(),
  qty: numeric('qty', { precision: 18, scale: 4 }).notNull(),
  refDocType: text('ref_doc_type').notNull(),
  refDocId: bigintString('ref_doc_id').notNull(),
  ...auditColumns(),
});
