/** F10 UI seams: request scope (no stale order/site), rendered states and labels, role visibility. */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  automationContext, createSourceRefresher, describeReconcile, effectiveRequest, OrderTimelineView, refreshKeyOf, SourceRefreshMessage, TimelineActions, timelineQuery,
  type OrderTimelineView as TimelineData, type SourceRefreshState, type TimelineRequest,
} from "../../src/components/OrderTimelineCard";
import { flowQuery, flowRequestFor, OrderFlowView, type OrderFlowView as FlowData } from "../../src/components/OrderFlowSection";
import { createOverviewLoader, type OverviewState } from "../../src/lib/hooks/useReportsOverview";
import { orderTimelineVisible } from "../../src/pages/Reports";

/** Visible text only (class names such as text-slate-500 must not count). */
const text = (html: string) => html.replace(/<[^>]*>/g, " ");
const CLASSIFY = /(late|lateness|overdue|slow|fast|SLA|threshold|on time)/i;
const tick = () => new Promise((r) => setTimeout(r, 0));
const SCOPE = "11111111-1111-4111-8111-111111111111|owner|site";
const ready = <T,>(data: T): OverviewState<T> => ({ key: "k", status: "ready", data, error: null, code: null });

const timeline = (site: "uk" | "au", orderNumber: string): TimelineData => ({
  site, orderNumber, linked: true, note: null,
  stages: [
    { stage: "ordered", status: "confirmed", at: "2026-11-20T09:00:00.000000Z", source: "shopify", kind: "confirmed" },
    { stage: "make_submitted", status: "missing", at: null, source: null, kind: null },
    { stage: "framed", status: "partial", at: "2026-11-20T12:00:00.000000Z", source: "app", kind: "confirmed" },
    { stage: "shipped", status: "unconfirmed", at: "2026-11-21T12:00:00.000000Z", source: "shopify", kind: "inferred" },
  ],
  gaps: [
    { from: "ordered", to: "make_submitted", status: "unknown", hours: null },
    { from: "make_submitted", to: "framed", status: "unknown", hours: null },
    { from: "framed", to: "shipped", status: "anomaly", hours: null },
  ],
  cancelled: { at: "2026-11-22T09:00:00.000000Z" },
  framedByWorkType: [{ workType: "framed", at: "2026-11-20T12:00:00.000000Z", kind: "confirmed" }],
  fulfillments: [{ fulfillmentId: "1", at: "2026-11-21T12:00:00.000000Z", complete: false, kind: "confirmed" }],
  deliveries: [{ fulfillmentId: "1", at: "2026-11-22T12:00:00.000000Z", kind: "confirmed" }],
  evidence: [
    { stage: "dispatched", source: "app", kind: "confirmed", at: "2026-11-21T09:00:00.000000Z", receivedAt: "2026-11-21T09:00:01.000000Z", fulfillmentId: null, workType: null, batchId: null, caseId: "C-1", retraction: false, revoked: true },
    { stage: "dispatched", source: "app", kind: "confirmed", at: "2026-11-21T10:00:00.000000Z", receivedAt: "2026-11-21T10:00:01.000000Z", fulfillmentId: null, workType: null, batchId: null, caseId: "C-1", retraction: true, revoked: false },
  ],
});

