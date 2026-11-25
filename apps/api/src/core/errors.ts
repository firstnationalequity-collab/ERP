import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { ErrorCodes, type ErrorCode } from '@albert/shared';
import { logger } from './logger';

const statusFor: Partial<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 401,
  ACCOUNT_INACTIVE: 401,
  SESSION_REVOKED: 401,
  PASSWORD_EXPIRED: 403,
  PASSWORD_CHANGE_REQUIRED: 403,
  FORBIDDEN: 403,
  SEGREGATION_OF_DUTIES: 403,
  SELF_ROLE_CHANGE: 403,
  COUNTERSIGN_REQUIRED: 403,
  ESIGN_FAILED: 403,
  WITNESS_REQUIRED: 403,
  WITNESS_MISMATCH: 403,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  INVALID_TRANSITION: 409,
  PERIOD_OUT_OF_ORDER: 409,
  RECORD_LOCKED: 409,
  IN_USE: 409,
  DUPLICATE_REQUEST: 409,
  /** A stored file no longer matches its recorded SHA-256: never serve it. */
  FILE_INTEGRITY_FAILED: 500,
};

/** Throw this from services. Business-rule codes default to HTTP 422. */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = statusFor[code] ?? 422;
  }
}

const knownCodes = new Set<string>(ErrorCodes);

/**
 * Database guard triggers raise `RAISE EXCEPTION '<CODE>: message' USING ERRCODE = 'P0001'`.
 * Turn those into AppErrors. APPEND_ONLY / POSTED_IMMUTABLE are state conflicts (409).
 * Returns undefined for anything that is not a guard error.
 */
export function fromDbError(err: unknown): AppError | undefined {
  if (!(err instanceof Error)) return undefined;
  const pgCode = (err as Error & { code?: unknown }).code;
  if (pgCode === '23P01') {
    // exclusion_violation: e.g. a fiscal period overlapping an existing one.
    return new AppError('ALREADY_EXISTS', 'This overlaps an existing record', {
      constraint: (err as Error & { constraint?: unknown }).constraint,
    });
  }
  if (pgCode === '23505') {
    // unique_violation: a code, username or similar already exists.
    return new AppError('ALREADY_EXISTS', 'A record with the same unique value already exists', {
      constraint: (err as Error & { constraint?: unknown }).constraint,
    });
  }
  if (pgCode === '23514') {
    // check_violation: the database backstop for a rule the service should have checked first.
    return new AppError('VALIDATION_FAILED', 'The data breaks a database rule', {
      constraint: (err as Error & { constraint?: unknown }).constraint,
    });
  }
  if (pgCode === '23503') {
    // foreign_key_violation: deleting something still used, or pointing at a record that does not exist.
    const inUse = /still referenced/.test(err.message);
    return new AppError(inUse ? 'IN_USE' : 'VALIDATION_FAILED', inUse ? 'This record is still in use' : 'A referenced record does not exist', {
      constraint: (err as Error & { constraint?: unknown }).constraint,
    });
  }
  if (pgCode !== 'P0001') return undefined;
  const match = /^([A-Z_]+): (.*)$/s.exec(err.message);
  if (!match?.[1]) return undefined;
  const [, code, message = ''] = match;
  if (code === 'APPEND_ONLY' || code === 'POSTED_IMMUTABLE') {
    return new AppError('INVALID_TRANSITION', `${code}: ${message}`);
  }
  if (knownCodes.has(code)) return new AppError(code as ErrorCode, message);
  return undefined;
}

export const notFound: RequestHandler = (req, _res, next) => {
  next(new AppError('NOT_FOUND', `No route for ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res
      .status(400)
      .json({ error: { code: 'VALIDATION_FAILED', message: 'Invalid request', details: err.flatten() } });
    return;
  }
  // Database guard triggers: surface them with their own code and status.
  const dbError = fromDbError(err);
  if (dbError) {
    res.status(dbError.status).json({ error: { code: dbError.code, message: dbError.message } });
    return;
  }
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
};
