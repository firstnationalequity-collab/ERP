// Queries for number series and fiscal periods. No business rules here.
import { and, asc, eq, sql } from 'drizzle-orm';
import type { NumberSeriesReset } from '@albert/shared';
import type { Queryable } from '../../db/client';
import { fiscalPeriods, numberSeries, numberSeriesCounters } from '../../db/schema/core';

export type NumberSeriesRow = typeof numberSeries.$inferSelect;
export type FiscalPeriodRow = typeof fiscalPeriods.$inferSelect;

/** Series for a doc type in the acting company (core.current_company_id(), set by withTransaction). */
export async function findActiveSeries(q: Queryable, docType: string): Promise<NumberSeriesRow | undefined> {
  const [row] = await q
    .select()
    .from(numberSeries)
    .where(
      and(
        eq(numberSeries.companyId, sql`core.current_company_id()`),
        eq(numberSeries.docType, docType),
        eq(numberSeries.isActive, true),
      ),
    );
  return row;
}

/**
 * Take the next value of a counter. One atomic upsert; the counter row stays locked until the calling
 * transaction ends, so concurrent callers queue and a rollback gives the value back (no gap).
 */
export async function takeNextValue(q: Queryable, seriesId: string, periodKey: string): Promise<number> {
  const result = await q.execute<{ value: string }>(sql`
    INSERT INTO core.number_series_counters (series_id, period_key, next_value)
    VALUES (${seriesId}, ${periodKey}, 2)
    ON CONFLICT (series_id, period_key)
    DO UPDATE SET next_value = core.number_series_counters.next_value + 1
    RETURNING next_value - 1 AS value`);
  const value = result.rows[0]?.value;
  if (value === undefined) throw new Error('number counter returned no value');
  return Number(value);
}

/** The value the next document would get (read only; not reserved). */
export async function peekNextValue(q: Queryable, seriesId: string, periodKey: string): Promise<number> {
  const [row] = await q
    .select({ next: numberSeriesCounters.nextValue })
    .from(numberSeriesCounters)
    .where(and(eq(numberSeriesCounters.seriesId, seriesId), eq(numberSeriesCounters.periodKey, periodKey)));
  return row ? Number(row.next) : 1;
}

export async function listSeries(q: Queryable, companyId: string): Promise<NumberSeriesRow[]> {
  return q.select().from(numberSeries).where(eq(numberSeries.companyId, companyId)).orderBy(asc(numberSeries.docType));
}

export async function findSeries(q: Queryable, companyId: string, id: string, lock = false): Promise<NumberSeriesRow | undefined> {
  const query = q.select().from(numberSeries).where(and(eq(numberSeries.companyId, companyId), eq(numberSeries.id, id)));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

export async function insertSeries(
  q: Queryable,
  values: { docType: string; name: string; prefix: string; pattern: string; reset: NumberSeriesReset },
): Promise<string> {
  const [row] = await q.insert(numberSeries).values(values).returning({ id: numberSeries.id });
  if (!row) throw new Error('number series insert returned no row');
  return row.id;
}

export async function updateSeries(
  q: Queryable,
  id: string,
  values: Partial<{ name: string; prefix: string; pattern: string; reset: NumberSeriesReset }>,
): Promise<void> {
  await q.update(numberSeries).set(values).where(eq(numberSeries.id, id));
}

// ---------------------------------------------------------------- fiscal periods

export async function insertPeriod(
  q: Queryable,
  values: { fiscalYear: string; periodNo: number; name: string; startDate: string; endDate: string },
): Promise<string> {
  const [row] = await q
    .insert(fiscalPeriods)
    .values({ ...values, status: 'OPEN' })
    .returning({ id: fiscalPeriods.id });
  if (!row) throw new Error('fiscal period insert returned no row');
  return row.id;
}

export async function listPeriods(q: Queryable, companyId: string, fiscalYear?: string): Promise<FiscalPeriodRow[]> {
  const conditions = [eq(fiscalPeriods.companyId, companyId)];
  if (fiscalYear) conditions.push(eq(fiscalPeriods.fiscalYear, fiscalYear));
  return q.select().from(fiscalPeriods).where(and(...conditions)).orderBy(asc(fiscalPeriods.startDate));
}

export async function findPeriod(q: Queryable, companyId: string, id: string): Promise<FiscalPeriodRow | undefined> {
  const [row] = await q
    .select()
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.companyId, companyId), eq(fiscalPeriods.id, id)));
  return row;
}

/** Raises PERIOD_NOT_DEFINED / PERIOD_CLOSED from the database function (share-locks the period). */
export async function assertPeriodOpen(q: Queryable, postingDate: string): Promise<void> {
  await q.execute(sql`SELECT core.assert_period_open(core.current_company_id(), ${postingDate}::date)`);
}
