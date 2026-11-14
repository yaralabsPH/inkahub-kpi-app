import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, ChevronDown, ChevronRight, ClipboardList, Download, RefreshCw, Search, Trash2 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { getSupabase, getBackendMode } from "@/lib/repository/supabase/client";
import { fetchAllRows } from "@/lib/repository/supabase/pageThrough";
import { createOrderLookupSession, type OrderLookupView } from "@/lib/repository/supabase/orderLookupSession";
import { useAppStore } from "@/lib/state/appStore";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import {
  PRODUCTION_DEPARTMENT_LABELS,
  type ProductionDepartment,
} from "@/lib/domain";
import { cn } from "@/lib/utils/cn";
import { useAuth } from "@/lib/auth/AuthProvider";
import { OrderNotesPanel } from "@/components/OrderNotesPanel";
import { DailyTimesheetCard } from "@/components/DailyTimesheetCard";
import { PackageUsageCard } from "@/components/PackageUsageCard";
import { PackageHistoryCard } from "@/components/PackageHistoryCard";
import { LiveOrderCompletionsCard } from "@/components/LiveOrderCompletionsCard";
import { ProductionCountStatus } from "@/components/ProductionCountStatus";
import { useProductionEvidence } from "@/lib/hooks/useProductionSummary";
import {
  isProductionDate,
  isReportSite,
  productionDateAt,
  productionRange,
  shiftProductionDate,
  type ProductionRange,
} from "@/lib/domain/productionPeriods";
import { type ProductionEvidenceEvent, type WorkType } from "@/lib/domain/productionCounts";
import { buildProductionReportView, orderLookupCounts, type ItemsOrders, type ReportDay } from "@/lib/domain/productionReportView";
import { loadOrderLookup } from "@/lib/repository/supabase/orderLookup";
import { productionVisibilityFor } from "@/lib/repository/supabase/productionEvidence";

/**
 * Reports tab — production analytics for owners + managers.
 *
 * Counts (F1): one production-evidence snapshot per refresh, loaded through
 * the shared reader for the site's 04:00 production days, prepared once and
 * projected by productionReportView.ts. Items, Orders, rework and coverage
 * come from the shared reducer; frame timing (avg min, hours, cost) comes
 * from productionFrameTiming.ts and never uses UN Items.
 *
 * Joins: staff_barcodes → display_name; staff_rates → hourly_rate for cost.
 *
 * Filters: production days (Today / 7d / 30d / Custom), staff, department.
 *
 * NavGate already restricts the route to users with `reports` in allowed_nav,
 * which (per role defaults) means owner + manager only.
 */

type PresetRange = "today" | "7d" | "30d" | "custom";

interface StaffLookup {
  user_id: string;
  display_name: string;
  hourly_rate: number | null;
}

/* ============================================================
 * Date helpers
 * ============================================================ */

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

/** Browser-day window, kept only for the package-usage card (unchanged by F1). */
function packageWindow(preset: PresetRange, customFrom?: Date, customTo?: Date): { from: Date; to: Date } {
  const now = new Date();
  if (preset === "today") return { from: startOfDay(now), to: endOfDay(now) };
  if (preset === "7d" || preset === "30d") {
    const from = startOfDay(now);
    from.setDate(from.getDate() - (preset === "7d" ? 6 : 29));
    return { from, to: endOfDay(now) };
  }
  return {
    from: customFrom ? startOfDay(customFrom) : startOfDay(now),
    to: customTo ? endOfDay(customTo) : endOfDay(now),
  };
}

function isoLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Production range for a preset; null with a reason when it cannot be built. */
function reportRange(
  site: string,
  preset: PresetRange,
  customFrom: string,
  customTo: string,
): { range: ProductionRange | null; problem: string | null } {
  if (!isReportSite(site)) return { range: null, problem: null };
  const today = productionDateAt(new Date(), site);
  if (preset === "today") return { range: productionRange(site, today, today), problem: null };
  if (preset === "7d") return { range: productionRange(site, shiftProductionDate(today, -6), today), problem: null };
  if (preset === "30d") return { range: productionRange(site, shiftProductionDate(today, -29), today), problem: null };
  if (!isProductionDate(customFrom) || !isProductionDate(customTo)) return { range: null, problem: "Choose a valid start and end date." };
  if (customFrom > customTo) return { range: null, problem: "The custom range ends before it starts." };
  return { range: productionRange(site, customFrom, customTo), problem: null };
}

function formatMinutes(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return "—";
  if (m < 1) return `${(m * 60).toFixed(0)}s`;
  if (m < 60) return `${m.toFixed(1)}m`;
  const h = Math.floor(m / 60);
  const r = m - h * 60;
  return `${h}h ${r.toFixed(0)}m`;
}

function formatHours(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return "0h";
  return `${(m / 60).toFixed(1)}h`;
}

/** Items can be null when an exact total would overflow; never show a rounded guess. */
function fmtItems(n: number | null): string {
  return n === null ? "too large" : n.toLocaleString();
}

/* ============================================================
 * Page
 * ============================================================ */

const ALL_STAFF = "__all__";
const ALL_DEPARTMENTS = "__all__";

const DEPARTMENT_OPTIONS: { value: ProductionDepartment | typeof ALL_DEPARTMENTS; label: string }[] = [
  { value: ALL_DEPARTMENTS, label: "All departments" },
  { value: "a0_framed", label: PRODUCTION_DEPARTMENT_LABELS.a0_framed },
  { value: "framed",    label: PRODUCTION_DEPARTMENT_LABELS.framed },
  { value: "unframed",  label: PRODUCTION_DEPARTMENT_LABELS.unframed },
  { value: "dispatch",  label: PRODUCTION_DEPARTMENT_LABELS.dispatch },
];

export function Reports() {
  // The Supabase client is only constructed on the Supabase path, so the
  // local-only (Dexie) build renders this message without missing-key errors.
  if (getBackendMode() !== "supabase") {
    return (
      <div className="p-6">
        <Card>
          <CardBody>
            <div className="text-sm text-slate-600 dark:text-slate-400">
              Reports require the Supabase backend. This dataset is running in
              local-only mode.
            </div>
          </CardBody>
        </Card>
      </div>
    );
  }
  return <SupabaseReports />;
}

