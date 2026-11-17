// Queries for core/auth. No business rules here — see auth.service.ts.
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { AuthEventType, PermissionKey, SessionRevokeReason } from '@albert/shared';
import type { Queryable as Tx } from '../../db/client';
import { authEvents, permissions, rolePermissions, roles, sessions, userCredentials, userRoles, users } from '../../db/schema/core';

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

export async function findUserByUsername(tx: Tx, companyId: string, username: string): Promise<UserRow | undefined> {
  const [row] = await tx
    .select()
    .from(users)
    .where(and(eq(users.companyId, companyId), sql`lower(${users.username}) = lower(${username})`))
    .for('update');
  return row;
}

export async function findUserById(tx: Tx, userId: string, lock = false): Promise<UserRow | undefined> {
  const query = tx.select().from(users).where(eq(users.id, userId));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

export async function currentPasswordHash(tx: Tx, userId: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ hash: userCredentials.passwordHash })
    .from(userCredentials)
    .where(and(eq(userCredentials.userId, userId), eq(userCredentials.isCurrent, true)));
  return row?.hash;
}

/** The most recent `limit` password hashes, newest first (includes the current one). */
export async function recentPasswordHashes(tx: Tx, userId: string, limit: number): Promise<string[]> {
  const rows = await tx
    .select({ hash: userCredentials.passwordHash })
    .from(userCredentials)
    .where(eq(userCredentials.userId, userId))
    .orderBy(desc(userCredentials.setAt), desc(userCredentials.id))
    .limit(limit);
  return rows.map((r) => r.hash);
}

export async function replacePassword(tx: Tx, userId: string, newHash: string): Promise<void> {
  await tx
    .update(userCredentials)
    .set({ isCurrent: false })
    .where(and(eq(userCredentials.userId, userId), eq(userCredentials.isCurrent, true)));
  await tx.insert(userCredentials).values({ userId, passwordHash: newHash });
}

export async function updateUser(
  tx: Tx,
  userId: string,
  values: Partial<Pick<UserRow, 'failedAttempts' | 'lockedAt' | 'lastLoginAt' | 'passwordChangedAt' | 'mustChangePassword'>>,
): Promise<void> {
  await tx.update(users).set(values).where(eq(users.id, userId));
}

export async function insertAuthEvent(
  tx: Tx,
  event: {
    companyId: string;
    userId: string | null;
    username: string;
    event: AuthEventType;
    actorId?: string | null;
    sessionId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    details?: Record<string, unknown> | null;
  },
): Promise<void> {
  await tx.insert(authEvents).values({
    companyId: event.companyId,
    userId: event.userId,
    username: event.username,
    event: event.event,
    actorId: event.actorId ?? null,
    sessionId: event.sessionId ?? null,
    ip: event.ip ?? null,
    userAgent: event.userAgent ?? null,
    details: event.details ?? null,
  });
}

export async function insertSession(
  tx: Tx,
  values: { companyId: string; userId: string; expiresAt: Date; ip: string | null; userAgent: string | null },
): Promise<SessionRow> {
  // Placeholder hash; replaced with the real token hash once the session id is known (same transaction).
  const [row] = await tx
    .insert(sessions)
    .values({ ...values, currentTokenHash: 'pending' })
    .returning();
  if (!row) throw new Error('session insert returned no row');
  return row;
}

export async function findSession(tx: Tx, sessionId: string, lock = false): Promise<SessionRow | undefined> {
  const query = tx.select().from(sessions).where(eq(sessions.id, sessionId));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

export async function setSessionToken(tx: Tx, sessionId: string, tokenHash: string): Promise<void> {
  await tx
    .update(sessions)
    .set({ currentTokenHash: tokenHash, lastUsedAt: new Date() })
    .where(eq(sessions.id, sessionId));
}

export async function revokeSession(tx: Tx, sessionId: string, reason: SessionRevokeReason): Promise<void> {
  await tx
    .update(sessions)
    .set({ revokedAt: new Date(), revokeReason: reason })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

/** Revoke every active session of a user, optionally keeping one. Returns how many were revoked. */
export async function revokeUserSessions(
  tx: Tx,
  userId: string,
  reason: SessionRevokeReason,
  exceptSessionId?: string,
): Promise<number> {
  const conditions = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
  if (exceptSessionId) conditions.push(ne(sessions.id, exceptSessionId));
  const rows = await tx
    .update(sessions)
    .set({ revokedAt: new Date(), revokeReason: reason })
    .where(and(...conditions))
    .returning({ id: sessions.id });
  return rows.length;
}

/** Active permission keys from the user's active roles. */
export async function permissionKeysForUser(tx: Tx, userId: string): Promise<PermissionKey[]> {
  const rows = await tx
    .selectDistinct({ key: permissions.key })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(and(eq(userRoles.userId, userId), eq(roles.isActive, true), eq(permissions.isActive, true)));
  return rows.map((r) => r.key as PermissionKey).sort();
}
