/**
 * F8 Reports v2: period overview (day / Monday week / month / custom) of the
 * site's published F1 counts, by person and by RECORDED business department.
 *
 * Data comes only from /api/reports/overview (server aggregates of one
 * published generation); nothing here reads raw production history. Staff
 * see only their own work (the server forces it too). Names come from
 * staff_barcodes (display only, no payroll), and only for site-wide roles.
 */
import { useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Download, RefreshCw } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { isReportSite, productionDateAt, SITE_TIME_ZONES } from "@/lib/domain/productionPeriods";
import {
  departmentLabel,
  OVERVIEW_WORK_TYPES,
  overviewCsv,
  overviewPeriod,
  UNKNOWN_DEPARTMENT,
  validateOverviewRequest,
  type CountPair,
  type OverviewPeriodKind,
  type OverviewRequest,
  type OverviewResult,
} from "@/lib/domain/reportsOverview";
import { useReportsOverview, type OverviewState } from "@/lib/hooks/useReportsOverview";
import { fetchAllRows } from "@/lib/repository/supabase/pageThrough";
import { FrameTimingSection } from "@/components/FrameTimingSection";
import { PRODUCTION_DEPARTMENT_LABELS, type ProductionDepartment } from "@/lib/domain";

export interface ReportsOverviewProps {
  supabase: SupabaseClient;
  site: string;
  /** Trusted user + role + audience (from the matching session/profile); the request identity. */
  scopeKey: string;
  userId: string | null;
  role: string | null;
  ownName: string | null;
  /** True when the detailed (legacy) Reports view follows below with its own filters. */
  detailBelow?: boolean;
}

const PERIODS: Array<{ value: OverviewPeriodKind; label: string }> = [
  { value: "day", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "custom", label: "Custom" },
];
const fmt = (n: number | null) => (n === null ? "too many" : n.toLocaleString());
const shortId = (id: string) => `User ${id.slice(0, 8)}`;

/** Build the request from the controls; null with a reason when the controls are not a valid request. */
export function buildOverviewRequest(input: {
  site: string; today: string | null; period: OverviewPeriodKind; custom: { from: string; to: string };
  staffId: string | null; workType: string | null; departmentId: string | null;
}): { request: OverviewRequest | null; problem: string | null } {
  if (!isReportSite(input.site) || !input.today) return { request: null, problem: "Reports are available for the AU, UK and US sites." };
  const { firstDate, lastDate } = overviewPeriod(input.period, input.today, input.custom);
  try {
    return {
      request: validateOverviewRequest({
        site: input.site, firstDate, lastDate,
        ...(input.staffId ? { staffId: input.staffId } : {}),
        ...(input.workType ? { workType: input.workType } : {}),
        ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      }),
      problem: null,
    };
  } catch (e) {
    return { request: null, problem: e instanceof Error ? e.message : "Invalid period" };
  }
}

