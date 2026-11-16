/**
 * Task 17: published management views (controller behind usePublishedProduction)
 * and the browser fetch layer, with a scripted fetch. The network trace proves
 * management loads only the authorized published endpoints (no raw history).
 */
import { describe, expect, it } from "vitest";
import { detailKey, identityKey, PublishedViewController, type PublishedIdentity } from "../../src/lib/hooks/usePublishedProduction";
import { fetchPublishedSummary, PublishedReadError, type FetchLike } from "../../src/lib/repository/supabase/productionPublished";
import type { SummaryResult } from "../../src/lib/domain/productionReporting";

const ID: PublishedIdentity = { userId: "u1", site: "uk", view: "reports", firstDate: "2026-11-01", lastDate: "2026-11-16" };
const summary = (generationId: string, items = 4, state: "current" | "delayed" | "outdated" = "current"): SummaryResult =>
  ({ meta: { generationId, state }, totals: { normal: { items, orders: 1 }, rework: { items: 0, orders: 0 } } }) as unknown as SummaryResult;

type Reply = { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
function scripted(handler: (url: string) => Reply) {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    urls.push(url);
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.cache).toBe("no-store");
    const r = await handler(url);
    return { status: r.status, ok: r.status < 400, json: async () => r.body };
  };
  return { urls, ctrl: new PublishedViewController({ fetch: fetchImpl, token: async () => "tok" }) };
}
const param = (url: string, k: string) => new URL(url, "http://x").searchParams.get(k);

