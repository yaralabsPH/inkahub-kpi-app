/**
 * GET /api/reports/summary?site=&firstDate=&lastDate=&view=reports|welcome[&staffId=][&workType=][&generationId=]
 *
 * Task 16: one published generation's exact totals for the caller's server-
 * derived audience. Precedence: 401 (no valid app session; nothing else is
 * read) → 405 (not GET) → 400 (selectors; unknown or repeated parameters) →
 * 403 (membership / nav) → 410/503 (generation) → 200. Every request
 * re-authorizes. No-store. No raw-history fallback.
 */
import { authorizeReportingRequest, bearerToken, errorResponse, readPublishedSummary, ReportingHttpError, type AuthDeps, type PublishedReader } from "../_lib/production-reporting.js";
import { rpcPublishedReader, supabaseAuthDeps } from "../_lib/production-reporting-rpc.js";
import { serviceRpcClient, type MinimalRequest, type MinimalResponse } from "../_lib/reporting-auth.js";
import type { SummaryRequest } from "../../src/lib/domain/productionReporting.js";

const PARAMS = ["site", "firstDate", "lastDate", "view", "staffId", "workType", "generationId"] as const;

export function queryRecord(q: MinimalRequest["query"], allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q ?? {})) {
    if (!allowed.includes(k)) throw new ReportingHttpError(400, "BAD_REQUEST", `unknown parameter ${k.slice(0, 40)}`);
    if (typeof v !== "string") throw new ReportingHttpError(400, "BAD_REQUEST", `parameter ${k} must appear once`);
    out[k] = v;
  }
  return out;
}

export interface SummaryDeps { auth(): AuthDeps | null; reader(): PublishedReader | null; now(): number }
const defaults = (): SummaryDeps => ({ auth: () => supabaseAuthDeps(), reader: () => { const c = serviceRpcClient(); return c ? rpcPublishedReader(c) : null; }, now: () => Date.now() });

export function createSummaryHandler(deps: SummaryDeps = defaults()) {
  return async function handler(req: MinimalRequest, res: MinimalResponse) {
    res.setHeader("Cache-Control", "no-store");
    // 401 first: a missing, malformed or duplicated bearer header is refused before ANY configuration,
    // client, auth or reader work (even when the server is also misconfigured).
    if (!bearerToken(req.headers)) return void res.status(401).json({ error: "A valid app session is required", code: "UNAUTHENTICATED" });
    try {
      const auth = deps.auth();
      if (!auth) throw new ReportingHttpError(500, "CONFIG", "Report service configuration missing");
      const { principal } = await authorizeReportingRequest(req.headers, auth);
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return void res.status(405).json({ error: "Method not allowed", code: "METHOD" });
      }
      const q = queryRecord(req.query, PARAMS);
      const request: SummaryRequest = { site: q.site as SummaryRequest["site"], firstDate: q.firstDate, lastDate: q.lastDate, view: q.view as SummaryRequest["view"],
        ...(q.staffId !== undefined ? { staffId: q.staffId } : {}), ...(q.workType !== undefined ? { workType: q.workType as SummaryRequest["workType"] } : {}), ...(q.generationId !== undefined ? { generationId: q.generationId } : {}) };
      const reader = deps.reader();
      if (!reader) throw new ReportingHttpError(500, "CONFIG", "Report service configuration missing");
      res.status(200).json(await readPublishedSummary(principal, request, { reader, now: deps.now, cursorSecret: undefined }));
    } catch (e) {
      const { status, body } = errorResponse(e);
      res.status(status).json(body);
    }
  };
}

export default createSummaryHandler();
