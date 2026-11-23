/** F10 UI seams: request scope (no stale order/site), rendered states and labels, role visibility. */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { automationContext, effectiveRequest, OrderTimelineView, timelineQuery, type OrderTimelineView as TimelineData, type TimelineRequest } from "../../src/components/OrderTimelineCard";
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
