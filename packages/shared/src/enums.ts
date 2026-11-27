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
 * true-up added to the FG lot at batch close (owner 2026-11-18, Q8). LANDED_COST: a landed-cost charge billed after receipt, on the share of the GRN lot still held (owner Q21; 0029).
 */
export const ValueAdjustmentReason = ['BATCH_CLOSE', 'LANDED_COST'] as const;
export type ValueAdjustmentReason = (typeof ValueAdjustmentReason)[number];

/**
 * QC sample type, the reason_code of a SAMPLE_ISSUE movement (owner 2026-11-27; 0035): TEST = taken for analysis;
 * RETENTION = retention / reserve sample kept by QC. Both leave stock the same way.
 */
export const QcSampleType = ['TEST', 'RETENTION'] as const;
export type QcSampleType = (typeof QcSampleType)[number];

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
  'SAMPLE_ISSUE', // QC sample out of a QUARANTINE / UNDER_TEST lot, qc.result.enter only; reason_code = QcSampleType (owner 2026-11-27, 0035)
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
 * Landed cost charge (0029; owner Q21, Q2): DRAFT → POSTED (with its GRN, or alone as a later bill);
 * DRAFT → CANCELLED (reason; also when its GRN is cancelled or reversed). A posted charge never changes.
 */
export const LandedCostStatus = ['DRAFT', 'POSTED', 'CANCELLED', 'REVERSED'] as const;
export type LandedCostStatus = (typeof LandedCostStatus)[number];

/**
 * How a capitalised charge is spread over the GRN lines (owner Q21): VALUE (default), WEIGHT (freight and other
 * charges, weight per PO line), GD_AMOUNTS (duties: the amounts per PO line from the goods declaration).
 * Within one PO line received on several GRN lines, the share is split by quantity.
 */
/**
 * Vendor invoice (M3 task 5; 0031). GOODS: 3-way match against GRN lines of one PO; CHARGES: settles landed-cost
 * clearing (owner Q3). DRAFT → POSTED (within the match tolerances) or → MATCH_EXCEPTION (outside), which a Finance
 * Manager releases with an e-signature and a reason, creator ≠ releaser (owner Q5), or returns to DRAFT;
 * DRAFT / MATCH_EXCEPTION → CANCELLED (reason). POSTED → REVERSED (M3 task 5b, 0032; owner 2026-11-26): Finance
 * Manager, reason + e-signature (REVERSED), only while nothing is paid or debited against it.
 */
export const VendorInvoiceStatus = ['DRAFT', 'MATCH_EXCEPTION', 'POSTED', 'CANCELLED', 'REVERSED'] as const;
export type VendorInvoiceStatus = (typeof VendorInvoiceStatus)[number];
export const VendorInvoiceType = ['GOODS', 'CHARGES'] as const;
export type VendorInvoiceType = (typeof VendorInvoiceType)[number];

/**
 * Vendor payment (M3 task 5; 0031): DRAFT → PENDING_APPROVAL (approval matrix VENDOR_PAYMENT) → APPROVED → POSTED;
 * a rejection returns it to DRAFT; DRAFT / APPROVED → CANCELLED (reason). Creator ≠ approver (§3).
 * POSTED → REVERSED (bounced cheque, wrong payment; M3 task 5b, 0032; owner 2026-11-26): Finance Manager, reason +
 * e-signature (REVERSED); the invoices it settled are open again.
 */
export const VendorPaymentStatus = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'CANCELLED', 'REVERSED'] as const;
export type VendorPaymentStatus = (typeof VendorPaymentStatus)[number];

/**
 * Debit note against a POSTED GOODS vendor invoice (M3 task 5b, 0032; owner 2026-11-26), DN-{FY}-{SEQ:5}:
 * DRAFT → PENDING_APPROVAL (approval matrix DEBIT_NOTE) → APPROVED → POSTED; a rejection returns it to DRAFT;
 * DRAFT / PENDING_APPROVAL / APPROVED → CANCELLED (reason). Creator ≠ approver.
 * POSTED → REVERSED (owner 2026-11-27, 0033): Finance Manager, reason + e-signature (REVERSED); the journal is mirrored
 * and, for a return, the return movement while the lot is still REJECTED; what it took off the invoice is open again.
 */
export const DebitNoteStatus = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'CANCELLED', 'REVERSED'] as const;
export type DebitNoteStatus = (typeof DebitNoteStatus)[number];
/**
 * PRICE_CLAIM: an amount off invoice lines; SHORT_SUPPLY: quantity billed but not received; RETURN_TO_VENDOR: a
 * REJECTED lot sent back (the debit note posts the witnessed RETURN_TO_VENDOR movement and links it).
 */
export const DebitNoteReason = ['PRICE_CLAIM', 'SHORT_SUPPLY', 'RETURN_TO_VENDOR'] as const;
export type DebitNoteReason = (typeof DebitNoteReason)[number];

/** What a WHT code is deducted on (owner 2026-11-26, 0032): the gross paid including sales tax, or excluding it. */
export const WhtBase = ['INCL_SALES_TAX', 'EXCL_SALES_TAX'] as const;
export type WhtBase = (typeof WhtBase)[number];

export const LandedCostBasis = ['VALUE', 'WEIGHT', 'GD_AMOUNTS'] as const;
export type LandedCostBasis = (typeof LandedCostBasis)[number];

/** Where a charge type that is not capitalised is debited (owner Q21): input sales tax or advance income tax. */
export const LandedCostTaxRole = ['INPUT_TAX', 'ADVANCE_TAX'] as const;
export type LandedCostTaxRole = (typeof LandedCostTaxRole)[number];

