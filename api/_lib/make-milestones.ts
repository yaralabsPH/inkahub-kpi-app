/**
 * F11 Make milestones receiver (server only).
 *
 * One authenticated HTTP report per Make part. Auth is separate from app
 * sessions and Shopify webhooks: headers `x-inka-make-scope` + `x-inka-make-key`
 * against MAKE_MILESTONE_SCOPES (server env JSON), compared in constant time
 * BEFORE any body read, parse or database work. The scope fixes site and shop;
 * the envelope can never name them. Envelopes (schemaVersion 1) are strictly
 * bounded and validated, then accepted atomically by the service-only 0060
 * ingest_make_milestone. A failure is never acknowledged.
 */
import { timingSafeEqual } from "node:crypto";
import { normalizeShop, strictIso, type OrderSite } from "../../src/lib/domain/orderTimeline.js";
import { ReportingHttpError, type ReportingPrincipal } from "./production-reporting.js";
import { authorizeTimeline } from "./order-timeline.js";
import type { RpcClient } from "./reporting-jobs.js";
import { normalizeOrderNumber } from "./shopify-webhooks.js";

export const MAKE_STAGES = ["submitted", "files_found", "planned", "images_ready", "packing_slips_ready"] as const;
export type MakeStage = (typeof MAKE_STAGES)[number];
export const MAKE_BODY_MAX_BYTES = 256 * 1024;
export const MAKE_MEMBERS_MAX = 500;
export const MAKE_FUTURE_SKEW_MS = 5 * 60_000;
const ID = /^[A-Za-z0-9._:#/-]+$/;

export interface MakeScope { name: string; site: OrderSite; shop: string; secret: string }
export class MakeConfigError extends Error {}

/** MAKE_MILESTONE_SCOPES = {"<scope>":{"site":"au","shop":"<shop>.myshopify.com","secret":"<>=32 chars>"}}. null when unset. */
export function parseMakeScopes(raw: string | undefined): Map<string, MakeScope> | null {
  if (raw === undefined || raw.trim() === "") return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    throw new MakeConfigError("scopes are not JSON");
  }
  if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).length === 0) throw new MakeConfigError("scopes must be a non-empty object");
  const out = new Map<string, MakeScope>();
  for (const [name, v] of Object.entries(o as Record<string, unknown>)) {
    const s = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new MakeConfigError("scope names are lower-case letters, digits and dashes");
    if (s.site !== "au" && s.site !== "uk" && s.site !== "us") throw new MakeConfigError("scope site must be au, uk or us");
    const shop = normalizeShop(typeof s.shop === "string" ? s.shop : null);
    if (!shop || shop !== s.shop) throw new MakeConfigError("scope shop must be a normalized *.myshopify.com domain");
    if (typeof s.secret !== "string" || s.secret.length < 32) throw new MakeConfigError("scope secret must be at least 32 characters");
    out.set(name, { name, site: s.site, shop, secret: s.secret });
  }
  return out;
}

type Headers = Record<string, string | string[] | undefined> | undefined;
const one = (h: Headers, name: string): string | null => {
  const keys = Object.keys(h ?? {}).filter((k) => k.toLowerCase() === name);
  if (keys.length !== 1) return null;
  const v = (h as Record<string, unknown>)[keys[0]];
  return typeof v === "string" ? v : null;
};

/** The authenticated scope, or null. Unknown scope and wrong key take the same constant-time path. */
export function authenticateMake(headers: Headers, scopes: ReadonlyMap<string, MakeScope>): MakeScope | null {
  const name = one(headers, "x-inka-make-scope");
  const key = one(headers, "x-inka-make-key");
  if (!name || !key) return null;
  const scope = scopes.get(name);
  const want = Buffer.from(scope?.secret ?? "x".repeat(64), "utf8");
  const got = Buffer.from(key, "utf8");
  const same = got.length === want.length && timingSafeEqual(got, want);
  return scope && same ? scope : null;
}

export interface MakeEnvelope {
  schemaVersion: 1;
  stage: MakeStage;
  occurrenceId: string;
  happenedAt: string;
  batchId: string;
  membershipVersion: number;
  members: Array<{ memberKey: string; orderNumber?: string; shopifyOrderId?: string }>;
}
export class EnvelopeError extends Error {}

const bad = (m: string): never => {
  throw new EnvelopeError(m);
};

