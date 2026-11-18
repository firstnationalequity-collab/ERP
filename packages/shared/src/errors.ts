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
  'JOURNAL_UNBALANCED',
  'NUMBER_SERIES_MISSING',
  'APPROVAL_RULE_MISSING',
  'APPROVER_ROLE_NOT_ALLOWED',
  'FILE_TOO_LARGE',
  'FILE_TYPE_NOT_ALLOWED',
  'FILE_INTEGRITY_FAILED',
  'LOT_NOT_APPROVED',
  'INSUFFICIENT_STOCK',
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
