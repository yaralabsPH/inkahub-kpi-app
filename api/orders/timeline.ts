/**
 * /api/orders/timeline — F10 order timeline (one function slot; replaces the
 * retired unauthenticated /api/shopify/whoami diagnostic).
 *
 *   GET  ?action=order&site=&orderNumber=          app session (owner/manager/permitted CS)
 *   GET  ?action=flow&site=&firstDate=&lastDate=   app session (same readers)
 *   POST {action:"reconcile", site, orderNumber}   app session, owner only
 *   POST (Shopify order webhook)                   X-Shopify-Hmac-Sha256 over the raw body only
 *   GET  ?action=make_batch&site=&batchId=         app session (same readers): F11 batch membership status
 *   POST (F11 Make part report, schemaVersion 1)   x-inka-make-scope + x-inka-make-key only (MAKE_MILESTONE_SCOPES)
 *
 * Exactly one auth method per request (session, Shopify signature or Make scope key).
 * The two auth paths are separate: a request carrying a Shopify signature is
 * ONLY ever verified as a webhook (no session fallback), and one carrying both
 * a session and a signature is refused. Webhooks: size limit, secret present,
 * raw-body HMAC, allowlisted shop and enabled ingestion are all checked before
 * any JSON parsing or database work. Persistence failures are never
 * acknowledged (503 so Shopify retries). No-store responses.
 *
 * Environment (server only): SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY,
 * SUPABASE_ANON_KEY, ORDER_TIMELINE_INGEST=on, ORDER_TIMELINE_ROUTING (JSON
 * routing contract), SHOPIFY_WEBHOOK_SECRET, and for owner reconciliation
 * SHOPIFY_SHOP_DOMAIN + SHOPIFY_ADMIN_TOKEN (read-only use).
 */
import { authorizeReportingRequest, bearerToken, errorResponse, ReportingHttpError, type AuthDeps } from "../_lib/production-reporting.js";
import { supabaseAuthDeps } from "../_lib/production-reporting-rpc.js";
import { serviceRpcClient, type MinimalRequest, type MinimalResponse } from "../_lib/reporting-auth.js";
import type { RpcClient } from "../_lib/reporting-jobs.js";
import { ingestOrderFacts, ingestWebhookPayload, readOrderFlow, readOrderTimeline, reconcileOrder } from "../_lib/order-timeline.js";
import {
  BodyError, ORDER_TOPICS, parseRoutingConfig, readRawBody, RoutingConfigError, verifyShopifyHmac, WEBHOOK_MAX_BYTES,
  type FetchLike, type RawBodyRequest, type RoutingConfig,
} from "../_lib/shopify-webhooks.js";
import { queryRecord } from "../reports/summary.js";
import { normalizeShop } from "../../src/lib/domain/orderTimeline.js";
import {
  authenticateMake, EnvelopeError, ingestMakeEnvelope, MAKE_BODY_MAX_BYTES, MakeConflict, parseMakeScopes, readMakeBatch, validateEnvelope,
} from "../_lib/make-milestones.js";

export interface TimelineHandlerDeps {
  auth(): AuthDeps | null;
  rpc(): RpcClient | null;
  env(): Record<string, string | undefined>;
  fetch: FetchLike;
  now(): number;
  audit?(line: Record<string, string | number>): void;
}
const defaults = (): TimelineHandlerDeps => ({
  auth: () => supabaseAuthDeps(),
  rpc: () => serviceRpcClient(),
  env: () => process.env,
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  audit: (line) => console.warn("[order-timeline]", JSON.stringify(line)),
});

const header = (req: MinimalRequest, name: string): string | undefined => {
  const keys = Object.keys(req.headers ?? {}).filter((k) => k.toLowerCase() === name);
  if (keys.length !== 1) return undefined;
  const v = (req.headers as Record<string, unknown>)[keys[0]];
  return typeof v === "string" ? v : undefined;
};
const hasHeader = (req: MinimalRequest, name: string) => Object.keys(req.headers ?? {}).some((k) => k.toLowerCase() === name);

/** Routing contract or a fail-closed reason (never guessed). */
function routing(env: Record<string, string | undefined>): { cfg: RoutingConfig | null; problem: string | null } {
  try {
    const cfg = parseRoutingConfig(env.ORDER_TIMELINE_ROUTING);
    return { cfg, problem: cfg ? null : "Order routing is not configured" };
  } catch (e) {
    return { cfg: null, problem: e instanceof RoutingConfigError ? `Order routing is invalid: ${e.message}` : "Order routing is invalid" };
  }
}

