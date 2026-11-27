// Queries for user and role administration. No business rules here — see access.service.ts.
// Password hashes are never selected here (see core/auth for credentials).
import { and, asc, count, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { PermissionKey } from '@albert/shared';
import type { Queryable } from '../../db/client';
import { permissions, rolePermissions, roles, userRoles, users } from '../../db/schema/core';

/** Display names of users by id (for "created by", "posted by" … on documents of any module). */
export async function userNames(q: Queryable, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await q.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export type RoleRow = typeof roles.$inferSelect;

const userColumns = {
  id: users.id,
  companyId: users.companyId,
  username: users.username,
  fullName: users.fullName,
  email: users.email,
  isSystem: users.isSystem,
  isActive: users.isActive,
  lockedAt: users.lockedAt,
  mustChangePassword: users.mustChangePassword,
  passwordChangedAt: users.passwordChangedAt,
  lastLoginAt: users.lastLoginAt,
};
export type UserSummaryRow = {
  id: string;
  companyId: string;
  username: string;
  fullName: string;
  email: string | null;
  isSystem: boolean;
  isActive: boolean;
  lockedAt: Date | null;
  mustChangePassword: boolean;
  passwordChangedAt: Date | null;
  lastLoginAt: Date | null;
};

export async function listUsers(
  q: Queryable,
  companyId: string,
  opts: { offset: number; limit: number; search?: string },
): Promise<{ rows: UserSummaryRow[]; total: number }> {
  const conditions = [eq(users.companyId, companyId), eq(users.isSystem, false)];
  if (opts.search) {
    const like = `%${opts.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const match = or(ilike(users.username, like), ilike(users.fullName, like), ilike(users.email, like));
    if (match) conditions.push(match);
  }
  const where = and(...conditions);
  const rows = await q.select(userColumns).from(users).where(where).orderBy(asc(users.username)).limit(opts.limit).offset(opts.offset);
  const [totalRow] = await q.select({ n: count() }).from(users).where(where);
  return { rows, total: totalRow?.n ?? 0 };
}

export async function findUser(q: Queryable, companyId: string, userId: string, lock = false): Promise<UserSummaryRow | undefined> {
  const query = q.select(userColumns).from(users).where(and(eq(users.companyId, companyId), eq(users.id, userId)));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

export async function insertUser(
  q: Queryable,
  values: { username: string; fullName: string; email: string | null },
): Promise<string> {
  const [row] = await q
    .insert(users)
    .values({ ...values, mustChangePassword: true, passwordChangedAt: new Date() })
    .returning({ id: users.id });
  if (!row) throw new Error('user insert returned no row');
  return row.id;
}

export async function updateUserDetails(
  q: Queryable,
  userId: string,
  values: Partial<{ fullName: string; email: string | null; isActive: boolean; mustChangePassword: boolean; passwordChangedAt: Date }>,
): Promise<void> {
  await q.update(users).set(values).where(eq(users.id, userId));
}

export async function rolesOfUsers(
  q: Queryable,
  userIds: string[],
): Promise<Map<string, { id: string; code: string; name: string }[]>> {
  const result = new Map<string, { id: string; code: string; name: string }[]>();
  if (userIds.length === 0) return result;
  const rows = await q
    .select({ userId: userRoles.userId, id: roles.id, code: roles.code, name: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(inArray(userRoles.userId, userIds))
    .orderBy(asc(roles.code));
  for (const r of rows) {
    const list = result.get(r.userId) ?? [];
    list.push({ id: r.id, code: r.code, name: r.name });
    result.set(r.userId, list);
  }
  return result;
}

export async function roleIdsOfUser(q: Queryable, userId: string): Promise<string[]> {
  const rows = await q.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, userId));
  return rows.map((r) => r.roleId);
}

export async function addUserRoles(q: Queryable, userId: string, roleIds: string[]): Promise<void> {
  if (roleIds.length === 0) return;
  await q.insert(userRoles).values(roleIds.map((roleId) => ({ userId, roleId })));
}

export async function removeUserRoles(q: Queryable, userId: string, roleIds: string[]): Promise<void> {
  if (roleIds.length === 0) return;
  await q.delete(userRoles).where(and(eq(userRoles.userId, userId), inArray(userRoles.roleId, roleIds)));
}

// ---------------------------------------------------------------- roles

export async function listRoles(q: Queryable, companyId: string): Promise<RoleRow[]> {
  return q.select().from(roles).where(eq(roles.companyId, companyId)).orderBy(asc(roles.code));
}

export async function findRoles(q: Queryable, companyId: string, roleIds: string[]): Promise<RoleRow[]> {
  if (roleIds.length === 0) return [];
  return q.select().from(roles).where(and(eq(roles.companyId, companyId), inArray(roles.id, roleIds)));
}

export async function findRole(q: Queryable, companyId: string, roleId: string, lock = false): Promise<RoleRow | undefined> {
  const query = q.select().from(roles).where(and(eq(roles.companyId, companyId), eq(roles.id, roleId)));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

/** Permission keys per role (active keys only). */
export async function keysOfRoles(q: Queryable, roleIds: string[]): Promise<Map<string, PermissionKey[]>> {
  const result = new Map<string, PermissionKey[]>();
  if (roleIds.length === 0) return result;
  const rows = await q
    .select({ roleId: rolePermissions.roleId, key: permissions.key })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(and(inArray(rolePermissions.roleId, roleIds), eq(permissions.isActive, true)))
    .orderBy(asc(permissions.key));
  for (const r of rows) {
    const list = result.get(r.roleId) ?? [];
    list.push(r.key as PermissionKey);
    result.set(r.roleId, list);
  }
  return result;
}

export async function userCountsOfRoles(q: Queryable, roleIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (roleIds.length === 0) return result;
  const rows = await q
    .select({ roleId: userRoles.roleId, n: count() })
    .from(userRoles)
    .where(inArray(userRoles.roleId, roleIds))
    .groupBy(userRoles.roleId);
  for (const r of rows) result.set(r.roleId, r.n);
  return result;
}

export async function userIdsWithRole(q: Queryable, roleId: string): Promise<string[]> {
  const rows = await q.select({ userId: userRoles.userId }).from(userRoles).where(eq(userRoles.roleId, roleId));
  return rows.map((r) => r.userId);
}

export async function insertRole(
  q: Queryable,
  values: { code: string; name: string; description: string | null },
): Promise<string> {
  const [row] = await q.insert(roles).values(values).returning({ id: roles.id });
  if (!row) throw new Error('role insert returned no row');
  return row.id;
}

export async function updateRole(
  q: Queryable,
  roleId: string,
  values: Partial<{ name: string; description: string | null; isActive: boolean }>,
): Promise<void> {
  await q.update(roles).set(values).where(eq(roles.id, roleId));
}

export async function permissionIdsByKey(q: Queryable, keys: PermissionKey[]): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const rows = await q
    .select({ id: permissions.id, key: permissions.key })
    .from(permissions)
    .where(and(inArray(permissions.key, keys), eq(permissions.isActive, true)));
  return new Map(rows.map((r) => [r.key, r.id]));
}

export async function addRolePermissions(q: Queryable, roleId: string, permissionIds: string[]): Promise<void> {
  if (permissionIds.length === 0) return;
  await q.insert(rolePermissions).values(permissionIds.map((permissionId) => ({ roleId, permissionId })));
}

export async function removeRolePermissions(q: Queryable, roleId: string, permissionIds: string[]): Promise<void> {
  if (permissionIds.length === 0) return;
  await q
    .delete(rolePermissions)
    .where(and(eq(rolePermissions.roleId, roleId), inArray(rolePermissions.permissionId, permissionIds)));
}

export async function listPermissions(q: Queryable) {
  return q
    .select({ key: permissions.key, class: permissions.class, description: permissions.description })
    .from(permissions)
    .where(eq(permissions.isActive, true))
    .orderBy(asc(permissions.key));
}

const USER_MANAGE_KEY: PermissionKey = 'core.user.manage';

/** Active, non-system users who hold core.user.manage through an active role. */
export async function countActiveUserManagers(q: Queryable, companyId: string): Promise<number> {
  const rows = await q.execute<{ n: number }>(sql`
    SELECT count(DISTINCT u.id)::int AS n
      FROM core.users u
      JOIN core.user_roles ur ON ur.user_id = u.id
      JOIN core.roles r ON r.id = ur.role_id AND r.is_active
      JOIN core.role_permissions rp ON rp.role_id = r.id
      JOIN core.permissions p ON p.id = rp.permission_id AND p.is_active AND p.key = ${USER_MANAGE_KEY}
     WHERE u.company_id = ${companyId} AND u.is_active AND NOT u.is_system`);
  return rows.rows[0]?.n ?? 0;
}
