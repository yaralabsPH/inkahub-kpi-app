/**
 * F10 Order timeline card (Reports): look up one order at the current site.
 * Shows every stage in order with its source, event time (site time zone) and
 * explicit missing/unconfirmed/partial status, plus elapsed time between
 * ADJACENT stages only (unknown when an endpoint is not confirmed). Durations
 * only: no lateness labels. Uses the shared request lifecycle: identity = user
 * scope + site + order, so a change clears the result and late answers for an
 * older site/order are dropped.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
const STATUS_TEXT: Record<string, string> = { confirmed: "recorded", partial: "partial (whole order not proven)", unconfirmed: "unconfirmed", missing: "missing" };

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
  /** Per fulfillment: when it was CREATED in Shopify (not when the whole order shipped). */
  fulfillments: Array<{ fulfillmentId: string; at: string; complete: boolean; kind: string }>;
  deliveries: Array<{ fulfillmentId: string | null; at: string; kind: string }>;
  evidence: Array<{ stage: string; source: string; kind: string; at: string; receivedAt: string; fulfillmentId: string | null; workType: string | null; batchId: string | null; caseId: string | null; retraction: boolean; revoked: boolean; runId?: string | null }>;
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

// ---------------------------------------------------------------------------
// Owner-only "Refresh sources": the existing POST {action:"reconcile"} copies
// one order's app events and reads Shopify (read-only), then the stored
// timeline is reloaded. The server re-authorizes (owner only); the UI only
// hides the action for other roles.
// ---------------------------------------------------------------------------

export type SourceRefreshTone = "ok" | "partial" | "error";
export interface SourceRefreshState { key: string; busy: boolean; tone: SourceRefreshTone | null; message: string | null }
const IDLE_REFRESH: SourceRefreshState = { key: "", busy: false, tone: null, message: null };

const bareOrder = (s: string) => s.trim().replace(/^#/, "").trim();
const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * One reconcile response -> a concise, honest outcome. Only "ok" claims both
 * sources were refreshed; a missing, unconfigured, unrouted or conflicting
 * Shopify read is "partial"; a shape we don't recognise is an error (outcome unknown).
 */
export function describeReconcile(body: unknown, r: TimelineRequest): { tone: SourceRefreshTone; message: string } {
  const unknown = { tone: "error" as const, message: "Refresh sources returned an unexpected answer; whether anything was saved is unknown. The timeline shows what is stored." };
  const o = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!o || o.site !== r.site || typeof o.orderNumber !== "string" || bareOrder(o.orderNumber) !== bareOrder(r.orderNumber)) return unknown;
  const app = o.app && typeof o.app === "object" ? (o.app as Record<string, unknown>) : null;
  const appNew = count(app?.accepted);
  const appDup = count(app?.duplicates);
  const appConf = count(app?.conflicts);
  const s = o.shopify && typeof o.shopify === "object" ? (o.shopify as Record<string, unknown>) : null;
  if (appNew === null || appDup === null || appConf === null || !s) return unknown;
  const appText = `App events: ${appNew} new, ${appDup} already recorded${appConf ? `, ${plural(appConf, "conflicting fact")} kept as first recorded` : ""}.`;
  const note = typeof s.note === "string" && s.note ? s.note : null;
  if (s.status === "not_found" || s.status === "not_configured") {
    return { tone: "partial", message: `${appText} Shopify not refreshed: ${note ?? (s.status === "not_found" ? "no Shopify order has this number" : "Shopify reading is not configured")}. Refresh incomplete.` };
  }
  if (s.status !== "recorded") return unknown;
  const res = s.result && typeof s.result === "object" ? (s.result as Record<string, unknown>) : null;
  const shNew = count(res?.accepted);
  const shDup = count(res?.duplicates);
  const shConf = count(res?.conflicts);
  if (shNew === null || shDup === null || shConf === null || typeof s.routedHere !== "boolean") return unknown;
  const shText = `Shopify: ${shNew} new, ${shDup} already recorded${shConf ? `, ${plural(shConf, "conflicting fact")} kept as first recorded` : ""}.`;
  if (!s.routedHere || note) return { tone: "partial", message: `${appText} ${shText} ${note ?? "The Shopify order is not linked to this site"}. Refresh incomplete.` };
  if (shConf || appConf) return { tone: "partial", message: `Sources read, with conflicts. ${appText} ${shText}` };
  return { tone: "ok", message: `Sources refreshed. ${appText} ${shText}` };
}

