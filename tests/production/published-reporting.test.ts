/**
 * Task 17: published management views (controller behind usePublishedProduction)
 * and the browser fetch layer, with a scripted fetch. The network trace proves
 * management loads only the authorized published endpoints (no raw history).
 */
import { readFileSync } from "node:fs";
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
  it("an ordinary refresh is UNPINNED: it discovers a newer generation and drops the old generation's pages", async () => {
    let n = 0;
    const { urls, ctrl } = scripted((url) => {
      if (url.startsWith("/api/reports/detail")) return { status: 200, body: { rows: [{ kind: "orders", row: { n: 1 } }], nextCursor: "c1", pageComplete: true, totalRows: 2 } };
      return ++n === 1 ? { status: 200, body: summary("g1") } : { status: 200, body: summary("g2", 9) };
    });
    await ctrl.load(ID);
    await ctrl.nextPage(ID, "orders");
    await ctrl.load(ID); // refresh
    const sums = urls.filter((u) => u.startsWith("/api/reports/summary"));
    expect(sums.map((u) => param(u, "generationId"))).toEqual([null, null]); // never pinned to the displayed generation
    expect(ctrl.get()).toMatchObject({ status: "current", summary: { meta: { generationId: "g2" }, totals: { normal: { items: 9 } } }, details: {} });
  });
  it("a refresh that returns the SAME generation keeps its loaded pages; a failed refresh keeps the previous result, marked stale", async () => {
    let n = 0;
    const { urls, ctrl } = scripted((url) => {
      if (url.startsWith("/api/reports/detail")) return { status: 200, body: { rows: [{ kind: "orders", row: { n: 1 } }], nextCursor: "c1", pageComplete: true, totalRows: 2 } };
      n++;
      return n <= 2 ? { status: 200, body: summary("g1") } : { status: 503, body: { error: "No published report", code: "UNAVAILABLE" } };
    });
    await ctrl.load(ID);
    await ctrl.nextPage(ID, "orders");
    await ctrl.load(ID);
    expect(ctrl.get().details[detailKey("orders")]?.rows).toHaveLength(1);
    await ctrl.load(ID);
    expect(urls.filter((u) => u.startsWith("/api/reports/summary")).every((u) => param(u, "generationId") === null)).toBe(true);
    expect(ctrl.get()).toMatchObject({ status: "stale", summary: { meta: { generationId: "g1" } }, error: "No published report" });
  });
  it("an expired generation on a detail page (410) reloads the WHOLE view at the latest generation, unpinned, and drops pages of the old one", async () => {
    let n = 0;
    let d = 0;
    const { urls, ctrl } = scripted((url) => {
      if (url.startsWith("/api/reports/detail")) {
        d++;
        return d === 1 ? { status: 200, body: { rows: [{ kind: "orders", row: { n: 1 } }], nextCursor: "c1", pageComplete: true, totalRows: 2 } } : { status: 410, body: { error: "expired", code: "GENERATION_EXPIRED" } };
      }
      return ++n === 1 ? { status: 200, body: summary("g1") } : { status: 200, body: summary("g2", 9) };
    });
    await ctrl.load(ID);
    await ctrl.nextPage(ID, "orders");
    expect(ctrl.get().details[detailKey("orders")]?.rows).toHaveLength(1);
    await ctrl.nextPage(ID, "orders"); // 410 → whole-view reload
    expect(ctrl.get()).toMatchObject({ status: "current", summary: { meta: { generationId: "g2" }, totals: { normal: { items: 9 } } } });
    expect(ctrl.get().details).toEqual({}); // no page of the old generation survives
    expect(urls.filter((u) => u.startsWith("/api/reports/summary")).map((u) => param(u, "generationId"))).toEqual([null, null]);
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
    expect(param(urls.at(-1)!, "generationId")).toBeNull(); // the reload fetches the LATEST summary, not the stale generation
    expect(ctrl.get().details).toEqual({}); // the stale cursor's pages are dropped even though the generation is unchanged
    await ctrl.nextPage(ID, "orders", 1);
    expect(param(urls.at(-1)!, "cursor")).toBeNull(); // paging restarts from the first page, never from the stale cursor
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

describe("Task 17 refresh semantics: unpinned refresh, pinned detail, whole-view reload, identity discard", () => {
  it("detail requests stay pinned to the DISPLAYED generation, including while a refresh is in flight", async () => {
    let release!: (v: { status: number; body: unknown }) => void;
    let n = 0;
    const { urls, ctrl } = scripted((url) => {
      if (url.startsWith("/api/reports/detail")) return { status: 200, body: { rows: [{ kind: "orders", row: { n: 1 } }], nextCursor: "c1", pageComplete: true, totalRows: 3 } };
      return ++n === 1 ? { status: 200, body: summary("g1") } : new Promise((r) => (release = r));
    });
    await ctrl.load(ID);
    const refreshing = ctrl.load(ID); // the newer summary is still in flight
    await ctrl.nextPage(ID, "orders");
    expect(param(urls.filter((u) => u.startsWith("/api/reports/detail")).at(-1)!, "generationId")).toBe("g1"); // the generation on screen
    release({ status: 200, body: summary("g2") });
    await refreshing;
    expect(ctrl.get().summary?.meta.generationId).toBe("g2");
    await ctrl.nextPage(ID, "orders");
    expect(param(urls.filter((u) => u.startsWith("/api/reports/detail")).at(-1)!, "generationId")).toBe("g2");
  });
  it("a stale cursor reloads the whole view to a NEWER generation when one exists", async () => {
    let n = 0;
    let d = 0;
    const { urls, ctrl } = scripted((url) => {
      if (url.startsWith("/api/reports/detail")) {
        d++;
        return d === 1 ? { status: 200, body: { rows: [{ kind: "orders", row: { n: 1 } }], nextCursor: "c1", pageComplete: true, totalRows: 2 } } : { status: 400, body: { error: "bad cursor", code: "BAD_CURSOR" } };
      }
      return ++n === 1 ? { status: 200, body: summary("g1") } : { status: 200, body: summary("g2", 9) };
    });
    await ctrl.load(ID);
    await ctrl.nextPage(ID, "orders");
    await ctrl.nextPage(ID, "orders");
    expect(urls.filter((u) => u.startsWith("/api/reports/summary")).map((u) => param(u, "generationId"))).toEqual([null, null]);
    expect(ctrl.get()).toMatchObject({ status: "current", summary: { meta: { generationId: "g2" } }, details: {} });
  });
  it("an old in-flight summary for a previous date range is discarded after the view identity changes", async () => {
    let release!: (v: { status: number; body: unknown }) => void;
    const slow = new Promise<{ status: number; body: unknown }>((r) => (release = r));
    const { ctrl } = scripted((url) => (param(url, "firstDate") === "2026-11-01" ? slow : { status: 200, body: summary("g-new") }));
    const first = ctrl.load(ID);
    const NEXT = { ...ID, firstDate: "2026-11-10" };
    await ctrl.load(NEXT);
    release({ status: 200, body: summary("g-old", 99) });
    await first;
    expect(ctrl.get()).toMatchObject({ identityKey: identityKey(NEXT), summary: { meta: { generationId: "g-new" } } });
    expect(ctrl.get().summary?.totals.normal.items).toBe(4);
  });
  it("a stale-cursor failure that lands after the identity changed never reloads (or touches) the old view", async () => {
    let release!: (v: { status: number; body: unknown }) => void;
    const { urls, ctrl } = scripted((url) => {
      if (url.startsWith("/api/reports/detail")) return new Promise((r) => (release = r));
      return { status: 200, body: summary(param(url, "site") === "au" ? "g-au" : "g-uk") };
    });
    await ctrl.load(ID);
    const page = ctrl.nextPage(ID, "orders");
    await new Promise((r) => setTimeout(r, 0));
    await ctrl.load({ ...ID, site: "au" });
    const before = urls.length;
    release({ status: 400, body: { error: "bad cursor", code: "BAD_CURSOR" } });
    await page;
    expect(urls.length).toBe(before); // no reload of the old (uk) view
    expect(ctrl.get()).toMatchObject({ identityKey: identityKey({ ...ID, site: "au" }), summary: { meta: { generationId: "g-au" } }, error: null });
  });
});

describe("Task 17 refresh semantics: a failed whole-view reload never keeps a stale cursor", () => {
  it("BAD_CURSOR triggers the unpinned reload; the reload fails (503): the summary stays visible as stale with the error, but no detail page or cursor survives", async () => {
    let n = 0;
    let d = 0;
    const { urls, ctrl } = scripted((url) => {
      if (url.startsWith("/api/reports/detail")) {
        d++;
        return d === 1 ? { status: 200, body: { rows: [{ kind: "orders", row: { n: 1 } }], nextCursor: "c1", pageComplete: true, totalRows: 2 } } : { status: 400, body: { error: "bad cursor", code: "BAD_CURSOR" } };
      }
      return ++n === 1 ? { status: 200, body: summary("g1", 40) } : { status: 503, body: { error: "No published report", code: "UNAVAILABLE" } };
    });
    await ctrl.load(ID);
    await ctrl.nextPage(ID, "orders");
    expect(ctrl.get().details[detailKey("orders")]).toMatchObject({ nextCursor: "c1" });
    await ctrl.nextPage(ID, "orders"); // BAD_CURSOR → unpinned whole-view reload → 503
    const sums = urls.filter((u) => u.startsWith("/api/reports/summary"));
    expect(sums.map((u) => param(u, "generationId"))).toEqual([null, null]); // the reload was attempted, unpinned
    expect(ctrl.get()).toMatchObject({ status: "stale", error: "No published report", summary: { meta: { generationId: "g1" }, totals: { normal: { items: 40 } } } });
    expect(ctrl.get().details).toEqual({}); // the stale cursor is gone
    await ctrl.nextPage(ID, "orders");
    expect(param(urls.at(-1)!, "cursor")).toBeNull(); // the next page request restarts from the first page
  });
});

describe("Task 17: days/people detail paging continues the summary's own first pages", () => {
  const paged = (people: string | null, days: string | null) =>
    ({ ...summary("g1"), peoplePage: { rows: [{ staffId: "p1" }, { staffId: "p2" }], nextCursor: people, pageComplete: true, totalRows: people ? 3 : 2 }, dailyPage: { rows: [{ productionDate: "2026-11-01" }], nextCursor: days, pageComplete: true, totalRows: days ? 2 : 1 } }) as unknown as SummaryResult;
  const page = (n: number, next: string | null) => ({ status: 200, body: { rows: [{ kind: "people", row: { staffId: `p${n}` } }], nextCursor: next, pageComplete: true, totalRows: 3 } });
  it("the first people/days page starts at the summary's nextCursor (never page 1 again: no duplicate rows)", async () => {
    const { urls, ctrl } = scripted((url) => (url.startsWith("/api/reports/detail") ? page(3, null) : { status: 200, body: paged("cur-people", "cur-days") }));
    await ctrl.load(ID);
    await ctrl.nextPage(ID, "people");
    await ctrl.nextPage(ID, "days");
    const details = urls.filter((u) => u.startsWith("/api/reports/detail"));
    expect(details.map((u) => [param(u, "kind"), param(u, "cursor"), param(u, "generationId")])).toEqual([["people", "cur-people", "g1"], ["days", "cur-days", "g1"]]);
    expect(ctrl.get().details[detailKey("people")]).toMatchObject({ rows: [{ row: { staffId: "p3" } }], nextCursor: null });
    await ctrl.nextPage(ID, "people"); // now complete: nothing more is fetched
    expect(urls.filter((u) => u.startsWith("/api/reports/detail"))).toHaveLength(2);
  });
  it("a summary page that already holds every row (nextCursor null) fetches nothing", async () => {
    const { urls, ctrl } = scripted(() => ({ status: 200, body: paged(null, null) }));
    await ctrl.load(ID);
    await ctrl.nextPage(ID, "people");
    await ctrl.nextPage(ID, "days");
    expect(urls.filter((u) => u.startsWith("/api/reports/detail"))).toEqual([]);
    expect(ctrl.get().details).toEqual({});
  });
  it("later pages follow the previous page's cursor; other kinds still start at their first page", async () => {
    const { urls, ctrl } = scripted((url) => {
      if (!url.startsWith("/api/reports/detail")) return { status: 200, body: paged("cur-people", null) };
      return param(url, "kind") === "orders" ? { status: 200, body: { rows: [], nextCursor: null, pageComplete: true, totalRows: 0 } } : page(3, param(url, "cursor") === "cur-people" ? "cur-2" : null);
    });
    await ctrl.load(ID);
    await ctrl.nextPage(ID, "people");
    await ctrl.nextPage(ID, "people");
    await ctrl.nextPage(ID, "orders");
    expect(urls.filter((u) => u.startsWith("/api/reports/detail")).map((u) => [param(u, "kind"), param(u, "cursor")])).toEqual([["people", "cur-people"], ["people", "cur-2"], ["orders", null]]);
  });
});

describe("Task 17: clearing the view (identity becomes null) invalidates everything in flight", () => {
  const EMPTY_STATE = { status: "idle", identityKey: null, summary: null, error: null, details: {} };
  it("a slow summary that resolves after reset never repopulates the old view", async () => {
    let release!: (v: { status: number; body: unknown }) => void;
    const { ctrl } = scripted(() => new Promise((r) => (release = r)));
    const slow = ctrl.load(ID);
    expect(ctrl.get().status).toBe("loading");
    await new Promise((r) => setTimeout(r, 0)); // the request is genuinely in flight
    ctrl.reset();
    expect(ctrl.get()).toEqual(EMPTY_STATE);
    release({ status: 200, body: summary("g-old", 77) });
    await slow;
    expect(ctrl.get()).toEqual(EMPTY_STATE);
  });
  it("a slow failure after reset is discarded too (no error state for a cleared view)", async () => {
    let release!: (v: { status: number; body: unknown }) => void;
    const { ctrl } = scripted(() => new Promise((r) => (release = r)));
    const slow = ctrl.load(ID);
    await new Promise((r) => setTimeout(r, 0)); // the request is genuinely in flight
    ctrl.reset();
    release({ status: 503, body: { error: "No published report", code: "UNAVAILABLE" } });
    await slow;
    expect(ctrl.get()).toEqual(EMPTY_STATE);
  });
  it("a slow detail page that resolves after reset never brings back the old summary or its pages", async () => {
    let release!: (v: { status: number; body: unknown }) => void;
    const { ctrl } = scripted((url) => (url.startsWith("/api/reports/detail") ? new Promise((r) => (release = r)) : { status: 200, body: summary("g1") }));
    await ctrl.load(ID);
    const page = ctrl.nextPage(ID, "orders");
    await new Promise((r) => setTimeout(r, 0));
    ctrl.reset();
    release({ status: 200, body: { rows: [{ kind: "orders", row: { n: 1 } }], nextCursor: null, pageComplete: true, totalRows: 1 } });
    await page;
    expect(ctrl.get()).toEqual(EMPTY_STATE);
  });
  it("after reset, a later valid identity loads normally (listeners stay subscribed)", async () => {
    let n = 0;
    const { urls, ctrl } = scripted(() => ({ status: 200, body: summary(++n === 1 ? "g1" : "g2", 9) }));
    const seen: string[] = [];
    ctrl.subscribe(() => seen.push(ctrl.get().status));
    await ctrl.load(ID);
    ctrl.reset();
    await ctrl.load({ ...ID, site: "au" });
    expect(ctrl.get()).toMatchObject({ status: "current", identityKey: identityKey({ ...ID, site: "au" }), summary: { meta: { generationId: "g2" } }, details: {} });
    expect(seen).toContain("idle"); // the reset was published to subscribers
    expect(seen.at(-1)).toBe("current");
    expect(urls.every((u) => u.startsWith("/api/reports/summary"))).toBe(true);
  });
  it("the hook resets the controller when its identity becomes null (sign-out, unsupported site, no range)", () => {
    const src = readFileSync("src/lib/hooks/usePublishedProduction.ts", "utf8");
    const end = src.indexOf("}, [ctrl, key, refreshKey]);");
    const effect = src.slice(src.lastIndexOf("useEffect(() => {", end), end);
    expect(effect).toMatch(/if \(!idRef\.current\) \{[^}]*ctrl\?\.reset\(\)/);
  });
});

describe("Task 17: selected-staff orders are lazy and page within the displayed generation", () => {
  const STAFF = { ...ID, staffId: "11111111-1111-4111-8111-111111111111" };
  it("no orders request on mount; Load orders fetches page 1 for the selected person; Load more follows its cursor", async () => {
    const { urls, ctrl } = scripted((url) => {
      if (!url.startsWith("/api/reports/detail")) return { status: 200, body: summary("g1") };
      return { status: 200, body: { rows: [{ kind: "orders", row: { key: `uk|O-${param(url, "cursor") ?? "1"}` } }], nextCursor: param(url, "cursor") ? null : "co-1", pageComplete: true, totalRows: 2 } };
    });
    await ctrl.load(STAFF);
    expect(urls.filter((u) => u.startsWith("/api/reports/detail"))).toEqual([]); // nothing on mount
    await ctrl.nextPage(STAFF, "orders");
    await ctrl.nextPage(STAFF, "orders");
    const d = urls.filter((u) => u.startsWith("/api/reports/detail"));
    expect(d.map((u) => [param(u, "kind"), param(u, "staffId"), param(u, "generationId"), param(u, "cursor")])).toEqual([["orders", STAFF.staffId, "g1", null], ["orders", STAFF.staffId, "g1", "co-1"]]);
    expect(ctrl.get().details[detailKey("orders")]).toMatchObject({ nextCursor: null, totalRows: 2 });
    expect(ctrl.get().summary?.totals.normal.orders).toBe(1); // totals stay the summary's
  });
});

describe("Task 17: collectAll - the published raw-export collector", () => {
  const rawRow = (n: number) => ({ kind: "raw-export", row: { id: `e${n}`, note: n === 1 ? "" : `note ${n}`, stationId: n === 2 ? null : "s1" } });
  const pages = (n: number, size: number, total = n * size) => (url: string) => {
    const at = Number(param(url, "cursor") ?? "0");
    const rows = Array.from({ length: Math.min(size, total - at * size) }, (_, i) => rawRow(at * size + i + 1));
    return { status: 200, body: { rows, nextCursor: at + 1 < n ? String(at + 1) : null, pageComplete: true, totalRows: total } };
  };
  function harness(detail: (url: string) => Reply, sums: () => Reply = () => ({ status: 200, body: summary("g1") })) {
    const urls: string[] = [];
    let tokens = 0;
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      const r = await (url.startsWith("/api/reports/detail") ? detail(url) : sums());
      return { status: r.status, ok: r.status < 400, json: async () => r.body };
    };
    const ctrl = new PublishedViewController({ fetch: fetchImpl, token: async () => (tokens++, "tok") });
    return { urls, ctrl, tokens: () => tokens };
  }
  it("collects every page of the displayed generation with limit <= 1000, a fresh token per page, and returns the rows (state untouched)", async () => {
    const h = harness(pages(3, 2));
    await h.ctrl.load(ID);
    const before = h.tokens();
    const rows = await h.ctrl.collectAll(ID, "raw-export", { limit: 5000 });
    expect(rows.map((r) => (r.row as { id: string }).id)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"]);
    const d = h.urls.filter((u) => u.startsWith("/api/reports/detail"));
    expect(d.map((u) => [param(u, "kind"), param(u, "generationId"), param(u, "limit"), param(u, "cursor")])).toEqual([["raw-export", "g1", "1000", null], ["raw-export", "g1", "1000", "1"], ["raw-export", "g1", "1000", "2"]]);
    expect(h.tokens() - before).toBe(3); // reauthorized per page
    expect(h.ctrl.get().details).toEqual({}); // export rows are not kept in the view
  });
  it("an invalid limit, no summary, or a request for another view is refused before any request", async () => {
    const h = harness(pages(1, 1));
    await expect(h.ctrl.collectAll(ID, "raw-export")).rejects.toMatchObject({ code: "NO_REPORT" });
    await h.ctrl.load(ID);
    for (const limit of [0, -1, 1.5, Number.NaN]) await expect(h.ctrl.collectAll(ID, "raw-export", { limit })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(h.ctrl.collectAll({ ...ID, site: "au" }, "raw-export")).rejects.toMatchObject({ code: "VIEW_CHANGED" }); // not the displayed view
    expect(h.urls.filter((u) => u.startsWith("/api/reports/detail"))).toEqual([]);
  });
  it("a typed page failure rejects the whole collection (no partial rows)", async () => {
    const h = harness((url) => (param(url, "cursor") === "1" ? { status: 503, body: { error: "No published report", code: "UNAVAILABLE" } } : pages(3, 2)(url)));
    await h.ctrl.load(ID);
    await expect(h.ctrl.collectAll(ID, "raw-export")).rejects.toMatchObject({ code: "UNAVAILABLE", status: 503 });
  });
  it("an identity change mid-export rejects; a generation change rejects; a same-generation refresh does not", async () => {
    let release!: (v: { status: number; body: unknown }) => void;
    const slow = (url: string): Reply => (param(url, "cursor") === "1" ? new Promise((r) => (release = r)) : pages(2, 2)(url));
    const page2 = pages(2, 2)("/api/reports/detail?cursor=1") as { status: number; body: unknown };
    const a = harness(slow);
    await a.ctrl.load(ID);
    const p1 = a.ctrl.collectAll(ID, "raw-export");
    await new Promise((r) => setTimeout(r, 0));
    await a.ctrl.load({ ...ID, site: "au" });
    release(page2);
    await expect(p1).rejects.toMatchObject({ code: "VIEW_CHANGED" });

    let n = 0;
    const b = harness(slow, () => ({ status: 200, body: summary(++n === 1 ? "g1" : "g2") }));
    await b.ctrl.load(ID);
    const p2 = b.ctrl.collectAll(ID, "raw-export");
    await new Promise((r) => setTimeout(r, 0));
    await b.ctrl.load(ID); // a refresh discovers g2
    release(page2);
    await expect(p2).rejects.toMatchObject({ code: "VIEW_CHANGED" });

    const c = harness(slow);
    await c.ctrl.load(ID);
    const p3 = c.ctrl.collectAll(ID, "raw-export");
    await new Promise((r) => setTimeout(r, 0));
    await c.ctrl.load(ID); // the same generation again
    release(page2);
    expect((await p3).length).toBe(4);
  });
  it("reset mid-export rejects and nothing further is requested", async () => {
    let release!: (v: { status: number; body: unknown }) => void;
    const h = harness((url) => (param(url, "cursor") === "1" ? new Promise((r) => (release = r)) : pages(3, 2)(url)));
    await h.ctrl.load(ID);
    const p = h.ctrl.collectAll(ID, "raw-export");
    await new Promise((r) => setTimeout(r, 0));
    h.ctrl.reset();
    release(pages(3, 2)("/api/reports/detail?cursor=1") as { status: number; body: unknown });
    await expect(p).rejects.toMatchObject({ code: "VIEW_CHANGED" });
    expect(h.urls.filter((u) => u.startsWith("/api/reports/detail"))).toHaveLength(2);
  });
  it("refuses cursor loops and non-progress: a repeated cursor, an empty page with a cursor, too many rows, a changing total, a short end", async () => {
    const cases: Array<[string, (url: string) => Reply]> = [
      ["repeated cursor", () => ({ status: 200, body: { rows: [rawRow(1)], nextCursor: "same", pageComplete: true, totalRows: 9 } })],
      ["empty page with a cursor", () => ({ status: 200, body: { rows: [], nextCursor: "x", pageComplete: true, totalRows: 9 } })],
      ["more rows than totalRows", () => ({ status: 200, body: { rows: [rawRow(1), rawRow(2)], nextCursor: null, pageComplete: true, totalRows: 1 } })],
      ["a changing total", (url) => ({ status: 200, body: { rows: [rawRow(1)], nextCursor: param(url, "cursor") ? null : "c1", pageComplete: true, totalRows: param(url, "cursor") ? 3 : 2 } })],
      ["ends short of totalRows", () => ({ status: 200, body: { rows: [rawRow(1)], nextCursor: null, pageComplete: true, totalRows: 2 } })],
    ];
    for (const [name, detail] of cases) {
      const h = harness(detail);
      await h.ctrl.load(ID);
      const outcome = await h.ctrl.collectAll(ID, "raw-export", { limit: 1 }).then(() => "accepted", (e: { code?: string }) => e.code);
      expect([name, outcome]).toEqual([name, expect.stringMatching(/^(NO_PROGRESS|INCOMPLETE)$/)]);
      expect(h.urls.filter((u) => u.startsWith("/api/reports/detail")).length).toBeLessThanOrEqual(3); // bounded, never a loop
    }
  });
});

describe("Task 17: an export aborted by the view is always the typed VIEW_CHANGED, never a raw AbortError", () => {
  /** A fetch that behaves like the browser's: a pending detail request REJECTS (AbortError) when its signal aborts. */
  function abortable(opts: { failSecond?: () => Error } = {}) {
    const urls: string[] = [];
    let n = 0;
    const fetchImpl: FetchLike = (url, init) => {
      urls.push(url);
      if (!url.startsWith("/api/reports/detail")) return Promise.resolve({ status: 200, ok: true, json: async () => summary("g1") });
      n++;
      if (n === 1) return Promise.resolve({ status: 200, ok: true, json: async () => ({ rows: [{ kind: "raw-export", row: { id: "e1" } }], nextCursor: "c1", pageComplete: true, totalRows: 2 }) });
      if (opts.failSecond) return Promise.reject(opts.failSecond());
      return new Promise((_resolve, reject) => {
        const signal = init.signal!;
        const fail = () => reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      });
    };
    return { urls, ctrl: new PublishedViewController({ fetch: fetchImpl, token: async () => "tok" }) };
  }
  const pending = async (ctrl: PublishedViewController) => {
    await ctrl.load(ID);
    const p = ctrl.collectAll(ID, "raw-export");
    const outcome = p.then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, e }));
    await new Promise((r) => setTimeout(r, 0)); // page 2 is genuinely in flight
    return { outcome }; // wrapped: awaiting the setup must not await the export itself
  };
  it("reset aborts the real request; the export rejects with PublishedReadError VIEW_CHANGED", async () => {
    const { urls, ctrl } = abortable();
    const { outcome } = await pending(ctrl);
    expect(urls.filter((u) => u.startsWith("/api/reports/detail"))).toHaveLength(2); // the abort hits a real pending request
    ctrl.reset();
    const r = await outcome;
    expect(r.ok).toBe(false);
    const e = (r as { e: unknown }).e;
    expect(e).toBeInstanceOf(PublishedReadError);
    expect(e).toMatchObject({ code: "VIEW_CHANGED", status: 409 });
  });
  it("an identity change aborts the real request; the export rejects with PublishedReadError VIEW_CHANGED", async () => {
    const { urls, ctrl } = abortable();
    const { outcome } = await pending(ctrl);
    expect(urls.filter((u) => u.startsWith("/api/reports/detail"))).toHaveLength(2);
    await ctrl.load({ ...ID, site: "au" });
    const r = await outcome;
    expect((r as { e: unknown }).e).toBeInstanceOf(PublishedReadError);
    expect((r as { e: unknown }).e).toMatchObject({ code: "VIEW_CHANGED" });
  });
  it("an ordinary fetch/network error with the view unchanged is rethrown unchanged (not relabelled)", async () => {
    const boom = new TypeError("Failed to fetch");
    const { ctrl } = abortable({ failSecond: () => boom });
    await ctrl.load(ID);
    await expect(ctrl.collectAll(ID, "raw-export")).rejects.toBe(boom);
  });
});

