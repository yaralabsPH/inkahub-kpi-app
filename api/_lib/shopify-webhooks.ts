/**
 * F10 Shopify adapter (server only, read-only towards Shopify).
 *
 * - verifyShopifyHmac: base64 HMAC-SHA256 of the RAW body with the webhook
 *   secret, constant-time compared. Runs before any JSON parsing.
 * - Routing contract (ORDER_TIMELINE_ROUTING): one shared store routes each
 *   order to a site by an explicitly configured, verified predicate. The shop
 *   itself never implies a site. Unknown, unmapped or ambiguous => unrouted
 *   with a reason (fail closed). The predicate's facts (country/tags/
 *   attributes) are used transiently and never stored or returned.
 * - Order facts from a REST webhook payload or a GraphQL node become source
 *   occurrences with deterministic keys (the same fact from a webhook replay or
 *   a reconciliation is a duplicate, never a second record). No customer data
 *   is carried into evidence.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeShop, ORDER_SITES, strictIso, type EvidenceKind, type OrderSite, type OrderStage } from "../../src/lib/domain/orderTimeline.js";

/** Verified against https://shopify.dev/changelog/release-notes/2026-10 (latest stable on 2026-11-23). */
export const SHOPIFY_ADMIN_API_VERSION = "2026-10";
export const WEBHOOK_MAX_BYTES = 1024 * 1024;
export const ORDER_TOPICS = ["orders/create", "orders/updated", "orders/cancelled", "orders/fulfilled", "orders/partially_fulfilled"] as const;

export function verifyShopifyHmac(raw: Buffer, header: string | undefined, secret: string | undefined): boolean {
  if (typeof secret !== "string" || secret.trim() === "" || typeof header !== "string" || header === "") return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(header)) return false;
  const want = createHmac("sha256", secret).update(raw).digest();
  const got = Buffer.from(header, "base64");
  return got.length === want.length && timingSafeEqual(got, want);
}

// ---------------------------------------------------------------------------
// Routing contract
// ---------------------------------------------------------------------------

export type RoutingRule =
  | { kind: "shipping_country"; map: Record<string, OrderSite> }
  | { kind: "order_tag"; map: Record<string, OrderSite> }
  | { kind: "note_attribute"; name: string; map: Record<string, OrderSite> };
export interface RoutingConfig { version: 1; shops: Record<string, RoutingRule> }
export class RoutingConfigError extends Error {}

/** null when not configured; RoutingConfigError when present but malformed (never guessed). */
export function parseRoutingConfig(raw: string | undefined): RoutingConfig | null {
  if (raw === undefined || raw.trim() === "") return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    throw new RoutingConfigError("routing config is not JSON");
  }
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!obj(o) || o.version !== 1 || !obj(o.shops) || Object.keys(o.shops).length === 0) throw new RoutingConfigError("routing config needs version 1 and at least one shop");
  const shops: Record<string, RoutingRule> = {};
  for (const [shopRaw, r] of Object.entries(o.shops)) {
    const shop = normalizeShop(shopRaw);
    if (!shop || shop !== shopRaw) throw new RoutingConfigError("routing shop must be a normalized *.myshopify.com domain");
    if (!obj(r) || !obj(r.map) || Object.keys(r.map).length === 0 || Object.keys(r.map).length > 500) throw new RoutingConfigError("routing rule needs a non-empty map");
    const map: Record<string, OrderSite> = {};
    for (const [k, v] of Object.entries(r.map)) {
      if (k.trim() === "" || k.length > 100 || !(ORDER_SITES as readonly unknown[]).includes(v)) throw new RoutingConfigError("routing map values must be au, uk or us");
      map[k] = v as OrderSite;
    }
    if (r.kind === "shipping_country") {
      if (!Object.keys(map).every((k) => /^[A-Z]{2}$/.test(k))) throw new RoutingConfigError("country keys must be ISO alpha-2 upper case");
      shops[shop] = { kind: "shipping_country", map };
    } else if (r.kind === "order_tag") shops[shop] = { kind: "order_tag", map };
    else if (r.kind === "note_attribute") {
      if (typeof r.name !== "string" || r.name.trim() === "" || r.name.length > 100) throw new RoutingConfigError("note_attribute rule needs a name");
      shops[shop] = { kind: "note_attribute", name: r.name, map };
    } else throw new RoutingConfigError("unsupported routing rule kind");
  }
  return { version: 1, shops };
}

