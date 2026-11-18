// User and role administration. Rules (docs/architecture.md §3; decisions Q1, Q5–Q7, Q14, roles review):
//  - nobody changes their own role assignments (also enforced in the DB);
//  - a role holding an admin key never holds an action key (also enforced in the DB);
//  - any change to a role holding a QA-controlled key (`qaControlled` in permissions.ts) — its bundle, its activation, or who holds it —
//    needs a QA Manager countersign (qa.access.countersign). The countersigner is a different person from
//    the admin, is not the user whose roles change, and does not hold the role being changed;
//  - the last active user who can manage users cannot be removed, deactivated or stripped of that key.
// The permission to call each function (core.user.manage / core.role.manage) is checked by the routes.
import {
  Permissions,
  isQaControlledKey,
  type CreateRoleRequest,
  type CreateUserRequest,
  type ListQuery,
  type Page,
  type PermissionDto,
  type PermissionKey,
  type ResetPasswordRequest,
  type RoleActionRequest,
  type RoleDto,
  type SetRolePermissionsRequest,
  type SetUserRolesRequest,
  type UpdateRoleRequest,
  type UpdateUserRequest,
  type UserDto,
  type WitnessSignRequest,
} from '@albert/shared';
import { sql } from 'drizzle-orm';
import { db, withTransaction, type Tx } from '../../db/client';
import { AppError } from '../errors';
import { isPasswordExpired, txContext, type AuthContext, type RequestMeta } from '../auth/auth.service';
import * as authRepo from '../auth/auth.repo';
import { assertPasswordPolicy, hashPassword } from '../auth/password';
import { recordSignature, verifyWitness, type SignatureProof } from '../esign/esign.service';
import * as repo from './access.repo';
import type { UserSummaryRow } from './access.repo';

const COUNTERSIGN_KEY: PermissionKey = 'qa.access.countersign';

// ---------------------------------------------------------------- helpers

function toUserDto(row: UserSummaryRow, roleList: { id: string; code: string; name: string }[]): UserDto {
  return {
    id: row.id,
    username: row.username,
    fullName: row.fullName,
    email: row.email,
    isActive: row.isActive,
    isLocked: row.lockedAt !== null,
    mustChangePassword: row.mustChangePassword,
    passwordExpired: isPasswordExpired(row),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    roles: roleList,
  };
}

function hasQualityKey(keys: Iterable<PermissionKey>): boolean {
  for (const k of keys) if (isQaControlledKey(k)) return true;
  return false;
}

function assertNoAdminActionMix(keys: PermissionKey[]): void {
  const classes = new Set(keys.map((k) => Permissions[k].class));
  if (classes.has('ADMIN') && classes.has('ACTION')) {
    throw new AppError('ROLE_ADMIN_CONFLICT', 'A role with an admin key cannot hold action keys', {
      admin: keys.filter((k) => Permissions[k].class === 'ADMIN'),
      action: keys.filter((k) => Permissions[k].class === 'ACTION'),
    });
  }
}

async function assertUserManagerRemains(tx: Tx, companyId: string): Promise<void> {
  if ((await repo.countActiveUserManagers(tx, companyId)) === 0) {
    throw new AppError('LAST_ADMIN', 'This change would leave nobody able to manage users');
  }
}

/** Verify the countersign password before the business transaction (failures must be counted). */
async function verifyCountersign(
  auth: AuthContext,
  countersign: WitnessSignRequest | undefined,
  meta: RequestMeta,
): Promise<SignatureProof | undefined> {
  if (!countersign) return undefined;
  if (countersign.meaning !== 'APPROVED') {
    throw new AppError('ESIGN_FAILED', 'A countersign must have the meaning APPROVED');
  }
  return verifyWitness(auth, countersign, meta);
}

/**
 * Inside the business transaction: require and record the QA countersign when `needed`.
 * `excludedUserIds` = people who may not countersign this change (the user whose roles change,
 * or the holders of the role being changed).
 */
