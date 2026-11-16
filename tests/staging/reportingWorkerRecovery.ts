/**
 * Task 15: recovery/cleanup ONLY for an interrupted --worker-runtime run
 * (PREPARED; run by root only, staging only):
 *
 *   npm run staging:reporting-jobs -- --recover-worker-run --site=X --report=<that run's staging-results-reporting-worker-worker-runtime-*.md>
 *
 * Preconditions: the original driver process is TERMINATED and the site's
 * lease has REALLY expired (this path never waits, resumes or renews a lease).
 *
 * Refusal first. Before any write it proves, from the persisted report and
 * read-only SQL, that: the report is an unmodified --worker-runtime report
 * for this site with a valid run id, prefix and exact fixture ids; 0043 is
 * installed; the site's active batch (if any) is one of the run's recorded
 * batches and its lease has expired; every batch/generation created at the
 * site since the run started is the run's; the only source rows with the
 * run's prefix are its exact fixture ids; capture is off, or on only because
 * this run's own confirmed receipts left it on.
 *
 * Then, each step independent and every failure kept: abandon ONLY the owned
 * expired batch with its CURRENT fence (no resume/renew); capture off (owned
 * receipt); delete exactly the fixture ids (capture off); processor off and
 * legacy read mode. The fresh audit then compares against the ORIGINAL run's
 * persisted baseline with the same scoped ownership rules.
 */
import { createHash } from "node:crypto";
import { abandonReportingBatch } from "../../api/_lib/reporting-jobs";
import { readFileSync } from "node:fs";
import type { Db, Site } from "./reportingPublication";
import { WORKER_CATALOG_SQL, workerCatalogParams, workerCatalogProblems, workerObjects, MIGRATION_0043, type WorkerCatalog } from "./reportingWorkerHarness";
import type { RuntimeOwnership } from "./reportingWorkerRuntime";
import { checker, fixtureIdsFor, serviceCall, SITE_ROW_SQL, withConn, type RuntimeCtx, type RuntimeEvidence } from "./reportingWorkerScenario";

export interface RecoveredRun {
  own: RuntimeOwnership;
  ev: RuntimeEvidence;
  reportSha256: string;
}

