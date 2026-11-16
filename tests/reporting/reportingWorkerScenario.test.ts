/**
 * Task 15 runtime gate scenarios over the REAL 0037-0044 SQL in PGlite
 * (offline). The lease-expiry wait is shimmed HERE ONLY by expiring the lease
 * row (the hosted runner waits for real and never edits a lease); everything
 * else is the real worker, real RPCs and real SQL.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { serviceRpcClient } from "../staging/serviceRpc";
import type { Observation } from "../staging/reportingPublication";
import { INSTALLED_HISTORY } from "../staging/reportingWorkerHarness";
import { newRuntimeOwnership, type RuntimeOwnership } from "../staging/reportingWorkerRuntime";
import { auditRuntime, cleanupRuntime, newRuntimeEvidence, preflightRuntime, REQUIRED_RUNTIME_CASES, runWorkerRuntime, scenarioRebuild, type RuntimeCtx, type RuntimeEvidence } from "../staging/reportingWorkerScenario";
import { reportingDb } from "./pg/harness";
import { pgDb, seedClustered, smallState, W1 } from "./pg/runtimeFixtures";

const HISTORY = [...INSTALLED_HISTORY.map((h) => ({ ...h })), { version: "20261117000000", name: "0043_reporting_worker_state" }];

export function pgCtx(db: PGlite, own: RuntimeOwnership, over: Partial<RuntimeCtx> = {}) {
  const observations: Observation[] = [];
  const saves = { n: 0 };
  const conn = () => ({ ...pgDb(db), end: async () => undefined });
  const ctx: RuntimeCtx = {
    site: own.site, staff: W1,
    open: async () => conn(),
    rpcClient: (c, opts) => serviceRpcClient(c, opts),
    asRole: async (c, role) => {
      await c.query("reset role");
      if (role !== "postgres") await c.query(`set local role ${role}`);
    },
    toggle: async (enabled) => {
      const epoch = async () => String((await db.query<{ e: string }>("select capture_epoch::text as e from reporting_private.control")).rows[0].e);
      const before = await epoch();
      const r = await serviceRpcClient(pgDb(db)).rpc("set_reporting_capture", { p_enabled: enabled });
      if (r.error) throw new Error(r.error.message);
      const after = await epoch();
      own.captureTransitions.push({ enable: enabled, before, after, state: "confirmed" });
      return Number(after);
    },
    history: async () => HISTORY,
    state: (c) => smallState(c),
    awaitLeaseExpiry: async (site) => {
      await db.query("update reporting_private.batches set lease_expires_at = now() - interval '1 second' where site = $1 and state in ('active', 'frozen', 'publishing')", [site]);
      await db.query("update reporting_private.site_state set lease_expires_at = now() - interval '1 second' where site = $1 and active_batch_id is not null", [site]);
      return 0;
    },
    record: (o) => observations.push(o),
    save: () => void saves.n++,
    redact: (s) => s.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[jwt]").replace(/postgres(ql)?:\/\/\S+/g, "[url]"),
    now: () => Date.now(),
    sleep: async () => undefined,
    limits: { paceCalls: 3, maxInvocations: 30 },
    ...over,
  };
  return { ctx, observations, saves };
}

describe("runtime gate: preflight, R1-R4 and cleanup (PGlite, real SQL)", () => {
  let db: PGlite;
  let own: RuntimeOwnership;
  let ev: RuntimeEvidence;
  beforeEach(async () => {
    db = await reportingDb();
    // Two 1,000-row copy pages (the minimum for a continuation), orders clustered in time as in real data.
    await seedClustered(db, 1100);
    own = newRuntimeOwnership("uk", "0a1b2c3d");
    ev = newRuntimeEvidence();
  }, 120_000);
  afterEach(async () => db?.close());

  it("R0-R4 then cleanup: continuation, busy, takeover with a newer fence, lost publish replayed, old fence refused, exact parity; settings restored", async () => {
    const { ctx, observations } = pgCtx(db, own);
    await preflightRuntime(pgDb(db), ctx, own, ev);
    await scenarioRebuild(pgDb(db), ctx, own, ev);
    expect(observations.filter((o) => !o.ok)).toEqual([]);
    expect(ev.recorded).toEqual(["R0", "R0b", "R1", "R2", "R3a", "R3b", "R3c", "R3d", "R4"]);
    expect(own.invocations.map((i) => i.state)).toEqual(["failed", "failed", "pending", "busy", "published"]);
    expect(own.invocations[2].counts.copiedPages).toBe(1);
    expect(own.invocations[4].counts.copiedPages).toBe(1); // resumed from the saved cursor: never recopied
    expect(own.invocations[4].injected).toEqual([{ fn: "publish_reporting_batch", n: 1, fault: "lost-after-commit" }]);
    expect(own.batches).toHaveLength(1);
    expect(own.generations).toHaveLength(1);
    const failures: string[] = [];
    await cleanupRuntime(ctx, own, failures);
    expect(failures).toEqual([]);
    const s = (await db.query<{ p: boolean; m: string; c: boolean }>("select s.processor_enabled as p, s.read_mode as m, (select capture_enabled from reporting_private.control) as c from reporting_private.site_state s where site = 'uk'")).rows[0];
    expect(s).toEqual({ p: false, m: "legacy", c: false });
  }, 180_000);
  it("preflight refuses before any write: processor already on, fixture collision, drift", async () => {
    const write = async () => (await db.query<{ n: number }>("select count(*)::int as n from reporting_private.worker_runs")).rows[0].n;
    await serviceRpcClient(pgDb(db)).rpc("set_reporting_site_mode", { p_site: "uk", p_read_mode: null, p_processor_enabled: true });
    await expect(preflightRuntime(pgDb(db), pgCtx(db, own).ctx, own, ev)).rejects.toThrow(/R0 failed/);
    await serviceRpcClient(pgDb(db)).rpc("set_reporting_site_mode", { p_site: "uk", p_read_mode: null, p_processor_enabled: false });
    await db.query("insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note) values ('uk', $1, $2, 'framed', 'X', 'S', 1, 'line_verified', 's', '')", [`${own.prefix}v1`, W1]);
    const collide = pgCtx(db, own);
    await expect(preflightRuntime(pgDb(db), collide.ctx, own, newRuntimeEvidence())).rejects.toThrow(/R0 failed/);
    expect(collide.observations[0].result).toMatch(/fixture prefix/);
    await db.query("delete from public.production_events where id = $1", [`${own.prefix}v1`]);
    let n = 0;
    const drift = pgCtx(db, own, { state: async (c) => { const s = await smallState(c); if (n++ === 1) s.surfaces["source:production_events"] = "drifted"; return s; } });
    await expect(preflightRuntime(pgDb(db), drift.ctx, own, newRuntimeEvidence())).rejects.toThrow(/R0b failed/);
    expect(own.committedAnything).toBe(false);
    const failures: string[] = [];
    await cleanupRuntime(drift.ctx, own, failures); // nothing committed: cleanup does nothing
    expect(failures).toEqual([]);
    expect(await write()).toBe(0);
  }, 120_000);
  it("an injected worker failure mid-run stops the scenario; cleanup abandons the owned batch and restores capture and the processor", async () => {
    const { ctx, observations } = pgCtx(db, own, {
      rpcClient: (c, opts) => serviceRpcClient(c, { fault: (fn, n) => (fn === "copy_reporting_source_page" && n === 1 && own.invocations.length >= 4 ? "fail-before" : opts?.fault?.(fn, n) ?? null) }),
    });
    // a non-transient failure: make the R3c takeover's first copy fail permanently
    const failing: RuntimeCtx = { ...ctx, rpcClient: (c, opts) => { const inner = serviceRpcClient(c, opts); return { ...inner, rpc: async (fn, args) => (fn === "freeze_reporting_rebuild" ? { data: null, error: { message: "injected permanent failure", code: "P0001" } } : inner.rpc(fn, args)) }; } };
    await preflightRuntime(pgDb(db), failing, own, ev);
    await expect(scenarioRebuild(pgDb(db), failing, own, ev)).rejects.toThrow(/R3c failed/);
    expect(observations.at(-1)).toMatchObject({ id: "R3c", ok: false });
    const failures: string[] = [];
    await cleanupRuntime(ctx, own, failures);
    expect(failures).toEqual([]);
    const s = (await db.query<{ a: string | null; p: boolean; c: boolean; st: string }>("select s.active_batch_id::text as a, s.processor_enabled as p, (select capture_enabled from reporting_private.control) as c, (select state from reporting_private.batches b where b.batch_id = $1) as st from reporting_private.site_state s where site = 'uk'", [own.batches[0]])).rows[0];
    expect(s).toMatchObject({ a: null, p: false, c: false });
    expect(s.st).not.toMatch(/active|frozen|publishing/);
  }, 180_000);
  it("cleanup keeps going after a failing step and reports it", async () => {
    const { ctx } = pgCtx(db, own, { hooks: { beforeCleanupStep: async (l) => { if (/capture/.test(l)) throw new Error("injected cleanup failure"); } } });
    await preflightRuntime(pgDb(db), ctx, own, ev);
    await scenarioRebuild(pgDb(db), ctx, own, ev);
    const failures: string[] = [];
    await cleanupRuntime(ctx, own, failures);
    expect(failures).toEqual(["return capture to its starting state: injected cleanup failure"]);
    expect((await db.query<{ p: boolean }>("select processor_enabled as p from reporting_private.site_state where site = 'uk'")).rows[0].p).toBe(false); // the later step still ran
  }, 180_000);
});

describe("runtime gate end to end: R0-R7, cleanup, fresh audit (PGlite, real SQL)", () => {
  let db: PGlite;
  let own: RuntimeOwnership;
  let ev: RuntimeEvidence;
  beforeEach(async () => {
    db = await reportingDb();
    await seedClustered(db, 1100);
    own = newRuntimeOwnership("uk", "0a1b2c3d");
    ev = newRuntimeEvidence();
  }, 120_000);
  afterEach(async () => db?.close());

  it("COMPLETE: every case recorded; cleanup clean; the fresh audit finds only declared, owned changes; final state explicit", async () => {
    const { ctx, observations } = pgCtx(db, own);
    await runWorkerRuntime(pgDb(db), ctx, own, ev);
    expect(observations.filter((o) => !o.ok)).toEqual([]);
    expect(ev.complete).toBe(true);
    expect(ev.recorded).toEqual([...REQUIRED_RUNTIME_CASES]);
    const r7 = observations.filter((o) => /^R7[ab]$/.test(o.id)).map((o) => o.result);
    expect(r7.every((x) => !/^published/.test(x))).toBe(true);
    expect(own.generations).toHaveLength(3); // rebuild, refresh, recovery rebuild
    const failures: string[] = [];
    await cleanupRuntime(ctx, own, failures);
    expect(failures).toEqual([]);
    const a = await auditRuntime(pgDb(db), ctx, own, ev);
    expect(a.problems).toEqual([]);
    expect(a.finalState.control).toMatchObject({ capture_enabled: false });
    expect(a.finalState.site).toMatchObject({ processor_enabled: false, read_mode: "legacy", active_batch_id: null, active_generation_id: own.generations[2] });
    expect(a.finalState.retained).toMatchObject({ generations: 3, fixtureJournalRows: 5, runLogRows: own.invocations.length });
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.production_events where id like $1", [`${own.prefix}%`])).rows[0].n).toBe(0);
    expect(r7).toEqual(["failed/capture_disabled", "failed/rebuild_required"]);
  }, 240_000);
  it("the fresh audit reports a change the run does not own (another site) and a fixture left behind", async () => {
    const { ctx } = pgCtx(db, own, { hooks: { beforeCleanupStep: async (l) => { if (/fixture/.test(l)) throw new Error("injected: fixture deletion failed"); } } });
    await runWorkerRuntime(pgDb(db), ctx, own, ev);
    const failures: string[] = [];
    await cleanupRuntime(ctx, own, failures);
    expect(failures).toEqual(["delete this run's fixture source rows (exact ids): injected: fixture deletion failed"]);
    await db.query("update reporting_private.site_state set processor_enabled = true where site = 'us'");
    const a = await auditRuntime(pgDb(db), ctx, own, ev);
    const p = a.problems.join("\n");
    expect(p).toMatch(/source:production_events differs/);
    expect(p).toMatch(/site_state us\.processor_enabled is true, was false/);
  }, 240_000);
  it("redaction: a worker failure carrying a token and a connection string is recorded redacted (invocation and observation)", async () => {
    const leak = "fetch failed: postgresql://postgres:hunter2@db.x/y Bearer eyJhbGc.eyJzdWI.c2ln";
    const { ctx, observations } = pgCtx(db, own, {
      rpcClient: (c, opts) => { const inner = serviceRpcClient(c, opts); return { ...inner, rpc: async (fn, args) => (fn === "get_reporting_job_status" ? { data: null, error: { message: leak, code: "P0001" } } : inner.rpc(fn, args)) }; },
    });
    await preflightRuntime(pgDb(db), ctx, own, ev);
    await expect(scenarioRebuild(pgDb(db), ctx, own, ev)).rejects.toThrow(/R1 failed/);
    const text = JSON.stringify({ observations, invocations: own.invocations });
    expect(text).not.toMatch(/hunter2|eyJhbGc/);
    expect(own.invocations[0].problems.join(" ")).toMatch(/\[url\]|\[jwt\]|redacted/);
  }, 60_000);
  it("an audit without a baseline refuses instead of passing", async () => {
    await expect(auditRuntime(pgDb(db), pgCtx(db, own).ctx, own, ev)).rejects.toThrow(/no starting baseline/);
  });
});
