// Master data the procurement module needs, exported so modules/procurement never reads master tables itself
// (CLAUDE.md "Modules talk to each other only through exported service functions"). Run inside the caller's
// query or transaction; no permission checks here (the calling module's route did them).
import { AvlItemTypes, type ItemStatus, type ItemType, type PartyStatus } from '@albert/shared';
import type { Queryable } from '../../db/client';
import { AppError } from '../../core/errors';
import * as repo from './purch-refs.repo';

export interface PurchVendorRef {
  id: string;
  code: string;
  name: string;
  status: PartyStatus;
  currency: string;
  isForeign: boolean;
}

export interface PurchItemRef {
  id: string;
  code: string;
  name: string;
  type: ItemType;
  status: ItemStatus;
  uomCode: string;
}

export async function purchVendors(q: Queryable, companyId: string, ids: string[]): Promise<Map<string, PurchVendorRef>> {
  const rows = await repo.vendorsByIds(q, companyId, [...new Set(ids)]);
  return new Map(rows.map((r) => [r.id, r]));
}

export async function purchItems(q: Queryable, companyId: string, ids: string[]): Promise<Map<string, PurchItemRef>> {
  const rows = await repo.itemsByIds(q, companyId, [...new Set(ids)]);
  return new Map(rows.map((r) => [r.id, r]));
}

/** The vendor of a purchase document: must exist and be ACTIVE (VENDOR_NOT_ACTIVE). */
export async function assertPurchVendor(q: Queryable, companyId: string, vendorId: string): Promise<PurchVendorRef> {
  const v = (await purchVendors(q, companyId, [vendorId])).get(vendorId);
  if (!v) throw new AppError('VALIDATION_FAILED', 'Vendor does not exist', { field: 'vendorId', id: vendorId });
  if (v.status !== 'ACTIVE') throw new AppError('VENDOR_NOT_ACTIVE', `Vendor ${v.code} is not active`, { vendorId });
  return v;
}

/**
 * Items on a requisition or PO: must exist, be ACTIVE and be bought (not BULK or FG, unless the buyer's
 * setting purch.allow_bulk_fg_purchase is on: owner 2026-11-25, answer 6; the caller reads it).
 */
export async function assertPurchItems(
  q: Queryable,
  companyId: string,
  itemIds: string[],
  opts: { allowBulkFg: boolean },
): Promise<Map<string, PurchItemRef>> {
  const map = await purchItems(q, companyId, itemIds);
  for (const id of itemIds) {
    const it = map.get(id);
    if (!it) throw new AppError('VALIDATION_FAILED', 'Item does not exist', { field: 'itemId', id });
    if (it.status !== 'ACTIVE') throw new AppError('VALIDATION_FAILED', `Item ${it.code} is not active`, { itemId: id });
    if ((it.type === 'BULK' || it.type === 'FG') && !opts.allowBulkFg) {
      throw new AppError('VALIDATION_FAILED', `Item ${it.code} (${it.type}) is made here, not bought (setting purch.allow_bulk_fg_purchase is off)`, { itemId: id });
    }
  }
  return map;
}

/**
 * AVL block (architecture §7.5): every GMP material (AvlItemTypes) needs an APPROVED approved source for this
 * vendor. Refuses with AVL_NOT_APPROVED naming the items. The database re-checks it on submit and approve (0023).
 */
export async function assertAvlApproved(q: Queryable, companyId: string, vendor: PurchVendorRef, items: PurchItemRef[]): Promise<void> {
  const gmp = items.filter((i) => AvlItemTypes.includes(i.type));
  if (gmp.length === 0) return;
  const approved = new Set(await repo.itemsWithApprovedSource(q, companyId, vendor.id, gmp.map((i) => i.id)));
  const missing = [...new Map(gmp.filter((i) => !approved.has(i.id)).map((i) => [i.id, i])).values()];
  if (missing.length > 0) {
    throw new AppError(
      'AVL_NOT_APPROVED',
      `${vendor.code} is not an approved source for ${missing.map((i) => `${i.code} (${i.type})`).join(', ')}`,
      { vendorId: vendor.id, itemIds: missing.map((i) => i.id) },
    );
  }
}
