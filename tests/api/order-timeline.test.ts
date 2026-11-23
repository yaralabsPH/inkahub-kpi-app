/** F10: /api/orders/timeline handler and Shopify adapter (no database, no network). */
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createOrderTimelineHandler } from "../../api/orders/timeline";
import {
  evidenceFromFacts, factsFromGraphqlOrder, factsFromWebhookOrder, parseRoutingConfig, readRawBody, routeOrder, verifyShopifyHmac, SHOPIFY_ADMIN_API_VERSION,
} from "../../api/_lib/shopify-webhooks";
import type { AuthDeps } from "../../api/_lib/production-reporting";
import type { RpcClient } from "../../api/_lib/reporting-jobs";

const SHOP = "inka-shared.myshopify.com";
const SECRET = "test-webhook-secret";
const U1 = "11111111-1111-4111-8111-111111111111";
const ROUTING = JSON.stringify({ version: 1, shops: { [SHOP]: { kind: "shipping_country", map: { AU: "au", NZ: "au", GB: "uk", US: "us" } } } });
const ENV = { SHOPIFY_WEBHOOK_SECRET: SECRET, ORDER_TIMELINE_INGEST: "on", ORDER_TIMELINE_ROUTING: ROUTING, SHOPIFY_SHOP_DOMAIN: SHOP, SHOPIFY_ADMIN_TOKEN: "tok" };

const ORDER = {
  id: 5550001, admin_graphql_api_id: "gid://shopify/Order/5550001", name: "#10190203", created_at: "2026-11-20T09:00:00+00:00", cancelled_at: null,
  fulfillment_status: "partial", tags: "vip, rush", note_attributes: [], email: "customer@example.com",
  shipping_address: { country_code: "GB", address1: "1 Secret Street", name: "A Customer" },
  fulfillments: [{ id: 77, admin_graphql_api_id: "gid://shopify/Fulfillment/77", created_at: "2026-11-21T10:00:00+00:00", updated_at: "2026-11-21T10:00:00+00:00", status: "success", shipment_status: null }],
};
const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("base64");

function setup(opts: { role?: string; nav?: unknown; sites?: string[]; env?: Record<string, string | undefined>; rpc?: (fn: string, args: Record<string, unknown>) => { data: unknown; error: { message: string } | null }; fetch?: unknown } = {}) {
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => (opts.rpc ? opts.rpc(fn, args) : { data: { accepted: 1, duplicates: 0, conflicts: 0, route: "routed" }, error: null }));
  const auth: AuthDeps = { getUser: async () => U1, profile: async () => ({ role: opts.role ?? "owner", allowed_nav: opts.nav ?? null }), memberships: async () => opts.sites ?? ["uk"] };
  const fetchFn = vi.fn(opts.fetch as never ?? (async () => ({ ok: true, status: 200, json: async () => ({ data: { orders: { nodes: [] } } }) })));
  const audit = vi.fn();
  const handler = createOrderTimelineHandler({ auth: () => auth, rpc: () => ({ rpc } as unknown as RpcClient), env: () => ({ ...ENV, ...opts.env }), fetch: fetchFn, now: () => Date.parse("2026-11-23T00:00:00Z"), audit });
  const call = async (req: { method: string; headers: Record<string, string>; query?: Record<string, string>; body?: unknown }) => {
    let status = 0;
    let body: Record<string, unknown> = {};
    const res = { setHeader: () => res, status: (s: number) => ({ json: (b: unknown) => { status = s; body = b as Record<string, unknown>; } }) };
    await handler(req as never, res);
    return { status, body };
  };
  const hook = (raw: string, headers: Record<string, string> = {}) => call({
    method: "POST", body: Buffer.from(raw, "utf8"),
    headers: { "x-shopify-hmac-sha256": sign(raw), "x-shopify-shop-domain": SHOP, "x-shopify-topic": "orders/updated", "content-length": String(Buffer.byteLength(raw)), ...headers },
  });
  const get = (query: Record<string, string>) => call({ method: "GET", headers: { authorization: "Bearer aaa.bbb.ccc" }, query });
  return { call, hook, get, rpc, fetchFn, audit };
}

