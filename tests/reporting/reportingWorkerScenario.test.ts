/**
 * Task 15 runtime gate scenarios over the REAL 0037-0044 SQL in PGlite
 * (offline). The lease-expiry wait is shimmed HERE ONLY by expiring the lease
 * row (the hosted runner waits for real and never edits a lease); everything
 * else is the real worker, real RPCs and real SQL.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { serviceRpcClient } from "../staging/serviceRpc";
import { newRuntimeOwnership, type RuntimeOwnership } from "../staging/reportingWorkerRuntime";
import { auditRuntime, cleanupRuntime, newRuntimeEvidence, preflightRuntime, REQUIRED_RUNTIME_CASES, runWorkerRuntime, scenarioRebuild, type RuntimeCtx, type RuntimeEvidence } from "../staging/reportingWorkerScenario";
import { reportingDb } from "./pg/harness";
import { pgDb, seedClustered, smallState, W1 } from "./pg/runtimeFixtures";
import { pgCtx } from "./pg/runtimeCtx";

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
  it("R0 refuses an altered local 0046 or an authenticated grant on 0046 before any write", async () => {
    const write = async () => (await db.query<{ n: number }>("select count(*)::int as n from reporting_private.worker_runs")).rows[0].n;
    const altered = pgCtx(db, own, { read: (path: string) => readFileSync(path, "utf8") + (/0046_/.test(path) ? "\n-- edited" : "") });
    await expect(preflightRuntime(pgDb(db), altered.ctx, own, newRuntimeEvidence())).rejects.toThrow(/R0 failed/);
    expect(altered.observations[0].result).toMatch(/the local 0046 file is not the reviewed draft/);
    await db.query("grant execute on function public.reporting_owner_input_version() to authenticated");
    const granted = pgCtx(db, own);
    await expect(preflightRuntime(pgDb(db), granted.ctx, own, newRuntimeEvidence())).rejects.toThrow(/R0 failed/);
    expect(granted.observations[0].result).toMatch(/0046: public\.reporting_owner_input_version security differs/);
    await db.query("revoke execute on function public.reporting_owner_input_version() from authenticated");
    // a missing 0046 index (final review Should-fix 3: index validity is checked by R0 too)
    await db.query("drop index reporting_private.owner_input_pieces_pending");
    const noIndex = pgCtx(db, own);
    await expect(preflightRuntime(pgDb(db), noIndex.ctx, own, newRuntimeEvidence())).rejects.toThrow(/R0 failed/);
    expect(noIndex.observations[0].result).toMatch(/index reporting_private\.owner_input_pieces_pending found 0 times/);
    await db.query("create index owner_input_pieces_pending on reporting_private.owner_input_pieces (handle) where not committed");
    // an altered 0044 object: its absent receipt can then never be accepted
    await db.query("grant execute on function public.read_reporting_generation(text, uuid) to authenticated");
    const bad44 = pgCtx(db, own);
    await expect(preflightRuntime(pgDb(db), bad44.ctx, own, newRuntimeEvidence())).rejects.toThrow(/R0 failed/);
    expect(bad44.observations[0].result).toMatch(/0044: public\.read_reporting_generation security differs/);
    await db.query("revoke execute on function public.read_reporting_generation(text, uuid) from authenticated");
    expect(own.committedAnything).toBe(false);
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
  it("R6 cannot complete with a missing client identity, or with one that is allowed the 0046 protocol", async () => {
    const missing = pgCtx(db, own, { clientRoles: ["anon", "owner", "manager", "staff", "kiosk"] });
    await expect(runWorkerRuntime(pgDb(db), missing.ctx, own, ev)).rejects.toThrow(/R6 failed/);
    expect(missing.observations.find((o) => o.id === "R6")?.result).toMatch(/missing: cs/);
    await cleanupRuntime(missing.ctx, own, []);
  }, 240_000);
  it("R6 fails when a client identity is actually allowed (here kiosk runs with the owner's privileges)", async () => {
    const base = pgCtx(db, own);
    const allowed = pgCtx(db, own, { asRole: async (c, role) => (role === "kiosk" ? void (await c.query("reset role")) : base.ctx.asRole(c, role)) });
    await expect(runWorkerRuntime(pgDb(db), allowed.ctx, own, ev)).rejects.toThrow(/R6 failed/);
    expect(allowed.observations.find((o) => o.id === "R6")?.result).toMatch(/kiosk was allowed: select \* from public\.reporting_owner_input_version/);
    await cleanupRuntime(allowed.ctx, own, []);
  }, 240_000);
  it("the fresh audit fails on an owner-input journal tied to a batch this run does not own", async () => {
    const { ctx } = pgCtx(db, own);
    await runWorkerRuntime(pgDb(db), ctx, own, ev);
    await cleanupRuntime(ctx, own, []);
    // a journal of another (foreign) batch at the run site: a copy of this run's first batch under a new id, abandoned
    const foreign = "99999999-9999-4999-8999-999999999999";
    await db.query(`insert into reporting_private.batches select (jsonb_populate_record(null::reporting_private.batches, to_jsonb(b) || jsonb_build_object('batch_id', $1::text, 'state', 'abandoned', 'published_generation_id', null))).* from reporting_private.batches b where b.batch_id = $2::uuid`, [foreign, own.batches[0]]);
    await db.query(`insert into reporting_private.owner_inputs (batch_id, partition_kind, partition_key, site, source_cutoff, rule_version, purpose, state, last_writer_fence) values ($1, 'order', 'FOREIGN', 'uk', now(), 'x', 'plan', '{"v":1,"step":"members","m":{"afterOrd":null}}'::jsonb, 1)`, [foreign]);
    const a = await auditRuntime(pgDb(db), ctx, own, ev);
    expect(a.problems.join("\n")).toMatch(/1 ownerInputs row\(s\) at uk do not belong to this run/);
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
