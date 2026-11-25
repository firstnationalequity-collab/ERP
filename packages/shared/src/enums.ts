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
/**
 * Owner 2026-11-25 (answer 4): an item's qc_required starts true for these types, false for the others. A GRN lot of
 * an item with qc_required = false is created APPROVED with no QC sample request. Changing it needs QA (0028).
 */
export const QcRequiredByDefaultTypes: readonly ItemType[] = ['RM', 'PM', 'API', 'EXCIPIENT'];
export const qcRequiredDefault = (type: ItemType): boolean => QcRequiredByDefaultTypes.includes(type);

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

/**
 * How a lot came to exist (inv.lots.source, 0017). RECEIPT, OUTPUT and SALES_RETURN movements go only into lots of
 * their own source. A SALES_RETURN lot is created in HOLD, linked to the original lot (owner 2026-11-18, Q9).
 */
export const LotSource = ['GRN', 'PRODUCTION_OUTPUT', 'SALES_RETURN'] as const;
export type LotSource = (typeof LotSource)[number];

/**
 * Why a lot's value is adjusted (VALUE_ADJUSTMENT rows, reason_code; 0017). BATCH_CLOSE: conversion cost and the
 * true-up added to the FG lot at batch close (owner 2026-11-18, Q8). M3 adds LANDED_COST.
 */
export const ValueAdjustmentReason = ['BATCH_CLOSE'] as const;
export type ValueAdjustmentReason = (typeof ValueAdjustmentReason)[number];

export const StockOwner = ['OWN', 'CUSTOMER'] as const;
export type StockOwner = (typeof StockOwner)[number];

/**
 * Stock ledger movement types (inv.stock_movements, migration 0014). Each row touches one location: inbound
 * types add stock (to_location, qty > 0), outbound types remove it (from_location, qty < 0). A transfer is a
 * TRANSFER_OUT + TRANSFER_IN pair. A reversal row keeps the original's type with the direction flipped.
 */
export const StockMovementType = [
  'RECEIPT', // GRN or customer-material receipt: new lot, QUARANTINE
  'ISSUE', // material issued to a batch: APPROVED lots only (rule 2)
  'ISSUE_RETURN', // material returned from the floor
  'OUTPUT', // FG output of a batch: new lot, QUARANTINE
  'DISPATCH', // delivery: RELEASED FG lots only (rule 2)
  'SALES_RETURN', // goods returned by a customer
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'ADJUSTMENT_IN',
  'ADJUSTMENT_OUT',
  'DESTROY', // REJECTED lot destroyed
  'RETURN_TO_VENDOR', // REJECTED lot returned
  'ROUNDING_SWEEP', // value only (qty 0, no location): clears the paisa left on an empty lot; posting engine only (0016)
  'VALUE_ADJUSTMENT', // value only (qty 0, no location): raises or lowers a lot's value and unit cost (owner Q8, 0017)
] as const;
export type StockMovementType = (typeof StockMovementType)[number];

/** Movement types that add stock to a location (the rest remove it). SQL: inv.is_inbound, tested equal. */
export const InboundMovementTypes: readonly StockMovementType[] = ['RECEIPT', 'ISSUE_RETURN', 'OUTPUT', 'SALES_RETURN', 'TRANSFER_IN', 'ADJUSTMENT_IN'];

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

/** Purchase requisition (owner 2026-11-25, Q6): no approval; value approval happens on the PO. */
export const PurchaseRequisitionStatus = ['DRAFT', 'SUBMITTED', 'CONVERTED', 'CANCELLED'] as const;
export type PurchaseRequisitionStatus = (typeof PurchaseRequisitionStatus)[number];

/** A LOCAL PO is in PKR; an IMPORT PO names its currency and incoterm (0023). */
export const PurchaseOrderType = ['LOCAL', 'IMPORT'] as const;
export type PurchaseOrderType = (typeof PurchaseOrderType)[number];

export const Incoterm = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'] as const;
export type Incoterm = (typeof Incoterm)[number];

/** GRN, issue, delivery, invoice, receipt, payment, journal. */
export const PostingStatus = ['DRAFT', 'POSTED', 'REVERSED'] as const;
export type PostingStatus = (typeof PostingStatus)[number];

/** GRN (0027, 0028): DRAFT → POSTED; DRAFT → CANCELLED (reason); POSTED → REVERSED (lots untouched; owner 2026-11-25). */
export const GrnStatus = ['DRAFT', 'POSTED', 'CANCELLED', 'REVERSED'] as const;
export type GrnStatus = (typeof GrnStatus)[number];

/**
 * QC sample request (M3 stub, owner 2026-11-25 Q1: created OPEN with each GRN lot; M4 adds the sampling moves).
 * CANCELLED: its GRN was reversed before any sample was taken (owner 2026-11-25, answer 5; 0028).
 */
