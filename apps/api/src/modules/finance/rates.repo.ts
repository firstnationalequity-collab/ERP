// Queries for fin.exchange_rates (0023). No business rules here.
import { and, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { exchangeRates } from '../../db/schema/fin';
import { users } from '../../db/schema/core';

export type ExchangeRateRow = typeof exchangeRates.$inferSelect;

export async function listRates(
  q: Queryable,
  companyId: string,
  f: { currency?: string; dateFrom?: string; dateTo?: string },
): Promise<(ExchangeRateRow & { updatedByName: string })[]> {
  const where: SQL[] = [eq(exchangeRates.companyId, companyId)];
  if (f.currency) where.push(eq(exchangeRates.currency, f.currency));
  if (f.dateFrom) where.push(gte(exchangeRates.rateDate, f.dateFrom));
  if (f.dateTo) where.push(lte(exchangeRates.rateDate, f.dateTo));
  const rows = await q
    .select({ r: exchangeRates, updatedByName: users.fullName })
    .from(exchangeRates)
    .innerJoin(users, eq(users.id, exchangeRates.updatedBy))
    .where(and(...where))
    .orderBy(desc(exchangeRates.rateDate), exchangeRates.currency)
    .limit(500);
  return rows.map((x) => ({ ...x.r, updatedByName: x.updatedByName }));
}

export async function findRate(q: Queryable, companyId: string, currency: string, rateDate: string, lock = false): Promise<ExchangeRateRow | undefined> {
  const query = q
    .select()
    .from(exchangeRates)
    .where(and(eq(exchangeRates.companyId, companyId), eq(exchangeRates.currency, currency), eq(exchangeRates.rateDate, rateDate)));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

export async function insertRate(q: Queryable, v: { currency: string; rateDate: string; rate: string; source: string }): Promise<string> {
  const [row] = await q.insert(exchangeRates).values(v).returning({ id: exchangeRates.id });
  if (!row) throw new Error('exchange rate insert returned no row');
  return row.id;
}

export async function updateRate(q: Queryable, id: string, v: { rate: string; source: string }): Promise<void> {
  await q.update(exchangeRates).set(v).where(eq(exchangeRates.id, id));
}
