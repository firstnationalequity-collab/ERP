// Queries on the `fin` journal tables and posting rules, for engines/posting only (no business rules).
import { and, asc, eq, isNull, or } from 'drizzle-orm';
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
