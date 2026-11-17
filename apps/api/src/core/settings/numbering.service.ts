// core/numbering — document numbers from core.number_series (docs/architecture.md §7.1; decision Q16).
// Call nextDocNo INSIDE the business transaction that creates the document, so the number and the
// document commit or roll back together (no gaps, no duplicates).
import {
  formatDocNo,
  numberPatternErrors,
  numberPeriodKey,
  parseBusinessDate,
  type CreateNumberSeriesRequest,
  type NumberSeriesDto,
  type UpdateNumberSeriesRequest,
} from '@albert/shared';
import { db, withTransaction, type Tx } from '../../db/client';
import { AppError } from '../errors';
import { companyToday } from '../dates';
import { txContext, type AuthContext } from '../auth/auth.service';
import * as repo from './settings.repo';

/**
 * Next document number for `docType`, dated `docDate` ('YYYY-MM-DD', company time zone).
 * The fiscal-year / calendar-year bucket comes from the document date, not from today.
 */
export async function nextDocNo(tx: Tx, docType: string, docDate: string = companyToday()): Promise<string> {
  try {
    parseBusinessDate(docDate);
  } catch {
    throw new AppError('VALIDATION_FAILED', `Invalid document date ${docDate}`);
  }
  const series = await repo.findActiveSeries(tx, docType);
  if (!series) throw new AppError('NUMBER_SERIES_MISSING', `No active number series for ${docType}`);
  const seq = await repo.takeNextValue(tx, series.id, numberPeriodKey(series.reset, docDate));
  return formatDocNo(series.pattern, { prefix: series.prefix, date: docDate, seq });
}

async function toDto(row: repo.NumberSeriesRow): Promise<NumberSeriesDto> {
  const today = companyToday();
  const next = await repo.peekNextValue(db, row.id, numberPeriodKey(row.reset, today));
  return {
    id: row.id,
    docType: row.docType,
    name: row.name,
    prefix: row.prefix,
    pattern: row.pattern,
    reset: row.reset,
    isActive: row.isActive,
    preview: formatDocNo(row.pattern, { prefix: row.prefix, date: today, seq: next }),
  };
}

export async function listSeries(auth: AuthContext): Promise<NumberSeriesDto[]> {
  return Promise.all((await repo.listSeries(db, auth.companyId)).map(toDto));
}

export async function createSeries(auth: AuthContext, input: CreateNumberSeriesRequest): Promise<NumberSeriesDto> {
  const id = await withTransaction(txContext(auth, input.reason), (tx) =>
    repo.insertSeries(tx, {
      docType: input.docType,
      name: input.name,
      prefix: input.prefix,
      pattern: input.pattern,
      reset: input.reset,
    }),
  );
  const row = await repo.findSeries(db, auth.companyId, id);
  if (!row) throw new AppError('NOT_FOUND', 'Number series not found');
  return toDto(row);
}

/**
 * Change prefix, pattern or reset rule. The combined pattern + reset must still never repeat a number.
 * Numbers already issued keep their old format; the database's unique doc_no constraints catch collisions.
 */
export async function updateSeries(auth: AuthContext, id: string, input: UpdateNumberSeriesRequest): Promise<NumberSeriesDto> {
  await withTransaction(txContext(auth, input.reason), async (tx) => {
    const row = await repo.findSeries(tx, auth.companyId, id, true);
    if (!row) throw new AppError('NOT_FOUND', 'Number series not found');
    const pattern = input.pattern ?? row.pattern;
    const reset = input.reset ?? row.reset;
    const errors = numberPatternErrors(pattern, reset);
    if (errors.length > 0) throw new AppError('VALIDATION_FAILED', 'Invalid number pattern', { pattern: errors });
    const { reason: _reason, ...changes } = input;
    await repo.updateSeries(tx, id, changes);
  });
  const row = await repo.findSeries(db, auth.companyId, id);
  if (!row) throw new AppError('NOT_FOUND', 'Number series not found');
  return toDto(row);
}
