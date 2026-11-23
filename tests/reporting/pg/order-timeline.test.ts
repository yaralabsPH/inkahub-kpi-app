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
import { readOrderTimeline } from "../../../api/_lib/order-timeline";
import type { ReportingPrincipal } from "../../../api/_lib/production-reporting";

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
  await db.query("insert into auth.users (id) values ($1), ('22222222-2222-4222-8222-222222222222')", [STAFF]);
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
    expect(r1.data).toMatchObject({ accepted: 4, duplicates: 0, conflicts: 0 });
    expect((await rpc().rpc("reconcile_order_timeline_app", { p_site: "uk", p_order_number: "#88" })).data).toMatchObject({ accepted: 0, duplicates: 4 });
    const keys = (await db.query("select occurrence_key, stage, work_type, retracts_key from public.order_timeline_evidence where source = 'app' and order_number = '#88' order by 1")).rows;
    expect(keys).toEqual([
      { occurrence_key: "uk/p1", stage: "framed", work_type: "framed", retracts_key: null },
      { occurrence_key: "uk/p2", stage: "dispatched", work_type: null, retracts_key: null },
      { occurrence_key: "uk/p4", stage: "framed", work_type: "a0_framed", retracts_key: null },
      { occurrence_key: "uk/p5", stage: "framed", work_type: null, retracts_key: "uk/p4" }, // the cancel retracts exactly p4
    ]);
    expect((await db.query("select count(*)::int n from public.production_events")).rows[0]).toEqual(before);
  });
  it("copy -> cancel -> reconcile -> read: the earlier copy is revoked, never left confirmed, and is not an order cancellation", async () => {
    await ingest(order("9901", "uk", "99"), [ev({ key: "order:9901:ordered", shopifyOrderId: "9901", orderNumber: "99" })]);
    const ins = (id: string, dept: string, type: string, at: string, parent: string | null = null) =>
      db.query(`insert into public.production_events (location, id, staff_id, department, order_number, event_type, created_at, parent_event_id) values ('uk',$1,$2,$3,'99',$4,$5,$6)`, [id, STAFF, dept, type, at, parent]);
    await ins("q1", "framed", "completed", "2026-11-20T10:00:00Z");
    await ins("q2", "dispatch", "dispatched", "2026-11-20T12:00:00Z");
    const owner: ReportingPrincipal = { userId: STAFF, role: "owner", nav: new Set(["reports"]), sites: new Set(["uk"]) };
    const read = () => readOrderTimeline(owner, { site: "uk", orderNumber: "99" }, { rpc: rpc(), now: () => Date.parse("2026-11-22T00:00:00Z") });
    expect((await rpc().rpc("reconcile_order_timeline_app", { p_site: "uk", p_order_number: "99" })).data).toMatchObject({ accepted: 2 });
    const before = await read();
    expect(before.stages?.find((s) => s.stage === "dispatched")?.status).toBe("confirmed");
    await ins("q3", "dispatch", "cancelled", "2026-11-20T13:00:00Z", "q2"); // the dispatch scan is cancelled AFTER the copy
    expect((await rpc().rpc("reconcile_order_timeline_app", { p_site: "uk", p_order_number: "99" })).data).toMatchObject({ accepted: 1, duplicates: 2, conflicts: 0 });
    const after = await read();
    expect(after.stages?.find((s) => s.stage === "dispatched")?.status).toBe("missing");
    expect(after.stages?.find((s) => s.stage === "framed")?.status).toBe("partial"); // the other scan is untouched
    expect(after.cancelled).toBeNull(); // one scan's cancellation is not an order cancellation
    expect(after.evidence.filter((e) => e.revoked).map((e) => e.stage)).toEqual(["dispatched"]);
    expect(after.evidence.filter((e) => e.retraction)).toHaveLength(1);
    // the original copy is still stored unchanged (history is never edited)
    expect((await db.query("select count(*)::int n from public.order_timeline_evidence where occurrence_key = 'uk/q2'")).rows[0]).toEqual({ n: 1 });
  });
});

