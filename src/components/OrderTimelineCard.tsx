/**
 * F10 Order timeline card (Reports): look up one order at the current site.
 * Shows every stage in order with its source, event time (site time zone) and
 * explicit missing/unconfirmed/partial status, plus elapsed time between
 * ADJACENT stages only (unknown when an endpoint is not confirmed). Durations
 * only: no lateness labels. Uses the shared request lifecycle: identity = user
 * scope + site + order, so a change clears the result and late answers for an
 * older site/order are dropped.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { SITE_TIME_ZONES, isReportSite, type ReportSite } from "@/lib/domain/productionPeriods";
import { createOverviewLoader, type OverviewState } from "@/lib/hooks/useReportsOverview";

export const STAGE_LABELS: Record<string, string> = {
  ordered: "Ordered",
  make_submitted: "Submitted to print",
  make_files_found: "Files found",
  make_planned: "Planned",
  make_images_ready: "Images ready",
  make_packing_ready: "Packing slips ready",
  framed: "Framed",
  dispatched: "Dispatched",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
};
const STATUS_TEXT: Record<string, string> = { confirmed: "recorded", partial: "partial", unconfirmed: "unconfirmed", missing: "missing" };

export interface TimelineRequest { site: ReportSite; orderNumber: string }
export interface OrderTimelineView {
  site: ReportSite;
  orderNumber: string;
  linked: boolean;
  note: string | null;
  stages: Array<{ stage: string; status: string; at: string | null; source: string | null; kind: string | null }> | null;
  gaps: Array<{ from: string; to: string; status: "measured" | "unknown" | "anomaly"; hours: number | null }>;
  cancelled: { at: string | null } | null;
  framedByWorkType: Array<{ workType: string; at: string; kind: string }>;
  fulfillments: Array<{ fulfillmentId: string; at: string; complete: boolean; kind: string }>;
  evidence: Array<{ stage: string; source: string; kind: string; at: string; receivedAt: string; fulfillmentId: string | null; workType: string | null; batchId: string | null; caseId: string | null }>;
}

export const timelineQuery = (r: TimelineRequest) => `action=order&site=${encodeURIComponent(r.site)}&orderNumber=${encodeURIComponent(r.orderNumber)}`;

export function siteTime(iso: string | null, site: ReportSite): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone: SITE_TIME_ZONES[site], day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}
export function formatHours(h: number | null): string {
  if (h === null) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
}
export const gapText = (g: OrderTimelineView["gaps"][number]) => (g.status === "measured" ? formatHours(g.hours) : g.status === "anomaly" ? "time anomaly (not measured)" : "unknown");

/** Shared loader binding for the timeline endpoint (same lifecycle as the overview/timing sections). */
export function useTimelineLoad<R, T>(supabase: SupabaseClient, queryOf: (r: R) => string, scopeKey: string | null, request: R | null, refreshKey: number): OverviewState<T> {
  const [state, setState] = useState<OverviewState<T>>({ key: "", status: "idle", data: null, error: null, code: null });
  const loader = useMemo(
    () =>
      createOverviewLoader<R, T>({
        path: "/api/orders/timeline",
        queryOf,
        fetch: (url, init) => window.fetch(url, init),
        token: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
        onChange: setState,
      }),
    [supabase, queryOf],
  );
  const key = request && scopeKey ? `${scopeKey}|${queryOf(request)}` : "";
  useEffect(() => {
    void loader.load(scopeKey, request);
    // the key captures the site, the request and the trusted scope
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loader, key, refreshKey]);
  useEffect(() => () => loader.dispose(), [loader]);
  return state.key === key ? state : { key, status: key ? "loading" : "idle", data: null, error: null, code: null };
}

/** The looked-up order only while the selected site is the one it was looked up for. */
export const effectiveRequest = (r: TimelineRequest | null, site: string): TimelineRequest | null => (r && r.site === site ? r : null);

