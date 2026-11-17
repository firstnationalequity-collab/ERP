// Number series and fiscal periods (docs/architecture.md §7.1; decision Q16).
import { z } from 'zod';
import { NumberSeriesReset, numberPatternErrors } from '../../fiscal';
import type { FiscalPeriodStatus } from '../../enums';

const reason = z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500);

const seriesFields = {
  name: z.string().trim().min(1).max(80),
  prefix: z.string().trim().regex(/^[A-Za-z0-9]{0,10}$/, 'Prefix: up to 10 letters or digits'),
  pattern: z.string().trim().min(1).max(60),
  reset: z.enum(NumberSeriesReset),
};

function checkPattern(v: { pattern?: string; reset?: NumberSeriesReset }, ctx: z.RefinementCtx): void {
  if (v.pattern === undefined || v.reset === undefined) return;
  for (const message of numberPatternErrors(v.pattern, v.reset)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pattern'], message });
  }
}

export const CreateNumberSeriesRequest = z
  .object({ docType: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,29}$/, 'Doc type: upper case code'), ...seriesFields, reason })
  .strict()
  .superRefine(checkPattern);
export type CreateNumberSeriesRequest = z.infer<typeof CreateNumberSeriesRequest>;

/** Pattern and reset are validated together in the service (one may change without the other). */
export const UpdateNumberSeriesRequest = z
  .object({
    name: seriesFields.name.optional(),
    prefix: seriesFields.prefix.optional(),
    pattern: seriesFields.pattern.optional(),
    reset: seriesFields.reset.optional(),
    reason,
  })
  .strict();
export type UpdateNumberSeriesRequest = z.infer<typeof UpdateNumberSeriesRequest>;

export interface NumberSeriesDto {
  id: string;
  docType: string;
  name: string;
  prefix: string;
  pattern: string;
  reset: NumberSeriesReset;
  isActive: boolean;
  /** What the next number would look like today (not reserved). */
  preview: string;
}

export const CreateFiscalYearRequest = z
  .object({ startYear: z.number().int().min(2020).max(2099) })
  .strict();
export type CreateFiscalYearRequest = z.infer<typeof CreateFiscalYearRequest>;

export const PeriodActionRequest = z.object({ reason }).strict();
export type PeriodActionRequest = z.infer<typeof PeriodActionRequest>;

export const FiscalPeriodQuery = z.object({ fiscalYear: z.string().regex(/^\d{4}-\d{2}$/).optional() });
export type FiscalPeriodQuery = z.infer<typeof FiscalPeriodQuery>;

export interface FiscalPeriodDto {
  id: string;
  fiscalYear: string;
  periodNo: number;
  name: string;
  /** 'YYYY-MM-DD' business dates; shown DD-MM-YYYY in the UI. */
  startDate: string;
  endDate: string;
  status: FiscalPeriodStatus;
}
