/**
 * GET /api/reports/refresh-summaries?site=au|uk|us
 *
 * Task 15: scheduled (Vercel cron, site-staggered every 15 minutes) or manual
 * reporting refresh for ONE site. Precedence: 401 (missing/wrong
 * `Authorization: Bearer <CRON_SECRET>`, checked before ANY parsing,
 * environment or database work) → 405 (not GET) → 400 (site) → 500 (server
 * configuration) → work. The worker stops taking new work at 240 s of the
 * 300 s function and returns `pending`; a duplicate invocation returns `busy`.
 * No app role or ordinary refresh can trigger a rebuild (that is the operator
 * endpoint). Responses are no-store and carry ids/counts/redacted problems only.
 */
import { bearerMatches, serviceRpcClient, type MinimalRequest, type MinimalResponse } from "../_lib/reporting-auth.js";
import { isReportingSite, type RpcClient } from "../_lib/reporting-jobs.js";
import { runReportingCycle, type CycleResult } from "../_lib/production-reporting-worker.js";

export const config = { maxDuration: 300 };

export interface RefreshDeps {
  env: Record<string, string | undefined>;
  client(): RpcClient | null;
  run(client: RpcClient, site: "au" | "uk" | "us"): Promise<CycleResult>;
}
const defaultDeps = (): RefreshDeps => ({
  env: process.env,
  client: () => serviceRpcClient(process.env),
  run: (client, site) => runReportingCycle({ client, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }, { site, mode: "refresh" }),
});

export function createRefreshHandler(deps: RefreshDeps = defaultDeps()) {
  return async function handler(req: MinimalRequest, res: MinimalResponse) {
    res.setHeader("Cache-Control", "no-store");
    if (!bearerMatches(req.headers, deps.env.CRON_SECRET)) return void res.status(401).json({ error: "Unauthorized" });
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return void res.status(405).json({ error: "Method not allowed" });
    }
    const q = req.query ?? {};
    const extra = Object.keys(q).filter((k) => k !== "site");
    const site = q.site;
    if (extra.length || typeof site !== "string" || !isReportingSite(site)) return void res.status(400).json({ error: "site must be exactly one of au, uk, us" });
    const client = deps.client();
    if (!client) return void res.status(500).json({ error: "Reporting service configuration missing" });
    try {
      const result = await deps.run(client, site);
      res.status(result.state === "failed" ? 500 : 200).json(result);
    } catch {
      res.status(500).json({ error: "Reporting refresh failed" });
    }
  };
}

export default createRefreshHandler();