describe("0059 flow alias uniqueness is site-wide (review task2 P2)", () => {
  it("an order number shared with another recorded order at the site (outside the window) never attaches app facts", async () => {
    await ingest(order("4001", "uk", "55"), [ev({ key: "order:4001:ordered", shopifyOrderId: "4001", orderNumber: "55", happenedAt: "2026-11-25T09:00:00Z" })]);
    await ingest(order("4002", "uk", "55"), [ev({ key: "order:4002:ordered", shopifyOrderId: "4002", orderNumber: "55", happenedAt: "2026-10-01T09:00:00Z" })]);
    await ingest(order("4003", "uk", "56"), [ev({ key: "order:4003:ordered", shopifyOrderId: "4003", orderNumber: "56", happenedAt: "2026-11-25T10:00:00Z" })]);
    await ingest(null, [
      { source: "app", key: "uk/a55", site: "uk", shop: null, shopifyOrderId: null, orderNumber: "55", stage: "dispatched", kind: "confirmed", happenedAt: "2026-11-25T12:00:00Z" },
      { source: "app", key: "uk/a56", site: "uk", shop: null, shopifyOrderId: null, orderNumber: "56", stage: "dispatched", kind: "confirmed", happenedAt: "2026-11-25T12:00:00Z" },
    ]);
    const r = await rpc().rpc("read_order_flow", { p_site: "uk", p_start: "2026-11-25T00:00:00Z", p_end: "2026-11-26T00:00:00Z", p_order_limit: 100, p_row_limit: 1000 });
    expect(r.error).toBeNull();
    const keys = (r.data as { evidence: unknown[][] }).evidence.map((x) => x[1]);
    expect(keys).toContain("uk/a56");
    expect(keys).not.toContain("uk/a55");
    expect((await read("uk", "55")).error?.message).toMatch(/ambiguous/); // consistent with the single-order read
  });
});

// ---------------------------------------------------------------------------
// 0061: scanner-attested full framing from a saved F6 commit receipt
// ---------------------------------------------------------------------------

interface ReceiptLine { sku: string; qty: number; wt: "framed" | "a0_framed" }
interface EventRow { location: string; id: string; staff_id: string; department: string; order_number: string; line_sku: string | null; line_quantity: number | null; event_type: string; station_id: string; note: string; created_at: string; cs_case_id: string | null; parent_event_id: string | null }
/**
 * Writes exactly what scanner_commit_framing (0055 steps 9 and 11) writes for one saved commit: per-line
 * line_verified events (ids -vNN, lines sorted by SKU), one completed event per work type (-c-<wt>), all at the
 * scan time on the shared station, then the receipt whose result lists every event id. Hooks alter the rows
 * or the receipt to build invalid variants.
 */
