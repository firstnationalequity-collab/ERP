// Helpers shared by the masters services.
import type { MasterListQuery, Page, PermissionKey, WitnessSignRequest } from '@albert/shared';
import type { Queryable, Tx } from '../../db/client';
import { AppError } from '../../core/errors';
import type { AuthContext, RequestMeta } from '../../core/auth/auth.service';
import { permissionKeysForUser } from '../../core/auth/auth.repo';
import { recordSignature, verifyWitness, type SignatureProof } from '../../core/esign/esign.service';
import * as repo from './masters.repo';

/** Row → DTO: drop company_id, timestamps as ISO strings. */
export function stamped<R extends { companyId: string; createdAt: Date; updatedAt: Date }>(
  row: R,
): Omit<R, 'companyId' | 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string } {
  const { companyId: _companyId, createdAt, updatedAt, ...rest } = row;
  return { ...rest, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString() };
}

export function paging(query: MasterListQuery): repo.Paging {
  return { limit: query.pageSize, offset: (query.page - 1) * query.pageSize };
}

export function page<T>(items: T[], total: number, query: MasterListQuery): Page<T> {
  return { items, total, page: query.page, pageSize: query.pageSize };
}

export function found<T>(row: T | undefined, what: string): T {
  if (!row) throw new AppError('NOT_FOUND', `${what} not found`);
  return row;
}

/**
 * A referenced master must exist in this company and be active (customers/vendors: status ACTIVE),
 * unless `allowInactive` (e.g. keeping an existing reference unchanged).
 */
export async function assertReference(
  q: Queryable,
  entity: string,
  companyId: string,
  id: string,
  label: string,
  opts: { allowInactive?: boolean } = {},
): Promise<void> {
  const state = await repo.referenceState(q, entity, companyId, id);
  if (state === undefined) throw new AppError('VALIDATION_FAILED', `${label} does not exist`, { field: label, id });
  if (!state && !opts.allowInactive) throw new AppError('VALIDATION_FAILED', `${label} is not active`, { field: label, id });
}

/** Activate / deactivate a master that has an is_active flag (not customers/vendors: they use status). */
export async function setActive(tx: Tx, entity: string, companyId: string, id: string, active: boolean, label: string): Promise<void> {
  const current = await repo.lockActiveFlag(tx, entity, companyId, id);
  if (current === undefined) throw new AppError('NOT_FOUND', `${label} not found`);
  if (current === active) throw new AppError('INVALID_TRANSITION', `${label} is already ${active ? 'active' : 'inactive'}`);
  await repo.setActiveFlag(tx, entity, id, active);
}

// ---------------------------------------------------------------- countersign (a second person signs in the same request)

/** Verify the countersigner's password before the business transaction, so failures are counted. */
export async function verifyCountersign(
  auth: AuthContext,
  countersign: WitnessSignRequest | undefined,
  meta: RequestMeta,
): Promise<SignatureProof | undefined> {
  if (!countersign) return undefined;
  if (countersign.meaning !== 'APPROVED') throw new AppError('ESIGN_FAILED', 'A countersign must have the meaning APPROVED');
  return verifyWitness(auth, countersign, meta);
}

/**
 * Inside the transaction: refuse without a countersign (COUNTERSIGN_REQUIRED) or when the countersigner does not
 * hold `key` (FORBIDDEN); otherwise store it as an APPROVED e-signature on the record. The DB guards check the
 * signature at commit.
 */
export async function applyCountersign(
  tx: Tx,
  proof: SignatureProof | undefined,
  record: { table: string; id: string },
  key: PermissionKey,
  requiredMessage: string,
  fields: string[],
): Promise<void> {
  if (!proof) throw new AppError('COUNTERSIGN_REQUIRED', requiredMessage, { fields, permission: key });
  if (!(await permissionKeysForUser(tx, proof.userId)).includes(key)) {
    throw new AppError('FORBIDDEN', `The countersigner does not hold ${key}`, { permission: key });
  }
  await recordSignature(tx, proof, record, ['APPROVED']);
}

/** Only the keys the request actually sent (undefined = leave unchanged; null = clear). */
export function sent<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>;
}