/** Transient routing facts (never stored). */
export interface RouteFacts { shippingCountry: string | null; tags: string[]; attributes: Array<{ name: string; value: string }> }
export type RouteResult = { site: OrderSite; reason: null } | { site: null; reason: string };

export function routeOrder(cfg: RoutingConfig, shop: string, f: RouteFacts): RouteResult {
  const rule = cfg.shops[shop];
  if (!rule) return { site: null, reason: "shop has no routing rule" };
  let hits: OrderSite[];
  if (rule.kind === "shipping_country") {
    if (!f.shippingCountry) return { site: null, reason: "order has no shipping country" };
    hits = rule.map[f.shippingCountry.toUpperCase()] ? [rule.map[f.shippingCountry.toUpperCase()]] : [];
  } else if (rule.kind === "order_tag") {
    hits = f.tags.map((t) => rule.map[t.trim()]).filter((s): s is OrderSite => !!s);
  } else {
    hits = f.attributes.filter((a) => a.name === rule.name).map((a) => rule.map[a.value.trim()]).filter((s): s is OrderSite => !!s);
  }
  const sites = [...new Set(hits)];
  if (sites.length === 0) return { site: null, reason: "order location is not mapped to a site" };
  if (sites.length > 1) return { site: null, reason: "order location maps to several sites" };
  return { site: sites[0], reason: null };
}

// ---------------------------------------------------------------------------
// Order facts -> evidence
// ---------------------------------------------------------------------------

export interface FulfillmentFact { id: string; createdAt: string; success: boolean; deliveredAt: string | null; deliveredReportedAt: string | null }
export interface ShopifyOrderFacts {
  shop: string;
  shopifyOrderId: string;
  orderNumber: string;
  createdAt: string;
  cancelledAt: string | null;
  fulfillmentStatus: "fulfilled" | "partial" | "other";
  fulfillments: FulfillmentFact[];
  route: RouteFacts;
}
export class ShopifyPayloadError extends Error {}

/** The order name as an alias: trimmed, one leading "#" removed (app scans use the bare number). */
export function normalizeOrderNumber(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^#/, "").trim();
  return s.length >= 1 && s.length <= 64 && !/[\u0000-\u001f]/.test(s) ? s : null;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const gidId = (v: unknown, type: string) => {
  const m = typeof v === "string" ? new RegExp(`^gid://shopify/${type}/(\\d{1,20})$`).exec(v) : null;
  return m ? m[1] : null;
};
const idText = (v: unknown) => (typeof v === "string" && /^\d{1,20}$/.test(v) ? v : typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? String(v) : null);
const need = <T>(v: T | null | undefined, what: string): T => {
  if (v === null || v === undefined) throw new ShopifyPayloadError(`order payload: ${what}`);
  return v;
};
const MAX_FULFILLMENTS = 100;

/** A REST order webhook payload (orders/* topics). */
export function factsFromWebhookOrder(payload: unknown, shop: string): ShopifyOrderFacts {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ShopifyPayloadError("order payload: not an object");
  const p = payload as Record<string, unknown>;
  const id = need(gidId(p.admin_graphql_api_id, "Order") ?? idText(p.id), "id");
  const fs = Array.isArray(p.fulfillments) ? p.fulfillments : [];
  if (fs.length > MAX_FULFILLMENTS) throw new ShopifyPayloadError("order payload: too many fulfillments");
  const ship = p.shipping_address && typeof p.shipping_address === "object" ? (p.shipping_address as Record<string, unknown>) : null;
  return {
    shop,
    shopifyOrderId: id,
    orderNumber: need(normalizeOrderNumber(p.name), "name"),
    createdAt: need(strictIso(p.created_at), "created_at"),
    cancelledAt: p.cancelled_at == null ? null : need(strictIso(p.cancelled_at), "cancelled_at"),
    fulfillmentStatus: p.fulfillment_status === "fulfilled" ? "fulfilled" : p.fulfillment_status === "partial" ? "partial" : "other",
    fulfillments: fs.map((f) => {
      const o = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
      const delivered = o.shipment_status === "delivered";
      return {
        id: need(gidId(o.admin_graphql_api_id, "Fulfillment") ?? idText(o.id), "fulfillment id"),
        createdAt: need(strictIso(o.created_at), "fulfillment created_at"),
        success: o.status === "success",
        deliveredAt: null, // REST payloads carry no carrier delivery time
        deliveredReportedAt: delivered ? need(strictIso(o.updated_at), "fulfillment updated_at") : null,
      };
    }),
    route: {
      shippingCountry: ship ? str(ship.country_code) : null,
      tags: typeof p.tags === "string" ? p.tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 250) : [],
      attributes: (Array.isArray(p.note_attributes) ? p.note_attributes : []).slice(0, 100)
        .map((a) => (a && typeof a === "object" ? { name: str((a as Record<string, unknown>).name) ?? "", value: str((a as Record<string, unknown>).value) ?? "" } : { name: "", value: "" })),
    },
  };
}

