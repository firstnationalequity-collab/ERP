// Queries for purch.landed_cost_types, landed_costs, landed_cost_inputs, landed_cost_allocations (0029).
// No business rules here; landed-costs.service.ts holds them.
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Queryable, Tx } from '../../db/client';
import { grns, landedCostAllocations, landedCostInputs, landedCosts, landedCostTypes } from '../../db/schema/purch';
import type { Paging } from './procurement.repo';

export type LandedCostTypeRow = typeof landedCostTypes.$inferSelect;
export type LandedCostRow = typeof landedCosts.$inferSelect;
export type LandedCostInputRow = typeof landedCostInputs.$inferSelect;
export type LandedCostAllocationRow = typeof landedCostAllocations.$inferSelect;

type Stamp = 'id' | 'companyId' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy';
export type LandedCostTypeValues = Omit<typeof landedCostTypes.$inferInsert, Stamp | 'isActive'>;
export type LandedCostValues = Pick<
  typeof landedCosts.$inferInsert,
  'chargeTypeId' | 'chargeDate' | 'amount' | 'currency' | 'foreignAmount' | 'exchangeRate' | 'exchangeRateDate' | 'basis' | 'vendorId' | 'reference' | 'notes'
>;
export type LandedCostInputValues = Pick<typeof landedCostInputs.$inferInsert, 'poLineId' | 'gdAmount' | 'weightKg'>;
export type LandedCostAllocationValues = Omit<typeof landedCostAllocations.$inferInsert, Stamp>;

// ---------------------------------------------------------------- charge types

export async function listTypes(q: Queryable, companyId: string, activeOnly: boolean): Promise<LandedCostTypeRow[]> {
  const where: SQL[] = [eq(landedCostTypes.companyId, companyId)];
  if (activeOnly) where.push(eq(landedCostTypes.isActive, true));
  return q.select().from(landedCostTypes).where(and(...where)).orderBy(asc(landedCostTypes.code));
}

