// Queries behind purch-refs.service.ts (master data procurement needs). No business rules here.
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { approvedSources, items, locations, taxCodes, uoms, vendors, warehouses } from '../../db/schema/masters';

export async function vendorsByIds(q: Queryable, companyId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return q
    .select({
      id: vendors.id,
      code: vendors.code,
      name: vendors.name,
      status: vendors.status,
      currency: vendors.currency,
      isForeign: vendors.isForeign,
      paymentTermsDays: vendors.paymentTermsDays,
      whtTaxCodeId: vendors.whtTaxCodeId,
      isFiler: vendors.isFiler,
      filerCheckedOn: vendors.filerCheckedOn,
    })
    .from(vendors)
    .where(and(eq(vendors.companyId, companyId), inArray(vendors.id, ids)));
}

export async function itemsByIds(q: Queryable, companyId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return q
    .select({
      id: items.id,
      code: items.code,
      name: items.name,
      type: items.type,
      status: items.status,
      uomCode: uoms.code,
      categoryId: items.categoryId,
      shelfLifeDays: items.shelfLifeDays,
      qcRequired: items.qcRequired,
    })
    .from(items)
    .innerJoin(uoms, eq(uoms.id, items.baseUomId))
    .where(and(eq(items.companyId, companyId), inArray(items.id, ids)));
}

/** Item ids (of `itemIds`) that have an APPROVED source for this vendor. */
export async function itemsWithApprovedSource(q: Queryable, companyId: string, vendorId: string, itemIds: string[]): Promise<string[]> {
  if (itemIds.length === 0) return [];
  const rows = await q
    .selectDistinct({ itemId: approvedSources.itemId })
    .from(approvedSources)
    .where(
      and(
        eq(approvedSources.companyId, companyId),
        eq(approvedSources.vendorId, vendorId),
        inArray(approvedSources.itemId, itemIds),
        eq(approvedSources.status, 'APPROVED'),
      ),
    );
  return rows.map((r) => r.itemId);
}

const sourceColumns = {
  id: approvedSources.id,
  vendorId: approvedSources.vendorId,
  itemId: approvedSources.itemId,
  manufacturer: approvedSources.manufacturer,
  manufacturingSite: approvedSources.manufacturingSite,
  status: approvedSources.status,
};

export async function sourcesByIds(q: Queryable, companyId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return q.select(sourceColumns).from(approvedSources).where(and(eq(approvedSources.companyId, companyId), inArray(approvedSources.id, ids)));
}

/** APPROVED sources of these items for this vendor. */
export async function approvedSourcesFor(q: Queryable, companyId: string, vendorId: string, itemIds: string[]) {
  if (itemIds.length === 0) return [];
  return q
    .select(sourceColumns)
    .from(approvedSources)
    .where(
      and(
        eq(approvedSources.companyId, companyId),
        eq(approvedSources.vendorId, vendorId),
        inArray(approvedSources.itemId, itemIds),
        eq(approvedSources.status, 'APPROVED'),
      ),
    )
    .orderBy(asc(approvedSources.manufacturer), asc(approvedSources.manufacturingSite));
}

export async function locationsByIds(q: Queryable, companyId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return q
    .select({ id: locations.id, code: locations.code, name: locations.name, warehouseCode: warehouses.code, isActive: locations.isActive })
    .from(locations)
    .innerJoin(warehouses, eq(warehouses.id, locations.warehouseId))
    .where(and(eq(locations.companyId, companyId), inArray(locations.id, ids)));
}

export async function taxCodesByIds(q: Queryable, companyId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return q
    .select({ id: taxCodes.id, code: taxCodes.code, name: taxCodes.name, kind: taxCodes.kind, rate: taxCodes.rate, isPlaceholder: taxCodes.isPlaceholder, isActive: taxCodes.isActive })
    .from(taxCodes)
    .where(and(eq(taxCodes.companyId, companyId), inArray(taxCodes.id, ids)));
}