/** A GraphQL Admin order node from ORDER_TIMELINE_QUERY. */
export function factsFromGraphqlOrder(node: unknown, shop: string): ShopifyOrderFacts {
  if (!node || typeof node !== "object") throw new ShopifyPayloadError("order node: not an object");
  const n = node as Record<string, unknown>;
  const fs = Array.isArray(n.fulfillments) ? n.fulfillments : [];
  if (fs.length >= FULFILLMENT_PAGE) throw new ShopifyPayloadError("order node: fulfillment list may be incomplete");
  const ship = n.shippingAddress && typeof n.shippingAddress === "object" ? (n.shippingAddress as Record<string, unknown>) : null;
  const status = n.displayFulfillmentStatus;
  return {
    shop,
    shopifyOrderId: need(idText(n.legacyResourceId), "legacyResourceId"),
    orderNumber: need(normalizeOrderNumber(n.name), "name"),
    createdAt: need(strictIso(n.createdAt), "createdAt"),
    cancelledAt: n.cancelledAt == null ? null : need(strictIso(n.cancelledAt), "cancelledAt"),
    fulfillmentStatus: status === "FULFILLED" ? "fulfilled" : status === "PARTIALLY_FULFILLED" ? "partial" : "other",
    fulfillments: fs.map((f) => {
      const o = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
      return {
        id: need(idText(o.legacyResourceId), "fulfillment legacyResourceId"),
        createdAt: need(strictIso(o.createdAt), "fulfillment createdAt"),
        success: o.status === "SUCCESS",
        deliveredAt: o.deliveredAt == null ? null : need(strictIso(o.deliveredAt), "fulfillment deliveredAt"),
        deliveredReportedAt: null,
      };
    }),
    route: {
      shippingCountry: ship ? str(ship.countryCodeV2) : null,
      tags: Array.isArray(n.tags) ? n.tags.filter((t): t is string => typeof t === "string").slice(0, 250) : [],
      attributes: (Array.isArray(n.customAttributes) ? n.customAttributes : []).slice(0, 100)
        .map((a) => (a && typeof a === "object" ? { name: str((a as Record<string, unknown>).key) ?? "", value: str((a as Record<string, unknown>).value) ?? "" } : { name: "", value: "" })),
    },
  };
}

/** The ingestion record shape (0059 ingest_order_timeline). Shopify evidence never names a site. */
export interface EvidenceInput {
  source: "shopify" | "app" | "make";
  key: string;
  site: OrderSite | null;
  shop: string | null;
  shopifyOrderId: string | null;
  orderNumber: string | null;
  stage: OrderStage;
  kind: EvidenceKind;
  happenedAt: string;
  fulfillmentId?: string | null;
  fulfillmentComplete?: boolean | null;
}

/**
 * Deterministic occurrence keys per fact. A fulfillment completes the order
 * only when the order reports fulfilled AND it is the latest successful one;
 * cancelled/failed fulfillments are not shipments. Carrier delivery time from
 * GraphQL is confirmed; a REST "delivered" status (time = last update) is
 * reported only.
 */
