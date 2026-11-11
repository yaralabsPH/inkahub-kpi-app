import * as XLSX from "xlsx";

/**
 * Multi-sheet Excel export. Each `SheetSpec` becomes a tab in the workbook.
 * The first row of each sheet is the header. Cells can be any primitive —
 * Excel auto-formats numbers, dates, and booleans.
 *
 * Excel sheet names are capped at 31 characters and can't contain
 * `: \ / ? * [ ]` — we sanitize automatically.
 */
export interface SheetSpec {
  name: string;
  headers: string[];
  rows: (string | number | boolean | null | undefined)[][];
  /** Optional column widths in characters — useful for keeping totals readable. */
  columnWidths?: number[];
}

export function downloadXlsx(filename: string, sheets: SheetSpec[]): void {
  if (sheets.length === 0) return;
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const aoa = [sheet.headers, ...sheet.rows];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (sheet.columnWidths) {
      ws["!cols"] = sheet.columnWidths.map((w) => ({ wch: w }));
    } else {
      // Sensible defaults — first column wider for codes/labels.
      const widths: { wch: number }[] = sheet.headers.map((_, i) => ({ wch: i === 0 ? 22 : 14 }));
      ws["!cols"] = widths;
    }
    XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(sheet.name));
  }
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Excel rejects sheet names > 31 chars or with `: \ / ? * [ ]`. */
function sanitizeSheetName(name: string): string {
  return name.replace(/[:\\/?*[\]]/g, "_").slice(0, 31) || "Sheet";
}