/**
 * QC sample request (owner 2026-11-25 Q1: created OPEN with each GRN lot; FG output in M6).
 * OPEN → SAMPLED (M4 task 2, 0036): the analyst took the sample (lot → UNDER_TEST, SAMPLE_ISSUE movements, spec pinned).
 * SAMPLED → CLOSED (M4 task 3, 0037): the QC Manager approved or rejected the lot on its reviewed results.
 * CANCELLED: its GRN was reversed before any sample was taken (owner 2026-11-25, answer 5; 0028).
 */
export const SampleRequestStatus = ['OPEN', 'SAMPLED', 'CLOSED', 'CANCELLED'] as const;
export type SampleRequestStatus = (typeof SampleRequestStatus)[number];

/**
 * QC specification version (M4 task 1; 0034): DRAFT → PENDING_APPROVAL → APPROVED (QC Manager, e-signature)
 * → OBSOLETE when the next version is approved; a rejection returns it to DRAFT.
 */
export const QcSpecStatus = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'OBSOLETE'] as const;
export type QcSpecStatus = (typeof QcSpecStatus)[number];

/** A spec test is NUMERIC (min and/or max) or TEXT (a text limit the analyst judges, e.g. "Complies"). */
export const QcResultType = ['NUMERIC', 'TEXT'] as const;
/**
 * Why the QC Manager rejects a material lot without a failed test (owner 2026-11-27; 0038): required, with a
 * description, on every rejection that no failed latest result supports. SQL: qc.dispositions.reject_category CHECK.
 */
export const QcRejectCategory = ['DAMAGED_CONTAINER', 'LABELLING', 'SEAL_BROKEN', 'CONTAMINATION', 'COA_MISMATCH', 'VENDOR_ISSUE', 'OTHER'] as const;
export type QcRejectCategory = (typeof QcRejectCategory)[number];
export type QcResultType = (typeof QcResultType)[number];

/** Item types a QC specification can be written for (0034 qc.guard_spec). */
export const QcSpecItemTypes = ['RM', 'PM', 'API', 'EXCIPIENT', 'BULK', 'FG'] as const;

export const DeviationClass = ['MINOR', 'MAJOR', 'CRITICAL'] as const;
export type DeviationClass = (typeof DeviationClass)[number];

export const SignatureMeaning = ['REVIEWED', 'APPROVED', 'RELEASED', 'REJECTED', 'WITNESSED', 'PERFORMED', 'REVERSED'] as const;
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
  'IMPORT_TAX', // import-stage sales tax and income tax collected at import: not capitalised (owner Q21; 0029)
  'VENDOR_INVOICE',
  'VENDOR_PAYMENT',
  'VENDOR_DEBIT_NOTE', // price claim / short supply against a vendor invoice (owner 2026-11-26; 0032)
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
  'QC_SAMPLE', // QC sample taken from a lot: Dr QC sample expense / Cr inventory (owner 2026-11-27; 0035)
] as const;
export type PostingEvent = (typeof PostingEvent)[number];

/** The account a posting rule supplies for one leg of an event (debit or credit is decided by the posting engine). */
export const AccountRole = [
  'INVENTORY',
  'GRNI',
  'PRICE_VARIANCE',
  'LANDED_COST_CLEARING',
  'INPUT_TAX',
  'ADVANCE_TAX', // income tax collected at import (owner Q21; 0029)
  'ACCOUNTS_PAYABLE',
  'BANK',
  'WHT_PAYABLE',
  'EXCHANGE_DIFFERENCE', // IAS 21 rate difference on vendor invoices and payments (owner Q4; 0031). Placeholder account
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
  'QC_SAMPLE_EXPENSE', // QC samples taken out of stock (owner 2026-11-27; 0035). Placeholder account 6400, Finance to confirm
] as const;
export type AccountRole = (typeof AccountRole)[number];

/**
 * Which account roles each event uses (architecture §6 table). SQL: fin.is_valid_posting_role, tested equal.
 * INVENTORY is resolved by item category (a rule with no category is the default for every category).
 */
export const PostingEventRoles: Readonly<Record<PostingEvent, readonly AccountRole[]>> = {
  GRN_RECEIPT: ['INVENTORY', 'GRNI'],
  LANDED_COST: ['INVENTORY', 'PRICE_VARIANCE', 'LANDED_COST_CLEARING'],
  IMPORT_TAX: ['INPUT_TAX', 'ADVANCE_TAX', 'LANDED_COST_CLEARING'],
  // 0031: a CHARGES invoice settles landed-cost clearing (owner Q3); the rate difference → exchange gain/loss (Q4).
  VENDOR_INVOICE: ['GRNI', 'LANDED_COST_CLEARING', 'INPUT_TAX', 'PRICE_VARIANCE', 'EXCHANGE_DIFFERENCE', 'ACCOUNTS_PAYABLE'],
  VENDOR_PAYMENT: ['ACCOUNTS_PAYABLE', 'BANK', 'WHT_PAYABLE', 'EXCHANGE_DIFFERENCE'],
  // 0032 (owner 2026-11-26): Dr AP / Cr price variance + input tax reversal.
  VENDOR_DEBIT_NOTE: ['ACCOUNTS_PAYABLE', 'PRICE_VARIANCE', 'INPUT_TAX'],
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
  // 0032: a return on a debit note also books the difference to the billed price and reverses the input tax.
  LOT_RETURNED: ['ACCOUNTS_PAYABLE', 'INVENTORY', 'PRICE_VARIANCE', 'INPUT_TAX'],
  ROUNDING_DIFFERENCE: ['INVENTORY', 'ROUNDING_DIFFERENCE'],
  QC_SAMPLE: ['QC_SAMPLE_EXPENSE', 'INVENTORY'],
};
