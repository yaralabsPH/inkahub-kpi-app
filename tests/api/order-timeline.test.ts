/** F10: /api/orders/timeline handler and Shopify adapter (no database, no network). */
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createOrderTimelineHandler } from "../../api/orders/timeline";
import {
  evidenceFromFacts, factsFromGraphqlOrder, factsFromWebhookOrder, parseRoutingConfig, readRawBody, routeOrder, verifyShopifyHmac, wholeOrderProof, SHOPIFY_ADMIN_API_VERSION,
} from "../../api/_lib/shopify-webhooks";
import type { AuthDeps } from "../../api/_lib/production-reporting";
import { projectTimeline, stageGaps } from "../../src/lib/domain/orderTimeline";
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
    // 0062: base facts + whole-proof invalidation in one call; the webhook never carries a proof
    expect(fn).toBe("ingest_order_timeline_webhook");
    expect(Object.keys(args).sort()).toEqual(["p_evidence", "p_order"]);
    expect(args.p_order).toEqual({ shop: SHOP, shopifyOrderId: "5550001", orderNumber: "10190203", site: "uk", routeReason: null });
    const evs = args.p_evidence as Array<Record<string, unknown>>;
    expect(evs.map((e) => e.key)).toEqual(["order:5550001:ordered", "fulfillment:77:created"]);
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
    expect(routeOrder(cfg, SHOP, { shippingCountry: "AU", tags: ["site-au"], attributes: [], incomplete: null })).toEqual({ site: "au", reason: null });
    expect(routeOrder(cfg, SHOP, { shippingCountry: "AU", tags: [], attributes: [], incomplete: null }).site).toBeNull();
    expect(routeOrder(cfg, SHOP, { shippingCountry: null, tags: ["site-au", "site-uk"], attributes: [], incomplete: null })).toMatchObject({ site: null, reason: expect.stringMatching(/several/) });
    expect(routeOrder(cfg, "other.myshopify.com", { shippingCountry: null, tags: ["site-au"], attributes: [], incomplete: null }).site).toBeNull();
    const attr = parseRoutingConfig(JSON.stringify({ version: 1, shops: { [SHOP]: { kind: "note_attribute", name: "Fulfil from", map: { Sydney: "au" } } } }))!;
    expect(routeOrder(attr, SHOP, { shippingCountry: null, tags: [], attributes: [{ name: "Fulfil from", value: "Sydney" }], incomplete: null }).site).toBe("au");
  });
  it("review task2 P1: Shopify state never backdates completion; fulfillments are recorded per fulfillment at creation, never as whole-order completion", () => {
    const f = factsFromWebhookOrder({ ...ORDER, fulfillment_status: "fulfilled", fulfillments: [
      ORDER.fulfillments[0],
      { id: 78, created_at: "2026-11-22T10:00:00Z", updated_at: "2026-11-24T10:00:00Z", status: "success", shipment_status: "delivered" },
      { id: 79, created_at: "2026-11-23T10:00:00Z", updated_at: "2026-11-23T10:00:00Z", status: "cancelled", shipment_status: null }] }, SHOP);
    const e = evidenceFromFacts(f);
    expect(e.filter((x) => x.stage === "shipped").map((x) => [x.key, x.fulfillmentComplete])).toEqual([["fulfillment:77:created", false], ["fulfillment:78:created", false]]);
    expect(e.some((x) => x.fulfillmentComplete === true)).toBe(false);
    expect(e.find((x) => x.stage === "delivered")).toMatchObject({ kind: "reported", key: "fulfillment:78:delivered:reported", fulfillmentId: "78" });
    // a pending fulfillment that later succeeds, or lines removed so the order becomes "fulfilled", produces the SAME facts:
    // nothing is re-timed or promoted to completion
    const later = evidenceFromFacts(factsFromWebhookOrder({ ...ORDER, fulfillment_status: "partial", fulfillments: [ORDER.fulfillments[0]] }, SHOP));
    expect(later.find((x) => x.stage === "shipped")).toEqual(e.find((x) => x.stage === "shipped"));
    const p = projectTimeline(e.map((x) => ({ ...x, site: "uk", receivedAt: "2026-11-25T00:00:00Z" })));
    expect(p.completeShipmentAt).toBeNull();
    expect(p.stages.shipped.status).toBe("partial");
  });
  it("review task2 P1: carrier delivery is per fulfillment; one of two delivered is partial with no shipped->delivered duration", () => {
    const g = factsFromGraphqlOrder({ legacyResourceId: "5550001", name: "#10190203", createdAt: "2026-11-20T09:00:00Z", cancelledAt: null, tags: [], customAttributes: [],
      shippingAddress: { countryCodeV2: "GB" }, fulfillments: [
        { legacyResourceId: "77", createdAt: "2026-11-21T10:00:00Z", status: "SUCCESS", deliveredAt: "2026-11-22T08:00:00Z" },
        { legacyResourceId: "78", createdAt: "2026-11-21T11:00:00Z", status: "SUCCESS", deliveredAt: null }] }, SHOP);
    const e = evidenceFromFacts(g);
    expect(e.map((x) => [x.key, x.kind])).toEqual([["order:5550001:ordered", "confirmed"], ["fulfillment:77:created", "confirmed"], ["fulfillment:77:delivered:confirmed", "confirmed"], ["fulfillment:78:created", "confirmed"]]);
    const t = projectTimeline(e.map((x) => ({ ...x, site: "uk", receivedAt: "2026-11-25T00:00:00Z" })));
    expect(t.stages.delivered.status).toBe("partial");
    expect(stageGaps(t).find((x) => x.to === "delivered")).toMatchObject({ status: "unknown", hours: null });
    expect(() => factsFromGraphqlOrder({ legacyResourceId: "1", name: "#1", createdAt: "2026-11-20T09:00:00Z", fulfillments: Array.from({ length: 50 }, () => ({})) }, SHOP)).toThrow(/incomplete/);
  });
  it("review task2 P2: routing never uses a truncated prefix (tags 250 / attributes 100 boundaries)", () => {
    const cfg = parseRoutingConfig(JSON.stringify({ version: 1, shops: { [SHOP]: { kind: "note_attribute", name: "site", map: { AU: "au", UK: "uk" } } } }))!;
    const attrs = (n: number, lastValue: string) => Array.from({ length: n }, (_, i) => ({ name: i === 0 || i === n - 1 ? "site" : `x${i}`, value: i === 0 ? "AU" : i === n - 1 ? lastValue : "y" }));
    // exactly 100 attributes are read whole: a contradicting last value makes the order ambiguous, not AU
    expect(routeOrder(cfg, SHOP, factsFromWebhookOrder({ ...ORDER, note_attributes: attrs(100, "UK") }, SHOP).route)).toMatchObject({ site: null, reason: expect.stringMatching(/several/) });
    // AU first and UK at attribute 101: refused, never routed AU on the first 100
    expect(routeOrder(cfg, SHOP, factsFromWebhookOrder({ ...ORDER, note_attributes: attrs(101, "UK") }, SHOP).route)).toMatchObject({ site: null, reason: expect.stringMatching(/more than 100 attributes/) });
    expect(routeOrder(cfg, SHOP, factsFromGraphqlOrder({ legacyResourceId: "1", name: "#1", createdAt: "2026-11-20T09:00:00Z", fulfillments: [],
      customAttributes: attrs(101, "UK").map((a) => ({ key: a.name, value: a.value })) }, SHOP).route).site).toBeNull();
    const tagCfg = parseRoutingConfig(JSON.stringify({ version: 1, shops: { [SHOP]: { kind: "order_tag", map: { "site-au": "au", "site-uk": "uk" } } } }))!;
    const tags = (n: number) => ["site-au", ...Array.from({ length: n - 2 }, (_, i) => `t${i}`), "site-uk"].join(", ");
    expect(routeOrder(tagCfg, SHOP, factsFromWebhookOrder({ ...ORDER, tags: tags(250) }, SHOP).route)).toMatchObject({ site: null, reason: expect.stringMatching(/several/) });
    expect(routeOrder(tagCfg, SHOP, factsFromWebhookOrder({ ...ORDER, tags: tags(251) }, SHOP).route)).toMatchObject({ site: null, reason: expect.stringMatching(/more than 250 tags/) });
    expect(routeOrder(tagCfg, SHOP, factsFromWebhookOrder({ ...ORDER, tags: "site-au" }, SHOP).route).site).toBe("au");
    // an unreadable attribute entry is refused rather than skipped
    expect(routeOrder(cfg, SHOP, factsFromWebhookOrder({ ...ORDER, note_attributes: [{ name: "site", value: "AU" }, 7] }, SHOP).route).site).toBeNull();
  });
});

