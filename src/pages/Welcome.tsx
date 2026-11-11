import { useEffect, useMemo, useState } from "react";
import { LineChart, Line, ResponsiveContainer } from "recharts";
import { Trophy, Sparkles } from "lucide-react";
import { getSupabase, getBackendMode } from "@/lib/repository/supabase/client";
import { fetchAllRows } from "@/lib/repository/supabase/pageThrough";
import { isKpiEligibleSku, kpiUnitMultiplier } from "@/lib/domain/skuRouting";
import { useAppStore } from "@/lib/state/appStore";
import { Card, CardBody } from "@/components/ui/Card";
import { CurrentlyClockedInCard } from "@/components/CurrentlyClockedInCard";
import {
  PRODUCTION_DEPARTMENT_LABELS,
  type ProductionDepartment,
} from "@/lib/domain";

/**
 * Welcome page - staff-safe landing replacing Dashboard for non-owners.
 *
 * Shows ONLY motivational / operational data: yesterday''s per-department
 * orders + items, top worker per department, streak callout, today-so-far
 * counters, most improved staff, team-total sparkline.
 *
 * No financial figures, no SKU stock counts, no customer data - safe to
 * leave open on a kiosk or any user role''s screen.
 */

interface RawEvent {
  staff_id: string;
  department: ProductionDepartment;
  order_number: string;
  line_sku: string | null;
  line_quantity: number | null;
  event_type: "started" | "completed" | "cancelled" | "dispatched" | "line_verified";
  created_at: string;
}

const DEPARTMENTS: ProductionDepartment[] = ["a0_framed", "framed", "unframed", "dispatch"];

function startOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function isoLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function greeting(date: Date): string {
  const h = date.getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export function Welcome() {
  const supabase = getSupabase();
  const location = useAppStore((s) => s.location);
  const isSupabase = getBackendMode() === "supabase";

  // Lock the "now" snapshot to the initial render so memos stay stable.
  const [now] = useState(() => new Date());
  const today = startOfLocalDay(now);
  const yesterday = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return d;
  }, [today]);
  const sameDayLastWeek = useMemo(() => {
    const d = new Date(yesterday);
    d.setDate(d.getDate() - 7);
    return d;
  }, [yesterday]);
  const eightDaysAgo = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - 9);
    return d;
  }, [today]);

  const [events, setEvents] = useState<RawEvent[]>([]);
  const [staffNames, setStaffNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSupabase) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        // Paginated fetch - bypasses PostgRESTs 1000-row cap so the Today /
        // last-7-days tiles + sparkline scale to any volume.
        const [evRows, staffRes] = await Promise.all([
          fetchAllRows<RawEvent>((from, to) =>
            supabase
              .from("production_events")
              .select("staff_id, department, order_number, line_sku, line_quantity, event_type, created_at")
              .eq("location", location)
              .gte("created_at", eightDaysAgo.toISOString())
              .in("event_type", ["completed", "dispatched", "line_verified"])
              .order("created_at", { ascending: true })
              .range(from, to),
          ),
          supabase
            .from("staff_barcodes")
            .select("user_id, display_name")
            .eq("location", location),
        ]);
        if (cancelled) return;
        if (staffRes.error) throw staffRes.error;

        setEvents(evRows);
        const m = new Map<string, string>();
        for (const r of (staffRes.data ?? []) as Array<{ user_id: string; display_name: string }>) {
          m.set(r.user_id, r.display_name);
        }
        setStaffNames(m);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [supabase, location, isSupabase, eightDaysAgo]);

  const summary = useMemo(() => {
    const yKey = isoLocalDate(yesterday);
    const swKey = isoLocalDate(sameDayLastWeek);

    // Bucket events by local day.
    const byDate = new Map<string, RawEvent[]>();
    for (const ev of events) {
      const k = isoLocalDate(new Date(ev.created_at));
      const arr = byDate.get(k) ?? [];
      arr.push(ev);
      byDate.set(k, arr);
    }

    // Today (since 4am local).
    const todayReset = new Date();
    todayReset.setHours(4, 0, 0, 0);
    if (now < todayReset) todayReset.setDate(todayReset.getDate() - 1);
    let todayItems = 0;
    const todayOrderSet = new Set<string>();
    for (const ev of events) {
      const t = new Date(ev.created_at);
      if (t < todayReset) continue;
      // Orders count from completed/dispatched (the order-lifecycle events).
      if (ev.event_type === "completed" || ev.event_type === "dispatched") {
        todayOrderSet.add(ev.order_number);
      }
      // Items count from line_verified events only, filtered by KPI eligibility.
      // Hooks, gift cards, free prints, legacy SKUs all return false from
      // isKpiEligibleSku and contribute 0. Sets multiply by setCount.
      if (ev.event_type === "line_verified" && isKpiEligibleSku(ev.line_sku)) {
        todayItems += (ev.line_quantity ?? 1) * kpiUnitMultiplier(ev.line_sku);
      }
    }
    const todayOrders = todayOrderSet.size;
    const todayEvents = events.filter((ev) => new Date(ev.created_at) >= todayReset);

    const yEvents = byDate.get(yKey) ?? [];
    const swEvents = byDate.get(swKey) ?? [];

    type DepSummary = {
      orders: number;
      items: number;
      topWorker: { name: string; orders: number; items: number; staffId: string } | null;
      vsLastWeek: number | null;
      streak: number;
    };
    const perDep: Record<ProductionDepartment, DepSummary> = {
      a0_framed: { orders: 0, items: 0, topWorker: null, vsLastWeek: null, streak: 0 },
      framed:    { orders: 0, items: 0, topWorker: null, vsLastWeek: null, streak: 0 },
      unframed:  { orders: 0, items: 0, topWorker: null, vsLastWeek: null, streak: 0 },
      dispatch:  { orders: 0, items: 0, topWorker: null, vsLastWeek: null, streak: 0 },
    };

    for (const dep of DEPARTMENTS) {
      const depYE = todayEvents.filter((e) => e.department === dep);
      const orderSet = new Set<string>();
      let items = 0;
      const perStaff = new Map<string, Set<string>>();
      const perStaffItems = new Map<string, number>();
      for (const e of depYE) {
        // Orders + top worker ranking from completed/dispatched.
        if (e.event_type === "completed" || e.event_type === "dispatched") {
          orderSet.add(e.order_number);
          const s = perStaff.get(e.staff_id) ?? new Set<string>();
          s.add(e.order_number);
          perStaff.set(e.staff_id, s);
        }
        // Items + per-staff items from KPI-eligible line_verified events.
        if (e.event_type === "line_verified" && isKpiEligibleSku(e.line_sku)) {
          const units = (e.line_quantity ?? 1) * kpiUnitMultiplier(e.line_sku);
          items += units;
          perStaffItems.set(e.staff_id, (perStaffItems.get(e.staff_id) ?? 0) + units);
        }
      }
      let topStaff: string | null = null;
      let topCount = 0;
      for (const [sid, set] of perStaff) {
        if (set.size > topCount) {
          topCount = set.size;
          topStaff = sid;
        }
      }

      // Same day last week (for delta).
      const depSW = swEvents.filter((e) => e.department === dep);
      const swOrderCount = new Set(
        depSW.filter((e) => e.event_type === "completed" || e.event_type === "dispatched")
             .map((e) => e.order_number),
      ).size;

      // Streak: count back from yesterday how many consecutive days the
      // same person was top in this dep.
      let streak = 0;
      if (topStaff) {
        streak = 1; // yesterday counts
        for (let i = 1; i <= 7; i++) {
          const d = new Date(yesterday);
          d.setDate(d.getDate() - i);
          const dKey = isoLocalDate(d);
          const dEvents = (byDate.get(dKey) ?? []).filter((e) => e.department === dep && (e.event_type === "completed" || e.event_type === "dispatched"));
          if (dEvents.length === 0) break;
          const dPerStaff = new Map<string, Set<string>>();
          for (const e of dEvents) {
            const s = dPerStaff.get(e.staff_id) ?? new Set<string>();
            s.add(e.order_number);
            dPerStaff.set(e.staff_id, s);
          }
          let dTop: string | null = null;
          let dCount = 0;
          for (const [sid, set] of dPerStaff) {
            if (set.size > dCount) {
              dCount = set.size;
              dTop = sid;
            }
          }
          if (dTop === topStaff && dCount > 0) {
            streak++;
          } else {
            break;
          }
        }
      }

      perDep[dep] = {
        orders: orderSet.size,
        items,
        topWorker: topStaff
          ? {
              staffId: topStaff,
              name: staffNames.get(topStaff) ?? "User " + topStaff.slice(0, 8),
              orders: topCount,
              items: perStaffItems.get(topStaff) ?? 0,
            }
          : null,
        vsLastWeek: depSW.length > 0 ? orderSet.size - swOrderCount : null,
        streak,
      };
    }

    // 7-day team-total sparkline (last 7 days ending yesterday).
    const sparkline: Array<{ day: string; orders: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(yesterday);
      d.setDate(d.getDate() - i);
      const k = isoLocalDate(d);
      const dayEvents = byDate.get(k) ?? [];
      const oset = new Set(dayEvents.map((e) => e.order_number));
      sparkline.push({ day: k, orders: oset.size });
    }

    const teamTotalYesterday = new Set(yEvents.map((e) => e.order_number)).size;

    // Most improved: largest positive delta between yesterday and the
    // 7-day average of the days before.
    let mostImproved: { name: string; yesterdayOrders: number; avgBefore: number; delta: number } | null = null;
    const yPerStaff = new Map<string, Set<string>>();
    for (const e of yEvents) {
      const s = yPerStaff.get(e.staff_id) ?? new Set<string>();
      s.add(e.order_number);
      yPerStaff.set(e.staff_id, s);
    }
    for (const [sid, yset] of yPerStaff) {
      const yCount = yset.size;
      let totalBefore = 0;
      let daysCounted = 0;
      for (let i = 1; i <= 7; i++) {
        const d = new Date(yesterday);
        d.setDate(d.getDate() - i);
        const k = isoLocalDate(d);
        const dev = (byDate.get(k) ?? []).filter((e) => e.staff_id === sid);
        const oset = new Set(dev.map((e) => e.order_number));
        if (oset.size > 0) {
          totalBefore += oset.size;
          daysCounted++;
        }
      }
      if (daysCounted === 0) continue;
      const avgBefore = totalBefore / daysCounted;
      const delta = yCount - avgBefore;
      if (delta > 0 && (!mostImproved || delta > mostImproved.delta)) {
        mostImproved = {
          name: staffNames.get(sid) ?? "User " + sid.slice(0, 8),
          yesterdayOrders: yCount,
          avgBefore,
          delta,
        };
      }
    }

    return { todayOrders, todayItems, perDep, sparkline, teamTotalYesterday, mostImproved };
  }, [events, staffNames, now, today, yesterday, sameDayLastWeek]);

  if (!isSupabase) {
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

  const dateStr = now.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const todayStr = today.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const yesterdayStr = yesterday.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl mx-auto">
      {/* ------------ Header ------------ */}
      <div className="space-y-1">
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          {greeting(now)}
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{dateStr}</p>
      </div>

      {error ? (
        <div className="text-sm text-rose-700 bg-rose-50 ring-1 ring-rose-200 rounded px-3 py-2 dark:bg-rose-900/20 dark:text-rose-300 dark:ring-rose-800">
          {error}
        </div>
      ) : null}

      {/* ------------ Yesterday header ------------ */}
      <div>
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Today
          <span className="text-sm font-normal text-slate-500 ml-2">{todayStr}</span>
        </h2>
      </div>

      {/* ------------ Per-department cards ------------ */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {DEPARTMENTS.map((dep) => {
          const d = summary.perDep[dep];
          return (
            <Card key={dep}>
              <CardBody>
                <div className="text-xs uppercase tracking-widest text-slate-500 dark:text-slate-400 font-semibold mb-2">
                  {PRODUCTION_DEPARTMENT_LABELS[dep]}
                </div>
                <div className="flex items-baseline gap-2 flex-wrap">
                  <div className="text-3xl font-semibold tabular-nums">{d.orders}</div>
                  <div className="text-sm text-slate-500">orders</div>
                  {d.vsLastWeek !== null && d.vsLastWeek !== 0 ? (
                    <span
                      className={
                        d.vsLastWeek > 0
                          ? "text-xs font-medium text-emerald-700 bg-emerald-50 ring-1 ring-emerald-200 rounded-full px-2 py-0.5 dark:bg-emerald-900/30 dark:text-emerald-300 dark:ring-emerald-800"
                          : "text-xs font-medium text-rose-700 bg-rose-50 ring-1 ring-rose-200 rounded-full px-2 py-0.5 dark:bg-rose-900/30 dark:text-rose-300 dark:ring-rose-800"
                      }
                      title="vs same day last week"
                    >
                      {d.vsLastWeek > 0 ? "+" : ""}{d.vsLastWeek} vs last week
                    </span>
                  ) : null}
                </div>
                {dep !== "dispatch" ? (
                  <div className="text-sm text-slate-600 dark:text-slate-300 mt-1">
                    {d.items} items
                  </div>
                ) : null}
                <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800">
                  {d.topWorker ? (
                    <div className="flex items-center gap-2 flex-wrap">
                      <Trophy size={16} className="text-amber-500" />
                      <span className="text-sm font-medium">
                        {d.topWorker.name}
                      </span>
                      <span className="text-xs text-slate-500">
                        {d.topWorker.orders} order{d.topWorker.orders === 1 ? "" : "s"} {"Â·"} {d.topWorker.items} item{d.topWorker.items === 1 ? "" : "s"}
                      </span>
                      {d.streak > 1 ? (
                        <span className="ml-auto text-xs font-medium text-amber-800 bg-amber-50 ring-1 ring-amber-200 rounded-full px-2 py-0.5 dark:bg-amber-900/30 dark:text-amber-200 dark:ring-amber-800">
                          {d.streak}-day streak
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <div className="text-xs text-slate-400 italic">
                      No activity yet
                    </div>
                  )}
                </div>
              </CardBody>
            </Card>
          );
        })}
      </div>

      {/* ------------ Most improved ------------ */}
      {summary.mostImproved ? (
        <Card>
          <CardBody className="flex items-center gap-3">
            <Sparkles size={20} className="text-amber-500 shrink-0" />
            <div>
              <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                Most improved: {summary.mostImproved.name}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {summary.mostImproved.yesterdayOrders} orders yesterday vs {summary.mostImproved.avgBefore.toFixed(1)} 7-day avg (+{summary.mostImproved.delta.toFixed(1)})
              </div>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* ------------ Team total + sparkline ------------ */}
      <Card>
        <CardBody>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="text-xs uppercase tracking-widest text-slate-500 dark:text-slate-400 font-semibold">
                Team total yesterday
              </div>
              <div className="text-3xl font-semibold tabular-nums mt-1">
                {summary.teamTotalYesterday}
                <span className="text-base font-normal text-slate-500 ml-2">orders</span>
              </div>
            </div>
            <div className="flex-1 min-w-[200px] max-w-md">
              <div className="text-[10px] uppercase tracking-widest text-slate-500 text-right mb-1">
                Last 7 days
              </div>
              <div style={{ width: "100%", height: 60 }}>
                <ResponsiveContainer>
                  <LineChart data={summary.sparkline} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                    <Line type="monotone" dataKey="orders" stroke="#0f172a" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </CardBody>
      </Card>

      {loading ? (
        <div className="text-xs text-slate-500 italic">Loading todays stats...</div>
      ) : null}

      <CurrentlyClockedInCard />
    </div>
  );
}