/** HTTP failures that wrote nothing (validation, auth, ingestion switched off): no reload needed. */
const NOTHING_WRITTEN = new Set(["BAD_REQUEST", "UNAUTHENTICATED", "FORBIDDEN", "DISABLED", "METHOD"]);

export interface SourceRefresherDeps {
  fetch: (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  token: () => Promise<string | null>;
  /** The identity (scope + site + order) currently on screen; a result for any other is dropped. */
  currentKey: () => string;
  onChange: (s: SourceRefreshState) => void;
  /** Reload the stored timeline of the CURRENT order (called only while `key` is still current). */
  reload: () => void;
}

export const refreshKeyOf = (scopeKey: string, r: TimelineRequest) => `${scopeKey}|${timelineQuery(r)}`;

export function createSourceRefresher(deps: SourceRefresherDeps) {
  let state: SourceRefreshState = IDLE_REFRESH;
  let seq = 0;
  /** Requests still unsettled, per identity: the lock, independent of what is displayed. */
  const inFlight = new Map<string, number>();
  /** The request whose answer may paint and reload (0 = none; cleared when the identity changes). */
  let shown = 0;
  const set = (s: SourceRefreshState) => {
    state = s;
    deps.onChange(s);
  };
  return {
    state: () => state,
    /** Identities with an unsettled request (for tests and diagnostics). */
    inFlight: () => [...inFlight.keys()],
    /**
     * Start one refresh. While a request for this identity is unsettled no second
     * one is sent; asking again (e.g. after looking at another order and coming
     * back) re-attaches the display to the running request instead.
     */
    async refresh(scopeKey: string, r: TimelineRequest): Promise<void> {
      const key = refreshKeyOf(scopeKey, r);
      const running = inFlight.get(key);
      if (running !== undefined) {
        if (shown !== running) {
          shown = running;
          set({ key, busy: true, tone: null, message: null });
        }
        return;
      }
      const mine = ++seq;
      inFlight.set(key, mine);
      shown = mine;
      set({ key, busy: true, tone: null, message: null });
      try {
        await run(key, mine, r);
      } finally {
        if (inFlight.get(key) === mine) inFlight.delete(key);
      }
    },
    /** Identity changed: forget the shown result; a late answer neither paints nor reloads. The lock stays until settlement. */
    reset() {
      shown = 0;
      if (state !== IDLE_REFRESH) set(IDLE_REFRESH);
    },
  };

  async function run(key: string, mine: number, r: TimelineRequest): Promise<void> {
    const current = () => mine === shown && deps.currentKey() === key;
    const finish = (tone: SourceRefreshTone, message: string, reload: boolean) => {
      if (!current()) return;
      set({ key, busy: false, tone, message });
      if (reload) deps.reload();
    };
    try {
      const token = await deps.token();
      // abandoned before anything was sent (identity changed and not re-asked): send nothing
      if (!current()) return;
      if (!token) return finish("error", "Sign in again to refresh sources.", false);
      const res = await deps.fetch("/api/orders/timeline", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reconcile", site: r.site, orderNumber: r.orderNumber }),
      });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.ok) {
        const d = describeReconcile(body, r);
        return finish(d.tone, d.message, true);
      }
      const code = typeof body?.code === "string" ? body.code : `HTTP_${res.status}`;
      const error = typeof body?.error === "string" ? body.error : `request failed (${res.status})`;
      // the app copy is committed before Shopify is read, so a Shopify failure is a partial refresh
      if (code === "SHOPIFY_UNAVAILABLE") return finish("partial", `App events were refreshed; Shopify could not be read (${error}). Refresh incomplete.`, true);
      if (NOTHING_WRITTEN.has(code)) return finish("error", `Refresh sources failed: ${error}`, false);
      return finish("error", `Refresh sources did not complete: ${error}. Some events may already be saved; the timeline shows what is stored.`, true);
    } catch (e) {
      finish("error", `Refresh sources outcome unknown (${e instanceof Error ? e.message : "network error"}). The timeline shows what is stored.`, true);
    }
  }
}

/** Buttons for the looked-up order. Only an owner gets Refresh sources; every reader keeps the stored-data Refresh. */
export function TimelineActions({ active, role, busy, onReload, onRefreshSources }: { active: boolean; role: string | null; busy: boolean; onReload: () => void; onRefreshSources: () => void }) {
  if (!active) return null;
  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={onReload}>Refresh</Button>
      {role === "owner" ? (
        <Button type="button" variant="secondary" size="sm" disabled={busy} aria-busy={busy} onClick={onRefreshSources} title="Copy this order's app events and read Shopify, then reload">
          {busy ? "Refreshing sources…" : "Refresh sources"}
        </Button>
      ) : null}
    </>
  );
}

