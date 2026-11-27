// Queries behind specs.service.ts. No business rules here.
import { and, asc, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { Queryable, Tx } from '../../db/client';
import { specs, specTests } from '../../db/schema/qc';

export type SpecRow = typeof specs.$inferSelect;
export type SpecTestRow = typeof specTests.$inferSelect;
export type NewSpecTest = Omit<typeof specTests.$inferInsert, 'id' | 'companyId' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy'>;

export async function findSpec(q: Queryable, companyId: string, id: string, lock = false): Promise<SpecRow | undefined> {
  const query = q.select().from(specs).where(and(eq(specs.companyId, companyId), eq(specs.id, id)));
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/** Every version of an item's spec, newest first, locked (so "one APPROVED / one open per item" cannot race). */
export async function lockSpecsOfItem(tx: Tx, companyId: string, itemId: string): Promise<SpecRow[]> {
  return tx
    .select()
    .from(specs)
    .where(and(eq(specs.companyId, companyId), eq(specs.itemId, itemId)))
    .orderBy(desc(specs.version))
    .for('update');
}

export async function approvedSpecOf(q: Queryable, companyId: string, itemId: string): Promise<SpecRow | undefined> {
  const [row] = await q
    .select()
    .from(specs)
    .where(and(eq(specs.companyId, companyId), eq(specs.itemId, itemId), eq(specs.status, 'APPROVED')));
  return row;
}

export async function insertSpec(tx: Tx, values: { itemId: string; version: number; reference: string | null; notes: string | null }): Promise<SpecRow> {
  const [row] = await tx.insert(specs).values({ ...values, status: 'DRAFT' }).returning();
  if (!row) throw new Error('spec insert returned nothing');
  return row;
}

export async function updateSpec(tx: Tx, id: string, values: { reference?: string | null; notes?: string | null }): Promise<void> {
  if (Object.keys(values).length === 0) return;
  await tx.update(specs).set(values).where(eq(specs.id, id));
}

export async function specTestsOf(q: Queryable, specId: string): Promise<SpecTestRow[]> {
  return q.select().from(specTests).where(eq(specTests.specId, specId)).orderBy(asc(specTests.seq));
}

export async function specTestsByIds(q: Queryable, ids: string[]): Promise<SpecTestRow[]> {
  if (ids.length === 0) return [];
  return q.select().from(specTests).where(inArray(specTests.id, [...new Set(ids)]));
}

export async function replaceSpecTests(tx: Tx, specId: string, tests: NewSpecTest[]): Promise<void> {
  await tx.delete(specTests).where(eq(specTests.specId, specId));
  if (tests.length > 0) await tx.insert(specTests).values(tests);
}

export function specWhere(companyId: string, f: { status?: string; itemIds?: string[] }): SQL | undefined {
  return and(
    eq(specs.companyId, companyId),
    f.status ? eq(specs.status, f.status as SpecRow['status']) : undefined,
    f.itemIds ? inArray(specs.itemId, f.itemIds.length > 0 ? f.itemIds : ['0']) : undefined,
  );
}

export async function listSpecs(q: Queryable, where: SQL | undefined, paging: { offset: number; limit: number }): Promise<SpecRow[]> {
  return q.select().from(specs).where(where).orderBy(desc(specs.id)).offset(paging.offset).limit(paging.limit);
}

export async function countSpecs(q: Queryable, where: SQL | undefined): Promise<number> {
  const [row] = await q.select({ n: count() }).from(specs).where(where);
  return row?.n ?? 0;
}

export async function specsByIds(q: Queryable, companyId: string, ids: string[]): Promise<SpecRow[]> {
  if (ids.length === 0) return [];
  return q.select().from(specs).where(and(eq(specs.companyId, companyId), inArray(specs.id, ids)));
}