describe("request scope: a slow answer for another site or order never paints", () => {
  it("site change makes the old order inactive at once; a late reply for it is dropped", async () => {
    const uk: TimelineRequest = { site: "uk", orderNumber: "100" };
    expect(effectiveRequest(uk, "uk")).toBe(uk);
    expect(effectiveRequest(uk, "au")).toBeNull();
    const pending: Array<{ url: string; resolve: (b: unknown) => void }> = [];
    const loader = createOverviewLoader<TimelineRequest, TimelineData>({
      path: "/api/orders/timeline",
      queryOf: timelineQuery,
      token: async () => "t.t.t",
      fetch: (url) => new Promise((resolve) => pending.push({ url, resolve: (b) => resolve({ ok: true, status: 200, json: async () => b }) })),
      onChange: () => {},
    });
    void loader.load(SCOPE, uk);
    await tick();
    void loader.load(SCOPE, { site: "au", orderNumber: "200" });
    await tick();
    expect(pending.map((p) => p.url)).toEqual(["/api/orders/timeline?action=order&site=uk&orderNumber=100", "/api/orders/timeline?action=order&site=au&orderNumber=200"]);
    pending[0].resolve(timeline("uk", "100"));
    await tick();
    expect(loader.state()).toMatchObject({ status: "loading", data: null });
    pending[1].resolve(timeline("au", "200"));
    await tick();
    expect(loader.state().data).toMatchObject({ site: "au", orderNumber: "200" });
    void loader.load(SCOPE, null); // site without a valid selection: cleared, nothing pending wins
    pending[1].resolve(timeline("au", "200"));
    await tick();
    expect(loader.state()).toMatchObject({ status: "idle", data: null });
  });
  it("order numbers are encoded; flow requests follow the site's production days", () => {
    expect(timelineQuery({ site: "uk", orderNumber: "#1&x=1" })).toBe("action=order&site=uk&orderNumber=%231%26x%3D1");
    expect(flowRequestFor("staging", 7)).toBeNull();
    const r = flowRequestFor("au", 7, new Date("2026-11-23T02:00:00Z"))!; // 13:00 in Sydney
    expect(r).toEqual({ site: "au", firstDate: "2026-11-17", lastDate: "2026-11-23" });
    expect(flowQuery(r)).toBe("action=flow&site=au&firstDate=2026-11-17&lastDate=2026-11-23");
  });
});

describe("rendered timeline", () => {
  const html = renderToStaticMarkup(<OrderTimelineView state={ready(timeline("uk", "100"))} onRetry={() => {}} />);
  it("shows missing, partial, unconfirmed (with kind) and cancelled explicitly; unknown and anomaly gaps are never numbers", () => {
    expect(html).toContain("missing");
    expect(html).toContain("partial");
    expect(html).toContain("unconfirmed (inferred)");
    expect(html).toContain("Cancelled");
    expect(html).toContain("unknown");
    expect(html).toContain("time anomaly (not measured)");
    expect(html).toContain("never counts as completing the original order");
    // review task2: fulfillment creation is labelled as such, never as completion; deliveries are per fulfillment; withdrawn scans shown
    expect(html).toContain("Fulfillments created in Shopify");
    expect(html).toContain("When the whole order was shipped is not recorded");
    expect(html).not.toContain("completes order");
    expect(html).toContain("Deliveries per fulfillment");
    expect(html).toContain("withdrawn, not counted");
    expect(html).toContain("scan cancelled (withdraws an earlier scan)");
    expect(html).toContain("partial (whole order not proven)");
    expect(text(html)).not.toMatch(CLASSIFY);
  });
  it("times are shown in the site's time zone (UK 09:00Z = 09:00 GMT; AU = 20:00 AEDT)", () => {
    expect(html).toContain("09:00");
    const au = renderToStaticMarkup(<OrderTimelineView state={ready(timeline("au", "200"))} onRetry={() => {}} />);
    expect(au).toContain("20:00");
  });
  it("unlinked orders show the note and evidence, and errors offer a retry", () => {
    const un = renderToStaticMarkup(<OrderTimelineView state={ready({ ...timeline("uk", "1"), linked: false, stages: null, note: "Not linked to a Shopify order at this site yet" })} onRetry={() => {}} />);
    expect(un).toContain("Not linked");
    expect(un).toContain("Recorded evidence (2)");
    const err = renderToStaticMarkup(<OrderTimelineView state={{ key: "k", status: "error", data: null, error: "Order timeline is available to owners", code: "FORBIDDEN" }} onRetry={() => {}} />);
    expect(err).toContain("Retry");
  });
});

describe("rendered flow", () => {
  const flow: FlowData = {
    site: "uk", firstDate: "2026-11-17", lastDate: "2026-11-23", cohort: 3, completeShipmentSamples: 2, openOrders: 1, anomalies: 0,
    orderToShipHours: { median: 15, p90: 20 },
    stageGaps: [{ from: "ordered", to: "make_submitted", samples: 0, unknown: 3, anomalies: 0, median: null, p90: null }],
    coverage: { label: "Covers orders recorded by the timeline since it was commissioned, not complete Shopify history", recordedOrders: 3, unroutedOrders: 2, latestReceivedAt: { shopify: "2026-11-22T00:00:00.000000Z", app: null, make: null } },
  };
  it("neutral median/P90 with sample counts, coverage and unrouted orders; no classification", () => {
    const html = renderToStaticMarkup(<OrderFlowView state={ready(flow)} onRetry={() => {}} />);
    expect(html).toContain("median 15.0 h, P90 20.0 h");
    expect(html).toContain("2 measured, 1 not completely shipped");
    expect(html).toContain("not complete Shopify history");
    expect(html).toContain("2 recorded order(s) are not linked to a site yet");
    expect(text(html)).not.toMatch(CLASSIFY);
  });
});

