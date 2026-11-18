// Generic list-query helpers shared by every module's repo (queries only, no business rules).
import { and, count, eq, ilike, or, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Queryable } from './client';

export interface Paging {
  offset: number;
  limit: number;
}

/** ILIKE pattern with %, _ and \ escaped. */
export function likePattern(search: string): string {
  return `%${search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

/** WHERE parts shared by every list: company, free-text search over the given columns, active flag. */
export function listWhere(
  companyCol: PgColumn,
  opts: { search?: string; searchCols: PgColumn[]; activeCol?: PgColumn; active?: 'active' | 'inactive' | 'all'; extra?: (SQL | undefined)[] },
  companyId: string,
): SQL | undefined {
  const parts: (SQL | undefined)[] = [eq(companyCol, companyId), ...(opts.extra ?? [])];
  if (opts.search) parts.push(or(...opts.searchCols.map((c) => ilike(c, likePattern(opts.search ?? '')))));
  if (opts.activeCol && opts.active === 'active') parts.push(eq(opts.activeCol, true));
  if (opts.activeCol && opts.active === 'inactive') parts.push(eq(opts.activeCol, false));
  return and(...parts);
}

export async function countWhere(q: Queryable, table: PgTable, where: SQL | undefined): Promise<number> {
  const [row] = await q.select({ n: count() }).from(table).where(where);
  return row?.n ?? 0;
}