function SupabaseReports() {
  const supabase = getSupabase();
  const location = useAppStore((s) => s.location);

  const [preset, setPreset] = useState<PresetRange>("7d");
  const [customFrom, setCustomFrom] = useState<string>(() =>
    isoLocalDate(new Date(Date.now() - 6 * 86_400_000)),
  );
  const [customTo, setCustomTo] = useState<string>(() => isoLocalDate(new Date()));
  const [selectedStaff, setSelectedStaff] = useState<string>(ALL_STAFF);
  const [selectedDepartment, setSelectedDepartment] =
    useState<ProductionDepartment | typeof ALL_DEPARTMENTS>(ALL_DEPARTMENTS);
  const [refreshTick, setRefreshTick] = useState(0);
  // === per-day-worked view ===
  const [chartMode, setChartMode] = useState<"totals" | "perDay">("totals");

  // Production days at the site (04:00 boundaries). Recomputed on refresh so
  // "today" rolls over at 04:00 site time.
  const { range, problem: rangeProblem } = useMemo(
    () => reportRange(location, preset, customFrom, customTo),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [location, preset, customFrom, customTo, refreshTick],
  );
  const pkgWindow = useMemo(() => {
    const cf = customFrom ? new Date(customFrom) : undefined;
    const ct = customTo ? new Date(customTo) : undefined;
    return packageWindow(preset, cf, ct);
  }, [preset, customFrom, customTo]);

  const evidence = useProductionEvidence({ client: supabase, site: location, range, refreshKey: refreshTick });

  const [staffLookup, setStaffLookup] = useState<Map<string, StaffLookup>>(new Map());
  const [staffError, setStaffError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // Clear person filter and lookups when the site changes.
  useEffect(() => {
    setSelectedStaff(ALL_STAFF);
    setStaffLookup(new Map());
  }, [location]);

  // -------- staff names + rates (display only; counts never depend on them) --------
  useEffect(() => {
    let cancelled = false;
    setStaffError(null);
    (async () => {
      try {
        const [staffRes, rateRes] = await Promise.all([
          supabase
            .from("staff_barcodes")
            .select("user_id, display_name, active")
            .eq("location", location),
          supabase
            .from("staff_rates")
            .select("user_id, hourly_rate")
            .eq("location", location),
        ]);
        if (staffRes.error) throw staffRes.error;
        if (rateRes.error) throw rateRes.error;
        if (cancelled) return;

        const lookup = new Map<string, StaffLookup>();
        for (const row of (staffRes.data ?? []) as Array<{
          user_id: string; display_name: string; active: boolean;
        }>) {
          const existing = lookup.get(row.user_id);
          if (!existing || row.active) {
            lookup.set(row.user_id, {
              user_id: row.user_id,
              display_name: row.display_name,
              hourly_rate: existing?.hourly_rate ?? null,
            });
          }
        }
        for (const row of (rateRes.data ?? []) as Array<{
          user_id: string; hourly_rate: number;
        }>) {
          const existing = lookup.get(row.user_id);
          if (existing) {
            existing.hourly_rate = row.hourly_rate;
          } else {
            lookup.set(row.user_id, {
              user_id: row.user_id,
              display_name: `User ${row.user_id.slice(0, 8)}`,
              hourly_rate: row.hourly_rate,
            });
          }
        }
        setStaffLookup(lookup);
      } catch (e) {
        if (!cancelled) setStaffError(`Staff names unavailable: ${(e as Error).message}`);
      }
    })();
    return () => { cancelled = true; };
  }, [supabase, location, refreshTick]);

  const nameOf = useCallback(
    (id: string) => staffLookup.get(id)?.display_name ?? `User ${id.slice(0, 8)}`,
    [staffLookup],
  );

  const staffId = selectedStaff === ALL_STAFF ? null : selectedStaff;
  const workType = selectedDepartment === ALL_DEPARTMENTS ? null : (selectedDepartment as WorkType);
  const view = useMemo(
    () => (evidence.prepared && range ? buildProductionReportView(evidence.prepared, { range, staffId, workType }) : null),
    [evidence.prepared, range, staffId, workType],
  );

  // -------- staff dropdown options --------
  const staffOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const r of view?.leaderboard ?? []) ids.add(r.staffId);
    for (const e of view?.exportEvents ?? []) if (e.staff_id) ids.add(e.staff_id);
    for (const [id] of staffLookup) ids.add(id);
    return Array.from(ids)
      .map((id) => ({ user_id: id, display_name: nameOf(id) }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
  }, [view, staffLookup, nameOf]);

  const staffBoard = useMemo(
    () =>
      (view?.leaderboard ?? []).map((r) => {
        const rate = staffLookup.get(r.staffId)?.hourly_rate ?? null;
        return { ...r, display_name: nameOf(r.staffId), cost: rate != null ? (r.timing.durationMin / 60) * rate : null };
      }),
    [view, staffLookup, nameOf],
  );

  // -------- CSV export (respects all filters; raw saved values) --------
  const handleExport = useCallback(async () => {
    if (!view || !range) return;
    const rowsToExport = view.exportEvents;
    setExportError(null);
    setExporting(true);
    try {
      // Note/station are display-only columns: fetched for the selected days
      // only, never for every context row of the count snapshot.
      const extra = await fetchAllRows<{ id: string; station_id: string | null; note: string | null }>((from, to) =>
        supabase
          .from("production_events")
          .select("id, station_id, note")
          .eq("location", location)
          .in("event_type", ["line_verified", "cancelled", "completed", "dispatched"])
          .gte("created_at", range.startUtc)
          .lt("created_at", range.endUtcExclusive)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      );
      const byId = new Map(extra.map((r) => [r.id, r]));
      const headers = [
        "timestamp", "staff_name", "department",
        "order_number", "sku", "quantity", "event_type",
        "station_id", "note",
      ];
      const rows = rowsToExport.map((e: ProductionEvidenceEvent) => {
        const x = byId.get(e.id);
        return [
          e.created_at,
          e.staff_id ? (staffLookup.get(e.staff_id)?.display_name ?? e.staff_id) : "",
          PRODUCTION_DEPARTMENT_LABELS[e.department as ProductionDepartment] ?? e.department ?? "",
          e.order_number ?? "",
          e.line_sku ?? "",
          e.line_quantity == null ? "" : String(e.line_quantity),
          e.event_type,
          x?.station_id ?? "",
          (x?.note ?? "").replace(/[\r\n]+/g, " "),
        ];
      });
      const csv = [headers, ...rows]
        .map((r) =>
          r
            .map((cell) => {
              const s = String(cell);
              return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            })
            .join(","),
        )
        .join("\r\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const staffSuffix = selectedStaff === ALL_STAFF
        ? "all-staff"
        : (staffLookup.get(selectedStaff)?.display_name ?? selectedStaff).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      const deptSuffix = selectedDepartment === ALL_DEPARTMENTS ? "all-depts" : selectedDepartment;
      a.download = `production-events_${staffSuffix}_${deptSuffix}_${range.firstDate}_to_${range.lastDate}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(`Export failed: ${(e as Error).message}`);
    } finally {
      setExporting(false);
    }
  }, [view, range, supabase, location, staffLookup, selectedStaff, selectedDepartment]);

  /* ------------------------------------------------------------
   * Render
   * ------------------------------------------------------------ */

  const selectedStaffName = staffId ? nameOf(staffId) : null;
  const selectedDeptLabel = selectedDepartment === ALL_DEPARTMENTS
    ? null
    : PRODUCTION_DEPARTMENT_LABELS[selectedDepartment];

  // Build a subtitle suffix shared across card headers.
  const subtitleSuffix = [
    selectedStaffName ? selectedStaffName : null,
    selectedDeptLabel ? selectedDeptLabel : null,
  ].filter(Boolean).join(" · ");

  const summary = view?.summary ?? null;
  const itemsLabel = workType ? "Items" : "Items (all work types)";
  const disclosures = [
    workType ? null : "Items with all departments selected are work processed across the selected work types: a line verified at framing and at dispatch counts at both.",
    "Orders are distinct completed orders; a person's or department's Orders overlap, so they do not add up to the total.",
    "CS/rework is counted separately. Rework scanned without a case tag cannot be told apart from normal work.",
  ].filter((x): x is string => !!x);

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Page header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <BarChart3 size={20} className="text-slate-600 dark:text-slate-400" />
          <h1 className="text-lg font-semibold tracking-tight">Production Reports</h1>
          {selectedStaffName && (
            <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-slate-900 text-white text-xs font-medium px-2 py-0.5 dark:bg-slate-100 dark:text-slate-900">
              {selectedStaffName}
            </span>
          )}
          {selectedDeptLabel && (
            <span className="inline-flex items-center gap-1 rounded-full bg-indigo-600 text-white text-xs font-medium px-2 py-0.5">
              {selectedDeptLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRefreshTick((n) => n + 1)}
            title="Refetch data"
          >
            <RefreshCw size={14} />
            Refresh
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleExport()}
            disabled={!view || view.exportEvents.length === 0 || exporting}
            title="Download raw event log as CSV"
          >
            <Download size={14} />
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
        </div>
      </div>

      {/* Order lookup — independent of date filter */}
      <OrderLookupCard
        supabase={supabase}
        location={location}
        staffLookup={staffLookup}
      />

      {/* Filter bar */}
      <Card>
        <CardBody className="flex flex-wrap items-center gap-2">
          {([
            { key: "today", label: "Today" },
            { key: "7d", label: "Last 7 days" },
            { key: "30d", label: "Last 30 days" },
            { key: "custom", label: "Custom" },
          ] as { key: PresetRange; label: string }[]).map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPreset(p.key)}
              className={cn(
                "px-3 h-8 rounded-md text-xs font-medium transition",
                preset === p.key
                  ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                  : "bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-slate-800",
              )}
            >
              {p.label}
            </button>
          ))}
          {preset === "custom" && (
            <div className="flex items-center gap-2 ml-2">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="h-8 px-2 rounded-md border border-slate-300 bg-white text-xs dark:border-slate-700 dark:bg-slate-900"
              />
              <span className="text-xs text-slate-500">to</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="h-8 px-2 rounded-md border border-slate-300 bg-white text-xs dark:border-slate-700 dark:bg-slate-900"
              />
            </div>
          )}

          {/* Staff dropdown */}
          <div className="flex items-center gap-2 ml-2">
            <label
              htmlFor="staff-filter"
              className="text-xs text-slate-500 dark:text-slate-400"
            >
              Staff:
            </label>
            <select
              id="staff-filter"
              value={selectedStaff}
              onChange={(e) => setSelectedStaff(e.target.value)}
              className="h-8 px-2 rounded-md border border-slate-300 bg-white text-xs dark:border-slate-700 dark:bg-slate-900"
            >
              <option value={ALL_STAFF}>All staff</option>
              {staffOptions.map((s) => (
                <option key={s.user_id} value={s.user_id}>
                  {s.display_name}
                </option>
              ))}
            </select>
          </div>

          {/* Department dropdown */}
          <div className="flex items-center gap-2 ml-2">
            <label
              htmlFor="dept-filter"
              className="text-xs text-slate-500 dark:text-slate-400"
            >
              Dept:
            </label>
            <select
              id="dept-filter"
              value={selectedDepartment}
              onChange={(e) =>
                setSelectedDepartment(e.target.value as ProductionDepartment | typeof ALL_DEPARTMENTS)
              }
              className="h-8 px-2 rounded-md border border-slate-300 bg-white text-xs dark:border-slate-700 dark:bg-slate-900"
            >
              {DEPARTMENT_OPTIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>

          {(selectedStaff !== ALL_STAFF || selectedDepartment !== ALL_DEPARTMENTS) && (
            <button
              type="button"
              onClick={() => {
                setSelectedStaff(ALL_STAFF);
                setSelectedDepartment(ALL_DEPARTMENTS);
              }}
              className="text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 underline ml-1"
            >
              Clear
            </button>
          )}

          <div className="ml-auto text-xs text-slate-500 dark:text-slate-400">
            {range ? `${range.firstDate} → ${range.lastDate}` : null}
            {rangeProblem && <span className="ml-2 text-red-600">{rangeProblem}</span>}
            {staffError && <span className="ml-2 text-red-600">{staffError}</span>}
            {exportError && <span className="ml-2 text-red-600">{exportError}</span>}
          </div>
          <ProductionCountStatus
            className="basis-full"
            state={evidence}
            range={range}
            coverage={view?.coverage ?? null}
            notes={disclosures}
          />
        </CardBody>
      </Card>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <KpiTile
          label={itemsLabel}
          value={summary ? fmtItems(summary.normal.items) : "--"}
          sub={workType ? undefined : "work processed"}
        />
        <KpiTile
          label="Orders completed"
          value={summary ? summary.normal.orders.toLocaleString() : "--"}
          sub={
            view && view.dispatchedOrders > 0
              ? `${view.dispatchedOrders.toLocaleString()} dispatched`
              : undefined
          }
        />
        <KpiTile
          label="CS / rework"
          value={summary ? `${fmtItems(summary.rework.items)} items` : "--"}
          sub={summary ? `${summary.rework.orders.toLocaleString()} case order${summary.rework.orders === 1 ? "" : "s"}` : undefined}
        />
        <KpiTile
          label="Avg min / unit"
          value={view ? formatMinutes(view.timing.avgMinPerUnit) : "--"}
          sub="framed units only"
        />
        <KpiTile
          label={selectedStaff === ALL_STAFF ? "Active staff" : "Hours worked"}
          value={
            !view
              ? "--"
              : selectedStaff === ALL_STAFF
                ? view.activeStaff.toLocaleString()
                : formatHours(view.timing.durationMin)
          }
        />
        <KpiTile
          label="Avg orders / staff-day"
          value={view && view.avgOrdersPerStaffDay > 0 ? view.avgOrdersPerStaffDay.toFixed(1) : "--"}
          sub={view && view.staffDays > 0 ? `${view.staffDays} staff-day${view.staffDays === 1 ? "" : "s"}` : undefined}
        />
      </div>

      {/* === per-staff grouped bars === */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between w-full gap-3">
            <CardTitle>Output by staff</CardTitle>
            <div className="flex gap-0.5 rounded-md ring-1 ring-slate-200 dark:ring-slate-800 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setChartMode("totals")}
                className={cn(
                  "px-2 h-6 rounded transition",
                  chartMode === "totals"
                    ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-300",
                )}
              >
                Totals
              </button>
              <button
                type="button"
                onClick={() => setChartMode("perDay")}
                className={cn(
                  "px-2 h-6 rounded transition",
                  chartMode === "perDay"
                    ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-300",
                )}
              >
                Per day worked
              </button>
            </div>
          </div>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Items vs Orders per person (normal work; all visible staff)
            {selectedDeptLabel ? ` -- ${selectedDeptLabel}` : ""}
          </span>
        </CardHeader>
        <CardBody>
          {staffBoard.length === 0 ? (
            <Empty label={evidence.status === "loading" ? "Loading…" : "No credited items or orders in this range."} />
          ) : (
            <div style={{ width: "100%", height: 260 }}>
              <ResponsiveContainer>
                <BarChart
                  data={staffBoard.map((s) => ({
                    staff_id: s.staffId,
                    name: s.display_name,
                    Items: chartMode === "perDay"
                      ? Number(s.itemsPerDay.toFixed(1))
                      : (s.normal.items ?? 0),
                    Orders: chartMode === "perDay"
                      ? Number(s.ordersPerDay.toFixed(1))
                      : s.normal.orders,
                  }))}
                  margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
                  onClick={(state: any) => {
                    const pl = state?.activePayload?.[0]?.payload;
                    if (pl?.staff_id) {
                      setSelectedStaff((cur) => cur === pl.staff_id ? ALL_STAFF : pl.staff_id);
                    }
                  }}
                >
                  <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-15} textAnchor="end" height={50} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip
                    cursor={{ fill: "rgba(148,163,184,0.15)" }}
                    contentStyle={{ fontSize: 12, borderRadius: 6 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Items"  fill="#0f172a" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Orders" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Staff leaderboard */}
      <CollapsibleSection storageKey="staff-leaderboard" title="Staff leaderboard">
      <Card>
        <CardHeader>
          <CardTitle>Staff leaderboard</CardTitle>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {selectedDeptLabel ? `${selectedDeptLabel} only` : "All departments"} — all visible staff
            {selectedStaffName ? ` (the tiles above show ${selectedStaffName} only)` : ""} — click row to filter
          </span>
        </CardHeader>
        <CardBody className="p-0">
          {staffBoard.length === 0 ? (
            <Empty label="No credited production from staff in this range." />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="text-left px-4 py-2 font-semibold">Staff</th>
                    <th className="text-right px-3 py-2 font-semibold">Orders</th>
                    <th className="text-right px-3 py-2 font-semibold">Items</th>
                    <th className="text-right px-3 py-2 font-semibold">Rework</th>
                    <th className="text-right px-3 py-2 font-semibold">Days</th>
                    <th className="text-right px-3 py-2 font-semibold">O/day</th>
                    <th className="text-right px-3 py-2 font-semibold">I/day</th>
                    <th className="text-right px-3 py-2 font-semibold">Hours</th>
                    <th className="text-right px-3 py-2 font-semibold">Avg min/unit</th>
                    <th className="text-right px-4 py-2 font-semibold">Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {staffBoard.map((r) => {
                    const isSelected = selectedStaff === r.staffId;
                    return (
                      <tr
                        key={r.staffId}
                        onClick={() =>
                          setSelectedStaff(isSelected ? ALL_STAFF : r.staffId)
                        }
                        className={cn(
                          "border-t border-slate-100 dark:border-slate-800 cursor-pointer transition",
                          isSelected
                            ? "bg-slate-100 dark:bg-slate-800"
                            : "hover:bg-slate-50 dark:hover:bg-slate-800/50",
                        )}
                        title={isSelected ? "Click to clear filter" : `Click to filter to ${r.display_name}`}
                      >
                        <td className="px-4 py-2 font-medium">
                          {r.display_name}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.normal.orders.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtItems(r.normal.items)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                          {(r.rework.items ?? 0) > 0 || r.rework.orders > 0 ? `${fmtItems(r.rework.items)} / ${r.rework.orders}` : "--"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.daysWorked.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.ordersPerDay > 0 ? r.ordersPerDay.toFixed(1) : "--"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.itemsPerDay > 0 ? r.itemsPerDay.toFixed(1) : "--"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatHours(r.timing.durationMin)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatMinutes(r.timing.avgMinPerUnit)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {r.cost == null
                            ? <span className="text-slate-400 italic">no rate</span>
                            : `$${r.cost.toFixed(2)}`}
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
      </CollapsibleSection>

      {/* SKU bottleneck */}
      <CollapsibleSection storageKey="slowest-variants" title="Slowest variants">
      <Card>
        <CardHeader>
          <CardTitle>Slowest variants</CardTitle>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Grouped by size and variant. Top 20 by avg minutes per framed unit
            {subtitleSuffix ? ` — ${subtitleSuffix}` : ""}
          </span>
        </CardHeader>
        <CardBody className="p-0">
          {!view || view.skuBoard.length === 0 ? (
            <Empty label="No SKU-level events in this range." />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="text-left px-4 py-2 font-semibold">Size / Variant</th>
                    <th className="text-right px-3 py-2 font-semibold">Timed units</th>
                    <th className="text-right px-3 py-2 font-semibold">Total time</th>
                    <th className="text-right px-4 py-2 font-semibold">Avg min/unit</th>
                  </tr>
                </thead>
                <tbody>
                  {view.skuBoard.map((r) => (
                    <tr
                      key={r.sku}
                      className="border-t border-slate-100 dark:border-slate-800"
                    >
                      <td className="px-4 py-2 font-mono text-xs">{r.sku}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.weight.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatHours(r.durationMin)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{formatMinutes(r.avgMin)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
      </CollapsibleSection>

      {/* Per-staff order drill-down - only when a single staff is selected */}
      {staffId && view && view.staffOrders.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Orders handled by {selectedStaffName}</CardTitle>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {view.staffOrders.length.toLocaleString()} distinct order{view.staffOrders.length === 1 ? "" : "s"} touched in this range;{" "}
              {view.summary.normal.orders.toLocaleString()} completed by {selectedStaffName}. Click an order # to look it up.
            </span>
          </CardHeader>
          <CardBody className="p-0">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="text-left px-4 py-2 font-semibold">Order #</th>
                    <th className="text-left px-3 py-2 font-semibold">First touched</th>
                    <th className="text-left px-3 py-2 font-semibold">Last touched</th>
                    <th className="text-left px-3 py-2 font-semibold">Departments</th>
                    <th className="text-right px-3 py-2 font-semibold">Lines verified</th>
                    <th className="text-right px-3 py-2 font-semibold">Items</th>
                    <th className="text-left px-4 py-2 font-semibold">Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {view.staffOrders.map((r) => {
                    const fmt = (ms: number) => new Date(ms).toLocaleString(undefined, {
                      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                      ...(range ? { timeZone: range.timeZone } : {}),
                    });
                    return (
                      <tr key={r.key} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="px-4 py-2 font-mono text-xs">
                          <button
                            type="button"
                            className="text-indigo-600 dark:text-indigo-400 hover:underline"
                            onClick={() => {
                              // Scroll to Order lookup and trigger search.
                              const evt = new CustomEvent("inka:lookup-order", { detail: r.orderNumber });
                              window.dispatchEvent(evt);
                              window.scrollTo({ top: 0, behavior: "smooth" });
                            }}
                            title="Look up this order"
                          >
                            #{r.orderNumber}
                          </button>
                          {r.caseId ? <span className="ml-1 text-[10px] text-amber-700">CS {r.caseId}</span> : null}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400 whitespace-nowrap">{fmt(r.firstMs)}</td>
                        <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400 whitespace-nowrap">{fmt(r.lastMs)}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {r.workTypes.map((d) => (
                              <span key={d} className="inline-flex items-center rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-[11px] px-2 py-0.5 ring-1 ring-slate-200 dark:ring-slate-700">
                                {PRODUCTION_DEPARTMENT_LABELS[d]}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.verifiedLines.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtItems(r.items)}</td>
                        <td className="px-4 py-2 text-xs">{r.completed ? "yes" : "--"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* Per-staff daily productivity chart */}
      {staffId && view?.personDaily && view.personTotals && view.staffOrders.length > 0 ? (
        <StaffProductivityChart
          staffName={selectedStaffName ?? "Staff"}
          daily={view.personDaily}
          totals={view.personTotals.normal}
        />
      ) : null}

      <CollapsibleSection storageKey="live-completions" title="Live order completions">
        <LiveOrderCompletionsCard />
      </CollapsibleSection>

      <PackageUsageCard
        fromIso={pkgWindow.from.toISOString()}
        toIso={pkgWindow.to.toISOString()}
        rangeLabel={subtitleSuffix || "current range"}
      />

      <PackageHistoryCard />

      <DailyTimesheetCard />
    </div>
  );
}

/* ============================================================
 * Small subcomponents
 * ============================================================ */

function KpiTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card>
      <CardBody>
        <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-semibold">
          {label}
        </div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        {sub && <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{sub}</div>}
      </CardBody>
    </Card>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="px-4 py-6 text-sm text-slate-500 dark:text-slate-400 italic">
      {label}
    </div>
  );
}

/* ============================================================
 * OrderLookupCard â€” search any order across all time
 * ============================================================
 *
 * Standalone widget at the top of the Reports page. Lets owners /
 * managers paste an order number (either the 6-digit scanner code
 * "190203" or the full "10190203" Shopify number) and see every
 * production_event ever logged against that order at the current
 * location. Useful for:
 *
 *   - "Did framing already touch this order?" â€” checks department chips
 *   - "Who dispatched it?" â€” first row in the timeline
 *   - "When did it move?" â€” chronological event log
 *
 * Future: per-order notes (e.g. "framer flagged: customer changed mind,
 * cancel") will live alongside the event timeline. The placeholder
 * "Add note" button is wired but the order_notes table doesn't exist
 * yet â€” adding a note shows a "coming soon" toast.
 */

interface OrderEvent {
  id: string;
  staff_id: string;
  department: ProductionDepartment;
  order_number: string;
  line_sku: string | null;
  line_quantity: number | null;
  event_type: "started" | "completed" | "cancelled" | "dispatched" | "line_verified" | "clock_in" | "clock_out";
  parent_event_id?: string | null;
  cs_case_id?: string | null;
  station_id: string | null;
  note: string;
  created_at: string;
}

function normalizeOrderNumber(raw: string): string {
  // Strip the leading '#' if present, then any whitespace.
  let s = raw.trim().replace(/^#/, "").trim();
  // If the user scanned the short 6-digit code (no "10" prefix), add it.
  // Shopify orders at Inka Arthouse all follow "10XXXXXX".
  if (/^\d{6}$/.test(s)) s = "10" + s;
  return s;
}

function OrderLookupCard({
  supabase,
  location,
  staffLookup,
}: {
  supabase: ReturnType<typeof getSupabase>;
  location: string;
  staffLookup: Map<string, StaffLookup>;
}) {
  const [input, setInput] = useState("");
  const auth = useAuth();

  // A result belongs to the user, site and order it was read for, under one
  // cutoff. Changing user or site clears it, and a late response for an
  // older search is discarded, so a count never appears under another site.
  // The lifecycle lives in createOrderLookupSession (tested with deferred responses).
  const scopeKey = `${auth.user?.id ?? "anon"}|${location}`;
  const supabaseRef = useRef(supabase);
  supabaseRef.current = supabase;
  const [view, setView] = useState<OrderLookupView<OrderEvent> | null>(null);
  const session = useMemo(
    () =>
      createOrderLookupSession<OrderEvent>({
        load: (req) => loadOrderLookup<OrderEvent>(supabaseRef.current, req),
        normalize: normalizeOrderNumber,
        now: () => new Date().toISOString(),
        onChange: setView,
        scopeKey,
        location,
      }),
    // Created once; scope changes go through setScope below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => session.setScope(scopeKey, location), [session, scopeKey, location]);
  const current = view ?? session.view();
  const { searched, loading, error, lookup, events } = current;
  const setError = useCallback((message: string | null) => session.setError(message), [session]);
  const runSearch = useCallback(() => session.search(input), [session, input]);

  // Per-event Remove action. Owner-only. Deletes the production_events
  // row + any matching ledger rows (parent_event_id) so the audit
  // trail stays consistent. Stock numbers themselves are NOT reversed
  // here - operator can adjust on /skus if needed (the confirm dialog
  // says so).
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const deleteEvent = useCallback(async (eventId: string) => {
    const ok = window.confirm(
      "Remove this event from the order history?" + "\n\n" +
      "This deletes the production_events row and any matching ledger" + "\n" +
      "rows (audit cleanup). It does NOT reverse stock deductions -" + "\n" +
      "adjust on /skus if needed.",
    );
    if (!ok) return;
    setDeletingId(eventId);
    setError(null);
    try {
      // Ledger first (FK convention).
      const ledRes = await supabase
        .from("ledger")
        .delete()
        .eq("parent_event_id", eventId);
      if (ledRes.error) throw ledRes.error;
      const evRes = await supabase
        .from("production_events")
        .delete()
        .eq("id", eventId);
      if (evRes.error) throw evRes.error;
      await runSearch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeletingId(null);
    }
  }, [supabase, runSearch]);

  const reset = () => {
    setInput("");
    session.reset();
  };

  // Departments that touched this order (set of unique department values from
  // the events). Used for the chip row.
  const touchedDepartments = useMemo(() => {
    if (!events) return new Set<ProductionDepartment>();
    const s = new Set<ProductionDepartment>();
    for (const ev of events) s.add(ev.department);
    return s;
  }, [events]);

  const author = (auth.user && auth.profile)
    ? { user_id: auth.user.id, display_name: auth.profile.display_name }
    : null;

  // Items on this order, counted by the shared F1 rules over its whole saved
  // history (cancellations resolved, sets expanded, excluded lines ignored).
  // This is work processed across work types, not a count of physical goods.
  // Only a read confirmed complete, for the site it was read from, is counted.
  const role = auth.profile?.role ?? null;
  const memberOfLookupSite = lookup ? auth.locations.includes(lookup.location) : false;
  const orderCounts = useMemo(() => {
    if (!lookup || !events || events.length === 0) return null;
    const counts = orderLookupCounts(
      events.map((e) => ({
        id: e.id,
        staff_id: e.staff_id,
        department: e.department,
        order_number: e.order_number,
        line_sku: e.line_sku,
        line_quantity: e.line_quantity,
        event_type: e.event_type,
        created_at: e.created_at,
        parent_event_id: e.parent_event_id ?? null,
        cs_case_id: e.cs_case_id ?? null,
      })),
      { location: lookup.location, asOfUtc: lookup.asOfUtc, complete: lookup.complete, visibility: productionVisibilityFor(role, memberOfLookupSite) },
    );
    return counts ?? { unavailable: true as const };
  }, [lookup, events, role, memberOfLookupSite]);
// High-level status: dispatched > completed > started > cancelled-only > none
  const orderStatus = useMemo(() => {
    if (!events || events.length === 0) return null;
    if (events.some((e) => e.event_type === "dispatched")) return "Dispatched";
    if (events.some((e) => e.event_type === "completed")) return "Completed (not yet dispatched)";
    if (events.some((e) => e.event_type === "started")) return "In progress";
    if (events.every((e) => e.event_type === "cancelled")) return "Scrapped";
    return null;
  }, [events]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ClipboardList size={16} className="text-slate-600 dark:text-slate-400" />
          <CardTitle>Order lookup</CardTitle>
        </div>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          Search any order to see which departments interacted with it. Accepts the 6-digit scanner code or the full 10XXXXXX Shopify number.
        </span>
      </CardHeader>
      <CardBody className="space-y-3">
        <form
          data-lookup-form="1"
          onSubmit={(e) => {
            e.preventDefault();
            runSearch();
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
            />
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g. 10190203 or 190203"
              className="h-9 w-full rounded-md border border-slate-300 bg-white pl-8 pr-3 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 font-mono"
              autoComplete="off"
            />
          </div>
          <Button type="submit" variant="primary" size="sm" disabled={loading}>
            {loading ? "Searching..." : "Search"}
          </Button>
          {(searched || input) && (
            <button
              type="button"
              onClick={reset}
              className="text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 underline"
            >
              Clear
            </button>
          )}
        </form>

        {error ? (
          <div className="text-xs text-rose-700 bg-rose-50 ring-1 ring-rose-200 rounded px-2 py-1.5 dark:bg-rose-900/20 dark:text-rose-300 dark:ring-rose-800">
            {error}
          </div>
        ) : null}

{searched && events !== null && !loading ? (
          events.length === 0 ? (
            <div className="space-y-3">
              {/* Header row: order # + Not started status */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-semibold">
                  #{searched}
                </span>
                <span className="inline-flex items-center rounded-full bg-amber-500 text-white text-[11px] font-medium px-2 py-0.5">
                  Not started
                </span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  Departments:
                </span>
                <span className="text-[11px] italic text-slate-400">none</span>
              </div>

              {/* Notes panel - works without any production_events */}
              <OrderNotesPanel
                supabase={supabase}
                location={location}
                orderNumber={searched}
                author={author}
                variant="compact"
              />

              <div className="text-xs text-slate-500 dark:text-slate-400 italic">
                No production events yet at this location. Add a note above to
                flag this order for whoever picks it up next.
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Header row: order # + status + dept chips */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-semibold">
                  #{searched}
                </span>
                {orderCounts && "unavailable" in orderCounts ? (
                  <span
                    className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 rounded-full px-2 py-0.5"
                    title="The order's history could not be confirmed complete, so no item count is shown."
                  >
                    item count unavailable (incomplete read)
                  </span>
                ) : orderCounts ? (
                  <span
                    className="text-xs text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 rounded-full px-2 py-0.5"
                    title="Verified pieces across all work types: a piece verified at two stations counts at both."
                  >
                    {fmtItems(orderCounts.normal)} item{orderCounts.normal === 1 ? "" : "s"} processed
                    {(orderCounts.rework ?? 0) > 0 ? ` · ${fmtItems(orderCounts.rework)} rework` : ""}
                    {orderCounts.incomplete ? " · incomplete detail" : ""}
                  </span>
                ) : null}
                {orderStatus ? (
                  <span
                    className={
                      orderStatus.startsWith("Dispatched")
                        ? "inline-flex items-center rounded-full bg-emerald-600 text-white text-[11px] font-medium px-2 py-0.5"
                        : orderStatus.startsWith("Scrapped")
                        ? "inline-flex items-center rounded-full bg-rose-600 text-white text-[11px] font-medium px-2 py-0.5"
                        : orderStatus.startsWith("Completed")
                        ? "inline-flex items-center rounded-full bg-indigo-600 text-white text-[11px] font-medium px-2 py-0.5"
                        : "inline-flex items-center rounded-full bg-amber-500 text-white text-[11px] font-medium px-2 py-0.5"
                    }
                  >
                    {orderStatus}
                  </span>
                ) : null}
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  Departments:
                </span>
                {touchedDepartments.size === 0 ? (
                  <span className="text-[11px] italic text-slate-400">none</span>
                ) : (
                  Array.from(touchedDepartments).map((d) => (
                    <span
                      key={d}
                      className="inline-flex items-center rounded-full bg-slate-100 text-slate-800 text-[11px] font-medium px-2 py-0.5 dark:bg-slate-800 dark:text-slate-200 ring-1 ring-slate-200 dark:ring-slate-700"
                    >
                      {PRODUCTION_DEPARTMENT_LABELS[d]}
                    </span>
                  ))
                )}
                </div>

              {/* Order notes */}
              <OrderNotesPanel
                supabase={supabase}
                location={location}
                orderNumber={searched}
                author={author}
                variant="compact"
              />

              {/* Timeline */}
              <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs uppercase tracking-wide text-slate-600 dark:text-slate-400">
                    <tr>
                      <th className="text-left px-3 py-1.5 font-medium">When</th>
                      <th className="text-left px-3 py-1.5 font-medium">Who</th>
                      <th className="text-left px-3 py-1.5 font-medium">Department</th>
                      <th className="text-left px-3 py-1.5 font-medium">Event</th>
                      <th className="text-left px-3 py-1.5 font-medium">Note</th>
                      {author && auth.profile?.role === "owner" ? (
                        <th className="text-right px-3 py-1.5 font-medium w-px">Remove</th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {events.map((ev) => {
                      const who =
                        staffLookup.get(ev.staff_id)?.display_name ??
                        `User ${ev.staff_id.slice(0, 8)}`;
                      const when = new Date(ev.created_at).toLocaleString(
                        undefined,
                        {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        },
                      );
                      const eventPill =
                        ev.event_type === "dispatched"
                          ? "bg-emerald-100 text-emerald-800 ring-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-200 dark:ring-emerald-800"
                          : ev.event_type === "completed"
                          ? "bg-indigo-100 text-indigo-800 ring-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-200 dark:ring-indigo-800"
                          : ev.event_type === "started"
                          ? "bg-amber-100 text-amber-800 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-200 dark:ring-amber-800"
                          : "bg-rose-100 text-rose-800 ring-rose-200 dark:bg-rose-900/30 dark:text-rose-200 dark:ring-rose-800";
                      return (
                        <tr key={ev.id}>
                          <td className="px-3 py-1.5 text-xs text-slate-700 dark:text-slate-300 whitespace-nowrap">
                            {when}
                          </td>
                          <td className="px-3 py-1.5 text-xs text-slate-700 dark:text-slate-300 whitespace-nowrap">
                            {who}
                          </td>
                          <td className="px-3 py-1.5 text-xs text-slate-700 dark:text-slate-300 whitespace-nowrap">
                            {PRODUCTION_DEPARTMENT_LABELS[ev.department] ?? ev.department}
                          </td>
                          <td className="px-3 py-1.5">
                            <span
                              className={
                                "inline-flex items-center rounded-full text-[11px] font-medium px-2 py-0.5 ring-1 " +
                                eventPill
                              }
                            >
                              {ev.event_type}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-xs text-slate-600 dark:text-slate-400 max-w-[260px] truncate" title={ev.note ?? ""}>
                            {ev.note?.trim() ? ev.note : <span className="italic text-slate-400">--</span>}
                          </td>
                          {author && auth.profile?.role === "owner" ? (
                            <td className="px-3 py-1.5 text-right whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() => void deleteEvent(ev.id)}
                                disabled={deletingId === ev.id}
                                title="Remove this event from the order history"
                                className="inline-flex items-center justify-center h-7 w-7 rounded-md text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/30 disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                <Trash2 size={14} />
                              </button>
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )
        ) : null}
      </CardBody>
    </Card>
  );
}

/* ============================================================
 * Per-staff daily productivity chart
 * ============================================================ */

interface StaffProductivityProps {
  staffName: string;
  /** One entry per production date (shared projection; no re-counting here). */
  daily: ReportDay[];
  /** Range totals: distinct Orders over the whole range, not a sum of days. */
  totals: ItemsOrders;
}

/** Calendar label for a YYYY-MM-DD production date, independent of the browser's timezone. */
function dateParts(date: string): { label: string; dayOfWeek: number } {
  const [y, m, d] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  return {
    label: utc.toLocaleDateString(undefined, { day: "2-digit", month: "short", timeZone: "UTC" }),
    dayOfWeek: utc.getUTCDay(),
  };
}

function StaffProductivityChart({ staffName, daily, totals }: StaffProductivityProps) {
  const rows = useMemo(
    () =>
      daily.map((r) => {
        const p = dateParts(r.date);
        return { day: r.date, dayLabel: p.label, dayOfWeek: p.dayOfWeek, orders: r.normal.orders, items: r.normal.items ?? 0 };
      }),
    [daily],
  );

  const summary = useMemo(() => {
    const totalOrders = totals.orders;
    const totalItems = totals.items;
    const worked = rows.filter((r) => r.orders > 0 || r.items > 0);
    const dayOrderSum = worked.reduce((s, r) => s + r.orders, 0);
    const avgOrders = worked.length > 0 ? dayOrderSum / worked.length : 0;
    const bestDay = rows.reduce((best, r) => (r.orders > best.orders ? r : best), { orders: 0, items: 0, dayLabel: "-" } as { orders: number; items: number; dayLabel: string });
    const highestItemsDay = rows.reduce((best, r) => (r.items > best.items ? r : best), { orders: 0, items: 0, dayLabel: "-" } as { orders: number; items: number; dayLabel: string });
    // 7-day rolling stdev of orders (last 7 days worked)
    const workedOrders = worked.slice(-7).map((r) => r.orders);
    let stdev = 0;
    if (workedOrders.length >= 2) {
      const mean = workedOrders.reduce((s, n) => s + n, 0) / workedOrders.length;
      const variance = workedOrders.reduce((s, n) => s + (n - mean) ** 2, 0) / workedOrders.length;
      stdev = Math.sqrt(variance);
    }
    const dayItemSum = rows.reduce((s, r) => s + r.items, 0);
    const weekendItems = rows.reduce((s, r) => s + ((r.dayOfWeek === 0 || r.dayOfWeek === 6) ? r.items : 0), 0);
    const weekendPct = dayItemSum > 0 ? (weekendItems / dayItemSum) * 100 : 0;
    return { totalOrders, totalItems, avgOrders, bestDay, highestItemsDay, stdev, weekendPct };
  }, [rows, totals]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{staffName} - daily productivity</CardTitle>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          Orders + items per production day (04:00 to 04:00 site time). Range totals count each order once.
        </span>
      </CardHeader>
      <CardBody className="space-y-3">
        {/* KPI tiles */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Total orders</div>
            <div className="text-xl font-bold tabular-nums">{summary.totalOrders.toLocaleString()}</div>
          </div>
          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Total items</div>
            <div className="text-xl font-bold tabular-nums">{fmtItems(summary.totalItems)}</div>
          </div>
          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Avg / day worked</div>
            <div className="text-xl font-bold tabular-nums">{summary.avgOrders.toFixed(1)}</div>
            <div className="text-[10px] text-slate-500">orders</div>
          </div>
          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Best day</div>
            <div className="text-xl font-bold tabular-nums">{summary.bestDay.orders}</div>
            <div className="text-[10px] text-slate-500">orders {summary.bestDay.dayLabel !== "-" ? "· " + summary.bestDay.dayLabel : ""}</div>
          </div>
        </div>

        {/* Chart */}
        <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 p-3">
          <div className="flex items-center gap-3 text-[11px] text-slate-500 mb-2">
            <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full bg-slate-900 dark:bg-slate-100" />Orders</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full bg-slate-400" />Items</span>
          </div>
          <div style={{ width: "100%", height: 260 }}>
            <ResponsiveContainer>
              <LineChart data={rows} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="dayLabel" tick={{ fontSize: 10, fill: "#64748b" }} axisLine={{ stroke: "#e2e8f0" }} tickLine={false} />
                <YAxis yAxisId="orders" orientation="left" tick={{ fontSize: 10, fill: "#64748b" }} axisLine={{ stroke: "#e2e8f0" }} tickLine={false} width={30} />
                <YAxis yAxisId="items" orientation="right" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={{ stroke: "#e2e8f0" }} tickLine={false} width={30} />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid #e2e8f0" }}
                  labelStyle={{ fontWeight: 600 }}
                />
                <Line yAxisId="orders" type="monotone" dataKey="orders" stroke="#0f172a" strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 4 }} name="Orders" isAnimationActive={false} />
                <Line yAxisId="items" type="monotone" dataKey="items" stroke="#94a3b8" strokeWidth={2} strokeDasharray="4 3" dot={{ r: 2 }} activeDot={{ r: 4 }} name="Items" isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Breakdown cells */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px]">
          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2 bg-slate-50/50 dark:bg-slate-900/40">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Highest items in a day</div>
            <div className="text-sm font-semibold mt-0.5">
              {summary.highestItemsDay.items} items
              {summary.highestItemsDay.dayLabel !== "-" ? <span className="font-normal text-slate-500"> on {summary.highestItemsDay.dayLabel}</span> : null}
            </div>
          </div>
          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2 bg-slate-50/50 dark:bg-slate-900/40">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Consistency (7d stdev)</div>
            <div className="text-sm font-semibold mt-0.5">
              &plusmn;{summary.stdev.toFixed(1)} orders/day
            </div>
          </div>
          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2 bg-slate-50/50 dark:bg-slate-900/40">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Weekend contribution</div>
            <div className="text-sm font-semibold mt-0.5">
              {summary.weekendPct.toFixed(0)}% of items
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

/* ============================================================
 * Collapsible section wrapper for Reports subsections
 * ============================================================ */

function CollapsibleSection({
  storageKey, title, defaultOpen = true, children,
}: {
  storageKey: string;
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const raw = window.localStorage.getItem(`inka-reports-collapse:${storageKey}`);
      if (raw === "0") return false;
      if (raw === "1") return true;
    } catch {}
    return defaultOpen;
  });
  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      try { window.localStorage.setItem(`inka-reports-collapse:${storageKey}`, next ? "1" : "0"); } catch {}
      return next;
    });
  };
  return (
    <div className="rounded-xl ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-900/40 overflow-hidden">
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition text-left"
        aria-expanded={open}
      >
        <span className="text-sm font-semibold">{title}</span>
        {open ? <ChevronDown size={16} className="text-slate-500" /> : <ChevronRight size={16} className="text-slate-500" />}
      </button>
      {open ? (
        <div className="border-t border-slate-200 dark:border-slate-800">
          {children}
        </div>
      ) : null}
    </div>
  );
}
