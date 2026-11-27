// Master data the QC module needs, exported so modules/qc never reads master tables itself
// (CLAUDE.md "Modules talk to each other only through exported service functions"). Run inside the caller's
// query or transaction; no permission checks here (the calling module's route did them).
import { and, eq, ilike, or } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { items } from '../../db/schema/masters';
import * as purchRepo from './purch-refs.repo';
import type { PurchItemRef } from './purch-refs.service';

export type QcItemRef = PurchItemRef;

export async function qcItems(q: Queryable, companyId: string, ids: string[]): Promise<Map<string, QcItemRef>> {
  const rows = await purchRepo.itemsByIds(q, companyId, [...new Set(ids)]);
  return new Map(rows.map((r) => [r.id, r]));
}

/** Ids of items whose code or name contains `search` (for QC list filters). At most 500. */
export async function qcItemIdsMatching(q: Queryable, companyId: string, search: string): Promise<string[]> {
  const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await q
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.companyId, companyId), or(ilike(items.code, like), ilike(items.name, like))))
    .limit(500);
  return rows.map((r) => r.id);
}