async function applyCountersign(
  tx: Tx,
  proof: SignatureProof | undefined,
  needed: boolean,
  record: { table: string; id: string },
  excludedUserIds: readonly string[],
): Promise<string | undefined> {
  if (!needed && !proof) return undefined;
  if (needed && !proof) {
    throw new AppError('COUNTERSIGN_REQUIRED', 'This change touches QA-controlled keys and needs a QA Manager countersign', {
      permission: COUNTERSIGN_KEY,
    });
  }
  if (!proof) return undefined;
  if (excludedUserIds.includes(proof.userId)) {
    throw new AppError('SEGREGATION_OF_DUTIES', 'The countersigner cannot countersign a change to their own roles');
  }
  const witnessKeys = await authRepo.permissionKeysForUser(tx, proof.userId);
  if (!witnessKeys.includes(COUNTERSIGN_KEY)) {
    throw new AppError('FORBIDDEN', `The countersigner does not hold ${COUNTERSIGN_KEY}`, { permission: COUNTERSIGN_KEY });
  }
  const signature = await recordSignature(tx, proof, record, ['APPROVED']);
  return signature.id;
}

function auditReason(reason: string, countersignId: string | undefined): string {
  return countersignId ? `${reason} [countersign e-signature ${countersignId}]` : reason;
}

/** Record the reason (and countersign) for every audit row written after this point in the transaction. */
async function setAuditReason(tx: Tx, reason: string): Promise<void> {
  await tx.execute(sql`select set_config('app.reason', ${reason}, true)`);
}

// ---------------------------------------------------------------- users

export async function listUsers(auth: AuthContext, query: ListQuery): Promise<Page<UserDto>> {
  const { rows, total } = await repo.listUsers(db, auth.companyId, {
    offset: (query.page - 1) * query.pageSize,
    limit: query.pageSize,
    search: query.search,
  });
  const roleMap = await repo.rolesOfUsers(db, rows.map((r) => r.id));
  return { items: rows.map((r) => toUserDto(r, roleMap.get(r.id) ?? [])), total, page: query.page, pageSize: query.pageSize };
}

async function loadUser(q: Tx | typeof db, auth: AuthContext, userId: string, lock = false): Promise<UserSummaryRow> {
  const row = await repo.findUser(q, auth.companyId, userId, lock);
  if (!row || row.isSystem) throw new AppError('NOT_FOUND', 'User not found');
  return row;
}

export async function getUser(auth: AuthContext, userId: string): Promise<UserDto> {
  const row = await loadUser(db, auth, userId);
  const roleMap = await repo.rolesOfUsers(db, [row.id]);
  return toUserDto(row, roleMap.get(row.id) ?? []);
}

export async function createUser(auth: AuthContext, input: CreateUserRequest): Promise<UserDto> {
  assertPasswordPolicy(input.temporaryPassword, input.username);
  const hash = await hashPassword(input.temporaryPassword);
  const id = await withTransaction(txContext(auth, 'create user'), async (tx) => {
    const userId = await repo.insertUser(tx, { username: input.username, fullName: input.fullName, email: input.email ?? null });
    await authRepo.replacePassword(tx, userId, hash);
    return userId;
  });
  return getUser(auth, id);
}

export async function updateUser(auth: AuthContext, userId: string, input: UpdateUserRequest): Promise<UserDto> {
  await withTransaction(txContext(auth, 'update user details'), async (tx) => {
    await loadUser(tx, auth, userId, true);
    await repo.updateUserDetails(tx, userId, input);
  });
  return getUser(auth, userId);
}

export async function setUserActive(auth: AuthContext, userId: string, active: boolean): Promise<UserDto> {
  if (userId === auth.userId) throw new AppError('FORBIDDEN', 'You cannot activate or deactivate your own account');
  await withTransaction(txContext(auth, active ? 'activate user' : 'deactivate user'), async (tx) => {
    const user = await loadUser(tx, auth, userId, true);
    if (user.isActive === active) {
      throw new AppError('INVALID_TRANSITION', active ? 'User is already active' : 'User is already inactive');
    }
    await repo.updateUserDetails(tx, userId, { isActive: active });
    if (!active) {
      await authRepo.revokeUserSessions(tx, userId, 'ADMIN');
      await assertUserManagerRemains(tx, auth.companyId);
    }
  });
  return getUser(auth, userId);
}

