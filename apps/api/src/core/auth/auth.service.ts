// Authentication: login, refresh with rotation and reuse detection, logout, change password, unlock.
// Rules: docs/architecture.md §7.1; decisions Q2–Q7.
// Failed attempts must be recorded even though the request fails, so each flow commits its transaction
// first and throws afterwards.
import {
  MAX_FAILED_ATTEMPTS,
  PASSWORD_HISTORY_DEPTH,
  PASSWORD_MAX_AGE_DAYS,
  type AuthEventType,
  type ChangePasswordRequest,
  type CurrentUser,
  type LoginRequest,
  type PermissionKey,
} from '@albert/shared';
import { COMPANY_ID, db, setActor, systemContext, withTransaction, type Queryable, type Tx, type TxContext } from '../../db/client';
import { AppError } from '../errors';
import { assertPasswordPolicy, hashPassword, verifyPassword } from './password';
import * as repo from './auth.repo';
import type { UserRow } from './auth.repo';
import {
  SESSION_TTL_MS,
  newRefreshToken,
  signAccessToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashJti,
} from './tokens';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface AuthContext {
  userId: string;
  companyId: string;
  sessionId: string;
  username: string;
  mustChangePassword: boolean;
  passwordExpired: boolean;
  permissions: ReadonlySet<PermissionKey>;
}

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  user: CurrentUser;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: AppError };

const invalidCredentials = () => new AppError('INVALID_CREDENTIALS', 'Username or password is incorrect');
const lockedError = () =>
  new AppError('ACCOUNT_LOCKED', 'Account is locked after too many failed attempts. Ask an administrator to unlock it.');

/** Used when the username is unknown, so a wrong username takes as long as a wrong password. */
let dummyHash: Promise<string> | undefined;
async function burnTime(password: string): Promise<void> {
  dummyHash ??= hashPassword('Dummy-Password-For-Timing-1');
  await verifyPassword(await dummyHash, password);
}

export function isPasswordExpired(user: Pick<UserRow, 'passwordChangedAt'>, now = new Date()): boolean {
  if (!user.passwordChangedAt) return true;
  const ageMs = now.getTime() - user.passwordChangedAt.getTime();
  return ageMs > PASSWORD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Count one wrong password (login, password change or e-signature — decision Q3).
 * The 5th consecutive failure locks the account, revokes its sessions and logs LOCKOUT.
 * The caller must have locked the user row (SELECT ... FOR UPDATE).
 */
export async function registerFailedPassword(
  tx: Tx,
  user: UserRow,
  event: Extract<AuthEventType, 'LOGIN_FAIL' | 'ESIGN_FAIL'>,
  meta: RequestMeta,
  details: Record<string, unknown> = {},
): Promise<{ locked: boolean }> {
  const attempts = user.failedAttempts + 1;
  const locked = attempts >= MAX_FAILED_ATTEMPTS;
  await repo.updateUser(tx, user.id, { failedAttempts: attempts, ...(locked ? { lockedAt: new Date() } : {}) });
  await repo.insertAuthEvent(tx, {
    companyId: user.companyId,
    userId: user.id,
    username: user.username,
    event,
    ...meta,
    details: { ...details, attempt: attempts },
  });
  if (locked) {
    await repo.revokeUserSessions(tx, user.id, 'LOCKOUT');
    await repo.insertAuthEvent(tx, {
      companyId: user.companyId,
      userId: user.id,
      username: user.username,
      event: 'LOCKOUT',
      ...meta,
      details: { attempts },
    });
  }
  return { locked };
}

async function buildCurrentUser(q: Queryable, user: UserRow): Promise<CurrentUser> {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    mustChangePassword: user.mustChangePassword,
    passwordExpired: isPasswordExpired(user),
    permissions: await repo.permissionKeysForUser(q, user.id),
  };
}

async function issueTokens(tx: Tx, user: UserRow, sessionId: string, expiresAt: Date): Promise<IssuedTokens> {
  const refresh = newRefreshToken(sessionId, expiresAt);
  await repo.setSessionToken(tx, sessionId, refresh.jtiHash);
  const access = signAccessToken({ sub: user.id, sid: sessionId, cid: user.companyId });
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt.toISOString(),
    refreshToken: refresh.token,
    refreshTokenExpiresAt: expiresAt,
    user: await buildCurrentUser(tx, user),
  };
}

// ---------------------------------------------------------------- login

