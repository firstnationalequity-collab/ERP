// /api/v1/core/auth — login, refresh, logout, me, change-password.
// The refresh token travels only in an httpOnly cookie scoped to this path.
import { Router, type CookieOptions, type Response } from 'express';
import { ChangePasswordRequest, LoginRequest, type LoginResponse } from '@albert/shared';
import { env } from '../../config/env';
import * as auth from './auth.service';
import { asyncHandler, authenticate, authOf, requestMeta } from './middleware';

export const REFRESH_COOKIE = 'albert_rt';
const COOKIE_PATH = '/api/v1/core/auth';

function cookieOptions(expires?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: COOKIE_PATH,
    ...(expires ? { expires } : {}),
  };
}

function sendTokens(res: Response, tokens: auth.IssuedTokens): void {
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, cookieOptions(tokens.refreshTokenExpiresAt));
  const body: LoginResponse = {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    user: tokens.user,
  };
  res.json(body);
}

function refreshCookie(cookies: unknown): string | undefined {
  if (typeof cookies !== 'object' || cookies === null) return undefined;
  const value = (cookies as Record<string, unknown>)[REFRESH_COOKIE];
  return typeof value === 'string' ? value : undefined;
}

export const authRouter = Router();

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const input = LoginRequest.parse(req.body);
    sendTokens(res, await auth.login(input, requestMeta(req)));
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    try {
      sendTokens(res, await auth.refresh(refreshCookie(req.cookies), requestMeta(req)));
    } catch (err) {
      res.clearCookie(REFRESH_COOKIE, cookieOptions());
      throw err;
    }
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await auth.logout(refreshCookie(req.cookies), requestMeta(req));
    res.clearCookie(REFRESH_COOKIE, cookieOptions());
    res.status(204).end();
  }),
);

// Allowed while a password change is pending (no requireCurrentPassword here).
authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await auth.currentUser(authOf(req)));
  }),
);

authRouter.post(
  '/change-password',
  authenticate,
  asyncHandler(async (req, res) => {
    const input = ChangePasswordRequest.parse(req.body);
    await auth.changePassword(authOf(req), input, requestMeta(req));
    res.status(204).end();
  }),
);
