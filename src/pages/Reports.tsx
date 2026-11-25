import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ReportsSectionNav } from "@/components/ReportsSectionNav";
import {
  ArrowRight, BarChart3, ChevronDown, Clock, Download, Layers, Package, RefreshCw, RotateCcw, Search, Trash2, User, Users, Zap,
  type LucideIcon,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { getSupabase, getBackendMode } from "@/lib/repository/supabase/client";
import { fetchAllRows } from "@/lib/repository/supabase/pageThrough";
import { createOrderLookupSession, viewForScope, type OrderLookupView } from "@/lib/repository/supabase/orderLookupSession";
import { useAppStore } from "@/lib/state/appStore";
import { Section } from "@/components/ui/Section";
import { EmptyState } from "@/components/ui/EmptyState";
import { Callout } from "@/components/ui/Callout";
import { Segmented } from "@/components/ui/Segmented";
import { Avatar, Tag, colorForId } from "@/components/ui/Tag";
import { Pager, clampPage, type PageSize } from "@/components/ui/Pager";
import { nField, nTable, nTableWrap, nTd, nTdNum, nTh, nThNum } from "@/components/ui/nStyles";
import type { TagColor } from "@/lib/auth/roles";
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
import { PackagingAttentionCard } from "@/components/PackagingAttentionCard";
import { LiveOrderCompletionsCard } from "@/components/LiveOrderCompletionsCard";
import { ReportsOverview } from "@/components/ReportsOverview";
import { OrderTimelineCard } from "@/components/OrderTimelineCard";
import { OrderFlowSection } from "@/components/OrderFlowSection";
import {
  ATTRIBUTION_CSV_HEADERS,
  attributableEventIds,
  attributionCsvCells,
  fetchAttributionsForEvents,
  fetchAttributionsForOrder,
  groupByEvent,
  type AttributionLoad,
  type FramerAttribution,
} from "@/lib/scanners/attribution";
import { ProductionCountStatus } from "@/components/ProductionCountStatus";
import { useProductionEvidence } from "@/lib/hooks/useProductionSummary";
import { usePublishedManagement } from "@/lib/hooks/usePublishedManagement";
import { managementSource, publishedCsvHeader, publishedCsvLines, publishedDetailList, publishedOrders, publishedStatusLine, rawRangeFor, reportViewFromSummary } from "@/lib/domain/productionPublishedView";
import {
  isProductionDate,
  isReportSite,
  productionDateAt,
  productionRange,
  shiftProductionDate,
  type ProductionRange,
} from "@/lib/domain/productionPeriods";
import { type ProductionEvidenceEvent, type WorkType } from "@/lib/domain/productionCounts";
import { type PublishedDetailRow } from "@/lib/domain/productionReporting";
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
      <div className="mx-auto max-w-hub px-4 pt-9 sm:px-8 lg:px-14">
        <Callout>
          Reports require the Supabase backend. This dataset is running in
          local-only mode.
        </Callout>
      </div>
    );
  }
  return (
    <div id="reports-root" className="mx-auto max-w-[1440px]">
      <ReportsSectionNav containerId="reports-root" />
      <RoleReports />
    </div>
  );
}

/**
 * F8: the role split runs BEFORE any legacy Reports hook mounts. Staff and CS
 * get only the published overview (their own work / the server-chosen
 * audience); the legacy full-team view (staff list, hourly rates, raw event
 * reads) mounts only for owner and manager. Kiosk never sees Reports.
 */
export function reportsLayoutFor(role: string | null): "pending" | "denied" | "overview_only" | "full" {
  if (role === null) return "pending";
  if (role === "kiosk") return "denied";
  if (role === "owner" || role === "manager") return "full";
  return "overview_only";
}

/** F10: whole-order management view. Staff and kiosk never; CS still needs Reports permission + membership (server-enforced). */
export function orderTimelineVisible(role: string | null): boolean {
  return role === "owner" || role === "manager" || role === "cs";
}

export interface ReportsAccess {
  layout: "pending" | "denied" | "overview_only" | "full";
  userId: string | null;
  role: string | null;
  /** Trusted identity of everything shown: user + role + audience. A change remounts the summary. */
  scopeKey: string;
}

/**
 * Fail closed: while auth loads, or when the session, user and profile do not
 * all belong to the same person (AuthProvider keeps the previous profile until
 * the new one arrives), nothing role-dependent mounts.
 */
export function reportsAccessFor(a: {
  loading: boolean;
  session: { user: { id: string } } | null;
  user: { id: string } | null;
  profile: { user_id: string; role: string } | null;
}): ReportsAccess {
  const pending: ReportsAccess = { layout: "pending", userId: null, role: null, scopeKey: "" };
  if (a.loading || !a.session || !a.user || !a.profile) return pending;
  if (a.profile.user_id !== a.user.id || a.session.user.id !== a.user.id) return pending;
  const role = a.profile.role;
  const layout = reportsLayoutFor(role);
  return { layout, userId: a.user.id, role, scopeKey: `${a.user.id}|${role}|${role === "staff" ? "self" : "site"}` };
}

/** The role-dependent tree for one resolved access (pure; legacy only for a matching owner/manager). */
export function ReportsForAccess({ access, overview, legacy }: { access: ReportsAccess; overview: (a: ReportsAccess) => ReactNode; legacy: () => ReactNode }) {
  if (access.layout === "pending") return <div className="p-6 text-sm text-slate-500" role="status">Loading your access…</div>;
  if (access.layout === "denied") return <div className="p-6 text-sm text-slate-600 dark:text-slate-300">Reports are not available on kiosk accounts.</div>;
  if (access.layout === "overview_only") return <div className="p-4 md:p-6 space-y-4">{overview(access)}</div>;
  return (
    <>
      <div className="px-4 md:px-6 pt-4 md:pt-6">{overview(access)}</div>
      {legacy()}
    </>
  );
}

