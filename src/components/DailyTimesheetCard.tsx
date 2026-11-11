import { useState } from "react";
import { CalendarDays, Download, FileSpreadsheet } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { getSupabase, getBackendMode } from "@/lib/repository/supabase/client";
import { useAppStore } from "@/lib/state/appStore";
import { computeShifts, formatShiftDuration, effectiveHourlyRate, type ShiftEvent } from "@/lib/domain/shifts";

/**
 * Timesheet export: pick a From / To date range, download as CSV or XLSX.
 *
 * Algorithm (computeShifts) handles:
 *   - 30-min between-orders gap rule (under = paid transition, over = break)
 *   - Long focused work protected (started -> completed bracket on order scan)
 *   - Forgot-to-clock-out (silence > 2h means shift ended at last event)
 *
 * For a single-day range (from = to), behaviour matches the old card.
 * For a multi-day range, all shifts roll up into one sheet sorted by
 * date then by staff name.
 */
export function DailyTimesheetCard() {
  if (getBackendMode() !== "supabase") return null;
  return <DailyTimesheetCardInner />;
}

function todayLocalIsoDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function escapeCsv(v: string | number): string {
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function secondsToHours(sec: number): number {
  return Math.round((sec / 3600) * 100) / 100;
}

interface Row {
  Name: string;
  Date: string;
  "Clock in": string;
  "Clock out": string;
  "Inferred end": string;
  "Total hours": number;
  "Break hours": number;
  "Billable hours": number;
  "Hourly rate": number;
  Cost: number;
}

async function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) { resolve(); return; }
    const tag = document.createElement("script");
    tag.src = src;
    tag.async = true;
    tag.onload = () => resolve();
    tag.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(tag);
  });
}