/** Strict schemaVersion 1 validation. Unknown fields (including site/shop) are refused. */
export function validateEnvelope(v: unknown, nowMs: number): MakeEnvelope {
  if (!v || typeof v !== "object" || Array.isArray(v)) return bad("envelope must be an object");
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["schemaVersion", "stage", "occurrenceId", "happenedAt", "batchId", "membershipVersion", "members"].includes(k)) bad(`unknown field ${k.slice(0, 40)}`);
  if (o.schemaVersion !== 1) bad("schemaVersion must be 1");
  if (!(MAKE_STAGES as readonly unknown[]).includes(o.stage)) bad("stage must be one of submitted, files_found, planned, images_ready, packing_slips_ready");
  const stage = o.stage as MakeStage;
  if (typeof o.occurrenceId !== "string" || o.occurrenceId.length > 120 || !ID.test(o.occurrenceId)) bad("occurrenceId must be 1..120 of A-Z a-z 0-9 . _ : # / -");
  if (typeof o.batchId !== "string" || o.batchId.length > 100 || !ID.test(o.batchId)) bad("batchId must be 1..100 of A-Z a-z 0-9 . _ : # / -");
  const at = strictIso(o.happenedAt);
  if (!at) bad("happenedAt must be an explicit UTC/offset ISO instant");
  if (Date.parse(at as string) > nowMs + MAKE_FUTURE_SKEW_MS) bad("happenedAt is in the future");
  if (typeof o.membershipVersion !== "number" || !Number.isSafeInteger(o.membershipVersion) || o.membershipVersion < 1 || o.membershipVersion > 1_000_000) bad("membershipVersion must be an integer 1..1000000");
  if (!Array.isArray(o.members) || o.members.length < 1 || o.members.length > MAKE_MEMBERS_MAX) bad(`members must list 1..${MAKE_MEMBERS_MAX} entries`);
  const seen = new Set<string>();
  const members = (o.members as unknown[]).map((m) => {
    if (!m || typeof m !== "object" || Array.isArray(m)) return bad("each member must be an object");
    const r = m as Record<string, unknown>;
    const allowed = stage === "submitted" ? ["memberKey", "orderNumber"] : stage === "files_found" ? ["memberKey", "shopifyOrderId"] : ["memberKey"];
    for (const k of Object.keys(r)) if (!allowed.includes(k)) bad(`${stage} members may only carry ${allowed.join(", ")}`);
    if (typeof r.memberKey !== "string" || r.memberKey.length > 64 || !ID.test(r.memberKey)) bad("memberKey must be 1..64 of A-Z a-z 0-9 . _ : # / -");
    if (seen.has(r.memberKey as string)) bad("member keys must be unique");
    seen.add(r.memberKey as string);
    if (stage === "submitted") {
      const n = normalizeOrderNumber(r.orderNumber);
      if (!n) bad("orderNumber must be 1..64 characters");
      return { memberKey: r.memberKey as string, orderNumber: n as string };
    }
    if (stage === "files_found") {
      if (typeof r.shopifyOrderId !== "string" || !/^\d{1,20}$/.test(r.shopifyOrderId)) bad("shopifyOrderId must be the numeric Shopify order id as a string");
      return { memberKey: r.memberKey as string, shopifyOrderId: r.shopifyOrderId as string };
    }
    return { memberKey: r.memberKey as string };
  });
  return { schemaVersion: 1, stage, occurrenceId: o.occurrenceId as string, happenedAt: at as string, batchId: o.batchId as string, membershipVersion: o.membershipVersion as number, members };
}

export interface MakeIngestResult { result: "accepted" | "duplicate"; members: Record<string, number> }

/** Durable atomic acceptance; 409 for a conflicting occurrence/membership (nothing written), 503 when not persisted. */
export async function ingestMakeEnvelope(rpc: RpcClient, scope: MakeScope, e: MakeEnvelope, audit?: (l: Record<string, string>) => void): Promise<MakeIngestResult> {
  const { schemaVersion: _v, ...envelope } = e;
  const { data, error } = await rpc.rpc("ingest_make_milestone", { p_site: scope.site, p_shop: scope.shop, p_scope: scope.name, p_envelope: envelope });
  if (error) {
    audit?.({ event: "make_ingest_failed", scope: scope.name, stage: e.stage });
    throw new ReportingHttpError(503, "UNAVAILABLE", "The milestone could not be recorded; retry the original envelope");
  }
  const d = (data ?? {}) as { result?: unknown; reason?: unknown; members?: unknown };
  if (d.result === "conflict") {
    audit?.({ event: "make_conflict", scope: scope.name, stage: e.stage });
    throw new MakeConflict(typeof d.reason === "string" ? d.reason : "conflict");
  }
  if (d.result !== "accepted" && d.result !== "duplicate") throw new ReportingHttpError(503, "UNAVAILABLE", "Unexpected milestone result");
  const members = d.members && typeof d.members === "object" ? (d.members as Record<string, number>) : {};
  return { result: d.result, members };
}
export class MakeConflict extends Error {}

/**
 * Owner/manager/permitted CS: one batch's membership status (unresolved and fail-closed members stay visible).
 * The shop is the single configured scope for the site; authorization precedes the read.
 */
export async function readMakeBatch(p: ReportingPrincipal, q: Record<string, string>, rpc: RpcClient, scopesRaw: string | undefined): Promise<unknown> {
  for (const k of Object.keys(q)) if (k !== "site" && k !== "batchId") throw new ReportingHttpError(400, "BAD_REQUEST", `unknown parameter ${k}`);
  if (q.site !== "au" && q.site !== "uk" && q.site !== "us") throw new ReportingHttpError(400, "BAD_REQUEST", "site must be au, uk or us");
  if (typeof q.batchId !== "string" || q.batchId.length > 100 || !ID.test(q.batchId)) throw new ReportingHttpError(400, "BAD_REQUEST", "batchId is invalid");
  authorizeTimeline(p, q.site, "read");
  let scopes: Map<string, MakeScope> | null;
  try {
    scopes = parseMakeScopes(scopesRaw);
  } catch {
    scopes = null;
  }
  const shops = [...new Set([...(scopes?.values() ?? [])].filter((s) => s.site === q.site).map((s) => s.shop))];
  if (shops.length !== 1) throw new ReportingHttpError(503, "CONFIG", "Milestone reporting is not configured for exactly one shop at this site");
  const { data, error } = await rpc.rpc("read_make_batch", { p_site: q.site, p_shop: shops[0], p_batch_id: q.batchId, p_limit: 1000 });
  if (error) throw new ReportingHttpError(503, /exceed the limit/.test(error.message) ? "TOO_LARGE" : "UNAVAILABLE", "The batch status could not be read");
  return { site: q.site, ...(data as Record<string, unknown>) };
}