const jsonBlock = (md: string, heading: string): unknown => {
  const at = md.indexOf(`\n## ${heading}\n`);
  if (at < 0) return undefined;
  const m = /```json\n([\s\S]*?)\n```/.exec(md.slice(at));
  if (!m) return undefined;
  return JSON.parse(m[1]);
};
const isStrArray = (x: unknown): x is string[] => Array.isArray(x) && x.every((v) => typeof v === "string");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure: parse and validate the interrupted run's own persisted report. Throws with every problem. */
export function parseRunReport(markdown: string, site: Site): RecoveredRun {
  const md = markdown.replace(/\r\n/g, "\n");
  const p: string[] = [];
  if (!/^# Reporting worker staging evidence \(worker-runtime\)\n/.test(md)) p.push("the file is not a --worker-runtime report");
  const siteLine = /^- project: ybrzhrgfrnvtcwymjdrq \(staging\) · site: (\w+) /m.exec(md);
  if (!siteLine) p.push("the report has no staging project/site line");
  else if (siteLine[1] !== site) p.push(`the report is for site ${siteLine[1]}, not ${site}`);
  let own: RuntimeOwnership | undefined;
  let ev: RuntimeEvidence | undefined;
  try {
    own = jsonBlock(md, "Ownership") as RuntimeOwnership | undefined;
    ev = jsonBlock(md, "Evidence") as RuntimeEvidence | undefined;
  } catch (e) {
    p.push(`the report's JSON is not readable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!own) p.push("the report has no ownership record");
  if (!ev) p.push("the report has no evidence record");
  if (own) {
    if (own.site !== site) p.push(`the ownership is for site ${String(own.site)}, not ${site}`);
    if (typeof own.runId !== "string" || !/^[0-9a-f]{8}$/.test(own.runId)) p.push("the run id is not 8 hex characters");
    else if (own.prefix !== `rw-${own.runId}-`) p.push(`the fixture prefix ${String(own.prefix)} is not rw-${own.runId}-`);
    if (typeof own.startedAt !== "string" || Number.isNaN(Date.parse(own.startedAt))) p.push("the run has no recorded start time (it never passed preflight)");
    if (own.committedAnything !== true) p.push("the run never committed anything; there is nothing to recover");
    if (!own.original || own.original.captureEnabled !== false || own.original.processor !== false || own.original.readMode !== "legacy") p.push("the run's recorded starting state is not capture off / processor off / legacy");
    if (!isStrArray(own.batches) || !own.batches.every((b) => UUID.test(b))) p.push("the recorded batches are not uuids");
    if (!isStrArray(own.generations) || !own.generations.every((g) => UUID.test(g))) p.push("the recorded generations are not uuids");
    if (!isStrArray(own.fixtureIds) || (typeof own.runId === "string" && JSON.stringify(own.fixtureIds) !== JSON.stringify(fixtureIdsFor(own)))) p.push("the recorded fixture ids are not exactly this run's");
    if (!Array.isArray(own.captureTransitions) || !Array.isArray(own.invocations)) p.push("the receipts or invocations are missing");
    if (!/^\d+$/.test(String(own.baselineMaxChangeId))) p.push("the journal high-water mark is missing");
  }
  if (ev && (!ev.before || !ev.stableBefore)) p.push("the report has no starting baseline");
  if (p.length) throw new Error(`refusing to recover: ${p.join("; ")}`);
  return { own: own!, ev: { ...ev!, complete: false }, reportSha256: createHash("sha256").update(markdown).digest("hex") };
}

/** Whether this run's own CONFIRMED receipts leave capture enabled (the only way recovery may turn capture off). */
export function runLeftCaptureOn(own: RuntimeOwnership): boolean {
  const confirmed = own.captureTransitions.filter((t) => t.state === "confirmed");
  if (own.captureTransitions.some((t) => t.state === "tentative" || t.state === "uncertain")) return false;
  return confirmed.length > 0 && confirmed[confirmed.length - 1].enable === true;
}

export const RECOVERY_STATE_SQL = `select json_build_object(
  'captureEnabled', (select capture_enabled from reporting_private.control where singleton),
  'captureEpoch', (select capture_epoch::text from reporting_private.control where singleton),
  'activeBatch', (select active_batch_id::text from reporting_private.site_state where site = $1),
  'leaseFence', (select lease_fence::text from reporting_private.site_state where site = $1),
  'leaseLive', (select coalesce(lease_expires_at > now(), false) from reporting_private.site_state where site = $1 and active_batch_id is not null),
  'liveBatches', (select coalesce(json_agg(b.batch_id::text order by b.batch_id), '[]'::json) from reporting_private.batches b where b.site = $1 and b.state in ('active', 'frozen', 'publishing') and b.lease_expires_at > now()),
  'siteBatches', (select coalesce(json_agg(b.batch_id::text order by b.batch_id), '[]'::json) from reporting_private.batches b where b.site = $1 and b.created_at >= $2::timestamptz),
  'siteGenerations', (select coalesce(json_agg(g.generation_id::text order by g.generation_id), '[]'::json) from reporting_private.generations g where g.site = $1 and g.created_at >= $2::timestamptz),
  'prefixRows', (select coalesce(json_agg(e.id order by e.id), '[]'::json) from public.production_events e where e.id like $3),
  'prefixElsewhere', (select count(*) from public.production_events e where e.id like $3 and e.location <> $1)
) as j`;
export interface RecoveryState {
  captureEnabled: boolean; captureEpoch: string; activeBatch: string | null; leaseFence: string | null; leaseLive: boolean | null;
  liveBatches: string[]; siteBatches: string[]; siteGenerations: string[]; prefixRows: string[]; prefixElsewhere: number;
}

/** Pure: every reason the database state is not provably this run's interrupted state. */
export function recoveryRefusals(own: RuntimeOwnership, s: RecoveryState): string[] {
  const p: string[] = [];
  if (s.activeBatch && !own.batches.includes(s.activeBatch)) p.push(`${own.site}'s active batch ${s.activeBatch} is not this run's`);
  if (s.activeBatch && s.leaseLive !== false) p.push(`${own.site}'s lease is still live; terminate the driver and wait for the real lease expiry`);
  for (const b of s.liveBatches) p.push(`batch ${b} at ${own.site} still holds a live lease`);
  const foreignB = s.siteBatches.filter((b) => !own.batches.includes(b));
  if (foreignB.length) p.push(`batches [${foreignB.join(", ")}] at ${own.site} since the run started are not this run's`);
  const foreignG = s.siteGenerations.filter((g) => !own.generations.includes(g));
  if (foreignG.length) p.push(`generations [${foreignG.join(", ")}] at ${own.site} since the run started are not this run's`);
  const foreignRows = s.prefixRows.filter((id) => !own.fixtureIds.includes(id));
  if (foreignRows.length) p.push(`source rows [${foreignRows.join(", ")}] use the run's prefix but are not its fixture ids`);
  if (Number(s.prefixElsewhere) > 0) p.push(`${s.prefixElsewhere} source row(s) with the run's prefix are at another site`);
  if (s.captureEnabled && !runLeftCaptureOn(own)) p.push("capture is enabled but this run's confirmed receipts did not leave it on");
  return p;
}

export const REQUIRED_RECOVERY_CASES = ["X0", "X1", "X2", "X3", "X4", "X5"] as const;

/**
 * X0 0043 installed and the report's run matches; X1 the database state is
 * provably this run's (refuse otherwise; nothing written). X2-X5 run even
 * after an earlier step fails (each failure kept in `failures`): abandon the
 * owned expired batch with its current fence; capture off by an owned receipt;
 * delete exactly the fixture ids with capture off; processor off + legacy.
 * Returns whether anything may have been written.
 */
export async function recoverWorkerRun(main: Db, ctx: RuntimeCtx, run: RecoveredRun, failures: string[]): Promise<{ wrote: boolean }> {
  const { own, ev } = run;
  const check = checker(ctx, ev);
  const t43 = (ctx.read ?? ((p: string) => readFileSync(p, "utf8")))(MIGRATION_0043);
  await check("X0", "0043 is installed exactly as reviewed", "installed", async () => {
    const cat = (await main.query(WORKER_CATALOG_SQL, workerCatalogParams(workerObjects(t43)))).rows[0].j as WorkerCatalog;
    const p = workerCatalogProblems(cat, t43, "installed");
    if (p.length) throw new Error(p.join("; "));
  });
  const st = await check("X1", "the database state is provably this interrupted run's (owned batch, expired lease, no foreign batch/generation/prefix row, capture explained)", "no refusal; nothing written", async () => {
    const s = (await main.query(RECOVERY_STATE_SQL, [own.site, own.startedAt, `${own.prefix}%`])).rows[0].j as RecoveryState;
    const p = recoveryRefusals(own, s);
    if (p.length) throw new Error(p.join("; "));
    return s;
  }, (s) => `active ${s.activeBatch ?? "none"} (fence ${s.leaseFence ?? "-"}, expired); capture ${s.captureEnabled ? "on (this run's)" : "off"}; ${s.prefixRows.length} fixture row(s)`);
  ctx.enterCleanup?.();
  const stepDo = async (id: string, what: string, fn: () => Promise<string>) => {
    const t0 = ctx.now();
    try {
      await ctx.hooks?.beforeCleanupStep?.(id);
      const r = await fn();
      ctx.record({ id, what, expected: "done", result: ctx.redact(r), ok: true, ms: Math.round(ctx.now() - t0) });
      ev.recorded.push(id);
    } catch (e) {
      const m = ctx.redact(e instanceof Error ? e.message : String(e));
      ctx.record({ id, what, expected: "done", result: m, ok: false, ms: Math.round(ctx.now() - t0) });
      failures.push(`${id} ${what}: ${m}`);
    }
    try {
      ctx.save();
    } catch (e) {
      failures.push(`report save after ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await stepDo("X2", "abandon ONLY the owned expired batch with its current fence (no resume or renew)", async () => {
    if (!st.activeBatch) return "no active batch";
    const now = await withConn(ctx, async (c) => (await c.query(SITE_ROW_SQL, [own.site])).rows[0]);
    if (String(now?.active_batch_id) !== st.activeBatch || String(now?.lease_fence) !== st.leaseFence) throw new Error("the active batch or its fence changed since X1; refusing to abandon");
    const r = await withConn(ctx, (c) => abandonReportingBatch(ctx.rpcClient(c), st.activeBatch!, Number(st.leaseFence), "staging worker harness recovery (interrupted run)"));
    return `${r.batchId} ${r.state}/${r.failureKind}`;
  });
  await stepDo("X3", "capture off (owned receipt) when this run left it on", async () => {
    const on = await withConn(ctx, async (c) => Boolean((await c.query("select capture_enabled from reporting_private.control where singleton")).rows[0].capture_enabled));
    if (!on) return "already off";
    if (!runLeftCaptureOn(own)) throw new Error("capture is on but not because of this run; left unchanged");
    return `epoch ${await ctx.toggle(false, true)}`;
  });
  await stepDo("X4", "delete exactly this run's fixture ids (only with capture off)", async () => {
    return withConn(ctx, async (c) => {
      const on = Boolean((await c.query("select capture_enabled from reporting_private.control where singleton")).rows[0].capture_enabled);
      if (on) throw new Error("capture is still enabled; fixtures kept so no unowned journal row is created");
      const r = await c.query("delete from public.production_events where location = $1 and id = any($2::text[]) returning id", [own.site, own.fixtureIds]);
      return `${r.rows.length} row(s) deleted`;
    });
  });
  await stepDo("X5", "processor off and legacy read mode for the site", async () => {
    await serviceCall(ctx, "set_reporting_site_mode", { p_site: own.site, p_read_mode: "legacy", p_processor_enabled: false });
    return "processor off, legacy";
  });
  return { wrote: true };
}
