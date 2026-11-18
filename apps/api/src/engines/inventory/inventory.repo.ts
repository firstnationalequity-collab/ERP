// Queries on the `inv` tables, for engines/inventory only. Balances are never written here: the ledger trigger
// (inv.apply_stock_movement) keeps them.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { LotStatus } from '@albert/shared';
import type { Queryable, Tx } from '../../db/client';
import { lots, stockBalances, stockMovements, stockReservations } from '../../db/schema/inv';

export type LotRow = typeof lots.$inferSelect;
export type MovementRow = typeof stockMovements.$inferSelect;
export type ReservationRow = typeof stockReservations.$inferSelect;

export async function insertLot(tx: Tx, v: typeof lots.$inferInsert): Promise<LotRow> {
  const [row] = await tx.insert(lots).values(v).returning();
  if (!row) throw new Error('lot insert returned no row');
  return row;
}

export async function findLot(q: Queryable, companyId: string, id: string): Promise<LotRow | undefined> {
  const [row] = await q.select().from(lots).where(and(eq(lots.companyId, companyId), eq(lots.id, id)));
  return row;
}

/** SELECT ... FOR UPDATE on one lot (posting transactions lock lots before balances). */
export async function lockLot(tx: Tx, companyId: string, id: string): Promise<LotRow | undefined> {
  const [row] = await tx.select().from(lots).where(and(eq(lots.companyId, companyId), eq(lots.id, id))).for('update');
  return row;
}

/** The lot's ledger totals over all locations (= its stock and its value). */
export async function lotLedgerTotals(q: Queryable, lotId: string): Promise<{ qty: string; value: string }> {
  const [row] = await q
    .select({
      qty: sql<string>`COALESCE(sum(${stockMovements.qty}), 0)::text`,
      value: sql<string>`COALESCE(sum(${stockMovements.value}), 0)::text`,
    })
    .from(stockMovements)
    .where(eq(stockMovements.lotId, lotId));
  return row ?? { qty: '0', value: '0' };
}

/** The lot's balance rows, locked FOR UPDATE. */
export async function lockBalances(tx: Tx, lotId: string): Promise<{ locationId: string; qty: string }[]> {
  return tx
    .select({ locationId: stockBalances.locationId, qty: stockBalances.qty })
    .from(stockBalances)
    .where(eq(stockBalances.lotId, lotId))
    .orderBy(asc(stockBalances.locationId))
    .for('update');
}

export async function balancesOfLots(q: Queryable, lotIds: string[]): Promise<{ lotId: string; locationId: string; qty: string }[]> {
  if (lotIds.length === 0) return [];
  return q
    .select({ lotId: stockBalances.lotId, locationId: stockBalances.locationId, qty: stockBalances.qty })
    .from(stockBalances)
    .where(and(inArray(stockBalances.lotId, lotIds), sql`${stockBalances.qty} > 0`));
}

export async function insertMovement(tx: Tx, v: typeof stockMovements.$inferInsert): Promise<MovementRow> {
  const [row] = await tx.insert(stockMovements).values(v).returning();
  if (!row) throw new Error('stock movement insert returned no row');
  return row;
}

export async function findMovements(q: Queryable, companyId: string, ids: string[]): Promise<MovementRow[]> {
  if (ids.length === 0) return [];
  return q
    .select()
    .from(stockMovements)
    .where(and(eq(stockMovements.companyId, companyId), inArray(stockMovements.id, ids)))
    .orderBy(asc(stockMovements.id));
}

export async function reversalsOf(q: Queryable, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await q.select({ of: stockMovements.reversalOf }).from(stockMovements).where(inArray(stockMovements.reversalOf, ids));
  return rows.flatMap((r) => (r.of ? [r.of] : []));
}

/** The lot's reservations, locked FOR UPDATE. */
export async function lockReservations(tx: Tx, lotId: string): Promise<ReservationRow[]> {
  return tx.select().from(stockReservations).where(eq(stockReservations.lotId, lotId)).orderBy(asc(stockReservations.id)).for('update');
}

export async function reservationsOfLots(q: Queryable, lotIds: string[]): Promise<ReservationRow[]> {
  if (lotIds.length === 0) return [];
  return q.select().from(stockReservations).where(and(inArray(stockReservations.lotId, lotIds), sql`${stockReservations.qty} > 0`));
}

export async function reservationsOfDocument(q: Queryable, companyId: string, refDocType: string, refDocId: string): Promise<ReservationRow[]> {
  return q
    .select()
    .from(stockReservations)
    .where(and(eq(stockReservations.companyId, companyId), eq(stockReservations.refDocType, refDocType), eq(stockReservations.refDocId, refDocId)))
    .orderBy(asc(stockReservations.id));
}

export async function insertReservation(tx: Tx, v: typeof stockReservations.$inferInsert): Promise<ReservationRow> {
  const [row] = await tx.insert(stockReservations).values(v).returning();
  if (!row) throw new Error('reservation insert returned no row');
  return row;
}

export async function setReservationQty(tx: Tx, id: string, qty: string): Promise<ReservationRow> {
  const [row] = await tx.update(stockReservations).set({ qty }).where(eq(stockReservations.id, id)).returning();
  if (!row) throw new Error('reservation update returned no row');
  return row;
}

export interface FefoLotRow {
  id: string;
  lotNo: string;
  expiryDate: string | null;
  retestDate: string | null;
  unitCost: string;
  ownerType: string;
  ownerCustomerId: string | null;
}

/**
 * Lots of an item in one status whose expiry and retest dates are after `asOf`, holding stock somewhere,
 * earliest expiry first (no expiry last), then oldest lot.
 */
export async function fefoLots(
  q: Queryable,
  f: { companyId: string; itemId: string; status: LotStatus; asOf: string; ownerCustomerId?: string | null },
): Promise<FefoLotRow[]> {
  const owner =
    f.ownerCustomerId === undefined
      ? sql`TRUE`
      : f.ownerCustomerId === null
        ? sql`${lots.ownerType} = 'OWN'`
        : sql`${lots.ownerCustomerId} = ${f.ownerCustomerId}`;
  return q
    .select({
      id: lots.id,
      lotNo: lots.lotNo,
      expiryDate: lots.expiryDate,
      retestDate: lots.retestDate,
      unitCost: lots.unitCost,
      ownerType: lots.ownerType,
      ownerCustomerId: lots.ownerCustomerId,
    })
    .from(lots)
    .where(
      and(
        eq(lots.companyId, f.companyId),
        eq(lots.itemId, f.itemId),
        eq(lots.status, f.status),
        sql`(${lots.expiryDate} IS NULL OR ${lots.expiryDate} > ${f.asOf}::date)`,
        sql`(${lots.retestDate} IS NULL OR ${lots.retestDate} > ${f.asOf}::date)`,
        owner,
        sql`EXISTS (SELECT 1 FROM inv.stock_balances b WHERE b.lot_id = ${lots.id} AND b.qty > 0)`,
      ),
    )
    .orderBy(sql`${lots.expiryDate} ASC NULLS LAST`, asc(lots.id));
}
