// Error codes returned by the API in { error: { code, message, details } }.
// Add new codes here so the web app can show the right message.
export const ErrorCodes = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'ACCOUNT_INACTIVE',
  'PASSWORD_EXPIRED',
  'PASSWORD_CHANGE_REQUIRED',
  'PASSWORD_POLICY',
  'PASSWORD_REUSED',
  'SESSION_REVOKED',
  'FORBIDDEN',
  'SEGREGATION_OF_DUTIES',
  'SELF_ROLE_CHANGE',
  'ROLE_ADMIN_CONFLICT',
  'COUNTERSIGN_REQUIRED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'LAST_ADMIN',
  'QA_MANAGER_EXISTS',
  'INVALID_TRANSITION',
  'RECORD_LOCKED',
  'IN_USE',
  'ESIGN_FAILED',
  'PERIOD_CLOSED',
  'PERIOD_NOT_DEFINED',
  /** Periods close in order (earliest OPEN first) and reopen in order (latest CLOSED first) (owner Q2/Q3, 0022). */
  'PERIOD_OUT_OF_ORDER',
  'JOURNAL_UNBALANCED',
  'TAX_RATE_NOT_CONFIRMED',
  'NUMBER_SERIES_MISSING',
  'APPROVAL_RULE_MISSING',
  'POSTING_RULE_MISSING',
  'APPROVER_ROLE_NOT_ALLOWED',
  'FILE_TOO_LARGE',
  'FILE_TYPE_NOT_ALLOWED',
  'FILE_INTEGRITY_FAILED',
  'LOT_NOT_APPROVED',
  'LOT_NOT_RELEASED',
  'INSUFFICIENT_STOCK',
  'BATCH_NOT_CLOSED',
  'LOT_EMPTY',
  'LOT_VALUE_NEGATIVE',
  'RETURN_EXCEEDS_DISPATCH',
  'CUSTOMER_NOT_ACTIVE',
  /** A lot disposal (DESTROY / RETURN_TO_VENDOR, → DESTROYED / RETURNED) without a valid QA witness signature (0020). */
  'WITNESS_REQUIRED',
  /** The witness signed for a different lot, movement type or quantity (0020). */
  'WITNESS_MISMATCH',
  /** A lot emptied by a disposal was not closed (DESTROYED / RETURNED) in the same transaction (0020). */
  'LOT_NOT_CLOSED',
  'VENDOR_NOT_APPROVED',
  /** A GMP material (AvlItemTypes) without an APPROVED approved source for the vendor (+ manufacturer at GRN) (0023). */
  'AVL_NOT_APPROVED',
  'VENDOR_NOT_ACTIVE',
  /** No Finance exchange rate for the currency on the document date (owner 2026-11-25, Q4). */
  'RATE_MISSING',
  /** A GRN would receive more than the PO line's open quantity plus the over-receipt tolerance (§7.5; 0027). */
  'OVER_RECEIPT',
  /** Remaining shelf life on the GRN date below setting purch.grn.min_shelf_life_pct (owner 2026-11-25; 0028). */
  'SHELF_LIFE_TOO_SHORT',
  /** A GRN reversal refused: a lot was sampled, moved, reserved or changed status (owner 2026-11-25; 0028). */
  'GRN_LOTS_IN_USE',
  /** Landed-cost corrections would take a charge below zero (owner 2026-11-25, 4b; 0030). GRN_HAS_LANDED_COST (0029) is gone: a GRN with posted charges is reversed with them. */
  'CORRECTION_EXCEEDS_CHARGE',
  /** A currency the document does not allow: PKR-only charge types and GD amounts (owner 2026-11-26; 0031). */
  'CURRENCY_NOT_ALLOWED',
  /** An invoice line or payment allocation beyond what is still open on the charge or invoice (0031). */
  'AMOUNT_EXCEEDS_OPEN',
  /** A warning the actor must acknowledge first, e.g. a vendor's filer status checked too long ago (owner 2026-11-26; 0032). */
  'ACKNOWLEDGEMENT_REQUIRED',
  'CREDIT_LIMIT_EXCEEDED',
  'OPEN_DEVIATION',
  'DUPLICATE_REQUEST',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ErrorCodes)[number];

export interface ApiError {
  error: { code: ErrorCode; message: string; details?: unknown };
}