describe("Shopify webhook: verification before any parsing or database work", () => {
  const raw = JSON.stringify(ORDER);
  it("missing, malformed or wrong signatures are 401 with no database call", async () => {
    for (const h of ["", "not base64!!", sign(raw, "wrong-secret"), sign(raw + " ")]) {
      const s = setup();
      expect((await s.hook(raw, { "x-shopify-hmac-sha256": h })).status).toBe(401);
      expect(s.rpc).not.toHaveBeenCalled();
    }
  });
  it("wrong/unlisted shop is 403; oversized is 413; missing secret or disabled ingestion fails closed (503); none touch the database", async () => {
    const cases: Array<[ReturnType<typeof setup>, Record<string, string>, number]> = [
      [setup(), { "x-shopify-shop-domain": "other-shop.myshopify.com" }, 403],
      [setup(), { "x-shopify-shop-domain": "evil.example.com" }, 403],
      [setup(), { "content-length": String(2 * 1024 * 1024) }, 413],
      [setup({ env: { SHOPIFY_WEBHOOK_SECRET: undefined } }), {}, 503],
      [setup({ env: { ORDER_TIMELINE_INGEST: undefined } }), {}, 503],
      [setup({ env: { ORDER_TIMELINE_ROUTING: "{bad" } }), {}, 503],
    ];
    for (const [s, h, want] of cases) {
      expect((await s.hook(raw, h)).status).toBe(want);
      expect(s.rpc).not.toHaveBeenCalled();
    }
    const big = setup();
    const huge = JSON.stringify({ ...ORDER, pad: "x".repeat(1024 * 1024) });
    expect((await big.call({ method: "POST", body: Buffer.from(huge), headers: { "x-shopify-hmac-sha256": sign(huge), "x-shopify-shop-domain": SHOP, "x-shopify-topic": "orders/updated" } })).status).toBe(413);
    expect(big.rpc).not.toHaveBeenCalled();
  });
  it("a signature plus a session is refused; a signed request never falls back to session auth; parsed-object bodies cannot be verified", async () => {
    const s = setup();
    expect((await s.call({ method: "POST", body: Buffer.from(raw), headers: { "x-shopify-hmac-sha256": sign(raw), authorization: "Bearer aaa.bbb.ccc" } })).status).toBe(400);
    expect((await s.call({ method: "POST", body: ORDER, headers: { "x-shopify-hmac-sha256": sign(raw), "x-shopify-shop-domain": SHOP, "x-shopify-topic": "orders/updated" } })).status).toBe(503);
    expect(s.rpc).not.toHaveBeenCalled();
  });
  it("a verified order is routed by the configured predicate; evidence has no site and no customer data", async () => {
    const s = setup();
    const r = await s.hook(raw);
    expect(r.status).toBe(200);
    expect(s.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = s.rpc.mock.calls[0];
    expect(fn).toBe("ingest_order_timeline");
    expect(args.p_order).toEqual({ shop: SHOP, shopifyOrderId: "5550001", orderNumber: "10190203", site: "uk", routeReason: null });
    const evs = args.p_evidence as Array<Record<string, unknown>>;
    expect(evs.map((e) => e.key)).toEqual(["order:5550001:ordered", "fulfillment:77:shipped:partial"]);
    expect(evs.every((e) => e.site === null)).toBe(true);
    expect(JSON.stringify(args)).not.toMatch(/customer@example|Secret Street|A Customer|GB/);
  });
  it("altered duplicates are reported as conflicts (original kept by the database); failed persistence is never acknowledged; other topics are ignored", async () => {
    const c = setup({ rpc: () => ({ data: { accepted: 0, duplicates: 1, conflicts: 1, route: "unchanged" }, error: null }) });
    const r = await c.hook(raw);
    expect([r.status, r.body.conflicts]).toEqual([200, 1]);
    expect(c.audit).toHaveBeenCalledWith(expect.objectContaining({ event: "timeline_conflict" }));
    const f = setup({ rpc: () => ({ data: null, error: { message: "connection lost" } }) });
    expect((await f.hook(raw)).status).toBe(503);
    const t = setup();
    expect((await t.hook(raw, { "x-shopify-topic": "products/update" })).body).toEqual({ ignored: true });
    expect(t.rpc).not.toHaveBeenCalled();
    const bad = setup();
    expect((await bad.hook("{not json")).status).toBe(400);
    expect((await bad.hook(JSON.stringify({ ...ORDER, created_at: "yesterday" }))).status).toBe(400);
    expect(bad.rpc).not.toHaveBeenCalled();
  });
  it("raw body: reads an unread stream with a size cap; refuses an already-parsed object", async () => {
    const stream = Object.assign(Readable.from([Buffer.from("ab"), Buffer.from("cd")]), {});
    expect((await readRawBody(stream as never, 10)).toString()).toBe("abcd");
    await expect(readRawBody(Readable.from([Buffer.alloc(11)]) as never, 10)).rejects.toThrow(/too large/);
    await expect(readRawBody({ body: { a: 1 } }, 10)).rejects.toThrow(/unavailable/);
    expect(verifyShopifyHmac(Buffer.from("x"), sign("x"), SECRET)).toBe(true);
    expect(verifyShopifyHmac(Buffer.from("x"), sign("x"), "")).toBe(false);
  });
});

describe("routing contract (shared shop, fail closed)", () => {
  it("parses only explicit rules; malformed is an error, absent is null", () => {
    expect(parseRoutingConfig(undefined)).toBeNull();
    for (const bad of ["{", "{}", JSON.stringify({ version: 1, shops: { [SHOP]: { kind: "shop", map: { x: "au" } } } }),
      JSON.stringify({ version: 1, shops: { [SHOP]: { kind: "shipping_country", map: { au: "au" } } } }),
      JSON.stringify({ version: 1, shops: { [SHOP]: { kind: "order_tag", map: { AU: "nz" } } } }),
      JSON.stringify({ version: 1, shops: { "Inka.myshopify.com": { kind: "order_tag", map: { AU: "au" } } } })]) {
      expect(() => parseRoutingConfig(bad), bad).toThrow();
    }
  });
  it("unknown, missing or ambiguous location is unrouted with a reason; the shop alone never implies a site", () => {
    const cfg = parseRoutingConfig(JSON.stringify({ version: 1, shops: { [SHOP]: { kind: "order_tag", map: { "site-au": "au", "site-uk": "uk" } } } }))!;
    expect(routeOrder(cfg, SHOP, { shippingCountry: "AU", tags: ["site-au"], attributes: [] })).toEqual({ site: "au", reason: null });
    expect(routeOrder(cfg, SHOP, { shippingCountry: "AU", tags: [], attributes: [] }).site).toBeNull();
    expect(routeOrder(cfg, SHOP, { shippingCountry: null, tags: ["site-au", "site-uk"], attributes: [] })).toMatchObject({ site: null, reason: expect.stringMatching(/several/) });
    expect(routeOrder(cfg, "other.myshopify.com", { shippingCountry: null, tags: ["site-au"], attributes: [] }).site).toBeNull();
    const attr = parseRoutingConfig(JSON.stringify({ version: 1, shops: { [SHOP]: { kind: "note_attribute", name: "Fulfil from", map: { Sydney: "au" } } } }))!;
    expect(routeOrder(attr, SHOP, { shippingCountry: null, tags: [], attributes: [{ name: "Fulfil from", value: "Sydney" }] }).site).toBe("au");
  });
  it("a fulfillment completes the order only when Shopify reports fulfilled and it is the latest successful one; delivered needs carrier time", () => {
    const f = factsFromWebhookOrder({ ...ORDER, fulfillment_status: "fulfilled", fulfillments: [
      ORDER.fulfillments[0],
      { id: 78, created_at: "2026-11-22T10:00:00Z", updated_at: "2026-11-24T10:00:00Z", status: "success", shipment_status: "delivered" },
      { id: 79, created_at: "2026-11-23T10:00:00Z", updated_at: "2026-11-23T10:00:00Z", status: "cancelled", shipment_status: null }] }, SHOP);
    const e = evidenceFromFacts(f);
    expect(e.filter((x) => x.stage === "shipped").map((x) => [x.fulfillmentId, x.fulfillmentComplete])).toEqual([["77", false], ["78", true]]);
    expect(e.find((x) => x.stage === "delivered")).toMatchObject({ kind: "reported", key: "fulfillment:78:delivered:reported" });
    const g = factsFromGraphqlOrder({ legacyResourceId: "5550001", name: "#10190203", createdAt: "2026-11-20T09:00:00Z", cancelledAt: null, displayFulfillmentStatus: "FULFILLED", tags: [], customAttributes: [],
      shippingAddress: { countryCodeV2: "GB" }, fulfillments: [{ legacyResourceId: "77", createdAt: "2026-11-21T10:00:00Z", status: "SUCCESS", deliveredAt: "2026-11-22T08:00:00Z" }] }, SHOP);
    expect(evidenceFromFacts(g).map((x) => [x.key, x.kind])).toEqual([["order:5550001:ordered", "confirmed"], ["fulfillment:77:shipped:complete", "confirmed"], ["fulfillment:77:delivered:confirmed", "confirmed"]]);
    expect(() => factsFromGraphqlOrder({ legacyResourceId: "1", name: "#1", createdAt: "2026-11-20T09:00:00Z", fulfillments: Array.from({ length: 50 }, () => ({})) }, SHOP)).toThrow(/incomplete/);
  });
});

const row = (over: Partial<Record<string, unknown>> = {}) => {
  const r = { source: "shopify", key: "order:9:ordered", stage: "ordered", kind: "confirmed", at: "2026-11-20T09:00:00.000000Z", rcv: "2026-11-20T09:00:01.000000Z", fid: null, fc: null, wt: null, frc: null, cs: null, b: null, shop: SHOP, id: "9", num: "10190203", site: null, ...over };
  return [r.source, r.key, r.stage, r.kind, r.at, r.rcv, r.fid, r.fc, r.wt, r.frc, r.cs, r.b, r.shop, r.id, r.num, r.site];
};

describe("GET reads: authorization before any service read", () => {
  const Q = { action: "order", site: "uk", orderNumber: "#10190203" };
  it("401 without a session; staff, kiosk, CS without Reports and non-members are 403 with no RPC", async () => {
    const anon = setup();
    expect((await anon.call({ method: "GET", headers: {}, query: Q })).status).toBe(401);
    for (const s of [setup({ role: "staff", nav: ["welcome", "reports"] }), setup({ role: "kiosk", nav: ["reports"] }), setup({ role: "cs" }), setup({ role: "manager", sites: ["au"] })]) {
      expect((await s.get(Q)).status).toBe(403);
      expect(s.rpc).not.toHaveBeenCalled();
    }
    const cs = setup({ role: "cs", nav: ["cs_cases", "reports"], rpc: () => ({ data: { identity: null, evidence: [] }, error: null }) });
    expect((await cs.get(Q)).status).toBe(200);
  });
  it("bad parameters are 400 before any read", async () => {
    const s = setup();
    for (const q of [{ ...Q, site: "nz" }, { ...Q, orderNumber: "" }, { ...Q, action: "late" }, { ...Q, extra: "1" }, { ...Q, firstDate: "2026-11-20" }]) expect((await s.get(q)).status).toBe(400);
    expect(s.rpc).not.toHaveBeenCalled();
  });
  it("returns the projected stages and adjacent gaps; no classification, customer data or raw keys", async () => {
    const s = setup({ rpc: () => ({ data: { identity: { shop: SHOP, shopifyOrderId: "9", orderNumber: "10190203" }, evidence: [
      row(),
      row({ source: "app", key: "uk/e1", stage: "dispatched", at: "2026-11-21T09:00:00.000000Z", shop: null, id: null, site: "uk" }),
      row({ key: "fulfillment:1:shipped:complete", stage: "shipped", at: "2026-11-21T11:00:00.000000Z", fid: "1", fc: true }),
    ] }, error: null }) });
    const r = await s.get(Q);
    expect(r.status).toBe(200);
    expect(s.rpc).toHaveBeenCalledWith("read_order_timeline", { p_site: "uk", p_order_number: "10190203", p_limit: 500 });
    const stages = r.body.stages as Array<{ stage: string; status: string }>;
    expect(stages.find((x) => x.stage === "shipped")?.status).toBe("confirmed");
    expect(stages.find((x) => x.stage === "framed")?.status).toBe("missing");
    const gaps = r.body.gaps as Array<{ from: string; to: string; status: string; hours: number | null }>;
    expect(gaps.find((g) => g.from === "dispatched")).toEqual({ from: "dispatched", to: "shipped", status: "measured", hours: 2 });
    expect(gaps.find((g) => g.to === "dispatched")?.status).toBe("unknown"); // framing missing: never skipped
    expect(JSON.stringify(r.body)).not.toMatch(/late|threshold|"key"/i);
  });
  it("cross-site rows from the reader are refused; unlinked orders list app events without stages", async () => {
    const bad = setup({ rpc: () => ({ data: { identity: { shop: SHOP, shopifyOrderId: "9" }, evidence: [row({ source: "app", key: "au/x", shop: null, id: null, site: "au" })] }, error: null }) });
    expect((await bad.get(Q)).status).toBe(503);
    const un = setup({ rpc: () => ({ data: { identity: null, evidence: [row({ source: "app", key: "uk/e1", stage: "framed", shop: null, id: null, site: "uk", wt: "framed" })] }, error: null }) });
    const r = await un.get(Q);
    expect(r.body).toMatchObject({ linked: false, stages: null });
    expect((r.body.evidence as unknown[]).length).toBe(1);
  });
  it("flow: bounded range, recorded-order coverage label and explicit TOO_LARGE", async () => {
    const s = setup({ rpc: () => ({ data: { orders: 1, unroutedOrders: 3, latestReceivedAt: { shopify: "2026-11-22T00:00:00.000000Z", app: null, make: null }, evidence: [
      row({ at: "2026-11-20T09:00:00.000000Z" }), row({ key: "fulfillment:1:shipped:complete", stage: "shipped", at: "2026-11-20T19:00:00.000000Z", fid: "1", fc: true })] }, error: null }) });
    const r = await s.get({ action: "flow", site: "uk", firstDate: "2026-11-20", lastDate: "2026-11-20" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ cohort: 1, completeShipmentSamples: 1, orderToShipHours: { median: 10, p90: 10 }, coverage: { recordedOrders: 1, unroutedOrders: 3 } });
    expect((r.body.coverage as { label: string }).label).toMatch(/recorded/);
    expect((await s.get({ action: "flow", site: "uk", firstDate: "2026-01-01", lastDate: "2026-11-20" })).status).toBe(400);
    const big = setup({ rpc: () => ({ data: null, error: { message: "read_order_flow: more than 2000 orders exceed the limit 2000" } }) });
    const b = await big.get({ action: "flow", site: "uk", firstDate: "2026-11-20", lastDate: "2026-11-20" });
    expect([b.status, b.body.code]).toEqual([503, "TOO_LARGE"]);
  });
});

describe("POST reconcile: owner only, bounded, read-only towards Shopify", () => {
  const body = { action: "reconcile", site: "uk", orderNumber: "10190203" };
  const post = (s: ReturnType<typeof setup>, b: unknown = body) => s.call({ method: "POST", headers: { authorization: "Bearer aaa.bbb.ccc" }, body: b });
  const node = { legacyResourceId: "9", name: "#10190203", createdAt: "2026-11-20T09:00:00Z", cancelledAt: null, displayFulfillmentStatus: "UNFULFILLED", tags: [], customAttributes: [], shippingAddress: { countryCodeV2: "GB" }, fulfillments: [] };
  const okFetch = (nodes: unknown[]) => async () => ({ ok: true, status: 200, json: async () => ({ data: { orders: { nodes } } }) });
  it("managers and CS are 403 before any read; bad bodies are 400", async () => {
    for (const s of [setup({ role: "manager" }), setup({ role: "cs", nav: ["reports"] })]) {
      expect((await post(s)).status).toBe(403);
      expect(s.rpc).not.toHaveBeenCalled();
      expect(s.fetchFn).not.toHaveBeenCalled();
    }
    const s = setup();
    expect((await post(s, { ...body, site: "nz" })).status).toBe(400);
    expect((await post(s, { ...body, force: true })).status).toBe(400);
    expect(s.rpc).not.toHaveBeenCalled();
  });
  it("owner: app evidence for the site, then one read-only GraphQL query at the verified API version; routing elsewhere is never reassigned", async () => {
    const s = setup({ fetch: okFetch([{ ...node, shippingAddress: { countryCodeV2: "US" } }]) });
    const r = await post(s);
    expect(r.status).toBe(200);
    expect(s.rpc.mock.calls[0]).toEqual(["reconcile_order_timeline_app", { p_site: "uk", p_order_number: "10190203" }]);
    const [url, init] = s.fetchFn.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toBe(`https://${SHOP}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`);
    expect(init.body).not.toMatch(/mutation/);
    expect((s.rpc.mock.calls[1][1] as { p_order: { site: string } }).p_order.site).toBe("us");
    expect(r.body.shopify).toMatchObject({ status: "recorded", routedHere: false });
  });
  it("Shopify failures or ambiguous matches are errors (records untouched), not success; unconfigured Shopify refreshes app events only", async () => {
    const down = setup({ fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
    expect((await post(down)).body.code).toBe("SHOPIFY_UNAVAILABLE");
    expect(down.rpc).toHaveBeenCalledTimes(1); // app reconciliation only; no Shopify ingestion
    const two = setup({ fetch: okFetch([node, node]) });
    expect((await post(two)).body.code).toBe("SHOPIFY_UNAVAILABLE");
    const none = setup({ env: { SHOPIFY_ADMIN_TOKEN: undefined } });
    expect((await post(none)).body.shopify).toMatchObject({ status: "not_configured" });
    expect(none.fetchFn).not.toHaveBeenCalled();
  });
});
