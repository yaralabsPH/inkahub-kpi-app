/**
 * Task 15 runtime gate: context, checker, preflight (R0/R0b) and the
 * always-run cleanup. The committed scenarios (R1-R7) are added in later
 * increments in this module. PREPARED; NOT run by the coder.
 */
import { readFileSync } from "node:fs";
import { CASE_SQL, MIGRATION_0040, MIGRATION_0041 } from "./reportingDependencyRehearsal";
import { MIGRATION_0042 } from "./reportingDependencyPlans";
import { PREFLIGHT_SQL, preflightProblems, type PreflightSnapshot } from "./reportingCommitted";
import { compareFullState, type Db, type FullState, type Observation, type Site } from "./reportingPublication";
import {
  dependencyIdentityProblems, historyProblems, MIGRATION_0043, REVIEWED_0043_LF, sha256Lf, WORKER_CATALOG_SQL, workerCatalogParams, workerCatalogProblems, workerObjects, type WorkerCatalog,
} from "./reportingWorkerHarness";
import { OWNERSHIP_SQL, ownershipParams, parityProblems, runtimeAllowance, runtimeAuditProblems, stableHashes, type RuntimeInvocation, type RuntimeOwnership } from "./reportingWorkerRuntime";
import { runReportingCycle, WORKER_BUDGET_MS } from "../../api/_lib/production-reporting-worker";
import { abandonReportingBatch } from "../../api/_lib/reporting-jobs";
import type { ServiceRpcClient, ServiceRpcOptions } from "./serviceRpc";

/** Task 15 scale contingency: the worker's predecessor walk reads 0045; the runtime refuses unless it is installed exactly. */
export const MIGRATION_0045 = "supabase/migrations/0045_reporting_predecessor_page.sql";

export interface RuntimeConn extends Db { end(): Promise<void> }
export interface RuntimeCtx {
  site: Site;
  /** The staff test user (fixture owner; self-audience parity). */
  staff: string;
  /** A fresh guarded, marker-checked connection (runner). */
  open(): Promise<RuntimeConn>;
  rpcClient(c: RuntimeConn, opts?: ServiceRpcOptions): ServiceRpcClient;
  asRole(c: Db, role: "postgres" | "service_role" | "authenticated"): Promise<void>;
  /** This run's OWN capture transition (receipt persisted before COMMIT into own.captureTransitions). */
  toggle(enabled: boolean, restoring?: boolean): Promise<number>;
  history(c: Db): Promise<Array<Record<string, unknown>>>;
  state(c: Db): Promise<FullState>;
  /** Wait (bounded) until the site's live lease has expired; returns ms waited. Hosted: a real wait, never a lease edit. */
  awaitLeaseExpiry(site: Site): Promise<number>;
  record(o: Observation): void;
  save(): void;
  redact(s: string): string;
  now(): number;
  sleep(ms: number): Promise<void>;
  limits: { paceCalls: number; maxInvocations: number };
  enterCleanup?(): void;
  read?: (path: string) => string;
  /** Test hooks only (injected failures); never set by the runner. */
  hooks?: { afterStep?(id: string): Promise<void>; beforeCleanupStep?(label: string): Promise<void> };
}
export interface RuntimeEvidence {
  identities: Record<string, unknown> | null;
  stableBefore: Record<string, string> | null;
  before: FullState | null;
  recorded: string[];
  complete: boolean;
}
export const newRuntimeEvidence = (): RuntimeEvidence => ({ identities: null, stableBefore: null, before: null, recorded: [], complete: false });

export const SITE_ROW_SQL = "select active_batch_id::text as active_batch_id, lease_fence::text as lease_fence, processor_enabled, read_mode, active_generation_id::text as active_generation_id from reporting_private.site_state where site = $1";
export const fixtureIdsFor = (own: RuntimeOwnership) => ["v1", "v2", "c1"].map((s) => `${own.prefix}${s}`);

/** Stop on the first failure: every check records an observation and throws when it does not hold. */
export function checker(ctx: RuntimeCtx, ev: RuntimeEvidence) {
  return async <T>(id: string, what: string, expected: string, fn: () => Promise<T>, show: (t: T) => string = () => "ok"): Promise<T> => {
    const t0 = ctx.now();
    try {
      const v = await fn();
      ctx.record({ id, what, expected, result: ctx.redact(show(v)), ok: true, ms: Math.round(ctx.now() - t0) });
      ev.recorded.push(id);
      await ctx.hooks?.afterStep?.(id);
      return v;
    } catch (e) {
      ctx.record({ id, what, expected, result: ctx.redact(e instanceof Error ? e.message : String(e)), ok: false, ms: Math.round(ctx.now() - t0) });
      throw new Error(`${id} failed; the run stops here (cleanup and the fresh audit still run)`);
    }
  };
}

