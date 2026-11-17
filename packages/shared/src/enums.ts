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
