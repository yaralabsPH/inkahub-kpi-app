import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, ChevronDown, ChevronRight, ClipboardList, Download, RefreshCw, Search, Trash2 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { getSupabase, getBackendMode } from "@/lib/repository/supabase/client";
import { fetchAllRows } from "@/lib/repository/supabase/pageThrough";
import { useAppStore } from "@/lib/state/appStore";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import {
  PRODUCTION_DEPARTMENT_LABELS,
  type ProductionDepartment,
} from "@/lib/domain";
import { isKpiEligibleSku, isKpiOrderSku, kpiUnitMultiplier, parseSku } from "@/lib/domain/skuRouting";
import { cn } from "@/lib/utils/cn";
import { useAuth } from "@/lib/auth/AuthProvider";
import { OrderNotesPanel } from "@/components/OrderNotesPanel";
import { DailyTimesheetCard } from "@/components/DailyTimesheetCard";
import { PackageUsageCard } from "@/components/PackageUsageCard";
import { PackageHistoryCard } from "@/components/PackageHistoryCard";
import { LiveOrderCompletionsCard } from "@/components/LiveOrderCompletionsCard";

/**
 * Reports tab — production analytics for owners + managers.
 *
 * Reads from production_events (append-only log) and joins:
 *   - staff_barcodes  → display_name
 *   - staff_rates     → hourly_rate for cost-per-frame
 *
 * Filters:
 *   - Date range (Today / 7d / 30d / Custom)
 *   - Staff member (All staff / individual selection)
 *   - Department  (All / A0 Framed / Framed / Unframed / Dispatch)
 *
 * Sections:
 *   1. Filter bar  — date preset chips + custom range + staff + department
 *   2. KPI tiles
 *   3. Output chart— units completed per day
 *   4. Staff board — all staff in range (click a row to filter)
 *   5. SKU board   — slowest SKUs (avg min/unit), reveals bottlenecks
 *   6. CSV export  — raw event log for the active filters
 *
 * NavGate already restricts the route to users with `reports` in allowed_nav,
 * which (per role defaults) means owner + manager only.
 */

type PresetRange = "today" | "7d" | "30d" | "custom";

interface DateRange {
  from: Date;
  to: Date;
  preset: PresetRange;
}

interface RawEvent {
  id: string;
  staff_id: string;
  department: ProductionDepartment;
  order_number: string;
  line_sku: string | null;
  line_quantity: number | null;
  event_type: "started" | "completed" | "cancelled" | "dispatched" | "line_verified" | "clock_in" | "clock_out";
  parent_event_id?: string | null;
  station_id: string | null;
  note: string;
  created_at: string;
}

interface StaffLookup {
  user_id: string;
  display_name: string;
  hourly_rate: number | null;
}

