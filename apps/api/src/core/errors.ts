import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ErrorCode } from '@albert/shared';
import { logger } from './logger';

const statusFor: Partial<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  SEGREGATION_OF_DUTIES: 403,
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
  // Database guard triggers raise with these prefixes; surface them as business-rule errors.
  const message = err instanceof Error ? err.message : String(err);
  if (/^(APPEND_ONLY|POSTED_IMMUTABLE)/.test(message)) {
    res.status(409).json({ error: { code: 'INVALID_TRANSITION', message } });
    return;
  }
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
};
