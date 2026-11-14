import { useEffect, useMemo, useState } from "react";
import { LineChart, Line, ResponsiveContainer } from "recharts";
import { Trophy, Sparkles } from "lucide-react";
import { getSupabase, getBackendMode } from "@/lib/repository/supabase/client";
import { useAppStore } from "@/lib/state/appStore";
import { Card, CardBody } from "@/components/ui/Card";
import { CurrentlyClockedInCard } from "@/components/CurrentlyClockedInCard";
import { ProductionCountStatus } from "@/components/ProductionCountStatus";
import { useProductionEvidence } from "@/lib/hooks/useProductionSummary";
import { isReportSite, productionDateAt, productionRange } from "@/lib/domain/productionPeriods";
import { buildProductionWelcomeView, welcomeRange } from "@/lib/domain/productionWelcomeView";
import { snapshotCovers } from "@/lib/domain/productionCounts";
import {
  PRODUCTION_DEPARTMENT_LABELS,
  type ProductionDepartment,
} from "@/lib/domain";

/**
 * Welcome page - staff-safe landing replacing Dashboard for non-owners.
 *
 * Shows ONLY motivational / operational data: today's per-department
 * orders + items (site production day from 04:00), top worker and streak,
 * most improved staff (yesterday), team-total sparkline. Counts come from
 * the shared F1 evidence snapshot (productionWelcomeView.ts).
 *
 * No financial figures, no SKU stock counts, no customer data - safe to
 * leave open on a kiosk or any user role''s screen.
 */

const DEPARTMENTS: ProductionDepartment[] = ["a0_framed", "framed", "unframed", "dispatch"];

function greeting(date: Date): string {
  const h = date.getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/** Label for a YYYY-MM-DD production date, independent of the browser's timezone. */
function dateLabel(date: string, opts: Intl.DateTimeFormatOptions): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
}

const itemsText = (n: number | null) => (n === null ? "too many to show" : `${n} item${n === 1 ? "" : "s"}`);

export function Welcome() {
  // Construct the Supabase client only on the Supabase path (Dexie shows the message below).
  if (getBackendMode() !== "supabase") {
    return (
      <div className="p-6">
        <Card>
          <CardBody>
            <div className="text-sm text-slate-600 dark:text-slate-400">
              Welcome page is only available when signed in.
            </div>
          </CardBody>
        </Card>
      </div>
    );
  }
  return <SupabaseWelcome />;
}

