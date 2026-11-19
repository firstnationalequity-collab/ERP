// Excel export for list screens (architecture §7: "every list screen has search, filters, paging and Excel export").
// Owner Q19 (19-11-2026): money and quantity columns are written as NUMERIC cells, formatted 0.00 (money) and
// 0.0000 (quantity), so Excel can sum them; every other column is written as text exactly as shown. The decimal
// strings from the API are converted to numbers here, at write time only, and nowhere else (rule 10).
// exceljs is loaded only when someone exports.

/** How a column is written: `money` → number with 0.00, `quantity` → number with 0.0000, `text` (default) → text. */
export type ExportFormat = 'text' | 'money' | 'quantity';

export interface ExportColumn<T> {
  title: string;
  /** The cell value as the API gives it (decimal string for money/quantity) or as shown (text). */
  value(row: T): string;
  format?: ExportFormat;
}

/** Upper bound for one export, so a mistaken click cannot pull a whole ledger into the browser (owner Q19: kept). */
export const EXPORT_MAX_ROWS = 20_000;

export type SheetCell = string | number | null;

/** Excel number format per column kind. */
export const EXPORT_NUM_FMT: Record<ExportFormat, string> = { text: '@', money: '0.00', quantity: '0.0000' };

const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * One cell. Money/quantity: a decimal string becomes a number, an empty value an empty cell, and anything that is
 * not a plain decimal stays as text (never silently turned into 0 or NaN). Text columns are written unchanged.
 */
export function toCell(raw: string | null | undefined, format: ExportFormat = 'text'): SheetCell {
  const text = raw ?? '';
  if (format === 'text') return text;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return DECIMAL.test(trimmed) ? Number(trimmed) : text;
}

/** Rows → a 2-D array of cells with a header row (pure; tested). */
export function toSheetRows<T>(columns: readonly ExportColumn<T>[], rows: readonly T[]): SheetCell[][] {
  return [columns.map((c) => c.title), ...rows.map((r) => columns.map((c) => toCell(c.value(r), c.format)))];
}

/** "Items" + date → "Items 18-11-2026.xlsx"; characters Windows refuses in file names are replaced. */
export function exportFileName(base: string, today: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  const date = m ? `${m[3]}-${m[2]}-${m[1]}` : today;
  return `${base.replace(/[\\/:*?"<>|]/g, '_')} ${date}.xlsx`;
}

export async function downloadExcel<T>(fileName: string, sheetName: string, columns: readonly ExportColumn<T>[], rows: readonly T[]): Promise<void> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName.slice(0, 31) || 'Sheet1', { views: [{ state: 'frozen', ySplit: 1 }] });
  const data = toSheetRows(columns, rows);
  for (const line of data) ws.addRow(line);
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((col, i) => {
    const longest = Math.max(...data.map((line) => String(line[i] ?? '').length));
    col.width = Math.min(60, Math.max(10, longest + 2));
    col.numFmt = EXPORT_NUM_FMT[columns[i]?.format ?? 'text'];
  });
  // The header cell of a numeric column stays text-formatted.
  ws.getRow(1).eachCell((cell) => {
    cell.numFmt = '@';
  });
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  saveBlob(blob, fileName);
}

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
