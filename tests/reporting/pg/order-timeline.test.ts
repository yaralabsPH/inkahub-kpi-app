/**
 * F10 order timeline SQL (0059), offline on PGlite: atomic service-only
 * ingestion (duplicate/conflict, rollback), set-once routing (never
 * reassigned), site isolation for equal order numbers, explicit over-limit
 * errors, bounded app reconciliation and grants (no browser access).
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { reportingDb } from "./harness";
import { pgRpc } from "./rpc";

const SHOP = "inka-shared.myshopify.com";
const STAFF = "11111111-1111-4111-8111-111111111111";
let db: PGlite;
const rpc = () => pgRpc(db);
const ev = (over: Record<string, unknown>) => ({
  source: "shopify", key: "k", shop: SHOP, shopifyOrderId: "1001", orderNumber: "#1001", stage: "ordered", kind: "confirmed",
  happenedAt: "2026-11-20T09:00:00Z", ...over,
});
const order = (id: string, site: string | null, num = `#${id}`, routeReason: string | null = null) => ({ shop: SHOP, shopifyOrderId: id, orderNumber: num, site, routeReason });
async function ingest(o: unknown, evidence: unknown[]) {
  const r = await rpc().rpc("ingest_order_timeline", { p_order: o, p_evidence: evidence });
  if (r.error) throw new Error(r.error.message);
  return r.data as { accepted: number; duplicates: number; conflicts: number; route: string };
}
async function read(site: string, num: string, limit = 500) {
  return rpc().rpc("read_order_timeline", { p_site: site, p_order_number: num, p_limit: limit });
}

beforeAll(async () => {
  db = await reportingDb();
  await db.query("insert into auth.users (id) values ($1)", [STAFF]);
});

describe("0059 ingestion", () => {
  it("records once; identical replay is a duplicate; altered content conflicts and keeps the original", async () => {
    expect(await ingest(order("1001", "uk"), [ev({ key: "order:1001:ordered" })])).toMatchObject({ accepted: 1, duplicates: 0, conflicts: 0, route: "routed" });
    expect(await ingest(order("1001", "uk"), [ev({ key: "order:1001:ordered" })])).toMatchObject({ accepted: 0, duplicates: 1, conflicts: 0, route: "unchanged" });
    expect(await ingest(null, [ev({ key: "order:1001:ordered", happenedAt: "2026-11-21T09:00:00Z" })])).toMatchObject({ conflicts: 1 });
    const r = await read("uk", "#1001");
    const rows = (r.data as { evidence: unknown[][] }).evidence;
    expect(rows).toHaveLength(1);
    expect(rows[0][4]).toBe("2026-11-20T09:00:00.000000Z");
  });
  it("a batch is atomic: one invalid record rolls back the whole call", async () => {
    const r = await rpc().rpc("ingest_order_timeline", { p_order: order("1002", "uk"), p_evidence: [ev({ key: "a", shopifyOrderId: "1002" }), ev({ key: "b", shopifyOrderId: "1002", stage: "teleported" })] });
    expect(r.error).not.toBeNull();
    expect((await db.query("select count(*)::int n from public.order_timeline_evidence where shopify_order_id = '1002'")).rows[0]).toEqual({ n: 0 });
    expect((await db.query("select count(*)::int n from public.order_timeline_orders where shopify_order_id = '1002'")).rows[0]).toEqual({ n: 0 });
  });
  it("refuses shopify evidence carrying a site, local times and oversized batches", async () => {
    for (const bad of [[ev({ key: "s1", shopifyOrderId: "1003", site: "uk" })], [ev({ key: "s2", shopifyOrderId: "1003", happenedAt: "2026-11-20T09:00:00" })],
      Array.from({ length: 201 }, (_, i) => ev({ key: `m${i}`, shopifyOrderId: "1003" }))]) {
      expect((await rpc().rpc("ingest_order_timeline", { p_order: null, p_evidence: bad })).error).not.toBeNull();
    }
  });
  it("evidence is immutable even for the service role", async () => {
    await db.exec("SET ROLE service_role");
    try {
      await expect(db.query("update public.order_timeline_evidence set kind = 'inferred'")).rejects.toThrow();
      await expect(db.query("delete from public.order_timeline_evidence")).rejects.toThrow();
    } finally {
      await db.exec("RESET ROLE");
    }
  });
});

describe("0059 routing and site isolation", () => {
  it("a fulfillment before its order waits unrouted; routing is set once and a different site is a conflict, never a reassignment", async () => {
    const f = ev({ key: "fulfillment:F9:shipped:complete", shopifyOrderId: "2001", orderNumber: "#2001", stage: "shipped", fulfillmentId: "F9", fulfillmentComplete: true, happenedAt: "2026-11-21T09:00:00Z" });
    expect(await ingest(null, [f])).toMatchObject({ accepted: 1, route: "none" });
    expect((await read("au", "#2001")).data).toMatchObject({ identity: null, evidence: [] });
    expect(await ingest(order("2001", null, "#2001", "no mapped location"), [])).toMatchObject({ route: "unrouted" });
    expect(await ingest(order("2001", "au"), [ev({ key: "order:2001:ordered", shopifyOrderId: "2001", orderNumber: "#2001" })])).toMatchObject({ route: "routed" });
    expect((await read("au", "#2001")).data).toMatchObject({ identity: { shopifyOrderId: "2001" } });
    expect(((await read("au", "#2001")).data as { evidence: unknown[] }).evidence).toHaveLength(2);
    expect(await ingest(order("2001", "us"), [])).toMatchObject({ route: "conflict" });
    expect((await read("us", "#2001")).data).toMatchObject({ identity: null, evidence: [] });
    expect((await db.query("select site, route_conflicts from public.order_timeline_orders where shopify_order_id = '2001'")).rows[0]).toEqual({ site: "au", route_conflicts: 1 });
  });
  it("equal order numbers at two sites never merge; app/make evidence attaches only within its own site and identity", async () => {
    await ingest(order("3001", "uk", "#77"), [ev({ key: "order:3001:ordered", shopifyOrderId: "3001", orderNumber: "#77" })]);
    await ingest(order("3002", "au", "#77"), [ev({ key: "order:3002:ordered", shopifyOrderId: "3002", orderNumber: "#77" })]);
    await ingest(null, [
      { source: "app", key: "uk/e1", site: "uk", shop: null, shopifyOrderId: null, orderNumber: "#77", stage: "framed", kind: "confirmed", happenedAt: "2026-11-20T10:00:00Z", workType: "framed" },
      { source: "app", key: "au/e1", site: "au", shop: null, shopifyOrderId: null, orderNumber: "#77", stage: "dispatched", kind: "confirmed", happenedAt: "2026-11-20T11:00:00Z" },
      // make evidence naming the UK identity but reported for AU is never shown under either
      { source: "make", key: "run-1:3001", site: "au", shop: SHOP, shopifyOrderId: "3001", orderNumber: "#77", stage: "make_planned", kind: "confirmed", happenedAt: "2026-11-20T10:30:00Z", batchId: "B1" },
    ]);
    const uk = (await read("uk", "#77")).data as { identity: { shopifyOrderId: string }; evidence: unknown[][] };
    const au = (await read("au", "#77")).data as { identity: { shopifyOrderId: string }; evidence: unknown[][] };
    expect(uk.identity.shopifyOrderId).toBe("3001");
    expect(au.identity.shopifyOrderId).toBe("3002");
    expect(uk.evidence.map((r) => r[1]).sort()).toEqual(["order:3001:ordered", "uk/e1"]);
    expect(au.evidence.map((r) => r[1]).sort()).toEqual(["au/e1", "order:3002:ordered"]);
  });
  it("over the row limit is an explicit error, never a truncated history", async () => {
    const r = await read("uk", "#77", 1);
    expect(r.error?.message).toMatch(/exceed the limit/);
    expect((await read("uk", "x".repeat(65))).error).not.toBeNull();
    expect((await read("nz", "#77")).error).not.toBeNull();
  });
});

describe("0059 flow cohort", () => {
  it("returns the site's recorded orders ordered in the window with their evidence, bounded", async () => {
    const r = await rpc().rpc("read_order_flow", { p_site: "uk", p_start: "2026-11-20T00:00:00Z", p_end: "2026-11-21T00:00:00Z", p_order_limit: 100, p_row_limit: 1000 });
    expect(r.error).toBeNull();
    const d = r.data as { orders: number; evidence: unknown[][]; unroutedOrders: number; latestReceivedAt: Record<string, string | null> };
    expect(d.orders).toBe(2); // 1001 and 3001 (UK); AU 2001/3002 excluded
    expect(new Set(d.evidence.map((x) => x[13]))).toEqual(new Set(["1001", "3001", null]));
    expect(d.latestReceivedAt.shopify).toMatch(/Z$/);
    expect(d.unroutedOrders).toBe(0);
    const big = await rpc().rpc("read_order_flow", { p_site: "uk", p_start: "2026-11-20T00:00:00Z", p_end: "2026-11-21T00:00:00Z", p_order_limit: 1, p_row_limit: 1000 });
    expect(big.error?.message).toMatch(/exceed the limit/);
    const long = await rpc().rpc("read_order_flow", { p_site: "uk", p_start: "2026-01-01T00:00:00Z", p_end: "2026-11-21T00:00:00Z", p_order_limit: 100, p_row_limit: 1000 });
    expect(long.error).not.toBeNull();
  });
});

describe("0059 bounded app reconciliation", () => {
  it("copies one order's recorded app framing/dispatch (site-scoped), idempotently, without touching production events", async () => {
    const ins = (loc: string, id: string, dept: string, type: string, at: string, parent: string | null = null) =>
      db.query(`insert into public.production_events (location, id, staff_id, department, order_number, event_type, created_at, parent_event_id) values ($1,$2,$3,$4,'#88',$5,$6,$7)`, [loc, id, STAFF, dept, type, at, parent]);
    await ins("uk", "p1", "framed", "completed", "2026-11-20T10:00:00Z");
    await ins("uk", "p2", "dispatch", "dispatched", "2026-11-20T12:00:00Z");
    await ins("uk", "p3", "framed", "started", "2026-11-20T09:00:00Z");
    await ins("uk", "p4", "a0_framed", "completed", "2026-11-20T10:30:00Z");
    await ins("uk", "p5", "a0_framed", "cancelled", "2026-11-20T10:31:00Z", "p4");
    await ins("au", "p1", "framed", "completed", "2026-11-20T10:00:00Z");
    const before = (await db.query("select count(*)::int n from public.production_events")).rows[0];
    const r1 = await rpc().rpc("reconcile_order_timeline_app", { p_site: "uk", p_order_number: "#88" });
    expect(r1.error).toBeNull();
    expect(r1.data).toMatchObject({ accepted: 2, duplicates: 0, conflicts: 0 });
    expect((await rpc().rpc("reconcile_order_timeline_app", { p_site: "uk", p_order_number: "#88" })).data).toMatchObject({ accepted: 0, duplicates: 2 });
    const keys = (await db.query<{ occurrence_key: string; stage: string; work_type: string | null }>("select occurrence_key, stage, work_type from public.order_timeline_evidence where source = 'app' and order_number = '#88' order by 1")).rows;
    expect(keys).toEqual([{ occurrence_key: "uk/p1", stage: "framed", work_type: "framed" }, { occurrence_key: "uk/p2", stage: "dispatched", work_type: null }]);
    expect((await db.query("select count(*)::int n from public.production_events")).rows[0]).toEqual(before);
  });
});

describe("0059 grants", () => {
  it("browser roles cannot read tables or execute any timeline RPC", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      try {
        await expect(db.query("select 1 from public.order_timeline_evidence limit 1")).rejects.toThrow();
        await expect(db.query("select 1 from public.order_timeline_orders limit 1")).rejects.toThrow();
      } finally {
        await db.exec("RESET ROLE");
      }
      for (const fn of ["read_order_timeline", "read_order_flow", "ingest_order_timeline", "reconcile_order_timeline_app"]) {
        const ok = (await db.query<{ ok: boolean }>(`select has_function_privilege($1, p.oid, 'EXECUTE') ok from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $2`, [role, fn])).rows;
        expect(ok, `${role} ${fn}`).toEqual([{ ok: false }]);
      }
    }
    const svc = (await db.query<{ ok: boolean }>(`select bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE')) ok from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any($1)`, [["read_order_timeline", "read_order_flow", "ingest_order_timeline", "reconcile_order_timeline_app"]])).rows[0];
    expect(svc.ok).toBe(true);
  });
});
