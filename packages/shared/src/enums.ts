// Single source of status values. DB CHECK constraints must list exactly these values.
// Allowed transitions live in apps/api/src/core/transition (see docs/architecture.md §4).

export const ItemType = ['RM', 'PM', 'API', 'EXCIPIENT', 'BULK', 'FG', 'SPARE', 'CONSUMABLE'] as const;
export type ItemType = (typeof ItemType)[number];

/**
 * GMP item types (owner decision 18-11-2026, fixed by type): only a holder of master.item.approve (QA Manager)
 * activates, deactivates or reactivates them, and changing their GMP fields after DRAFT needs a QA countersign.
 * Mirrored by master.is_gmp_item_type() in 0011_item_activation.sql (a test keeps them equal).
 */
export const GmpItemTypes: readonly ItemType[] = ['RM', 'PM', 'API', 'EXCIPIENT', 'BULK', 'FG'];

/** GMP materials bought from vendors: approved sources (AVL) are kept for these, and PO lines need one. */
export const AvlItemTypes: readonly ItemType[] = ['RM', 'PM', 'API', 'EXCIPIENT'];

/** Item lifecycle: created DRAFT; ACTIVE items are usable in documents. */
export const ItemStatus = ['DRAFT', 'ACTIVE', 'INACTIVE'] as const;
export type ItemStatus = (typeof ItemStatus)[number];

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

/** Changed only through core/transition (OPEN → CLOSED → OPEN, core.period.close). */
export const FiscalPeriodStatus = ['OPEN', 'CLOSED'] as const;
export type FiscalPeriodStatus = (typeof FiscalPeriodStatus)[number];

/** What an approval band is measured on (decision Q12). NONE = one band, any value (e.g. AVL, master formula). */
export const ApprovalMeasure = ['AMOUNT_PKR', 'PERCENT', 'NONE'] as const;
export type ApprovalMeasure = (typeof ApprovalMeasure)[number];

export const ApprovalStatus = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type ApprovalStatus = (typeof ApprovalStatus)[number];

/** WAITING = a later "then" step not yet open; SKIPPED = closed because the approval was rejected/cancelled. */
export const ApprovalStepStatus = ['WAITING', 'PENDING', 'APPROVED', 'REJECTED', 'SKIPPED'] as const;
export type ApprovalStepStatus = (typeof ApprovalStepStatus)[number];

/** How a document-number series restarts (decision Q16). */
export const NumberSeriesReset = ['FISCAL_YEAR', 'CALENDAR_YEAR', 'NEVER'] as const;
export type NumberSeriesReset = (typeof NumberSeriesReset)[number];

/** core.idempotency_keys.status: claimed before the action runs, completed with the stored response. */
export const IdempotencyStatus = ['IN_PROGRESS', 'COMPLETED'] as const;
export type IdempotencyStatus = (typeof IdempotencyStatus)[number];

/** core.attachments.storage_driver (local disk now, S3-compatible in M10). */
export const StorageDriver = ['local', 's3'] as const;
export type StorageDriver = (typeof StorageDriver)[number];

/** core.audit_log.action, written by the audit trigger. */
export const AuditAction = ['INSERT', 'UPDATE', 'DELETE'] as const;
export type AuditAction = (typeof AuditAction)[number];

/** Permission key classes (docs/roles.md). A role holding an ADMIN key may never hold an ACTION key. */
export const PermissionClass = ['ADMIN', 'VIEW', 'ACTION'] as const;
export type PermissionClass = (typeof PermissionClass)[number];

/** Rows of the insert-only core.auth_events log. */
export const AuthEventType = [
  'LOGIN_OK',
  'LOGIN_FAIL',
  'LOGOUT',
  'LOCKOUT',
  'UNLOCK',
  'PASSWORD_CHANGE',
  'ESIGN_FAIL',
  'TOKEN_REUSE',
] as const;
export type AuthEventType = (typeof AuthEventType)[number];

/** Why a core.sessions row was revoked. */
export const SessionRevokeReason = ['LOGOUT', 'TOKEN_REUSE', 'PASSWORD_CHANGE', 'LOCKOUT', 'ADMIN'] as const;
export type SessionRevokeReason = (typeof SessionRevokeReason)[number];

// ---------------------------------------------------------------- masters (M2, migration 0008)

/** Customers and vendors: created DRAFT, activated by the approve key (creator ≠ activator); via core/transition. */
export const PartyStatus = ['DRAFT', 'ACTIVE', 'INACTIVE'] as const;
export type PartyStatus = (typeof PartyStatus)[number];

/** AVL row: PENDING while its AVL approval runs; APPROVED by QA Manager; BLOCKED by QA Manager; REJECTED if the approval is rejected. */
export const ApprovedSourceStatus = ['PENDING', 'APPROVED', 'REJECTED', 'BLOCKED'] as const;
export type ApprovedSourceStatus = (typeof ApprovedSourceStatus)[number];

/** Master formula version: editable only in DRAFT; one APPROVED per product; the previous APPROVED becomes OBSOLETE. */
export const FormulaStatus = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'OBSOLETE'] as const;
export type FormulaStatus = (typeof FormulaStatus)[number];

/** API formula line: potency on the as-is assay or on the dried basis (assay × (100 − water) ÷ 100). */
export const AssayBasis = ['AS_IS', 'DRIED'] as const;
export type AssayBasis = (typeof AssayBasis)[number];

/** Storage condition of an item and of a location (transfers must match; enforced from M3). */
export const StorageZone = ['AMBIENT', 'BELOW_25C', 'COLD_2_8C', 'FROZEN'] as const;
export type StorageZone = (typeof StorageZone)[number];

export const TaxKind = ['SALES_TAX', 'WITHHOLDING'] as const;
export type TaxKind = (typeof TaxKind)[number];

export const AddressType = ['BILLING', 'SHIPPING'] as const;
export type AddressType = (typeof AddressType)[number];
