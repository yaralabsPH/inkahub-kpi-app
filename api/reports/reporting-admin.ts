/**
 * POST /api/reports/reporting-admin
 *
 * Task 15: explicit operator (CJ) commands, authenticated with
 * `Authorization: Bearer <REPORTING_OPERATOR_SECRET>` BEFORE any parsing,
 * environment or database work. The operator secret must be configured and
 * differ from CRON_SECRET (otherwise every request is refused as a
 * misconfiguration), so the scheduler cannot run operator actions and an app
 * session token never can. Precedence: 401 → 405 (not POST) → 400 (strict
 * body: exact keys per action) → 500 (configuration) → work.
 *
 *   {action:"status", site}                         read-only job/backlog state
 *   {action:"rebuild", site}                        full rebuild (bounded, resumable)
 *   {action:"cleanup", site}                        retention pass (7-day generations, 30-day log)
 *   {action:"set-mode", site, readMode?, processorEnabled?}
 *   {action:"abandon", site, reason}                expired/invalidated batch only; evidence kept
 *   {action:"disable-capture"}                      ALL SITES: new capture epoch; every site needs a rebuild
 *   {action:"enable-capture"}                       ALL SITES: new capture epoch; every site needs a rebuild
 *
 * Every action is recorded (redacted) in the run log. No-store.
 */
import { z } from "zod";
import { bearerMatches, serviceRpcClient, type MinimalRequest, type MinimalResponse } from "../_lib/reporting-auth.js";
import { abandonReportingBatch, getReportingJobStatus, REPORTING_SITES, setReportingCapture, type ReportingSite, type RpcClient } from "../_lib/reporting-jobs.js";
import { runReportingCycle, type CycleResult } from "../_lib/production-reporting-worker.js";
import { recordRun, setSiteMode } from "../_lib/reporting-worker-state.js";

export const config = { maxDuration: 300 };

const site = z.enum(["au", "uk", "us"]);
export const AdminCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), site }).strict(),
  z.object({ action: z.literal("rebuild"), site }).strict(),
  z.object({ action: z.literal("cleanup"), site }).strict(),
  z.object({ action: z.literal("set-mode"), site, readMode: z.enum(["legacy", "shadow", "summary"]).optional(), processorEnabled: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("abandon"), site, reason: z.string().trim().min(1).max(180) }).strict(),
  z.object({ action: z.literal("disable-capture") }).strict(),
  z.object({ action: z.literal("enable-capture") }).strict(),
]).superRefine((c, ctx) => {
  if (c.action === "set-mode" && c.readMode === undefined && c.processorEnabled === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "set-mode needs readMode and/or processorEnabled" });
});
export type AdminCommand = z.infer<typeof AdminCommand>;

export interface AdminDeps {
  env: Record<string, string | undefined>;
  client(): RpcClient | null;
  now(): number;
  cycle(client: RpcClient, site: ReportingSite, mode: "rebuild" | "cleanup"): Promise<CycleResult>;
}
const defaultDeps = (): AdminDeps => ({
  env: process.env,
  client: () => serviceRpcClient(process.env),
  now: () => Date.now(),
  cycle: (client, s, mode) => runReportingCycle({ client, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }, { site: s, mode }),
});

const ALL_SITES_NOTE = "capture changes are global: the capture epoch advanced for every site; each site's published reports are invalidated until a rebuild completes";

/** Execute one validated command (exported for tests). */
export async function runAdminCommand(client: RpcClient, cmd: AdminCommand, deps: Pick<AdminDeps, "cycle">): Promise<{ status: number; body: Record<string, unknown> }> {
  switch (cmd.action) {
    case "status":
      return { status: 200, body: { action: cmd.action, site: cmd.site, status: await getReportingJobStatus(client, cmd.site) } };
    case "rebuild":
    case "cleanup": {
      const r = await deps.cycle(client, cmd.site, cmd.action);
      return { status: r.state === "failed" ? 500 : 200, body: { action: cmd.action, site: cmd.site, result: r } };
    }
    case "set-mode":
      return { status: 200, body: { action: cmd.action, site: cmd.site, result: await setSiteMode(client, cmd.site, cmd.readMode ?? null, cmd.processorEnabled ?? null) } };
    case "abandon": {
      const s = await getReportingJobStatus(client, cmd.site);
      if (!s.activeBatchId) return { status: 409, body: { action: cmd.action, site: cmd.site, error: "no active batch" } };
      return { status: 200, body: { action: cmd.action, site: cmd.site, result: await abandonReportingBatch(client, s.activeBatchId, s.leaseFence, cmd.reason) } };
    }
    case "disable-capture":
    case "enable-capture": {
      const r = await setReportingCapture(client, cmd.action === "enable-capture");
      return { status: 200, body: { action: cmd.action, affectedSites: [...REPORTING_SITES], rebuildRequired: [...REPORTING_SITES], note: ALL_SITES_NOTE, result: r } };
    }
  }
  throw new Error("unknown action");
}

export function createAdminHandler(deps: AdminDeps = defaultDeps()) {
  return async function handler(req: MinimalRequest, res: MinimalResponse) {
    res.setHeader("Cache-Control", "no-store");
    const secret = deps.env.REPORTING_OPERATOR_SECRET;
    if (!bearerMatches(req.headers, secret)) return void res.status(401).json({ error: "Unauthorized" });
    if (secret === deps.env.CRON_SECRET) return void res.status(500).json({ error: "Operator secret must differ from the scheduler secret" });
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return void res.status(405).json({ error: "Method not allowed" });
    }
    let raw: unknown = req.body;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        return void res.status(400).json({ error: "Body must be JSON" });
      }
    }
    if (req.query && Object.keys(req.query).length) return void res.status(400).json({ error: "No query parameters are accepted" });
    const parsed = AdminCommand.safeParse(raw);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid command", issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).slice(0, 5) });
    const client = deps.client();
    if (!client) return void res.status(500).json({ error: "Reporting service configuration missing" });
    const t0 = deps.now();
    const cmd = parsed.data;
    let out: { status: number; body: Record<string, unknown> };
    try {
      out = await runAdminCommand(client, cmd, deps);
    } catch (e) {
      out = { status: 500, body: { action: cmd.action, error: (e instanceof Error ? e.message : String(e)).replace(/(Bearer\s+)\S+/gi, "$1[redacted]").slice(0, 300) } };
    }
    try {
      await recordRun(client, {
        site: "site" in cmd ? (cmd as { site: ReportingSite }).site : null, mode: "operator", action: cmd.action, outcome: out.status >= 400 ? "failed" : "done", batchId: null, generationId: null,
        startedAtUtc: new Date(t0).toISOString(), durationMs: deps.now() - t0, counts: {}, failureKind: out.status >= 400 ? `http_${out.status}` : null,
      });
    } catch {
      out.body.runLog = "not recorded";
    }
    res.status(out.status).json({ ...out.body, at: new Date(t0).toISOString() });
  };
}

export default createAdminHandler();
