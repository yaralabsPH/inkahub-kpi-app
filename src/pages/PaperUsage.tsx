import { useMemo, useState } from "react";
import { Printer, Save, Trash2, Upload as LoadIcon } from "lucide-react";
import { useDataset } from "@/lib/hooks/useDataset";
import { useMutations } from "@/lib/hooks/useMutations";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { fmtFloat, fmtNum, fmtShortDate } from "@/lib/utils/format";
import { addDays, parseIsoDate, todayIso } from "@/lib/utils/dates";
import { cn } from "@/lib/utils/cn";
import type { PaperUsageEntry } from "@/lib/domain";

/**
 * Paper-roll consumption calculator with optimal nesting. Each row across
 * the roll fits N prints side-by-side; the row consumes one print's length
 * along the roll regardless of how many prints sit on it. A fixed
 * inter-row gap (cutter margin / bleed) is added to every row, so:
 *
 *  Line mm  =  ceil(count / perRow)  ×  (rowLengthMM + ROW_GAP_MM)
 *
 *  GP-4000 — 42″ heavy-weight coated, 30 m rolls (≈1066.8 mm wide)
 *    A0 portrait, 1 per row · row = 1189 mm  → 1189 mm / print average
 *
 *  GP-2000 — 24″ heavy-weight coated, 30 m rolls (≈609.6 mm wide)
 *    A1 portrait,  1 per row · row =  841 mm → 841 mm / print average
 *    A2 landscape, 1 per row · row =  420 mm → 420 mm / print average
 *    A3 portrait,  2 per row · row =  420 mm → 210 mm / print average
 *    A4 landscape, 2 per row · row =  210 mm → 105 mm / print average
 *
 * The ROW_GAP_MM constant is the trim / cut buffer between consecutive
 * rows on the roll. The waste-buffer % below applies on top of this as
 * an additional global multiplier for stuff the gap doesn't cover
 * (e.g. start-of-roll leader, end-of-job trim).
 */

const ROLL_LENGTH_M = 30;
const ROLL_LENGTH_MM = ROLL_LENGTH_M * 1000;
/**
 * Fixed inter-row spacing applied to every printed row regardless of size.
 * Models the cutter margin / bleed gap your GP-2000 / GP-4000 leaves
 * between successive rows. Treated as part of each row's footprint so the
 * math stays a clean multiply by `rowsUsed` rather than tracking N-1 gaps.
 */
const ROW_GAP_MM = 12;

interface SizeSpec {
  key: "A0" | "A1" | "A2" | "A3" | "A4";
  label: string;
  rollWidthInch: 24 | 42;
  printer: "Canon GP-2000" | "Canon GP-4000";
  /** Length of one row down the roll. The row holds `perRow` prints. */
  rowLengthMM: number;
  /** Prints that fit side-by-side across the roll width. */
  perRow: number;
  /** Human-readable orientation + packing note. */
  printedAs: string;
}

const SIZES: readonly SizeSpec[] = [
  { key: "A0", label: "A0  (841 × 1189 mm)", rollWidthInch: 42, printer: "Canon GP-4000", rowLengthMM: 1189, perRow: 1, printedAs: "portrait · 1 per row (841 mm across)" },
  { key: "A1", label: "A1  (594 × 841 mm)",  rollWidthInch: 24, printer: "Canon GP-2000", rowLengthMM:  841, perRow: 1, printedAs: "portrait · 1 per row (594 mm across)" },
  { key: "A2", label: "A2  (420 × 594 mm)",  rollWidthInch: 24, printer: "Canon GP-2000", rowLengthMM:  420, perRow: 1, printedAs: "landscape · 1 per row (594 mm across)" },
  { key: "A3", label: "A3  (297 × 420 mm)",  rollWidthInch: 24, printer: "Canon GP-2000", rowLengthMM:  420, perRow: 2, printedAs: "portrait · 2 per row (2×297 = 594 mm)" },
  { key: "A4", label: "A4  (210 × 297 mm)",  rollWidthInch: 24, printer: "Canon GP-2000", rowLengthMM:  210, perRow: 2, printedAs: "landscape · 2 per row (2×297 = 594 mm)" },
] as const;

