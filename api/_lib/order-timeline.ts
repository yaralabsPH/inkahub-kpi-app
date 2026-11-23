/**
 * F10 Order timeline: authorized reads, signed Shopify ingestion and bounded
 * owner reconciliation (server only).
 *
 * Readers: owner and manager with a site membership; CS only with an explicit
 * Reports permission and membership; staff and kiosk are always refused (this
 * is a whole-order management view). Authorization happens before any
 * service-role read. Reconciliation is owner-only. DTOs contain stages,
 * times, sources and batch/fulfillment ids only: no customer data exists in
 * the store. Durations only: no lateness or classification anywhere.
 */
import { productionRange, type ReportSite } from "../../src/lib/domain/productionPeriods.js";
import {
  flowMetrics, occurrenceKey, projectTimeline, stageGaps, strictIso, TIMELINE_SEQUENCE,
  type EvidenceKind, type EvidenceSource, type FlowMetrics, type OrderEvidence, type OrderStage, type StageGap, type StageStatus, type TimelineView,
} from "../../src/lib/domain/orderTimeline.js";
import { audienceFor, ReportingHttpError, type ReportingPrincipal } from "./production-reporting.js";
import type { RpcClient } from "./reporting-jobs.js";
import {
  evidenceFromFacts, factsFromGraphqlOrder, factsFromWebhookOrder, fetchShopifyOrder, normalizeOrderNumber, routeOrder,
  ShopifyPayloadError, ShopifyReadError, type FetchLike, type RoutingConfig, type ShopifyOrderFacts,
} from "./shopify-webhooks.js";

export const ORDER_ROW_LIMIT = 500;
export const FLOW_ORDER_LIMIT = 2000;
export const FLOW_ROW_LIMIT = 40_000;
export const FLOW_MAX_DAYS = 92;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SITES: readonly string[] = ["au", "uk", "us"];

type Audit = (line: Record<string, string | number>) => void;

/** 403 before any data read. Staff/kiosk never; CS needs explicit Reports; membership always. */
export function authorizeTimeline(p: ReportingPrincipal, site: ReportSite, action: "read" | "reconcile"): void {
  if (p.role === "kiosk" || p.role === "staff") throw new ReportingHttpError(403, "FORBIDDEN", "Order timeline is available to owners, managers and permitted CS only");
  if (action === "reconcile" && p.role !== "owner") throw new ReportingHttpError(403, "FORBIDDEN", "Only an owner can refresh an order's timeline");
  audienceFor(p, site, "reports"); // membership + explicit Reports nav (CS defaults have none)
}

// ---------------------------------------------------------------------------
// Row parsing (0059 order_timeline_row arrays)
// ---------------------------------------------------------------------------

const unavailable = (m: string): never => {
  throw new ReportingHttpError(503, "UNAVAILABLE", `timeline rows: ${m}`);
};
const STAGES: readonly string[] = ["ordered", "cancelled", "framed", "dispatched", "shipped", "delivered", "make_submitted", "make_files_found", "make_planned", "make_images_ready", "make_packing_ready"];
const optStr = (v: unknown) => (v === null ? null : typeof v === "string" ? v : unavailable("text field"));
const optBool = (v: unknown) => (v === null ? null : typeof v === "boolean" ? v : unavailable("flag field"));

export interface StoredEvidence extends OrderEvidence { receivedAt: string; storedSite: string | null }

