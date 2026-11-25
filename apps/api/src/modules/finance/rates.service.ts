// Daily exchange rates (owner 2026-11-25, Q4): Finance keeps one rate per currency and date (PKR per 1 unit),
// key fin.rate.manage (Finance Manager), audited. Documents look up the rate of their own date with rateOn()
// and copy it, so a later correction never changes a document.
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { ExchangeRateDto, ExchangeRateQuery, SetExchangeRateRequest } from '@albert/shared';
import { db, withTransaction, type Queryable } from '../../db/client';
import { AppError } from '../../core/errors';
import { txContext, type AuthContext } from '../../core/auth/auth.service';
import * as repo from './rates.repo';
import { getSetting, registerSetting } from '../../core/settings/app-settings.service';

/** Owner 2026-11-25 (answer 3): how old the latest rate may be, in days, before a document is refused. */
export const RATE_MAX_AGE_SETTING = 'fin.rate.max_age_days';
registerSetting({
  key: RATE_MAX_AGE_SETTING,
  description: 'A document uses the latest exchange rate on or before its date, no older than this many days (else RATE_MISSING)',
  schema: z.number().int().min(0).max(31),
  defaultValue: 3,
});

export interface RateUsed {
  /** PKR per 1 unit, NUMERIC(9,4) text. */
  rate: string;
  /** The day of that rate (YYYY-MM-DD); the document date for PKR. */
  rateDate: string;
}

const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const ddmmyyyy = (d: string) => d.split('-').reverse().join('-');

function toDto(r: repo.ExchangeRateRow & { updatedByName: string }): ExchangeRateDto {
  return {
    id: r.id,
    currency: r.currency,
    rateDate: r.rateDate,
    rate: r.rate,
    source: r.source,
    updatedBy: r.updatedByName,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listRates(auth: AuthContext, query: ExchangeRateQuery): Promise<ExchangeRateDto[]> {
  return (await repo.listRates(db, auth.companyId, query)).map(toDto);
}

/** Create the day's rate, or correct it (a correction needs a reason, kept in the audit log). */
export async function setRate(auth: AuthContext, input: SetExchangeRateRequest): Promise<ExchangeRateDto> {
  const rate = new Decimal(input.rate).toFixed(4);
  await withTransaction(txContext(auth, input.reason ?? `exchange rate ${input.currency} ${input.rateDate}`), async (tx) => {
    const existing = await repo.findRate(tx, auth.companyId, input.currency, input.rateDate, true);
    if (!existing) {
      await repo.insertRate(tx, { currency: input.currency, rateDate: input.rateDate, rate, source: input.source });
      return;
    }
    if (new Decimal(existing.rate).equals(rate) && existing.source === input.source) return;
    if (!input.reason) {
      throw new AppError('VALIDATION_FAILED', `A ${input.currency} rate for this date already exists; give a reason to correct it`, {
        field: 'reason',
      });
    }
    await repo.updateRate(tx, existing.id, { rate, source: input.source });
  });
  const [row] = await repo.listRates(db, auth.companyId, { currency: input.currency, dateFrom: input.rateDate, dateTo: input.rateDate });
  if (!row) throw new AppError('NOT_FOUND', 'Exchange rate not found');
  return toDto(row);
}

/**
 * For other modules, inside their transaction: PKR per 1 unit of `currency` for a document dated `date`
 * (1 for PKR). Owner 2026-11-25 (answer 3): the latest rate on or before the date, no older than setting
 * fin.rate.max_age_days (default 3); older or none → RATE_MISSING. The caller copies rate and date.
 */
export async function rateOn(q: Queryable, companyId: string, currency: string, date: string): Promise<RateUsed> {
  if (currency === 'PKR') return { rate: '1.0000', rateDate: date };
  const maxAge = await getSetting<number>(q, companyId, RATE_MAX_AGE_SETTING);
  const row = await repo.findLatestRate(q, companyId, currency, date);
  if (!row || days(row.rateDate, date) > maxAge) {
    const latest = row ? `; the latest is of ${ddmmyyyy(row.rateDate)}` : '';
    throw new AppError(
      'RATE_MISSING',
      `No ${currency} exchange rate within ${maxAge} days before ${ddmmyyyy(date)}${latest}; Finance must enter it first`,
      { currency, date, maxAgeDays: maxAge, latestRateDate: row?.rateDate ?? null },
    );
  }
  return { rate: row.rate, rateDate: row.rateDate };
}
