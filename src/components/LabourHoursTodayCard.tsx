import { useEffect, useState } from "react";
import { Clock4 } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { getSupabase, getBackendMode } from "@/lib/repository/supabase/client";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import { useAppStore } from "@/lib/state/appStore";
import { computeShifts, formatShiftDuration, effectiveHourlyRate, type ShiftEvent } from "@/lib/domain/shifts";

/**
 * Owner-only Dashboard widget: today's labour hours per worker.
 *
 * Refreshes every 60s. Each row shows current status (IN / OUT),
 * accumulated billable hours today, and today's cost at the staff
 * member's hourly rate. The IN/OUT status comes from the latest clock
 * event today.
 *
 * Hidden for non-owners (this is cost data) and in Dexie mode.
 */
export function LabourHoursTodayCard() {
  const auth = useAuthOptional();
  const isOwner = auth?.profile?.role === "owner";
  if (!isOwner) return null;
  if (getBackendMode() !== "supabase") return null;
  return <LabourHoursTodayCardInner />;
}

interface WorkerRow {
  staff_id: string;
  display_name: string;
  is_signed_in: boolean;
  billable_seconds: number;
  cost: number;
  orders: number;
  cost_per_order: number | null;
}

function LabourHoursTodayCardInner() {
  const supabase = getSupabase();
  const location = useAppStore((s) => s.location);
  const [rows, setRows] = useState<WorkerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchOnce = async () => {
      try {
        // Local day boundaries.
        const now = new Date();
        const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);

        const [evRes, barcodesRes, ratesRes] = await Promise.all([
          supabase
            .from("production_events")
            .select("staff_id, event_type, order_number, created_at")
            .eq("location", location)
            .in("event_type", ["clock_in", "clock_out", "started", "completed", "dispatched"])
            .gte("created_at", dayStart.toISOString())
            .lt("created_at", dayEnd.toISOString())
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
        if (cancelled) return;
        if (evRes.error) { setErr(evRes.error.message); setLoading(false); return; }
        if (barcodesRes.error) { setErr(barcodesRes.error.message); setLoading(false); return; }
        if (ratesRes.error) { setErr(ratesRes.error.message); setLoading(false); return; }

        const events = (evRes.data ?? []) as ShiftEvent[];
        const nameByUser = new Map<string, string>();
        for (const r of (barcodesRes.data ?? [])) {
          if (!nameByUser.has(r.user_id)) nameByUser.set(r.user_id, r.display_name);
        }
        const rateByUser = new Map<string, number>();
        for (const r of (ratesRes.data ?? [])) {
          if (!rateByUser.has(r.user_id)) rateByUser.set(r.user_id, Number(r.hourly_rate));
        }

        // Determine current signed-in status from the latest clock event
        // per staff today.
        const latestClockByStaff = new Map<string, string>();
        for (const e of events) {
          if (e.event_type === "clock_in" || e.event_type === "clock_out") {
            latestClockByStaff.set(e.staff_id, e.event_type);
          }
        }

        // Compute today's shifts via the shared helper.
        const shifts = computeShifts(events, { gapThresholdMin: 30, staleHours: 2, now });

        // Aggregate billable seconds per staff.
        const byStaff = new Map<string, number>();
        for (const s of shifts) {
          byStaff.set(s.staff_id, (byStaff.get(s.staff_id) ?? 0) + s.billable_seconds);
        }

        // Count completed/dispatched events per staff (today's output).
        // Each completion event - whether at framing, unframed, A0, or
        // dispatch - counts as one "order" for the worker who logged it.
        // Different departments touching the same order both get credit.
        const ordersByStaff = new Map<string, number>();
        for (const e of events) {
          if (e.event_type === "completed" || e.event_type === "dispatched") {
            ordersByStaff.set(e.staff_id, (ordersByStaff.get(e.staff_id) ?? 0) + 1);
          }
        }

        const out: WorkerRow[] = [];
        for (const [staff_id, billable_seconds] of byStaff) {
          const rate = effectiveHourlyRate(rateByUser.get(staff_id));
          const cost = (billable_seconds / 3600) * rate;
          const orders = ordersByStaff.get(staff_id) ?? 0;
          out.push({
            staff_id,
            display_name: nameByUser.get(staff_id) ?? staff_id,
            is_signed_in: latestClockByStaff.get(staff_id) === "clock_in",
            billable_seconds,
            cost,
            orders,
            cost_per_order: orders > 0 ? cost / orders : null,
          });
        }
        // Sort: currently-in first, then by billable hours descending.
        out.sort((a, b) => {
          if (a.is_signed_in !== b.is_signed_in) return a.is_signed_in ? -1 : 1;
          return b.billable_seconds - a.billable_seconds;
        });
        setRows(out);
        setErr(null);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    };

    void fetchOnce();
    const id = setInterval(() => { void fetchOnce(); }, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [supabase, location]);

  // Re-render every minute so billable_seconds shown for signed-in workers
  // is fresh without a fetch round-trip.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const totalBillable = rows.reduce((s, r) => s + r.billable_seconds, 0);
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const totalOrders = rows.reduce((s, r) => s + r.orders, 0);
  const inCount = rows.filter((r) => r.is_signed_in).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2">
          <Clock4 size={16} /> Today's labour hours
        </CardTitle>
        <span className="text-xs text-slate-500">
          Refreshes every 60s. Cost = billable hours x hourly rate (set on the Team page).
        </span>
      </CardHeader>
      <CardBody className="p-0">
        {err ? (
          <div className="px-4 py-3 text-xs text-red-600 dark:text-red-400">Couldn't load: {err}</div>
        ) : loading ? (
          <div className="px-4 py-3 text-sm text-slate-500">Checking...</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-3 text-sm text-slate-500">Nobody clocked in today yet.</div>
        ) : (
          <div>
            <div className="overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left font-medium px-4 py-2">Name</th>
                    <th className="text-left font-medium px-2 py-2 w-px">Status</th>
                    <th className="text-right font-medium px-2 py-2">Billable</th>
                    <th className="text-right font-medium px-2 py-2">Orders</th>
                    <th className="text-right font-medium px-2 py-2">$/Order</th>
                    <th className="text-right font-medium px-4 py-2">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rows.map((r) => (
                    <tr key={r.staff_id}>
                      <td className="px-4 py-2 font-medium text-slate-900 dark:text-slate-100">{r.display_name}</td>
                      <td className="px-2 py-2">
                        {r.is_signed_in ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] uppercase tracking-wide ring-1 ring-emerald-400 bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" /> In
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] uppercase tracking-wide ring-1 ring-slate-300 text-slate-500">
                            Out
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatShiftDuration(r.billable_seconds)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{r.orders}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {r.cost_per_order !== null
                          ? `$${r.cost_per_order.toFixed(2)}`
                          : <span className="text-slate-400">{"n/a"}</span>}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">${r.cost.toFixed(2)}</td>
                    </tr>
                  ))}
                  <tr className="bg-slate-50 dark:bg-slate-900/60 font-semibold">
                    <td className="px-4 py-2">TOTAL</td>
                    <td className="px-2 py-2 text-xs text-slate-500 whitespace-nowrap">
                      {inCount} on floor
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatShiftDuration(totalBillable)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{totalOrders}</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {totalOrders > 0
                        ? `$${(totalCost / totalOrders).toFixed(2)}`
                        : <span className="text-slate-400">{"n/a"}</span>}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">${totalCost.toFixed(2)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}