describe("Task 17: published view controller", () => {
  it("loads one generation; only the published summary endpoint is called (no raw history)", async () => {
    const { urls, ctrl } = scripted(() => ({ status: 200, body: summary("g1") }));
    await ctrl.load(ID);
    expect(ctrl.get()).toMatchObject({ status: "current", summary: { meta: { generationId: "g1" } }, error: null });
    expect(urls).toHaveLength(1);
    expect(urls.every((u) => u.startsWith("/api/reports/summary?"))).toBe(true);
    expect(param(urls[0], "generationId")).toBeNull();
  });
  it("a delayed/outdated generation is shown as stale with its numbers, never zeroed", async () => {
    const { ctrl } = scripted(() => ({ status: 200, body: summary("g1", 7, "outdated") }));
    await ctrl.load(ID);
    expect(ctrl.get()).toMatchObject({ status: "stale", summary: { totals: { normal: { items: 7 } } } });
  });
  it("changing identity clears the old result at once and discards its late response", async () => {
    let release!: (v: { status: number; body: unknown }) => void;
    const slow = new Promise<{ status: number; body: unknown }>((r) => (release = r));
    const { ctrl } = scripted((url) => (param(url, "site") === "uk" ? slow : { status: 200, body: summary("g-au") }));
    const first = ctrl.load(ID);
    await ctrl.load({ ...ID, site: "au" });
    expect(ctrl.get()).toMatchObject({ identityKey: identityKey({ ...ID, site: "au" }), summary: { meta: { generationId: "g-au" } } });
    release({ status: 200, body: summary("g-uk") });
    await first;
    expect(ctrl.get().summary?.meta.generationId).toBe("g-au");
    const { ctrl: c2 } = scripted(() => ({ status: 200, body: summary("g1") }));
    await c2.load(ID);
    let hold!: () => void;
    const pending = c2.load({ ...ID, userId: "u2" });
    expect(c2.get()).toMatchObject({ status: "loading", summary: null }); // the other user's data is gone immediately
    void hold;
    await pending;
  });
  it("a refresh pins the current generation; a failed refresh keeps the previous result, marked stale", async () => {
    let n = 0;
    const { urls, ctrl } = scripted(() => (++n === 1 ? { status: 200, body: summary("g1") } : { status: 503, body: { error: "No published report", code: "UNAVAILABLE" } }));
    await ctrl.load(ID);
    await ctrl.load(ID);
    expect(param(urls[1], "generationId")).toBe("g1");
    expect(ctrl.get()).toMatchObject({ status: "stale", summary: { meta: { generationId: "g1" } }, error: "No published report" });
  });
  it("an expired pinned generation (410) reloads the WHOLE view at the current one and drops pages of the old one", async () => {
    let n = 0;
    const { urls, ctrl } = scripted((url) => {
      if (url.startsWith("/api/reports/detail")) return { status: 200, body: { rows: [{ kind: "orders", row: { n: 1 } }], nextCursor: "c1", pageComplete: true, totalRows: 2 } };
      n++;
      if (n === 1) return { status: 200, body: summary("g1") };
      if (param(url, "generationId") === "g1") return { status: 410, body: { error: "expired", code: "GENERATION_EXPIRED" } };
      return { status: 200, body: summary("g2", 9) };
    });
    await ctrl.load(ID);
    await ctrl.nextPage(ID, "orders");
    expect(ctrl.get().details[detailKey("orders")]?.rows).toHaveLength(1);
    await ctrl.load(ID);
    expect(ctrl.get()).toMatchObject({ status: "current", summary: { meta: { generationId: "g2" }, totals: { normal: { items: 9 } } }, details: {} });
    expect(ctrl.get().details).toEqual({}); // no page of the old generation survives
    expect(urls.filter((u) => u.startsWith("/api/reports/summary")).map((u) => param(u, "generationId"))).toEqual([null, "g1", null]);
  });
  it("detail pages stay in the summary's generation; totals never come from loaded pages; a stale cursor reloads the view", async () => {
    let pages = 0;
    const { urls, ctrl } = scripted((url) => {
      if (url.startsWith("/api/reports/summary")) return { status: 200, body: summary("g1", 40) };
      pages++;
      if (pages === 3) return { status: 400, body: { error: "bad cursor", code: "BAD_CURSOR" } };
      return { status: 200, body: { rows: [{ kind: "orders", row: { n: pages } }], nextCursor: pages < 5 ? `c${pages}` : null, pageComplete: true, totalRows: 5 } };
    });
    await ctrl.load(ID);
    await ctrl.nextPage(ID, "orders", 1);
    await ctrl.nextPage(ID, "orders", 1);
    expect(ctrl.get().details[detailKey("orders")]).toMatchObject({ totalRows: 5, nextCursor: "c2" });
    expect(ctrl.get().summary?.totals.normal.items).toBe(40);
    const details = urls.filter((u) => u.startsWith("/api/reports/detail"));
    expect(details.map((u) => [param(u, "generationId"), param(u, "cursor")])).toEqual([["g1", null], ["g1", "c1"]]);
    await ctrl.nextPage(ID, "orders", 1); // BAD_CURSOR → whole-view reload
    expect(urls.at(-1)!.startsWith("/api/reports/summary")).toBe(true);
  });
  it("a site not yet on published reads reports `legacy` (the page keeps its existing path); other errors stay errors", async () => {
    const { ctrl } = scripted(() => ({ status: 503, body: { error: "not enabled", code: "READ_MODE_LEGACY" } }));
    await ctrl.load(ID);
    expect(ctrl.get()).toMatchObject({ status: "legacy", summary: null });
    const { ctrl: c2 } = scripted(() => ({ status: 403, body: { error: "No membership for this site", code: "FORBIDDEN" } }));
    await c2.load(ID);
    expect(c2.get()).toMatchObject({ status: "error", summary: null, error: "No membership for this site" });
  });
  it("no session: nothing is fetched", async () => {
    const urls: string[] = [];
    const ctrl = new PublishedViewController({ fetch: async (u) => (urls.push(u), { status: 200, ok: true, json: async () => ({}) }), token: async () => null });
    await ctrl.load(ID);
    expect(ctrl.get().status).toBe("error");
    expect(urls).toEqual([]);
  });
});

