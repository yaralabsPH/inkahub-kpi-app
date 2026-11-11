/**
 * Tiny RFC-4180-ish CSV helpers. Handles double-quoted strings, embedded
 * commas, embedded newlines and "" escapes. No streaming — small files only.
 */

export function parseCsv(text: string, delimiter: "," | ";" | "\t" = ","): string[][] {
  const rows: string[][] = [];
  let cur = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === delimiter) {
        row.push(cur);
        cur = "";
      } else if (c === "\n") {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = "";
      } else if (c === "\r") {
        // ignore CR — handled by \n
      } else {
        cur += c;
      }
    }
  }
  if (cur !== "" || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell !== ""));
}

/**
 * Pick the most likely delimiter from the first chunk of a file. Excel saves
 * CSVs with semicolons in regions where comma is the decimal separator
 * (Australia, much of Europe). We only sniff outside quoted strings so a
 * cell value like "Smith, Jones" doesn't skew the count.
 */
export function detectCsvDelimiter(text: string): "," | ";" | "\t" {
  const sample = text.slice(0, 4096);
  const counts: Record<"," | ";" | "\t", number> = { ",": 0, ";": 0, "\t": 0 };
  let inQ = false;
  for (const c of sample) {
    if (c === '"') inQ = !inQ;
    else if (!inQ && (c === "," || c === ";" || c === "\t")) {
      counts[c as "," | ";" | "\t"] += 1;
    }
  }
  if (counts[";"] > counts[","] && counts[";"] >= counts["\t"]) return ";";
  if (counts["\t"] > counts[","]) return "\t";
  return ",";
}

/** Convert an array of objects to a CSV string with a header row. */
export function toCsv<T extends Record<string, unknown>>(
  rows: T[],
  columns: (keyof T)[],
): string {
  const header = columns.map((c) => escape(String(c))).join(",");
  const body = rows
    .map((r) =>
      columns
        .map((c) => {
          const v = r[c];
          return escape(v === null || v === undefined ? "" : String(v));
        })
        .join(","),
    )
    .join("\n");
  return `${header}\n${body}`;
}

function escape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Trigger a CSV download in the browser. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Trigger a JSON download. */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
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
