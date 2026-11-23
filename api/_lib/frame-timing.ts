/**
 * F9 Frame timing: authorized orchestration. Reuses F8's validation and
 * authorization (authorizeOverview: kiosk refused, CS by explicit nav, staff
 * forced to self, site membership) and the overview's PINNED generationId, so
 * the timing section can never use another cutoff than the summary shown
 * above it. The service-only 0058 RPC returns the generation's stream rows;
 * the complete worker/day streams are timed here before any filter, and only
 * aggregates leave the server.
 */
import { productionRange } from "../../src/lib/domain/productionPeriods.js";
import type { PublishedMeta } from "../../src/lib/domain/productionReporting.js";
import { OverviewRequestError, validateOverviewRequest, type OverviewRequest } from "../../src/lib/domain/reportsOverview.js";
import { computeFrameTiming, validateWeights, type FrameTimingBody, type TimingStreamRow, type WeightSet } from "../../src/lib/domain/frameTimingReport.js";
import { freshness, ReportingHttpError, resolveGeneration, type PublishedReader, type ReportingPrincipal } from "./production-reporting.js";
import { authorizeOverview } from "./reports-overview.js";
import type { RpcClient } from "./reporting-jobs.js";

export const TIMING_ROW_LIMIT = 50_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface FrameTimingResult extends FrameTimingBody {
  meta: PublishedMeta;
  request: OverviewRequest & { generationId: string };
}
export interface TimingDeps { reader: PublishedReader; rpc: RpcClient; now(): number; audit?(line: Record<string, string>): void }

const bad = (m: string): never => {
  throw new ReportingHttpError(503, "UNAVAILABLE", `timing rows: ${m}`);
};

export function parseTimingRows(v: unknown): { rows: TimingStreamRow[]; weights: WeightSet | null } {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : bad("not an object");
  const list = Array.isArray(o.rows) ? o.rows : bad("rows");
  const rows = list.map((r): TimingStreamRow => {
    if (!Array.isArray(r) || r.length !== 11) return bad("row shape");
    const [id, staffId, at, productionDate, kind, workType, sku, pieces, effective, rework, departmentId] = r as unknown[];
    if (typeof id !== "string" || typeof staffId !== "string" || typeof at !== "string" || typeof productionDate !== "string") return bad("row fields");
    if (kind !== "verify" && kind !== "clock_in" && kind !== "clock_out") return bad("row kind");
    const n = typeof pieces === "string" ? Number(pieces) : pieces;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return bad("row pieces");
    if (typeof effective !== "boolean" || typeof rework !== "boolean") return bad("row flags");
    return {
      id, staffId, at, productionDate, kind, pieces: n, effective, rework,
      workType: typeof workType === "string" ? workType : null,
      sku: typeof sku === "string" ? sku : null,
      departmentId: typeof departmentId === "string" ? departmentId : null,
    };
  });
  let weights: WeightSet | null = null;
  if (o.weights !== null && o.weights !== undefined) {
    const w = o.weights as Record<string, unknown>;
    if (typeof w.version !== "number" || !Number.isSafeInteger(w.version) || w.version < 1) return bad("weights version");
    try {
      weights = { version: w.version, weights: validateWeights(w.weights) };
    } catch {
      return bad("weights values");
    }
  }
  return { rows, weights };
}

export async function readFrameTiming(p: ReportingPrincipal, raw: Record<string, unknown>, deps: TimingDeps): Promise<FrameTimingResult> {
  const { generationId, ...rest } = raw;
  let request: OverviewRequest;
  try {
    if (typeof generationId !== "string" || !UUID.test(generationId)) throw new OverviewRequestError("generationId (the summary's report version) is required");
    request = validateOverviewRequest(rest);
  } catch (e) {
    deps.audit?.({ event: "timing_bad_request", role: p.role });
    throw new ReportingHttpError(400, "BAD_REQUEST", e instanceof OverviewRequestError ? e.message : "invalid request");
  }
  const { request: r, audience: { audience, visibility } } = authorizeOverview(p, request);
  const now = deps.now();
  // pinned: 410 when that version is gone; never silently "latest"
  const g = await resolveGeneration(deps.reader, r.site, generationId, now);
  const range = productionRange(r.site, r.firstDate, r.lastDate);
  const { data, error } = await deps.rpc.rpc("read_frame_timing_rows", {
    p_site: r.site,
    p_audience_kind: audience.kind,
    p_audience_staff: audience.kind === "self" ? audience.staffId : null,
    p_generation: g.generationId,
    p_first_date: r.firstDate,
    p_last_date: r.lastDate,
    p_start: range.startUtc,
    p_end: range.endUtcExclusive,
    p_row_limit: TIMING_ROW_LIMIT,
  });
  if (error) {
    const tooMany = /exceed the limit/.test(error.message ?? "");
    deps.audit?.({ event: tooMany ? "timing_too_many_rows" : "timing_rpc_failed", site: r.site, role: p.role });
    throw tooMany
      ? new ReportingHttpError(503, "TOO_LARGE", "Too much scan history for one timing report; choose a shorter period")
      : new ReportingHttpError(503, "UNAVAILABLE", "Frame timing could not be read");
  }
  const { rows, weights } = parseTimingRows(data);
  const body = computeFrameTiming(rows, weights, g.sourceCutoffUtc, { staffId: r.staffId, workType: r.workType, departmentId: r.departmentId });
  const f = freshness(g.verifiedAtUtc, now);
  const meta: PublishedMeta = {
    site: g.site, generationId: g.generationId, ruleVersion: g.ruleVersion, sourceCutoffUtc: g.sourceCutoffUtc, verifiedAtUtc: g.verifiedAtUtc,
    publishedAtUtc: g.publishedAtUtc, freshUntilUtc: f.freshUntilUtc, expiresAtUtc: g.expiresAtUtc ?? "", visibility, state: f.state,
  };
  return { ...body, meta, request: { ...r, generationId: g.generationId } };
}