export async function resetPassword(
  auth: AuthContext,
  userId: string,
  input: ResetPasswordRequest,
  meta: RequestMeta,
): Promise<void> {
  if (userId === auth.userId) throw new AppError('FORBIDDEN', 'Use change password for your own account');
  const target = await loadUser(db, auth, userId);
  assertPasswordPolicy(input.temporaryPassword, target.username);
  const hash = await hashPassword(input.temporaryPassword);
  await withTransaction(txContext(auth, 'admin password reset'), async (tx) => {
    const user = await loadUser(tx, auth, userId, true);
    await authRepo.replacePassword(tx, user.id, hash);
    await repo.updateUserDetails(tx, user.id, { mustChangePassword: true, passwordChangedAt: new Date() });
    await authRepo.revokeUserSessions(tx, user.id, 'ADMIN');
    await authRepo.insertAuthEvent(tx, {
      companyId: user.companyId,
      userId: user.id,
      username: user.username,
      event: 'PASSWORD_CHANGE',
      actorId: auth.userId,
      ...meta,
      details: { reset: true },
    });
  });
}

export async function setUserRoles(
  auth: AuthContext,
  userId: string,
  input: SetUserRolesRequest,
  meta: RequestMeta,
): Promise<UserDto> {
  if (userId === auth.userId) throw new AppError('SELF_ROLE_CHANGE', 'You cannot change your own role assignments');
  const proof = await verifyCountersign(auth, input.countersign, meta);

  await withTransaction(txContext(auth, input.reason), async (tx) => {
    await loadUser(tx, auth, userId, true);
    const wanted = [...new Set(input.roleIds)];
    const found = await repo.findRoles(tx, auth.companyId, wanted);
    if (found.length !== wanted.length) {
      throw new AppError('NOT_FOUND', 'One or more roles were not found', {
        missing: wanted.filter((id) => !found.some((r) => r.id === id)),
      });
    }
    const current = await repo.roleIdsOfUser(tx, userId);
    const added = wanted.filter((id) => !current.includes(id));
    const removed = current.filter((id) => !wanted.includes(id));
    if (added.length === 0 && removed.length === 0) return;

    const keyMap = await repo.keysOfRoles(tx, [...added, ...removed]);
    const touchesQuality = [...added, ...removed].some((id) => hasQualityKey(keyMap.get(id) ?? []));
    const countersignId = await applyCountersign(tx, proof, touchesQuality, { table: 'core.users', id: userId }, [userId]);
    await setAuditReason(tx, auditReason(input.reason, countersignId));

    await repo.removeUserRoles(tx, userId, removed);
    await repo.addUserRoles(tx, userId, added);
    if (removed.length > 0) await assertUserManagerRemains(tx, auth.companyId);
  });
  return getUser(auth, userId);
}

// ---------------------------------------------------------------- roles

async function toRoleDtos(q: Tx | typeof db, rows: repo.RoleRow[]): Promise<RoleDto[]> {
  const ids = rows.map((r) => r.id);
  const keyMap = await repo.keysOfRoles(q, ids);
  const counts = await repo.userCountsOfRoles(q, ids);
  return rows.map((r) => {
    const keys = keyMap.get(r.id) ?? [];
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      isActive: r.isActive,
      keys,
      userCount: counts.get(r.id) ?? 0,
      needsCountersign: hasQualityKey(keys),
    };
  });
}

export async function listRoles(auth: AuthContext): Promise<RoleDto[]> {
  return toRoleDtos(db, await repo.listRoles(db, auth.companyId));
}

export async function getRole(auth: AuthContext, roleId: string): Promise<RoleDto> {
  const row = await repo.findRole(db, auth.companyId, roleId);
  if (!row) throw new AppError('NOT_FOUND', 'Role not found');
  const [dto] = await toRoleDtos(db, [row]);
  if (!dto) throw new AppError('NOT_FOUND', 'Role not found');
  return dto;
}

export async function listPermissions(): Promise<PermissionDto[]> {
  const rows = await repo.listPermissions(db);
  return rows.map((r) => ({ key: r.key as PermissionKey, class: r.class, description: r.description }));
}