export async function findType(q: Queryable, companyId: string, id: string, lock = false): Promise<LandedCostTypeRow | undefined> {
  const query = q.select().from(landedCostTypes).where(and(eq(landedCostTypes.companyId, companyId), eq(landedCostTypes.id, id)));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

export async function typesByIds(q: Queryable, companyId: string, ids: string[]): Promise<Map<string, LandedCostTypeRow>> {
  if (ids.length === 0) return new Map();
  const rows = await q
    .select()
    .from(landedCostTypes)
    .where(and(eq(landedCostTypes.companyId, companyId), inArray(landedCostTypes.id, [...new Set(ids)])));
  return new Map(rows.map((r) => [r.id, r]));
}

export async function typeCodeTaken(q: Queryable, companyId: string, code: string): Promise<boolean> {
  const [row] = await q
    .select({ id: landedCostTypes.id })
    .from(landedCostTypes)
    .where(and(eq(landedCostTypes.companyId, companyId), eq(landedCostTypes.code, code)));
  return row !== undefined;
}

export async function insertType(tx: Tx, v: LandedCostTypeValues): Promise<string> {
  const [row] = await tx.insert(landedCostTypes).values(v).returning({ id: landedCostTypes.id });
  if (!row) throw new Error('charge type insert returned nothing');
  return row.id;
}

export async function updateType(tx: Tx, id: string, v: Partial<Pick<LandedCostTypeRow, 'name' | 'defaultBasis' | 'isActive'>>): Promise<void> {
  await tx.update(landedCostTypes).set(v).where(eq(landedCostTypes.id, id));
}

// ---------------------------------------------------------------- charges

export async function insertCharge(
  tx: Tx,
  v: LandedCostValues & { docNo: string; grnId: string; withGrn: boolean; correctionOf?: string | null; correctionReason?: string | null },
): Promise<string> {
  const [row] = await tx.insert(landedCosts).values({ ...v, status: 'DRAFT' }).returning({ id: landedCosts.id });
  if (!row) throw new Error('landed cost insert returned nothing');
  return row.id;
}

export async function updateCharge(tx: Tx, id: string, v: Partial<LandedCostValues>): Promise<void> {
  await tx.update(landedCosts).set(v).where(eq(landedCosts.id, id));
}

export async function findCharge(q: Queryable, companyId: string, id: string, lock = false): Promise<LandedCostRow | undefined> {
  const query = q.select().from(landedCosts).where(and(eq(landedCosts.companyId, companyId), eq(landedCosts.id, id)));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

export async function listCharges(
  q: Queryable,
  companyId: string,
  f: { status?: string; search?: string; grnId?: string },
  paging: Paging,
): Promise<{ rows: LandedCostRow[]; total: number }> {
  const where: SQL[] = [eq(landedCosts.companyId, companyId)];
  if (f.status) where.push(sql`${landedCosts.status} = ${f.status}`);
  if (f.grnId) where.push(eq(landedCosts.grnId, f.grnId));
  if (f.search) {
    const s = `%${f.search}%`;
    const cond = or(
      ilike(landedCosts.docNo, s),
      ilike(landedCosts.reference, s),
      sql`${landedCosts.grnId} IN (SELECT ${grns.id} FROM ${grns} WHERE ${grns.docNo} ILIKE ${s})`,
    );
    if (cond) where.push(cond);
  }
  const rows = await q.select().from(landedCosts).where(and(...where)).orderBy(desc(landedCosts.id)).limit(paging.limit).offset(paging.offset);
  const [c] = await q.select({ n: count() }).from(landedCosts).where(and(...where));
  return { rows, total: Number(c?.n ?? 0) };
}

/** The charges of these GRNs, oldest first; `lock` locks them (posting / cancelling with the GRN). */
export async function chargesOfGrns(q: Queryable, grnIds: string[], lock = false): Promise<LandedCostRow[]> {
  if (grnIds.length === 0) return [];
  const query = q.select().from(landedCosts).where(inArray(landedCosts.grnId, grnIds)).orderBy(asc(landedCosts.id));
  return lock ? query.for('update') : query;
}

export async function replaceInputs(tx: Tx, chargeId: string, rows: LandedCostInputValues[]): Promise<void> {
  await tx.delete(landedCostInputs).where(eq(landedCostInputs.landedCostId, chargeId));
  if (rows.length > 0) await tx.insert(landedCostInputs).values(rows.map((r) => ({ ...r, landedCostId: chargeId })));
}

export async function inputsOf(q: Queryable, chargeIds: string[]): Promise<LandedCostInputRow[]> {
  if (chargeIds.length === 0) return [];
  return q.select().from(landedCostInputs).where(inArray(landedCostInputs.landedCostId, chargeIds)).orderBy(asc(landedCostInputs.id));
}

export async function insertAllocations(tx: Tx, rows: LandedCostAllocationValues[]): Promise<void> {
  if (rows.length > 0) await tx.insert(landedCostAllocations).values(rows);
}

export async function allocationsOf(q: Queryable, chargeIds: string[]): Promise<LandedCostAllocationRow[]> {
  if (chargeIds.length === 0) return [];
  return q
    .select()
    .from(landedCostAllocations)
    .where(inArray(landedCostAllocations.landedCostId, chargeIds))
    .orderBy(asc(landedCostAllocations.id));
}

/** Corrections of these originals (all statuses), oldest first. */
export async function correctionsOf(q: Queryable, originalIds: string[], lock = false): Promise<LandedCostRow[]> {
  if (originalIds.length === 0) return [];
  const query = q.select().from(landedCosts).where(inArray(landedCosts.correctionOf, originalIds)).orderBy(asc(landedCosts.id));
  return lock ? query.for('update') : query;
}

export async function docNosOf(q: Queryable, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await q.select({ id: landedCosts.id, docNo: landedCosts.docNo }).from(landedCosts).where(inArray(landedCosts.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.docNo]));
}