export function parseEvidenceRows(v: unknown): StoredEvidence[] {
  if (!Array.isArray(v)) return unavailable("not a list");
  return v.map((r): StoredEvidence => {
    if (!Array.isArray(r) || r.length !== 17) return unavailable("row shape");
    const [source, key, stage, kind, happenedAt, receivedAt, fulfillmentId, fulfillmentComplete, workType, framingComplete, caseId, batchId, shop, shopifyOrderId, orderNumber, site, retractsKey] = r as unknown[];
    if (source !== "shopify" && source !== "app" && source !== "make") return unavailable("source");
    if (typeof key !== "string" || typeof stage !== "string" || !STAGES.includes(stage)) return unavailable("key/stage");
    if (kind !== "confirmed" && kind !== "reported" && kind !== "inferred") return unavailable("kind");
    const h = strictIso(happenedAt);
    const rcv = strictIso(receivedAt);
    if (!h || !rcv) return unavailable("times");
    return {
      source, key, stage: stage as OrderStage, kind, happenedAt: h, receivedAt: rcv,
      fulfillmentId: optStr(fulfillmentId), fulfillmentComplete: optBool(fulfillmentComplete), workType: optStr(workType), framingComplete: optBool(framingComplete),
      caseId: optStr(caseId), batchId: optStr(batchId), shop: optStr(shop), shopifyOrderId: optStr(shopifyOrderId), orderNumber: optStr(orderNumber),
      site: "", storedSite: optStr(site), retractsKey: optStr(retractsKey),
    };
  });
}

