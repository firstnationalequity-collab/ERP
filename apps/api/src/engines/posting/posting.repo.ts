// Queries on the `fin` journal tables and posting rules, for engines/posting only (no business rules).
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { AccountRole, PostingEvent } from '@albert/shared';
import type { Queryable, Tx } from '../../db/client';
import { journalEntries, journalLines, postingRules } from '../../db/schema/fin';

export type EntryRow = typeof journalEntries.$inferSelect;
export type LineRow = typeof journalLines.$inferSelect;

/**
 * The account for one leg of an event: the active rule for (event, role, item category), else the active default
 * rule (no category). undefined when neither exists.
 */
export async function ruleAccount(
  q: Queryable,
  companyId: string,
  event: PostingEvent,
  role: AccountRole,
  itemCategoryId: string | null,
): Promise<string | undefined> {
  const rows = await q
    .select({ accountId: postingRules.accountId, itemCategoryId: postingRules.itemCategoryId })
    .from(postingRules)
    .where(
      and(
        eq(postingRules.companyId, companyId),
        eq(postingRules.event, event),
        eq(postingRules.accountRole, role),
        eq(postingRules.isActive, true),
        itemCategoryId === null
          ? isNull(postingRules.itemCategoryId)
          : or(eq(postingRules.itemCategoryId, itemCategoryId), isNull(postingRules.itemCategoryId)),
      ),
    );
  return (rows.find((r) => r.itemCategoryId !== null) ?? rows[0])?.accountId;
}

export async function insertEntry(tx: Tx, v: typeof journalEntries.$inferInsert): Promise<EntryRow> {
  const [row] = await tx.insert(journalEntries).values(v).returning();
  if (!row) throw new Error('journal entry insert returned no row');
  return row;
}

export async function insertLines(tx: Tx, rows: (typeof journalLines.$inferInsert)[]): Promise<void> {
  if (rows.length) await tx.insert(journalLines).values(rows);
}

export async function findEntry(q: Queryable, companyId: string, id: string): Promise<EntryRow | undefined> {
  const [row] = await q.select().from(journalEntries).where(and(eq(journalEntries.companyId, companyId), eq(journalEntries.id, id)));
  return row;
}

/** SELECT ... FOR UPDATE on one entry (a reversal locks its original first). */
export async function lockEntry(tx: Tx, companyId: string, id: string): Promise<EntryRow | undefined> {
  const [row] = await tx
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.companyId, companyId), eq(journalEntries.id, id)))
    .for('update');
  return row;
}

export async function linesOf(q: Queryable, entryId: string): Promise<LineRow[]> {
  return q.select().from(journalLines).where(eq(journalLines.entryId, entryId)).orderBy(asc(journalLines.lineNo));
}

/** Re-read after posting (posted_at / posted_by / period are set by the guard trigger). */
export async function reloadEntry(q: Queryable, id: string): Promise<EntryRow> {
  const [row] = await q.select().from(journalEntries).where(eq(journalEntries.id, id));
  if (!row) throw new Error(`journal entry ${id} vanished`);
  return row;
}

/** Journal entries naming a source document (newest last). */
export async function entriesOfSource(q: Queryable, companyId: string, sourceType: string, sourceId: string): Promise<EntryRow[]> {
  return q
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.companyId, companyId), eq(journalEntries.sourceType, sourceType), eq(journalEntries.sourceId, sourceId)))
    .orderBy(asc(journalEntries.id));
}

/** Every account a posting rule (active or not, any event) maps to a role: e.g. the INVENTORY accounts. */
export async function accountsOfRole(q: Queryable, companyId: string, role: AccountRole): Promise<Set<string>> {
  const rows = await q
    .selectDistinct({ accountId: postingRules.accountId })
    .from(postingRules)
    .where(and(eq(postingRules.companyId, companyId), eq(postingRules.accountRole, role)));
  return new Set(rows.map((r) => r.accountId));
}

/** One vendor's lines on the accounts of a role (POSTED and REVERSED entries both stand: a reversal is its own entry). */
export async function vendorSubledger(
  q: Queryable,
  companyId: string,
  role: AccountRole,
  vendorId: string,
  period: { from?: string; to?: string },
): Promise<{
  opening: string;
  lines: { entryId: string; docNo: string; entryDate: string; sourceType: string; sourceId: string | null; narration: string; debit: string; credit: string }[];
}> {
  const base = sql`FROM fin.journal_lines l JOIN fin.journal_entries e ON e.id = l.entry_id
    WHERE e.company_id = ${companyId} AND e.status IN ('POSTED', 'REVERSED') AND l.vendor_id = ${vendorId}
      AND l.account_id IN (SELECT pr.account_id FROM fin.posting_rules pr WHERE pr.company_id = ${companyId} AND pr.account_role = ${role})`;
  const opening = period.from
    ? ((await q.execute<{ v: string }>(sql`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS v ${base} AND e.entry_date < ${period.from}`)).rows[0]?.v ?? '0')
    : '0';
  const rows = (
    await q.execute<{
      entry_id: string;
      doc_no: string;
      entry_date: string;
      source_type: string;
      source_id: string | null;
      narration: string;
      debit: string;
      credit: string;
    }>(sql`SELECT e.id::text AS entry_id, e.doc_no, e.entry_date::text AS entry_date, e.source_type, e.source_id::text AS source_id,
                  coalesce(l.narration, e.narration) AS narration, l.debit::text AS debit, l.credit::text AS credit
             ${base}
             ${period.from ? sql`AND e.entry_date >= ${period.from}` : sql``}
             ${period.to ? sql`AND e.entry_date <= ${period.to}` : sql``}
            ORDER BY e.entry_date, e.id, l.line_no`)
  ).rows;
  return {
    opening,
    lines: rows.map((r) => ({
      entryId: r.entry_id,
      docNo: r.doc_no,
      entryDate: r.entry_date,
      sourceType: r.source_type,
      sourceId: r.source_id,
      narration: r.narration,
      debit: r.debit,
      credit: r.credit,
    })),
  };
}
