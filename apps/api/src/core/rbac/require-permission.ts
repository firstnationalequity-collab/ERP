// RBAC: every route declares the permission key it needs (CLAUDE.md "routes (validate + permission)").
// Place after `authenticate`. Permissions are loaded per request (auth.service), so revocation is immediate.
import type { RequestHandler } from 'express';
import type { PermissionKey } from '@albert/shared';
import { AppError } from '../errors';

/** The user must hold `key`. 403 FORBIDDEN otherwise. */
export function requirePermission(key: PermissionKey): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) {
      next(new AppError('UNAUTHENTICATED', 'Not signed in'));
      return;
    }
    if (!req.auth.permissions.has(key)) {
      next(new AppError('FORBIDDEN', 'You do not have permission for this action', { permission: key }));
      return;
    }
    next();
  };
}

/** The user must hold at least one of `keys` (e.g. reading the role list for user admin). */
export function requireAnyPermission(...keys: [PermissionKey, ...PermissionKey[]]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) {
      next(new AppError('UNAUTHENTICATED', 'Not signed in'));
      return;
    }
    if (!keys.some((k) => req.auth?.permissions.has(k))) {
      next(new AppError('FORBIDDEN', 'You do not have permission for this action', { permission: keys }));
      return;
    }
    next();
  };
}
