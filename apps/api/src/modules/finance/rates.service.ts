// Daily exchange rates (owner 2026-11-25, Q4): Finance keeps one rate per currency and date (PKR per 1 unit),
// key fin.rate.manage (Finance Manager), audited. Documents look up the rate of their own date with rateOn()
// and copy it, so a later correction never changes a document.
import { Decimal } from 'decimal.js';
import type { ExchangeRateDto, ExchangeRateQuery, SetExchangeRateRequest } from '@albert/shared';
import { db, withTransaction, type Queryable } from '../../db/client';
import { AppError } from '../../core/errors';
import { txContext, type AuthContext } from '../../core/auth/auth.service';
import * as repo from './rates.repo';

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
 * For other modules, inside their transaction: PKR per 1 unit of `currency` on `date` ('1' for PKR).
 * No rate for that exact date → RATE_MISSING (owner Q4: never an older rate silently).
 */
export async function rateOn(q: Queryable, companyId: string, currency: string, date: string): Promise<string> {
  if (currency === 'PKR') return '1.0000';
  const row = await repo.findRate(q, companyId, currency, date);
  if (!row) {
    throw new AppError('RATE_MISSING', `No ${currency} exchange rate for ${date.split('-').reverse().join('-')}; Finance must enter it first`, {
      currency,
      date,
    });
  }
  return row.rate;
}
