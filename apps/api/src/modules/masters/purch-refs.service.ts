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

// ---------------------------------------------------------------- GRN (M3 task 3)

export interface PurchSourceRef {
  id: string;
  vendorId: string;
  itemId: string;
  manufacturer: string;
  manufacturingSite: string;
  status: string;
}

export async function purchSources(q: Queryable, companyId: string, ids: string[]): Promise<Map<string, PurchSourceRef>> {
  const rows = await repo.sourcesByIds(q, companyId, [...new Set(ids)]);
  return new Map(rows.map((r) => [r.id, r]));
}

/** The APPROVED sources (manufacturer + site) a GRN may name for these items from this vendor. */
export async function approvedSourcesFor(q: Queryable, companyId: string, vendorId: string, itemIds: string[]): Promise<PurchSourceRef[]> {
  return repo.approvedSourcesFor(q, companyId, vendorId, [...new Set(itemIds)]);
}

/**
 * AVL at receipt (owner 2026-11-25): a GMP material (AvlItemTypes) is received only from an APPROVED source for this
 * item + vendor, which names the manufacturer and site (AVL_NOT_APPROVED). Returns the source, or null for other items.
 * The database re-checks it when the GRN posts (0027).
 */
export async function assertReceiptSource(
  q: Queryable,
  companyId: string,
  input: { vendor: PurchVendorRef; item: PurchItemRef; approvedSourceId: string | null },
): Promise<PurchSourceRef | null> {
  if (!AvlItemTypes.includes(input.item.type)) return null;
  const source = input.approvedSourceId ? (await purchSources(q, companyId, [input.approvedSourceId])).get(input.approvedSourceId) : undefined;
  if (!source || source.vendorId !== input.vendor.id || source.itemId !== input.item.id || source.status !== 'APPROVED') {
    throw new AppError(
      'AVL_NOT_APPROVED',
      `${input.item.code} (${input.item.type}) is received only from an APPROVED source of ${input.vendor.code}: pick the manufacturer and site`,
      { vendorId: input.vendor.id, itemId: input.item.id, approvedSourceId: input.approvedSourceId, status: source?.status ?? null },
    );
  }
  return source;
}

export interface PurchLocationRef {
  id: string;
  code: string;
  name: string;
  warehouseCode: string;
  isActive: boolean;
}

export async function purchLocations(q: Queryable, companyId: string, ids: string[]): Promise<Map<string, PurchLocationRef>> {
  const rows = await repo.locationsByIds(q, companyId, [...new Set(ids)]);
  return new Map(rows.map((r) => [r.id, r]));
}