export function OrderTimelineCard({ supabase, scopeKey, site }: { supabase: SupabaseClient; scopeKey: string; site: string }) {
  const [draft, setDraft] = useState("");
  const [request, setRequest] = useState<TimelineRequest | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // only a request for the CURRENT site is ever loaded or shown (no frame of another site's order)
  const active = effectiveRequest(request, site);
  const state = useTimelineLoad<TimelineRequest, OrderTimelineView>(supabase, timelineQuery, scopeKey, active, refreshKey);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = draft.trim();
    if (!n || !isReportSite(site)) return;
    setRequest({ site, orderNumber: n });
  };
  return (
    <Card>
      <CardBody>
        <section aria-label="Order timeline" className="space-y-2">
          <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">Order timeline</h3>
            <input
              aria-label="Order number"
              className="h-8 w-40 rounded border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
              value={draft}
              maxLength={64}
              placeholder="Order number"
              onChange={(e) => setDraft(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={!draft.trim() || !isReportSite(site)}><Search size={14} /> Look up</Button>
            {active ? <Button type="button" variant="secondary" size="sm" onClick={() => setRefreshKey((k) => k + 1)}>Refresh</Button> : null}
          </form>
          {!isReportSite(site) ? <p className="text-xs text-slate-500">Choose AU, UK or US to look up an order.</p> : null}
          <OrderTimelineView state={state} onRetry={() => setRefreshKey((k) => k + 1)} />
        </section>
      </CardBody>
    </Card>
  );
}

export function OrderTimelineView({ state, onRetry }: { state: OverviewState<OrderTimelineView>; onRetry: () => void }) {
  if (state.status === "idle") return <p className="text-[11px] text-slate-500">Shows recorded evidence only: a missing step means nothing was recorded, not that it failed. Times are in the site's time zone.</p>;
  if (state.status === "loading") return <div className="text-xs text-slate-500" role="status">Loading order timeline…</div>;
  if (state.status === "not_ready" || state.status === "error" || !state.data) {
    return <div className="text-xs text-rose-700 dark:text-rose-300" role="alert">Couldn't load the order timeline: {state.error ?? "unknown error"} <button type="button" className="underline" onClick={onRetry}>Retry</button></div>;
  }
  const d = state.data;
  const gapTo = new Map(d.gaps.map((g) => [g.to, g]));
  return (
    <div className="space-y-2 text-xs">
      <div className="text-slate-600 dark:text-slate-300">
        Order {d.orderNumber} · {d.site.toUpperCase()}
        {d.cancelled ? <span className="ml-2 rounded bg-rose-100 px-1.5 py-0.5 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200">Cancelled {siteTime(d.cancelled.at, d.site)}</span> : null}
      </div>
      {d.note ? <p className="text-slate-500" role="status">{d.note}</p> : null}
      {d.stages ? (
        <table className="w-full">
          <thead>
            <tr className="text-left text-slate-500"><th className="py-1">Step</th><th>Status</th><th>When</th><th>Source</th><th>Since previous step</th></tr>
          </thead>
          <tbody>
            {d.stages.map((s, i) => {
              const g = i === 0 ? null : gapTo.get(s.stage) ?? null;
              return (
                <tr key={s.stage} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-1">{STAGE_LABELS[s.stage] ?? s.stage}</td>
                  <td className={s.status === "missing" ? "text-slate-400" : s.status === "confirmed" ? "" : "text-amber-700 dark:text-amber-300"}>
                    {STATUS_TEXT[s.status] ?? s.status}{s.kind && s.kind !== "confirmed" ? ` (${s.kind})` : ""}
                  </td>
                  <td className="tabular-nums">{siteTime(s.at, d.site)}</td>
                  <td>{s.source ?? "—"}</td>
                  <td className="tabular-nums">{g ? gapText(g) : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      {d.framedByWorkType.length ? (
        <div className="text-slate-600 dark:text-slate-300">Framing by work type: {d.framedByWorkType.map((f) => `${f.workType} ${siteTime(f.at, d.site)}${f.kind !== "confirmed" ? ` (${f.kind})` : ""}`).join("; ")}</div>
      ) : null}
      {d.fulfillments.length ? (
        <div className="text-slate-600 dark:text-slate-300">
          Shipments: {d.fulfillments.map((f) => `${f.complete ? "completes order" : "partial"} ${siteTime(f.at, d.site)}${f.kind !== "confirmed" ? ` (${f.kind})` : ""}`).join("; ")}
        </div>
      ) : null}
      {d.evidence.some((e) => e.caseId) ? <div className="text-slate-600 dark:text-slate-300">CS/replacement work is listed in the evidence below and never counts as completing the original order.</div> : null}
      <details>
        <summary className="cursor-pointer text-slate-500">Recorded evidence ({d.evidence.length})</summary>
        <ul className="mt-1 space-y-0.5">
          {d.evidence.map((e, i) => (
            <li key={i} className="tabular-nums text-slate-600 dark:text-slate-300">
              {siteTime(e.at, d.site)} · {STAGE_LABELS[e.stage] ?? e.stage} · {e.source}{e.kind !== "confirmed" ? ` (${e.kind})` : ""}
              {e.workType ? ` · ${e.workType}` : ""}{e.batchId ? ` · batch ${e.batchId}` : ""}{e.caseId ? ` · CS case ${e.caseId}` : ""}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
