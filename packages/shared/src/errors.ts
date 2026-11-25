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
  'CREDIT_LIMIT_EXCEEDED',
  'OPEN_DEVIATION',
  'DUPLICATE_REQUEST',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ErrorCodes)[number];

export interface ApiError {
  error: { code: ErrorCode; message: string; details?: unknown };
}
