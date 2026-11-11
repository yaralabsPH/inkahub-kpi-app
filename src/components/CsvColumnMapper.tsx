import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Field, Select, Input } from "@/components/ui/Input";
import type { Product } from "@/lib/domain";

/**
 * Fallback CSV column-mapper. When the importer can't auto-detect a known
 * shape (Notion, long-form, Shopify), open this modal and let the user
 * point each required field at one of the actual column headers in their
 * file. Result: a list of `{ skuCode, isoWeekStart, units }` rows that
 * the caller writes through the normal mutation path.
 */

export interface MapperRow {
  skuCode: string;
  isoWeekStart: string;
  units: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** First row of the CSV (the header). */
  headers: string[];
  /** All data rows (already split by parseCsv). */
  rows: string[][];
  /** Product list — used to validate that mapped sku codes exist. */
  products: Product[];
  /** Receives the parsed result; caller writes to DB. */
  onApply: (rows: MapperRow[]) => Promise<void> | void;
}

const NONE = "__none__";

export function CsvColumnMapper({ open, onClose, headers, rows, products, onApply }: Props) {
  const [skuIdx, setSkuIdx] = useState<string>(NONE);
  const [weekIdx, setWeekIdx] = useState<string>(NONE);
  const [unitsIdx, setUnitsIdx] = useState<string>(NONE);
  const [defaultWeek, setDefaultWeek] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Try to guess sensible defaults when the modal opens.
  useEffect(() => {
    if (!open) return;
    setError(null); setBusy(false);
    const lc = headers.map((h) => h.trim().toLowerCase());
    const findIdx = (...candidates: string[]) =>
      candidates
        .map((c) => lc.findIndex((h) => h === c || h.includes(c)))
        .find((i) => i >= 0);
    setSkuIdx(String(findIdx("sku_code", "sku", "code", "product") ?? NONE));
    setWeekIdx(String(findIdx("iso_week_start", "week", "date") ?? NONE));
    setUnitsIdx(String(findIdx("units_sold", "units", "quantity", "qty", "frames") ?? NONE));
  }, [open, headers]);

  const codes = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) {
      set.add(p.code.toLowerCase());
      const sc = (p.short_code ?? `${p.size}${(p.colour[0] ?? "").toUpperCase()}`).toLowerCase();
      if (sc) set.add(sc);
    }
    return set;
  }, [products]);

  const preview = useMemo(() => {
    const sIdx = Number(skuIdx);
    const wIdx = Number(weekIdx);
    const uIdx = Number(unitsIdx);
    if (!Number.isFinite(sIdx) || !Number.isFinite(uIdx)) return null;

    const out: MapperRow[] = [];
    let invalidWeek = 0;
    let unknownSku = 0;
    let invalidUnits = 0;

    for (const r of rows) {
      const sku = (r[sIdx] ?? "").trim();
      if (!sku) continue;
      if (!codes.has(sku.toLowerCase())) { unknownSku++; continue; }
      const wk = (Number.isFinite(wIdx) && wIdx >= 0 ? r[wIdx] : defaultWeek)?.trim();
      if (!wk || !/^\d{4}-\d{2}-\d{2}$/.test(wk)) { invalidWeek++; continue; }
      const u = Number(r[uIdx]);
      if (!Number.isFinite(u) || u < 0) { invalidUnits++; continue; }
      out.push({ skuCode: sku, isoWeekStart: wk, units: u });
    }
    return { rows: out, invalidWeek, unknownSku, invalidUnits };
  }, [skuIdx, weekIdx, unitsIdx, defaultWeek, rows, codes]);

  const ready = preview && preview.rows.length > 0;

  const apply = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      await onApply(preview.rows);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Map CSV columns">
      <div className="space-y-4">
        <p className="text-sm text-slate-600 dark:text-slate-400">
          We couldn't detect a known CSV shape. Pick which column in your file
          provides each piece of information — leave week blank if your file
          has no date column and provide a default below.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="SKU code column" hint="Match your file's column to a SKU code or short code.">
            <Select value={skuIdx} onChange={(e) => setSkuIdx(e.target.value)}>
              <option value={NONE}>—</option>
              {headers.map((h, i) => <option key={i} value={String(i)}>{h || `(col ${i + 1})`}</option>)}
            </Select>
          </Field>
          <Field label="Week-start column" hint="A YYYY-MM-DD date. Optional — leave blank to use the default below for every row.">
            <Select value={weekIdx} onChange={(e) => setWeekIdx(e.target.value)}>
              <option value={NONE}>—</option>
              {headers.map((h, i) => <option key={i} value={String(i)}>{h || `(col ${i + 1})`}</option>)}
            </Select>
          </Field>
          <Field label="Units column" hint="Number sold (or frames after set multipliers).">
            <Select value={unitsIdx} onChange={(e) => setUnitsIdx(e.target.value)}>
              <option value={NONE}>—</option>
              {headers.map((h, i) => <option key={i} value={String(i)}>{h || `(col ${i + 1})`}</option>)}
            </Select>
          </Field>
          <Field label="Default week" hint="Used when no week column is selected, or a row's week is blank.">
            <Input type="date" value={defaultWeek} onChange={(e) => setDefaultWeek(e.target.value)} />
          </Field>
        </div>

        {preview ? (
          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 p-3 text-sm">
            <strong>{preview.rows.length}</strong> row{preview.rows.length === 1 ? "" : "s"} ready to import
            {preview.unknownSku > 0 ? ` · ${preview.unknownSku} skipped (unknown SKU code)` : ""}
            {preview.invalidWeek > 0 ? ` · ${preview.invalidWeek} skipped (invalid week)` : ""}
            {preview.invalidUnits > 0 ? ` · ${preview.invalidUnits} skipped (bad units)` : ""}
            {preview.rows.length > 0 ? (
              <div className="mt-2 text-[11px] text-slate-500">
                First row: {preview.rows[0].skuCode} · {preview.rows[0].isoWeekStart} · {preview.rows[0].units} units
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? <div className="text-sm text-red-600 dark:text-red-400">{error}</div> : null}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={apply} disabled={!ready || busy}>
            {busy ? "Importing…" : `Import ${preview?.rows.length ?? 0} rows`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
