/**
 * F8 Reports v2: authorized orchestration of one published-period overview.
 *
 * Order: validate (400) -> role/site/nav and person checks (403, before any
 * generation or data read) -> the site's published generation (503/410, never
 * a raw-history fallback) -> service-only 0057 read_reports_overview with the
 * SERVER-derived audience -> strict parse -> meta (generation, cutoff,
 * freshness). Staff are forced to their own work; a different person is 403.
 * Kiosk is always refused. CS needs an explicit Reports permission (nav) and
 * a site membership. No payroll fields exist in this contract.
 */
import { productionRange } from "../../src/lib/domain/productionPeriods.js";
import { DETAIL_RESPONSE_MAX_BYTES, type PublishedMeta } from "../../src/lib/domain/productionReporting.js";
import {
  OVERVIEW_GROUP_LIMIT,
  OverviewRequestError,
  OverviewShapeError,
  parseOverviewBody,
  validateOverviewRequest,
  type OverviewRequest,
  type OverviewResult,
} from "../../src/lib/domain/reportsOverview.js";
import { audienceFor, freshness, ReportingHttpError, resolveGeneration, type PublishedReader, type ReportingPrincipal } from "./production-reporting.js";
import type { RpcClient } from "./reporting-jobs.js";

export interface OverviewDeps {
  reader: PublishedReader;
  rpc: RpcClient;
  now(): number;
  /** Redacted audit line (code, site, role); never tokens or event payloads. */
  audit?(line: Record<string, string>): void;
}

/** Who may read which overview: 403 before any data read. Returns the request with the forced person. */
export function authorizeOverview(p: ReportingPrincipal, r: OverviewRequest): { request: OverviewRequest; audience: ReturnType<typeof audienceFor> } {
  if (p.role === "kiosk") throw new ReportingHttpError(403, "FORBIDDEN", "Kiosk accounts cannot open Reports");
  if (p.role === "cs" && !p.nav.has("reports")) throw new ReportingHttpError(403, "FORBIDDEN", "Reports permission is required");
  const audience = audienceFor(p, r.site, "reports"); // membership + nav
  if (p.role === "staff") {
    if (r.staffId !== undefined && r.staffId !== p.userId) throw new ReportingHttpError(403, "FORBIDDEN", "Staff can only open their own report");
    return { request: { ...r, staffId: p.userId }, audience };
  }
  return { request: r, audience };
}

export async function readReportsOverview(p: ReportingPrincipal, raw: Record<string, unknown>, deps: OverviewDeps): Promise<OverviewResult> {
  let request: OverviewRequest;
  try {
    request = validateOverviewRequest(raw);
  } catch (e) {
    deps.audit?.({ event: "overview_bad_request", role: p.role });
    throw new ReportingHttpError(400, "BAD_REQUEST", e instanceof OverviewRequestError ? e.message : "invalid request");
  }
  const { request: r, audience: { audience, visibility } } = authorizeOverview(p, request);
  const now = deps.now();
  const g = await resolveGeneration(deps.reader, r.site, null, now);
  const range = productionRange(r.site, r.firstDate, r.lastDate);
  const { data, error } = await deps.rpc.rpc("read_reports_overview", {
    p_site: r.site,
    p_audience_kind: audience.kind,
    p_audience_staff: audience.kind === "self" ? audience.staffId : null,
    p_generation: g.generationId,
    p_first_date: r.firstDate,
    p_last_date: r.lastDate,
    p_start: range.startUtc,
    p_end: range.endUtcExclusive,
    // a self audience already holds only the caller's work; the filter is the same person
    p_staff: r.staffId ?? null,
    p_work_type: r.workType ?? null,
    p_department: r.departmentId ?? null,
    p_group_limit: OVERVIEW_GROUP_LIMIT,
  });
  if (error) {
    const tooMany = /exceed the limit/.test(error.message ?? "");
    deps.audit?.({ event: tooMany ? "overview_too_many_groups" : "overview_rpc_failed", site: r.site, role: p.role });
    throw tooMany
      ? new ReportingHttpError(503, "TOO_LARGE", "Too many people or departments for one report; narrow the filters")
      : new ReportingHttpError(503, "UNAVAILABLE", "The report could not be read");
  }
  if (Buffer.byteLength(JSON.stringify(data ?? null), "utf8") > DETAIL_RESPONSE_MAX_BYTES) throw new ReportingHttpError(503, "TOO_LARGE", "The report exceeds the response limit");
  let body;
  try {
    body = parseOverviewBody(data, { firstDate: r.firstDate, lastDate: r.lastDate });
  } catch (e) {
    deps.audit?.({ event: "overview_bad_shape", site: r.site });
    throw new ReportingHttpError(503, "UNAVAILABLE", e instanceof OverviewShapeError ? "The report had an unexpected shape" : "The report could not be read");
  }
  const f = freshness(g.verifiedAtUtc, now);
  const meta: PublishedMeta = {
    site: g.site, generationId: g.generationId, ruleVersion: g.ruleVersion, sourceCutoffUtc: g.sourceCutoffUtc, verifiedAtUtc: g.verifiedAtUtc,
    publishedAtUtc: g.publishedAtUtc, freshUntilUtc: f.freshUntilUtc, expiresAtUtc: g.expiresAtUtc ?? "", visibility, state: f.state,
  };
  return { ...body, meta, request: r };
}