function RoleReports() {
  const auth = useAuth();
  const supabase = getSupabase();
  const location = useAppStore((s) => s.location);
  const access = reportsAccessFor(auth);
  return (
    <ReportsForAccess
      access={access}
      overview={(a) => (
        <>
          <ReportsOverview
            key={a.scopeKey}
            supabase={supabase}
            site={location}
            scopeKey={a.scopeKey}
            userId={a.userId}
            role={a.role}
            ownName={auth.profile?.display_name ?? null}
            detailBelow={a.layout === "full"}
          />
          {orderTimelineVisible(a.role) ? (
            <div key={`timeline|${a.scopeKey}`} className="mt-4 space-y-4">
              <OrderTimelineCard supabase={supabase} scopeKey={a.scopeKey} site={location} role={a.role} />
              <OrderFlowSection supabase={supabase} scopeKey={a.scopeKey} site={location} />
            </div>
          ) : null}
        </>
      )}
      legacy={() => <SupabaseReports />}
    />
  );
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
  // "Orders handled by" table: shown a page at a time.
  const [ordersPage, setOrdersPage] = useState(0);
  const [ordersPageSize, setOrdersPageSize] = useState<PageSize>(10);
  // Back to the first page whenever the filtered set changes.
  useEffect(() => { setOrdersPage(0); }, [selectedStaff, selectedDepartment, preset, customFrom, customTo, location]);

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

  const staffId = selectedStaff === ALL_STAFF ? null : selectedStaff;
  const workType = selectedDepartment === ALL_DEPARTMENTS ? null : (selectedDepartment as WorkType);
  // Published first: the raw-history read runs ONLY for a site that answered READ_MODE_LEGACY (no dual read, no fallback).
  const pub = usePublishedManagement({ supabase, view: "reports", site: location, range, staffId, workType, refreshKey: refreshTick });
  const source = managementSource(pub.status);
  const evidence = useProductionEvidence({ client: supabase, site: location, range: rawRangeFor(pub.status, range), refreshKey: refreshTick });

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

  const legacyView = useMemo(
    () => (source === "legacy" && evidence.prepared && range ? buildProductionReportView(evidence.prepared, { range, staffId, workType }) : null),
    [source, evidence.prepared, range, staffId, workType],
  );
  // The published status line (cutoff, 15/30/120-minute freshness, days the generation does not cover).
  const line = isReportSite(location) && source !== "legacy" ? publishedStatusLine(pub, { site: location, range, nowMs: Date.now() }) : null;
  const pubView = useMemo(
    () => (source === "published" && pub.summary && line?.coveredThrough ? reportViewFromSummary(pub.summary, { staffId, details: pub.details, coveredThrough: line.coveredThrough }) : null),
    [source, pub.summary, pub.details, staffId, line?.coveredThrough],
  );
  const view = source === "legacy" ? legacyView : pubView;
  const statusState = line ? { ...line, refresh: pub.refresh } : evidence;

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
    // Published sites export from generation-pinned raw-export pages (next slice); the raw history read never runs here.
    if (source !== "legacy" || !legacyView || !range) return;
    const rowsToExport = legacyView.exportEvents;
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
      // F7: framer attributions for the shared-scanner dispatch rows in this
      // exact export, appended as two columns. Event columns and row counts are unchanged.
      const attrIds = attributableEventIds(rowsToExport);
      const attr = attrIds.length > 0 ? await fetchAttributionsForEvents(supabase, location, attrIds) : { ok: true as const, rows: [] };
      const byEvent = groupByEvent(attr.ok ? attr.rows : []);
      const headers = [
        "timestamp", "staff_name", "department",
        "order_number", "sku", "quantity", "event_type",
        "station_id", "note", ...ATTRIBUTION_CSV_HEADERS,
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
          ...attributionCsvCells(e.id, byEvent, !attr.ok),
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
  }, [source, legacyView, range, supabase, location, staffLookup, selectedStaff, selectedDepartment]);

  // -------- published CSV export (opt-in; every raw-export page of the SHOWN generation and filters) --------
  const handlePublishedExport = useCallback(async () => {
    if (source !== "published" || !pub.summary || !range) return;
    setExportError(null);
    setExporting(true);
    try {
      // Page-chunked: ONE BlobPart per validated page (the header, then each page as one CRLF-led chunk),
      // never a string per row or a whole-file join. The Blob is created only after the WHOLE collection
      // resolved - any typed refusal (view changed, page failure, revocation, no progress) rejects first and
      // every buffered chunk is discarded: never a partial file.
      // F7: the framer columns need the attributions of every shared-scanner dispatch row, so the
      // validated pages are kept until the collection resolves, then rendered one chunk per page.
      // The attribution read runs inside the collector (beforeFinish), so a view change during it is
      // VIEW_CHANGED and nothing downloads; only synchronous work follows until the download.
      const pages: PublishedDetailRow[][] = [];
      let attr: AttributionLoad = { ok: true, rows: [] };
      await pub.collectAll("raw-export", {
        limit: 1000,
        onPage: (rows) => {
          if (rows.length) pages.push(rows);
        },
        beforeFinish: async () => {
          const attrIds = attributableEventIds(pages.flat().flatMap((r) => (r.kind === "raw-export" ? [{ id: r.row.id, event_type: r.row.eventType }] : [])));
          if (attrIds.length > 0) attr = await fetchAttributionsForEvents(supabase, location, attrIds);
        },
      });
      const byEvent = groupByEvent(attr.ok ? attr.rows : []);
      const extra = (eventId: string) => attributionCsvCells(eventId, byEvent, !attr.ok);
      const chunks: BlobPart[] = [publishedCsvHeader(ATTRIBUTION_CSV_HEADERS)];
      for (const rows of pages) chunks.push(`\r\n${publishedCsvLines(rows, nameOf, extra).join("\r\n")}`);
      const blob = new Blob(chunks, { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const staffSuffix = staffId ? nameOf(staffId).replace(/[^a-z0-9]+/gi, "-").toLowerCase() : "all-staff";
      const deptSuffix = workType ?? "all-depts";
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
  }, [source, pub, range, nameOf, staffId, workType, supabase, location]);

  // Selected person's published orders: loaded only on request, paged in the shown generation.
  const pubOrders = pubView ? publishedOrders(pub.details) : null;
  // Coverage issues and timing observations: published drill-downs loaded only on request.
  const coverageList = pubView ? publishedDetailList(pub.details, "coverage") : null;
  const timingList = pubView ? publishedDetailList(pub.details, "timing") : null;
  const fmtUtc = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", ...(range ? { timeZone: range.timeZone } : {}) });
  const orderRows = legacyView ? legacyView.staffOrders : pubOrders?.rows ?? [];

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

  const kpis: KpiCell[] = [
    { label: itemsLabel, icon: Layers, value: summary ? fmtItems(summary.normal.items) : "--", sub: workType ? undefined : "work processed" },
    {
      label: "Orders completed",
      icon: Package,
      value: summary ? summary.normal.orders.toLocaleString() : "--",
      sub: view && view.dispatchedOrders > 0 ? `${view.dispatchedOrders.toLocaleString()} dispatched` : undefined,
    },
    {
      label: "CS / rework",
      icon: RotateCcw,
      value: summary ? `${fmtItems(summary.rework.items)} items` : "--",
      sub: summary ? `${summary.rework.orders.toLocaleString()} case order${summary.rework.orders === 1 ? "" : "s"}` : undefined,
    },
    { label: "Avg min / unit", icon: Clock, value: view ? formatMinutes(view.timing.avgMinPerUnit) : "--", sub: "framed units only" },
    selectedStaff === ALL_STAFF
      ? { label: "Active staff", icon: User, value: view ? view.activeStaff.toLocaleString() : "--" }
      : { label: "Hours worked", icon: User, value: view ? formatHours(view.timing.durationMin) : "--" },
    {
      label: "Avg orders / staff-day",
      icon: Zap,
      value: view && view.avgOrdersPerStaffDay > 0 ? view.avgOrdersPerStaffDay.toFixed(1) : "--",
      sub: view && view.staffDays > 0 ? `${view.staffDays} staff-day${view.staffDays === 1 ? "" : "s"}` : undefined,
    },
  ];
  const chartRows = staffBoard.map((s) => ({
    staff_id: s.staffId,
    name: s.display_name,
    Items: chartMode === "perDay" ? Number(s.itemsPerDay.toFixed(1)) : (s.normal.items ?? 0),
    Orders: chartMode === "perDay" ? Number(s.ordersPerDay.toFixed(1)) : s.normal.orders,
    valueLabel: chartMode === "perDay"
      ? `${s.itemsPerDay.toFixed(1)} · ${s.ordersPerDay.toFixed(1)}`
      : `${fmtItems(s.normal.items)} · ${s.normal.orders.toLocaleString()}`,
  }));
  const maxChartValue = Math.max(1, ...chartRows.map((r) => Math.max(r.Items, r.Orders)));
  const slowestAvg = view?.skuBoard[0]?.avgMin ?? 0;
  const ordersPageSafe = clampPage(ordersPage, orderRows.length, ordersPageSize);
  const loadingOrEmpty = (empty: string) =>
    statusState.status === "loading" ? "Loading…" : statusState.status === "error" ? "Counts unavailable." : empty;

  return (
    <div className="relative mx-auto max-w-hub px-4 pb-[100px] pt-6 sm:px-8 lg:px-14">
      {/* Page header */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-0">
          <div className="mb-3.5 grid h-[52px] w-[52px] place-items-center rounded-xl border border-hub-line bg-hub-fill text-hub-muted">
            <BarChart3 size={26} strokeWidth={1.4} aria-hidden />
          </div>
          <h1 className="text-[26px] font-bold leading-tight tracking-[-0.01em] text-hub-text md:text-[32px]">Production Reports</h1>
          <p className="mt-1.5 text-sm text-hub-muted">
            Output, speed and packaging across the floor for this location.
          </p>
        </div>
        <div className="ml-auto flex gap-1.5 pb-1">
          <Button variant="ghost" onClick={() => setRefreshTick((n) => n + 1)} title="Refetch data">
            <RefreshCw size={15} strokeWidth={1.6} aria-hidden /> Refresh
          </Button>
          <Button
            variant="secondary"
            onClick={() => void (source === "legacy" ? handleExport() : handlePublishedExport())}
            disabled={exporting || (source === "legacy" ? !legacyView || legacyView.exportEvents.length === 0 : source !== "published" || !pub.summary)}
            title={source === "legacy" ? "Download raw event log as CSV" : "Download the raw event log of this report version as CSV"}
          >
            <Download size={15} strokeWidth={1.6} aria-hidden />
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
        </div>
      </div>

      {/* Order lookup (independent of the date filter) */}
      <OrderLookupCard
        supabase={supabase}
        location={location}
        staffLookup={staffLookup}
      />

      {/* Filter bar */}
      <div className="mt-[26px] border-b border-hub-line pb-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPreset(p.key)}
              aria-pressed={preset === p.key}
              className={cn(pill, preset === p.key && pillOn)}
            >
              {p.label}
            </button>
          ))}
          {preset === "custom" && (
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                aria-label="From"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className={cn(nField, "h-7 text-[13px]")}
              />
              <ArrowRight size={14} className="text-hub-faint" aria-hidden />
              <input
                type="date"
                aria-label="To"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className={cn(nField, "h-7 text-[13px]")}
              />
            </div>
          )}

          <span aria-hidden className="mx-1.5 h-[18px] w-px bg-hub-line-2" />

          {/* Staff dropdown: the native select is stretched invisibly over the pill */}
          <label className={cn(pill, "relative", selectedStaff !== ALL_STAFF && pillOn)}>
            <User size={13} strokeWidth={1.6} aria-hidden />
            Staff: <b className="font-medium text-hub-text">{selectedStaffName ?? "All"}</b>
            <ChevronDown size={13} strokeWidth={1.6} aria-hidden />
            <select
              id="staff-filter"
              aria-label="Staff"
              value={selectedStaff}
              onChange={(e) => setSelectedStaff(e.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              <option value={ALL_STAFF}>All staff</option>
              {staffOptions.map((s) => (
                <option key={s.user_id} value={s.user_id}>
                  {s.display_name}
                </option>
              ))}
            </select>
          </label>

          <label className={cn(pill, "relative", selectedDepartment !== ALL_DEPARTMENTS && pillOn)}>
            <Layers size={13} strokeWidth={1.6} aria-hidden />
            Dept: <b className="font-medium text-hub-text">{selectedDeptLabel ?? "All"}</b>
            <ChevronDown size={13} strokeWidth={1.6} aria-hidden />
            <select
              id="dept-filter"
              aria-label="Department"
              value={selectedDepartment}
              onChange={(e) =>
                setSelectedDepartment(e.target.value as ProductionDepartment | typeof ALL_DEPARTMENTS)
              }
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              {DEPARTMENT_OPTIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>

          {(selectedStaff !== ALL_STAFF || selectedDepartment !== ALL_DEPARTMENTS) && (
            <button
              type="button"
              onClick={() => {
                setSelectedStaff(ALL_STAFF);
                setSelectedDepartment(ALL_DEPARTMENTS);
              }}
              className="rounded px-1.5 text-[13px] text-hub-muted hover:bg-hub-fill hover:text-hub-text"
            >
              Clear
            </button>
          )}

          <div className="ml-auto text-[12.5px] tabular-nums text-hub-faint">
            {range ? formatRangeLabel(range.firstDate, range.lastDate) : null}
          </div>
        </div>
        {rangeProblem || staffError || exportError ? (
          <div className="mt-2 flex flex-wrap gap-x-3 text-[12.5px] text-hub-bad">
            {rangeProblem ? <span>{rangeProblem}</span> : null}
            {staffError ? <span>{staffError}</span> : null}
            {exportError ? <span>{exportError}</span> : null}
          </div>
        ) : null}
        <ProductionCountStatus
          className="mt-2"
          state={statusState}
          range={range}
          coverage={view?.coverage ?? null}
          notes={line ? [...disclosures, ...line.notes.filter((n) => !line.warnings.includes(n))] : disclosures}
          warnings={line?.warnings}
        />
      </div>

      {/* KPI strip: one bordered box, hairline dividers */}
      <div className="mt-[22px] grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-hub-line bg-hub-line md:grid-cols-3 xl:grid-cols-6">
        {kpis.map((k) => (
          <div key={k.label} className="bg-hub-page px-[18px] py-4">
            <div className="flex items-center gap-1.5 text-[12.5px] text-hub-muted">
              <k.icon size={14} strokeWidth={1.6} className="text-hub-faint" aria-hidden />
              {k.label}
            </div>
            <div
              className={cn(
                "mt-1 text-[26px] font-semibold tracking-[-0.02em] tabular-nums text-hub-text",
                isDimValue(k.value) && "text-hub-faint",
              )}
            >
              {k.value}
            </div>
            {/* There is no previous-period comparison, so this line holds the
                existing sub-text (or stays empty at the same height). */}
            <div className="mt-0.5 text-xs text-hub-faint">{k.sub ?? " "}</div>
          </div>
        ))}
      </div>

      {/* Output by staff */}
      <Section
        title="Output by staff"
        subtitle={`Items vs orders per person (normal work; all visible staff)${selectedDeptLabel ? ` · ${selectedDeptLabel}` : ""}`}
        storageKey={sectionKey("output-by-staff")}
        actions={
          <>
            {staffBoard.length > 0 ? (
              <div className="flex gap-3.5 text-xs text-hub-muted">
                <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block h-2 w-2 rounded-sm bg-hub-accent-text" />Items</span>
                <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block h-2 w-2 rounded-sm bg-hub-info opacity-70" />Orders</span>
              </div>
            ) : null}
            <Segmented
              label="Chart values"
              className="ml-2.5"
              value={chartMode}
              onChange={setChartMode}
              options={[
                { value: "totals", label: "Totals" },
                { value: "perDay", label: "Per day worked" },
              ]}
            />
          </>
        }
      >
        {staffBoard.length === 0 ? (
          <EmptyState icon={BarChart3} title={loadingOrEmpty("No credited items or orders in this range")} hint="Try a wider date range or a different department." />
        ) : (
          <div style={{ width: "100%", height: Math.max(80, chartRows.length * 36 + 8) }}>
            <ResponsiveContainer>
              <BarChart
                layout="vertical"
                data={chartRows}
                margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
                barGap={3}
                barCategoryGap={12}
                onClick={(state: any) => {
                  const pl = state?.activePayload?.[0]?.payload;
                  if (pl?.staff_id) {
                    setSelectedStaff((cur) => cur === pl.staff_id ? ALL_STAFF : pl.staff_id);
                  }
                }}
                style={{ cursor: "pointer", fontFamily: "inherit" }}
              >
                <XAxis type="number" domain={[0, maxChartValue]} hide />
                <YAxis
                  yAxisId="names"
                  type="category"
                  dataKey="name"
                  width={150}
                  tick={{ fontSize: 13.5, fill: "rgb(var(--hub-text))", textAnchor: "start", dx: -142 }}
                  axisLine={false}
                  tickLine={false}
                />
                {/* Values on the right, as "items · orders" */}
                <YAxis
                  yAxisId="values"
                  orientation="right"
                  type="category"
                  dataKey="valueLabel"
                  width={116}
                  tick={{ fontSize: 12.5, fill: "rgb(var(--hub-muted))" }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: "rgb(var(--hub-hover))" }}
                  contentStyle={CHART_TOOLTIP}
                  labelStyle={{ fontWeight: 600, color: "rgb(var(--hub-text))" }}
                  itemStyle={{ color: "rgb(var(--hub-muted))" }}
                />
                <Bar yAxisId="names" dataKey="Items" fill="rgb(var(--hub-accent-text))" barSize={8} radius={3} isAnimationActive={false} />
                <Bar yAxisId="names" dataKey="Orders" fill="rgb(var(--hub-info))" fillOpacity={0.7} barSize={8} radius={3} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Section>

      {/* Staff leaderboard */}
      <Section
        title="Staff leaderboard"
        meta={staffBoard.length > 0 ? `${staffBoard.length} ${staffBoard.length === 1 ? "person" : "people"}` : undefined}
        subtitle={
          `${selectedDeptLabel ? `${selectedDeptLabel} only` : "All departments"} · all visible staff`
          + (selectedStaffName ? ` (the tiles above show ${selectedStaffName} only)` : "")
          + " · click a row to filter the page"
        }
        storageKey={sectionKey("staff-leaderboard")}
      >
        {pubView && !pubView.people.complete ? (
          <div className="mb-2 flex items-center gap-2 text-xs text-hub-warn" role="status">
            Showing {pubView.people.shown.toLocaleString()} of {pubView.people.total.toLocaleString()} people.
            <button type="button" className="underline" onClick={() => pub.nextPage("people")}>Load more</button>
          </div>
        ) : null}
        {staffBoard.length === 0 ? (
          <EmptyState icon={Users} title={statusState.status === "error" ? "Counts unavailable." : "No credited production from staff in this range"} hint="Events appear here once staff start scanning orders." />
        ) : (
          <div className={nTableWrap}>
            <table className={nTable}>
              <thead>
                <tr>
                  <th className={cn(nTh, "w-[30px]")}><span className="sr-only">Rank</span></th>
                  <th className={nTh}>Staff</th>
                  <th className={nThNum}>Orders</th>
                  <th className={nThNum}>Items</th>
                  <th className={nThNum}>Rework</th>
                  <th className={nThNum}>Days</th>
                  <th className={nThNum}>O/day</th>
                  <th className={nThNum}>I/day</th>
                  <th className={nThNum}>Hours</th>
                  <th className={nThNum}>Avg min/unit</th>
                  <th className={nThNum}>Est. cost</th>
                </tr>
              </thead>
              <tbody>
                {staffBoard.map((r, i) => {
                  const isSelected = selectedStaff === r.staffId;
                  return (
                    <tr
                      key={r.staffId}
                      onClick={() =>
                        setSelectedStaff(isSelected ? ALL_STAFF : r.staffId)
                      }
                      className={cn("cursor-pointer", isSelected ? "bg-hub-fill" : "hover:bg-hub-hover")}
                      title={isSelected ? "Click to clear filter" : `Click to filter to ${r.display_name}`}
                    >
                      <td className={cn(nTd, "w-[30px] tabular-nums text-hub-faint")}>{i + 1}</td>
                      <td className={nTd}>
                        <div className="flex items-center gap-[9px] whitespace-nowrap">
                          <Avatar name={r.display_name} color={colorForId(r.staffId)} size={22} />
                          {r.display_name}
                        </div>
                      </td>
                      <td className={nTdNum}>{r.normal.orders.toLocaleString()}</td>
                      <td className={nTdNum}>{fmtItems(r.normal.items)}</td>
                      <td className={cn(nTdNum, "text-hub-faint")}>
                        {(r.rework.items ?? 0) > 0 || r.rework.orders > 0 ? `${fmtItems(r.rework.items)} / ${r.rework.orders}` : "—"}
                      </td>
                      <td className={cn(nTdNum, "text-hub-faint")}>{r.daysWorked.toLocaleString()}</td>
                      <td className={nTdNum}>{r.ordersPerDay > 0 ? r.ordersPerDay.toFixed(1) : <Dash />}</td>
                      <td className={nTdNum}>{r.itemsPerDay > 0 ? r.itemsPerDay.toFixed(1) : <Dash />}</td>
                      <td className={nTdNum}>{formatHours(r.timing.durationMin)}</td>
                      <td className={nTdNum}>{formatMinutes(r.timing.avgMinPerUnit)}</td>
                      <td className={nTdNum}>
                        {r.cost == null
                          ? <span className="text-hub-faint">No rate</span>
                          : `$${r.cost.toFixed(2)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Slowest variants (SKU bottleneck) */}
      <Section
        title="Slowest variants"
        subtitle={`Grouped by size and variant · top 20 by avg minutes per framed unit${subtitleSuffix ? ` · ${subtitleSuffix}` : ""}`}
        storageKey={sectionKey("slowest-variants")}
      >
        {!view || view.skuBoard.length === 0 ? (
          <EmptyState icon={Layers} title="No SKU-level events in this range" hint="Variants are ranked once units are completed." />
        ) : (
          <div className={nTableWrap}>
            <table className={nTable}>
              <thead>
                <tr>
                  <th className={nTh}>Size</th>
                  <th className={nTh}>Variant</th>
                  <th className={nThNum}>Avg min / unit</th>
                  <th className={nThNum}>Timed units</th>
                  <th className={nThNum}>Total time</th>
                  <th className={cn(nTh, "w-[28%]")}><span className="sr-only">Relative time</span></th>
                </tr>
              </thead>
              <tbody>
                {view.skuBoard.map((r) => {
                  const { size, variant } = splitSizeVariant(r.sku);
                  return (
                    <tr key={r.sku} className="hover:bg-hub-hover">
                      <td className={nTd}><Tag color="blue">{size}</Tag></td>
                      <td className={cn(nTd, "font-mono text-[12.5px]")}>{variant}</td>
                      <td className={nTdNum}>{formatMinutes(r.avgMin)}</td>
                      <td className={cn(nTdNum, "text-hub-faint")}>{r.weight.toLocaleString()}</td>
                      <td className={cn(nTdNum, "text-hub-faint")}>{formatHours(r.durationMin)}</td>
                      <td className={nTd}>
                        <div className="h-1.5 rounded-[3px] bg-hub-line-2">
                          <div
                            className="h-full rounded-[3px] bg-hub-warn opacity-80"
                            style={{ width: `${slowestAvg > 0 ? Math.max(2, (r.avgMin / slowestAvg) * 100) : 0}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {staffId && pubOrders && (!pubOrders.started || !pubOrders.complete) ? (
        <div className="mt-[30px] flex items-center gap-2 text-xs text-hub-muted" role="status">
          {pubOrders.started
            ? `Showing ${pubOrders.shown.toLocaleString()} of ${pubOrders.total.toLocaleString()} orders handled by ${selectedStaffName}.`
            : `Orders handled by ${selectedStaffName} load on request.`}
          <Button variant="secondary" size="sm" onClick={() => pub.nextPage("orders")}>
            {pubOrders.started ? "Load more" : "Load orders"}
          </Button>
        </div>
      ) : null}

      {/* Per-staff order drill-down: only when a single staff is selected */}
      {staffId && view && orderRows.length > 0 ? (
        <Section
          title={`Orders handled by ${selectedStaffName}`}
          navLabel="Orders handled"
          subtitle={
            (legacyView
              ? `${orderRows.length.toLocaleString()} distinct order${orderRows.length === 1 ? "" : "s"} touched in this range; `
              : `${orderRows.length.toLocaleString()} of ${(pubOrders?.total ?? 0).toLocaleString()} order${pubOrders?.total === 1 ? "" : "s"} loaded; `)
            + `${view.summary.normal.orders.toLocaleString()} completed by ${selectedStaffName}. Click an order # to look it up.`
          }
          storageKey={sectionKey("staff-orders")}
        >
          <div className={nTableWrap}>
            <table className={nTable}>
              <thead>
                <tr>
                  <th className={nTh}>Order #</th>
                  <th className={nTh}>First touched</th>
                  <th className={nTh}>Last touched</th>
                  <th className={nTh}>Departments</th>
                  <th className={nThNum}>Lines verified</th>
                  <th className={nThNum}>Items</th>
                  <th className={nTh}>Completed</th>
                </tr>
              </thead>
              <tbody>
                {orderRows.slice(ordersPageSafe * ordersPageSize, (ordersPageSafe + 1) * ordersPageSize).map((r) => {
                  const fmt = (ms: number) => new Date(ms).toLocaleString(undefined, {
                    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                    ...(range ? { timeZone: range.timeZone } : {}),
                  });
                  return (
                    <tr key={r.key} className="hover:bg-hub-hover">
                      <td className={cn(nTd, "whitespace-nowrap")}>
                        <button
                          type="button"
                          className="whitespace-nowrap font-mono text-[12.5px] text-hub-info hover:underline"
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
                        {r.caseId ? <span className="ml-1.5"><Tag color="yellow">CS {r.caseId}</Tag></span> : null}
                      </td>
                      <td className={cn(nTd, "whitespace-nowrap text-hub-muted")}>{fmt(r.firstMs)}</td>
                      <td className={cn(nTd, "whitespace-nowrap text-hub-muted")}>{fmt(r.lastMs)}</td>
                      <td className={nTd}>
                        <div className="flex flex-wrap gap-1">
                          {r.workTypes.map((d) => (
                            <Tag key={d}>{PRODUCTION_DEPARTMENT_LABELS[d]}</Tag>
                          ))}
                        </div>
                      </td>
                      <td className={nTdNum}>{r.verifiedLines.toLocaleString()}</td>
                      <td className={nTdNum}>{fmtItems(r.items)}</td>
                      <td className={nTd}>{r.completed ? "Yes" : <Dash />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager
            total={orderRows.length}
            page={ordersPageSafe}
            size={ordersPageSize}
            onPage={setOrdersPage}
            onSize={(n) => { setOrdersPageSize(n); setOrdersPage(0); }}
            label="orders"
          />
        </Section>
      ) : null}

      {/* Per-staff daily productivity chart */}
      {staffId && view?.personDaily && view.personTotals && (legacyView ? legacyView.staffOrders.length > 0 : view.personDaily.length > 0) ? (
        <StaffProductivityChart
          staffName={selectedStaffName ?? "Staff"}
          daily={view.personDaily}
          totals={view.personTotals.normal}
        />
      ) : null}
      {staffId && pubView && (!pubView.daily.complete || pubView.daily.unpublishedAfter) ? (
        <div className="mt-2 text-xs text-hub-warn" role="status">
          {!pubView.daily.complete ? `The chart shows ${pubView.daily.shown} of ${pubView.daily.total} production days. ` : ""}
          {pubView.daily.unpublishedAfter ? `Days after ${pubView.daily.unpublishedAfter} are not published yet and are not shown.` : ""}
          {!pubView.daily.complete ? (
            <button type="button" className="ml-2 underline" onClick={() => pub.nextPage("days")}>Load more production days</button>
          ) : null}
        </div>
      ) : null}

      {/* Coverage issues (published drill-down; loaded on request, only when there are issues) */}
      {pubView && coverageList && pubView.coverage.issueRows > 0 ? (
        <Section
          title="Coverage issues"
          meta={coverageList.started
            ? `${coverageList.shown.toLocaleString()} of ${coverageList.total.toLocaleString()} issue${coverageList.total === 1 ? "" : "s"} loaded`
            : `${pubView.coverage.issueRows.toLocaleString()} issue${pubView.coverage.issueRows === 1 ? "" : "s"} in this report`}
          storageKey={sectionKey("coverage-issues")}
        >
          {coverageList.rows.length > 0 ? (
            <div className={nTableWrap}>
              <table className={nTable}>
                <thead>
                  <tr>
                    <th className={nTh}>Issue</th>
                    <th className={nTh}>Event</th>
                    <th className={nTh}>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {coverageList.rows.map((r) => (
                    <tr key={`${r.kind}|${r.eventId}`} className="hover:bg-hub-hover">
                      <td className={nTd}>{r.kind.replace(/_/g, " ")}</td>
                      <td className={cn(nTd, "font-mono text-[12.5px]")}>{r.eventId}</td>
                      <td className={cn(nTd, "text-hub-muted")}>{r.detail ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {!coverageList.complete ? (
            <div className="pt-2.5">
              <Button variant="secondary" size="sm" onClick={() => pub.nextPage("coverage")}>
                {coverageList.started ? "Load more" : "Load coverage issues"}
              </Button>
            </div>
          ) : null}
        </Section>
      ) : null}

      {/* Timing observations (published drill-down; loaded on request) */}
      {pubView && timingList ? (
        <Section
          title="Timing observations"
          subtitle={timingList.started
            ? `${timingList.shown.toLocaleString()} of ${timingList.total.toLocaleString()} observation${timingList.total === 1 ? "" : "s"} loaded`
            : "Each framed line with its gap since the worker's previous line"}
          storageKey={sectionKey("timing-observations")}
        >
          {timingList.rows.length > 0 ? (
            <div className={nTableWrap}>
              <table className={nTable}>
                <thead>
                  <tr>
                    <th className={nTh}>Completed</th>
                    <th className={nTh}>Staff</th>
                    <th className={nTh}>Dept</th>
                    <th className={nTh}>Order #</th>
                    <th className={nTh}>SKU</th>
                    <th className={nThNum}>Weight</th>
                    <th className={nThNum}>Minutes</th>
                  </tr>
                </thead>
                <tbody>
                  {timingList.rows.map((r) => (
                    <tr key={r.eventId} className="hover:bg-hub-hover">
                      <td className={cn(nTd, "whitespace-nowrap text-hub-muted")}>{fmtUtc(r.completedAtUtc)}</td>
                      <td className={nTd}>{nameOf(r.staffId)}</td>
                      <td className={nTd}>{PRODUCTION_DEPARTMENT_LABELS[r.workType as ProductionDepartment] ?? r.workType}</td>
                      <td className={cn(nTd, "font-mono text-[12.5px]")}>#{r.orderNumber}</td>
                      <td className={cn(nTd, "font-mono text-[12.5px]")}>{r.sku ?? "—"}</td>
                      <td className={nTdNum}>{r.weight.toLocaleString()}</td>
                      <td className={nTdNum}>{formatMinutes(r.durationMin)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {!timingList.complete ? (
            <div className="pt-2.5">
              <Button variant="secondary" size="sm" onClick={() => pub.nextPage("timing")}>
                {timingList.started ? "Load more" : "Load timing observations"}
              </Button>
            </div>
          ) : null}
        </Section>
      ) : null}

      <LiveOrderCompletionsCard />

      <PackageUsageCard
        fromIso={pkgWindow.from.toISOString()}
        toIso={pkgWindow.to.toISOString()}
        rangeLabel={subtitleSuffix || "current range"}
      />

      <div className="mt-[30px]">
        <PackagingAttentionCard fromIso={pkgWindow.from.toISOString()} toIso={pkgWindow.to.toISOString()} />
      </div>

      <PackageHistoryCard />

      <DailyTimesheetCard />
    </div>
  );
}

/* ============================================================
 * Small subcomponents
 * ============================================================ */

interface KpiCell {
  label: string;
  icon: LucideIcon;
  value: string;
  sub?: string;
}

const RANGE_PRESETS: { key: PresetRange; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "custom", label: "Custom" },
];

/** Pill button / pill dropdown used in the filter bar. */
const pill =
  "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[13px] text-hub-muted shadow-[0_0_0_1px_rgb(var(--hub-line-2))] hover:bg-hub-hover hover:text-hub-text";
const pillOn =
  "bg-hub-accent-bg text-hub-text shadow-[0_0_0_1px_rgb(var(--hub-accent-text)/0.55)] hover:bg-hub-accent-bg";

const CHART_TOOLTIP = {
  fontSize: 12.5,
  borderRadius: 8,
  border: "1px solid rgb(var(--hub-line))",
  background: "rgb(var(--hub-panel))",
  boxShadow: "0 16px 40px var(--hub-shadow-2)",
  color: "rgb(var(--hub-text))",
};

/** localStorage key for a section's open/closed state (same prefix as before). */
function sectionKey(id: string): string {
  return `inka-reports-collapse:${id}`;
}

/** Zero / empty KPI values render muted. */
function isDimValue(v: string): boolean {
  return /^(0|0h|—|--|0 items)$/.test(v.trim());
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Nov 13 – Nov 19, 2026" from two YYYY-MM-DD production dates (no time
 * zone conversion); the year is repeated only when it differs.
 */
export function formatRangeLabel(first: string, last: string): string {
  const parse = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return { y, label: `${SHORT_MONTHS[m - 1]} ${d}` };
  };
  const a = parse(first);
  const b = parse(last);
  if (!a.label || !b.label || Number.isNaN(a.y) || Number.isNaN(b.y)) return `${first} → ${last}`;
  if (first === last) return `${b.label}, ${b.y}`;
  if (a.y === b.y) return `${a.label} – ${b.label}, ${b.y}`;
  return `${a.label}, ${a.y} – ${b.label}, ${b.y}`;
}

/** "A3-FN" → A3 / FN, "PF A3-FN" → PF A3 / FN. Falls back to the whole key. */
export function splitSizeVariant(key: string): { size: string; variant: string } {
  const i = key.lastIndexOf("-");
  if (i <= 0) return { size: key, variant: "" };
  return { size: key.slice(0, i), variant: key.slice(i + 1) };
}

function Dash() {
  return <span className="text-hub-faint">—</span>;
}

/* ============================================================
 * OrderLookupCard — search any order across all time
 * ============================================================
 *
 * Standalone widget at the top of the Reports page. Lets owners /
 * managers paste an order number (either the 6-digit scanner code
 * "190203" or the full "10190203" Shopify number) and see every
 * production_event ever logged against that order at the current
 * location. Useful for:
 *
 *   - "Did framing already touch this order?" — checks department chips
 *   - "Who dispatched it?" — first row in the timeline
 *   - "When did it move?" — chronological event log
 *
 * Future: per-order notes (e.g. "framer flagged: customer changed mind,
 * cancel") will live alongside the event timeline. The placeholder
 * "Add note" button is wired but the order_notes table doesn't exist
 * yet — adding a note shows a "coming soon" toast.
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
  // Filter at render time too: the effect above runs after this render, so a
  // view from the previous user/site must not be shown in the meantime.
  const current = viewForScope(view ?? session.view(), scopeKey);
  const { searched, loading, error, lookup, events } = current;
  const setError = useCallback((message: string | null) => session.setError(message), [session]);
  const runSearch = useCallback(() => {
    session.setScope(scopeKey, location);
    return session.search(input);
  }, [session, scopeKey, location, input]);

  // F7: stored "who framed it" rows for shared-scanner dispatches of the shown
  // order, read after the lookup resolves; a late answer for an older search is dropped.
  const [framers, setFramers] = useState<FramerAttribution[] | null>(null);
  const [framersError, setFramersError] = useState<string | null>(null);
  const framerSeq = useRef(0);
  useEffect(() => {
    const mine = ++framerSeq.current;
    setFramers(null);
    setFramersError(null);
    if (!searched || !events || attributableEventIds(events).length === 0) return;
    void fetchAttributionsForOrder(supabaseRef.current, location, searched).then((a) => {
      if (mine !== framerSeq.current) return;
      if (a.ok) setFramers(a.rows);
      else setFramersError(a.message);
    });
  }, [events, searched, location, scopeKey]);

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
    setFramers(null);
    setFramersError(null);
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

  // Department trail: one step per department, oldest first, showing who
  // last touched it there and when. Built only from the events above.
  const trail = useMemo(() => {
    if (!events || events.length === 0) return [];
    const byDept = new Map<ProductionDepartment, { dept: ProductionDepartment; first: number; last: OrderEvent; done: boolean }>();
    for (const ev of events) {
      const ms = Date.parse(ev.created_at);
      const cur = byDept.get(ev.department);
      const done = ev.event_type === "completed" || ev.event_type === "dispatched" || ev.event_type === "line_verified";
      if (!cur) {
        byDept.set(ev.department, { dept: ev.department, first: ms, last: ev, done });
      } else {
        cur.first = Math.min(cur.first, ms);
        if (ms > Date.parse(cur.last.created_at)) cur.last = ev;
        cur.done = cur.done || done;
      }
    }
    return Array.from(byDept.values()).sort((a, b) => a.first - b.first);
  }, [events]);

  const isOwner = !!author && auth.profile?.role === "owner";
  const fmtWhen = (iso: string) => new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  const nameFor = (id: string) => staffLookup.get(id)?.display_name ?? `User ${id.slice(0, 8)}`;

  return (
    <div className="mt-7">
      <form
        data-lookup-form="1"
        onSubmit={(e) => {
          e.preventDefault();
          runSearch();
        }}
      >
        <label className="flex h-[46px] items-center gap-2.5 rounded-[10px] border border-hub-line bg-hub-fill pl-3.5 pr-1.5 transition-colors focus-within:border-hub-accent-text focus-within:bg-hub-panel">
          <Search size={16} strokeWidth={1.6} className="shrink-0 text-hub-faint" aria-hidden />
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Look up an order…"
            aria-label="Order number"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-hub-text outline-none placeholder:text-hub-faint"
            autoComplete="off"
          />
          {(searched || input) && !loading ? (
            <button
              type="button"
              onClick={reset}
              className="rounded px-1.5 py-0.5 text-[12.5px] text-hub-muted hover:bg-hub-fill-2 hover:text-hub-text"
            >
              Clear
            </button>
          ) : null}
          {loading ? (
            <span className="px-1.5 text-[12.5px] text-hub-faint">Searching…</span>
          ) : (
            <kbd className="mr-1.5 rounded px-1.5 py-px font-mono text-[11px] text-hub-faint shadow-[0_0_0_1px_rgb(var(--hub-line-2))]">Enter</kbd>
          )}
          {/* Enter submits; this keeps a real submit control for assistive tech. */}
          <button type="submit" className="sr-only" disabled={loading}>Search</button>
        </label>
      </form>
      <div className="mx-0.5 mt-2 text-[12.5px] text-hub-faint">
        See which departments touched an order. Accepts the 6-digit scanner code{" "}
        <code className="rounded bg-hub-fill px-[5px] font-mono text-xs text-hub-muted">190203</code> or the full Shopify number{" "}
        <code className="rounded bg-hub-fill px-[5px] font-mono text-xs text-hub-muted">10190203</code>.
      </div>

      {error ? (
        <div className="mx-0.5 mt-2 text-[13px] text-hub-warn" role="alert">{error}</div>
      ) : null}

      {searched && events !== null && !loading ? (
        <div className="mt-2.5 space-y-3 rounded-hub-card border border-hub-line px-4 py-3.5">
          {/* Header row: order # + status (+ item count) */}
          <div className="flex flex-wrap items-center gap-2.5">
            <b className="font-semibold text-hub-text">Order #{searched}</b>
            {events.length === 0 ? (
              <Tag color="yellow">Not started</Tag>
            ) : orderStatus ? (
              <Tag color={statusColor(orderStatus)}>{orderStatus}</Tag>
            ) : null}
            {orderCounts && "unavailable" in orderCounts ? (
              <span title="The order's history could not be confirmed complete, so no item count is shown.">
                <Tag color="yellow">item count unavailable (incomplete read)</Tag>
              </span>
            ) : orderCounts ? (
              <span title="Verified pieces across all work types: a piece verified at two stations counts at both.">
                <Tag>
                  {fmtItems(orderCounts.normal)} item{orderCounts.normal === 1 ? "" : "s"} processed
                  {(orderCounts.rework ?? 0) > 0 ? ` · ${fmtItems(orderCounts.rework)} rework` : ""}
                  {orderCounts.incomplete ? " · incomplete detail" : ""}
                </Tag>
              </span>
            ) : null}
          </div>

          {/* Department trail */}
          {trail.length === 0 ? (
            <div className="text-[13px] text-hub-faint">No departments have touched this order yet.</div>
          ) : (
            <div className="flex flex-wrap items-center gap-y-1.5">
              {trail.map((s, i) => (
                <div key={s.dept} className="flex items-center text-[13px] text-hub-muted">
                  {i > 0 ? <span aria-hidden className="mx-2 h-px w-7 bg-hub-line-2" /> : null}
                  <span aria-hidden className={cn("mr-2 h-2 w-2 rounded-full", s.done ? "bg-hub-accent-text" : "bg-hub-warn")} />
                  <span>
                    <span className="text-hub-text">{PRODUCTION_DEPARTMENT_LABELS[s.dept] ?? s.dept}</span>
                    {" · "}{nameFor(s.last.staff_id)}{" · "}{fmtWhen(s.last.created_at)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Order notes (works without any production_events) */}
          <OrderNotesPanel
            supabase={supabase}
            location={location}
            orderNumber={searched}
            author={author}
            variant="compact"
          />

          {events.length === 0 ? (
            <div className="text-[13px] text-hub-faint">
              No production events yet at this location. Add a note above to
              flag this order for whoever picks it up next.
            </div>
          ) : (
            <>
              {/* F7: who framed it, as recorded at shared-scanner dispatch */}
              {framersError ? (
                <div className="text-xs text-hub-bad">Couldn't load framer attribution: {framersError}</div>
              ) : null}
              {framers && framers.length > 0 ? (
                <div className="rounded-hub border border-hub-line px-3 py-2" data-testid="framer-attribution">
                  <div className="mb-1 text-[12.5px] font-medium text-hub-muted">Framed by (recorded at dispatch)</div>
                  <ul className="space-y-0.5 text-sm">
                    {framers.map((f) => (
                      <li key={`${f.dispatch_event_id}|${f.sku}`} className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs">{f.sku}</span>
                        <span className="font-medium">{f.display_name}</span>
                        {f.source === "manual" ? (
                          <span title="Chosen by the dispatcher; no framing scan exists, so it adds no framing time or credit">
                            <Tag color="yellow">Manual</Tag>
                          </span>
                        ) : (
                          <span className="text-xs text-hub-accent-text" title="Measured: framing verification and completion scans">✓ scanned</span>
                        )}
                        {f.source === "manual" ? (
                          <span className="text-[11px] text-hub-faint">chosen by {nameFor(f.dispatcher_id)}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {/* Full event timeline */}
              <div className={nTableWrap}>
                <table className={nTable}>
                  <thead>
                    <tr>
                      <th className={nTh}>When</th>
                      <th className={nTh}>Who</th>
                      <th className={nTh}>Department</th>
                      <th className={nTh}>Event</th>
                      <th className={nTh}>Note</th>
                      {isOwner ? <th className={cn(nThNum, "w-px")}>Remove</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((ev) => (
                      <tr key={ev.id} className="hover:bg-hub-hover">
                        <td className={cn(nTd, "whitespace-nowrap tabular-nums text-hub-muted")}>{fmtWhen(ev.created_at)}</td>
                        <td className={cn(nTd, "whitespace-nowrap")}>{nameFor(ev.staff_id)}</td>
                        <td className={cn(nTd, "whitespace-nowrap")}>
                          {PRODUCTION_DEPARTMENT_LABELS[ev.department] ?? ev.department}
                        </td>
                        <td className={nTd}>
                          <Tag color={eventColor(ev.event_type)}>{ev.event_type}</Tag>
                        </td>
                        <td className={cn(nTd, "max-w-[260px] truncate text-hub-muted")} title={ev.note ?? ""}>
                          {ev.note?.trim() ? ev.note : <span className="text-hub-faint">—</span>}
                        </td>
                        {isOwner ? (
                          <td className={cn(nTd, "whitespace-nowrap text-right")}>
                            <button
                              type="button"
                              onClick={() => void deleteEvent(ev.id)}
                              disabled={deletingId === ev.id}
                              title="Remove this event from the order history"
                              aria-label="Remove this event from the order history"
                              className="inline-flex h-7 w-7 items-center justify-center rounded-hub text-hub-bad hover:bg-hub-bad-bg disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <Trash2 size={14} />
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function statusColor(status: string): TagColor {
  if (status.startsWith("Dispatched")) return "green";
  if (status.startsWith("Scrapped")) return "pink";
  if (status.startsWith("Completed")) return "blue";
  return "yellow";
}

function eventColor(t: OrderEvent["event_type"]): TagColor {
  if (t === "dispatched") return "green";
  if (t === "completed") return "blue";
  if (t === "started") return "yellow";
  if (t === "cancelled") return "pink";
  return "gray";
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

  const cells: Array<[string, string, string?]> = [
    ["Total orders", summary.totalOrders.toLocaleString()],
    ["Total items", fmtItems(summary.totalItems)],
    ["Avg / day worked", summary.avgOrders.toFixed(1), "orders"],
    ["Best day", String(summary.bestDay.orders), `orders${summary.bestDay.dayLabel !== "-" ? " · " + summary.bestDay.dayLabel : ""}`],
  ];
  const axisTick = { fontSize: 11, fill: "rgb(var(--hub-faint))" };

  return (
    <Section
      title={`${staffName} · daily productivity`}
      navLabel="Daily productivity"
      subtitle="Orders and items per production day (04:00 to 04:00 site time). Range totals count each order once."
      storageKey="inka-reports-collapse:staff-daily"
      actions={
        <div className="flex gap-3.5 text-xs text-hub-muted">
          <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block h-2 w-2 rounded-sm bg-hub-accent-text" />Orders</span>
          <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block h-2 w-2 rounded-sm bg-hub-info opacity-70" />Items</span>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-hub-line bg-hub-line md:grid-cols-4">
        {cells.map(([label, value, sub]) => (
          <div key={label} className="bg-hub-page px-4 py-3">
            <div className="text-[12.5px] text-hub-muted">{label}</div>
            <div className="mt-0.5 text-xl font-semibold tabular-nums text-hub-text">{value}</div>
            <div className="text-xs text-hub-faint">{sub ?? " "}</div>
          </div>
        ))}
      </div>

      <div className="mt-4" style={{ width: "100%", height: 260 }}>
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} style={{ fontFamily: "inherit" }}>
            <CartesianGrid stroke="rgb(var(--hub-line))" vertical={false} />
            <XAxis dataKey="dayLabel" tick={axisTick} axisLine={{ stroke: "rgb(var(--hub-line))" }} tickLine={false} />
            <YAxis yAxisId="orders" orientation="left" tick={axisTick} axisLine={false} tickLine={false} width={30} />
            <YAxis yAxisId="items" orientation="right" tick={axisTick} axisLine={false} tickLine={false} width={30} />
            <Tooltip
              contentStyle={CHART_TOOLTIP}
              labelStyle={{ fontWeight: 600, color: "rgb(var(--hub-text))" }}
              itemStyle={{ color: "rgb(var(--hub-muted))" }}
            />
            <Line yAxisId="orders" type="monotone" dataKey="orders" stroke="rgb(var(--hub-accent-text))" strokeWidth={1.75} dot={{ r: 2 }} activeDot={{ r: 4 }} name="Orders" isAnimationActive={false} />
            <Line yAxisId="items" type="monotone" dataKey="items" stroke="rgb(var(--hub-info))" strokeOpacity={0.8} strokeWidth={1.75} strokeDasharray="4 3" dot={{ r: 2 }} activeDot={{ r: 4 }} name="Items" isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
        {([
          ["Highest items in a day", <>{summary.highestItemsDay.items} items{summary.highestItemsDay.dayLabel !== "-" ? <span className="font-normal text-hub-muted"> on {summary.highestItemsDay.dayLabel}</span> : null}</>],
          ["Consistency (7d stdev)", <>&plusmn;{summary.stdev.toFixed(1)} orders/day</>],
          ["Weekend contribution", <>{summary.weekendPct.toFixed(0)}% of items</>],
        ] as Array<[string, ReactNode]>).map(([label, value]) => (
          <div key={label} className="rounded-hub bg-hub-fill px-3.5 py-2.5">
            <div className="text-[12.5px] text-hub-muted">{label}</div>
            <div className="mt-0.5 text-sm font-semibold text-hub-text">{value}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}
