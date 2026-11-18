// Journals API (/api/v1/fin/journals), read-only (M2 task 7). Journals are written only by engines/posting
// (system journals, series SJ); manual journal vouchers (series JV) come with M8.
import { z } from 'zod';
import { PostingEvent, PostingStatus } from '../../enums';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date: YYYY-MM-DD');

export const JournalListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  /** Document number or narration. */
  search: z.string().trim().max(100).optional(),
  status: z.enum(PostingStatus).optional(),
  event: z.enum(PostingEvent).optional(),
  /** MANUAL = journal vouchers, SYSTEM = posted by modules. */
  kind: z.enum(['MANUAL', 'SYSTEM']).optional(),
  sourceType: z.string().trim().regex(/^[A-Z][A-Z_]{1,29}$/).optional(),
  sourceId: z.string().regex(/^\d+$/).optional(),
  dateFrom: isoDate.optional(),
  dateTo: isoDate.optional(),
});
export type JournalListQuery = z.infer<typeof JournalListQuery>;

export interface JournalLineDto {
  id: string;
  lineNo: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
  costCenterId: string | null;
  customerId: string | null;
  vendorId: string | null;
  productionOrderId: string | null;
  taxCodeId: string | null;
  narration: string | null;
}

export interface JournalEntryDto {
  id: string;
  docNo: string;
  entryDate: string;
  periodId: string;
  sourceType: string;
  sourceId: string | null;
  event: PostingEvent | null;
  narration: string;
  status: PostingStatus;
  /** Sum of the debit lines (= sum of the credits once posted). */
  total: string;
  postedAt: string | null;
  postedBy: string | null;
  reversalOf: string | null;
  reversalId: string | null;
  reversedAt: string | null;
  reversedBy: string | null;
  createdAt: string;
  createdBy: string;
}

export interface JournalEntryDetailDto extends JournalEntryDto {
  lines: JournalLineDto[];
}
