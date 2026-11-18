// Master data the inventory engine needs, exported so engines/inventory never reads master tables itself
// (CLAUDE.md "Modules talk to each other only through exported service functions"). Run inside the caller's
// transaction; no permission checks here (the calling module's route did them).
import type { ItemStatus, ItemType } from '@albert/shared';
import type { Queryable } from '../../db/client';
import { AppError } from '../../core/errors';
import * as repo from './masters.repo';

export interface StockItemRef {
  id: string;
  code: string;
  type: ItemType;
  categoryId: string;
  status: ItemStatus;
}

/** The item a lot belongs to: type (FG or material) and category (posting rules are per category). */
export async function stockItem(q: Queryable, companyId: string, itemId: string): Promise<StockItemRef> {
  const row = await repo.findItem(q, companyId, itemId);
  if (!row) throw new AppError('NOT_FOUND', `Item ${itemId} not found`);
  return { id: row.id, code: row.code, type: row.type, categoryId: row.categoryId, status: row.status };
}

/** A location stock moves through: must exist in the company; stock only goes INTO an active one. */
export async function assertStockLocation(q: Queryable, companyId: string, locationId: string, inbound: boolean): Promise<void> {
  const row = await repo.findLocation(q, companyId, locationId);
  if (!row) throw new AppError('NOT_FOUND', `Location ${locationId} not found`);
  if (inbound && !row.isActive) {
    throw new AppError('VALIDATION_FAILED', `Location ${row.code} is inactive; stock cannot be put into it`, { locationId });
  }
}

/** Customer returns are received only into a returns area (owner 2026-11-18, Q9; 0017). */
export async function assertReturnsArea(q: Queryable, companyId: string, locationId: string): Promise<void> {
  const row = await repo.findLocation(q, companyId, locationId);
  if (!row) throw new AppError('NOT_FOUND', `Location ${locationId} not found`);
  if (!row.isReturnsArea) {
    throw new AppError('VALIDATION_FAILED', `Location ${row.code} is not a returns area; customer returns are received into one`, { locationId });
  }
}

/** Customer-owned (toll) stock belongs to an ACTIVE toll customer (rule 12). */
export async function assertTollCustomer(q: Queryable, companyId: string, customerId: string): Promise<void> {
  const row = await repo.findCustomer(q, companyId, customerId);
  if (!row) throw new AppError('NOT_FOUND', `Customer ${customerId} not found`);
  if (row.status !== 'ACTIVE' || !row.isTollCustomer) {
    throw new AppError('VALIDATION_FAILED', `Customer ${row.code} is not an ACTIVE toll customer; it cannot own stock`, { customerId });
  }
}

/**
 * The customer named on a dispatch or a customer return must exist in the company (0018). A customer return may
 * come from an inactive customer; a dispatch goes only to an ACTIVE one (owner 2026-11-18; 0019).
 */
export async function assertCustomerFor(q: Queryable, companyId: string, customerId: string, use: 'DISPATCH' | 'SALES_RETURN'): Promise<void> {
  const row = await repo.findCustomer(q, companyId, customerId);
  if (!row) throw new AppError('NOT_FOUND', `Customer ${customerId} not found`);
  if (use === 'DISPATCH' && row.status !== 'ACTIVE') {
    throw new AppError('CUSTOMER_NOT_ACTIVE', `Customer ${row.code} is ${row.status}; goods are dispatched only to an ACTIVE customer`, {
      customerId,
      status: row.status,
    });
  }
}
