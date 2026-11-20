/**
 * Task 16: authorized published report reads (server only).
 *
 *   authorizeReportingRequest(headers, view, deps) -> ReportingPrincipal
 *   readPublishedSummary(principal, request, deps)  -> SummaryResult
 *   readPublishedDetail(principal, request, deps)   -> Page<PublishedDetailRow>
 *
 * Authorization happens on EVERY request and page: the app JWT is verified
 * with Supabase `auth.getUser(token)`; the caller's current profile (role,
 * allowed_nav) and site memberships are read through a client carrying the
 * caller's own JWT (existing RLS applies). Nothing is taken from request
 * fields or JWT user metadata. Owners, managers, kiosks and CS read their
 * member site's site audience; staff read only their own (self) audience,
 * labelled limited, even when explicitly granted Reports. Unknown role or no
 * membership is denied. The service-only published reader receives only the
 * audience derived here.
 *
 * Results: 401 bad/missing auth, 403 missing permission/membership, 400
 * invalid selector/cursor, 410 expired generation, 503 missing/incomplete/
 * failed publication. Cursors are opaque HMAC-signed selectors bound to
 * version, site, audience, filter and generation: altered or mismatched is
 * 400; they never grant anything. A stale (delayed/outdated) generation is
 * returned with its state; it is never zeroed or replaced by raw history.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { productionRange, type ReportSite } from "../../src/lib/domain/productionPeriods.js";
import {
  DETAIL_PAGE_MAX, DETAIL_RESPONSE_MAX_BYTES, ReportingRequestError, validateDetailRequest, validateSummaryRequest,
  type DetailRequest, type Page, type PublishedDetailRow, type PublishedMeta, type ReportingAudience, type SummaryRequest, type SummaryResult,
} from "../../src/lib/domain/productionReporting.js";
import type { ProductionVisibility } from "../../src/lib/domain/productionCounts.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ReportingStatus = 400 | 401 | 403 | 410 | 500 | 503;
export class ReportingHttpError extends Error {
  constructor(readonly status: ReportingStatus, readonly code: string, message: string) {
    super(message);
    this.name = "ReportingHttpError";
  }
}

// ---------------------------------------------------------------------------
// Principal: verified user, current profile and memberships
// ---------------------------------------------------------------------------

export const ROLES = ["owner", "manager", "staff", "kiosk", "cs"] as const;
export type Role = (typeof ROLES)[number];
/** Same keys as src/lib/domain NAV_KEYS (tests prove the mirror is equal). */
export const NAV = ["welcome", "dashboard", "skus", "sales", "shipments", "events", "warehouse", "orders", "paper", "movements", "cs_cases", "cs_returns", "order_submission", "reports", "team", "settings"] as const;

/** Server mirror of src/lib/auth/permissions.ts effectiveNavAccess (equality is tested over every role and override). */
export function effectiveNav(profile: { role: string; allowed_nav: unknown } | null): Set<string> {
  if (!profile) return new Set();
  let keys: string[];
  if (Array.isArray(profile.allowed_nav)) keys = profile.allowed_nav as string[];
  else {
    switch (profile.role) {
      case "owner": keys = [...NAV]; break;
      case "manager": keys = NAV.filter((k) => k !== "dashboard"); break;
      case "kiosk": keys = ["order_submission"]; break;
      case "cs": keys = ["cs_returns", "cs_cases"]; break;
      default: keys = ["welcome"];
    }
  }
  if (profile.role !== "owner") keys = keys.filter((k) => k !== "dashboard");
  if (!keys.includes("welcome")) keys = [...keys, "welcome"];
  if (profile.role === "owner" && !keys.includes("settings")) keys = [...keys, "settings"];
  return new Set(keys);
}

export interface ReportingPrincipal {
  userId: string;
  role: Role;
  nav: ReadonlySet<string>;
  sites: ReadonlySet<string>;
}

export interface AuthDeps {
  /** Supabase auth.getUser(token): the verified user id, or null. */
  getUser(token: string): Promise<string | null>;
  /** Reads under the CALLER's JWT (existing RLS applies). */
  profile(token: string, userId: string): Promise<{ role: string; allowed_nav: unknown } | null>;
  memberships(token: string, userId: string): Promise<string[]>;
}

export function bearerToken(headers: Record<string, string | string[] | undefined> | undefined): string | null {
  if (!headers) return null;
  const keys = Object.keys(headers).filter((k) => k.toLowerCase() === "authorization");
  if (keys.length !== 1) return null;
  const v = headers[keys[0]];
  if (typeof v !== "string") return null;
  const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(v);
  return m ? m[1] : null;
}