function SupabaseWelcome() {
  const supabase = getSupabase();
  const location = useAppStore((s) => s.location);
  const site = isReportSite(location) ? location : null;

  // Greeting is cosmetic browser time; report dates are the site's production days.
  const [now] = useState(() => new Date());
  const [tick, setTick] = useState(0);
  const today = useMemo(
    () => (site ? productionDateAt(new Date(), site) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [site, tick],
  );
  const range = useMemo(() => (site && today ? welcomeRange(site, today) : null), [site, today]);

  // Roll over at the next site-local 04:00 (and re-check every few minutes in case the tab slept).
  useEffect(() => {
    if (!site || !today) return;
    const nextBoundary = Date.parse(productionRange(site, today, today).endUtcExclusive);
    const ms = Math.max(1_000, Math.min(nextBoundary - Date.now() + 1_000, 5 * 60_000));
    const t = setTimeout(() => setTick((n) => n + 1), ms);
    return () => clearTimeout(t);
  }, [site, today, tick]);

  // Returning to the tab re-derives the production date FIRST (tick), then the
  // refresh runs for that date's range: never a new cutoff on yesterday's range.
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, []);
  const evidence = useProductionEvidence({ client: supabase, site: location, range, refreshKey: tick });

  const [staffNames, setStaffNames] = useState<Map<string, string>>(new Map());
  const [namesError, setNamesError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setStaffNames(new Map());
    setNamesError(null);
    (async () => {
      const res = await supabase.from("staff_barcodes").select("user_id, display_name").eq("location", location);
      if (cancelled) return;
      if (res.error) {
        setNamesError(`Staff names unavailable: ${res.error.message}`);
        return;
      }
      const m = new Map<string, string>();
      for (const r of (res.data ?? []) as Array<{ user_id: string; display_name: string }>) m.set(r.user_id, r.display_name);
      setStaffNames(m);
    })();
    return () => { cancelled = true; };
  }, [supabase, location]);
  const nameOf = (id: string) => staffNames.get(id) ?? "User " + id.slice(0, 8);

  const view = useMemo(
    () =>
      evidence.prepared && evidence.snapshot && site && today && snapshotCovers(evidence.snapshot, range)
        ? buildProductionWelcomeView(evidence.prepared, site, evidence.snapshot.asOfUtc, today)
        : null,
    [evidence.prepared, evidence.snapshot, site, today, range],
  );
  const shownToday = view?.today ?? today;

  const dateStr = now.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const todayStr = shownToday ? dateLabel(shownToday, { weekday: "long", month: "long", day: "numeric" }) : "";

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl mx-auto">
      {/* ------------ Header ------------ */}
      <div className="space-y-1">
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          {greeting(now)}
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{dateStr}</p>
      </div>

      {namesError ? (
        <div className="text-xs text-amber-700 dark:text-amber-300">{namesError}</div>
      ) : null}

      <ProductionCountStatus
        state={evidence}
        range={site && shownToday ? productionRange(site, shownToday, shownToday) : null}
        coverage={view?.coverage ?? null}
        compact
      />

      {/* ------------ Today header ------------ */}
      <div>
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Today
          <span className="text-sm font-normal text-slate-500 ml-2">{todayStr}</span>
        </h2>
        {view && ((view.todayTotals.rework.items ?? 0) > 0 || view.todayTotals.rework.orders > 0) ? (
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Plus CS/rework today: {itemsText(view.todayTotals.rework.items)}, {view.todayTotals.rework.orders} case order{view.todayTotals.rework.orders === 1 ? "" : "s"} (counted separately).
          </div>
        ) : null}
      </div>

      {/* ------------ Per-department cards ------------ */}
      {view ? (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {DEPARTMENTS.map((dep) => {
          const d = view.perDepartment[dep];
          const lastWeekLabel = dateLabel(d.lastWeekDate, { weekday: "short", day: "numeric", month: "short" });
          return (
            <Card key={dep}>
              <CardBody>
                <div className="text-xs uppercase tracking-widest text-slate-500 dark:text-slate-400 font-semibold mb-2">
                  {PRODUCTION_DEPARTMENT_LABELS[dep]}
                </div>
                <div className="flex items-baseline gap-2 flex-wrap">
                  <div className="text-3xl font-semibold tabular-nums">{d.normal.orders}</div>
                  <div className="text-sm text-slate-500">orders today</div>
                  {d.vsLastWeek !== null && d.vsLastWeek !== 0 ? (
                    <span
                      className={
                        d.vsLastWeek > 0
                          ? "text-xs font-medium text-emerald-700 bg-emerald-50 ring-1 ring-emerald-200 rounded-full px-2 py-0.5 dark:bg-emerald-900/30 dark:text-emerald-300 dark:ring-emerald-800"
                          : "text-xs font-medium text-rose-700 bg-rose-50 ring-1 ring-rose-200 rounded-full px-2 py-0.5 dark:bg-rose-900/30 dark:text-rose-300 dark:ring-rose-800"
                      }
                      title={`Today so far vs the whole of ${lastWeekLabel}`}
                    >
                      {d.vsLastWeek > 0 ? "+" : ""}{d.vsLastWeek} vs {lastWeekLabel}
                    </span>
                  ) : null}
                </div>
                {dep !== "dispatch" ? (
                  <div className="text-sm text-slate-600 dark:text-slate-300 mt-1">
                    {itemsText(d.normal.items)}
                  </div>
                ) : null}
                {(d.rework.items ?? 0) > 0 || d.rework.orders > 0 ? (
                  <div className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">
                    CS/rework: {itemsText(d.rework.items)}, {d.rework.orders} order{d.rework.orders === 1 ? "" : "s"}
                  </div>
                ) : null}
                <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800">
                  {d.topWorker ? (
                    <div className="flex items-center gap-2 flex-wrap">
                      <Trophy size={16} className="text-amber-500" />
                      <span className="text-sm font-medium">
                        {nameOf(d.topWorker.staffId)}
                      </span>
                      <span className="text-xs text-slate-500">
                        {d.topWorker.orders} order{d.topWorker.orders === 1 ? "" : "s"} {"·"} {itemsText(d.topWorker.items)}
                      </span>
                      {d.streak > 1 ? (
                        <span
                          className="ml-auto text-xs font-medium text-amber-800 bg-amber-50 ring-1 ring-amber-200 rounded-full px-2 py-0.5 dark:bg-amber-900/30 dark:text-amber-200 dark:ring-amber-800"
                          title="Consecutive production days, ending today, as top worker here"
                        >
                          {d.streak}-day streak
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <div className="text-xs text-slate-400 italic">
                      No completed orders yet
                    </div>
                  )}
                </div>
              </CardBody>
            </Card>
          );
        })}
      </div>
      ) : null}

      {/* ------------ Most improved ------------ */}
      {view?.mostImproved ? (
        <Card>
          <CardBody className="flex items-center gap-3">
            <Sparkles size={20} className="text-amber-500 shrink-0" />
            <div>
              <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                Most improved: {nameOf(view.mostImproved.staffId)}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {view.mostImproved.yesterdayOrders} orders yesterday vs {view.mostImproved.avgBefore.toFixed(1)} average on their working days in the 7 days before (+{view.mostImproved.delta.toFixed(1)})
              </div>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* ------------ Team total + sparkline ------------ */}
      {view ? (
      <Card>
        <CardBody>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="text-xs uppercase tracking-widest text-slate-500 dark:text-slate-400 font-semibold">
                Team total yesterday
              </div>
              <div className="text-3xl font-semibold tabular-nums mt-1">
                {view.teamTotalYesterday}
                <span className="text-base font-normal text-slate-500 ml-2">orders</span>
              </div>
            </div>
            <div className="flex-1 min-w-[200px] max-w-md">
              <div className="text-[10px] uppercase tracking-widest text-slate-500 text-right mb-1">
                7 days to yesterday
              </div>
              <div style={{ width: "100%", height: 60 }}>
                <ResponsiveContainer>
                  <LineChart data={view.sparkline} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                    <Line type="monotone" dataKey="orders" stroke="#0f172a" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </CardBody>
      </Card>
      ) : null}

      <CurrentlyClockedInCard />
    </div>
  );
}