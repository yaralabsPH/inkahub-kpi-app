import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { Section } from "@/components/ui/Section";
import { Segmented } from "@/components/ui/Segmented";
import { Callout } from "@/components/ui/Callout";
import { Tag } from "@/components/ui/Tag";
import { nTable, nTableWrap, nTd, nTdNum, nTh, nThNum } from "@/components/ui/nStyles";
import { cn } from "@/lib/utils/cn";
import { Button } from "@/components/ui/Button";
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
import { usePackagingCatalogue } from "@/lib/hooks/usePackagingCatalogue";
import { PACKAGE_USAGE_ROWS_FILTER, usageOf } from "@/lib/domain/packaging/usage";

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
  /** Label on the segmented control. */
  short: string;
  days: number;
  bucketDays: number;
  bucketCount: number;
  bucketLabel: string;
  avgLabel: string;
  coverLabel: string;
}
const PERIODS: PeriodDef[] = [
  { key: "7d",  label: "Last 7 days",      short: "7 days", days: 7,  bucketDays: 1, bucketCount: 7,  bucketLabel: "day",  avgLabel: "Avg / day", coverLabel: "Days cover" },
  { key: "30d", label: "Last month",       short: "Last month", days: 30, bucketDays: 1, bucketCount: 30, bucketLabel: "day",  avgLabel: "Avg / day", coverLabel: "Days cover" },
  { key: "8w",  label: "Trailing 8 weeks", short: "8 weeks", days: 56, bucketDays: 7, bucketCount: 8,  bucketLabel: "week", avgLabel: "Avg / wk",  coverLabel: "Weeks cover" },
  { key: "12w", label: "Last 12 weeks",    short: "12 weeks", days: 84, bucketDays: 7, bucketCount: 12, bucketLabel: "week", avgLabel: "Avg / wk",  coverLabel: "Weeks cover" },
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

/**
 * Stock-cover colour bands, in buckets of the active period (weeks for the
 * weekly views, days for the daily ones). Below `critical` = red, below
 * `warn` = amber, otherwise green. Same thresholds the card used before.
 */
export const COVER_THRESHOLDS = {
  week: { critical: 4, warn: 8 },
  day: { critical: 14, warn: 28 },
} as const;

export function coverLevel(cover: number, bucket: "week" | "day"): "critical" | "warn" | "ok" {
  const t = COVER_THRESHOLDS[bucket];
  if (cover < t.critical) return "critical";
  if (cover < t.warn) return "warn";
  return "ok";
}

const COVER_DOT: Record<"critical" | "warn" | "ok", string> = {
  critical: "bg-hub-bad",
  warn: "bg-hub-warn",
  ok: "bg-hub-accent-text",
};

/** 120×24 line with a dot on the last point; dashed flat line when unused. */
function Sparkline({ values, width = 120, height = 24 }: { values: number[]; width?: number; height?: number }) {
  if (values.length === 0 || values.every((v) => v === 0)) {
    return (
      <svg width={width} height={height} aria-hidden className="block">
        <line x1="0" y1={height - 2} x2={width} y2={height - 2} stroke="rgb(var(--hub-line-2))" strokeDasharray="2 3" />
      </svg>
    );
  }
  const max = Math.max(...values, 1);
  const stepX = values.length > 1 ? width / (values.length - 1) : width;
  const pt = (v: number, i: number) => [i * stepX, height - 2 - (v / max) * (height - 6)] as const;
  const pts = values.map((v, i) => pt(v, i).map((n) => n.toFixed(1)).join(",")).join(" ");
  const [lx, ly] = pt(values[values.length - 1], values.length - 1);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="block overflow-visible">
      <polyline fill="none" stroke="rgb(var(--hub-accent-text))" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" points={pts} />
      <circle cx={lx} cy={ly} r="2.2" fill="rgb(var(--hub-accent-text))" />
    </svg>
  );
}

/**
 * Package usage history over a trailing period. Historical read on request
 * only (Task 17): nothing is fetched on mount or on a Reports refresh; a
 * change of period, site or package set clears the result back to "not
 * loaded"; Load reads every ledger and order-event page (stable order) or
 * shows an error - a partial history is never shown as complete.
 */
