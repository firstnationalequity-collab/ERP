// JWTs. Access token: 15 min, carries user + session + company. Refresh token: carries session + a one-time id
// (jti); only sha256(jti) of the latest token is stored on the session, so an older token = reuse.
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** Fixed from login (one shift); rotation does not extend it. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface AccessClaims {
  sub: string; // user id
  sid: string; // session id
  cid: string; // company id
}

export interface RefreshClaims {
  sid: string;
  jti: string;
}

export function signAccessToken(claims: AccessClaims): { token: string; expiresAt: Date } {
  const token = jwt.sign({ sid: claims.sid, cid: claims.cid }, env.JWT_ACCESS_SECRET, {
    subject: claims.sub,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    algorithm: 'HS256',
  });
  return { token, expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000) };
}

/** Returns undefined for any invalid, expired or malformed token. */
export function verifyAccessToken(token: string): AccessClaims | undefined {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    if (typeof payload === 'string') return undefined;
    const { sub, sid, cid } = payload as Record<string, unknown>;
    if (typeof sub !== 'string' || typeof sid !== 'string' || typeof cid !== 'string') return undefined;
    return { sub, sid, cid };
  } catch {
    return undefined;
  }
}

export function newRefreshToken(sessionId: string, expiresAt: Date): { token: string; jtiHash: string } {
  const jti = randomBytes(32).toString('base64url');
  const seconds = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const token = jwt.sign({ sid: sessionId, jti }, env.JWT_REFRESH_SECRET, { expiresIn: seconds, algorithm: 'HS256' });
  return { token, jtiHash: hashJti(jti) };
}

export function verifyRefreshToken(token: string): RefreshClaims | undefined {
  try {
    const payload = jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
    if (typeof payload === 'string') return undefined;
    const { sid, jti } = payload as Record<string, unknown>;
    if (typeof sid !== 'string' || typeof jti !== 'string') return undefined;
    return { sid, jti };
  } catch {
    return undefined;
  }
}

export function hashJti(jti: string): string {
  return createHash('sha256').update(jti).digest('hex');
}
