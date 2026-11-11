import { useEffect, useMemo, useState } from "react";
import { Package, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { getSupabase } from "@/lib/repository/supabase/client";
import { useAppStore } from "@/lib/state/appStore";
import { useDataset } from "@/lib/hooks/useDataset";
import {
  PACKAGE_TYPES,
  MAIL_TUBE_LARGE_PRODUCT_ID,
  MAIL_TUBE_SMALL_PRODUCT_ID,
  MAIL_TUBE_LABELS,
} from "@/lib/domain/skuRouting";
import { fetchAllRows } from "@/lib/repository/supabase/pageThrough";

interface LedgerRow {
  product_id: string;
  delta: number;
  ts: string;
}
interface DeptEvent {
  order_number: string;
  department: string;
  event_type: string;
  created_at: string;
}

type PeriodKey = "7d" | "30d" | "8w" | "12w";
interface PeriodDef {
  key: PeriodKey;
  label: string;
  days: number;
  bucketDays: number;
  bucketCount: number;
  bucketLabel: string;
  avgLabel: string;
  coverLabel: string;
}
const PERIODS: PeriodDef[] = [
  { key: "7d",  label: "Last 7 days",      days: 7,  bucketDays: 1, bucketCount: 7,  bucketLabel: "day",  avgLabel: "Avg / day", coverLabel: "Days cover" },
  { key: "30d", label: "Last month",       days: 30, bucketDays: 1, bucketCount: 30, bucketLabel: "day",  avgLabel: "Avg / day", coverLabel: "Days cover" },
  { key: "8w",  label: "Trailing 8 weeks", days: 56, bucketDays: 7, bucketCount: 8,  bucketLabel: "week", avgLabel: "Avg / wk",  coverLabel: "Weeks cover" },
  { key: "12w", label: "Last 12 weeks",    days: 84, bucketDays: 7, bucketCount: 12, bucketLabel: "week", avgLabel: "Avg / wk",  coverLabel: "Weeks cover" },
];

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function isoWeekMonday(d: Date): Date {
  const x = startOfDay(d);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  return x;
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function Sparkline({ values, width = 140, height = 28 }: { values: number[]; width?: number; height?: number }) {
  if (values.length === 0) return <span className="text-slate-400 text-xs">â€”</span>;
  const max = Math.max(...values, 1);
  const stepX = values.length > 1 ? width / (values.length - 1) : width;
  const pts = values.map((v, i) => {
    const x = i * stepX;
    const y = height - (v / max) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={pts}
        className="text-indigo-500 dark:text-indigo-400"
      />
      {values.map((v, i) => {
        const x = i * stepX;
        const y = height - (v / max) * (height - 4) - 2;
        return (
          <circle key={i} cx={x} cy={y} r="1.5" className="fill-indigo-500 dark:fill-indigo-400" />
        );
      })}
    </svg>
  );
}

export function PackageHistoryCard() {
  const supabase = getSupabase();
  const location = useAppStore((s) => s.location);
  const { data } = useDataset();
  const [periodKey, setPeriodKey] = useState<PeriodKey>("12w");
  const period = PERIODS.find((p) => p.key === periodKey) ?? PERIODS[3];

  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [events, setEvents] = useState<DeptEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const bucketStarts = useMemo(() => {
    const today = startOfDay(new Date());
    const arr: Date[] = [];
    if (period.bucketDays === 7) {
      const thisMonday = isoWeekMonday(today);
      for (let i = period.bucketCount - 1; i >= 0; i--) {
        const d = new Date(thisMonday);
        d.setDate(d.getDate() - i * 7);
        arr.push(d);
      }
    } else {
      for (let i = period.bucketCount - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        arr.push(d);
      }
    }
    return arr;
  }, [period]);

  const fromDate = useMemo(() => bucketStarts[0], [bucketStarts]);

  type PackageSlot = {
    key: string;
    label: string;
    kind: "box" | "tube";
    product: { id: string; supplier: string; current_on_hand: number } | null;
  };
  const packageSlots = useMemo<PackageSlot[]>(() => {
    if (!data) return [];
    const byCode = new Map(data.products.map((p) => [p.code, p]));
    const byId = new Map(data.products.map((p) => [p.id, p]));
    const slots: PackageSlot[] = [];
    for (const pt of PACKAGE_TYPES) {
      const product = byCode.get(pt.key) ?? null;
      slots.push({
        key: pt.key,
        label: pt.label,
        kind: "box",
        product: product
          ? { id: product.id, supplier: product.supplier ?? "", current_on_hand: product.current_on_hand ?? 0 }
          : null,
      });
    }
    for (const tubeId of [MAIL_TUBE_LARGE_PRODUCT_ID, MAIL_TUBE_SMALL_PRODUCT_ID]) {
      const product = byId.get(tubeId) ?? null;
      slots.push({
        key: tubeId,
        label: MAIL_TUBE_LABELS[tubeId] ?? tubeId,
        kind: "tube",
        product: product
          ? { id: product.id, supplier: product.supplier ?? "", current_on_hand: product.current_on_hand ?? 0 }
          : null,
      });
    }
    return slots;
  }, [data]);

  const packageProductIds = useMemo(() => {
    const s = new Set<string>();
    for (const slot of packageSlots) if (slot.product) s.add(slot.product.id);
    return s;
  }, [packageSlots]);

  useEffect(() => {
    if (!data) {
      setRows([]);
      setEvents([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const fromIso = fromDate.toISOString();
        const idsArray = Array.from(packageProductIds);
        const ledgerPromise = idsArray.length > 0
          ? fetchAllRows<LedgerRow>((from, to) =>
              supabase
                .from("ledger")
                .select("product_id, delta, ts")
                .eq("location", location)
                .in("product_id", idsArray)
                .lt("delta", 0)
                .gte("ts", fromIso)
                .order("ts", { ascending: true })
                .range(from, to),
            )
          : Promise.resolve([]);
        const eventsPromise = fetchAllRows<DeptEvent>((from, to) =>
          supabase
            .from("production_events")
            .select("order_number, department, event_type, created_at")
            .eq("location", location)
            .in("event_type", ["dispatched", "completed"])
            .gte("created_at", fromIso)
            .order("created_at", { ascending: true })
            .range(from, to),
        );
        const [ledgerResults, eventResults] = await Promise.all([ledgerPromise, eventsPromise]);
        if (cancelled) return;
        setRows(ledgerResults);
        setEvents(eventResults);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [supabase, location, packageProductIds, data, fromDate]);

  // Framed orders = distinct order_number from either:
  //   - dispatched events (dispatch station, for non-A0 orders)
  //   - completed events at a0_framed dept (A0 orders end there because
  //     A0 packages are scanned at the a0_framed station directly)
  // Set union means mixed orders touching both stations count once.
  // Unframed orders = distinct order_number from completed events at
  // the unframed dept (tubes are auto-assigned there).
  const denominators = useMemo(() => {
    const framedOrders = new Set<string>();
    const unframedOrders = new Set<string>();
    for (const ev of events) {
      if (ev.event_type === "dispatched") {
        framedOrders.add(ev.order_number);
      } else if (ev.event_type === "completed" && ev.department === "a0_framed") {
        framedOrders.add(ev.order_number);
      } else if (ev.event_type === "completed" && ev.department === "unframed") {
        unframedOrders.add(ev.order_number);
      }
    }
    return { framed: framedOrders.size, unframed: unframedOrders.size };
  }, [events]);

  const bucketKeyForTs = (ts: string): string => {
    const d = new Date(ts);
    if (period.bucketDays === 7) return isoDate(isoWeekMonday(d));
    return isoDate(startOfDay(d));
  };

  const summary = useMemo(() => {
    const bucketKeys = bucketStarts.map(isoDate);
    const perProduct = new Map<string, number[]>();
    for (const slot of packageSlots) {
      if (slot.product) perProduct.set(slot.product.id, new Array(period.bucketCount).fill(0));
    }
    for (const r of rows) {
      const key = bucketKeyForTs(r.ts);
      const idx = bucketKeys.indexOf(key);
      if (idx < 0) continue;
      const arr = perProduct.get(r.product_id);
      if (arr) arr[idx] += Math.abs(r.delta);
    }
    return packageSlots.map((slot) => {
      const buckets = slot.product ? (perProduct.get(slot.product.id) ?? new Array(period.bucketCount).fill(0)) : new Array(period.bucketCount).fill(0);
      const totalUsed = buckets.reduce((a, b) => a + b, 0);
      const perBucketAvg = totalUsed / period.bucketCount;
      const onHand = slot.product?.current_on_hand ?? 0;
      const cover = perBucketAvg > 0 ? onHand / perBucketAvg : null;
      const denom = slot.kind === "tube" ? denominators.unframed : denominators.framed;
      const ratio = denom > 0 ? totalUsed / denom : null;
      return {
        slotKey: slot.key,
        label: slot.label,
        kind: slot.kind,
        supplier: slot.product?.supplier ?? "",
        catalogued: slot.product != null,
        onHand,
        buckets,
        perBucketAvg,
        cover,
        totalUsed,
        ratio,
        denom,
      };
    }).sort((a, b) => (b.totalUsed - a.totalUsed) || a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, packageSlots, bucketStarts, denominators, period]);

  return (
    <Card>
      <CardHeader>
        <div className="flex-1 min-w-0">
          <CardTitle className="inline-flex items-center gap-2">
            <Package size={16} /> Package usage history
          </CardTitle>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {period.label} Â· {denominators.framed.toLocaleString()} framed orders (A0 + dispatch) Â· {denominators.unframed.toLocaleString()} unframed completed
          </div>
        </div>
        <div className="inline-flex rounded-md ring-1 ring-slate-200 dark:ring-slate-700 overflow-hidden text-xs">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPeriodKey(p.key)}
              className={"px-2.5 h-8 " + (p.key === periodKey ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "bg-white hover:bg-slate-100 dark:bg-slate-900 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300")}
              title={`Show ${p.label.toLowerCase()}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardBody className="p-0">
        {loading ? (
          <div className="p-6 text-sm text-slate-500">Loadingâ€¦</div>
        ) : error ? (
          <div className="p-6 text-sm text-red-600 dark:text-red-400">{error}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="text-left px-4 py-2 font-semibold">Package</th>
                  <th className="text-left px-3 py-2 font-semibold">{period.label}</th>
                  <th className="text-right px-3 py-2 font-semibold">On hand</th>
                  <th className="text-right px-3 py-2 font-semibold" title={`Average packages used per ${period.bucketLabel} over the ${period.label.toLowerCase()}`}>{period.avgLabel}</th>
                  <th className="text-right px-3 py-2 font-semibold" title="Boxes: usage divided by framed orders (dispatch station + A0 framed station). Tubes: usage divided by unframed orders completed at the unframed station.">Per order</th>
                  <th className="text-right px-3 py-2 font-semibold" title="On hand divided by average usage per bucket - how long stock lasts at current rate">{period.coverLabel}</th>
                  <th className="text-right px-4 py-2 font-semibold">Reorder</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {summary.map((r) => {
                  const critThreshold = period.bucketDays === 7 ? 4 : 14;
                  const warnThreshold = period.bucketDays === 7 ? 8 : 28;
                  const critical = r.cover != null && r.cover < critThreshold;
                  const warn = r.cover != null && r.cover >= critThreshold && r.cover < warnThreshold;
                  const denomLabel = r.kind === "tube" ? "unframed order" : "framed order";
                  return (
                    <tr key={r.slotKey} className={critical ? "bg-red-50/40 dark:bg-red-900/10" : warn ? "bg-amber-50/40 dark:bg-amber-900/10" : ""}>
                      <td className="px-4 py-2">
                        <div className="font-medium flex items-center gap-1.5">
                          <span>{r.label}</span>
                          <span className={"text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded " + (r.kind === "tube" ? "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300" : "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200")}>
                            {r.kind}
                          </span>
                        </div>
                        {r.catalogued ? (
                          r.supplier ? <div className="text-[11px] text-slate-500">{r.supplier}</div> : null
                        ) : (
                          <div className="text-[11px] text-amber-700 dark:text-amber-400 italic">not in catalogue â€” add on SKUs page as code "{r.slotKey}"</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Sparkline values={r.buckets} />
                        <div className="text-[10px] text-slate-500 mt-0.5 tabular-nums">
                          {r.totalUsed.toLocaleString()} used
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.catalogued ? r.onHand.toLocaleString() : "â€”"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.catalogued ? r.perBucketAvg.toFixed(1) : "â€”"}</td>
                      <td className="px-3 py-2 text-right tabular-nums" title={r.ratio == null ? `No ${denomLabel}s in window` : `${(r.ratio * 100).toFixed(0)}% of ${denomLabel}s used this`}>
                        {r.ratio == null ? "â€”" : r.ratio.toFixed(2)}
                      </td>
                      <td className={"px-3 py-2 text-right tabular-nums " + (critical ? "text-red-700 dark:text-red-300 font-semibold" : warn ? "text-amber-700 dark:text-amber-300" : "")}>
                        {r.cover == null ? "â€”" : r.cover.toFixed(1) + (period.bucketDays === 7 ? "w" : "d")}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {r.supplier ? (
                          <Link
                            to={`/orders?supplier=${encodeURIComponent(r.supplier)}`}
                            className="inline-flex items-center gap-1 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                            title={`Open Order Builder for ${r.supplier}`}
                          >
                            Build PO <ExternalLink size={11} />
                          </Link>
                        ) : (
                          <span className="text-xs text-slate-400 italic">â€”</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="px-4 py-2 text-[11px] text-slate-500 border-t border-slate-200 dark:border-slate-800">
              Boxes ratio = usage Ã· framed orders (dispatch + A0 framed). Tubes ratio = usage Ã· unframed orders completed. Multiply by expected order volume to size next PO.
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}