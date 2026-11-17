// Audit trail viewer and settings (docs/architecture.md §7.1: "audit trail viewer (filter by table, record,
// user, date)"). Dates are business dates 'YYYY-MM-DD', read as whole days in Asia/Karachi.
import { z } from 'zod';
import type { AuthEventType, SignatureMeaning } from '../../enums';

const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date as YYYY-MM-DD');

export const AuditLogQuery = z
  .object({
    table: z.string().regex(/^[a-z_]+\.[a-z_]+$/).optional(),
    recordId: z.string().max(40).optional(),
    userId: z.string().regex(/^\d+$/).optional(),
    action: z.enum(['INSERT', 'UPDATE', 'DELETE']).optional(),
    from: businessDate.optional(),
    to: businessDate.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((q) => !q.recordId || q.table, { message: 'recordId needs table', path: ['recordId'] })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must not be after to', path: ['from'] });
export type AuditLogQuery = z.infer<typeof AuditLogQuery>;

export interface AuditFieldChange {
  field: string;
  old: unknown;
  new: unknown;
}

export interface AuditEntryDto {
  id: string;
  table: string;
  recordId: string;
  action: 'INSERT' | 'UPDATE' | 'DELETE';
  changedAt: string;
  changedBy: { id: string; username: string; fullName: string } | null;
  reason: string | null;
  /** For UPDATE: only the fields that changed (updated_at/updated_by left out). */
  changes: AuditFieldChange[];
  oldData: Record<string, unknown> | null;
  newData: Record<string, unknown> | null;
}

export const RecordQuery = z.object({
  table: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
  recordId: z.string().regex(/^\d+$/),
});
export type RecordQuery = z.infer<typeof RecordQuery>;

export interface StatusHistoryDto {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  at: string;
  actor: { id: string; fullName: string };
  reason: string | null;
  signature: { meaning: SignatureMeaning; signerName: string } | null;
  witness: { meaning: SignatureMeaning; signerName: string } | null;
}

export interface ESignatureDto {
  id: string;
  signerUsername: string;
  signerName: string;
  meaning: SignatureMeaning;
  reason: string;
  signedAt: string;
}

export const AuthEventQuery = z.object({
  userId: z.string().regex(/^\d+$/).optional(),
  event: z.string().regex(/^[A-Z_]+$/).optional(),
  from: businessDate.optional(),
  to: businessDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuthEventQuery = z.infer<typeof AuthEventQuery>;

export interface AuthEventDto {
  id: string;
  at: string;
  event: AuthEventType;
  username: string;
  userId: string | null;
  actorId: string | null;
  ip: string | null;
  details: Record<string, unknown> | null;
}

// ---------------------------------------------------------------- settings

export interface SettingDto {
  key: string;
  description: string;
  value: unknown;
  defaultValue: unknown;
  isDefault: boolean;
}

export const UpdateSettingRequest = z.object({ value: z.unknown(), reason: z.string().trim().min(3).max(500) }).strict();
export type UpdateSettingRequest = z.infer<typeof UpdateSettingRequest>;
