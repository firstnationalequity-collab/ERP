// Queries behind purch-refs.service.ts (master data procurement needs). No business rules here.
import { and, eq, inArray } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { approvedSources, items, uoms, vendors } from '../../db/schema/masters';

export async function vendorsByIds(q: Queryable, companyId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return q
    .select({ id: vendors.id, code: vendors.code, name: vendors.name, status: vendors.status, currency: vendors.currency, isForeign: vendors.isForeign })
    .from(vendors)
    .where(and(eq(vendors.companyId, companyId), inArray(vendors.id, ids)));
}

export async function itemsByIds(q: Queryable, companyId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return q
    .select({ id: items.id, code: items.code, name: items.name, type: items.type, status: items.status, uomCode: uoms.code })
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