describe("Task 18: the published raw export streams bounded pages (incremental, never partial)", () => {
  const rawRow = (n: number) => ({ kind: "raw-export", row: { id: `e${n}` } });
  function harness(detail: (url: string) => { status: number; body: unknown }) {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      const r = url.startsWith("/api/reports/detail") ? detail(url) : { status: 200, body: summary("g1") };
      return { status: r.status, ok: r.status < 400, json: async () => r.body };
    };
    return { urls, ctrl: new PublishedViewController({ fetch: fetchImpl, token: async () => "tok" }) };
  }
  const pages = (url: string) => {
    const at = Number(new URL(url, "http://x").searchParams.get("cursor") ?? "0");
    return { status: 200, body: { rows: [rawRow(at * 2 + 1), rawRow(at * 2 + 2)], nextCursor: at < 2 ? String(at + 1) : null, pageComplete: true, totalRows: 6 } };
  };
  it("onPage receives every page in order and no rows are retained by the collector", async () => {
    const h = harness(pages);
    await h.ctrl.load(ID);
    const seen: string[][] = [];
    const kept = await h.ctrl.collectAll(ID, "raw-export", { onPage: (rows) => void seen.push(rows.map((r) => (r.row as { id: string }).id)) });
    expect(seen).toEqual([["e1", "e2"], ["e3", "e4"], ["e5", "e6"]]);
    expect(kept).toEqual([]); // streamed: the caller owns the output, nothing accumulates here
  });
  it("the totals/progress checks still hold when streaming: a short end is INCOMPLETE after pages were delivered", async () => {
    const h = harness(() => ({ status: 200, body: { rows: [rawRow(1)], nextCursor: null, pageComplete: true, totalRows: 2 } }));
    await h.ctrl.load(ID);
    let delivered = 0;
    await expect(h.ctrl.collectAll(ID, "raw-export", { onPage: (rows) => void (delivered += rows.length) })).rejects.toMatchObject({ code: "INCOMPLETE" });
    expect(delivered).toBe(1); // the caller saw a page but the export as a whole is refused
  });
  it("mid-export revocation (403 on page 2) rejects with the typed error; the export is refused", async () => {
    const h = harness((url) => (new URL(url, "http://x").searchParams.get("cursor") === "1" ? { status: 403, body: { error: "No membership for this site", code: "FORBIDDEN" } } : pages(url)));
    await h.ctrl.load(ID);
    let delivered = 0;
    await expect(h.ctrl.collectAll(ID, "raw-export", { onPage: (rows) => void (delivered += rows.length) })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(delivered).toBe(2);
  });
});
