// Display labels for master records (pure; tested).

/** "RM-001 — Paracetamol" from the usual master shapes (code/name, itemCode/itemName, docNo, version). */
export function refLabel(row: Record<string, unknown> | undefined): string {
  if (!row) return '';
  const code = (row.code ?? row.itemCode ?? row.docNo) as string | undefined;
  const name = (row.name ?? row.itemName ?? row.fullName) as string | undefined;
  const version = typeof row.version === 'number' ? ` v${row.version}` : '';
  if (code && name) return `${code} — ${name}${version}`;
  return `${code ?? name ?? `#${String(row.id ?? '')}`}${version}`;
}