async function replaceRoleKeys(tx: Tx, roleId: string, from: PermissionKey[], to: PermissionKey[]): Promise<void> {
  const added = to.filter((k) => !from.includes(k));
  const removed = from.filter((k) => !to.includes(k));
  const ids = await repo.permissionIdsByKey(tx, [...added, ...removed]);
  const missing = [...added, ...removed].filter((k) => !ids.has(k));
  if (missing.length > 0) throw new AppError('NOT_FOUND', 'Unknown or inactive permission keys', { missing });
  // Remove first, so swapping an admin key for an action key is judged on the final bundle.
  await repo.removeRolePermissions(tx, roleId, removed.map((k) => ids.get(k)!));
  await repo.addRolePermissions(tx, roleId, added.map((k) => ids.get(k)!));
}

export async function createRole(auth: AuthContext, input: CreateRoleRequest, meta: RequestMeta): Promise<RoleDto> {
  const keys = [...new Set(input.keys)];
  assertNoAdminActionMix(keys);
  const proof = await verifyCountersign(auth, input.countersign, meta);
  const roleId = await withTransaction(txContext(auth, input.reason), async (tx) => {
    const id = await repo.insertRole(tx, { code: input.code, name: input.name, description: input.description ?? null });
    const countersignId = await applyCountersign(tx, proof, hasQualityKey(keys), { table: 'core.roles', id }, []);
    await setAuditReason(tx, auditReason(input.reason, countersignId));
    await replaceRoleKeys(tx, id, [], keys);
    return id;
  });
  return getRole(auth, roleId);
}

export async function updateRole(auth: AuthContext, roleId: string, input: UpdateRoleRequest): Promise<RoleDto> {
  await withTransaction(txContext(auth, 'update role details'), async (tx) => {
    const role = await repo.findRole(tx, auth.companyId, roleId, true);
    if (!role) throw new AppError('NOT_FOUND', 'Role not found');
    await repo.updateRole(tx, roleId, input);
  });
  return getRole(auth, roleId);
}

export async function setRolePermissions(
  auth: AuthContext,
  roleId: string,
  input: SetRolePermissionsRequest,
  meta: RequestMeta,
): Promise<RoleDto> {
  const keys = [...new Set(input.keys)];
  assertNoAdminActionMix(keys);
  const proof = await verifyCountersign(auth, input.countersign, meta);
  await withTransaction(txContext(auth, input.reason), async (tx) => {
    const role = await repo.findRole(tx, auth.companyId, roleId, true);
    if (!role) throw new AppError('NOT_FOUND', 'Role not found');
    const current = (await repo.keysOfRoles(tx, [roleId])).get(roleId) ?? [];
    const unchanged = current.length === keys.length && keys.every((k) => current.includes(k));
    if (unchanged) return;

    const holders = await repo.userIdsWithRole(tx, roleId);
    const needed = hasQualityKey(current) || hasQualityKey(keys);
    const countersignId = await applyCountersign(tx, proof, needed, { table: 'core.roles', id: roleId }, holders);
    await setAuditReason(tx, auditReason(input.reason, countersignId));
    await replaceRoleKeys(tx, roleId, current, keys);
    await assertUserManagerRemains(tx, auth.companyId);
  });
  return getRole(auth, roleId);
}

export async function setRoleActive(
  auth: AuthContext,
  roleId: string,
  active: boolean,
  input: RoleActionRequest,
  meta: RequestMeta,
): Promise<RoleDto> {
  const proof = await verifyCountersign(auth, input.countersign, meta);
  await withTransaction(txContext(auth, input.reason), async (tx) => {
    const role = await repo.findRole(tx, auth.companyId, roleId, true);
    if (!role) throw new AppError('NOT_FOUND', 'Role not found');
    if (role.isActive === active) {
      throw new AppError('INVALID_TRANSITION', active ? 'Role is already active' : 'Role is already inactive');
    }
    const keys = (await repo.keysOfRoles(tx, [roleId])).get(roleId) ?? [];
    const holders = await repo.userIdsWithRole(tx, roleId);
    const countersignId = await applyCountersign(tx, proof, hasQualityKey(keys), { table: 'core.roles', id: roleId }, holders);
    await setAuditReason(tx, auditReason(input.reason, countersignId));
    await repo.updateRole(tx, roleId, { isActive: active });
    if (!active) await assertUserManagerRemains(tx, auth.companyId);
  });
  return getRole(auth, roleId);
}