function DailyTimesheetCardInner() {
  const supabase = getSupabase();
  const location = useAppStore((s) => s.location);
  const [fromDate, setFromDate] = useState<string>(todayLocalIsoDate());
  const [toDate, setToDate] = useState<string>(todayLocalIsoDate());
  const [busy, setBusy] = useState<null | "csv" | "xlsx">(null);
  const [msg, setMsg] = useState<string | null>(null);

  /**
   * Fetch events for the date range and compute the rows + grand totals.
   * Returns null on error (already surfaced via setMsg).
   */
  const buildRows = async (): Promise<{ rows: Row[]; totalBillableSec: number; totalCost: number; rangeLabel: string } | null> => {
    // Validate range.
    if (!fromDate || !toDate) {
      setMsg("Pick both From and To dates.");
      return null;
    }
    if (fromDate > toDate) {
      setMsg("From date must be on or before To date.");
      return null;
    }

    const [fy, fm, fd] = fromDate.split("-").map(Number);
    const [ty, tm, td] = toDate.split("-").map(Number);
    const rangeStart = new Date(fy, fm - 1, fd, 0, 0, 0, 0);
    const rangeEnd = new Date(ty, tm - 1, td + 1, 0, 0, 0, 0);

    const [evRes, barcodesRes, ratesRes] = await Promise.all([
      supabase
        .from("production_events")
        .select("staff_id, event_type, order_number, created_at")
        .eq("location", location)
        .in("event_type", ["clock_in", "clock_out", "started", "completed", "dispatched"])
        .gte("created_at", rangeStart.toISOString())
        .lt("created_at", rangeEnd.toISOString())
        .order("created_at", { ascending: true }),
      supabase
        .from("staff_barcodes")
        .select("user_id, display_name")
        .eq("location", location),
      supabase
        .from("staff_rates")
        .select("user_id, hourly_rate")
        .eq("location", location),
    ]);
    if (evRes.error) { setMsg(`Events query failed: ${evRes.error.message}`); return null; }
    if (barcodesRes.error) { setMsg(`Names query failed: ${barcodesRes.error.message}`); return null; }
    if (ratesRes.error) { setMsg(`Rates query failed: ${ratesRes.error.message}`); return null; }

    const events = (evRes.data ?? []) as ShiftEvent[];
    if (events.length === 0) {
      setMsg(`No production events in the selected range.`);
      return null;
    }

    const nameByUser = new Map<string, string>();
    for (const r of (barcodesRes.data ?? [])) {
      if (!nameByUser.has(r.user_id)) nameByUser.set(r.user_id, r.display_name);
    }
    const rateByUser = new Map<string, number>();
    for (const r of (ratesRes.data ?? [])) {
      if (!rateByUser.has(r.user_id)) rateByUser.set(r.user_id, Number(r.hourly_rate));
    }

    const shifts = computeShifts(events, { gapThresholdMin: 30, staleHours: 2 });
    if (shifts.length === 0) {
      setMsg(`No shifts found in the selected range. (Events exist but no clock_in/out detected.)`);
      return null;
    }

    // Sort: by date ascending, then by name.
    shifts.sort((a, b) => a.date.localeCompare(b.date) || (nameByUser.get(a.staff_id) ?? "").localeCompare(nameByUser.get(b.staff_id) ?? ""));

    let totalBillableSec = 0;
    let totalCost = 0;
    const rows: Row[] = shifts.map((s) => {
      const rate = effectiveHourlyRate(rateByUser.get(s.staff_id));
      const billableHours = secondsToHours(s.billable_seconds);
      const cost = Math.round(billableHours * rate * 100) / 100;
      totalBillableSec += s.billable_seconds;
      totalCost += cost;
      return {
        Name: nameByUser.get(s.staff_id) ?? s.staff_id,
        Date: s.date,
        "Clock in": hhmm(s.clock_in_at),
        "Clock out": s.clock_out_at ? hhmm(s.clock_out_at) : "",
        "Inferred end": s.inferred_end ? `inferred (${hhmm(s.effective_end_at)})` : "",
        "Total hours": secondsToHours(s.total_seconds),
        "Break hours": secondsToHours(s.break_seconds),
        "Billable hours": billableHours,
        "Hourly rate": rate,
        Cost: cost,
      };
    });

    const rangeLabel = fromDate === toDate ? fromDate : `${fromDate}_to_${toDate}`;
    return { rows, totalBillableSec, totalCost, rangeLabel };
  };

  const onDownloadCsv = async () => {
    setMsg(null);
    setBusy("csv");
    try {
      const built = await buildRows();
      if (!built) return;
      const { rows, totalBillableSec, totalCost, rangeLabel } = built;
      const header = Object.keys(rows[0]) as Array<keyof Row>;
      const lines: string[] = [];
      lines.push(header.map((h) => escapeCsv(String(h))).join(","));
      for (const r of rows) {
        lines.push(header.map((h) => escapeCsv(r[h] as string | number)).join(","));
      }
      // Totals row.
      const totalRow: Record<string, string | number> = {};
      for (const h of header) totalRow[h] = "";
      totalRow["Name"] = "TOTAL";
      totalRow["Billable hours"] = secondsToHours(totalBillableSec);
      totalRow["Cost"] = Math.round(totalCost * 100) / 100;
      lines.push(header.map((h) => escapeCsv(totalRow[h] as string | number)).join(","));

      const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `timesheet_${rangeLabel}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setMsg(`Downloaded CSV: ${rows.length} shift${rows.length === 1 ? "" : "s"}, total billable ${formatShiftDuration(totalBillableSec)} / $${totalCost.toFixed(2)}.`);
    } catch (e) {
      setMsg(`CSV error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const onDownloadXlsx = async () => {
    setMsg(null);
    setBusy("xlsx");
    try {
      const built = await buildRows();
      if (!built) return;
      const { rows, totalBillableSec, totalCost, rangeLabel } = built;

      // Load SheetJS at click time so we don't ship the lib at app load.
      await loadScript("https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js");
      type Cols = { wch: number }[];
      type WS = { "!cols"?: Cols } & Record<string, unknown>;
      type XLSXLib = {
        utils: {
          json_to_sheet: (data: Record<string, string | number>[]) => WS;
          sheet_add_aoa: (ws: WS, data: (string | number)[][], opts: { origin: string }) => void;
          book_new: () => unknown;
          book_append_sheet: (wb: unknown, ws: WS, name: string) => void;
          decode_range: (ref: string) => { e: { r: number } };
          encode_range: (range: { s: { c: number; r: number }; e: { c: number; r: number } }) => string;
        };
        writeFile: (wb: unknown, filename: string) => void;
      };
      const XLSX = (window as unknown as { XLSX?: XLSXLib }).XLSX;
      if (!XLSX) throw new Error("XLSX failed to load from CDN");

      // Convert rows to a worksheet, then append a TOTAL row beneath.
      const ws = XLSX.utils.json_to_sheet(rows as unknown as Record<string, string | number>[]);
      const totalRow: (string | number)[] = [
        "TOTAL", "", "", "", "", "", "", secondsToHours(totalBillableSec), "", Math.round(totalCost * 100) / 100,
      ];
      XLSX.utils.sheet_add_aoa(ws, [totalRow], { origin: `A${rows.length + 2}` });

      // Column widths - rough auto-fit so dates and names are legible.
      ws["!cols"] = [
        { wch: 22 }, // Name
        { wch: 12 }, // Date
        { wch: 9 },  // Clock in
        { wch: 9 },  // Clock out
        { wch: 22 }, // Inferred end
        { wch: 12 }, // Total hours
        { wch: 12 }, // Break hours
        { wch: 14 }, // Billable hours
        { wch: 12 }, // Hourly rate
        { wch: 10 }, // Cost
      ];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Timesheet");
      XLSX.writeFile(wb, `timesheet_${rangeLabel}.xlsx`);
      setMsg(`Downloaded workbook: ${rows.length} shift${rows.length === 1 ? "" : "s"}, total billable ${formatShiftDuration(totalBillableSec)} / $${totalCost.toFixed(2)}.`);
    } catch (e) {
      setMsg(`Workbook error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2">
          <CalendarDays size={16} /> Timesheet export
        </CardTitle>
        <span className="text-xs text-slate-500">
          Per-shift breakdown for the selected date range: clock-in/out, breaks deducted, billable hours, cost at each staff member's hourly rate.
        </span>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 font-semibold">
              From
            </label>
            <Input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="h-9 w-44 text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 font-semibold">
              To
            </label>
            <Input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="h-9 w-44 text-sm"
            />
          </div>
          <Button onClick={onDownloadCsv} disabled={busy !== null} className="inline-flex items-center gap-2">
            <Download size={14} /> {busy === "csv" ? "Generating..." : "Download CSV"}
          </Button>
          <Button onClick={onDownloadXlsx} disabled={busy !== null} className="inline-flex items-center gap-2">
            <FileSpreadsheet size={14} /> {busy === "xlsx" ? "Generating..." : "Download Excel"}
          </Button>
        </div>
        {msg ? (
          <div className="text-xs text-slate-600 dark:text-slate-300">{msg}</div>
        ) : null}
        <div className="text-[11px] text-slate-500">
          Break rule: any gap of 30+ minutes between orders is deducted. Time within an order (between started and completed) is always paid. Forgotten clock-outs: shift ends at the last meaningful event if silent for 2+ hours. Single-day exports use the file name <code>timesheet_2026-06-09</code>; ranges use <code>timesheet_2026-06-01_to_2026-06-07</code>.
        </div>
      </CardBody>
    </Card>
  );
}