/** 401 for a missing/invalid token; 403 for an unknown role. Membership/nav are checked per site/view by the readers. */
export async function authorizeReportingRequest(headers: Record<string, string | string[] | undefined> | undefined, deps: AuthDeps): Promise<{ principal: ReportingPrincipal; token: string }> {
  const token = bearerToken(headers);
  if (!token) throw new ReportingHttpError(401, "UNAUTHENTICATED", "A valid app session is required");
  let userId: string | null;
  try {
    userId = await deps.getUser(token);
  } catch {
    userId = null;
  }
  if (!userId) throw new ReportingHttpError(401, "UNAUTHENTICATED", "A valid app session is required");
  const [profile, sites] = await Promise.all([deps.profile(token, userId), deps.memberships(token, userId)]);
  if (!profile || !(ROLES as readonly string[]).includes(profile.role)) throw new ReportingHttpError(403, "FORBIDDEN", "No reporting role");
  return { principal: { userId, role: profile.role as Role, nav: effectiveNav(profile), sites: new Set(sites) }, token };
}

/** The ONLY audience a principal may read for a site and view (never client-chosen). */
export function audienceFor(p: ReportingPrincipal, site: ReportSite, view: "reports" | "welcome"): { audience: ReportingAudience; visibility: ProductionVisibility } {
  if (!p.sites.has(site)) throw new ReportingHttpError(403, "FORBIDDEN", "No membership for this site");
  if (view === "reports" && !p.nav.has("reports")) throw new ReportingHttpError(403, "FORBIDDEN", "Reports permission is required");
  if (view === "welcome" && !p.nav.has("welcome")) throw new ReportingHttpError(403, "FORBIDDEN", "Welcome permission is required");
  if (p.role === "staff") return { audience: { kind: "self", staffId: p.userId }, visibility: { kind: "limited", reason: "own work only" } };
  return { audience: { kind: "site" }, visibility: { kind: "site" } };
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

export const FRESH_MS = 30 * 60_000;
export const OUTDATED_MS = 120 * 60_000;
/** current ≤30 min after verified source coverage; delayed ≤120 min; outdated beyond. Measured from verification, not render or event time. */
export function freshness(verifiedAtUtc: string, nowMs: number): { state: PublishedMeta["state"]; freshUntilUtc: string } {
  const v = Date.parse(verifiedAtUtc);
  if (!Number.isFinite(v)) throw new ReportingHttpError(503, "UNAVAILABLE", "The publication has no verification time");
  const age = nowMs - v;
  return { state: age <= FRESH_MS ? "current" : age <= OUTDATED_MS ? "delayed" : "outdated", freshUntilUtc: new Date(v + FRESH_MS).toISOString() };
}

// ---------------------------------------------------------------------------
// Opaque, signed cursors
// ---------------------------------------------------------------------------

export interface CursorBinding { v: 1; site: string; audience: string; filter: string; generationId: string; kind: string }
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");
const mac = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("base64url");
export const audienceKey = (a: ReportingAudience) => (a.kind === "site" ? "site" : `self:${a.staffId}`);
export function filterKey(r: { firstDate: string; lastDate: string; staffId?: string; workType?: string; orderNumber?: string }): string {
  return JSON.stringify([r.firstDate, r.lastDate, r.staffId ?? null, r.workType ?? null, r.orderNumber ?? null]);
}
export function signCursor(secret: string, binding: CursorBinding, last: unknown): string {
  const body = b64(JSON.stringify({ ...binding, last }));
  return `${body}.${mac(secret, body)}`;
}
/** The last tuple of a cursor issued for EXACTLY this binding; anything altered or mismatched is a 400. */
export function verifyCursor(secret: string, binding: CursorBinding, cursor: string): unknown {
  const bad = () => new ReportingHttpError(400, "BAD_CURSOR", "The cursor is invalid for this request");
  const [body, sig, extra] = cursor.split(".");
  if (!body || !sig || extra !== undefined) throw bad();
  const want = Buffer.from(mac(secret, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw bad();
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(unb64(body)) as Record<string, unknown>;
  } catch {
    throw bad();
  }
  for (const k of ["v", "site", "audience", "filter", "generationId", "kind"] as const) if (o[k] !== binding[k]) throw bad();
  if (!("last" in o)) throw bad();
  return o.last;
}

// ---------------------------------------------------------------------------
// The published reader contract (service-only 0044 RPCs in production)
// ---------------------------------------------------------------------------

export interface GenerationMeta {
  generationId: string;
  site: ReportSite;
  state: "published" | "superseded" | "expired" | "building" | "failed";
  complete: boolean;
  ruleVersion: string;
  sourceCutoffUtc: string;
  verifiedAtUtc: string;
  publishedAtUtc: string;
  /** null while published (no expiry yet); set when superseded. */
  expiresAtUtc: string | null;
  /** The site's CURRENT effective read mode (operator-controlled, per site). */
  readMode: "legacy" | "shadow" | "summary";
}
export interface ReaderScope {
  site: ReportSite;
  audience: ReportingAudience;
  generationId: string;
  firstDate: string;
  lastDate: string;
  startUtc: string;
  endUtcExclusive: string;
  staffId: string | null;
  workType: string | null;
}
export type SummaryBody = Omit<SummaryResult, "meta">;
export interface PublishedReader {
  /** The site's active published generation (generationId null) or the named one. */
  generation(site: ReportSite, generationId: string | null): Promise<GenerationMeta | null>;
  summary(scope: ReaderScope, view: "reports" | "welcome", pages: { dailyLimit: number; peopleLimit: number }): Promise<SummaryBody>;
  detail(scope: ReaderScope, kind: DetailRequest["kind"], orderNumber: string | null, after: unknown, limit: number): Promise<{ rows: PublishedDetailRow[]; last: unknown; more: boolean; totalRows: number }>;
}

export interface ReadDeps { reader: PublishedReader; now(): number; cursorSecret: string | undefined }

/** Resolve and check one generation: 503 missing/incomplete/failed, 410 expired or past retention; a mismatched pin is 410 (reload the whole view). */
export async function resolveGeneration(reader: PublishedReader, site: ReportSite, pinned: string | null, nowMs: number): Promise<GenerationMeta> {
  const g = await reader.generation(site, pinned);
  if (!g) throw pinned ? new ReportingHttpError(410, "GENERATION_EXPIRED", "This report version is no longer available; reload the view") : new ReportingHttpError(503, "UNAVAILABLE", "No published report is available for this site yet");
  if (g.site !== site) throw new ReportingHttpError(400, "BAD_GENERATION", "The report version belongs to another site");
  // Effective per-site mode, delivered only through this authorized API: before activation (legacy) and during
  // shadow comparison the app keeps its existing reads; this explicit signal is never a silent raw-history fallback.
  if (g.readMode !== "summary") throw new ReportingHttpError(503, g.readMode === "shadow" ? "READ_MODE_SHADOW" : "READ_MODE_LEGACY", "Published reports are not enabled for this site");
  if (g.state === "building" || g.state === "failed" || !g.complete) throw new ReportingHttpError(503, "UNAVAILABLE", "The report publication is incomplete");
  if (g.state === "expired" || (g.expiresAtUtc !== null && Date.parse(g.expiresAtUtc) <= nowMs)) throw new ReportingHttpError(410, "GENERATION_EXPIRED", "This report version has expired; reload the view");
  return g;
}

function meta(g: GenerationMeta, visibility: ProductionVisibility, nowMs: number): PublishedMeta {
  const f = freshness(g.verifiedAtUtc, nowMs);
  return {
    site: g.site, generationId: g.generationId, ruleVersion: g.ruleVersion, sourceCutoffUtc: g.sourceCutoffUtc, verifiedAtUtc: g.verifiedAtUtc, publishedAtUtc: g.publishedAtUtc,
    freshUntilUtc: f.freshUntilUtc, expiresAtUtc: g.expiresAtUtc ?? "", visibility, state: f.state,
  };
}

function scopeOf(p: ReportingPrincipal, r: { site: ReportSite; firstDate: string; lastDate: string; staffId?: string; workType?: string }, view: "reports" | "welcome", generationId: string) {
  const { audience, visibility } = audienceFor(p, r.site, view);
  let range;
  try {
    range = productionRange(r.site, r.firstDate, r.lastDate);
  } catch (e) {
    throw new ReportingHttpError(400, "BAD_REQUEST", e instanceof Error ? e.message : "invalid range");
  }
  const scope: ReaderScope = { site: r.site, audience, generationId, firstDate: r.firstDate, lastDate: r.lastDate, startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive, staffId: r.staffId ?? null, workType: r.workType ?? null };
  return { scope, visibility };
}

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

export async function readPublishedSummary(p: ReportingPrincipal, request: SummaryRequest, deps: ReadDeps): Promise<SummaryResult> {
  try {
    validateSummaryRequest(request);
  } catch (e) {
    throw new ReportingHttpError(400, "BAD_REQUEST", e instanceof ReportingRequestError ? e.message : "invalid request");
  }
  audienceFor(p, request.site, request.view); // 403 before any generation or data read
  const now = deps.now();
  const g = await resolveGeneration(deps.reader, request.site, request.generationId ?? null, now);
  const { scope, visibility } = scopeOf(p, request, request.view, g.generationId);
  const raw = await deps.reader.summary(scope, request.view, { dailyLimit: DETAIL_PAGE_MAX, peopleLimit: 200 });
  // Coverage carries the trusted audience's visibility; a limited view is always incomplete.
  const cover = (c: SummaryBody["coverage"]) => ({ ...c, visibility, incomplete: c.incomplete || visibility.kind === "limited" });
  const body: SummaryBody = { ...raw, coverage: cover(raw.coverage), ...(raw.welcome ? { welcome: { ...raw.welcome, coverage: cover(raw.welcome.coverage), todayCoverage: cover(raw.welcome.todayCoverage) } } : {}) };
  // A page that does not hold every row continues through a signed detail cursor (only a null cursor ends a sequence).
  const continuation = (kind: "days" | "people", shown: number, total: number) => {
    if (total <= shown) return null;
    if (!deps.cursorSecret) throw new ReportingHttpError(500, "CONFIG", "Report paging is not configured");
    return signCursor(deps.cursorSecret, { v: 1, site: request.site, audience: audienceKey(scope.audience), filter: filterKey(request), generationId: g.generationId, kind }, shown);
  };
  body.dailyPage = { ...body.dailyPage, nextCursor: continuation("days", body.dailyPage.rows.length, body.dailyPage.totalRows) };
  body.peoplePage = { ...body.peoplePage, nextCursor: continuation("people", body.peoplePage.rows.length, body.peoplePage.totalRows) };
  if (request.view === "welcome") {
    // Welcome returns only its existing shape: no people, SKU board or person-level detail.
    return { ...body, meta: meta(g, visibility, now), peoplePage: { rows: [], nextCursor: null, pageComplete: true, totalRows: 0 }, skuBoard: [] };
  }
  const out: SummaryResult = { ...body, meta: meta(g, visibility, now) };
  if (bytes(out) > DETAIL_RESPONSE_MAX_BYTES) throw new ReportingHttpError(503, "TOO_LARGE", "The summary exceeds the response limit");
  return out;
}

export async function readPublishedDetail(p: ReportingPrincipal, request: DetailRequest, deps: ReadDeps): Promise<Page<PublishedDetailRow>> {
  let r: DetailRequest & { limit: number };
  try {
    r = validateDetailRequest(request);
  } catch (e) {
    throw new ReportingHttpError(400, "BAD_REQUEST", e instanceof ReportingRequestError ? e.message : "invalid request");
  }
  if (!deps.cursorSecret) throw new ReportingHttpError(500, "CONFIG", "Report paging is not configured");
  const { audience } = audienceFor(p, r.site, "reports"); // detail is a Reports view; re-authorized on every page
  const now = deps.now();
  const g = await resolveGeneration(deps.reader, r.site, r.generationId, now);
  const binding: CursorBinding = { v: 1, site: r.site, audience: audienceKey(audience), filter: filterKey(r), generationId: g.generationId, kind: r.kind };
  const after = r.cursor ? verifyCursor(deps.cursorSecret, binding, r.cursor) : null;
  const { scope } = scopeOf(p, r, "reports", g.generationId);
  const page = await deps.reader.detail(scope, r.kind, r.orderNumber ?? null, after, r.limit);
  if (page.rows.length > r.limit) throw new ReportingHttpError(503, "TOO_LARGE", "The reader returned more rows than requested");
  const out: Page<PublishedDetailRow> = { rows: page.rows, nextCursor: page.more ? signCursor(deps.cursorSecret, binding, page.last) : null, pageComplete: true, totalRows: page.totalRows };
  if (bytes(out) > DETAIL_RESPONSE_MAX_BYTES) throw new ReportingHttpError(503, "TOO_LARGE", "The page exceeds the 1 MiB response limit; request fewer rows");
  return out;
}

/** Map any failure to the documented status (no internal detail leaks for 5xx). */
export function errorResponse(e: unknown): { status: ReportingStatus; body: { error: string; code: string } } {
  if (e instanceof ReportingHttpError) return { status: e.status, body: { error: e.status >= 500 && e.status !== 503 ? "Report service error" : e.message, code: e.code } };
  return { status: 500, body: { error: "Report service error", code: "ERROR" } };
}
