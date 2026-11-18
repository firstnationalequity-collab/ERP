// Finance repository: queries only (no business rules). Tables in schema `fin` (0012_finance_masters.sql).
import { and, asc, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { Queryable, Tx } from '../../db/client';
import type { Paging } from '../../db/list';
import { accounts, costCenters, journalEntries, journalLines, postingRules } from '../../db/schema/fin';

export type AccountRow = typeof accounts.$inferSelect;
export type CostCenterRow = typeof costCenters.$inferSelect;
export type PostingRuleRow = typeof postingRules.$inferSelect & { accountCode: string; accountName: string };

/** Tables with an is_active flag that the finance masters activate / deactivate. */
export const ACTIVE_FLAG_TABLES = {
  accounts,
  'cost-centers': costCenters,
  'posting-rules': postingRules,
} as const;
export type ActiveFlagTable = keyof typeof ACTIVE_FLAG_TABLES;

/** Lock the row and read its is_active (undefined = not found in this company). */
export async function lockActiveFlag(tx: Tx, resource: ActiveFlagTable, companyId: string, id: string): Promise<boolean | undefined> {
  const t = ACTIVE_FLAG_TABLES[resource];
  const [row] = await tx
    .select({ isActive: t.isActive })
    .from(t)
    .where(and(eq(t.companyId, companyId), eq(t.id, id)))
    .for('update');
  return row?.isActive;
}

export async function setActiveFlag(tx: Tx, resource: ActiveFlagTable, id: string, active: boolean): Promise<void> {
  const t = ACTIVE_FLAG_TABLES[resource];
  await tx.update(t).set({ isActive: active }).where(eq(t.id, id));
}

// ---------------------------------------------------------------- accounts

export async function listAccounts(q: Queryable, where: SQL | undefined, p: Paging): Promise<AccountRow[]> {
  return q.select().from(accounts).where(where).orderBy(asc(accounts.code)).limit(p.limit).offset(p.offset);
}
export async function findAccount(q: Queryable, companyId: string, id: string): Promise<AccountRow | undefined> {
  const [row] = await q.select().from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.id, id)));
  return row;
}
export async function insertAccount(tx: Tx, values: typeof accounts.$inferInsert): Promise<AccountRow> {
  const [row] = await tx.insert(accounts).values(values).returning();
  if (!row) throw new Error('account insert returned no row');
  return row;
}
export async function updateAccount(tx: Tx, id: string, values: Partial<typeof accounts.$inferInsert>): Promise<void> {
  if (Object.keys(values).length) await tx.update(accounts).set(values).where(eq(accounts.id, id));
}

// ---------------------------------------------------------------- cost centres

export async function listCostCenters(q: Queryable, where: SQL | undefined, p: Paging): Promise<CostCenterRow[]> {
  return q.select().from(costCenters).where(where).orderBy(asc(costCenters.code)).limit(p.limit).offset(p.offset);
}
export async function findCostCenter(q: Queryable, companyId: string, id: string): Promise<CostCenterRow | undefined> {
  const [row] = await q.select().from(costCenters).where(and(eq(costCenters.companyId, companyId), eq(costCenters.id, id)));
  return row;
}
export async function insertCostCenter(tx: Tx, values: { code: string; name: string }): Promise<CostCenterRow> {
  const [row] = await tx.insert(costCenters).values(values).returning();
  if (!row) throw new Error('cost centre insert returned no row');
  return row;
}
export async function updateCostCenter(tx: Tx, id: string, values: { name: string }): Promise<void> {
  await tx.update(costCenters).set(values).where(eq(costCenters.id, id));
}

// ---------------------------------------------------------------- posting rules

const ruleColumns = {
  id: postingRules.id,
  companyId: postingRules.companyId,
  event: postingRules.event,
  accountRole: postingRules.accountRole,
  itemCategoryId: postingRules.itemCategoryId,
  accountId: postingRules.accountId,
  isPlaceholder: postingRules.isPlaceholder,
  isActive: postingRules.isActive,
  createdAt: postingRules.createdAt,
  createdBy: postingRules.createdBy,
  updatedAt: postingRules.updatedAt,
  updatedBy: postingRules.updatedBy,
  accountCode: accounts.code,
  accountName: accounts.name,
};

