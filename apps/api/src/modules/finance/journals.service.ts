// Journals, read only (M2 task 7): list and detail behind fin.view (checked in the routes). Journals are written
// only by engines/posting inside the business transaction that causes them; manual vouchers come with M8.
import { gte, ilike, isNull, isNotNull, lte, or, eq } from 'drizzle-orm';
import type { JournalEntryDetailDto, JournalEntryDto, JournalListQuery, Page } from '@albert/shared';
import { db } from '../../db/client';
import { likePattern, listWhere } from '../../db/list';
import { journalEntries } from '../../db/schema/fin';
import { AppError } from '../../core/errors';
import type { AuthContext } from '../../core/auth/auth.service';
import * as repo from './finance.repo';

function toDto(e: repo.JournalEntryRow): JournalEntryDto {
  return {
    id: e.id,
    docNo: e.docNo,
    entryDate: e.entryDate,
    periodId: e.periodId,
    sourceType: e.sourceType,
    sourceId: e.sourceId,
    event: e.event,
    narration: e.narration,
    status: e.status,
    total: e.total,
    postedAt: e.postedAt?.toISOString() ?? null,
    postedBy: e.postedBy,
    reversalOf: e.reversalOf,
    reversalId: e.reversalId,
    reversedAt: e.reversedAt?.toISOString() ?? null,
    reversedBy: e.reversedBy,
    createdAt: e.createdAt.toISOString(),
    createdBy: e.createdBy,
  };
}

export async function listJournals(auth: AuthContext, q: JournalListQuery): Promise<Page<JournalEntryDto>> {
  if (q.dateFrom && q.dateTo && q.dateFrom > q.dateTo) throw new AppError('VALIDATION_FAILED', 'The start date is after the end date');
  const where = listWhere(
    journalEntries.companyId,
    {
      searchCols: [],
      extra: [
        q.search ? or(ilike(journalEntries.docNo, likePattern(q.search)), ilike(journalEntries.narration, likePattern(q.search))) : undefined,
        q.status ? eq(journalEntries.status, q.status) : undefined,
        q.event ? eq(journalEntries.event, q.event) : undefined,
        q.kind === 'MANUAL' ? isNull(journalEntries.event) : q.kind === 'SYSTEM' ? isNotNull(journalEntries.event) : undefined,
        q.sourceType ? eq(journalEntries.sourceType, q.sourceType) : undefined,
        q.sourceId ? eq(journalEntries.sourceId, q.sourceId) : undefined,
        q.dateFrom ? gte(journalEntries.entryDate, q.dateFrom) : undefined,
        q.dateTo ? lte(journalEntries.entryDate, q.dateTo) : undefined,
      ],
    },
    auth.companyId,
  );
  const paging = { limit: q.pageSize, offset: (q.page - 1) * q.pageSize };
  const [rows, total] = await Promise.all([repo.listJournalEntries(db, where, paging), repo.countJournalEntries(db, where)]);
  return { items: rows.map(toDto), total, page: q.page, pageSize: q.pageSize };
}

export async function getJournal(auth: AuthContext, id: string): Promise<JournalEntryDetailDto> {
  const entry = await repo.findJournalEntry(db, auth.companyId, id);
  if (!entry) throw new AppError('NOT_FOUND', 'Journal entry not found');
  const lines = await repo.journalLinesOf(db, id);
  return {
    ...toDto(entry),
    lines: lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      accountId: l.accountId,
      accountCode: l.accountCode,
      accountName: l.accountName,
      debit: l.debit,
      credit: l.credit,
      costCenterId: l.costCenterId,
      customerId: l.customerId,
      vendorId: l.vendorId,
      productionOrderId: l.productionOrderId,
      taxCodeId: l.taxCodeId,
      narration: l.narration,
    })),
  };
}
