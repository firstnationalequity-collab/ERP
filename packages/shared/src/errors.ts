// Error codes returned by the API in { error: { code, message, details } }.
// Add new codes here so the web app can show the right message.
export const ErrorCodes = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'SEGREGATION_OF_DUTIES',
  'NOT_FOUND',
  'INVALID_TRANSITION',
  'ESIGN_FAILED',
  'PERIOD_CLOSED',
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
