/**
 * The Reports order-lookup lifecycle (review r2 R2-6 / r1 M4): results are
 * bound to user, site and order; site/account switches and late responses
 * never show one scope's events or counts under another.
 */
import { describe, expect, it } from "vitest";
import { createOrderLookupSession, type OrderLookupView } from "../orderLookupSession";
import { loadOrderLookup, type OrderLookupRequest, type OrderLookupResult } from "../orderLookup";
import { orderLookupCounts } from "../../../domain/productionReportView";

type Ev = { id: string; location: string };

function deferredLoader() {
  const pending: Array<{ req: OrderLookupRequest; resolve: (r: OrderLookupResult<Ev>) => void; reject: (e: Error) => void }> = [];
  const load = (req: OrderLookupRequest) => new Promise<OrderLookupResult<Ev>>((resolve, reject) => void pending.push({ req, resolve, reject }));
  return { pending, load };
}

function session(scopeKey = "userA|au", location = "au") {
  const d = deferredLoader();
  const views: OrderLookupView<Ev>[] = [];
  let t = 0;
  const s = createOrderLookupSession<Ev>({
    load: d.load, normalize: (x) => x.trim().replace(/^#/, ""), now: () => `2026-11-14T00:00:0${t++}.000Z`, onChange: (v) => void views.push(v), scopeKey, location,
  });
  return { s, d, views };
}

const hit = (location: string, n = 2): OrderLookupResult<Ev> => ({ events: Array.from({ length: n }, (_, i) => ({ id: `${location}-${i}`, location })), complete: true });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createOrderLookupSession", () => {
  it("binds a result to the site it was read from, with one fixed cutoff", async () => {
    const { s, d } = session();
    const p = s.search(" #1001 ");
    expect(d.pending[0].req).toEqual({ location: "au", orderNumber: "1001", asOfUtc: "2026-11-14T00:00:00.000Z" });
    expect(s.view().loading).toBe(true);
    d.pending[0].resolve(hit("au"));
    await p;
    expect(s.view()).toMatchObject({ searched: "1001", loading: false, error: null, lookup: { key: "userA|au|1001", location: "au", asOfUtc: "2026-11-14T00:00:00.000Z", complete: true } });
    expect(s.view().events?.map((e) => e.id)).toEqual(["au-0", "au-1"]);
  });

  it("a site switch while a search is pending discards the late old-site response", async () => {
    const { s, d } = session();
    const p = s.search("1001");
    s.setScope("userA|uk", "uk");
    expect(s.view()).toMatchObject({ scopeKey: "userA|uk", searched: null, loading: false, lookup: null, events: null });
    d.pending[0].resolve(hit("au"));
    await p;
    expect(s.view().events).toBeNull();
    expect(s.view().lookup).toBeNull();
  });

  it("a site switch after a result clears it; a new search reads the new site only", async () => {
    const { s, d } = session();
    const p1 = s.search("1001");
    d.pending[0].resolve(hit("au"));
    await p1;
    s.setScope("userA|uk", "uk");
    expect(s.view().events).toBeNull();
    const p2 = s.search("1001");
    expect(d.pending[1].req.location).toBe("uk");
    d.pending[1].resolve(hit("uk", 1));
    await p2;
    expect(s.view().lookup?.location).toBe("uk");
    expect(s.view().events?.map((e) => e.location)).toEqual(["uk"]);
  });

  it("an account switch at the same site discards the other account's pending and shown results", async () => {
    const { s, d } = session("userA|au");
    const p1 = s.search("1001");
    d.pending[0].resolve(hit("au"));
    await p1;
    const p2 = s.search("1002");
    s.setScope("userB|au", "au");
    expect(s.view().events).toBeNull();
    d.pending[1].resolve(hit("au"));
    await p2;
    expect(s.view()).toMatchObject({ scopeKey: "userB|au", lookup: null, events: null, loading: false });
  });

  it("an older search finishing after a newer one never replaces it", async () => {
    const { s, d } = session();
    const p1 = s.search("1001");
    const p2 = s.search("1002");
    d.pending[1].resolve({ events: [{ id: "new", location: "au" }], complete: true });
    await p2;
    d.pending[0].resolve({ events: [{ id: "old", location: "au" }], complete: true });
    await p1;
    expect(s.view().lookup?.order).toBe("1002");
    expect(s.view().events?.map((e) => e.id)).toEqual(["new"]);
  });

  it("a late failure of an outdated search does not show its error", async () => {
    const { s, d } = session();
    const p1 = s.search("1001");
    s.setScope("userA|uk", "uk");
    d.pending[0].reject(new Error("boom"));
    await p1;
    expect(s.view().error).toBeNull();
    const p2 = s.search("1001");
    d.pending[1].reject(new Error("network down"));
    await p2;
    expect(s.view()).toMatchObject({ error: "network down", lookup: null, loading: false });
  });

  it("empty input asks for an order and starts no read; reset clears", async () => {
    const { s, d } = session();
    await s.search("   ");
    expect(s.view().error).toBe("Enter an order number first.");
    expect(d.pending).toHaveLength(0);
    const p = s.search("1001");
    s.reset();
    d.pending[0].resolve(hit("au"));
    await p;
    expect(s.view()).toMatchObject({ searched: null, lookup: null, events: null });
  });

  it("an order larger than the server cap goes through the real loader completely, and an incomplete read shows no counts", async () => {
    type Row = { id: string; location: string; order_number: string; created_at: string; event_type: string; line_sku: string; line_quantity: number; staff_id: string; department: string; parent_event_id: null; cs_case_id: null };
    const rows: Row[] = Array.from({ length: 1500 }, (_, i) => ({
      id: `e${String(i).padStart(5, "0")}`, location: "au", order_number: "1001", created_at: `2026-01-15T09:00:00.${String(i).padStart(6, "0")}Z`,
      event_type: "line_verified", line_sku: "INKA-KAN0566-A4-UN", line_quantity: 1, staff_id: "s", department: "unframed", parent_event_id: null, cs_case_id: null,
    }));
    const client = (cap: number, breakAt?: number) => ({
      from() {
        const ops: Array<[string, unknown[]]> = [];
        const q: Record<string, unknown> = {};
        q.select = () => q;
        for (const m of ["eq", "lte", "order"]) q[m] = (...a: unknown[]) => (ops.push([m, a]), q);
        q.range = (from: number) => {
          const matched = rows.filter((r) => ops.every(([m, a]) => (m === "eq" ? (r as Record<string, unknown>)[String(a[0])] === a[1] : true))).reverse();
          return Promise.resolve({ data: matched.slice(from, from + cap), error: null, count: breakAt !== undefined && from >= breakAt ? matched.length + 1 : matched.length });
        };
        return q;
      },
    });
    for (const [c, complete] of [[client(500), true], [client(500, 500), false]] as const) {
      const views: OrderLookupView<Row>[] = [];
      const s = createOrderLookupSession<Row>({ load: (req) => loadOrderLookup<Row>(c, req), normalize: (x) => x, now: () => "2026-01-16T00:00:00.000Z", onChange: (v) => void views.push(v), scopeKey: "u|au", location: "au" });
      await s.search("1001");
      await flush();
      const v = s.view();
      expect(v.lookup?.complete).toBe(complete);
      expect(v.events?.length).toBe(complete ? 1500 : 1000);
      const counts = orderLookupCounts(v.events!.map((e) => ({ ...e, line_quantity: e.line_quantity })) as never, { location: "au", asOfUtc: v.lookup!.asOfUtc, complete: v.lookup!.complete, visibility: { kind: "full" } as never });
      if (complete) expect(counts).not.toBeNull();
      else expect(counts).toBeNull();
    }
  });
});