export async function listPostingRules(q: Queryable, where: SQL | undefined, p: Paging): Promise<PostingRuleRow[]> {
  return q
    .select(ruleColumns)
    .from(postingRules)
    .innerJoin(accounts, eq(accounts.id, postingRules.accountId))
    .where(where)
    .orderBy(asc(postingRules.event), asc(postingRules.accountRole), sql`${postingRules.itemCategoryId} NULLS FIRST`)
    .limit(p.limit)
    .offset(p.offset);
}
/** Count with the account joined, because a search may match the account code or name. */
export async function countPostingRules(q: Queryable, where: SQL | undefined): Promise<number> {
  const [row] = await q
    .select({ n: count() })
    .from(postingRules)
    .innerJoin(accounts, eq(accounts.id, postingRules.accountId))
    .where(where);
  return row?.n ?? 0;
}
export async function findPostingRule(q: Queryable, companyId: string, id: string): Promise<PostingRuleRow | undefined> {
  const [row] = await q
    .select(ruleColumns)
    .from(postingRules)
    .innerJoin(accounts, eq(accounts.id, postingRules.accountId))
    .where(and(eq(postingRules.companyId, companyId), eq(postingRules.id, id)));
  return row;
}
export async function insertPostingRule(tx: Tx, values: typeof postingRules.$inferInsert): Promise<string> {
  const [row] = await tx.insert(postingRules).values(values).returning({ id: postingRules.id });
  if (!row) throw new Error('posting rule insert returned no row');
  return row.id;
}
export async function updatePostingRule(tx: Tx, id: string, values: Partial<typeof postingRules.$inferInsert>): Promise<void> {
  if (Object.keys(values).length) await tx.update(postingRules).set(values).where(eq(postingRules.id, id));
}

// ---------------------------------------------------------------- journals (read only; engines/posting writes them)

export type JournalEntryRow = typeof journalEntries.$inferSelect & { total: string };
export type JournalLineRow = typeof journalLines.$inferSelect & { accountCode: string; accountName: string };

// Qualified by hand: inside a subquery Drizzle renders a column unqualified, which would bind to journal_lines.id.
const totalOf = sql<string>`(SELECT COALESCE(sum(l.debit), 0)::text FROM fin.journal_lines l WHERE l.entry_id = "journal_entries"."id")`;

export async function listJournalEntries(q: Queryable, where: SQL | undefined, p: Paging): Promise<JournalEntryRow[]> {
  const rows = await q
    .select({ entry: journalEntries, total: totalOf })
    .from(journalEntries)
    .where(where)
    .orderBy(desc(journalEntries.entryDate), desc(journalEntries.id))
    .limit(p.limit)
    .offset(p.offset);
  return rows.map((r) => ({ ...r.entry, total: r.total }));
}
export async function countJournalEntries(q: Queryable, where: SQL | undefined): Promise<number> {
  const [row] = await q.select({ n: count() }).from(journalEntries).where(where);
  return row?.n ?? 0;
}
export async function findJournalEntry(q: Queryable, companyId: string, id: string): Promise<JournalEntryRow | undefined> {
  const [row] = await q
    .select({ entry: journalEntries, total: totalOf })
    .from(journalEntries)
    .where(and(eq(journalEntries.companyId, companyId), eq(journalEntries.id, id)));
  return row ? { ...row.entry, total: row.total } : undefined;
}
export async function journalLinesOf(q: Queryable, entryId: string): Promise<JournalLineRow[]> {
  const rows = await q
    .select({ line: journalLines, accountCode: accounts.code, accountName: accounts.name })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(eq(journalLines.entryId, entryId))
    .orderBy(asc(journalLines.lineNo));
  return rows.map((r) => ({ ...r.line, accountCode: r.accountCode, accountName: r.accountName }));
}
