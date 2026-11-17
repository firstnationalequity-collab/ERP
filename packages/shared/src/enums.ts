// Single source of status values. DB CHECK constraints must list exactly these values.
// Allowed transitions live in apps/api/src/core/transition (see docs/architecture.md §4).

export const ItemType = ['RM', 'PM', 'API', 'EXCIPIENT', 'BULK', 'FG', 'SPARE', 'CONSUMABLE'] as const;
export type ItemType = (typeof ItemType)[number];

/** Item types that are GMP-regulated: PO lines need an APPROVED approved-source row. */
export const GmpItemTypes: readonly ItemType[] = ['RM', 'PM', 'API', 'EXCIPIENT'];

export const LotStatus = [
  'QUARANTINE',
  'UNDER_TEST',
  'APPROVED',
  'REJECTED',
  'HOLD',
  'RETEST_DUE',
  'EXPIRED',
  'RELEASED', // FG only, set by QA batch release
  'DESTROYED',
  'RETURNED',
] as const;
export type LotStatus = (typeof LotStatus)[number];

export const StockOwner = ['OWN', 'CUSTOMER'] as const;
export type StockOwner = (typeof StockOwner)[number];

export const BatchStatus = [
  'PLANNED',
  'RELEASED',
  'IN_PROCESS',
  'AWAITING_QA',
  'RELEASED_FOR_SALE',
  'REJECTED',
  'CANCELLED',
] as const;
export type BatchStatus = (typeof BatchStatus)[number];

export const QuotationStatus = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'LOST'] as const;
export type QuotationStatus = (typeof QuotationStatus)[number];

export const SalesOrderStatus = [
  'DRAFT',
  'ON_CREDIT_HOLD',
  'CONFIRMED',
  'PARTIALLY_DISPATCHED',
  'DISPATCHED',
  'CLOSED',
  'CANCELLED',
] as const;
export type SalesOrderStatus = (typeof SalesOrderStatus)[number];

export const PurchaseOrderStatus = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CLOSED',
  'CANCELLED',
] as const;
export type PurchaseOrderStatus = (typeof PurchaseOrderStatus)[number];

/** GRN, issue, delivery, invoice, receipt, payment, journal. */
export const PostingStatus = ['DRAFT', 'POSTED', 'REVERSED'] as const;
export type PostingStatus = (typeof PostingStatus)[number];

export const DeviationClass = ['MINOR', 'MAJOR', 'CRITICAL'] as const;
export type DeviationClass = (typeof DeviationClass)[number];

export const SignatureMeaning = ['REVIEWED', 'APPROVED', 'RELEASED', 'REJECTED', 'WITNESSED', 'PERFORMED'] as const;
export type SignatureMeaning = (typeof SignatureMeaning)[number];

export const FiscalPeriodStatus = ['OPEN', 'CLOSED'] as const;
export type FiscalPeriodStatus = (typeof FiscalPeriodStatus)[number];