describe("visibility", () => {
  it("never for staff or kiosk", () => {
    expect(["owner", "manager", "cs"].map(orderTimelineVisible)).toEqual([true, true, true]);
    expect(["staff", "kiosk", null].map(orderTimelineVisible)).toEqual([false, false, false]);
  });
});

describe("F11 automation steps in the card", () => {
  const base = timeline("au", "9001");
  const data: TimelineData = {
    ...base, cancelled: null, deliveries: [], fulfillments: [],
    stages: [
      { stage: "ordered", status: "missing", at: null, source: null, kind: null },
      { stage: "make_submitted", status: "confirmed", at: "2026-11-20T09:00:00.000000Z", source: "make", kind: "confirmed" },
      { stage: "make_files_found", status: "missing", at: null, source: null, kind: null },
      { stage: "make_planned", status: "confirmed", at: "2026-11-20T11:00:00.000000Z", source: "make", kind: "confirmed" },
      { stage: "make_images_ready", status: "missing", at: null, source: null, kind: null },
      { stage: "make_packing_ready", status: "missing", at: null, source: null, kind: null },
    ],
    gaps: [{ from: "make_submitted", to: "make_files_found", status: "unknown", hours: null }, { from: "make_files_found", to: "make_planned", status: "unknown", hours: null }],
    evidence: [
      { stage: "make_submitted", source: "make", kind: "confirmed", at: "2026-11-20T09:00:00.000000Z", receivedAt: "2026-11-20T09:00:02.000000Z", fulfillmentId: null, workType: null, batchId: "B1", caseId: null, retraction: false, revoked: false, runId: "p1:B1:v1" },
      { stage: "make_planned", source: "make", kind: "confirmed", at: "2026-11-20T11:00:00.000000Z", receivedAt: "2026-11-20T11:00:02.000000Z", fulfillmentId: null, workType: null, batchId: "B1", caseId: null, retraction: false, revoked: false, runId: "p3:B1:v1:exec-77" },
    ],
  };
  it("shows the five steps with labels, batch and run context for recorded ones, and missing (never failed) for the rest", () => {
    const html = renderToStaticMarkup(<OrderTimelineView state={ready(data)} onRetry={() => {}} />);
    for (const label of ["Submitted to print", "Files found", "Planned", "Images ready", "Packing slips ready"]) expect(html).toContain(label);
    expect(html).toContain("make · batch B1 · run p1:B1:v1");
    expect(html).toContain("make · batch B1 · run p3:B1:v1:exec-77");
    expect(text(html)).not.toMatch(/\bfailed\b|percent|%|printed/i);
    expect(automationContext(data, data.stages![2])).toBe(""); // missing: no context invented
    expect(automationContext(data, data.stages![0])).toBe(""); // not an automation step
  });
});