interface CompletedLine {
  staff_id: string;
  department: ProductionDepartment;
  order_number: string;
  line_sku: string | null;
  line_quantity: number;
  started_at: number; // ms
  completed_at: number; // ms
  duration_min: number;
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

function computeRange(preset: PresetRange, customFrom?: Date, customTo?: Date): DateRange {
  const now = new Date();
  if (preset === "today") {
    return { from: startOfDay(now), to: endOfDay(now), preset };
  }
  if (preset === "7d") {
    const from = startOfDay(now);
    from.setDate(from.getDate() - 6); // include today
    return { from, to: endOfDay(now), preset };
  }
  if (preset === "30d") {
    const from = startOfDay(now);
    from.setDate(from.getDate() - 29);
    return { from, to: endOfDay(now), preset };
  }
  // custom
  return {
    from: customFrom ? startOfDay(customFrom) : startOfDay(now),
    to: customTo ? endOfDay(customTo) : endOfDay(now),
    preset: "custom",
  };
}

function isoLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayKey(ms: number): string {
  return isoLocalDate(new Date(ms));
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

/* ============================================================
 * Event → completed-lines reducer
 * ============================================================ */
function deriveCompletedLines(events: RawEvent[]): {
  completedLines: CompletedLine[];
  unitsCompleted: number;
  ordersCompleted: Set<string>;
} {
  // items-vs-orders split: UN counts for orders, not items.
  //   isKpiOrderSku   - broad: includes UN. Bumps ordersCompleted.
  //   isKpiEligibleSku - narrow: items only (excludes UN). Bumps units
  //                     + duration aggregations.
  // UN events still get pushed to completedLines (so unframed dept
  // shows order counts on the staff board) but with line_quantity=0
  // and duration_min=0 so they do not pollute items/avg-min stats.
  // Iterates line_verified events for per-SKU granularity (not order-
  // level completed/dispatched events). Cancelled verifies are
  // dropped via the parent_event_id chain.
  const sorted = [...events].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );

  const GAP_CAP_MIN = 30;

  const cancelledIds = new Set<string>();
  for (const ev of sorted) {
    if (ev.event_type === "cancelled" && ev.parent_event_id) {
      cancelledIds.add(ev.parent_event_id);
    }
  }

  const prevVerifyByWorker = new Map<string, RawEvent>();
  const completedLines: CompletedLine[] = [];
  const ordersCompleted = new Set<string>();
  let unitsCompleted = 0;

  for (const ev of sorted) {
    if (ev.event_type !== "line_verified") continue;
    if (cancelledIds.has(ev.id)) continue;
    if (!isKpiOrderSku(ev.line_sku)) continue;

    const isItem = isKpiEligibleSku(ev.line_sku);
    const rawQty = ev.line_quantity ?? 1;
    const itemUnits = isItem ? rawQty * kpiUnitMultiplier(ev.line_sku) : 0;

    unitsCompleted += itemUnits;
    ordersCompleted.add(ev.order_number);

    const prev = prevVerifyByWorker.get(ev.staff_id);
    const completedMs = Date.parse(ev.created_at);
    const prevMs = prev ? Date.parse(prev.created_at) : completedMs;
    const rawGapMin = (completedMs - prevMs) / 60_000;
    // Duration only contributes when this event is an item (frame).
    const validForAvg = !!prev && rawGapMin > 0 && rawGapMin <= GAP_CAP_MIN && isItem;
    const duration_min = validForAvg ? rawGapMin : 0;

    completedLines.push({
      staff_id: ev.staff_id,
      department: ev.department,
      order_number: ev.order_number,
      line_sku: ev.line_sku,
      line_quantity: itemUnits,
      started_at: prevMs,
      completed_at: completedMs,
      duration_min,
    });

    prevVerifyByWorker.set(ev.staff_id, ev);
  }

      return { completedLines, unitsCompleted, ordersCompleted };
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
  const supabase = getSupabase();
  const location = useAppStore((s) => s.location);
  const isSupabase = getBackendMode() === "supabase";

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

  const range = useMemo<DateRange>(() => {
    const cf = customFrom ? new Date(customFrom) : undefined;
    const ct = customTo ? new Date(customTo) : undefined;
    return computeRange(preset, cf, ct);
  }, [preset, customFrom, customTo]);

  const [events, setEvents] = useState<RawEvent[]>([]);
  const [staffLookup, setStaffLookup] = useState<Map<string, StaffLookup>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // -------- fetch --------
  useEffect(() => {
    if (!isSupabase) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const fromIso = range.from.toISOString();
        const toIso = range.to.toISOString();
        // Paginated production_events fetch - bypasses PostgRESTs 1000-row
        // cap so the KPI tiles + staff board scale past ~2 days of busy
        // production. fetchAllRows pages through with .range() until it
        // hits a short page.
        const [evRows, staffRes, rateRes] = await Promise.all([
          fetchAllRows<RawEvent>((from, to) =>
            supabase
              .from("production_events")
              .select("*")
              .eq("location", location)
              .in("event_type", ["line_verified", "cancelled", "completed", "dispatched"])
              .gte("created_at", fromIso)
              .lte("created_at", toIso)
              .order("created_at", { ascending: true })
              .range(from, to),
          ),
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
        setEvents(evRows);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [supabase, location, range.from, range.to, isSupabase, refreshTick]);

  // -------- staff dropdown options --------
  const staffOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const ev of events) ids.add(ev.staff_id);
    for (const [id] of staffLookup) ids.add(id);
    return Array.from(ids)
      .map((id) => ({
        user_id: id,
        display_name: staffLookup.get(id)?.display_name ?? `User ${id.slice(0, 8)}`,
      }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
  }, [events, staffLookup]);

  // -------- apply staff + department filters --------
  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      if (selectedStaff !== ALL_STAFF && e.staff_id !== selectedStaff) return false;
      if (selectedDepartment !== ALL_DEPARTMENTS && e.department !== selectedDepartment) return false;
      return true;
    });
  }, [events, selectedStaff, selectedDepartment]);

  // Same as filteredEvents but ignoring the staff filter — used for the
  // leaderboard so you always see everyone in the department for comparison.
  const eventsForLeaderboard = useMemo(() => {
    if (selectedDepartment === ALL_DEPARTMENTS) return events;
    return events.filter((e) => e.department === selectedDepartment);
  }, [events, selectedDepartment]);

  // -------- derive metrics from filtered events --------
  const derived = useMemo(() => deriveCompletedLines(filteredEvents), [filteredEvents]);
  const { completedLines, unitsCompleted, ordersCompleted } = derived;

  const dispatchedOrders = useMemo(() => {
    const s = new Set<string>();
    for (const ev of filteredEvents) {
      if (ev.event_type === "dispatched") s.add(ev.order_number);
    }
    return s;
  }, [filteredEvents]);

  const totalDurationMin = useMemo(
    () => completedLines.reduce((a, b) => a + b.duration_min, 0),
    [completedLines],
  );
  const totalUnitsForAvg = useMemo(
    () => completedLines.reduce((a, b) => a + (b.duration_min > 0 ? b.line_quantity : 0), 0),
    [completedLines],
  );
  const avgMinPerUnit = totalUnitsForAvg > 0 ? totalDurationMin / totalUnitsForAvg : 0;

  const activeStaffCount = useMemo(() => {
    const s = new Set<string>();
    for (const ev of filteredEvents) s.add(ev.staff_id);
    return s.size;
  }, [filteredEvents]);

    // -------- staff leaderboard (respects department filter, not staff filter) --------
  // Now also tracks days worked + computes orders_per_day / units_per_day.
  // Sort is order_count desc (orders drive the leaderboard until size-effort
  // data is available); units acts as tiebreaker.
  const staffBoard = useMemo(() => {
    type Row = {
      staff_id: string;
      display_name: string;
      units: number;
      units_for_avg: number;
      orders: Set<string>;
      daysWorked: Set<string>;
      duration_min: number;
      hourly_rate: number | null;
    };
    const map = new Map<string, Row>();
    const lbDerived = deriveCompletedLines(eventsForLeaderboard);
    for (const line of lbDerived.completedLines) {
      const info = staffLookup.get(line.staff_id);
      let row = map.get(line.staff_id);
      if (!row) {
        row = {
          staff_id: line.staff_id,
          display_name: info?.display_name ?? "User " + line.staff_id.slice(0, 8),
          units: 0,
          units_for_avg: 0,
          orders: new Set(),
          daysWorked: new Set(),
          duration_min: 0,
          hourly_rate: info?.hourly_rate ?? null,
        };
        map.set(line.staff_id, row);
      }
      row.units += line.line_quantity;
      if (line.duration_min > 0) row.units_for_avg += line.line_quantity;
      row.orders.add(line.order_number);
      row.daysWorked.add(dayKey(line.completed_at));
      row.duration_min += line.duration_min;
    }
    return Array.from(map.values())
      .map((r) => {
        const days = r.daysWorked.size;
        return {
          ...r,
          order_count: r.orders.size,
          days_worked: days,
          units_per_day: days > 0 ? r.units / days : 0,
          orders_per_day: days > 0 ? r.orders.size / days : 0,
          avg_min: r.units_for_avg > 0 ? r.duration_min / r.units_for_avg : 0,
          cost: r.hourly_rate != null ? (r.duration_min / 60) * r.hourly_rate : null,
        };
      })
      .sort((a, b) => b.order_count - a.order_count || b.units - a.units);
  }, [eventsForLeaderboard, staffLookup]);

  // -------- per-staff order drill-down --------
  // Active only when a single staff is selected. Groups filteredEvents
  // (already narrowed by date + dept) by order_number for that staff.
  const staffOrders = useMemo(() => {
    if (selectedStaff === ALL_STAFF) return [];
    type Row = {
      order_number: string;
      first_ms: number;
      last_ms: number;
      depts: Set<ProductionDepartment>;
      verified_lines: number;
      units: number;
    };
    const map = new Map<string, Row>();
    for (const ev of filteredEvents) {
      if (ev.staff_id !== selectedStaff) continue;
      const ms = Date.parse(ev.created_at);
      let row = map.get(ev.order_number);
      if (!row) {
        row = {
          order_number: ev.order_number,
          first_ms: ms,
          last_ms: ms,
          depts: new Set<ProductionDepartment>(),
          verified_lines: 0,
          units: 0,
        };
        map.set(ev.order_number, row);
      }
      row.first_ms = Math.min(row.first_ms, ms);
      row.last_ms  = Math.max(row.last_ms, ms);
      row.depts.add(ev.department);
      if (ev.event_type === "line_verified") {
        row.verified_lines += 1;
        // Units must match the KPI definition - only framed / PF SKUs
        // count. Hooks, gift cards, free prints, legacy / unparseable
        // SKUs all return false from isKpiEligibleSku and contribute 0
        // to units. Set prints multiply by setCount.
        if (isKpiEligibleSku(ev.line_sku)) {
          row.units += (ev.line_quantity ?? 1) * kpiUnitMultiplier(ev.line_sku);
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => b.last_ms - a.last_ms);
  }, [filteredEvents, selectedStaff]);

  // -------- SKU bottleneck --------
  // Groups by SIZE + VARIANT (e.g. A3-FN, A0-PW) rather than full SKU.
  // This surfaces which TYPE of production work is slow rather than
  // which specific artwork - far more actionable for planning.
  // Legacy / unparseable SKUs are skipped (no size + variant to extract).
  // Picture frames get their own bucket prefix (PF) since assembling a
  // frame-only product is a different effort from print + frame.
  const skuBoard = useMemo(() => {
    type Row = { sku: string; units: number; units_for_avg: number; duration_min: number };
    const map = new Map<string, Row>();
    for (const line of completedLines) {
      if (!line.line_sku) continue;
      if (line.line_quantity <= 0) continue; // UN lines: count orders, not items
      const p = parseSku(line.line_sku);
      if (!p) continue; // legacy / unparseable - skip
      if (!p.size || !p.variant) continue;
      const key = p.type === "picture_frame"
        ? `PF ${p.size}-${p.variant}`
        : `${p.size}-${p.variant}`;
      let row = map.get(key);
      if (!row) {
        row = { sku: key, units: 0, units_for_avg: 0, duration_min: 0 };
        map.set(key, row);
      }
      row.units += line.line_quantity;
      if (line.duration_min > 0) row.units_for_avg += line.line_quantity;
      row.duration_min += line.duration_min;
    }
    return Array.from(map.values())
      .map((r) => ({ ...r, avg_min: r.units_for_avg > 0 ? r.duration_min / r.units_for_avg : 0 }))
      .sort((a, b) => b.avg_min - a.avg_min)
      .slice(0, 20);
  }, [completedLines]);

  // -------- CSV export (respects all filters) --------
  const handleExport = useCallback(() => {
    const headers = [
      "timestamp", "staff_name", "department",
      "order_number", "sku", "quantity", "event_type",
      "station_id", "note",
    ];
    const rows = filteredEvents.map((e) => {
      const info = staffLookup.get(e.staff_id);
      return [
        e.created_at,
        info?.display_name ?? e.staff_id,
        PRODUCTION_DEPARTMENT_LABELS[e.department] ?? e.department,
        e.order_number,
        e.line_sku ?? "",
        e.line_quantity ?? "",
        e.event_type,
        e.station_id ?? "",
        (e.note ?? "").replace(/[\r\n]+/g, " "),
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
    a.download = `production-events_${staffSuffix}_${deptSuffix}_${isoLocalDate(range.from)}_to_${isoLocalDate(range.to)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [filteredEvents, staffLookup, selectedStaff, selectedDepartment, range.from, range.to]);

  /* ------------------------------------------------------------
   * Render
   * ------------------------------------------------------------ */

  // === per-day-worked view ===
  const totalStaffDays = staffBoard.reduce((s, r) => s + r.days_worked, 0);
  const avgUnitsPerStaffDay = totalStaffDays > 0 ? unitsCompleted / totalStaffDays : 0;
  const avgOrdersPerStaffDay = totalStaffDays > 0 ? ordersCompleted.size / totalStaffDays : 0;

  if (!isSupabase) {
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

  const selectedStaffName = selectedStaff === ALL_STAFF
    ? null
    : staffLookup.get(selectedStaff)?.display_name ?? selectedStaff;
  const selectedDeptLabel = selectedDepartment === ALL_DEPARTMENTS
    ? null
    : PRODUCTION_DEPARTMENT_LABELS[selectedDepartment];

  // Build a subtitle suffix shared across card headers.
  const subtitleSuffix = [
    selectedStaffName ? selectedStaffName : null,
    selectedDeptLabel ? selectedDeptLabel : null,
  ].filter(Boolean).join(" · ");

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
            onClick={handleExport}
            disabled={filteredEvents.length === 0}
            title="Download raw event log as CSV"
          >
            <Download size={14} />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Order lookup â€” independent of date filter */}
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
            {isoLocalDate(range.from)} → {isoLocalDate(range.to)}
            {loading && <span className="ml-2 italic">loading…</span>}
            {error && <span className="ml-2 text-red-600">{error}</span>}
          </div>
        </CardBody>
      </Card>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiTile
          label="Units completed"
          value={unitsCompleted.toLocaleString()}
        />
        <KpiTile
          label="Orders completed"
          value={ordersCompleted.size.toLocaleString()}
          sub={
            dispatchedOrders.size > 0
              ? `${dispatchedOrders.size.toLocaleString()} dispatched`
              : undefined
          }
        />
        <KpiTile
          label="Avg min / unit"
          value={formatMinutes(avgMinPerUnit)}
        />
        <KpiTile
          label={selectedStaff === ALL_STAFF ? "Active staff" : "Hours worked"}
          value={
            selectedStaff === ALL_STAFF
              ? activeStaffCount.toLocaleString()
              : formatHours(totalDurationMin)
          }
        />
        <KpiTile
          label="Avg orders / staff-day"
          value={avgOrdersPerStaffDay > 0 ? avgOrdersPerStaffDay.toFixed(1) : "--"}
          sub={totalStaffDays > 0 ? `${totalStaffDays} staff-day${totalStaffDays === 1 ? "" : "s"}` : undefined}
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
            Units (items) vs Orders per person
            {subtitleSuffix ? ` -- ${subtitleSuffix}` : ""}
          </span>
        </CardHeader>
        <CardBody>
          {staffBoard.length === 0 ? (
            <Empty label="No completed units in this range." />
          ) : (
            <div style={{ width: "100%", height: 260 }}>
              <ResponsiveContainer>
                <BarChart
                  data={staffBoard.map((s) => ({
                    staff_id: s.staff_id,
                    name: s.display_name,
                    Units: chartMode === "perDay"
                      ? Number(s.units_per_day.toFixed(1))
                      : s.units,
                    Orders: chartMode === "perDay"
                      ? Number(s.orders_per_day.toFixed(1))
                      : s.order_count,
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
                  <Bar dataKey="Units"  fill="#0f172a" radius={[4, 4, 0, 0]} />
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
            {selectedDeptLabel ? `${selectedDeptLabel} only` : "All departments"} — click row to filter
          </span>
        </CardHeader>
        <CardBody className="p-0">
          {staffBoard.length === 0 ? (
            <Empty label="No production events from staff in this range." />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="text-left px-4 py-2 font-semibold">Staff</th>
                    <th className="text-right px-3 py-2 font-semibold">Orders</th>
                    <th className="text-right px-3 py-2 font-semibold">Units</th>
                    <th className="text-right px-3 py-2 font-semibold">Days</th>
                    <th className="text-right px-3 py-2 font-semibold">O/day</th>
                    <th className="text-right px-3 py-2 font-semibold">U/day</th>
                    <th className="text-right px-3 py-2 font-semibold">Hours</th>
                    <th className="text-right px-3 py-2 font-semibold">Avg min/unit</th>
                    <th className="text-right px-4 py-2 font-semibold">Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {staffBoard.map((r) => {
                    const isSelected = selectedStaff === r.staff_id;
                    return (
                      <tr
                        key={r.staff_id}
                        onClick={() =>
                          setSelectedStaff(isSelected ? ALL_STAFF : r.staff_id)
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
                        <td className="px-3 py-2 text-right tabular-nums">{r.order_count.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.units.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.days_worked.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.orders_per_day > 0 ? r.orders_per_day.toFixed(1) : "--"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.units_per_day > 0 ? r.units_per_day.toFixed(1) : "--"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatHours(r.duration_min)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatMinutes(r.avg_min)}</td>
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
            Grouped by size and variant. Top 20 by avg minutes per unit
            {subtitleSuffix ? ` — ${subtitleSuffix}` : ""}
          </span>
        </CardHeader>
        <CardBody className="p-0">
          {skuBoard.length === 0 ? (
            <Empty label="No SKU-level events in this range." />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="text-left px-4 py-2 font-semibold">Size / Variant</th>
                    <th className="text-right px-3 py-2 font-semibold">Units</th>
                    <th className="text-right px-3 py-2 font-semibold">Total time</th>
                    <th className="text-right px-4 py-2 font-semibold">Avg min/unit</th>
                  </tr>
                </thead>
                <tbody>
                  {skuBoard.map((r) => (
                    <tr
                      key={r.sku}
                      className="border-t border-slate-100 dark:border-slate-800"
                    >
                      <td className="px-4 py-2 font-mono text-xs">{r.sku}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.units.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatHours(r.duration_min)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{formatMinutes(r.avg_min)}</td>
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
      {selectedStaff !== ALL_STAFF && staffOrders.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Orders handled by {selectedStaffName}</CardTitle>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {staffOrders.length.toLocaleString()} distinct order{staffOrders.length === 1 ? "" : "s"} in this range. Click an order # to look it up.
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
                    <th className="text-right px-4 py-2 font-semibold">Units</th>
                  </tr>
                </thead>
                <tbody>
                  {staffOrders.map((r) => {
                    const fmt = (ms: number) => new Date(ms).toLocaleString(undefined, {
                      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                    });
                    return (
                      <tr key={r.order_number} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="px-4 py-2 font-mono text-xs">
                          <button
                            type="button"
                            className="text-indigo-600 dark:text-indigo-400 hover:underline"
                            onClick={() => {
                              // Scroll to Order lookup and trigger search.
                              const evt = new CustomEvent("inka:lookup-order", { detail: r.order_number });
                              window.dispatchEvent(evt);
                              window.scrollTo({ top: 0, behavior: "smooth" });
                            }}
                            title="Look up this order"
                          >
                            #{r.order_number}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400 whitespace-nowrap">{fmt(r.first_ms)}</td>
                        <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400 whitespace-nowrap">{fmt(r.last_ms)}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {Array.from(r.depts).map((d) => (
                              <span key={d} className="inline-flex items-center rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-[11px] px-2 py-0.5 ring-1 ring-slate-200 dark:ring-slate-700">
                                {PRODUCTION_DEPARTMENT_LABELS[d]}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.verified_lines.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{r.units.toLocaleString()}</td>
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
      {selectedStaff !== ALL_STAFF && staffOrders.length > 0 ? (
        <StaffProductivityChart
          staffId={selectedStaff}
          staffName={selectedStaffName ?? "Staff"}
          events={filteredEvents}
          rangeFrom={range.from}
          rangeTo={range.to}
        />
      ) : null}

      <CollapsibleSection storageKey="live-completions" title="Live order completions">
        <LiveOrderCompletionsCard />
      </CollapsibleSection>

      <PackageUsageCard
        fromIso={range.from.toISOString()}
        toIso={range.to.toISOString()}
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
  const [searched, setSearched] = useState<string | null>(null);
  const [events, setEvents] = useState<OrderEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = useCallback(async () => {
    const normalized = normalizeOrderNumber(input);
    if (!normalized) {
      setError("Enter an order number first.");
      return;
    }
    setError(null);
    setLoading(true);
    setSearched(normalized);
    try {
      const { data, error: err } = await supabase
        .from("production_events")
        .select("*")
        .eq("location", location)
        .eq("order_number", normalized)
        .order("created_at", { ascending: false });
      if (err) throw err;
      setEvents((data ?? []) as OrderEvent[]);
    } catch (e) {
      setError((e as Error).message);
      setEvents(null);
    } finally {
      setLoading(false);
    }
  }, [supabase, location, input]);

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
    setSearched(null);
    setEvents(null);
    setError(null);
  };

  // Departments that touched this order (set of unique department values from
  // the events). Used for the chip row.
  const touchedDepartments = useMemo(() => {
    if (!events) return new Set<ProductionDepartment>();
    const s = new Set<ProductionDepartment>();
    for (const ev of events) s.add(ev.department);
    return s;
  }, [events]);

  // Total items in the order, deduped by SKU (any one event per unique sku).
  // Returns null if no per-line qty info was logged for the order.
  const totalItemsInOrder = useMemo(() => {
    if (!events) return null;
    const perSku = new Map<string, number>();
    for (const ev of events) {
      if (ev.line_sku && typeof ev.line_quantity === "number" && !perSku.has(ev.line_sku)) {
        perSku.set(ev.line_sku, ev.line_quantity);
      }
    }
    if (perSku.size === 0) return null;
    let sum = 0;
    for (const v of perSku.values()) sum += v;
    return sum;
  }, [events]);

  const auth = useAuth();
  const author = (auth.user && auth.profile)
    ? { user_id: auth.user.id, display_name: auth.profile.display_name }
    : null;
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
                {totalItemsInOrder !== null ? (
                  <span className="text-xs text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 rounded-full px-2 py-0.5">
                    {totalItemsInOrder} item{totalItemsInOrder === 1 ? "" : "s"}
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
  staffId: string;
  staffName: string;
  events: RawEvent[];
  rangeFrom: Date;
  rangeTo: Date;
}

function StaffProductivityChart({
  staffId, staffName, events, rangeFrom, rangeTo,
}: StaffProductivityProps) {
  const daily = useMemo(() => {
    const rows = new Map<string, { day: string; orders: Set<string>; items: number }>();
    // Seed every day in the range so the chart shows zero-work days.
    const startMs = new Date(rangeFrom.getFullYear(), rangeFrom.getMonth(), rangeFrom.getDate()).getTime();
    const endMs = new Date(rangeTo.getFullYear(), rangeTo.getMonth(), rangeTo.getDate()).getTime();
    for (let ms = startMs; ms <= endMs; ms += 86400000) {
      const d = new Date(ms);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      rows.set(key, { day: key, orders: new Set(), items: 0 });
    }
    // Populate from events for this staff only.
    for (const ev of events) {
      if (ev.staff_id !== staffId) continue;
      const d = new Date(ev.created_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const row = rows.get(key);
      if (!row) continue;
      if (ev.event_type === "completed" || ev.event_type === "dispatched") {
        row.orders.add(ev.order_number);
      }
      if (ev.event_type === "line_verified" && isKpiEligibleSku(ev.line_sku)) {
        row.items += (ev.line_quantity ?? 1) * kpiUnitMultiplier(ev.line_sku);
      }
    }
    return Array.from(rows.values())
      .map((r) => ({
        day: r.day,
        dayLabel: (() => {
          const [y, m, dd] = r.day.split("-").map(Number);
          const d = new Date(y, m - 1, dd);
          return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
        })(),
        dayOfWeek: (() => {
          const [y, m, dd] = r.day.split("-").map(Number);
          return new Date(y, m - 1, dd).getDay();
        })(),
        orders: r.orders.size,
        items: r.items,
      }));
  }, [events, staffId, rangeFrom, rangeTo]);

  const summary = useMemo(() => {
    const totalOrders = daily.reduce((s, r) => s + r.orders, 0);
    const totalItems = daily.reduce((s, r) => s + r.items, 0);
    const workedDays = daily.filter((r) => r.orders > 0 || r.items > 0).length;
    const avgOrders = workedDays > 0 ? totalOrders / workedDays : 0;
    const bestDay = daily.reduce((best, r) => (r.orders > best.orders ? r : best), { orders: 0, items: 0, dayLabel: "-" } as { orders: number; items: number; dayLabel: string });
    const highestItemsDay = daily.reduce((best, r) => (r.items > best.items ? r : best), { orders: 0, items: 0, dayLabel: "-" } as { orders: number; items: number; dayLabel: string });
    // 7-day rolling stdev of orders (last 7 days worked)
    const workedOrders = daily.filter((r) => r.orders > 0 || r.items > 0).slice(-7).map((r) => r.orders);
    let stdev = 0;
    if (workedOrders.length >= 2) {
      const mean = workedOrders.reduce((s, n) => s + n, 0) / workedOrders.length;
      const variance = workedOrders.reduce((s, n) => s + (n - mean) ** 2, 0) / workedOrders.length;
      stdev = Math.sqrt(variance);
    }
    const weekendItems = daily.reduce((s, r) => s + ((r.dayOfWeek === 0 || r.dayOfWeek === 6) ? r.items : 0), 0);
    const weekendPct = totalItems > 0 ? (weekendItems / totalItems) * 100 : 0;
    return { totalOrders, totalItems, avgOrders, bestDay, highestItemsDay, stdev, weekendPct };
  }, [daily]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{staffName} - daily productivity</CardTitle>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          Orders + items per day across the selected range
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
            <div className="text-xl font-bold tabular-nums">{summary.totalItems.toLocaleString()}</div>
          </div>
          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Avg / day worked</div>
            <div className="text-xl font-bold tabular-nums">{summary.avgOrders.toFixed(1)}</div>
            <div className="text-[10px] text-slate-500">orders</div>
          </div>
          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Best day</div>
            <div className="text-xl font-bold tabular-nums">{summary.bestDay.orders}</div>
            <div className="text-[10px] text-slate-500">orders {summary.bestDay.dayLabel !== "-" ? "\u00b7 " + summary.bestDay.dayLabel : ""}</div>
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
              <LineChart data={daily} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
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
