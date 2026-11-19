// Query-string helpers for list endpoints (search, filters, paging). Pure, so they can be unit-tested.

export type QueryValue = string | number | boolean | null | undefined;

/** `{ page: 1, search: 'para', type: undefined }` → "?page=1&search=para". Empty values are left out. */
export function buildQuery(params: Record<string, QueryValue>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    q.set(key, String(value));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** Number of pages needed to read `total` rows at `pageSize` per page (at least 1). */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