export function SourceRefreshMessage({ state }: { state: SourceRefreshState }) {
  if (state.busy) return <div className="text-xs text-slate-500" role="status">Refreshing sources…</div>;
  if (!state.message) return null;
  const cls = state.tone === "ok" ? "text-emerald-700 dark:text-emerald-300" : state.tone === "partial" ? "text-amber-700 dark:text-amber-300" : "text-rose-700 dark:text-rose-300";
  return <div className={`text-xs ${cls}`} role={state.tone === "error" ? "alert" : "status"}>{state.message}</div>;
}

export function OrderTimelineCard({ supabase, scopeKey, site, role }: { supabase: SupabaseClient; scopeKey: string; site: string; role: string | null }) {
  const [draft, setDraft] = useState("");
  const [request, setRequest] = useState<TimelineRequest | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // only a request for the CURRENT site is ever loaded or shown (no frame of another site's order)
  const active = effectiveRequest(request, site);
  const state = useTimelineLoad<TimelineRequest, OrderTimelineView>(supabase, timelineQuery, scopeKey, active, refreshKey);
  const currentKey = active ? refreshKeyOf(scopeKey, active) : "";
  const currentKeyRef = useRef(currentKey);
  currentKeyRef.current = currentKey;
  const [sources, setSources] = useState<SourceRefreshState>(IDLE_REFRESH);
  const refresher = useMemo(
    () =>
      createSourceRefresher({
        fetch: (url, init) => window.fetch(url, init),
        token: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
        currentKey: () => currentKeyRef.current,
        onChange: setSources,
        reload: () => setRefreshKey((k) => k + 1),
      }),
    [supabase],
  );
  useEffect(() => refresher.reset(), [refresher, currentKey]);
  const shownSources = sources.key === currentKey ? sources : IDLE_REFRESH;
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
            <TimelineActions
              active={!!active}
              role={role}
              busy={shownSources.busy}
              onReload={() => setRefreshKey((k) => k + 1)}
              onRefreshSources={() => {
                if (active && role === "owner") void refresher.refresh(scopeKey, active);
              }}
            />
          </form>
          {!isReportSite(site) ? <p className="text-xs text-slate-500">Choose AU, UK or US to look up an order.</p> : null}
          <SourceRefreshMessage state={shownSources} />
          <OrderTimelineView state={state} onRetry={() => setRefreshKey((k) => k + 1)} />
        </section>
      </CardBody>
    </Card>
  );
}

/** F11 batch/run context for a recorded automation step (from the evidence that recorded it; never secrets). */
export function automationContext(d: OrderTimelineView, s: { stage: string; status: string; at: string | null }): string {
  if (!s.stage.startsWith("make_") || s.status === "missing" || !s.at) return "";
  const e = d.evidence.find((x) => x.stage === s.stage && x.source === "make" && !x.revoked && !x.retraction && Date.parse(x.at) === Date.parse(s.at as string));
  if (!e) return "";
  return [e.batchId ? ` · batch ${e.batchId}` : "", e.runId ? ` · run ${e.runId}` : ""].join("");
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
                  <td>{s.source ?? "—"}{automationContext(d, s)}</td>
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
          Fulfillments created in Shopify: {d.fulfillments.map((f) => `${f.complete ? "whole-order proof " : ""}${siteTime(f.at, d.site)}${f.kind !== "confirmed" ? ` (${f.kind})` : ""}`).join("; ")}.
          {d.stages?.find((s) => s.stage === "shipped")?.status !== "confirmed" ? " When the whole order was shipped is not recorded, so its duration is unknown." : ""}
        </div>
      ) : null}
      {d.deliveries.length ? (
        <div className="text-slate-600 dark:text-slate-300">
          Deliveries per fulfillment: {d.deliveries.map((x) => `${x.fulfillmentId ?? "?"} ${siteTime(x.at, d.site)}${x.kind !== "confirmed" ? ` (${x.kind})` : ""}`).join("; ")}
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
              {e.retraction ? " · scan cancelled (withdraws an earlier scan)" : ""}{e.revoked ? " · withdrawn, not counted" : ""}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