export function evidenceFromFacts(f: ShopifyOrderFacts): EvidenceInput[] {
  const base = { source: "shopify" as const, site: null, shop: f.shop, shopifyOrderId: f.shopifyOrderId, orderNumber: f.orderNumber };
  const out: EvidenceInput[] = [{ ...base, key: `order:${f.shopifyOrderId}:ordered`, stage: "ordered", kind: "confirmed", happenedAt: f.createdAt }];
  if (f.cancelledAt) out.push({ ...base, key: `order:${f.shopifyOrderId}:cancelled`, stage: "cancelled", kind: "confirmed", happenedAt: f.cancelledAt });
  const ok = f.fulfillments.filter((x) => x.success).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1));
  ok.forEach((x, i) => {
    const complete = f.fulfillmentStatus === "fulfilled" && i === ok.length - 1;
    out.push({ ...base, key: `fulfillment:${x.id}:shipped:${complete ? "complete" : "partial"}`, stage: "shipped", kind: "confirmed", happenedAt: x.createdAt, fulfillmentId: x.id, fulfillmentComplete: complete });
    if (x.deliveredAt) out.push({ ...base, key: `fulfillment:${x.id}:delivered:confirmed`, stage: "delivered", kind: "confirmed", happenedAt: x.deliveredAt, fulfillmentId: x.id });
    else if (x.deliveredReportedAt) out.push({ ...base, key: `fulfillment:${x.id}:delivered:reported`, stage: "delivered", kind: "reported", happenedAt: x.deliveredReportedAt, fulfillmentId: x.id });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Raw body and read-only GraphQL lookup
// ---------------------------------------------------------------------------

export class BodyError extends Error {
  constructor(readonly code: "TOO_LARGE" | "RAW_BODY_UNAVAILABLE", message: string) {
    super(message);
  }
}

export interface RawBodyRequest {
  body?: unknown;
  readableEnded?: boolean;
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
}

/**
 * The exact request bytes. Prefers the unread stream; accepts a Buffer/string
 * body. An already-parsed object cannot be verified and is refused (fail closed).
 */
export async function readRawBody(req: RawBodyRequest, maxBytes: number): Promise<Buffer> {
  if (typeof req[Symbol.asyncIterator] === "function" && req.readableEnded === false) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req as AsyncIterable<unknown>) {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
      size += b.length;
      if (size > maxBytes) throw new BodyError("TOO_LARGE", "request body is too large");
      chunks.push(b);
    }
    return Buffer.concat(chunks);
  }
  const body = req.body;
  const b = Buffer.isBuffer(body) ? body : typeof body === "string" ? Buffer.from(body, "utf8") : null;
  if (!b) throw new BodyError("RAW_BODY_UNAVAILABLE", "the raw request body is unavailable");
  if (b.length > maxBytes) throw new BodyError("TOO_LARGE", "request body is too large");
  return b;
}

const FULFILLMENT_PAGE = 50;
export const ORDER_TIMELINE_QUERY = `query OrderTimeline($q: String!) {
  orders(first: 2, query: $q) {
    nodes {
      legacyResourceId name createdAt cancelledAt displayFulfillmentStatus tags
      customAttributes { key value }
      shippingAddress { countryCodeV2 }
      fulfillments(first: ${FULFILLMENT_PAGE}) { legacyResourceId createdAt status deliveredAt }
    }
  }
}`;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export class ShopifyReadError extends Error {}

/** Read-only: one order by its number. null = not found; several matches or any error throws (never a guess). */
export async function fetchShopifyOrder(fetchFn: FetchLike, shop: string, token: string, orderNumber: string): Promise<unknown | null> {
  const r = await fetchFn(`https://${shop}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query: ORDER_TIMELINE_QUERY, variables: { q: `name:${JSON.stringify(`#${orderNumber}`)}` } }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new ShopifyReadError("Shopify could not be reached");
  });
  if (!r.ok) throw new ShopifyReadError(`Shopify returned HTTP ${r.status}`);
  const body = (await r.json().catch(() => null)) as { data?: { orders?: { nodes?: unknown[] } }; errors?: unknown } | null;
  if (!body || body.errors || !Array.isArray(body.data?.orders?.nodes)) throw new ShopifyReadError("Shopify returned an unexpected response");
  const nodes = body.data.orders.nodes;
  if (nodes.length > 1) throw new ShopifyReadError("Several Shopify orders match this number");
  return nodes[0] ?? null;
}