describe("owner-only Refresh sources", () => {
  const R: TimelineRequest = { site: "au", orderNumber: "#9001" };
  const KEY = refreshKeyOf(SCOPE, R);
  const ok = (shopify: unknown, app: unknown = { accepted: 2, duplicates: 1, conflicts: 0, route: "app" }) => ({ site: "au", orderNumber: "9001", app, shopify });
  const recorded = (over: Record<string, unknown> = {}) => ({ status: "recorded", routedHere: true, note: null, result: { accepted: 3, duplicates: 0, conflicts: 0, route: "matched" }, ...over });
  type Reply = { ok: boolean; status: number; body: unknown } | Error;
  function harness(opts: { token?: string | null; tokenGate?: Promise<void> } = {}) {
    const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
    const pending: Array<(r: Reply) => void> = [];
    let current = KEY;
    let reloads = 0;
    const r = createSourceRefresher({
      token: async () => {
        if (opts.tokenGate) await opts.tokenGate;
        return opts.token === undefined ? "t.t.t" : opts.token;
      },
      fetch: (url, init) => {
        calls.push({ url, init });
        return new Promise((resolve, reject) => pending.push((x) => (x instanceof Error ? reject(x) : resolve({ ok: x.ok, status: x.status, json: async () => x.body }))));
      },
      currentKey: () => current,
      onChange: () => {},
      reload: () => reloads++,
    });
    return { r, calls, pending, reloads: () => reloads, setCurrent: (k: string) => (current = k) };
  }
  const idle: SourceRefreshState = { key: "", busy: false, tone: null, message: null };

  it("only owners see Refresh sources; every reader keeps the stored-data Refresh", () => {
    for (const role of ["manager", "cs", null]) {
      const html = renderToStaticMarkup(<TimelineActions active role={role} busy={false} onReload={() => {}} onRefreshSources={() => {}} />);
      expect(html).toContain(">Refresh<");
      expect(html).not.toContain("Refresh sources");
    }
    const owner = renderToStaticMarkup(<TimelineActions active role="owner" busy={false} onReload={() => {}} onRefreshSources={() => {}} />);
    expect(owner).toContain(">Refresh<");
    expect(owner).toContain("Refresh sources");
    expect(renderToStaticMarkup(<TimelineActions active role="owner" busy onReload={() => {}} onRefreshSources={() => {}} />)).toMatch(/disabled=""[^>]*>Refreshing sources…/);
    expect(renderToStaticMarkup(<TimelineActions active={false} role="owner" busy={false} onReload={() => {}} onRefreshSources={() => {}} />)).toBe("");
  });

  it("POSTs the existing reconcile action with the session, then reloads the same order; a double click sends one request", async () => {
    const h = harness();
    void h.r.refresh(SCOPE, R);
    void h.r.refresh(SCOPE, R);
    await tick();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe("/api/orders/timeline");
    expect(h.calls[0].init.method).toBe("POST");
    expect(h.calls[0].init.headers.Authorization).toBe("Bearer t.t.t");
    expect(JSON.parse(h.calls[0].init.body)).toEqual({ action: "reconcile", site: "au", orderNumber: "#9001" });
    expect(h.r.state()).toMatchObject({ key: KEY, busy: true });
    h.pending[0]({ ok: true, status: 200, body: ok(recorded()) });
    await tick();
    expect(h.r.state()).toMatchObject({ busy: false, tone: "ok" });
    expect(h.r.state().message).toBe("Sources refreshed. App events: 2 new, 1 already recorded. Shopify: 3 new, 0 already recorded.");
    expect(h.reloads()).toBe(1);
    const msg = renderToStaticMarkup(<SourceRefreshMessage state={h.r.state()} />);
    expect(msg).toContain("Sources refreshed");
    expect(text(msg)).not.toMatch(CLASSIFY);
  });

  it("partial outcomes never read as a full synchronization", () => {
    const partials = [
      ok({ status: "not_configured", note: "Shopify reading is not configured; only app events were refreshed" }),
      ok({ status: "not_found", note: "No Shopify order has this number" }),
      ok(recorded({ routedHere: false, note: "This order belongs to another site and is not shown here" })),
      ok(recorded({ note: "Shopify routing disagrees with the recorded site; the recorded site was kept", result: { accepted: 0, duplicates: 2, conflicts: 0, route: "conflict" } })),
      ok(recorded({ result: { accepted: 1, duplicates: 0, conflicts: 2, route: "matched" } })),
    ];
    for (const body of partials) {
      const d = describeReconcile(body, R);
      expect(d.tone).toBe("partial");
      expect(d.message).not.toContain("Sources refreshed");
    }
    expect(describeReconcile(partials[0], R).message).toContain("Shopify not refreshed: Shopify reading is not configured");
    expect(describeReconcile(partials[4], R).message).toContain("2 conflicting facts kept as first recorded");
  });

  it("review r1: app conflicts with a clean Shopify read are partial, never green", () => {
    const d = describeReconcile(ok(recorded(), { accepted: 1, duplicates: 0, conflicts: 1, route: "app" }), R);
    expect(d.tone).toBe("partial");
    expect(d.message).toContain("App events: 1 new, 0 already recorded, 1 conflicting fact kept as first recorded.");
    expect(d.message).not.toContain("Sources refreshed");
    const nf = describeReconcile(ok({ status: "not_found", note: "No Shopify order has this number" }, { accepted: 0, duplicates: 0, conflicts: 2, route: "app" }), R);
    expect(nf).toMatchObject({ tone: "partial" });
    expect(nf.message).toContain("2 conflicting facts");
  });

  it("malformed or mismatched answers are an unknown outcome, not success", () => {
    const bad = [
      null, [], "ok", {},
      ok(recorded(), { accepted: 2, duplicates: 1, route: "app" }),
      ok(recorded(), { accepted: 2, duplicates: 1, conflicts: "0", route: "app" }),
      ok(recorded(), { accepted: -1, duplicates: 0, conflicts: 0, route: "app" }),
      ok({ status: "weird" }),
      ok(recorded({ result: null })),
      { ...ok(recorded()), site: "uk" },
      { ...ok(recorded()), orderNumber: "9002" },
    ];
    for (const body of bad) {
      const d = describeReconcile(body, R);
      expect(d.tone).toBe("error");
      expect(d.message).toContain("unknown");
    }
  });

  it("API errors: a Shopify failure after the app copy is partial and reloads; refused requests do not reload", async () => {
    const cases: Array<[Reply, string, boolean, string]> = [
      [{ ok: false, status: 503, body: { error: "Shopify returned 502", code: "SHOPIFY_UNAVAILABLE" } }, "partial", true, "App events were refreshed; Shopify could not be read (Shopify returned 502). Refresh incomplete."],
      [{ ok: false, status: 403, body: { error: "Only an owner can refresh an order's timeline", code: "FORBIDDEN" } }, "error", false, "Refresh sources failed: Only an owner can refresh an order's timeline"],
      [{ ok: false, status: 503, body: { error: "Timeline ingestion is disabled; reconciliation is off", code: "DISABLED" } }, "error", false, "Refresh sources failed: Timeline ingestion is disabled"],
      [{ ok: false, status: 503, body: { error: "The timeline could not record this order", code: "UNAVAILABLE" } }, "error", true, "Some events may already be saved"],
      [{ ok: false, status: 502, body: "<html>" }, "error", true, "request failed (502)"],
      [new Error("Failed to fetch"), "error", true, "outcome unknown (Failed to fetch)"],
    ];
    for (const [reply, tone, reload, message] of cases) {
      const h = harness();
      void h.r.refresh(SCOPE, R);
      await tick();
      h.pending[0](reply);
      await tick();
      expect(h.r.state()).toMatchObject({ busy: false, tone });
      expect(h.r.state().message).toContain(message);
      expect(h.reloads()).toBe(reload ? 1 : 0);
    }
    const noSession = harness({ token: null });
    await noSession.r.refresh(SCOPE, R);
    expect(noSession.calls).toHaveLength(0);
    expect(noSession.r.state()).toMatchObject({ tone: "error", message: "Sign in again to refresh sources." });
  });

  it("a late answer after the user, site or order changed neither paints nor reloads another order", async () => {
    const others = [
      refreshKeyOf("22222222-2222-4222-8222-222222222222|owner|site", R),
      refreshKeyOf(SCOPE, { site: "uk", orderNumber: "#9001" }),
      refreshKeyOf(SCOPE, { site: "au", orderNumber: "9002" }),
      "",
    ];
    for (const next of others) {
      const h = harness();
      void h.r.refresh(SCOPE, R);
      await tick();
      h.setCurrent(next);
      h.r.reset();
      h.pending[0]({ ok: true, status: 200, body: ok(recorded()) });
      await tick();
      expect(h.r.state()).toEqual(idle);
      expect(h.reloads()).toBe(0);
    }
    // identity changed before the reset effect ran: the answer is still dropped
    const h = harness();
    void h.r.refresh(SCOPE, R);
    await tick();
    h.setCurrent(refreshKeyOf(SCOPE, { site: "au", orderNumber: "1" }));
    h.pending[0](new Error("late"));
    await tick();
    expect(h.r.state()).toMatchObject({ key: KEY, busy: true });
    expect(h.reloads()).toBe(0);
  });

  describe("review r1: the in-flight lock is per identity, not the displayed message (A -> B -> A)", () => {
    const B = refreshKeyOf(SCOPE, { site: "au", orderNumber: "9002" });
    async function aba(h: ReturnType<typeof harness>) {
      void h.r.refresh(SCOPE, R);
      await tick();
      h.setCurrent(B);
      h.r.reset();
      h.setCurrent(KEY);
      h.r.reset();
      expect(h.r.state()).toEqual(idle);
      expect(h.r.inFlight()).toEqual([KEY]);
    }

    it("refreshing A again while the first A request is unsettled sends no second POST; the running answer then paints and reloads A once", async () => {
      const h = harness();
      await aba(h);
      void h.r.refresh(SCOPE, R);
      void h.r.refresh(SCOPE, R);
      await tick();
      expect(h.calls).toHaveLength(1);
      expect(h.r.state()).toMatchObject({ key: KEY, busy: true });
      h.pending[0]({ ok: true, status: 200, body: ok(recorded()) });
      await tick();
      expect(h.r.state()).toMatchObject({ key: KEY, busy: false, tone: "ok" });
      expect(h.reloads()).toBe(1);
      expect(h.r.inFlight()).toEqual([]);
    });

    it("an old A answer that completes after A-B-A without a new click neither paints nor reloads, and releases the lock", async () => {
      const h = harness();
      await aba(h);
      h.pending[0]({ ok: true, status: 200, body: ok(recorded()) });
      await tick();
      expect(h.r.state()).toEqual(idle);
      expect(h.reloads()).toBe(0);
      expect(h.r.inFlight()).toEqual([]);
      void h.r.refresh(SCOPE, R);
      await tick();
      expect(h.calls).toHaveLength(2);
    });

    it("an old A request that rejects after A-B-A releases the lock silently; the next refresh is a new POST", async () => {
      const h = harness();
      await aba(h);
      h.pending[0](new Error("Failed to fetch"));
      await tick();
      expect(h.r.state()).toEqual(idle);
      expect(h.reloads()).toBe(0);
      expect(h.r.inFlight()).toEqual([]);
      void h.r.refresh(SCOPE, R);
      await tick();
      expect(h.calls).toHaveLength(2);
      h.pending[1]({ ok: true, status: 200, body: ok(recorded()) });
      await tick();
      expect(h.r.state()).toMatchObject({ tone: "ok" });
      expect(h.reloads()).toBe(1);
    });

    it("review r2: a deferred session token resolving after a user/site/order change sends no POST, reload or message", async () => {
      const others = [refreshKeyOf("22222222-2222-4222-8222-222222222222|owner|site", R), refreshKeyOf(SCOPE, { site: "uk", orderNumber: "#9001" }), B];
      for (const next of others) {
        let open!: () => void;
        const h = harness({ tokenGate: new Promise<void>((r) => (open = r)) });
        const done = h.r.refresh(SCOPE, R);
        await tick();
        h.setCurrent(next);
        h.r.reset();
        open();
        await done;
        expect(h.calls).toHaveLength(0);
        expect(h.reloads()).toBe(0);
        expect(h.r.state()).toEqual(idle);
        expect(h.r.inFlight()).toEqual([]);
      }
      // A -> B -> A and asking again while the token is pending re-attaches: exactly one POST, which then paints
      let open!: () => void;
      const h = harness({ tokenGate: new Promise<void>((r) => (open = r)) });
      void h.r.refresh(SCOPE, R);
      await tick();
      h.setCurrent(B);
      h.r.reset();
      h.setCurrent(KEY);
      h.r.reset();
      void h.r.refresh(SCOPE, R);
      open();
      await tick();
      expect(h.calls).toHaveLength(1);
      h.pending[0]({ ok: true, status: 200, body: ok(recorded()) });
      await tick();
      expect(h.r.state()).toMatchObject({ key: KEY, tone: "ok" });
      expect(h.reloads()).toBe(1);
      expect(h.r.inFlight()).toEqual([]);
    });

    it("A and B may each have one request; B's answer never paints on A", async () => {
      const h = harness();
      void h.r.refresh(SCOPE, R);
      await tick();
      h.setCurrent(B);
      h.r.reset();
      void h.r.refresh(SCOPE, { site: "au", orderNumber: "9002" });
      await tick();
      expect(h.calls).toHaveLength(2);
      h.setCurrent(KEY);
      h.r.reset();
      h.pending[1]({ ok: true, status: 200, body: { ...ok(recorded()), orderNumber: "9002" } });
      h.pending[0]({ ok: true, status: 200, body: ok(recorded()) });
      await tick();
      expect(h.r.state()).toEqual(idle);
      expect(h.reloads()).toBe(0);
      expect(h.r.inFlight()).toEqual([]);
    });
  });
});