const row = (over: Partial<Record<string, unknown>> = {}) => {
  const r = { source: "shopify", key: "order:9:ordered", stage: "ordered", kind: "confirmed", at: "2026-11-20T09:00:00.000000Z", rcv: "2026-11-20T09:00:01.000000Z", fid: null, fc: null, wt: null, frc: null, cs: null, b: null, shop: SHOP, id: "9", num: "10190203", site: null, rk: null, ...over };
  return [r.source, r.key, r.stage, r.kind, r.at, r.rcv, r.fid, r.fc, r.wt, r.frc, r.cs, r.b, r.shop, r.id, r.num, r.site, r.rk];
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
  /** Lookup (alias -> id) answers `nodes`; the by-id snapshot answers `byId` (default: the first node). */
  const okFetch = (nodes: unknown[], byId: unknown = nodes[0] ?? null) => async (_url: string, init: { body: string }) =>
    ({ ok: true, status: 200, json: async () => (JSON.parse(init.body).query.includes("OrderTimelineProof") ? { data: { order: byId } } : { data: { orders: { nodes } } }) });
  const proofRpc = (proof = "proven") => (fn: string) => ({
    data: fn === "order_timeline_proof_begin" ? 7 : fn === "order_timeline_proof_apply" ? { accepted: 1, duplicates: 0, conflicts: 0, route: "routed", proof } : { accepted: 0, duplicates: 0, conflicts: 0, route: "none" },
    error: null,
  });
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
    const s = setup({ fetch: okFetch([{ ...node, shippingAddress: { countryCodeV2: "US" } }]), rpc: proofRpc("none") });
    const r = await post(s);
    expect(r.status).toBe(200);
    expect(s.rpc.mock.calls[0]).toEqual(["reconcile_order_timeline_app", { p_site: "uk", p_order_number: "10190203" }]);
    for (const [url, init] of s.fetchFn.mock.calls as unknown as Array<[string, { method: string; body: string }]>) {
      expect(url).toBe(`https://${SHOP}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`);
      expect(init.body).not.toMatch(/mutation/);
    }
    expect(s.rpc.mock.calls.map((c) => c[0])).toEqual(["reconcile_order_timeline_app", "order_timeline_proof_begin", "order_timeline_proof_apply"]);
    expect((s.rpc.mock.calls[2][1] as { p_order: { site: string } }).p_order.site).toBe("us");
    expect(r.body.shopify).toMatchObject({ status: "recorded", routedHere: false, wholeOrder: "none" });
  });
  it("task3 review: ORDER_TIMELINE_INGEST off stops ALL reconciliation writes before any RPC or Shopify read; reads keep working", async () => {
    for (const off of [undefined, "off", "ON"]) {
      const s = setup({ env: { ORDER_TIMELINE_INGEST: off }, rpc: () => ({ data: { identity: null, evidence: [] }, error: null }) });
      const r = await post(s);
      expect([r.status, r.body.code]).toEqual([503, "DISABLED"]);
      expect(s.rpc).not.toHaveBeenCalled();
      expect(s.fetchFn).not.toHaveBeenCalled();
      // authorized reads stay available with the switch off
      expect((await s.get({ action: "order", site: "uk", orderNumber: "10190203" })).status).toBe(200);
      expect(s.rpc.mock.calls.map((c) => c[0])).toEqual(["read_order_timeline"]);
    }
    // validation and role checks still come first (no information about the switch to non-owners)
    expect((await post(setup({ role: "manager", env: { ORDER_TIMELINE_INGEST: undefined } }))).status).toBe(403);
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

  // ---- Task 3b: alias -> id, ticket BEFORE the snapshot, snapshot by id, one atomic apply ----
  const order = (over: Record<string, unknown> = {}) => ({ ...proofNode(), legacyResourceId: "9", name: "#10190203", ...over });
  it("resolves the id first, begins the ticket, THEN reads the snapshot by id and applies facts + proof with that ticket", async () => {
    const seq: string[] = [];
    const s = setup({
      fetch: async (_u: string, init: { body: string }) => {
        const q = JSON.parse(init.body);
        seq.push(q.query.includes("OrderTimelineProof") ? `fetch:byId:${q.variables.id}` : "fetch:lookup");
        return okFetch([{ legacyResourceId: "9", name: "#10190203" }], order())(_u, init);
      },
      rpc: (fn) => {
        seq.push(`rpc:${fn}`);
        return proofRpc()(fn);
      },
    });
    const r = await post(s);
    expect(r.status).toBe(200);
    expect(seq).toEqual(["rpc:reconcile_order_timeline_app", "fetch:lookup", "rpc:order_timeline_proof_begin", "fetch:byId:gid://shopify/Order/9", "rpc:order_timeline_proof_apply"]);
    const args = s.rpc.mock.calls[2][1] as Record<string, unknown>;
    expect(args).toMatchObject({ p_shop: SHOP, p_shopify_order_id: "9", p_ticket: 7 });
    expect(args.p_proof).toEqual({ hash: expect.stringMatching(/^[0-9a-f]{64}$/), shippedAt: "2026-11-22T10:00:00.000Z", deliveredAt: "2026-11-24T09:00:00.000Z" });
    expect((args.p_evidence as Array<{ key: string }>).map((e) => e.key)).toContain("fulfillment:101:created");
    expect(JSON.stringify(args)).not.toMatch(/GB|countryCode/);
    expect(r.body.shopify).toMatchObject({ status: "recorded", routedHere: true, note: null, wholeOrder: "proven" });
    // an unproven snapshot applies the base facts with no proof
    const u = setup({ fetch: okFetch([{ legacyResourceId: "9", name: "#10190203" }], order({ edited: true })), rpc: proofRpc("withdrawn") });
    await post(u);
    expect((u.rpc.mock.calls[2][1] as Record<string, unknown>).p_proof).toBeNull();
  });
  it("a failed or mismatched snapshot read withdraws through its own ticket and is reported, never applied as facts", async () => {
    for (const byId of [null, order({ legacyResourceId: "10" }), order({ name: "#10190204" }), order({ fulfillments: Array.from({ length: 20 }, () => ({})) })]) {
      const s = setup({ fetch: okFetch([{ legacyResourceId: "9", name: "#10190203" }], byId), rpc: proofRpc("withdrawn") });
      expect((await post(s)).body.code).toBe("SHOPIFY_UNAVAILABLE");
      expect(s.rpc.mock.calls.map((c) => c[0])).toEqual(["reconcile_order_timeline_app", "order_timeline_proof_begin", "order_timeline_proof_apply"]);
      expect(s.rpc.mock.calls[2][1]).toMatchObject({ p_ticket: 7, p_order: null, p_evidence: [], p_proof: null });
    }
    // a lookup failure or an inexact name match targets nothing (no ticket, no apply)
    for (const nodes of [[{ legacyResourceId: "9", name: "#101902031" }], [{ legacyResourceId: "x", name: "#10190203" }]]) {
      const s = setup({ fetch: okFetch(nodes), rpc: proofRpc() });
      const b = (await post(s)).body;
      expect(b.code === "SHOPIFY_UNAVAILABLE" || (b.shopify as { status: string }).status === "not_found").toBe(true);
      expect(s.rpc.mock.calls.map((c) => c[0])).toEqual(["reconcile_order_timeline_app"]);
    }
  });
  it("a superseded (stale) refresh is reported as incomplete; a malformed outcome is an error", async () => {
    const s = setup({ fetch: okFetch([{ legacyResourceId: "9", name: "#10190203" }], order()), rpc: proofRpc("stale") });
    expect((await post(s)).body.shopify).toMatchObject({ wholeOrder: "stale", note: expect.stringMatching(/newer Shopify update/) });
    const bad = setup({ fetch: okFetch([{ legacyResourceId: "9", name: "#10190203" }], order()), rpc: proofRpc("maybe") });
    expect((await post(bad)).status).toBeGreaterThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// Task 3b: pure whole-order proof
// ---------------------------------------------------------------------------

type Ful = { legacyResourceId: string; createdAt: string; status: string; deliveredAt: string | null; fulfillmentLineItems: unknown };
const ful = (id: string, createdAt: string, parts: Array<[string, number]>, deliveredAt: string | null = null, status = "SUCCESS"): Ful => ({
  legacyResourceId: id, createdAt, status, deliveredAt,
  fulfillmentLineItems: { nodes: parts.map(([l, q]) => ({ quantity: q, lineItem: { id: l } })), pageInfo: { hasNextPage: false } },
});
function proofNode(over: Record<string, unknown> = {}) {
  return {
    legacyResourceId: "9", name: "#10190203", createdAt: "2026-11-20T09:00:00Z", cancelledAt: null, edited: false, tags: [], customAttributes: [], shippingAddress: { countryCodeV2: "GB" },
    lineItems: { nodes: [
      { id: "gid://shopify/LineItem/1", quantity: 2, currentQuantity: 2, requiresShipping: true },
      { id: "gid://shopify/LineItem/2", quantity: 1, currentQuantity: 1, requiresShipping: true },
      { id: "gid://shopify/LineItem/3", quantity: 1, currentQuantity: 1, requiresShipping: false },
    ], pageInfo: { hasNextPage: false } },
    fulfillments: [
      ful("101", "2026-11-21T10:00:00Z", [["gid://shopify/LineItem/1", 2]], "2026-11-23T09:00:00Z"),
      ful("102", "2026-11-22T10:00:00Z", [["gid://shopify/LineItem/2", 1]], "2026-11-24T09:00:00Z"),
    ],
    ...over,
  };
}

describe("whole-order proof (pure, conservative)", () => {
  const L1 = "gid://shopify/LineItem/1";
  const L2 = "gid://shopify/LineItem/2";
  const L3 = "gid://shopify/LineItem/3";
  const unknown = (n: unknown) => expect(wholeOrderProof(n).status).toBe("unknown");
  it("multiple exact parcels: shipped = latest contributor creation, delivered = latest Shopify-reported delivery", () => {
    expect(wholeOrderProof(proofNode())).toMatchObject({ status: "proven", shippedAt: "2026-11-22T10:00:00.000Z", deliveredAt: "2026-11-24T09:00:00.000Z" });
  });
  it("one exact parcel; a non-shipping line never needs a fulfillment", () => {
    const one = proofNode({ fulfillments: [ful("101", "2026-11-21T10:00:00Z", [[L1, 2], [L2, 1]], "2026-11-23T09:00:00Z")] });
    expect(wholeOrderProof(one)).toMatchObject({ status: "proven", shippedAt: "2026-11-21T10:00:00.000Z", deliveredAt: "2026-11-23T09:00:00.000Z" });
  });
  it("delivery stays unknown unless every contributor has a valid delivery at or after its creation; updatedAt is never read", () => {
    const missing = proofNode({ fulfillments: [ful("101", "2026-11-21T10:00:00Z", [[L1, 2]], "2026-11-23T09:00:00Z"), { ...ful("102", "2026-11-22T10:00:00Z", [[L2, 1]]), updatedAt: "2026-11-25T00:00:00Z" }] });
    expect(wholeOrderProof(missing)).toMatchObject({ status: "proven", deliveredAt: null });
    const backwards = proofNode({ fulfillments: [ful("101", "2026-11-21T10:00:00Z", [[L1, 2]], "2026-11-23T09:00:00Z"), ful("102", "2026-11-22T10:00:00Z", [[L2, 1]], "2026-11-22T09:00:00Z")] });
    expect(wholeOrderProof(backwards)).toMatchObject({ status: "proven", deliveredAt: null });
    unknown(proofNode({ fulfillments: [ful("101", "2026-11-21T10:00:00Z", [[L1, 2], [L2, 1]], "soon")] }));
  });
  it("edited, cancelled or unknown edit/cancel state is unknown (quantity equality never implies unedited)", () => {
    unknown(proofNode({ edited: true }));
    unknown(proofNode({ edited: undefined }));
    unknown(proofNode({ edited: "false" }));
    unknown(proofNode({ cancelledAt: "2026-11-22T00:00:00Z" }));
    unknown(proofNode({ cancelledAt: undefined }));
  });
  it("changed, non-integer or non-positive quantities, truncated or malformed lists are unknown", () => {
    const li = (nodes: unknown[], hasNextPage: unknown = false) => ({ nodes, pageInfo: { hasNextPage } });
    const base = proofNode().lineItems.nodes;
    unknown(proofNode({ lineItems: li(base.map((n, i) => (i === 0 ? { ...n, currentQuantity: 1 } : n))) }));
    unknown(proofNode({ lineItems: li(base.map((n, i) => (i === 0 ? { ...n, quantity: 2.5, currentQuantity: 2.5 } : n))) }));
    unknown(proofNode({ lineItems: li(base, true) }));
    unknown(proofNode({ lineItems: { nodes: base } }));
    unknown(proofNode({ lineItems: li([...base, base[0]]) })); // duplicate line id
    unknown(proofNode({ lineItems: li(base.filter((n) => !n.requiresShipping)) })); // nothing to ship
    unknown(proofNode({ fulfillments: Array.from({ length: 20 }, (_, i) => ful(String(200 + i), "2026-11-21T10:00:00Z", [[L1, 1]])) }));
    unknown(proofNode({ fulfillments: [{ ...ful("101", "2026-11-21T10:00:00Z", [[L1, 2], [L2, 1]]), fulfillmentLineItems: { nodes: [{ quantity: 2, lineItem: { id: L1 } }, { quantity: 1, lineItem: { id: L2 } }], pageInfo: { hasNextPage: true } } }] }));
    unknown(proofNode({ fulfillments: [ful("101", "2026-11-21T10:00:00Z", [[L1, 2]]), ful("101", "2026-11-22T10:00:00Z", [[L2, 1]])] })); // duplicate fulfillment
    unknown(proofNode({ fulfillments: [ful("101", "2026-11-21T10:00:00Z", [[L1, 2], ["gid://shopify/LineItem/99", 1], [L2, 1]])] })); // unknown line
  });
  it("coverage must be exact on every shippable line: under, over and overcovered non-shipping lines are unknown", () => {
    unknown(proofNode({ fulfillments: [ful("101", "2026-11-21T10:00:00Z", [[L1, 2]])] }));
    unknown(proofNode({ fulfillments: [ful("101", "2026-11-21T10:00:00Z", [[L1, 2], [L2, 1]]), ful("102", "2026-11-22T10:00:00Z", [[L1, 1]])] }));
    unknown(proofNode({ fulfillments: [ful("101", "2026-11-21T10:00:00Z", [[L1, 2], [L2, 1], [L3, 2]])] }));
  });
  it("an earlier contributor's cancellation with a reship is ambiguous history: unknown, never a later cover", () => {
    unknown(proofNode({ fulfillments: [
      ful("101", "2026-11-21T10:00:00Z", [[L1, 2]], null, "CANCELLED"),
      ful("102", "2026-11-22T10:00:00Z", [[L2, 1]], "2026-11-24T09:00:00Z"),
      ful("103", "2026-11-23T10:00:00Z", [[L1, 2]], "2026-11-25T09:00:00Z"),
    ] }));
    unknown(proofNode({ fulfillments: [ful("101", "2026-11-21T10:00:00Z", [[L1, 2], [L2, 1]], null, "OPEN")] }));
    unknown(proofNode({ fulfillments: [ful("101", "2026-11-19T10:00:00Z", [[L1, 2], [L2, 1]])] })); // before the order
  });
  it("the hash is canonical (input order irrelevant) and changes with a corrected delivery time", () => {
    const a = wholeOrderProof(proofNode()) as { hash: string };
    const reordered = proofNode({ fulfillments: [...proofNode().fulfillments].reverse(), lineItems: { nodes: [...proofNode().lineItems.nodes].reverse(), pageInfo: { hasNextPage: false } } });
    expect((wholeOrderProof(reordered) as { hash: string }).hash).toBe(a.hash);
    const corrected = proofNode({ fulfillments: [proofNode().fulfillments[0], { ...proofNode().fulfillments[1], deliveredAt: "2026-11-24T11:00:00Z" }] });
    expect((wholeOrderProof(corrected) as { hash: string }).hash).not.toBe(a.hash);
  });
  it("REST webhook facts never carry whole-order proof", () => {
    const f = factsFromWebhookOrder(ORDER, SHOP);
    expect(evidenceFromFacts(f).some((e) => e.fulfillmentComplete === true)).toBe(false);
  });
});

describe("projection: aggregate whole proof is separate from parcels", () => {
  const e = (over: Record<string, unknown>) => ({ site: "uk", shop: SHOP, shopifyOrderId: "9", orderNumber: "10190203", source: "shopify" as const, kind: "confirmed" as const, receivedAt: "2026-11-25T00:00:00Z", ...over });
  const parcels = [
    e({ key: "order:9:ordered", stage: "ordered", happenedAt: "2026-11-20T09:00:00Z" }),
    e({ key: "fulfillment:101:created", stage: "shipped", happenedAt: "2026-11-21T10:00:00Z", fulfillmentId: "101", fulfillmentComplete: false }),
    e({ key: "fulfillment:102:created", stage: "shipped", happenedAt: "2026-11-22T10:00:00Z", fulfillmentId: "102", fulfillmentComplete: false }),
    e({ key: "fulfillment:101:delivered:confirmed", stage: "delivered", happenedAt: "2026-11-23T09:00:00Z", fulfillmentId: "101" }),
  ];
  const whole = [
    e({ key: "order:9:whole-shipped:r1", stage: "shipped", happenedAt: "2026-11-22T10:00:00Z", fulfillmentComplete: true }),
    e({ key: "order:9:whole-delivered:r1", stage: "delivered", happenedAt: "2026-11-24T09:00:00Z", fulfillmentComplete: true }),
  ];
  it("active proof confirms shipped/delivered and completes shipment metrics; parcel lists keep only parcels", () => {
    const t = projectTimeline([...parcels, ...whole] as never);
    expect(t.stages.shipped).toMatchObject({ status: "confirmed", at: "2026-11-22T10:00:00.000Z" });
    expect(t.stages.delivered).toMatchObject({ status: "confirmed", at: "2026-11-24T09:00:00.000Z" });
    expect(t.completeShipmentAt).toBe("2026-11-22T10:00:00.000Z");
    expect(t.fulfillments.map((f) => f.fulfillmentId)).toEqual(["101", "102"]);
    expect(t.deliveries.map((d) => d.fulfillmentId)).toEqual(["101"]);
  });
  it("a withdrawn proof leaves only partial parcels and no complete-shipment sample", () => {
    const withdrawn = [
      e({ key: "order:9:whole-shipped:r1:withdrawn", stage: "shipped", happenedAt: "2026-11-25T08:00:00Z", retractsKey: "order:9:whole-shipped:r1" }),
      e({ key: "order:9:whole-delivered:r1:withdrawn", stage: "delivered", happenedAt: "2026-11-25T08:00:00Z", retractsKey: "order:9:whole-delivered:r1" }),
    ];
    const t = projectTimeline([...parcels, ...whole, ...withdrawn] as never);
    expect(t.stages.shipped.status).toBe("partial");
    expect(t.stages.delivered.status).toBe("partial");
    expect(t.completeShipmentAt).toBeNull();
    // as of a cutoff before the withdrawal, the proof was active then
    expect(projectTimeline([...parcels, ...whole, ...withdrawn] as never, "2026-11-25T00:00:00Z").completeShipmentAt).toBe("2026-11-22T10:00:00.000Z");
  });
});
