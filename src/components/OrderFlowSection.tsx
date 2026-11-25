/**
 * F10 Order flow (Reports): neutral durations for the site's RECORDED orders
 * ordered in the chosen production days. Order-to-complete-shipment median/P90
 * with sample, open and anomaly counts, and per adjacent step gaps. Coverage
 * and freshness are always shown; no lateness or performance labels.
 */
import { useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { isReportSite, productionDateAt, shiftProductionDate, type ReportSite } from "@/lib/domain/productionPeriods";
import type { OverviewState } from "@/lib/hooks/useReportsOverview";
import { formatHours, siteTime, STAGE_LABELS, useTimelineLoad } from "./OrderTimelineCard";

export interface FlowRequest { site: ReportSite; firstDate: string; lastDate: string }
export interface OrderFlowView {
  site: ReportSite;
  firstDate: string;
  lastDate: string;
  cohort: number;
  completeShipmentSamples: number;
  openOrders: number;
  anomalies: number;
  orderToShipHours: { median: number | null; p90: number | null };
  stageGaps: Array<{ from: string; to: string; samples: number; unknown: number; anomalies: number; median: number | null; p90: number | null }>;
  coverage: { label: string; recordedOrders: number; unroutedOrders: number; latestReceivedAt: { shopify: string | null; app: string | null; make: string | null } };
}
export const flowQuery = (r: FlowRequest) => `action=flow&site=${encodeURIComponent(r.site)}&firstDate=${r.firstDate}&lastDate=${r.lastDate}`;

export function flowRequestFor(site: string, days: 7 | 30, now = new Date()): FlowRequest | null {
  if (!isReportSite(site)) return null;
  const today = productionDateAt(now, site);
  return { site, firstDate: shiftProductionDate(today, -(days - 1)), lastDate: today };
}

export function OrderFlowSection({ supabase, scopeKey, site }: { supabase: SupabaseClient; scopeKey: string; site: string }) {
  const [days, setDays] = useState<7 | 30>(7);
  const [refreshKey, setRefreshKey] = useState(0);
  // recomputed on refresh so "today" rolls over at the site's 04:00 production-day start
  const request = useMemo(() => flowRequestFor(site, days), [site, days, refreshKey]);
  const state = useTimelineLoad<FlowRequest, OrderFlowView>(supabase, flowQuery, scopeKey, request, refreshKey);
  return (
    <Card>
      <CardBody>
        <section aria-label="Order flow" className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">Order flow durations</h3>
            <select aria-label="Order flow period" className="h-8 rounded border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900" value={days} onChange={(e) => setDays(e.target.value === "30" ? 30 : 7)}>
              <option value={7}>Last 7 production days</option>
              <option value={30}>Last 30 production days</option>
            </select>
            <Button variant="secondary" size="sm" onClick={() => setRefreshKey((k) => k + 1)}>Refresh</Button>
          </div>
          <OrderFlowView state={state} onRetry={() => setRefreshKey((k) => k + 1)} />
        </section>
      </CardBody>
    </Card>
  );
}

export function OrderFlowView({ state, onRetry }: { state: OverviewState<OrderFlowView>; onRetry: () => void }) {
  if (state.status === "idle") return <p className="text-xs text-slate-500">Choose AU, UK or US to see order flow.</p>;
  if (state.status === "loading") return <div className="text-xs text-slate-500" role="status">Loading order flow…</div>;
  if (state.status !== "ready" || !state.data) {
    return <div className="text-xs text-rose-700 dark:text-rose-300" role="alert">Couldn't load order flow: {state.error ?? "unknown error"} <button type="button" className="underline" onClick={onRetry}>Retry</button></div>;
  }
  const d = state.data;
  const c = d.coverage;
  return (
    <div className="space-y-2 text-xs">
      <p className="text-[11px] text-slate-500" role="status">
        {c.label}. {d.firstDate} to {d.lastDate}: {d.cohort} recorded order{d.cohort === 1 ? "" : "s"} (cancelled excluded).
        {c.unroutedOrders ? ` ${c.unroutedOrders} recorded order(s) are not linked to a site yet and are not included.` : ""}
        {" "}Latest received: Shopify {siteTime(c.latestReceivedAt.shopify, d.site)}, app {siteTime(c.latestReceivedAt.app, d.site)}, automation {siteTime(c.latestReceivedAt.make, d.site)}.
      </p>
      <div className="text-slate-700 dark:text-slate-200">
        Order to complete shipment: median {formatHours(d.orderToShipHours.median)}, P90 {formatHours(d.orderToShipHours.p90)} — {d.completeShipmentSamples} measured, {d.openOrders} not completely shipped
        {d.anomalies ? `, ${d.anomalies} with a time anomaly (excluded)` : ""}.
      </div>
      <table className="w-full">
        <thead>
          <tr className="text-left text-slate-500"><th className="py-1">Between steps</th><th>Measured</th><th>Unknown</th><th>Anomalies</th><th>Median</th><th>P90</th></tr>
        </thead>
        <tbody>
          {d.stageGaps.map((g) => (
            <tr key={`${g.from}|${g.to}`} className="border-t border-slate-100 dark:border-slate-800">
              <td className="py-1">{STAGE_LABELS[g.from] ?? g.from} → {STAGE_LABELS[g.to] ?? g.to}</td>
              <td className="tabular-nums">{g.samples}</td>
              <td className="tabular-nums">{g.unknown}</td>
              <td className="tabular-nums">{g.anomalies}</td>
              <td className="tabular-nums">{formatHours(g.median)}</td>
              <td className="tabular-nums">{formatHours(g.p90)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-slate-500">Only confirmed times at both ends are measured; a missing step leaves both neighbouring gaps unknown.</p>
    </div>
  );
}
