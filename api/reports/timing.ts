/**
 * GET /api/reports/timing?site=&firstDate=&lastDate=&generationId=[&staffId=][&workType=][&departmentId=]
 *
 * F9 frame timing for the caller's server-derived audience, pinned to the
 * summary's generationId. Same precedence and authorization as
 * /api/reports/overview. No-store. No raw-history fallback.
 */
import { authorizeReportingRequest, bearerToken, errorResponse, ReportingHttpError, type AuthDeps, type PublishedReader } from "../_lib/production-reporting.js";
import { rpcPublishedReader, supabaseAuthDeps } from "../_lib/production-reporting-rpc.js";
import { readFrameTiming } from "../_lib/frame-timing.js";
import { serviceRpcClient, type MinimalRequest, type MinimalResponse } from "../_lib/reporting-auth.js";
import type { RpcClient } from "../_lib/reporting-jobs.js";
import { queryRecord } from "./summary.js";

const PARAMS = ["site", "firstDate", "lastDate", "generationId", "staffId", "workType", "departmentId"] as const;

export interface TimingHandlerDeps { auth(): AuthDeps | null; service(): { reader: PublishedReader; rpc: RpcClient } | null; now(): number }
const defaults = (): TimingHandlerDeps => ({
  auth: () => supabaseAuthDeps(),
  service: () => {
    const c = serviceRpcClient();
    return c ? { reader: rpcPublishedReader(c), rpc: c } : null;
  },
  now: () => Date.now(),
});

export function createTimingHandler(deps: TimingHandlerDeps = defaults()) {
  return async function handler(req: MinimalRequest, res: MinimalResponse) {
    res.setHeader("Cache-Control", "no-store");
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
      const svc = deps.service();
      if (!svc) throw new ReportingHttpError(500, "CONFIG", "Report service configuration missing");
      const audit = (line: Record<string, string>) => console.warn("[frame-timing]", JSON.stringify(line));
      res.status(200).json(await readFrameTiming(principal, q, { reader: svc.reader, rpc: svc.rpc, now: deps.now, audit }));
    } catch (e) {
      const { status, body } = errorResponse(e);
      res.status(status).json(body);
    }
  };
}

export default createTimingHandler();
