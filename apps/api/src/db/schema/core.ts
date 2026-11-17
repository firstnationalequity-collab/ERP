// Drizzle description of the `core` schema. Source of truth: src/db/migrations/0001_core_identity.sql.
import { boolean, integer, jsonb, pgSchema, text } from 'drizzle-orm/pg-core';
import type { AuthEventType, PermissionClass, SessionRevokeReason } from '@albert/shared';
import { auditColumns, bigintString, companyId, identityId, tstz } from './columns';

export const core = pgSchema('core');

export const companies = core.table('companies', {
  id: identityId(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  ntn: text('ntn'),
  strn: text('strn'),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

export const users = core.table('users', {
  id: identityId(),
  companyId: companyId(),
  username: text('username').notNull(),
  fullName: text('full_name').notNull(),
  email: text('email'),
  isSystem: boolean('is_system').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedAt: tstz('locked_at'),
  passwordChangedAt: tstz('password_changed_at'),
  mustChangePassword: boolean('must_change_password').notNull().default(true),
  lastLoginAt: tstz('last_login_at'),
  ...auditColumns(),
});

/** Never audited; never returned by an API. Only core/auth reads it. */
export const userCredentials = core.table('user_credentials', {
  id: identityId(),
  companyId: companyId(),
  userId: bigintString('user_id').notNull(),
  passwordHash: text('password_hash').notNull(),
  isCurrent: boolean('is_current').notNull().default(true),
  setAt: tstz('set_at').notNull().defaultNow(),
  ...auditColumns(),
});

export const sessions = core.table('sessions', {
  id: identityId(),
  companyId: companyId(),
  userId: bigintString('user_id').notNull(),
  currentTokenHash: text('current_token_hash').notNull(),
  issuedAt: tstz('issued_at').notNull().defaultNow(),
  lastUsedAt: tstz('last_used_at').notNull().defaultNow(),
  expiresAt: tstz('expires_at').notNull(),
  revokedAt: tstz('revoked_at'),
  revokeReason: text('revoke_reason').$type<SessionRevokeReason>(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  ...auditColumns(),
});

export const authEvents = core.table('auth_events', {
  id: identityId(),
  companyId: companyId(),
  userId: bigintString('user_id'),
  username: text('username').notNull(),
  event: text('event').$type<AuthEventType>().notNull(),
  actorId: bigintString('actor_id'),
  sessionId: bigintString('session_id'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  details: jsonb('details').$type<Record<string, unknown>>(),
  at: tstz('at').notNull().defaultNow(),
});

export const permissions = core.table('permissions', {
  id: identityId(),
  key: text('key').notNull(),
  class: text('class').$type<PermissionClass>().notNull(),
  description: text('description').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

export const roles = core.table('roles', {
  id: identityId(),
  companyId: companyId(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

export const rolePermissions = core.table('role_permissions', {
  id: identityId(),
  companyId: companyId(),
  roleId: bigintString('role_id').notNull(),
  permissionId: bigintString('permission_id').notNull(),
  ...auditColumns(),
});

export const userRoles = core.table('user_roles', {
  id: identityId(),
  companyId: companyId(),
  userId: bigintString('user_id').notNull(),
  roleId: bigintString('role_id').notNull(),
  ...auditColumns(),
});

export const auditLog = core.table('audit_log', {
  id: identityId(),
  tableName: text('table_name').notNull(),
  recordId: text('record_id').notNull(),
  action: text('action').$type<'INSERT' | 'UPDATE' | 'DELETE'>().notNull(),
  oldData: jsonb('old_data'),
  newData: jsonb('new_data'),
  changedBy: bigintString('changed_by'),
  reason: text('reason'),
  changedAt: tstz('changed_at').notNull().defaultNow(),
  txId: bigintString('tx_id').notNull(),
});