export async function login(input: LoginRequest, meta: RequestMeta): Promise<IssuedTokens> {
  const outcome = await withTransaction(systemContext('login'), async (tx): Promise<Outcome<IssuedTokens>> => {
    const user = await repo.findUserByUsername(tx, COMPANY_ID, input.username);
    const fail = async (u: UserRow | undefined, reason: string) =>
      repo.insertAuthEvent(tx, {
        companyId: u?.companyId ?? COMPANY_ID,
        userId: u?.id ?? null,
        username: input.username,
        event: 'LOGIN_FAIL',
        ...meta,
        details: { reason },
      });

    if (!user || user.isSystem) {
      await burnTime(input.password);
      await fail(user, user ? 'system_user' : 'unknown_user');
      return { ok: false, error: invalidCredentials() };
    }
    if (user.lockedAt) {
      await fail(user, 'locked');
      return { ok: false, error: lockedError() };
    }

    const hash = await repo.currentPasswordHash(tx, user.id);
    if (!hash || !(await verifyPassword(hash, input.password))) {
      const { locked } = await registerFailedPassword(tx, user, 'LOGIN_FAIL', meta, { reason: 'wrong_password' });
      return { ok: false, error: locked ? lockedError() : invalidCredentials() };
    }
    if (!user.isActive) {
      await fail(user, 'inactive');
      return { ok: false, error: new AppError('ACCOUNT_INACTIVE', 'This account is deactivated') };
    }

    // Verified: from here on the user is the actor in the audit trail.
    await setActor(tx, user.id);
    const now = new Date();
    await repo.updateUser(tx, user.id, { failedAttempts: 0, lastLoginAt: now });
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    const session = await repo.insertSession(tx, { companyId: user.companyId, userId: user.id, expiresAt, ...meta });
    await repo.insertAuthEvent(tx, {
      companyId: user.companyId,
      userId: user.id,
      username: user.username,
      event: 'LOGIN_OK',
      sessionId: session.id,
      ...meta,
    });
    const fresh = { ...user, failedAttempts: 0, lastLoginAt: now };
    return { ok: true, value: await issueTokens(tx, fresh, session.id, expiresAt) };
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

// ---------------------------------------------------------------- refresh (rotate on every use)

export async function refresh(refreshToken: string | undefined, meta: RequestMeta): Promise<IssuedTokens> {
  const claims = refreshToken ? verifyRefreshToken(refreshToken) : undefined;
  if (!claims) throw new AppError('UNAUTHENTICATED', 'Not signed in');

  const outcome = await withTransaction(systemContext('token refresh'), async (tx): Promise<Outcome<IssuedTokens>> => {
    const session = await repo.findSession(tx, claims.sid, true);
    if (!session) return { ok: false, error: new AppError('UNAUTHENTICATED', 'Not signed in') };
    if (session.revokedAt) return { ok: false, error: new AppError('SESSION_REVOKED', 'Session has ended; sign in again') };

    const user = await repo.findUserById(tx, session.userId);
    if (!user) return { ok: false, error: new AppError('UNAUTHENTICATED', 'Not signed in') };

    if (hashJti(claims.jti) !== session.currentTokenHash) {
      // An older refresh token was presented: assume it was stolen and end the whole session.
      await repo.revokeSession(tx, session.id, 'TOKEN_REUSE');
      await repo.insertAuthEvent(tx, {
        companyId: user.companyId,
        userId: user.id,
        username: user.username,
        event: 'TOKEN_REUSE',
        sessionId: session.id,
        ...meta,
      });
      return { ok: false, error: new AppError('SESSION_REVOKED', 'Session has ended; sign in again') };
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      return { ok: false, error: new AppError('SESSION_REVOKED', 'Session has expired; sign in again') };
    }
    if (!user.isActive || user.lockedAt) {
      await repo.revokeSession(tx, session.id, user.lockedAt ? 'LOCKOUT' : 'ADMIN');
      return { ok: false, error: new AppError('SESSION_REVOKED', 'Session has ended; sign in again') };
    }
    await setActor(tx, user.id);
    return { ok: true, value: await issueTokens(tx, user, session.id, session.expiresAt) };
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

// ---------------------------------------------------------------- logout

/** Ends the session of this refresh token. Always succeeds (logging out twice is harmless). */
export async function logout(refreshToken: string | undefined, meta: RequestMeta): Promise<void> {
  const claims = refreshToken ? verifyRefreshToken(refreshToken) : undefined;
  if (!claims) return;
  await withTransaction(systemContext('logout'), async (tx) => {
    const session = await repo.findSession(tx, claims.sid, true);
    if (!session || session.revokedAt) return;
    const user = await repo.findUserById(tx, session.userId);
    if (!user) return;
    await setActor(tx, user.id);
    await repo.revokeSession(tx, session.id, 'LOGOUT');
    await repo.insertAuthEvent(tx, {
      companyId: user.companyId,
      userId: user.id,
      username: user.username,
      event: 'LOGOUT',
      sessionId: session.id,
      ...meta,
    });
  });
}

// ---------------------------------------------------------------- access-token check (per request)

/** Resolve a bearer token to the acting user. Read-only. Throws 401 for anything not valid right now. */
export async function authenticateToken(accessToken: string): Promise<AuthContext> {
  const claims = verifyAccessToken(accessToken);
  if (!claims) throw new AppError('UNAUTHENTICATED', 'Not signed in or token expired');
  const session = await repo.findSession(db, claims.sid);
  if (!session || session.userId !== claims.sub) throw new AppError('UNAUTHENTICATED', 'Not signed in');
  if (session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
    throw new AppError('SESSION_REVOKED', 'Session has ended; sign in again');
  }
  const user = await repo.findUserById(db, claims.sub);
  if (!user || !user.isActive || user.lockedAt || user.isSystem) {
    throw new AppError('SESSION_REVOKED', 'Session has ended; sign in again');
  }
  return {
    userId: user.id,
    companyId: user.companyId,
    sessionId: session.id,
    username: user.username,
    mustChangePassword: user.mustChangePassword,
    passwordExpired: isPasswordExpired(user),
    permissions: new Set(await repo.permissionKeysForUser(db, user.id)),
  };
}

export async function currentUser(auth: AuthContext): Promise<CurrentUser> {
  const user = await repo.findUserById(db, auth.userId);
  if (!user) throw new AppError('UNAUTHENTICATED', 'Not signed in');
  return buildCurrentUser(db, user);
}

export function txContext(auth: Pick<AuthContext, 'userId' | 'companyId'>, reason?: string): TxContext {
  return { userId: auth.userId, companyId: auth.companyId, reason };
}

// ---------------------------------------------------------------- change password

export async function changePassword(auth: AuthContext, input: ChangePasswordRequest, meta: RequestMeta): Promise<void> {
  const outcome = await withTransaction(txContext(auth, 'password change'), async (tx): Promise<Outcome<void>> => {
    const user = await repo.findUserById(tx, auth.userId, true);
    if (!user) return { ok: false, error: new AppError('UNAUTHENTICATED', 'Not signed in') };

    const hash = await repo.currentPasswordHash(tx, user.id);
    if (!hash || !(await verifyPassword(hash, input.currentPassword))) {
      const { locked } = await registerFailedPassword(tx, user, 'LOGIN_FAIL', meta, { reason: 'wrong_current_password' });
      return { ok: false, error: locked ? lockedError() : invalidCredentials() };
    }
    assertPasswordPolicy(input.newPassword, user.username);
    for (const previous of await repo.recentPasswordHashes(tx, user.id, PASSWORD_HISTORY_DEPTH)) {
      if (await verifyPassword(previous, input.newPassword)) {
        return {
          ok: false,
          error: new AppError('PASSWORD_REUSED', `The new password must differ from your last ${PASSWORD_HISTORY_DEPTH} passwords`),
        };
      }
    }

    await repo.replacePassword(tx, user.id, await hashPassword(input.newPassword));
    await repo.updateUser(tx, user.id, { passwordChangedAt: new Date(), mustChangePassword: false, failedAttempts: 0 });
    // Other devices must sign in again with the new password; this session continues.
    await repo.revokeUserSessions(tx, user.id, 'PASSWORD_CHANGE', auth.sessionId);
    await repo.insertAuthEvent(tx, {
      companyId: user.companyId,
      userId: user.id,
      username: user.username,
      event: 'PASSWORD_CHANGE',
      sessionId: auth.sessionId,
      ...meta,
    });
    return { ok: true, value: undefined };
  });
  if (!outcome.ok) throw outcome.error;
}

// ---------------------------------------------------------------- admin unlock (Q5)

/** Permission (core.user.manage) is checked by the route. */
export async function unlockUser(actor: AuthContext, userId: string, meta: RequestMeta): Promise<void> {
  await withTransaction(txContext(actor, 'unlock account'), async (tx) => {
    const user = await repo.findUserById(tx, userId, true);
    if (!user || user.companyId !== actor.companyId) throw new AppError('NOT_FOUND', 'User not found');
    if (!user.lockedAt) throw new AppError('INVALID_TRANSITION', 'User is not locked');
    await repo.updateUser(tx, user.id, { lockedAt: null, failedAttempts: 0 });
    await repo.insertAuthEvent(tx, {
      companyId: user.companyId,
      userId: user.id,
      username: user.username,
      event: 'UNLOCK',
      actorId: actor.userId,
      ...meta,
    });
  });
}