describe("Task 17: browser fetch layer", () => {
  it("encodes only given parameters and maps typed failures", async () => {
    const urls: string[] = [];
    const f: FetchLike = async (u) => (urls.push(u), { status: 410, ok: false, json: async () => ({ error: "expired", code: "GENERATION_EXPIRED" }) });
    const e = await fetchPublishedSummary(f, "tok", { site: "uk", firstDate: "2026-11-01", lastDate: "2026-11-02", view: "welcome", workType: "framed" }).catch((x) => x);
    expect(e).toBeInstanceOf(PublishedReadError);
    expect(e).toMatchObject({ status: 410, code: "GENERATION_EXPIRED", expired: true, legacyMode: false });
    expect(urls[0]).toBe("/api/reports/summary?site=uk&firstDate=2026-11-01&lastDate=2026-11-02&view=welcome&workType=framed");
    const bad: FetchLike = async () => ({ status: 500, ok: false, json: async () => { throw new Error("html"); } });
    await expect(fetchPublishedSummary(bad, "t", { site: "uk", firstDate: "2026-11-01", lastDate: "2026-11-02", view: "reports" })).rejects.toMatchObject({ status: 500, code: "HTTP_500" });
  });
});

describe("Task 17 review: detail pages are keyed by the complete selector and guarded in flight", () => {
  it("switching orderNumber never reuses another selector's cursor or rows", async () => {
    const { urls, ctrl } = scripted((url) => {
      if (url.startsWith("/api/reports/summary")) return { status: 200, body: summary("g1") };
      const o = param(url, "orderNumber");
      const c = param(url, "cursor");
      return { status: 200, body: { rows: [{ kind: "events", row: { o, c } }], nextCursor: c ? null : `next-${o}`, pageComplete: true, totalRows: 2 } };
    });
    await ctrl.load(ID);
    await ctrl.nextPage(ID, "events", 1, "A");
    await ctrl.nextPage(ID, "events", 1, "A");
    await ctrl.nextPage(ID, "events", 1, "B");
    const det = urls.filter((u) => u.startsWith("/api/reports/detail")).map((u) => [param(u, "orderNumber"), param(u, "cursor")]);
    expect(det).toEqual([["A", null], ["A", "next-A"], ["B", null]]);
    expect(ctrl.get().details[detailKey("events", "A")]?.rows).toHaveLength(2);
    expect(ctrl.get().details[detailKey("events", "B")]?.rows).toHaveLength(1);
    await ctrl.nextPage(ID, "events", 1, "A"); // A is complete (null cursor): nothing fetched
    expect(urls.filter((u) => u.startsWith("/api/reports/detail"))).toHaveLength(3);
  });
  it("concurrent nextPage calls for one selector send ONE request and append ONE page", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { urls, ctrl } = scripted(async (url) => {
      if (url.startsWith("/api/reports/summary")) return { status: 200, body: summary("g1") };
      await gate;
      return { status: 200, body: { rows: [{ kind: "orders", row: { n: 1 } }], nextCursor: "c1", pageComplete: true, totalRows: 3 } };
    });
    await ctrl.load(ID);
    const a = ctrl.nextPage(ID, "orders", 1);
    const b = ctrl.nextPage(ID, "orders", 1);
    release();
    await Promise.all([a, b]);
    expect(urls.filter((u) => u.startsWith("/api/reports/detail"))).toHaveLength(1);
    expect(ctrl.get().details[detailKey("orders")]?.rows).toHaveLength(1);
  });
  it("a page that lands after the identity changed is discarded", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { ctrl } = scripted(async (url) => {
      if (url.startsWith("/api/reports/summary")) return { status: 200, body: summary(param(url, "site") === "uk" ? "g-uk" : "g-au") };
      await gate;
      return { status: 200, body: { rows: [{ kind: "orders", row: {} }], nextCursor: null, pageComplete: true, totalRows: 1 } };
    });
    await ctrl.load(ID);
    const late = ctrl.nextPage(ID, "orders");
    await ctrl.load({ ...ID, site: "au" });
    release();
    await late;
    expect(ctrl.get().summary?.meta.generationId).toBe("g-au");
    expect(ctrl.get().details).toEqual({});
  });
});