/** Evidence of ONE routed identity at `site` (the database already isolated site and identity). */
function bindToIdentity(rows: readonly StoredEvidence[], site: ReportSite, shop: string, shopifyOrderId: string): OrderEvidence[] {
  return rows.map((e) => {
    if (e.storedSite !== null && e.storedSite !== site) return unavailable("cross-site row");
    if (e.shopifyOrderId !== null && (e.shop !== shop || e.shopifyOrderId !== shopifyOrderId)) return unavailable("foreign identity row");
    return { ...e, site, shop, shopifyOrderId };
  });
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface StageDto { stage: string; status: StageStatus; at: string | null; source: EvidenceSource | null; kind: EvidenceKind | null }
export interface EvidenceDto {
  stage: string; source: EvidenceSource; kind: EvidenceKind; at: string; receivedAt: string; fulfillmentId: string | null; workType: string | null; batchId: string | null; caseId: string | null;
  /** This record retracts an earlier record of the same source (e.g. a cancelled scan); it is not a stage fact. */
  retraction: boolean;
  /** F11: the Make run/occurrence id for automation evidence (no secrets); null for other sources. */
  runId: string | null;
  /** This record was retracted at or before now and no longer counts. */
  revoked: boolean;
}
export interface OrderTimelineResult {
  site: ReportSite;
  orderNumber: string;
  linked: boolean;
  note: string | null;
  stages: StageDto[] | null;
  gaps: StageGap[];
  cancelled: { at: string | null } | null;
  framedByWorkType: TimelineView["framedByWorkType"];
  fulfillments: TimelineView["fulfillments"];
  deliveries: TimelineView["deliveries"];
  evidence: EvidenceDto[];
}

/** Same rule as projectTimeline: a retraction at or before now revokes the same source's key. */
const revokedAt = (rows: readonly StoredEvidence[], nowMs: number) =>
  new Set(rows.filter((r) => r.retractsKey && Date.parse(r.happenedAt) <= nowMs).map((r) => occurrenceKey({ source: r.source, key: r.retractsKey as string })));
const evidenceDto = (revoked: ReadonlySet<string>) => (e: StoredEvidence): EvidenceDto => ({
  stage: e.stage, source: e.source, kind: e.kind, at: e.happenedAt, receivedAt: e.receivedAt, fulfillmentId: e.fulfillmentId ?? null, workType: e.workType ?? null, batchId: e.batchId ?? null, caseId: e.caseId ?? null,
  retraction: !!e.retractsKey, revoked: revoked.has(occurrenceKey(e)),
  runId: e.source === "make" ? e.key.split("|")[0] : null,
});

function badRequest(m: string): never {
  throw new ReportingHttpError(400, "BAD_REQUEST", m);
}
function siteOf(v: unknown): ReportSite {
  return typeof v === "string" && SITES.includes(v) ? (v as ReportSite) : badRequest("site must be au, uk or us");
}
const rpcFailure = (fn: string, message: string | undefined, audit: Audit | undefined, site: string): never => {
  const tooMany = /exceed the limit/.test(message ?? "");
  const ambiguous = /ambiguous/.test(message ?? "");
  audit?.({ event: tooMany ? "timeline_too_large" : ambiguous ? "timeline_ambiguous" : "timeline_rpc_failed", fn, site });
  if (tooMany) throw new ReportingHttpError(503, "TOO_LARGE", "Too much history for one request; choose a shorter period");
  if (ambiguous) throw new ReportingHttpError(503, "AMBIGUOUS", "Several orders share this number at this site; the timeline cannot choose one");
  throw new ReportingHttpError(503, "UNAVAILABLE", "The order timeline could not be read");
};

export interface ReadDeps { rpc: RpcClient; now(): number; audit?: Audit }

export async function readOrderTimeline(p: ReportingPrincipal, q: Record<string, string>, deps: ReadDeps): Promise<OrderTimelineResult> {
  const site = siteOf(q.site);
  const orderNumber = normalizeOrderNumber(q.orderNumber) ?? badRequest("orderNumber must be 1..64 characters");
  authorizeTimeline(p, site, "read");
  const { data, error } = await deps.rpc.rpc("read_order_timeline", { p_site: site, p_order_number: orderNumber, p_limit: ORDER_ROW_LIMIT });
  if (error) return rpcFailure("read_order_timeline", error.message, deps.audit, site);
  const d = (data ?? {}) as { identity?: { shop?: unknown; shopifyOrderId?: unknown } | null; evidence?: unknown };
  const rows = parseEvidenceRows(d.evidence);
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const base = { site, orderNumber, gaps: [] as StageGap[], cancelled: null, framedByWorkType: [], fulfillments: [], deliveries: [], evidence: rows.map(evidenceDto(revokedAt(rows, nowMs))) };
  if (!d.identity) {
    return { ...base, linked: false, stages: null, note: rows.length ? "Not linked to a Shopify order at this site yet; recorded app events are listed." : "No recorded order with this number at this site." };
  }
  const shop = typeof d.identity.shop === "string" ? d.identity.shop : unavailable("identity shop");
  const id = typeof d.identity.shopifyOrderId === "string" ? d.identity.shopifyOrderId : unavailable("identity order id");
  const bound = bindToIdentity(rows, site, shop, id);
  if (bound.length === 0) return { ...base, linked: true, stages: null, note: "The order is recorded but has no evidence yet." };
  const t = projectTimeline(bound, nowIso);
  return {
    ...base,
    linked: true,
    note: null,
    stages: TIMELINE_SEQUENCE.map((s) => ({ stage: s, ...t.stages[s] })),
    gaps: stageGaps(t, nowIso),
    cancelled: t.stages.cancelled.status === "missing" ? null : { at: t.stages.cancelled.at },
    framedByWorkType: t.framedByWorkType,
    fulfillments: t.fulfillments,
    deliveries: t.deliveries,
  };
}

export interface OrderFlowResult extends FlowMetrics {
  site: ReportSite;
  firstDate: string;
  lastDate: string;
  coverage: { label: string; recordedOrders: number; unroutedOrders: number; latestReceivedAt: { shopify: string | null; app: string | null; make: string | null } };
}

export async function readOrderFlow(p: ReportingPrincipal, q: Record<string, string>, deps: ReadDeps): Promise<OrderFlowResult> {
  const site = siteOf(q.site);
  if (!DATE.test(q.firstDate ?? "") || !DATE.test(q.lastDate ?? "")) badRequest("firstDate and lastDate must be YYYY-MM-DD");
  let range;
  try {
    range = productionRange(site, q.firstDate, q.lastDate);
  } catch (e) {
    return badRequest(e instanceof Error ? e.message : "invalid range");
  }
  if ((Date.parse(`${q.lastDate}T00:00:00Z`) - Date.parse(`${q.firstDate}T00:00:00Z`)) / 86_400_000 + 1 > FLOW_MAX_DAYS) badRequest(`at most ${FLOW_MAX_DAYS} days`);
  authorizeTimeline(p, site, "read");
  const { data, error } = await deps.rpc.rpc("read_order_flow", { p_site: site, p_start: range.startUtc, p_end: range.endUtcExclusive, p_order_limit: FLOW_ORDER_LIMIT, p_row_limit: FLOW_ROW_LIMIT });
  if (error) return rpcFailure("read_order_flow", error.message, deps.audit, site);
  const d = (data ?? {}) as { orders?: unknown; evidence?: unknown; unroutedOrders?: unknown; latestReceivedAt?: Record<string, unknown> };
  const rows = parseEvidenceRows(d.evidence);
  const nowIso = new Date(deps.now()).toISOString();
  const byIdentity = new Map<string, StoredEvidence[]>();
  const appByNumber = new Map<string, StoredEvidence[]>();
  for (const r of rows) {
    if (r.shopifyOrderId) {
      const k = `${r.shop}|${r.shopifyOrderId}`;
      byIdentity.set(k, [...(byIdentity.get(k) ?? []), r]);
    } else if (r.orderNumber) appByNumber.set(r.orderNumber, [...(appByNumber.get(r.orderNumber) ?? []), r]);
  }
  const timelines: TimelineView[] = [];
  const numberOf = (list: StoredEvidence[]) => list.find((e) => e.source === "shopify" && e.orderNumber)?.orderNumber ?? null;
  const numberUse = new Map<string, number>();
  for (const list of byIdentity.values()) {
    const n = numberOf(list);
    if (n) numberUse.set(n, (numberUse.get(n) ?? 0) + 1);
  }
  for (const [k, list] of byIdentity) {
    const [shop, id] = k.split("|");
    const n = numberOf(list);
    // Defence in depth: SQL already attaches app facts only for numbers unique site-wide (any date);
    // here a number repeated inside the cohort is refused as well.
    const num = n && numberUse.get(n) === 1 ? n : null;
    timelines.push(projectTimeline(bindToIdentity([...list, ...(num ? appByNumber.get(num) ?? [] : [])], site, shop, id), nowIso));
  }
  const m = flowMetrics(timelines, { startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive }, nowIso);
  const at = (v: unknown) => (typeof v === "string" ? strictIso(v) : null);
  const lr = d.latestReceivedAt ?? {};
  return {
    ...m,
    site,
    firstDate: range.firstDate,
    lastDate: range.lastDate,
    coverage: {
      label: "Covers orders recorded by the timeline since it was commissioned, not complete Shopify history",
      recordedOrders: typeof d.orders === "number" ? d.orders : unavailable("orders"),
      unroutedOrders: typeof d.unroutedOrders === "number" ? d.unroutedOrders : unavailable("unrouted"),
      latestReceivedAt: { shopify: at(lr.shopify), app: at(lr.app), make: at(lr.make) },
    },
  };
}

// ---------------------------------------------------------------------------
// Ingestion (signed webhook) and owner reconciliation
// ---------------------------------------------------------------------------

export interface IngestResult { accepted: number; duplicates: number; conflicts: number; route: string }

function parseIngest(v: unknown): IngestResult {
  const o = (v ?? {}) as Record<string, unknown>;
  const n = (k: string) => (typeof o[k] === "number" && Number.isSafeInteger(o[k]) ? (o[k] as number) : unavailable(`ingest ${k}`));
  return { accepted: n("accepted"), duplicates: n("duplicates"), conflicts: n("conflicts"), route: typeof o.route === "string" ? o.route : unavailable("ingest route") };
}

/** One order's facts -> routed identity + evidence, persisted atomically. A failure is never acknowledged. */
export async function ingestOrderFacts(rpc: RpcClient, cfg: RoutingConfig, f: ShopifyOrderFacts, audit?: Audit): Promise<IngestResult & { site: string | null }> {
  const route = routeOrder(cfg, f.shop, f.route);
  const { data, error } = await rpc.rpc("ingest_order_timeline", {
    p_order: { shop: f.shop, shopifyOrderId: f.shopifyOrderId, orderNumber: f.orderNumber, site: route.site, routeReason: route.reason },
    p_evidence: evidenceFromFacts(f),
  });
  if (error) {
    audit?.({ event: "timeline_ingest_failed" });
    throw new ReportingHttpError(503, "UNAVAILABLE", "The timeline could not record this order");
  }
  const r = parseIngest(data);
  if (r.conflicts || r.route === "conflict") audit?.({ event: "timeline_conflict", conflicts: r.conflicts, route: r.route });
  return { ...r, site: route.site };
}

export function ingestWebhookPayload(payload: unknown, shop: string): ShopifyOrderFacts {
  try {
    return factsFromWebhookOrder(payload, shop);
  } catch (e) {
    throw new ReportingHttpError(400, "BAD_REQUEST", e instanceof ShopifyPayloadError ? e.message : "invalid order payload");
  }
}

export interface ReconcileDeps {
  /** ORDER_TIMELINE_INGEST === "on". Off = no reconciliation writes at all (rollback switch). */
  enabled: boolean;
  rpc: RpcClient;
  routing: RoutingConfig | null;
  shopify: { shop: string; token: string; fetch: FetchLike } | null;
  audit?: Audit;
}
export interface ReconcileResult {
  site: ReportSite;
  orderNumber: string;
  app: IngestResult;
  shopify: { status: "recorded"; routedHere: boolean; note: string | null; result: IngestResult } | { status: "not_found" | "not_configured"; note: string };
}

/** Owner-only, explicit and bounded: one order at one site. Read-only towards Shopify; never reassigns a site. */
export async function reconcileOrder(p: ReportingPrincipal, body: unknown, deps: ReconcileDeps): Promise<ReconcileResult> {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : badRequest("body must be an object");
  for (const k of Object.keys(b)) if (!["action", "site", "orderNumber"].includes(k)) badRequest(`unknown field ${k.slice(0, 40)}`);
  if (b.action !== "reconcile") badRequest("action must be reconcile");
  const site = siteOf(b.site);
  const orderNumber = normalizeOrderNumber(b.orderNumber) ?? badRequest("orderNumber must be 1..64 characters");
  authorizeTimeline(p, site, "reconcile");
  // rollback switch: with ingestion off, reconciliation writes NOTHING (checked before any RPC or Shopify read)
  if (!deps.enabled) {
    deps.audit?.({ event: "timeline_reconcile_disabled", site });
    throw new ReportingHttpError(503, "DISABLED", "Timeline ingestion is disabled; reconciliation is off");
  }
  const a = await deps.rpc.rpc("reconcile_order_timeline_app", { p_site: site, p_order_number: orderNumber });
  if (a.error) return rpcFailure("reconcile_order_timeline_app", a.error.message, deps.audit, site);
  const app = parseIngest(a.data);
  if (!deps.routing || !deps.shopify) return { site, orderNumber, app, shopify: { status: "not_configured", note: "Shopify reading is not configured; only app events were refreshed" } };
  if (!deps.routing.shops[deps.shopify.shop]) return { site, orderNumber, app, shopify: { status: "not_configured", note: "The configured Shopify shop is not in the routing allowlist" } };
  let node: unknown;
  let facts: ShopifyOrderFacts;
  try {
    node = await fetchShopifyOrder(deps.shopify.fetch, deps.shopify.shop, deps.shopify.token, orderNumber);
    if (node === null) return { site, orderNumber, app, shopify: { status: "not_found", note: "No Shopify order has this number" } };
    facts = factsFromGraphqlOrder(node, deps.shopify.shop);
  } catch (e) {
    deps.audit?.({ event: "timeline_shopify_read_failed", site });
    throw new ReportingHttpError(503, "SHOPIFY_UNAVAILABLE", e instanceof ShopifyReadError || e instanceof ShopifyPayloadError ? e.message : "Shopify could not be read");
  }
  const r = await ingestOrderFacts(deps.rpc, deps.routing, facts, deps.audit);
  const routedHere = r.site === site;
  const note = r.site === null ? "The order's location could not be routed to a site; it stays unlinked"
    : routedHere ? (r.route === "conflict" ? "Shopify routing disagrees with the recorded site; the recorded site was kept" : null)
      : "This order belongs to another site and is not shown here";
  return { site, orderNumber, app, shopify: { status: "recorded", routedHere, note, result: { accepted: r.accepted, duplicates: r.duplicates, conflicts: r.conflicts, route: r.route } } };
}
