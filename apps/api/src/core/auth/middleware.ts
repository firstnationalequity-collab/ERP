import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '../errors';
import { authenticateToken, type AuthContext, type RequestMeta } from './auth.service';

// Express request augmentation: req.auth is set by `authenticate`.
declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function requestMeta(req: Request): RequestMeta {
  return { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null };
}

/** Requires a valid bearer access token on a live session; sets req.auth. */
export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.get('authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match?.[1]) {
    next(new AppError('UNAUTHENTICATED', 'Not signed in'));
    return;
  }
  authenticateToken(match[1])
    .then((auth) => {
      req.auth = auth;
      next();
    })
    .catch(next);
};

/**
 * Blocks everything except change-password / me / logout while the password must be changed
 * (first login, admin reset) or is older than 90 days.
 */
export const requireCurrentPassword: RequestHandler = (req, _res, next) => {
  const auth = req.auth;
  if (!auth) {
    next(new AppError('UNAUTHENTICATED', 'Not signed in'));
    return;
  }
  if (auth.mustChangePassword) {
    next(new AppError('PASSWORD_CHANGE_REQUIRED', 'You must change your password before continuing'));
    return;
  }
  if (auth.passwordExpired) {
    next(new AppError('PASSWORD_EXPIRED', 'Your password has expired; change it to continue'));
    return;
  }
  next();
};

/** The authenticated user, for handlers placed after `authenticate`. */
export function authOf(req: Request): AuthContext {
  if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Not signed in');
  return req.auth;
}

/** Wrap an async handler so rejections reach the error handler (Express 4 does not do this). */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
