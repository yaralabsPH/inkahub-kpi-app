/**
 * Task 16: the production PublishedReader over the service-only 0044 RPCs, and
 * the Supabase auth/caller-JWT dependencies of the report endpoints.
 *
 * The reader passes ONLY the server-derived audience/scope. Every response is
 * shape-checked and bounded (one JSON value ≤1 MiB per call; detail pages
 * ≤1,000 rows); the database aggregates over classified facts of exactly one
 * generation and never returns raw source history.
 */
import { createClient } from "@supabase/supabase-js";
import type { ReportSite } from "../../src/lib/domain/productionPeriods.js";
import { DETAIL_PAGE_MAX, DETAIL_RESPONSE_MAX_BYTES, type PublishedDetailRow } from "../../src/lib/domain/productionReporting.js";
import type { AuthDeps, GenerationMeta, PublishedReader, ReaderScope, SummaryBody } from "./production-reporting.js";
import { ReportingHttpError } from "./production-reporting.js";
import { parseDetailResponse, parseSummaryResponse } from "./production-reporting-dto.js";
import type { RpcClient } from "./reporting-jobs.js";

const STATES = ["published", "superseded", "expired", "building", "failed"] as const;
const one = async (client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> => {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new ReportingHttpError(503, "UNAVAILABLE", `${fn} failed`);
  if (Buffer.byteLength(JSON.stringify(data ?? null), "utf8") > DETAIL_RESPONSE_MAX_BYTES) throw new ReportingHttpError(503, "TOO_LARGE", `${fn} exceeded 1 MiB`);
  return data;
};
const scopeArgs = (s: ReaderScope) => ({
  p_site: s.site, p_audience_kind: s.audience.kind, p_audience_staff: s.audience.kind === "self" ? s.audience.staffId : null, p_generation: s.generationId,
  p_first_date: s.firstDate, p_last_date: s.lastDate, p_start: s.startUtc, p_end: s.endUtcExclusive, p_staff: s.staffId, p_work_type: s.workType,
});

export function parseGeneration(v: unknown): GenerationMeta | null {
  const rows = Array.isArray(v) ? v : v == null ? [] : [v];
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new ReportingHttpError(503, "UNAVAILABLE", "read_reporting_generation returned several rows");
  const r = rows[0] as Record<string, unknown>;
  const s = (k: string) => {
    if (typeof r[k] !== "string" || !r[k]) throw new ReportingHttpError(503, "UNAVAILABLE", `generation ${k} is missing`);
    return r[k] as string;
  };
  if (!(STATES as readonly unknown[]).includes(r.state)) throw new ReportingHttpError(503, "UNAVAILABLE", "generation state is unknown");
  if (typeof r.complete !== "boolean") throw new ReportingHttpError(503, "UNAVAILABLE", "generation completeness is unknown");
  if (r.read_mode !== "legacy" && r.read_mode !== "shadow" && r.read_mode !== "summary") throw new ReportingHttpError(503, "UNAVAILABLE", "site read mode is unknown");
  return {
    generationId: s("generation_id"), site: s("site") as ReportSite, state: r.state as GenerationMeta["state"], complete: r.complete, ruleVersion: s("rule_version"),
    sourceCutoffUtc: s("source_cutoff"), verifiedAtUtc: s("verified_at"), publishedAtUtc: s("published_at"), expiresAtUtc: r.expires_at == null ? null : s("expires_at"), readMode: r.read_mode,
  };
}

export function rpcPublishedReader(client: RpcClient): PublishedReader {
  return {
    async generation(site, generationId) {
      return parseGeneration(await one(client, "read_reporting_generation", { p_site: site, p_generation: generationId }));
    },
    async siteReadMode(site) {
      // Service-only 0038 status RPC: the site's authoritative read mode, independent of any generation.
      const v = await one(client, "get_reporting_job_status", { p_site: site });
      const rows = Array.isArray(v) ? v : v == null ? [] : [v];
      if (rows.length !== 1) throw new ReportingHttpError(503, "UNAVAILABLE", "site reporting state is missing");
      const r = rows[0] as Record<string, unknown>;
      if (r.site !== site) throw new ReportingHttpError(503, "UNAVAILABLE", "site reporting state belongs to another site");
      if (r.read_mode !== "legacy" && r.read_mode !== "shadow" && r.read_mode !== "summary") throw new ReportingHttpError(503, "UNAVAILABLE", "site read mode is unknown");
      return r.read_mode;
    },
    async summary(scope, view, pages) {
      const v = await one(client, "read_reporting_summary", { ...scopeArgs(scope), p_view: view, p_daily_limit: pages.dailyLimit, p_people_limit: pages.peopleLimit });
      // Deep, strict validation: safe-integer counts, null-or-safe Items, finite rates, exact key sets.
      return parseSummaryResponse(v, view, { firstDate: scope.firstDate, lastDate: scope.lastDate }, pages) as SummaryBody;
    },
    async detail(scope, kind, orderNumber, after, limit) {
      // Bounded before any RPC: an integer page size within the contract's maximum.
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > DETAIL_PAGE_MAX) throw new ReportingHttpError(400, "BAD_REQUEST", `limit must be an integer 1..${DETAIL_PAGE_MAX}`);
      // days/people continue an offset (the signed cursor's `last`); every other kind is a keyset tuple.
      const offset = kind === "days" || kind === "people" ? (after === null || after === undefined ? 0 : Number.isSafeInteger(after) && (after as number) >= 0 ? (after as number) : -1) : 0;
      if (offset < 0) throw new ReportingHttpError(400, "BAD_CURSOR", "The page cursor is not valid for this list");
      const v = await one(client, "read_reporting_detail", { ...scopeArgs(scope), p_kind: kind, p_order: orderNumber, p_after: after ?? null, p_limit: limit });
      return parseDetailResponse(v, kind, { site: scope.site, firstDate: scope.firstDate, lastDate: scope.lastDate, limit, offset });
    },
  };
}

/** Supabase auth.getUser(token) plus caller-JWT reads of the current profile and site memberships. */
export function supabaseAuthDeps(env: Record<string, string | undefined> = process.env): AuthDeps | null {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  const anon = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  const asCaller = (token: string) => createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
  return {
    async getUser(token) {
      const { data, error } = await createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } }).auth.getUser(token);
      return error || !data.user ? null : data.user.id;
    },
    async profile(token, userId) {
      const { data, error } = await asCaller(token).from("profiles").select("role, allowed_nav").eq("user_id", userId).maybeSingle();
      if (error) throw new ReportingHttpError(503, "UNAVAILABLE", "profile read failed");
      return (data as { role: string; allowed_nav: unknown } | null) ?? null;
    },
    async memberships(token, userId) {
      const { data, error } = await asCaller(token).from("user_locations").select("location").eq("user_id", userId);
      if (error) throw new ReportingHttpError(503, "UNAVAILABLE", "membership read failed");
      return ((data ?? []) as Array<{ location: string }>).map((r) => r.location);
    },
  };
}