export function ReportsOverview({ supabase, site, scopeKey, userId, role, ownName, detailBelow }: ReportsOverviewProps) {
  const selfOnly = role === "staff";
  const [period, setPeriod] = useState<OverviewPeriodKind>("week");
  const [custom, setCustom] = useState(() => ({ from: "", to: "" }));
  const [staffId, setStaffId] = useState<string | null>(null);
  const [workType, setWorkType] = useState<string | null>(null);
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [deptOptions, setDeptOptions] = useState<Array<{ id: string; label: string }>>([]);

  const today = isReportSite(site) ? productionDateAt(new Date(), site) : null;
  useEffect(() => {
    if (today && (!custom.from || !custom.to)) setCustom({ from: custom.from || today, to: custom.to || today });
  }, [today, custom.from, custom.to]);
  // A site change starts from a clean filter set (person/department ids are per site).
  useEffect(() => {
    setStaffId(null);
    setDepartmentId(null);
    setDeptOptions([]);
  }, [site, scopeKey]);

  // Display names for site-wide roles only (no payroll columns).
  useEffect(() => {
    if (selfOnly || !isReportSite(site)) {
      setNames(new Map());
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // Active badges only, paged so a large roster is never cut at 1,000 rows.
        const rows = await fetchAllRows<{ user_id: string; display_name: string }>((from, to) =>
          supabase.from("staff_barcodes").select("user_id, display_name").eq("location", site).eq("active", true).order("user_id", { ascending: true }).range(from, to),
        );
        if (!cancelled) setNames(new Map(rows.map((r) => [r.user_id, r.display_name])));
      } catch {
        // names are display only; ids are shown instead
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, site, selfOnly]);
  const nameOf = (id: string) => (selfOnly && id === userId ? (ownName ?? "You") : names.get(id) ?? shortId(id));

  const { request, problem } = useMemo(
    () => buildOverviewRequest({ site, today, period, custom, staffId: selfOnly ? null : staffId, workType, departmentId }),
    [site, today, period, custom, staffId, selfOnly, workType, departmentId],
  );
  const state = useReportsOverview(supabase, scopeKey || null, request, refreshKey);
  const data = state.status === "ready" ? state.data : null;

  // Department choices come from unfiltered results (recorded ids and names).
  useEffect(() => {
    if (!data || data.request.departmentId) return;
    setDeptOptions(data.departments.filter((d) => d.departmentId !== null).map((d) => ({ id: d.departmentId as string, label: departmentLabel(d) })));
  }, [data]);

  const download = () => {
    if (!data) return;
    const deptName = data.request.departmentId === UNKNOWN_DEPARTMENT ? "Unknown" : deptOptions.find((d) => d.id === data.request.departmentId)?.label ?? null;
    const csv = overviewCsv(data, { person: nameOf, department: deptName });
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `production-summary_${data.request.site}_${data.request.firstDate}_to_${data.request.lastDate}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Production summary</CardTitle>
        <p className="text-xs text-slate-500 mt-1">
          Published period totals by person and department. These filters apply to this summary only
          {detailBelow ? "; the detailed view below keeps its own period and filters." : "."}
        </p>
      </CardHeader>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500">Period</span>
            <select className="rounded border px-2 py-1 dark:bg-slate-900" value={period} onChange={(e) => setPeriod(e.target.value as OverviewPeriodKind)}>
              {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
          {period === "custom" ? (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-slate-500">From</span>
                <input type="date" className="rounded border px-2 py-1 dark:bg-slate-900" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-slate-500">To</span>
                <input type="date" className="rounded border px-2 py-1 dark:bg-slate-900" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
              </label>
            </>
          ) : null}
          {selfOnly ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">Person</span>
              <span className="py-1">{ownName ?? "You"} (your own work)</span>
            </div>
          ) : (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">Person</span>
              <select className="rounded border px-2 py-1 dark:bg-slate-900" value={staffId ?? ""} onChange={(e) => setStaffId(e.target.value || null)}>
                <option value="">Everyone</option>
                {[...names.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id, n]) => <option key={id} value={id}>{n}</option>)}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500">Work type</span>
            <select className="rounded border px-2 py-1 dark:bg-slate-900" value={workType ?? ""} onChange={(e) => setWorkType(e.target.value || null)}>
              <option value="">All work</option>
              {OVERVIEW_WORK_TYPES.map((w) => <option key={w} value={w}>{PRODUCTION_DEPARTMENT_LABELS[w as ProductionDepartment] ?? w}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500">Department</span>
            <select className="rounded border px-2 py-1 dark:bg-slate-900" value={departmentId ?? ""} onChange={(e) => setDepartmentId(e.target.value || null)}>
              <option value="">All departments</option>
              {deptOptions.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              <option value={UNKNOWN_DEPARTMENT}>Unknown</option>
            </select>
          </label>
          <Button variant="secondary" size="sm" onClick={() => setRefreshKey((n) => n + 1)} disabled={!request}>
            <RefreshCw size={14} /> Refresh
          </Button>
          <Button variant="secondary" size="sm" onClick={download} disabled={!data}>
            <Download size={14} /> Summary CSV
          </Button>
        </div>
        {problem ? <div className="text-sm text-rose-700 dark:text-rose-300" role="alert">{problem}</div> : null}
        <OverviewBodyView state={state} nameOf={nameOf} onRetry={() => setRefreshKey((n) => n + 1)} />
        {data && scopeKey ? (
          // F9: the SAME displayed request and pinned report version as the summary above
          <FrameTimingSection supabase={supabase} scopeKey={scopeKey} request={{ ...data.request, generationId: data.meta.generationId }} />
        ) : null}
      </CardBody>
    </Card>
  );
}

export function OverviewBodyView({ state, nameOf, onRetry }: { state: OverviewState; nameOf: (id: string) => string; onRetry: () => void }) {
  if (state.status === "idle") return null;
  if (state.status === "loading" && !state.data) return <div className="text-sm text-slate-500" role="status">Loading the production summary…</div>;
  if (state.status === "not_ready")
    return (
      <div className="text-sm text-slate-600 dark:text-slate-300" role="status">
        The published summary is not ready for this site yet ({state.error}). Counts appear here once a report version is published.{" "}
        <button type="button" className="underline" onClick={onRetry}>Check again</button>
      </div>
    );
  if (state.status === "error")
    return (
      <div className="text-sm text-rose-700 dark:text-rose-300" role="alert">
        Couldn't load the production summary: {state.error}{" "}
        <button type="button" className="underline" onClick={onRetry}>Retry</button>
      </div>
    );
  const d = state.data as OverviewResult;
  return <OverviewTables data={d} nameOf={nameOf} />;
}

function Pair({ label, p }: { label: string; p: CountPair }) {
  return (
    <div className="rounded-lg ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{fmt(p.items)} items · {p.orders.toLocaleString()} orders</div>
    </div>
  );
}

export function OverviewTables({ data, nameOf }: { data: OverviewResult; nameOf: (id: string) => string }) {
  const tz = SITE_TIME_ZONES[data.meta.site];
  const max = Math.max(1, ...data.daily.map((x) => x.normal.items ?? 0));
  const stale = data.meta.state !== "current";
  return (
    <div className="space-y-4">
      <div className={"text-xs " + (stale ? "text-amber-700 dark:text-amber-300" : "text-slate-500")} role="status">
        Production days {data.request.firstDate} → {data.request.lastDate} from 04:00 {tz}. Counts as of{" "}
        {new Date(data.meta.sourceCutoffUtc).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: tz })} (report version {data.meta.generationId.slice(0, 8)})
        {stale ? `: ${data.meta.state} — newer work is not included until the next publication.` : "."}
        {data.meta.visibility.kind === "limited" ? ` Showing ${data.meta.visibility.reason}.` : ""}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Pair label="Whole period" p={data.totals.normal} />
        <Pair label="CS / rework (separate)" p={data.totals.rework} />
      </div>
      <div className="text-[11px] text-slate-500">Orders are distinct orders for the whole period; an order worked on several days or by several people counts once in each total.</div>
      <section aria-label="Daily trend">
        <h3 className="text-sm font-semibold mb-1">Daily trend (items)</h3>
        <table className="w-full text-xs">
          <thead><tr className="text-left text-slate-500"><th className="py-1">Day</th><th>Items</th><th>Orders</th><th className="w-1/2"><span className="sr-only">Bar</span></th></tr></thead>
          <tbody>
            {data.daily.map((x) => (
              <tr key={x.productionDate} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1 tabular-nums">{x.productionDate}</td>
                <td className="tabular-nums">{fmt(x.normal.items)}</td>
                <td className="tabular-nums">{x.normal.orders}</td>
                <td><div className="h-2 rounded bg-blue-500" style={{ width: `${Math.round(((x.normal.items ?? max) / max) * 100)}%` }} aria-hidden="true" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <GroupTable title="People" rows={data.people.map((p) => ({ key: p.staffId, label: nameOf(p.staffId), normal: p.normal, rework: p.rework }))} empty="No counted work for this period." />
      <GroupTable title="Departments (as recorded at the time of the work)" rows={data.departments.map((x) => ({ key: x.departmentId ?? UNKNOWN_DEPARTMENT, label: departmentLabel(x), normal: x.normal, rework: x.rework }))} empty="No counted work for this period." />
    </div>
  );
}

function GroupTable({ title, rows, empty }: { title: string; rows: Array<{ key: string; label: string; normal: CountPair; rework: CountPair }>; empty: string }) {
  return (
    <section aria-label={title}>
      <h3 className="text-sm font-semibold mb-1">{title}</h3>
      {rows.length === 0 ? (
        <div className="text-xs text-slate-500">{empty}</div>
      ) : (
        <table className="w-full text-xs">
          <thead><tr className="text-left text-slate-500"><th className="py-1">Name</th><th>Items</th><th>Orders</th><th>CS/rework items</th><th>CS/rework orders</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1">{r.label}</td>
                <td className="tabular-nums">{fmt(r.normal.items)}</td>
                <td className="tabular-nums">{r.normal.orders}</td>
                <td className="tabular-nums">{fmt(r.rework.items)}</td>
                <td className="tabular-nums">{r.rework.orders}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
