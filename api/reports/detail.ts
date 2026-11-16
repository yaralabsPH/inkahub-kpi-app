/**
 * GET /api/reports/detail?site=&generationId=&kind=&firstDate=&lastDate=[&staffId=][&workType=][&orderNumber=][&cursor=][&limit=]
 *
 * Task 16: one bounded page (default 200, max 1,000 rows, ≤1 MiB) of a pinned
 * generation's detail rows. Every page re-authorizes membership and the
 * Reports permission; the opaque cursor is HMAC-signed and bound to version,
 * site, audience, filter, generation and kind (altered/mismatched → 400).
 * Precedence: 401 → 405 → 400 → 403 → 410/503 → 200. No-store.
 */
import { authorizeReportingRequest, errorResponse, readPublishedDetail, ReportingHttpError, type AuthDeps, type PublishedReader } from "../_lib/production-reporting.js";
import { rpcPublishedReader, supabaseAuthDeps } from "../_lib/production-reporting-rpc.js";
import { serviceRpcClient, type MinimalRequest, type MinimalResponse } from "../_lib/reporting-auth.js";
import type { DetailRequest } from "../../src/lib/domain/productionReporting.js";
import { queryRecord } from "./summary.js";

const PARAMS = ["site", "generationId", "kind", "firstDate", "lastDate", "staffId", "workType", "orderNumber", "cursor", "limit"] as const;

export interface DetailDeps { auth(): AuthDeps | null; reader(): PublishedReader | null; now(): number; cursorSecret(): string | undefined }
const defaults = (): DetailDeps => ({
  auth: () => supabaseAuthDeps(),
  reader: () => { const c = serviceRpcClient(); return c ? rpcPublishedReader(c) : null; },
  now: () => Date.now(),
  cursorSecret: () => process.env.REPORTING_CURSOR_SECRET,
});

export function createDetailHandler(deps: DetailDeps = defaults()) {
  return async function handler(req: MinimalRequest, res: MinimalResponse) {
    res.setHeader("Cache-Control", "no-store");
    try {
      const auth = deps.auth();
      if (!auth) throw new ReportingHttpError(500, "CONFIG", "Report service configuration missing");
      const { principal } = await authorizeReportingRequest(req.headers, auth);
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return void res.status(405).json({ error: "Method not allowed", code: "METHOD" });
      }
      const q = queryRecord(req.query, PARAMS);
      if (q.limit !== undefined && !/^[1-9][0-9]{0,3}$/.test(q.limit)) throw new ReportingHttpError(400, "BAD_REQUEST", "limit must be a positive integer");
      const request: DetailRequest = {
        site: q.site as DetailRequest["site"], generationId: q.generationId, kind: q.kind as DetailRequest["kind"], firstDate: q.firstDate, lastDate: q.lastDate,
        ...(q.staffId !== undefined ? { staffId: q.staffId } : {}), ...(q.workType !== undefined ? { workType: q.workType as DetailRequest["workType"] } : {}),
        ...(q.orderNumber !== undefined ? { orderNumber: q.orderNumber } : {}), ...(q.cursor !== undefined ? { cursor: q.cursor } : {}), ...(q.limit !== undefined ? { limit: Number(q.limit) } : {}),
      };
      const reader = deps.reader();
      if (!reader) throw new ReportingHttpError(500, "CONFIG", "Report service configuration missing");
      res.status(200).json(await readPublishedDetail(principal, request, { reader, now: deps.now, cursorSecret: deps.cursorSecret() }));
    } catch (e) {
      const { status, body } = errorResponse(e);
      res.status(status).json(body);
    }
  };
}

export default createDetailHandler();