async function seedReceipt(o: {
  site?: string; order: string; rid: string; at: string; lines?: ReceiptLine[];
  event?: (e: EventRow) => EventRow | null; result?: (r: Record<string, unknown>) => Record<string, unknown>; extraEvents?: EventRow[];
}) {
  const site = o.site ?? "uk";
  const lines = [...(o.lines ?? [{ sku: "INKA-AB1234-A3-FB", qty: 1, wt: "framed" }, { sku: "INKA-CD5678-A2-FW", qty: 2, wt: "framed" }])].sort((a, b) => (a.sku < b.sku ? -1 : 1));
  const rid = o.rid.replace(/-/g, "");
  const base = { location: site, staff_id: STAFF, order_number: o.order, station_id: "shared:R1:A", note: "Shared scanner", created_at: o.at, cs_case_id: null, parent_event_id: null };
  const events: EventRow[] = lines.map((l, i) => ({ ...base, id: `scn-${rid}-v${String(i + 1).padStart(2, "0")}`, department: l.wt, line_sku: l.sku, line_quantity: l.qty, event_type: "line_verified" }));
  for (const wt of [...new Set(lines.map((l) => l.wt))].sort()) {
    events.push({ ...base, id: `scn-${rid}-c-${wt}`, department: wt, line_sku: null, line_quantity: lines.filter((l) => l.wt === wt).reduce((s, l) => s + l.qty, 0), event_type: "completed" });
  }
  const ids = events.map((e) => e.id);
  for (const raw of [...events, ...(o.extraEvents ?? [])]) {
    const e = o.event ? o.event(raw) : raw;
    if (!e) continue;
    await db.query(
      `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [e.location, e.id, e.staff_id, e.department, e.order_number, e.line_sku, e.line_quantity, e.event_type, e.station_id, e.note, e.created_at, e.cs_case_id, e.parent_event_id]);
  }
  const result: Record<string, unknown> = {
    status: "saved", request_id: o.rid, order_number: o.order, staff_id: STAFF, display_name: "Fixture", pieces: 3,
    work_types: [...new Set(lines.map((l) => l.wt))], event_ids: ids, deduction: null, packaging_pick: null, negative_codes: [],
  };
  await db.query(
    `insert into public.scanner_requests (location, request_id, kind, caller, receiver_id, scanner_id, staff_id, order_number, payload_hash, outcome, result, scanned_at)
     values ($1,$2,'commit',$3,'R1','A',$3,$4,$5,'saved',$6,$7)`,
    [site, o.rid, STAFF, o.order, "a".repeat(64), JSON.stringify(o.result ? o.result(result) : result), o.at]);
  return { ids, site };
}
const ownerAt = (site: string): ReportingPrincipal => ({ userId: STAFF, role: "owner", nav: new Set(["reports"]), sites: new Set([site]) });
const timelineOf = (site: string, num: string) => readOrderTimeline(ownerAt(site), { site, orderNumber: num }, { rpc: rpc(), now: () => Date.parse("2026-11-23T00:00:00Z") });
const reconcileApp = async (site: string, num: string) => {
  const r = await rpc().rpc("reconcile_order_timeline_app", { p_site: site, p_order_number: num });
  if (r.error) throw new Error(r.error.message);
  return r.data as { accepted: number; duplicates: number; conflicts: number };
};
let shopId = 61000;
async function linkOrder(site: string, num: string) {
  const id = String(++shopId);
  await ingest(order(id, site, num), [ev({ key: `order:${id}:ordered`, shopifyOrderId: id, orderNumber: num, happenedAt: "2026-11-20T08:00:00Z" })]);
}
const proofRows = (site: string, rid: string) =>
  db.query<{ occurrence_key: string; framing_complete: boolean | null; retracts_key: string | null; happened_at: string }>(
    `select occurrence_key, framing_complete, retracts_key, to_char(happened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') happened_at
       from public.order_timeline_evidence where source = 'app' and (occurrence_key = $1 or retracts_key = $1) order by occurrence_key`, [`${site}/receipt:${rid}`]).then((r) => r.rows);
const snapshot = async () => (await db.query<{ n: string }>(
  `select (select md5(coalesce(string_agg(t::text, '|' order by t.location, t.id), '')) from public.production_events t)
       || (select md5(coalesce(string_agg(t::text, '|' order by t.location, t.request_id), '')) from public.scanner_requests t) n`)).rows[0].n;
const AT = "2026-11-20T10:00:00Z";

describe("0061 scanner receipt framing proof", () => {
  it("a valid saved receipt gives confirmed full framing at the scan time; replay is all duplicates; sources are never mutated", async () => {
    await linkOrder("uk", "10000101");
    const rid = "00000000-0000-4000-8000-000000000101";
    await seedReceipt({ order: "10000101", rid, at: AT });
    const before = await snapshot();
    // 0059's per-work-type copy (one completed event) + the receipt proof
    expect(await reconcileApp("uk", "10000101")).toMatchObject({ accepted: 2, duplicates: 0, conflicts: 0 });
    expect(await reconcileApp("uk", "10000101")).toMatchObject({ accepted: 0, duplicates: 2, conflicts: 0 });
    expect(await proofRows("uk", rid)).toEqual([{ occurrence_key: `uk/receipt:${rid}`, framing_complete: true, retracts_key: null, happened_at: AT }]);
    const t = await timelineOf("uk", "10000101");
    const framed = t.stages?.find((s) => s.stage === "framed");
    expect(framed).toMatchObject({ status: "confirmed", source: "app", kind: "confirmed" });
    expect(Date.parse(framed!.at!)).toBe(Date.parse(AT));
    expect(t.framedByWorkType.map((f) => [f.workType, Date.parse(f.at), f.kind])).toEqual([["framed", Date.parse(AT), "confirmed"]]);
    expect(await snapshot()).toBe(before);
  });

  it("A0 + framed in one commit: one proof covering both work types", async () => {
    await linkOrder("uk", "10000102");
    const rid = "00000000-0000-4000-8000-000000000102";
    await seedReceipt({ order: "10000102", rid, at: AT, lines: [{ sku: "INKA-AB1234-A0-FB", qty: 1, wt: "a0_framed" }, { sku: "INKA-CD5678-A3-FW", qty: 1, wt: "framed" }] });
    expect(await reconcileApp("uk", "10000102")).toMatchObject({ accepted: 3, conflicts: 0 });
    expect((await timelineOf("uk", "10000102")).stages?.find((s) => s.stage === "framed")?.status).toBe("confirmed");
  });

  it("classic/manual framing without a receipt stays partial, even with scanner-looking ids", async () => {
    await linkOrder("uk", "10000103");
    await db.query(`insert into public.production_events (location, id, staff_id, department, order_number, event_type, created_at) values
      ('uk','classic-103','${STAFF}','framed','10000103','completed','${AT}'),
      ('uk','scn-00000000000040008000000000000103-c-framed','${STAFF}','framed','10000103','completed','${AT}')`);
    expect(await reconcileApp("uk", "10000103")).toMatchObject({ accepted: 2 });
    expect((await timelineOf("uk", "10000103")).stages?.find((s) => s.stage === "framed")?.status).toBe("partial");
  });

  it("a later CS case and its replacement work never erase the original proof; the replacement is excluded", async () => {
    await linkOrder("uk", "10000104");
    const rid = "00000000-0000-4000-8000-000000000104";
    await seedReceipt({ order: "10000104", rid, at: AT });
    await reconcileApp("uk", "10000104");
    await db.query(`insert into public.production_events (location, id, staff_id, department, order_number, event_type, created_at, cs_case_id)
      values ('uk','repl-104','${STAFF}','framed','10000104','completed','2026-11-22T10:00:00Z','CS-104')`);
    expect(await reconcileApp("uk", "10000104")).toMatchObject({ accepted: 1, duplicates: 2, conflicts: 0 });
    const t = await timelineOf("uk", "10000104");
    const framed = t.stages?.find((s) => s.stage === "framed");
    expect(framed?.status).toBe("confirmed");
    expect(Date.parse(framed!.at!)).toBe(Date.parse(AT)); // the original scan time, not the replacement's
    expect(t.framedByWorkType.map((f) => [f.workType, Date.parse(f.at), f.kind])).toEqual([["framed", Date.parse(AT), "confirmed"]]);
    expect(t.evidence.filter((e) => e.caseId === "CS-104")).toHaveLength(1);
  });

  it("wrong site or order never proves: a receipt elsewhere, or a result naming another order", async () => {
    await linkOrder("au", "10000105");
    await db.query(`insert into public.production_events (location, id, staff_id, department, order_number, event_type, created_at) values ('au','classic-105','${STAFF}','framed','10000105','completed','${AT}')`);
    await seedReceipt({ site: "uk", order: "10000105", rid: "00000000-0000-4000-8000-000000000105", at: AT }); // UK receipt, AU lookup
    expect(await reconcileApp("au", "10000105")).toMatchObject({ accepted: 1 });
    expect((await timelineOf("au", "10000105")).stages?.find((s) => s.stage === "framed")?.status).toBe("partial");
    // receipt at the site but its result names another order
    await linkOrder("uk", "10000106");
    const rid = "00000000-0000-4000-8000-000000000106";
    await seedReceipt({ order: "10000106", rid, at: AT, result: (r) => ({ ...r, order_number: "10009999" }) });
    await reconcileApp("uk", "10000106");
    expect(await proofRows("uk", rid)).toEqual([]);
  });

  const INVALID: Array<[string, Parameters<typeof seedReceipt>[0] extends infer P ? Omit<P & object, "order" | "rid" | "at"> : never]> = [
    ["empty event_ids", { result: (r) => ({ ...r, event_ids: [] }) }],
    ["duplicate id", { result: (r) => ({ ...r, event_ids: [...(r.event_ids as string[]), (r.event_ids as string[])[0]] }) }],
    ["non-string id", { result: (r) => ({ ...r, event_ids: [...(r.event_ids as string[]), 7] }) }],
    ["event_ids not an array", { result: (r) => ({ ...r, event_ids: (r.event_ids as string[]).join(",") }) }],
    ["missing event", { event: (e) => (e.id.endsWith("-v01") ? null : e) }],
    ["listed id of another request", { result: (r) => ({ ...r, event_ids: (r.event_ids as string[]).map((x) => x.replace(/-v01$/, "-v01x")) }), extraEvents: [] }],
    ["result request id mismatch", { result: (r) => ({ ...r, request_id: "00000000-0000-4000-8000-000000009999" }) }],
    ["result status not saved", { result: (r) => ({ ...r, status: "already_recorded" }) }],
    ["CS-tagged receipt event", { event: (e) => (e.id.endsWith("-v02") ? { ...e, cs_case_id: "CS-9" } : e) }],
    ["event time differs from scan time", { event: (e) => (e.id.endsWith("-c-framed") ? { ...e, created_at: "2026-11-20T10:00:01Z" } : e) }],
    ["event at another order", { event: (e) => (e.id.endsWith("-v01") ? { ...e, order_number: "10009998" } : e) }],
    ["completed id holds a line_verified event", { event: (e) => (e.id.endsWith("-c-framed") ? { ...e, event_type: "line_verified", line_sku: "INKA-ZZ0000-A3-FB" } : e) }],
    ["line id holds a completed event", { event: (e) => (e.id.endsWith("-v01") ? { ...e, event_type: "completed", line_sku: null } : e) }],
    ["no completed event listed", { result: (r) => ({ ...r, event_ids: (r.event_ids as string[]).filter((x) => !x.includes("-c-")) }) }],
    ["no per-line event listed", { result: (r) => ({ ...r, event_ids: (r.event_ids as string[]).filter((x) => x.includes("-c-")) }) }],
    ["completed work type without lines", { result: (r) => ({ ...r, event_ids: [...(r.event_ids as string[]), `scn-${String(r.request_id).replace(/-/g, "")}-c-a0_framed`] }),
      extraEvents: [] }],
    ["non-framing record", { result: (r) => ({ ...r, event_ids: [...(r.event_ids as string[]), `scn-${String(r.request_id).replace(/-/g, "")}-c-unframed`] }) }],
    ["different staff on one event", { event: (e) => (e.id.endsWith("-v01") ? { ...e, staff_id: "22222222-2222-4222-8222-222222222222" } : e) }],
    ["different station on one event", { event: (e) => (e.id.endsWith("-v02") ? { ...e, station_id: "shared:R2:A" } : e) }],
  ];
  it.each(INVALID.map(([name, hooks], i) => [name, hooks, i] as const))("invalid receipt (%s): no proof, framing stays partial or missing", async (_name, hooks, i) => {
    const num = String(10000200 + i);
    const rid = `00000000-0000-4000-8000-${String(200 + i).padStart(12, "0")}`;
    await linkOrder("uk", num);
    const ridHex = rid.replace(/-/g, "");
    // extra events the variants list but the scanner never wrote (a stray a0 completion, an unframed record)
    const extra: EventRow[] = [
      { location: "uk", id: `scn-${ridHex}-c-a0_framed`, staff_id: STAFF, department: "a0_framed", order_number: num, line_sku: null, line_quantity: 1, event_type: "completed", station_id: "shared:R1:A", note: "Shared scanner", created_at: AT, cs_case_id: null, parent_event_id: null },
      { location: "uk", id: `scn-${ridHex}-c-unframed`, staff_id: STAFF, department: "unframed", order_number: num, line_sku: null, line_quantity: 1, event_type: "completed", station_id: "shared:R1:A", note: "Shared scanner", created_at: AT, cs_case_id: null, parent_event_id: null },
    ];
    await seedReceipt({ order: num, rid, at: AT, ...hooks, extraEvents: hooks.extraEvents ?? extra });
    const before = await snapshot();
    await reconcileApp("uk", num);
    expect(await proofRows("uk", rid)).toEqual([]);
    expect(["partial", "missing"]).toContain((await timelineOf("uk", num)).stages?.find((s) => s.stage === "framed")?.status);
    expect(await snapshot()).toBe(before);
  });

  it("proof first, then a per-line cancellation: a retraction at the actual cancel time revokes it; repeats are duplicates", async () => {
    await linkOrder("uk", "10000301");
    const rid = "00000000-0000-4000-8000-000000000301";
    const { ids } = await seedReceipt({ order: "10000301", rid, at: AT });
    await reconcileApp("uk", "10000301");
    expect((await timelineOf("uk", "10000301")).stages?.find((s) => s.stage === "framed")?.status).toBe("confirmed");
    const line = ids.find((x) => x.endsWith("-v01"))!;
    await db.query(`insert into public.production_events (location, id, staff_id, department, order_number, event_type, created_at, parent_event_id)
      values ('uk','cx-301','${STAFF}','framed','10000301','cancelled','2026-11-20T11:30:00Z',$1)`, [line]);
    // the retraction is new; the completed copy is a duplicate; the proof is no longer re-emitted (it stays stored, revoked)
    expect(await reconcileApp("uk", "10000301")).toMatchObject({ accepted: 1, duplicates: 1, conflicts: 0 });
    expect(await reconcileApp("uk", "10000301")).toMatchObject({ accepted: 0, duplicates: 2, conflicts: 0 });
    expect(await proofRows("uk", rid)).toEqual([
      { occurrence_key: `uk/receipt-cancel:${rid}:cx-301`, framing_complete: null, retracts_key: `uk/receipt:${rid}`, happened_at: "2026-11-20T11:30:00Z" },
      { occurrence_key: `uk/receipt:${rid}`, framing_complete: true, retracts_key: null, happened_at: AT },
    ]);
    const t = await timelineOf("uk", "10000301");
    expect(t.stages?.find((s) => s.stage === "framed")?.status).toBe("partial"); // the completed copy stands; full proof revoked
    expect(t.evidence.some((e) => e.revoked && e.stage === "framed")).toBe(true);
  });

  it("cancellation before the first reconcile: no proof is emitted, the retraction still is, and order of arrival does not matter", async () => {
    await linkOrder("uk", "10000302");
    const rid = "00000000-0000-4000-8000-000000000302";
    const { ids } = await seedReceipt({ order: "10000302", rid, at: AT });
    const completed = ids.find((x) => x.endsWith("-c-framed"))!;
    await db.query(`insert into public.production_events (location, id, staff_id, department, order_number, event_type, created_at, parent_event_id)
      values ('uk','cx-302','${STAFF}','framed','10000302','cancelled','2026-11-20T12:00:00Z',$1)`, [completed]);
    await reconcileApp("uk", "10000302");
    expect(await proofRows("uk", rid)).toEqual([
      { occurrence_key: `uk/receipt-cancel:${rid}:cx-302`, framing_complete: null, retracts_key: `uk/receipt:${rid}`, happened_at: "2026-11-20T12:00:00Z" },
    ]);
    // a proof arriving afterwards (e.g. from an earlier copy) would still be revoked by the stored retraction
    await ingest(null, [{ source: "app", key: `uk/receipt:${rid}`, site: "uk", shop: null, shopifyOrderId: null, orderNumber: "10000302", stage: "framed", kind: "confirmed", happenedAt: AT, framingComplete: true }]);
    expect((await timelineOf("uk", "10000302")).stages?.find((s) => s.stage === "framed")?.status).not.toBe("confirmed");
  });

  it("over the ingest bound fails explicitly before writing anything", async () => {
    await linkOrder("uk", "10000401");
    const values = Array.from({ length: 201 }, (_, i) => `('uk','d401-${i}','${STAFF}','dispatch','10000401','dispatched','2026-11-20T12:00:00Z')`).join(",");
    await db.query(`insert into public.production_events (location, id, staff_id, department, order_number, event_type, created_at) values ${values}`);
    const r = await rpc().rpc("reconcile_order_timeline_app", { p_site: "uk", p_order_number: "10000401" });
    expect(r.error?.message).toMatch(/exceed the limit 200/);
    expect((await db.query("select count(*)::int n from public.order_timeline_evidence where source = 'app' and order_number = '10000401'")).rows[0]).toEqual({ n: 0 });
  });

  it("keeps the service-only, security-invoker, empty search_path function and can read receipts as service_role only", async () => {
    const f = (await db.query<{ secdef: boolean; cfg: string[] }>(`select p.prosecdef secdef, p.proconfig cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'reconcile_order_timeline_app'`)).rows;
    expect(f).toEqual([{ secdef: false, cfg: ['search_path=""'] }]);
    const sel = (role: string) => db.query<{ ok: boolean }>(`select has_table_privilege($1, 'public.scanner_requests', 'SELECT') ok`, [role]).then((r) => r.rows[0].ok);
    expect(await sel("service_role")).toBe(true);
    expect(await sel("anon")).toBe(false);
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