export function createOrderTimelineHandler(deps: TimelineHandlerDeps = defaults()) {
  async function webhook(req: MinimalRequest & RawBodyRequest, res: MinimalResponse) {
    const env = deps.env();
    const declared = Number(header(req, "content-length") ?? "0");
    if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BYTES) return void res.status(413).json({ error: "Payload too large", code: "TOO_LARGE" });
    const secret = env.SHOPIFY_WEBHOOK_SECRET;
    if (!secret) return void res.status(503).json({ error: "Webhook verification is not configured", code: "CONFIG" });
    let raw: Buffer;
    try {
      raw = await readRawBody(req, WEBHOOK_MAX_BYTES);
    } catch (e) {
      if (e instanceof BodyError && e.code === "TOO_LARGE") return void res.status(413).json({ error: "Payload too large", code: "TOO_LARGE" });
      deps.audit?.({ event: "webhook_raw_body_unavailable" });
      return void res.status(503).json({ error: "Raw body unavailable", code: "CONFIG" });
    }
    if (!verifyShopifyHmac(raw, header(req, "x-shopify-hmac-sha256"), secret)) {
      deps.audit?.({ event: "webhook_bad_signature" });
      return void res.status(401).json({ error: "Invalid signature", code: "UNAUTHENTICATED" });
    }
    const { cfg, problem } = routing(env);
    const shop = normalizeShop(header(req, "x-shopify-shop-domain"));
    if (!shop || (cfg && !cfg.shops[shop])) return void res.status(403).json({ error: "Shop is not allowed", code: "FORBIDDEN" });
    if (env.ORDER_TIMELINE_INGEST !== "on" || !cfg) return void res.status(503).json({ error: problem ?? "Timeline ingestion is disabled", code: "DISABLED" });
    const topic = header(req, "x-shopify-topic");
    if (!topic || !(ORDER_TOPICS as readonly string[]).includes(topic)) return void res.status(200).json({ ignored: true });
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return void res.status(400).json({ error: "Body is not JSON", code: "BAD_REQUEST" });
    }
    const rpc = deps.rpc();
    if (!rpc) return void res.status(503).json({ error: "Timeline storage is not configured", code: "CONFIG" });
    try {
      const r = await ingestOrderFacts(rpc, cfg, ingestWebhookPayload(payload, shop), deps.audit);
      res.status(200).json({ accepted: r.accepted, duplicates: r.duplicates, conflicts: r.conflicts, route: r.route });
    } catch (e) {
      const { status, body } = errorResponse(e);
      res.status(status).json(body);
    }
  }

  /** F11: one Make part report. Scope auth before any body read/parse/database work; site/shop only from the scope. */
  async function makeReport(req: MinimalRequest & RawBodyRequest, res: MinimalResponse) {
    const env = deps.env();
    let scopes;
    try {
      scopes = parseMakeScopes(env.MAKE_MILESTONE_SCOPES);
    } catch {
      return void res.status(503).json({ error: "Milestone scopes are invalid", code: "CONFIG" });
    }
    if (!scopes) return void res.status(503).json({ error: "Milestone reporting is not configured", code: "CONFIG" });
    const scope = authenticateMake(req.headers, scopes);
    if (!scope) {
      deps.audit?.({ event: "make_bad_key" });
      return void res.status(401).json({ error: "Invalid milestone credentials", code: "UNAUTHENTICATED" });
    }
    if (env.ORDER_TIMELINE_INGEST !== "on") return void res.status(503).json({ error: "Timeline ingestion is disabled", code: "DISABLED" });
    const declared = Number(header(req, "content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAKE_BODY_MAX_BYTES) return void res.status(413).json({ error: "Payload too large", code: "TOO_LARGE" });
    let envelope;
    try {
      const raw = await readRawBody(req, MAKE_BODY_MAX_BYTES).catch((e) => {
        // a runtime that already parsed JSON is acceptable here (no signature over the bytes); size is re-checked
        if (e instanceof BodyError && e.code === "RAW_BODY_UNAVAILABLE" && req.body && typeof req.body === "object") {
          const text = JSON.stringify(req.body);
          if (Buffer.byteLength(text, "utf8") > MAKE_BODY_MAX_BYTES) throw new BodyError("TOO_LARGE", "request body is too large");
          return Buffer.from(text, "utf8");
        }
        throw e;
      });
      envelope = validateEnvelope(JSON.parse(raw.toString("utf8")), deps.now());
    } catch (e) {
      if (e instanceof BodyError && e.code === "TOO_LARGE") return void res.status(413).json({ error: "Payload too large", code: "TOO_LARGE" });
      return void res.status(400).json({ error: e instanceof EnvelopeError ? e.message : "Body must be a JSON envelope", code: "BAD_REQUEST" });
    }
    const rpc = deps.rpc();
    if (!rpc) return void res.status(503).json({ error: "Timeline storage is not configured", code: "CONFIG" });
    try {
      const r = await ingestMakeEnvelope(rpc, scope, envelope, deps.audit);
      res.status(200).json({ result: r.result, stage: envelope.stage, occurrenceId: envelope.occurrenceId, members: r.members });
    } catch (e) {
      if (e instanceof MakeConflict) return void res.status(409).json({ error: e.message, code: "CONFLICT" });
      const { status, body } = errorResponse(e);
      res.status(status).json(body);
    }
  }

  return async function handler(req: MinimalRequest & RawBodyRequest, res: MinimalResponse) {
    res.setHeader("Cache-Control", "no-store");
    const signed = hasHeader(req, "x-shopify-hmac-sha256");
    const session = hasHeader(req, "authorization");
    const make = hasHeader(req, "x-inka-make-key") || hasHeader(req, "x-inka-make-scope");
    if ([signed, session, make].filter(Boolean).length > 1) return void res.status(400).json({ error: "Use one authentication method", code: "BAD_REQUEST" });
    if (make) {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return void res.status(405).json({ error: "Method not allowed", code: "METHOD" });
      }
      return makeReport(req, res);
    }
    if (signed) {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return void res.status(405).json({ error: "Method not allowed", code: "METHOD" });
      }
      return webhook(req, res);
    }
    if (!bearerToken(req.headers)) return void res.status(401).json({ error: "A valid app session is required", code: "UNAUTHENTICATED" });
    try {
      const auth = deps.auth();
      if (!auth) throw new ReportingHttpError(500, "CONFIG", "Timeline service configuration missing");
      const { principal } = await authorizeReportingRequest(req.headers, auth);
      const rpc = deps.rpc();
      if (req.method === "GET") {
        const q = queryRecord(req.query, ["action", "site", "orderNumber", "firstDate", "lastDate", "batchId"]);
        if (q.action !== "order" && q.action !== "flow" && q.action !== "make_batch") throw new ReportingHttpError(400, "BAD_REQUEST", "action must be order, flow or make_batch");
        const { action, ...rest } = q;
        if (!rpc) throw new ReportingHttpError(500, "CONFIG", "Timeline service configuration missing");
        const readDeps = { rpc, now: deps.now, audit: deps.audit };
        if (action === "make_batch") return void res.status(200).json(await readMakeBatch(principal, rest, rpc, deps.env().MAKE_MILESTONE_SCOPES));
        if ("batchId" in rest) throw new ReportingHttpError(400, "BAD_REQUEST", "unknown parameter batchId");
        if (action === "order") {
          for (const k of Object.keys(rest)) if (k !== "site" && k !== "orderNumber") throw new ReportingHttpError(400, "BAD_REQUEST", `unknown parameter ${k}`);
          return void res.status(200).json(await readOrderTimeline(principal, rest, readDeps));
        }
        for (const k of Object.keys(rest)) if (k === "orderNumber") throw new ReportingHttpError(400, "BAD_REQUEST", "unknown parameter orderNumber");
        return void res.status(200).json(await readOrderFlow(principal, rest, readDeps));
      }
      if (req.method === "POST") {
        let body: unknown;
        try {
          const raw = await readRawBody(req, 16 * 1024).catch((e) => {
            if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && e instanceof BodyError && e.code === "RAW_BODY_UNAVAILABLE") return null;
            throw e;
          });
          body = raw === null ? req.body : JSON.parse(raw.toString("utf8"));
        } catch {
          throw new ReportingHttpError(400, "BAD_REQUEST", "body must be a small JSON object");
        }
        if (!rpc) throw new ReportingHttpError(500, "CONFIG", "Timeline service configuration missing");
        const env = deps.env();
        const { cfg } = routing(env);
        const shop = normalizeShop(env.SHOPIFY_SHOP_DOMAIN);
        const enabled = env.ORDER_TIMELINE_INGEST === "on";
        const shopify = enabled && shop && env.SHOPIFY_ADMIN_TOKEN ? { shop, token: env.SHOPIFY_ADMIN_TOKEN, fetch: deps.fetch } : null;
        return void res.status(200).json(await reconcileOrder(principal, body, { enabled, rpc, routing: enabled ? cfg : null, shopify, audit: deps.audit }));
      }
      res.setHeader("Allow", "GET, POST");
      res.status(405).json({ error: "Method not allowed", code: "METHOD" });
    } catch (e) {
      const { status, body } = errorResponse(e);
      res.status(status).json(body);
    }
  };
}

export default createOrderTimelineHandler();
