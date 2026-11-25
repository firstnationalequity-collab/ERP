// Daily exchange rates (/api/v1/fin/exchange-rates), maintained by Finance (fin.rate.manage; owner 2026-11-25, Q4).
// A rate is PKR per 1 unit of the currency, NUMERIC(9,4). Documents copy the rate they use.
import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date: YYYY-MM-DD');
/** Above zero, up to 5 digits and 4 decimals (NUMERIC(9,4)). */
export const exchangeRate = z
  .string()
  .trim()
  .regex(/^\d{1,5}(\.\d{1,4})?$/, 'Rate: up to 5 digits and 4 decimals')
  .refine((v) => /[1-9]/.test(v), 'Rate must be above zero');
export const foreignCurrency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Currency: 3-letter ISO code')
  .refine((c) => c !== 'PKR', 'PKR needs no rate');

/** Create the rate for a currency and date, or correct it (a correction needs a reason; the audit log keeps the old value). */
export const SetExchangeRateRequest = z
  .object({
    currency: foreignCurrency,
    rateDate: isoDate,
    rate: exchangeRate,
    source: z.string().trim().min(1, 'Source is required (e.g. SBP)').max(100),
    reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500).optional(),
  })
  .strict();
export type SetExchangeRateRequest = z.infer<typeof SetExchangeRateRequest>;

export const ExchangeRateQuery = z.object({
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  dateFrom: isoDate.optional(),
  dateTo: isoDate.optional(),
});
export type ExchangeRateQuery = z.infer<typeof ExchangeRateQuery>;

export interface ExchangeRateDto {
  id: string;
  currency: string;
  rateDate: string;
  rate: string;
  source: string;
  updatedBy: string;
  updatedAt: string;
}