const PRINTER_BY_WIDTH: Record<24 | 42, string> = {
  24: "Canon GP-2000 · 24″ heavy-weight coated, 30 m rolls",
  42: "Canon GP-4000 · 42″ heavy-weight coated, 30 m rolls",
};

/** Snap any ISO date to the Monday of its week (ISO week start). */
function snapToMonday(iso: string): string {
  const d = parseIsoDate(iso);
  const dow = d.getUTCDay(); // 0 = Sun
  const back = (dow + 6) % 7;
  return addDays(iso, -back);
}

export function PaperUsage() {
  const { data } = useDataset();
  const m = useMutations();

  const [weekStart, setWeekStart] = useState<string>(snapToMonday(todayIso()));
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [bufferPct, setBufferPct] = useState<string>("0");
  const [notes, setNotes] = useState<string>("");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);

  // Sum weekly sales by paper size. Every framed variant (A1N, A1B, A1W,
  // …) starts life as an A1 print on the roll, so we count ALL SKUs whose
  // `size` matches — unframed + framed alike. Roll SKUs themselves are
  // excluded so they don't double-count (the roll is the resource, not the
  // demand). Built-in defensiveness: exclude SKUs flagged as paper rolls
  // in settings to avoid sales of literal rolls counting as prints.
  const salesCounts = useMemo(() => {
    const out: Record<SizeSpec["key"], number> = { A0: 0, A1: 0, A2: 0, A3: 0, A4: 0 };
    if (!data) return out;
    const rollSkuIds = new Set<string>(
      [data.settings.paper_roll_24_sku_id, data.settings.paper_roll_42_sku_id]
        .filter((x): x is string => !!x),
    );
    for (const sku of data.products) {
      if (rollSkuIds.has(sku.id)) continue;
      const size = (sku.size || "").toUpperCase() as SizeSpec["key"];
      if (!(size in out)) continue;
      for (const s of data.sales) {
        if (s.product_id === sku.id && s.iso_week_start === weekStart) {
          out[size] += s.units_sold;
        }
      }
    }
    return out;
  }, [data, weekStart]);

  /** Resolve final count for a size — manual override wins, falls back to sales. */
  const effective = (key: SizeSpec["key"]): number => {
    const raw = overrides[key];
    if (raw !== undefined && raw !== "") {
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    }
    return salesCounts[key] ?? 0;
  };

  const buffer = (() => {
    const n = Number(bufferPct);
    return Number.isFinite(n) && n >= 0 ? n / 100 : 0;
  })();

  /** Per-roll-width breakdown — uses strict row-rounding (ceil) so an odd
   *  count of 2-per-row sizes correctly costs the extra row's full length. */
  const breakdown = useMemo(() => {
    type Row = {
      size: SizeSpec["key"];
      count: number;
      rowsUsed: number;
      perRow: number;
      rowLengthMM: number;
      avgPerPrintMM: number;
      lineMM: number;
    };
    const byWidth: Record<24 | 42, { rows: Row[]; totalMM: number }> = {
      24: { rows: [], totalMM: 0 },
      42: { rows: [], totalMM: 0 },
    };
    for (const sz of SIZES) {
      const count = effective(sz.key);
      const rowsUsed = Math.ceil(count / sz.perRow);
      // Each row consumes (rowLengthMM + ROW_GAP_MM) on the roll, then the
      // global waste-buffer multiplier is applied on top.
      const lineMM = count > 0 ? rowsUsed * (sz.rowLengthMM + ROW_GAP_MM) * (1 + buffer) : 0;
      byWidth[sz.rollWidthInch].rows.push({
        size: sz.key,
        count,
        rowsUsed,
        perRow: sz.perRow,
        rowLengthMM: sz.rowLengthMM,
        avgPerPrintMM: (sz.rowLengthMM + ROW_GAP_MM) / sz.perRow,
        lineMM,
      });
      byWidth[sz.rollWidthInch].totalMM += lineMM;
    }
    return byWidth;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides, salesCounts, buffer]);

  const totalRolls24 = breakdown[24].totalMM / ROLL_LENGTH_MM;
  const totalRolls42 = breakdown[42].totalMM / ROLL_LENGTH_MM;

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight inline-flex items-center gap-2">
            <Printer size={18} /> Paper usage
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Roll consumption from the chosen week's print counts. Auto-fills from <strong>all A-size sales</strong>
            (framed + unframed — every framed print still consumes one roll-print at its size). Override any line to model
            what-ifs. <strong>Save snapshot</strong> deducts the computed rolls from inventory if you've mapped roll SKUs in
            Settings.
          </p>
        </div>
      </div>

      {/* ---- Inputs ---- */}
      <Card>
        <CardHeader>
          <CardTitle>Print counts</CardTitle>
          <span className="text-xs text-slate-500">
            Pick a week to pull counts from your unframed sales, or type override values.
          </span>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Field label="Week starting (Monday)">
              <Input type="date" value={weekStart}
                onChange={(e) => setWeekStart(snapToMonday(e.target.value || todayIso()))} />
            </Field>
            <Field label="Cutter / waste buffer (%)" hint="Adds a flat % on top of the raw print length per line. 0 = none.">
              <Input type="number" min={0} step="0.5" value={bufferPct}
                onChange={(e) => setBufferPct(e.target.value)} />
            </Field>
            <div className="flex items-end">
              <Button variant="secondary" size="sm" onClick={() => setOverrides({})}>
                Clear overrides (use sales)
              </Button>
            </div>
          </div>

          {/* Save snapshot row — persists current week + counts + buffer + notes */}
          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2 bg-slate-50/60 dark:bg-slate-900/30 space-y-2">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Notes for this snapshot">
                <Input value={notes} onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. heavier matte stock, included reprints, etc." className="w-72" />
              </Field>
              <Button
                size="sm"
                disabled={saveBusy}
                onClick={async () => {
                  setSaveBusy(true); setSaveMsg(null);
                  try {
                    const finalCounts: PaperUsageEntry["counts"] = {
                      A0: effective("A0"),
                      A1: effective("A1"),
                      A2: effective("A2"),
                      A3: effective("A3"),
                      A4: effective("A4"),
                    };

                    // Settings drive which SKU each roll width deducts from.
                    // If unmapped, we just save the entry without touching
                    // inventory.
                    const sku24Id = data?.settings.paper_roll_24_sku_id ?? null;
                    const sku42Id = data?.settings.paper_roll_42_sku_id ?? null;

                    // Reverse any prior deduction for this same week so
                    // re-saving is idempotent. Credit goes back to the SKU
                    // recorded on the old entry, not whatever's mapped now.
                    const existing = data?.paperUsage.find((p) => p.iso_week_start === weekStart);
                    if (existing) {
                      if (existing.deducted_sku_24_id && existing.deducted_rolls_24 > 0) {
                        await m.adjustOnHand.mutateAsync({
                          productId: existing.deducted_sku_24_id,
                          delta: -existing.deducted_rolls_24,
                          context: {
                            reason: "usage",
                            source_id: `paper:${weekStart}:24:reverse`,
                            parent_event_id: `paper:${weekStart}`,
                            note: "Paper-usage re-save — reverse prior 24″ deduction",
                          },
                        });
                      }
                      if (existing.deducted_sku_42_id && existing.deducted_rolls_42 > 0) {
                        await m.adjustOnHand.mutateAsync({
                          productId: existing.deducted_sku_42_id,
                          delta: -existing.deducted_rolls_42,
                          context: {
                            reason: "usage",
                            source_id: `paper:${weekStart}:42:reverse`,
                            parent_event_id: `paper:${weekStart}`,
                            note: "Paper-usage re-save — reverse prior 42″ deduction",
                          },
                        });
                      }
                    }

                    // Compute fresh deduction. Round UP — opening a roll =
                    // committing the whole roll, even if 4 m remain unused.
                    const rolls24 = Math.ceil(breakdown[24].totalMM / ROLL_LENGTH_MM);
                    const rolls42 = Math.ceil(breakdown[42].totalMM / ROLL_LENGTH_MM);
                    let deducted24 = 0;
                    let deducted42 = 0;
                    if (sku24Id && rolls24 > 0) {
                      await m.adjustOnHand.mutateAsync({
                        productId: sku24Id,
                        delta: rolls24,
                        context: {
                          reason: "usage",
                          source_id: `paper:${weekStart}:24`,
                          parent_event_id: `paper:${weekStart}`,
                          note: `Paper usage — week ${weekStart}, 24″ roll`,
                        },
                      });
                      deducted24 = rolls24;
                    }
                    if (sku42Id && rolls42 > 0) {
                      await m.adjustOnHand.mutateAsync({
                        productId: sku42Id,
                        delta: rolls42,
                        context: {
                          reason: "usage",
                          source_id: `paper:${weekStart}:42`,
                          parent_event_id: `paper:${weekStart}`,
                          note: `Paper usage — week ${weekStart}, 42″ roll`,
                        },
                      });
                      deducted42 = rolls42;
                    }

                    await m.upsertPaperUsage.mutateAsync({
                      iso_week_start: weekStart,
                      counts: finalCounts,
                      buffer_pct: Number(bufferPct) || 0,
                      notes: notes.trim(),
                      recorded_at: new Date().toISOString(),
                      recorded_by: "manual",
                      deducted_rolls_24: deducted24,
                      deducted_rolls_42: deducted42,
                      deducted_sku_24_id: deducted24 > 0 ? sku24Id : null,
                      deducted_sku_42_id: deducted42 > 0 ? sku42Id : null,
                    });
                    const deductMsg = deducted24 + deducted42 > 0
                      ? ` Deducted ${deducted42 ? `${deducted42}× 42″` : ""}${deducted42 && deducted24 ? " + " : ""}${deducted24 ? `${deducted24}× 24″` : ""} from inventory.`
                      : (!sku24Id && !sku42Id ? " (Paper-roll SKUs not mapped in Settings — no inventory change.)" : "");
                    setSaveMsg(`Saved snapshot for week ${weekStart}.${deductMsg}`);
                  } catch (e) {
                    setSaveMsg(`Save failed: ${(e as Error).message}`);
                  } finally {
                    setSaveBusy(false);
                  }
                }}
              >
                <Save size={14} /> {saveBusy ? "Saving…" : "Save snapshot"}
              </Button>
              {saveMsg ? <span className="text-xs text-emerald-700 dark:text-emerald-400">{saveMsg}</span> : null}
            </div>
            <div className="text-[11px] text-slate-500">
              Saves the current week's counts, waste buffer, and notes. Re-saving the same week overwrites the previous snapshot.
            </div>
          </div>

          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Size</th>
                  <th className="text-left px-2 py-2 font-medium">Printer / Roll</th>
                  <th className="text-right px-2 py-2 font-medium" title="Sum of all sales at this size for the selected week — framed (A1N/A1B/A1W/…) plus unframed (A1U). Every framed print still consumes one roll-print at its size.">From sales</th>
                  <th className="text-right px-2 py-2 font-medium">Count used</th>
                  <th className="text-right px-2 py-2 font-medium" title="Average roll length consumed per print, factoring in side-by-side nesting.">Avg mm / print</th>
                  <th className="text-right px-2 py-2 font-medium">Rows used</th>
                  <th className="text-right px-2 py-2 font-medium">Line mm</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {SIZES.map((sz) => {
                  const fromSales = salesCounts[sz.key] ?? 0;
                  const override = overrides[sz.key] ?? "";
                  const usingOverride = override !== "";
                  const count = effective(sz.key);
                  const rowsUsed = Math.ceil(count / sz.perRow);
                  const lineMM = count > 0 ? rowsUsed * (sz.rowLengthMM + ROW_GAP_MM) * (1 + buffer) : 0;
                  const avgPerPrint = (sz.rowLengthMM + ROW_GAP_MM) / sz.perRow;
                  return (
                    <tr key={sz.key}>
                      <td className="px-3 py-1.5">
                        <div className="font-medium">{sz.key}</div>
                        <div className="text-[11px] text-slate-500">{sz.label.replace(/^A\d  /, "")}</div>
                        <div className="text-[11px] text-slate-500">{sz.printedAs}</div>
                      </td>
                      <td className="px-2 py-1.5 text-slate-500 text-[11px]">{sz.printer}<br/>{sz.rollWidthInch}″ roll</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{fmtNum(fromSales)}</td>
                      <td className="px-2 py-1.5 text-right">
                        <Input type="number" min={0} step={1} value={override}
                          placeholder={String(fromSales)}
                          onChange={(e) => setOverrides((o) => ({ ...o, [sz.key]: e.target.value }))}
                          className={cn("w-24 h-8 text-right tabular-nums", usingOverride && "ring-1 ring-blue-400 dark:ring-blue-500")}
                          title={usingOverride ? "Manual override — clear to fall back to sales count" : "Falls back to sales count when blank"}
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-500" title={`(${sz.rowLengthMM} + ${ROW_GAP_MM} mm gap) / row of ${sz.perRow}`}>
                        {fmtNum(Math.round(avgPerPrint))}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-500" title={`Each row = ${sz.rowLengthMM} mm + ${ROW_GAP_MM} mm gap, holds ${sz.perRow} print${sz.perRow === 1 ? "" : "s"}`}>
                        {count > 0 ? rowsUsed : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{count > 0 ? fmtNum(Math.round(lineMM)) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      {/* ---- Outputs per roll width ---- */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {([42, 24] as const).map((w) => {
          const block = breakdown[w];
          const rolls = block.totalMM / ROLL_LENGTH_MM;
          const fullRolls = Math.floor(rolls);
          const partial = rolls - fullRolls;
          // On-hand for this roll width — derived live from the mapped SKU.
          const rollSkuId = w === 24
            ? data?.settings.paper_roll_24_sku_id
            : data?.settings.paper_roll_42_sku_id;
          const rollSku = rollSkuId
            ? data?.products.find((p) => p.id === rollSkuId)
            : undefined;
          const onHand = rollSku?.current_on_hand ?? null;
          const willDeduct = Math.ceil(rolls);
          const afterDeduct = onHand !== null ? Math.max(onHand - willDeduct, 0) : null;
          return (
            <Card key={w}>
              <CardHeader>
                <CardTitle>{w}″ roll · {w === 42 ? "GP-4000" : "GP-2000"}</CardTitle>
                <span className="text-xs text-slate-500">{PRINTER_BY_WIDTH[w]}</span>
              </CardHeader>
              <CardBody className="space-y-3">
                <table className="w-full text-sm">
                  <thead className="text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
                    <tr>
                      <th className="text-left font-medium px-2 py-1">Size</th>
                      <th className="text-right font-medium px-2 py-1">Prints</th>
                      <th className="text-right font-medium px-2 py-1">Rows</th>
                      <th className="text-right font-medium px-2 py-1" title="Roll length consumed per row × prints-per-row.">Row layout</th>
                      <th className="text-right font-medium px-2 py-1">Line mm</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {block.rows.map((r) => (
                      <tr key={r.size}>
                        <td className="px-2 py-1.5 font-medium">{r.size}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(r.count)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{r.count > 0 ? r.rowsUsed : "—"}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-[11px] text-slate-500">
                          {r.rowLengthMM} + {ROW_GAP_MM} mm gap × {r.perRow}/row
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{r.count > 0 ? fmtNum(Math.round(r.lineMM)) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-300 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-900/40">
                      <td className="px-2 py-2 font-semibold uppercase text-[11px] tracking-wide">Total</td>
                      <td />
                      <td />
                      <td />
                      <td className="px-2 py-2 text-right tabular-nums font-bold">{fmtNum(Math.round(block.totalMM))} mm</td>
                    </tr>
                  </tfoot>
                </table>

                <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2 bg-slate-50/60 dark:bg-slate-900/30 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="text-[10px] uppercase tracking-wide font-semibold text-slate-500">Roll usage</span>
                  <span className="text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-100">{fmtFloat(block.totalMM / 1000, 2)} m</span>
                  <span className="text-sm text-slate-500">·</span>
                  <span className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">{fmtFloat(rolls, 2)} rolls</span>
                  <span className="text-[11px] text-slate-500 ml-auto">
                    {fullRolls > 0 ? `${fullRolls} full + ${fmtFloat(partial * ROLL_LENGTH_M, 1)} m` : `${fmtFloat(partial * ROLL_LENGTH_M, 1)} m of a roll`}
                  </span>
                </div>

                {/* Live inventory readout from the mapped roll-SKU. Empty
                    state nudges the user to wire up the SKU mapping in
                    Settings. */}
                <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2 bg-white dark:bg-slate-950/40 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="text-[10px] uppercase tracking-wide font-semibold text-slate-500">Stock</span>
                  {rollSku ? (
                    <>
                      <span className="text-sm text-slate-600 dark:text-slate-300 truncate max-w-[18ch]" title={rollSku.code}>
                        {rollSku.code}
                      </span>
                      <span className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">
                        {fmtNum(onHand ?? 0)} {(onHand ?? 0) === 1 ? "roll" : "rolls"}
                      </span>
                      <span className="text-[11px] text-slate-500">on hand</span>
                      {willDeduct > 0 ? (
                        <span className={cn(
                          "text-[11px] ml-auto tabular-nums",
                          (afterDeduct ?? 0) <= 1 ? "text-red-600 dark:text-red-400 font-semibold" : "text-slate-500",
                        )}>
                          Save will deduct <strong>{willDeduct}</strong> → <strong>{fmtNum(afterDeduct ?? 0)}</strong> left
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-[11px] text-amber-600 dark:text-amber-400 italic">
                      No SKU mapped — pick the {w}″ paper-roll SKU in Settings → "Paper-roll inventory" to enable auto-deduction on save.
                    </span>
                  )}
                </div>
              </CardBody>
            </Card>
          );
        })}
      </div>

      {/* ---- Summary tile ---- */}
      <Card>
        <CardHeader>
          <CardTitle>Week summary</CardTitle>
          <span className="text-xs text-slate-500">
            Week of <strong>{weekStart}</strong>
            {Object.keys(overrides).filter((k) => overrides[k] !== "").length > 0
              ? ` · ${Object.keys(overrides).filter((k) => overrides[k] !== "").length} override${Object.keys(overrides).filter((k) => overrides[k] !== "").length === 1 ? "" : "s"} applied`
              : ""}
            {buffer > 0 ? ` · ${fmtFloat(buffer * 100, 1)}% waste buffer` : ""}
          </span>
        </CardHeader>
        <CardBody>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
            <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-3">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">42″ rolls (GP-4000)</div>
              <div className="text-2xl font-bold tabular-nums">{fmtFloat(totalRolls42, 2)}</div>
              <div className="text-[11px] text-slate-500">{fmtFloat(breakdown[42].totalMM / 1000, 1)} m</div>
            </div>
            <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-3">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">24″ rolls (GP-2000)</div>
              <div className="text-2xl font-bold tabular-nums">{fmtFloat(totalRolls24, 2)}</div>
              <div className="text-[11px] text-slate-500">{fmtFloat(breakdown[24].totalMM / 1000, 1)} m</div>
            </div>
            <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-3">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Total prints</div>
              <div className="text-2xl font-bold tabular-nums">
                {fmtNum(SIZES.reduce((a, sz) => a + effective(sz.key), 0))}
              </div>
              <div className="text-[11px] text-slate-500">A0–A4 unframed</div>
            </div>
            <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-3">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Total length</div>
              <div className="text-2xl font-bold tabular-nums">
                {fmtFloat((breakdown[24].totalMM + breakdown[42].totalMM) / 1000, 1)}
              </div>
              <div className="text-[11px] text-slate-500">metres of paper</div>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* ---- History ---- */}
      <Card>
        <CardHeader>
          <CardTitle>Saved snapshots</CardTitle>
          <span className="text-xs text-slate-500">
            {data?.paperUsage?.length ?? 0} entr{(data?.paperUsage?.length ?? 0) === 1 ? "y" : "ies"} ·
            recomputed live from the persisted counts + buffer, so editing the nesting math reflects in history too.
          </span>
        </CardHeader>
        <CardBody className="p-0">
          {!data?.paperUsage || data.paperUsage.length === 0 ? (
            <div className="p-6 text-sm text-slate-500">
              No saved snapshots yet. Type counts above and click <strong>Save snapshot</strong> to log this week.
            </div>
          ) : (
            <div className="max-h-[420px] overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide sticky top-0 z-10">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">Week</th>
                    <th className="text-right font-medium px-2 py-2">A0</th>
                    <th className="text-right font-medium px-2 py-2">A1</th>
                    <th className="text-right font-medium px-2 py-2">A2</th>
                    <th className="text-right font-medium px-2 py-2">A3</th>
                    <th className="text-right font-medium px-2 py-2">A4</th>
                    <th className="text-right font-medium px-2 py-2" title="Roll buffer applied to this snapshot">Buf%</th>
                    <th className="text-right font-medium px-2 py-2" title="Rolls used (computed live)">42″ used</th>
                    <th className="text-right font-medium px-2 py-2" title="Rolls used (computed live)">24″ used</th>
                    <th className="text-right font-medium px-2 py-2" title="Whole rolls deducted from inventory when this snapshot was saved">Deducted</th>
                    <th className="text-left font-medium px-3 py-2">Notes</th>
                    <th className="text-right font-medium px-2 py-2 w-px">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {data.paperUsage
                    .slice()
                    .sort((a, b) => b.iso_week_start.localeCompare(a.iso_week_start))
                    .map((e) => {
                      // Recompute totals from the persisted counts using the
                      // current nesting model. Keeps history accurate when the
                      // math changes (e.g. new packing rules added later).
                      const buf = (e.buffer_pct ?? 0) / 100;
                      let mm24 = 0, mm42 = 0;
                      for (const sz of SIZES) {
                        const c = e.counts[sz.key] ?? 0;
                        const rows = Math.ceil(c / sz.perRow);
                        const mm = c > 0 ? rows * (sz.rowLengthMM + ROW_GAP_MM) * (1 + buf) : 0;
                        if (sz.rollWidthInch === 24) mm24 += mm; else mm42 += mm;
                      }
                      return (
                        <tr key={e.iso_week_start}>
                          <td className="px-3 py-1.5">
                            <div className="font-medium tabular-nums">{fmtShortDate(e.iso_week_start)}</div>
                            <div className="text-[10px] text-slate-500 tabular-nums">{e.iso_week_start}</div>
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{e.counts.A0 || "—"}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{e.counts.A1 || "—"}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{e.counts.A2 || "—"}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{e.counts.A3 || "—"}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{e.counts.A4 || "—"}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{e.buffer_pct > 0 ? `${fmtFloat(e.buffer_pct, 1)}%` : "—"}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums font-semibold">
                            {fmtFloat(mm42 / ROLL_LENGTH_MM, 2)}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums font-semibold">
                            {fmtFloat(mm24 / ROLL_LENGTH_MM, 2)}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-[11px] text-slate-600 dark:text-slate-300"
                              title="Whole rolls deducted from inventory at save time. Reversed on delete or re-save.">
                            {(e.deducted_rolls_42 || 0) + (e.deducted_rolls_24 || 0) > 0 ? (
                              <span>
                                {e.deducted_rolls_42 ? <span className="mr-1">{e.deducted_rolls_42}× 42″</span> : null}
                                {e.deducted_rolls_24 ? <span>{e.deducted_rolls_24}× 24″</span> : null}
                              </span>
                            ) : <span className="text-slate-400">—</span>}
                          </td>
                          <td className="px-3 py-1.5 text-slate-600 dark:text-slate-300 max-w-[260px] truncate" title={e.notes || ""}>
                            {e.notes || <span className="text-slate-400">—</span>}
                          </td>
                          <td className="px-2 py-1.5 whitespace-nowrap text-right">
                            <button
                              className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                              title="Load this snapshot into the editor above"
                              onClick={() => {
                                setWeekStart(e.iso_week_start);
                                setOverrides({
                                  A0: String(e.counts.A0 ?? 0),
                                  A1: String(e.counts.A1 ?? 0),
                                  A2: String(e.counts.A2 ?? 0),
                                  A3: String(e.counts.A3 ?? 0),
                                  A4: String(e.counts.A4 ?? 0),
                                });
                                setBufferPct(String(e.buffer_pct ?? 0));
                                setNotes(e.notes ?? "");
                                setSaveMsg(`Loaded snapshot for week ${e.iso_week_start} into the editor.`);
                              }}
                              aria-label={`Load snapshot for ${e.iso_week_start}`}
                            >
                              <LoadIcon size={14} />
                            </button>
                            <button
                              className="inline-flex h-7 w-7 items-center justify-center rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
                              title="Delete this snapshot (also credits its deducted rolls back to inventory)"
                              onClick={async () => {
                                const willCredit = (e.deducted_rolls_24 || 0) + (e.deducted_rolls_42 || 0);
                                const msg = willCredit > 0
                                  ? `Delete the saved snapshot for week ${e.iso_week_start}? This will credit ${e.deducted_rolls_42 || 0}× 42″ and ${e.deducted_rolls_24 || 0}× 24″ rolls back to inventory.`
                                  : `Delete the saved snapshot for week ${e.iso_week_start}?`;
                                if (!window.confirm(msg)) return;
                                // Credit deducted rolls back first, then drop the row.
                                if (e.deducted_sku_24_id && e.deducted_rolls_24 > 0) {
                                  await m.adjustOnHand.mutateAsync({
                                    context: {
                                      reason: "usage",
                                      source_id: `paper:${e.iso_week_start}:24:delete`,
                                      parent_event_id: `paper:${e.iso_week_start}`,
                                      note: `Paper snapshot deleted — credit reversed (week ${e.iso_week_start})`,
                                    },
                                    productId: e.deducted_sku_24_id,
                                    delta: -e.deducted_rolls_24,
                                  });
                                }
                                if (e.deducted_sku_42_id && e.deducted_rolls_42 > 0) {
                                  await m.adjustOnHand.mutateAsync({
                                    productId: e.deducted_sku_42_id,
                                    delta: -e.deducted_rolls_42,
                                    context: {
                                      reason: "usage",
                                      source_id: `paper:${e.iso_week_start}:42:delete`,
                                      parent_event_id: `paper:${e.iso_week_start}`,
                                      note: `Paper snapshot deleted — credit reversed (week ${e.iso_week_start})`,
                                    },
                                  });
                                }
                                await m.deletePaperUsage.mutateAsync(e.iso_week_start);
                                setSaveMsg(`Deleted snapshot for week ${e.iso_week_start}.${willCredit > 0 ? " Inventory credited back." : ""}`);
                              }}
                              aria-label={`Delete snapshot for ${e.iso_week_start}`}
                            >
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <p className="text-[11px] text-slate-500">
        Math: prints are nested side-by-side across the roll where they fit, with a fixed {ROW_GAP_MM} mm cutter / trim gap baked into every row.
        A1 portrait (594 mm across) — 1 per row, 841 mm row.
        A2 landscape (594 mm across) — 1 per row, 420 mm row.
        A3 portrait (2×297 = 594 mm) — 2 per row, 420 mm row → 210 mm/print average (before gap).
        A4 landscape (2×297 = 594 mm) — 2 per row, 210 mm row → 105 mm/print average (before gap).
        A0 portrait (841 mm across the 42″ roll) — 1 per row, 1189 mm row.
        Line mm = ⌈count / per-row⌉ × (row mm + {ROW_GAP_MM} mm), so an odd count of 2-per-row prints correctly costs the extra row's full length + gap.
        Use the waste-buffer % above for anything the gap doesn't cover (start-of-roll leader, end-of-job trim, etc).
      </p>
    </div>
  );
}
