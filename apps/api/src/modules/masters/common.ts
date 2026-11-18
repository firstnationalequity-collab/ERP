// Helpers shared by the masters services.
import type { MasterListQuery, Page } from '@albert/shared';
import type { Queryable, Tx } from '../../db/client';
import { AppError } from '../../core/errors';
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

/** Only the keys the request actually sent (undefined = leave unchanged; null = clear). */
export function sent<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>;
}