export function PackageHistoryCard() {
  const supabase = getSupabase();
  const location = useAppStore((s) => s.location);
  const { data } = useDataset();
  const catalogue = usePackagingCatalogue();
  const [periodKey, setPeriodKey] = useState<PeriodKey>("12w");
  const period = PERIODS.find((p) => p.key === periodKey) ?? PERIODS[3];

  /** null = not loaded for the current period/site/package set. */
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [events, setEvents] = useState<DeptEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

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
    // F4: packaging items from the site's rule sets that are not in the
    // hard-coded list above.
    const listed = new Set(slots.map((s) => s.product?.id).filter(Boolean));
    for (const [productId, label] of catalogue) {
      if (listed.has(productId)) continue;
      const product = byId.get(productId) ?? null;
      slots.push({
        key: productId,
        label,
        kind: "box",
        product: product
          ? { id: product.id, supplier: product.supplier ?? "", current_on_hand: product.current_on_hand ?? 0 }
          : null,
      });
    }
    return slots;
  }, [data, catalogue]);

  const packageProductIds = useMemo(() => {
    const s = new Set<string>();
    for (const slot of packageSlots) if (slot.product) s.add(slot.product.id);
    return s;
  }, [packageSlots]);

  // A new period/site/package set invalidates any shown or in-flight result (no read here).
  const scopeKey = `${location}|${periodKey}|${fromDate.toISOString()}|${Array.from(packageProductIds).sort().join(",")}`;
  useEffect(() => {
    seq.current++;
    setRows(null);
    setEvents(null);
    setLoading(false);
    setError(null);
  }, [scopeKey]);

  // Explicit, complete read of the period's package ledger rows and order events.
  const load = useCallback(async () => {
    if (!data) return;
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
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
              // F4: include rows written back by packaging corrections.
              .or(PACKAGE_USAGE_ROWS_FILTER)
              .gte("ts", fromIso)
              .order("ts", { ascending: true })
              .order("id", { ascending: true })
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
          .order("id", { ascending: true })
          .range(from, to),
      );
      const [ledgerResults, eventResults] = await Promise.all([ledgerPromise, eventsPromise]);
      if (mine !== seq.current) return;
      setRows(ledgerResults);
      setEvents(eventResults);
    } catch (e) {
      if (mine !== seq.current) return;
      setRows(null); // never a partial history
      setEvents(null);
      setError((e as Error).message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
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
    for (const ev of events ?? []) {
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
    for (const r of rows ?? []) {
      const key = bucketKeyForTs(r.ts);
      const idx = bucketKeys.indexOf(key);
      if (idx < 0) continue;
      const arr = perProduct.get(r.product_id);
      if (arr) arr[idx] += usageOf(r);
    }
    // A correction can land in a later bucket than its deduction; never show
    // negative usage for a bucket.
    for (const arr of perProduct.values()) {
      for (let i = 0; i < arr.length; i++) if (arr[i] < 0) arr[i] = 0;
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

  const bucket = period.bucketDays === 7 ? "week" : "day";

  return (
    <Section
      title="Package usage history"
      meta={events === null
        ? "Not loaded"
        : `${denominators.framed.toLocaleString()} framed · ${denominators.unframed.toLocaleString()} unframed orders`}
      subtitle={`${period.label} · framed = A0 + dispatch, unframed = completed at the unframed station`}
      storageKey="inka-reports-collapse:package-history"
      actions={
        <Segmented
          label="History range"
          value={periodKey}
          onChange={setPeriodKey}
          options={PERIODS.map((p) => ({ value: p.key, label: p.short, title: `Show ${p.label.toLowerCase()}` }))}
        />
      }
    >
      {loading ? (
        <div className="text-[13px] text-hub-faint">Loading…</div>
      ) : error ? (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-hub-bad">
          {error}
          <Button variant="secondary" size="sm" onClick={() => void load()}>Retry</Button>
        </div>
      ) : rows === null || events === null ? (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-hub-muted">
          Not loaded for this period.
          <Button variant="secondary" size="sm" onClick={() => void load()}>Load package history</Button>
        </div>
      ) : (
        <>
          <div className={nTableWrap}>
            <table className={nTable}>
              <thead>
                <tr>
                  <th className={nTh}>Package</th>
                  <th className={nTh}>{period.label}</th>
                  <th className={nThNum}>On hand</th>
                  <th className={nThNum} title={`Average packages used per ${period.bucketLabel} over the ${period.label.toLowerCase()}`}>{period.avgLabel}</th>
                  <th className={nThNum} title="Boxes: usage divided by framed orders (dispatch station + A0 framed station). Tubes: usage divided by unframed orders completed at the unframed station.">Per order</th>
                  <th className={nThNum} title="On hand divided by average usage per bucket - how long stock lasts at current rate">{period.coverLabel}</th>
                  <th className={nThNum}>Reorder</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((r) => {
                  const level = r.cover == null ? null : coverLevel(r.cover, bucket);
                  const denomLabel = r.kind === "tube" ? "unframed order" : "framed order";
                  return (
                    <tr key={r.slotKey} className="hover:bg-hub-hover">
                      <td className={nTd}>
                        <div className="flex items-center gap-2">
                          <b className="font-medium text-hub-text">{r.label}</b>
                          <Tag color={r.kind === "tube" ? "blue" : "gray"}>{r.kind.toUpperCase()}</Tag>
                        </div>
                        {r.catalogued ? (
                          r.supplier ? <div className="mt-0.5 text-xs text-hub-faint">{r.supplier}</div> : null
                        ) : (
                          <div className="mt-0.5 text-xs text-hub-warn">
                            Not in catalogue ·{" "}
                            {/* The SKUs page can't prefill a code from the URL, so this just opens it. */}
                            <Link
                              to="/skus"
                              title={`Add a SKU with code "${r.slotKey}"`}
                              className="text-hub-muted underline decoration-hub-line-2 underline-offset-2 hover:text-hub-text"
                            >
                              Add as “{r.slotKey}”
                            </Link>
                          </div>
                        )}
                      </td>
                      <td className={nTd}>
                        <div className="flex items-center gap-2.5">
                          <Sparkline values={r.buckets} />
                          <span className="min-w-[56px] whitespace-nowrap text-xs tabular-nums text-hub-faint">
                            {r.totalUsed.toLocaleString()} used
                          </span>
                        </div>
                      </td>
                      <td className={cn(nTdNum, !r.catalogued && "text-hub-faint")}>{r.catalogued ? r.onHand.toLocaleString() : "—"}</td>
                      <td className={cn(nTdNum, !r.catalogued && "text-hub-faint")}>{r.catalogued ? r.perBucketAvg.toFixed(1) : "—"}</td>
                      <td
                        className={cn(nTdNum, r.ratio == null && "text-hub-faint")}
                        title={r.ratio == null ? `No ${denomLabel}s in window` : `${(r.ratio * 100).toFixed(0)}% of ${denomLabel}s used this`}
                      >
                        {r.ratio == null ? "—" : r.ratio.toFixed(2)}
                      </td>
                      <td className={nTdNum}>
                        {r.cover == null || level == null ? (
                          <span className="text-hub-faint">—</span>
                        ) : (
                          <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", level === "critical" && "font-semibold")}>
                            <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", COVER_DOT[level])} />
                            {r.cover.toFixed(1)} {bucket === "week" ? "wk" : "d"}
                          </span>
                        )}
                      </td>
                      <td className={nTdNum}>
                        {r.supplier ? (
                          <Link
                            to={`/orders?supplier=${encodeURIComponent(r.supplier)}`}
                            className="inline-flex items-center gap-1 whitespace-nowrap font-semibold text-hub-text hover:text-hub-accent-text"
                            title={`Open Order Builder for ${r.supplier}`}
                          >
                            Build PO <ExternalLink size={11} aria-hidden />
                          </Link>
                        ) : (
                          <span className="text-hub-faint">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Callout className="mt-3.5">
            <b>How ratios work.</b> Box ratio = usage ÷ framed orders (dispatch + A0 framed). Tube ratio = usage ÷ unframed orders completed. Multiply by expected order volume to size the next PO.
          </Callout>
        </>
      )}
    </Section>
  );
}
