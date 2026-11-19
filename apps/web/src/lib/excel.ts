// Excel export for list screens (architecture §7: "every list screen has search, filters, paging and Excel export").
// Cells are written as TEXT exactly as shown on screen: money and quantities arrive as decimal strings and are
// never turned into JS numbers (rule 10). exceljs is loaded only when someone exports.

export interface ExportColumn<T> {
  title: string;
  /** The text written into the cell. */
  value(row: T): string;
}

/** Rows → a 2-D array of strings with a header row (pure; tested). */
export function toSheetRows<T>(columns: readonly ExportColumn<T>[], rows: readonly T[]): string[][] {
  return [columns.map((c) => c.title), ...rows.map((r) => columns.map((c) => c.value(r) ?? ''))];
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
    const longest = Math.max(...data.map((line) => (line[i] ?? '').length));
    col.width = Math.min(60, Math.max(10, longest + 2));
    col.numFmt = '@'; // text: the value is shown exactly as exported
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