export const SampleRequestStatus = ['OPEN', 'CANCELLED'] as const;
export type SampleRequestStatus = (typeof SampleRequestStatus)[number];

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

// ---------------------------------------------------------------- finance (M2 task 4; 0012_finance_masters.sql)

export const AccountType = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'] as const;
export type AccountType = (typeof AccountType)[number];

/** Business events that post to the GL (docs/architecture.md §6). */
export const PostingEvent = [
  'GRN_RECEIPT',
  'LANDED_COST',
  'VENDOR_INVOICE',
  'VENDOR_PAYMENT',
  'MATERIAL_ISSUE',
  'MATERIAL_RETURN',
  'CONVERSION_ABSORB',
  'FG_OUTPUT',
  'FG_COST_ADJUSTMENT', // batch close: conversion + true-up onto the FG lot (owner 2026-11-18, Q8; 0017)
  'DISPATCH',
  'SALES_RETURN_RECEIPT', // customer return into a HOLD return lot, reverses COGS (owner 2026-11-18, Q9; 0017)
  'SALES_INVOICE',
  'TOLL_INVOICE',
  'CUSTOMER_RECEIPT',
  'STOCK_ADJUSTMENT',
  'LOT_DESTROYED',
  'LOT_RETURNED',
  'ROUNDING_DIFFERENCE', // paisa left on an empty lot, swept by the posting engine (owner 18-11-2026; 0016)
] as const;
export type PostingEvent = (typeof PostingEvent)[number];

/** The account a posting rule supplies for one leg of an event (debit or credit is decided by the posting engine). */
export const AccountRole = [
  'INVENTORY',
  'GRNI',
  'PRICE_VARIANCE',
  'LANDED_COST_CLEARING',
  'INPUT_TAX',
  'ACCOUNTS_PAYABLE',
  'BANK',
  'WHT_PAYABLE',
  'WIP',
  'LABOUR_ABSORBED',
  'OVERHEAD_ABSORBED',
  'COGS',
  'ACCOUNTS_RECEIVABLE',
  'SALES_REVENUE',
  'CONVERSION_REVENUE',
  'OUTPUT_TAX',
  'WHT_RECEIVABLE',
  'INVENTORY_LOSS',
  'INVENTORY_GAIN',
  'REJECTION_WRITE_OFF',
  'ROUNDING_DIFFERENCE',
] as const;
export type AccountRole = (typeof AccountRole)[number];

/**
 * Which account roles each event uses (architecture §6 table). SQL: fin.is_valid_posting_role, tested equal.
 * INVENTORY is resolved by item category (a rule with no category is the default for every category).
 */
export const PostingEventRoles: Readonly<Record<PostingEvent, readonly AccountRole[]>> = {
  GRN_RECEIPT: ['INVENTORY', 'GRNI'],
  LANDED_COST: ['INVENTORY', 'PRICE_VARIANCE', 'LANDED_COST_CLEARING'],
  VENDOR_INVOICE: ['GRNI', 'INPUT_TAX', 'PRICE_VARIANCE', 'ACCOUNTS_PAYABLE'],
  VENDOR_PAYMENT: ['ACCOUNTS_PAYABLE', 'BANK', 'WHT_PAYABLE'],
  MATERIAL_ISSUE: ['WIP', 'INVENTORY'],
  MATERIAL_RETURN: ['INVENTORY', 'WIP'],
  CONVERSION_ABSORB: ['WIP', 'LABOUR_ABSORBED', 'OVERHEAD_ABSORBED'],
  FG_OUTPUT: ['INVENTORY', 'WIP'],
  FG_COST_ADJUSTMENT: ['INVENTORY', 'WIP'],
  DISPATCH: ['COGS', 'INVENTORY'],
  SALES_RETURN_RECEIPT: ['INVENTORY', 'COGS'],
  SALES_INVOICE: ['ACCOUNTS_RECEIVABLE', 'SALES_REVENUE', 'OUTPUT_TAX'],
  TOLL_INVOICE: ['ACCOUNTS_RECEIVABLE', 'CONVERSION_REVENUE', 'OUTPUT_TAX'],
  CUSTOMER_RECEIPT: ['BANK', 'WHT_RECEIVABLE', 'ACCOUNTS_RECEIVABLE'],
  STOCK_ADJUSTMENT: ['INVENTORY', 'INVENTORY_LOSS', 'INVENTORY_GAIN'],
  LOT_DESTROYED: ['REJECTION_WRITE_OFF', 'INVENTORY'],
  LOT_RETURNED: ['ACCOUNTS_PAYABLE', 'INVENTORY'],
  ROUNDING_DIFFERENCE: ['INVENTORY', 'ROUNDING_DIFFERENCE'],
};