export async function withConn<T>(ctx: Pick<RuntimeCtx, "open">, fn: (c: RuntimeConn) => Promise<T>): Promise<T> {
  const c = await ctx.open();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
export const serviceCall = async (ctx: Pick<RuntimeCtx, "open" | "rpcClient">, fn: string, args: Record<string, unknown>) =>
  withConn(ctx, async (c) => {
    const r = await ctx.rpcClient(c).rpc(fn, args);
    if (r.error) throw new Error(`${fn}: ${r.error.message}`);
    return r.data;
  });

/**
 * R0 (read-only): the local 0043 is the pinned file; history and installed
 * identities are 0040-0043 exactly; capture off; nothing active; the site
 * clean (processor off, legacy, no batch/generation/derived/mirror/pending
 * journal row); no fixture collision. Then start time, journal high-water
 * mark, original settings, fixture ids and both baselines are taken and the
 * ownership is SAVED before anything is committed. R0b: a second baseline is
 * identical (no drift). Nothing is written by either step.
 */
export async function preflightRuntime(main: Db, ctx: RuntimeCtx, own: RuntimeOwnership, ev: RuntimeEvidence): Promise<void> {
  const check = checker(ctx, ev);
  const read = ctx.read ?? ((p: string) => readFileSync(p, "utf8"));
  const t43 = read(MIGRATION_0043);
  await check("R0", "identities and preflight: history 0040-0043, installed bodies, capture off, nothing active, the site clean, no fixture collision", "every check holds; nothing is written", async () => {
    const p: string[] = [];
    if (sha256Lf(t43) !== REVIEWED_0043_LF) p.push("the local 0043 file is not the reviewed draft");
    const history = await ctx.history(main);
    p.push(...historyProblems(history, "installed"));
    p.push(...dependencyIdentityProblems((await main.query(CASE_SQL.effective)).rows, read(MIGRATION_0040), read(MIGRATION_0041), read(MIGRATION_0042)));
    const cat = (await main.query(WORKER_CATALOG_SQL, workerCatalogParams(workerObjects(t43)))).rows[0].j as WorkerCatalog;
    p.push(...workerCatalogProblems(cat, t43, "installed"));
    const t45 = read(MIGRATION_0045);
    const cat45 = (await main.query(WORKER_CATALOG_SQL, workerCatalogParams(workerObjects(t45)))).rows[0].j as WorkerCatalog;
    p.push(...workerCatalogProblems(cat45, t45, "installed").map((x) => `0045: ${x}`));
    const pre = (await main.query(PREFLIGHT_SQL, [[own.site], `${own.prefix}%`])).rows[0].j as PreflightSnapshot;
    p.push(...preflightProblems(pre, [own.site]));
    if (p.length) throw new Error(p.join("; "));
    const s = pre.sites.find((x) => x.site === own.site);
    const t = (await main.query("select now()::text as t, (select coalesce(max(change_id), 0)::text from reporting_private.changes) as m")).rows[0];
    own.startedAt = String(t.t);
    own.baselineMaxChangeId = String(t.m);
    own.original = { captureEnabled: pre.captureEnabled, captureEpoch: pre.captureEpoch, processor: Boolean(s?.processor), readMode: String(s?.readMode) };
    own.fixtureIds = fixtureIdsFor(own);
    ev.identities = { history, captureEpoch: pre.captureEpoch };
    ev.before = await ctx.state(main);
    ev.stableBefore = await stableHashes(main, own);
    ctx.save(); // ownership and baseline are durable BEFORE the first commit
    return pre;
  }, (pre) => `epoch ${pre.captureEpoch}; ${own.site} clean; fixtures ${own.prefix}*`);
  await check("R0b", "baseline drift: a second baseline taken immediately before the first commit is identical", "identical", async () => {
    const d = compareFullState(ev.before!, await ctx.state(main));
    const s = await stableHashes(main, own);
    for (const t of new Set([...Object.keys(s), ...Object.keys(ev.stableBefore!)])) if (s[t] !== ev.stableBefore![t]) d.push(`reporting_private.${t} drifted`);
    if (d.length) throw new Error(d.join("; "));
  });
}

// ---------------------------------------------------------------------------
// Invocations
// ---------------------------------------------------------------------------

const OWN_IDS_SQL = `select (select coalesce(array_agg(b.batch_id::text order by b.created_at), '{}') from reporting_private.batches b where b.site = $1 and b.created_at >= $2::timestamptz) as batches,
  (select coalesce(array_agg(g.generation_id::text order by g.generation_seq), '{}') from reporting_private.generations g where g.site = $1 and g.created_at >= $2::timestamptz) as generations`;

/**
 * One REAL worker invocation on its own fresh connection. Refuses when the
 * site has an active batch this run does not own. New run-site batches and
 * generations (created at/after the run start; the site was clean and the run
 * requires it exclusively) are recorded as this run's and saved at once.
 * `pace` exhausts the 240 s budget after that many RPC calls (every call is
 * real); used only to stop the rebuild continuation case mid-copy.
 */
export async function invoke(ctx: RuntimeCtx, own: RuntimeOwnership, label: string, mode: "refresh" | "rebuild", opts: { pace?: number; fault?: ServiceRpcOptions["fault"] } = {}): Promise<RuntimeInvocation> {
  if (own.invocations.length >= ctx.limits.maxInvocations) throw new Error(`more than ${ctx.limits.maxInvocations} worker invocations; stopping`);
  const c = await ctx.open();
  try {
    const st = (await c.query(SITE_ROW_SQL, [own.site])).rows[0];
    if (st?.active_batch_id && !own.batches.includes(String(st.active_batch_id))) throw new Error(`${own.site} has an active batch ${String(st.active_batch_id)} this run does not own; refusing to invoke the worker`);
    const client = ctx.rpcClient(c, { fault: opts.fault });
    const pace = opts.pace ?? null;
    const now = pace === null ? () => ctx.now() : () => ctx.now() + (client.calls.length >= pace ? WORKER_BUDGET_MS + 1 : 0);
    const r = await runReportingCycle({ client, now, sleep: (ms) => ctx.sleep(ms), redact: ctx.redact }, { site: own.site, mode });
    const ids = (await c.query(OWN_IDS_SQL, [own.site, own.startedAt])).rows[0];
    for (const b of ids.batches as string[]) if (!own.batches.includes(b)) own.batches.push(b);
    for (const g of ids.generations as string[]) if (!own.generations.includes(g)) own.generations.push(g);
    const after = (await c.query(SITE_ROW_SQL, [own.site])).rows[0];
    const inv: RuntimeInvocation = {
      n: own.invocations.length + 1, label, mode, paced: pace, state: r.state, batchId: r.batchId, generationId: r.generationId, failureKind: r.failureKind,
      problems: r.problems.map((x) => ctx.redact(x)), counts: r.counts, calls: client.calls.length, injected: client.injected, fenceAfter: after?.lease_fence == null ? null : String(after.lease_fence),
    };
    own.invocations.push(inv);
    ctx.save();
    return inv;
  } finally {
    await c.end();
  }
}

/** Invoke until published; after a pending invocation the live lease is waited out (real wait) before the next takeover. */
export async function driveToPublished(ctx: RuntimeCtx, own: RuntimeOwnership, label: string, mode: "refresh" | "rebuild", fault?: ServiceRpcOptions["fault"]): Promise<RuntimeInvocation[]> {
  const out: RuntimeInvocation[] = [];
  for (;;) {
    const inv = await invoke(ctx, own, `${label} #${out.length + 1}`, mode, { fault });
    out.push(inv);
    if (inv.state === "published") return out;
    if (inv.state !== "pending") throw new Error(`${label}: invocation ${inv.n} ended ${inv.state} (${inv.failureKind ?? "-"}): ${inv.problems.join("; ")}`);
    await ctx.awaitLeaseExpiry(own.site);
  }
}

// ---------------------------------------------------------------------------
// R1-R4: processor-disabled no-work, enable, rebuild continuation/takeover, parity
// ---------------------------------------------------------------------------

export async function scenarioRebuild(main: Db, ctx: RuntimeCtx, own: RuntimeOwnership, ev: RuntimeEvidence): Promise<void> {
  const check = checker(ctx, ev);
  const site = own.site;
  own.committedAnything = true;
  ctx.save();
  await check("R1", "processor disabled: a refresh and a rebuild do no work (no batch) and each logs a failed run", "failed / processor_disabled twice; 0 batches", async () => {
    const a = await invoke(ctx, own, "R1 refresh (processor off)", "refresh");
    const b = await invoke(ctx, own, "R1 rebuild (processor off)", "rebuild");
    for (const i of [a, b]) if (i.state !== "failed" || i.failureKind !== "processor_disabled" || i.batchId !== null) throw new Error(`${i.label}: ${i.state}/${String(i.failureKind)}/${String(i.batchId)}`);
    if (own.batches.length) throw new Error(`batches were created: ${own.batches.join(", ")}`);
    return `${a.state}/${a.failureKind}, ${b.state}/${b.failureKind}`;
  }, (x) => x);
  await check("R2", "enable capture (owned receipt) and the run site's processor", "capture on; processor on", async () => {
    await ctx.toggle(true);
    own.processorChanged = true;
    ctx.save();
    await serviceCall(ctx, "set_reporting_site_mode", { p_site: site, p_read_mode: null, p_processor_enabled: true });
  });
  const a = await check("R3a", "rebuild invocation A (paced) stops pending with durable copy progress", "pending; active batch; saved copy cursor; candidate rows > 0", async () => {
    const inv = await invoke(ctx, own, "R3a rebuild (paced)", "rebuild", { pace: ctx.limits.paceCalls });
    if (inv.state !== "pending" || !inv.batchId) throw new Error(`expected pending with a batch, got ${inv.state}/${String(inv.batchId)}`);
    const b = (await main.query("select state, rebuild_cursor, lease_fence::text as fence, (select count(*)::int from reporting_private.source_candidate c where c.batch_id = $1) as rows from reporting_private.batches where batch_id = $1", [inv.batchId])).rows[0];
    if (b?.state !== "active" || !b.rebuild_cursor || !(Number(b.rows) > 0)) throw new Error(`no durable copy progress: ${JSON.stringify({ state: b?.state, rows: b?.rows })}`);
    return { inv, fence: String(b.fence), rows: Number(b.rows) };
  }, (x) => `batch ${String(x.inv.batchId)}, fence ${x.fence}, ${x.rows} candidate rows after ${x.inv.counts.copiedPages ?? 0} page(s)`);
  await check("R3b", "an immediate second invocation finds the live lease: busy, no new batch", "busy; same single batch", async () => {
    const inv = await invoke(ctx, own, "R3b rebuild (lease live)", "rebuild");
    if (inv.state !== "busy" || own.batches.length !== 1) throw new Error(`expected busy with one batch, got ${inv.state} with ${own.batches.length}`);
  });
  await check("R3c", "after the real lease expiry: takeover with a NEWER fence resumes the saved copy and publishes; the first publish response is lost and replayed", "published; fence > A's; exactly one generation; lost response injected", async () => {
    const waited = await ctx.awaitLeaseExpiry(site);
    const invs = await driveToPublished(ctx, own, "R3c rebuild (takeover)", "rebuild", (fn, n) => (fn === "publish_reporting_batch" && n === 1 ? "lost-after-commit" : null));
    const first = invs[0];
    if (first.batchId !== a.inv.batchId) throw new Error(`takeover worked on ${String(first.batchId)}, not ${String(a.inv.batchId)}`);
    if (!(BigInt(first.fenceAfter ?? "0") > BigInt(a.fence))) throw new Error(`fence did not advance (${a.fence} -> ${String(first.fenceAfter)})`);
    if (!invs[invs.length - 1].injected.some((x) => x.fn === "publish_reporting_batch")) throw new Error("the lost publish response was not exercised");
    if (own.generations.length !== 1) throw new Error(`${own.generations.length} generations, expected exactly 1 after the replay`);
    return { waited, n: invs.length, copied: invs.reduce((s, i) => s + (i.counts.copiedPages ?? 0), 0) };
  }, (x) => `waited ${x.waited} ms; ${x.n} invocation(s); ${x.copied} further page(s) copied`);
  await check("R3d", "the expired worker's old fence is refused and changes nothing", "refused; site_state unchanged", async () => {
    const before = (await main.query(SITE_ROW_SQL, [site])).rows[0];
    let refused: string | null = null;
    try {
      await serviceCall(ctx, "renew_reporting_lease", { p_batch: a.inv.batchId, p_fence: Number(a.fence) });
    } catch (e) {
      refused = e instanceof Error ? e.message : String(e);
    }
    const after = (await main.query(SITE_ROW_SQL, [site])).rows[0];
    if (refused === null) throw new Error("the old fence was accepted");
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("the refused call changed site_state");
    return refused;
  }, (x) => `refused: ${x.slice(0, 120)}`);
  await check("R4", "exact publication after the rebuild: mirror = source; daily totals (site, self) = the independent reducer", "no difference", async () => {
    const p = await parityProblems(main, site, ctx.staff);
    if (p.length) throw new Error(p.join("; "));
  });
}

// ---------------------------------------------------------------------------
// R5-R7: refresh after run-owned changes, run log/security, capture invalidation and recovery
// ---------------------------------------------------------------------------

export const REQUIRED_RUNTIME_CASES = ["R0", "R0b", "R1", "R2", "R3a", "R3b", "R3c", "R3d", "R4", "R5", "R6", "R7a", "R7b", "R7c"] as const;

const FIXTURE_INSERT_SQL = `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at)
  values ($1, $2, $5::uuid, 'framed', $6, 'INKA-KAN0566-A4-FB', 2, 'line_verified', 'rw-station', 'worker runtime', now() - interval '2 hours'),
         ($1, $3, $5::uuid, 'framed', $6, 'INKA-KAN0566-A4-FB', 1, 'line_verified', 'rw-station', 'worker runtime', now() - interval '2 hours' + interval '1 minute'),
         ($1, $4, $5::uuid, 'framed', null, null, null, 'clock_in', 'rw-station', 'worker runtime', now() - interval '2 hours' + interval '2 minutes')`;

export async function scenarioRefreshAndCapture(main: Db, ctx: RuntimeCtx, own: RuntimeOwnership, ev: RuntimeEvidence): Promise<void> {
  const check = checker(ctx, ev);
  const site = own.site;
  const t43 = (ctx.read ?? ((p: string) => readFileSync(p, "utf8")))(MIGRATION_0043);
  await check("R5", "refresh after run-owned source changes (3 inserts, 1 update, 1 delete): exact journal, acknowledgement and publication", "5 journal rows acknowledged by the refresh batch; one more generation; parity", async () => {
    const [v1, v2, c1] = own.fixtureIds;
    const gens = own.generations.length;
    own.fixturesInserted = true; // durable before the insert can commit
    ctx.save();
    await withConn(ctx, async (c) => {
      await c.query(FIXTURE_INSERT_SQL, [site, v1, v2, c1, ctx.staff, `RW-${own.runId}`]);
      await c.query("update public.production_events set note = 'worker runtime (updated)' where location = $1 and id = $2", [site, v2]);
      await c.query("delete from public.production_events where location = $1 and id = $2", [site, c1]);
    });
    const invs = await driveToPublished(ctx, own, "R5 refresh", "refresh");
    const batch = invs[invs.length - 1].batchId;
    const j = (await main.query("select count(*)::int as n, count(*) filter (where acknowledged_at is not null and batch_id = $3::uuid)::int as acked from reporting_private.changes where change_id > $1::bigint and (old_event_id = any($2::text[]) or new_event_id = any($2::text[]))", [own.baselineMaxChangeId, own.fixtureIds, batch])).rows[0];
    if (Number(j.n) !== 5 || Number(j.acked) !== 5) throw new Error(`journal rows for the fixtures: ${String(j.n)}, acknowledged by ${String(batch)}: ${String(j.acked)} (expected 5/5)`);
    if (own.generations.length !== gens + 1) throw new Error(`${own.generations.length} generations, expected ${gens + 1}`);
    const p = await parityProblems(main, site, ctx.staff);
    if (p.length) throw new Error(p.join("; "));
    return invs.length;
  }, (n) => `${n} invocation(s); 5/5 journal rows acknowledged; parity holds`);
  await check("R6", "run log, security and ACLs: one numeric-count run row per invocation; worker objects unchanged; client role refused", "exact", async () => {
    const rows = (await main.query("select outcome, counts from reporting_private.worker_runs where site = $1 and started_at >= $2::timestamptz", [site, own.startedAt])).rows;
    if (rows.length !== own.invocations.length) throw new Error(`${rows.length} run rows, ${own.invocations.length} invocations`);
    const outcomes = rows.map((r) => String(r.outcome)).sort().join(",");
    const want = own.invocations.map((i) => i.state).sort().join(",");
    if (outcomes !== want) throw new Error(`run outcomes ${outcomes} differ from invocations ${want}`);
    for (const r of rows) if (Object.values((r.counts ?? {}) as Record<string, unknown>).some((v) => typeof v !== "number")) throw new Error("a run row carries a non-numeric count (possible payload)");
    const cat = (await main.query(WORKER_CATALOG_SQL, workerCatalogParams(workerObjects(t43)))).rows[0].j as WorkerCatalog;
    const p = workerCatalogProblems(cat, t43, "installed");
    if (p.length) throw new Error(p.join("; "));
    await withConn(ctx, async (c) => {
      for (const sql of ["select * from public.get_reporting_job_status($1)", "select * from public.set_reporting_site_mode($1, null, true)"]) {
        await c.query("begin");
        let allowed = false;
        try {
          await ctx.asRole(c, "authenticated");
          await c.query(sql, [site]);
          allowed = true;
        } catch (e) {
          if (!/permission denied/.test(e instanceof Error ? e.message : String(e))) throw e;
        } finally {
          await c.query("rollback");
        }
        if (allowed) throw new Error(`authenticated was allowed: ${sql}`);
      }
    });
    return rows.length;
  }, (n) => `${n} run rows`);
  const gens = own.generations.length;
  await check("R7a", "capture disable invalidates: the epoch advances and a refresh publishes nothing", "not published; no new generation", async () => {
    await ctx.toggle(false);
    const inv = await invoke(ctx, own, "R7a refresh (capture off)", "refresh");
    if (inv.state !== "failed" || inv.failureKind !== "capture_disabled" || inv.batchId !== null || own.generations.length !== gens) throw new Error(`expected failed/capture_disabled with no batch, got ${inv.state}/${String(inv.failureKind)}/${String(inv.batchId)}`);
    return inv;
  }, (i) => `${i.state}/${String(i.failureKind)}`);
  await check("R7b", "re-enabled capture cannot continue the old base: a refresh publishes nothing until a rebuild", "not published; no new generation", async () => {
    await ctx.toggle(true);
    const inv = await invoke(ctx, own, "R7b refresh (after re-enable)", "refresh");
    if (inv.state !== "failed" || inv.failureKind !== "rebuild_required" || own.generations.length !== gens) throw new Error(`expected failed/rebuild_required, got ${inv.state}/${String(inv.failureKind)}`);
    return inv;
  }, (i) => `${i.state}/${String(i.failureKind)}`);
  await check("R7c", "rebuild recovery after re-enable publishes exactly", "published; parity", async () => {
    await driveToPublished(ctx, own, "R7c rebuild (recovery)", "rebuild");
    if (own.generations.length !== gens + 1) throw new Error(`${own.generations.length} generations, expected ${gens + 1}`);
    const p = await parityProblems(main, site, ctx.staff);
    if (p.length) throw new Error(p.join("; "));
  });
}

/** The whole committed gate: preflight, R1-R7, required-case check. The caller ALWAYS runs cleanupRuntime and auditRuntime after it. */
export async function runWorkerRuntime(main: Db, ctx: RuntimeCtx, own: RuntimeOwnership, ev: RuntimeEvidence): Promise<void> {
  await preflightRuntime(main, ctx, own, ev);
  await scenarioRebuild(main, ctx, own, ev);
  await scenarioRefreshAndCapture(main, ctx, own, ev);
  const missing = REQUIRED_RUNTIME_CASES.filter((id) => !ev.recorded.includes(id));
  if (missing.length) throw new Error(`required cases not recorded: ${missing.join(", ")}`);
  ev.complete = true;
  ctx.save();
}

/** The fresh audit (separate connection, after cleanup): declared and owned differences only; plus the explicit final intended state. */
export async function auditRuntime(fresh: Db, ctx: Pick<RuntimeCtx, "state">, own: RuntimeOwnership, ev: RuntimeEvidence): Promise<{ problems: string[]; finalState: Record<string, unknown> }> {
  if (!ev.before || !ev.stableBefore || !own.startedAt) throw new Error("no starting baseline was taken, so nothing can be compared");
  const seqs = (await fresh.query("select generation_seq::text as s from reporting_private.generations where generation_id = any($1::uuid[])", [own.generations])).rows.map((r) => String(r.s));
  const after = await ctx.state(fresh);
  const ownership = (await fresh.query(OWNERSHIP_SQL, ownershipParams(own, seqs))).rows[0].j as Record<string, unknown>;
  const problems = runtimeAuditProblems(own, { before: ev.before, after, stableBefore: ev.stableBefore, stableAfter: await stableHashes(fresh, own), ownership });
  const retained = (await fresh.query(RETAINED_SQL, [own.site, own.generations, own.batches, own.baselineMaxChangeId, own.fixtureIds, own.startedAt])).rows[0].j;
  return { problems, finalState: { control: after.control, site: after.siteState.find((s) => s.site === own.site) ?? null, retained, allowance: runtimeAllowance(own) } };
}
const RETAINED_SQL = `select json_build_object(
  'generations', (select count(*) from reporting_private.generations where site = $1 and generation_id = any($2::uuid[])),
  'batches', (select count(*) from reporting_private.batches where site = $1 and batch_id = any($3::uuid[])),
  'mirrorRows', (select count(*) from reporting_private.source_current where site = $1),
  'fixtureJournalRows', (select count(*) from reporting_private.changes where change_id > $4::bigint and (old_event_id = any($5::text[]) or new_event_id = any($5::text[]))),
  'runLogRows', (select count(*) from reporting_private.worker_runs where site = $1 and started_at >= $6::timestamptz)) as j`;

/**
 * ALWAYS runs after the scenarios (success or failure); each step independent,
 * every failure kept. Order: (1) abandon this run's live batch after a real
 * lease expiry, (2) capture back to its starting state, (3) delete exactly this
 * run's fixture ids (only with capture back off: no unowned journal row),
 * (4) the site's processor/read mode back. Nothing the run does not own is
 * touched; before the first commit it does nothing.
 */
export async function cleanupRuntime(ctx: RuntimeCtx, own: RuntimeOwnership, failures: string[]): Promise<void> {
  ctx.enterCleanup?.();
  if (!own.committedAnything || !own.original) return;
  const orig = own.original;
  const stepDo = async (label: string, fn: () => Promise<void>) => {
    try {
      await ctx.hooks?.beforeCleanupStep?.(label);
      await fn();
    } catch (e) {
      failures.push(`${label}: ${ctx.redact(e instanceof Error ? e.message : String(e))}`);
    }
    try {
      ctx.save();
    } catch (e) {
      failures.push(`report save after ${label}: ${ctx.redact(e instanceof Error ? e.message : String(e))}`);
    }
  };
  await stepDo("abandon this run's active batch", async () => {
    const st = await withConn(ctx, async (c) => (await c.query(SITE_ROW_SQL, [own.site])).rows[0]);
    const b = st?.active_batch_id == null ? null : String(st.active_batch_id);
    if (!b) return;
    if (!own.batches.includes(b)) throw new Error(`the active batch ${b} is not this run's; retained`);
    await ctx.awaitLeaseExpiry(own.site);
    // 0038: only an EXPIRED (or invalidated) batch may be abandoned, so no resume (it would renew the lease).
    // The worker's typed helper sends the exact RPC arguments; evidence and pending journal are kept.
    await withConn(ctx, (c) => abandonReportingBatch(ctx.rpcClient(c), b, Number(st.lease_fence), "staging worker harness cleanup"));
  });
  await stepDo("return capture to its starting state", async () => {
    const on = await withConn(ctx, async (c) => Boolean((await c.query("select capture_enabled from reporting_private.control where singleton")).rows[0].capture_enabled));
    if (on !== orig.captureEnabled) await ctx.toggle(orig.captureEnabled, true);
  });
  await stepDo("delete this run's fixture source rows (exact ids)", async () => {
    if (!own.fixturesInserted) return;
    await withConn(ctx, async (c) => {
      const on = Boolean((await c.query("select capture_enabled from reporting_private.control where singleton")).rows[0].capture_enabled);
      if (on && !orig.captureEnabled) throw new Error("capture is still enabled; fixtures are kept so no unowned journal row is created");
      await c.query("delete from public.production_events where location = $1 and id = any($2::text[])", [own.site, own.fixtureIds]);
    });
  });
  await stepDo("return the site's processor and read mode", async () => {
    if (!own.processorChanged) return;
    await serviceCall(ctx, "set_reporting_site_mode", { p_site: own.site, p_read_mode: orig.readMode, p_processor_enabled: orig.processor });
  });
}
