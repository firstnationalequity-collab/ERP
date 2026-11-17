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
  NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  DUPLICATE_REQUEST: 409,
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
