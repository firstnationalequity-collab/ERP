// Drizzle description of the `core` schema. Source of truth: src/db/migrations/0001_core_identity.sql.
import { sql } from 'drizzle-orm';
import { boolean, date, integer, jsonb, numeric, pgSchema, text } from 'drizzle-orm/pg-core';
import type {
  ApprovalMeasure,
  ApprovalStatus,
  ApprovalStepStatus,
  AuthEventType,
  FiscalPeriodStatus,
  NumberSeriesReset,
  PermissionClass,
  SessionRevokeReason,
  SignatureMeaning,
} from '@albert/shared';
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

// ---- 0002_esign_transition.sql

export const eSignatures = core.table('e_signatures', {
  id: identityId(),
  companyId: companyId(),
  userId: bigintString('user_id').notNull(),
  signerUsername: text('signer_username').notNull(),
  signerName: text('signer_name').notNull(),
  meaning: text('meaning').$type<SignatureMeaning>().notNull(),
  reason: text('reason').notNull(),
  recordTable: text('record_table').notNull(),
  recordId: text('record_id').notNull(),
  signedAt: tstz('signed_at').notNull().defaultNow(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  txId: bigintString('tx_id').notNull().default(sql`txid_current()`),
  ...auditColumns(),
});

export const statusHistory = core.table('status_history', {
  id: identityId(),
  companyId: companyId(),
  entityTable: text('entity_table').notNull(),
  entityId: text('entity_id').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  actorId: bigintString('actor_id').notNull(),
  esignId: bigintString('esign_id'),
  witnessEsignId: bigintString('witness_esign_id'),
  reason: text('reason'),
  at: tstz('at').notNull().defaultNow(),
  txId: bigintString('tx_id').notNull().default(sql`txid_current()`),
});

// ---- 0003_numbering_periods.sql

export const numberSeries = core.table('number_series', {
  id: identityId(),
  companyId: companyId(),
  docType: text('doc_type').notNull(),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  pattern: text('pattern').notNull(),
  reset: text('reset').$type<NumberSeriesReset>().notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

export const numberSeriesCounters = core.table('number_series_counters', {
  id: identityId(),
  companyId: companyId(),
  seriesId: bigintString('series_id').notNull(),
  periodKey: text('period_key').notNull(),
  nextValue: bigintString('next_value').notNull(),
  ...auditColumns(),
});

export const fiscalPeriods = core.table('fiscal_periods', {
  id: identityId(),
  companyId: companyId(),
  fiscalYear: text('fiscal_year').notNull(),
  periodNo: integer('period_no').notNull(),
  name: text('name').notNull(),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }).notNull(),
  status: text('status').$type<FiscalPeriodStatus>().notNull(),
  ...auditColumns(),
});

// ---- 0004_approvals.sql (NUMERIC columns are strings; use decimal.js for arithmetic)

export const approvalRules = core.table('approval_rules', {
  id: identityId(),
  companyId: companyId(),
  docType: text('doc_type').notNull(),
  measure: text('measure').$type<ApprovalMeasure>().notNull(),
  lowerBound: numeric('lower_bound', { precision: 18, scale: 4 }),
  upperBound: numeric('upper_bound', { precision: 18, scale: 4 }),
  stepNo: integer('step_no').notNull(),
  roleId: bigintString('role_id').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

export const approvals = core.table('approvals', {
  id: identityId(),
  companyId: companyId(),
  docType: text('doc_type').notNull(),
  docTable: text('doc_table').notNull(),
  docId: text('doc_id').notNull(),
  docNo: text('doc_no'),
  measure: text('measure').$type<ApprovalMeasure>().notNull(),
  amount: numeric('amount', { precision: 18, scale: 2 }),
  currency: text('currency'),
  exchangeRate: numeric('exchange_rate', { precision: 9, scale: 4 }),
  measuredValue: numeric('measured_value', { precision: 18, scale: 4 }),
  requestedBy: bigintString('requested_by').notNull(),
  status: text('status').$type<ApprovalStatus>().notNull(),
  decidedAt: tstz('decided_at'),
  ...auditColumns(),
});

export const approvalSteps = core.table('approval_steps', {
  id: identityId(),
  companyId: companyId(),
  approvalId: bigintString('approval_id').notNull(),
  stepNo: integer('step_no').notNull(),
  roleId: bigintString('role_id').notNull(),
  ruleId: bigintString('rule_id'),
  status: text('status').$type<ApprovalStepStatus>().notNull(),
  actedBy: bigintString('acted_by'),
  actedAt: tstz('acted_at'),
  esignId: bigintString('esign_id'),
  ...auditColumns(),
});

// ---- 0005_idempotency_attachments.sql

export const idempotencyKeys = core.table('idempotency_keys', {
  id: identityId(),
  companyId: companyId(),
  userId: bigintString('user_id').notNull(),
  key: text('key').notNull(),
  endpoint: text('endpoint').notNull(),
  requestHash: text('request_hash').notNull(),
  status: text('status').$type<'IN_PROGRESS' | 'COMPLETED'>().notNull(),
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body'),
  expiresAt: tstz('expires_at').notNull().default(sql`now() + interval '24 hours'`),
  completedAt: tstz('completed_at'),
  ...auditColumns(),
});

export const attachments = core.table('attachments', {
  id: identityId(),
  companyId: companyId(),
  recordTable: text('record_table').notNull(),
  recordId: text('record_id').notNull(),
  fileName: text('file_name').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: bigintString('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  storageDriver: text('storage_driver').$type<'local' | 's3'>().notNull(),
  storageKey: text('storage_key').notNull(),
  description: text('description'),
  ...auditColumns(),
});

// ---- 0006_settings_audit_indexes.sql

export const settings = core.table('settings', {
  id: identityId(),
  companyId: companyId(),
  key: text('key').notNull(),
  value: jsonb('value').notNull(),
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
