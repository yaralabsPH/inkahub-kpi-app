/**
 * Task 15 recovery of an interrupted --worker-runtime run, over the REAL
 * 0037-0044 SQL in PGlite (offline). The interrupted run is reproduced with
 * the real driver: preflight, R1, R2, the paced R3a rebuild leaves a live
 * owned batch, then the driver "terminates". The lease expiry is shimmed HERE
 * ONLY; the recovery itself never edits, resumes or renews a lease.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { newWorkerReport, workerMarkdown } from "../staging/reportingWorkerHarness";
import { newRuntimeOwnership, type RuntimeOwnership } from "../staging/reportingWorkerRuntime";
import { auditRuntime, newRuntimeEvidence, preflightRuntime, scenarioRebuild, type RuntimeEvidence } from "../staging/reportingWorkerScenario";
import { parseRunReport, recoverWorkerRun, recoveryRefusals, runLeftCaptureOn, type RecoveryState } from "../staging/reportingWorkerRecovery";
import { reportingDb } from "./pg/harness";
import { pgDb, seedClustered } from "./pg/runtimeFixtures";
import { pgCtx } from "./pg/runtimeCtx";

const reportOf = (own: RuntimeOwnership, ev: RuntimeEvidence) => {
  const r = newWorkerReport("worker-runtime", own.site, "abc", "t", "x");
  r.ownership = own as unknown as Record<string, unknown>;
  r.evidence = ev as unknown as Record<string, unknown>;
  return workerMarkdown(r);
};
const expireLease = (db: PGlite) => pgCtx(db, newRuntimeOwnership("uk", "00000000")).ctx.awaitLeaseExpiry("uk");

/** The real driver up to a live owned batch (R3a pending), then terminated. */
async function interrupted(db: PGlite) {
  const own = newRuntimeOwnership("uk", "0a1b2c3d");
  const ev = newRuntimeEvidence();
  const { ctx } = pgCtx(db, own, { hooks: { afterStep: async (id) => { if (id === "R3a") throw new Error("driver terminated"); } } });
  await preflightRuntime(pgDb(db), ctx, own, ev);
  await expect(scenarioRebuild(pgDb(db), ctx, own, ev)).rejects.toThrow(/R3a failed/); // the driver "terminates" right after R3a
  expect(own.batches).toHaveLength(1);
  return { own, ev, md: reportOf(own, ev) };
}

describe("recovery: pure refusals", () => {
  const own = (): RuntimeOwnership => ({ ...newRuntimeOwnership("uk", "0a1b2c3d"), startedAt: "2026-11-17 00:00:00+00", committedAnything: true, batches: ["11111111-1111-4111-8111-111111111111"], fixtureIds: ["rw-0a1b2c3d-v1", "rw-0a1b2c3d-v2", "rw-0a1b2c3d-c1"], original: { captureEnabled: false, captureEpoch: "19", processor: false, readMode: "legacy" } });
  const s = (o: Partial<RecoveryState> = {}): RecoveryState => ({ captureEnabled: false, captureEpoch: "20", activeBatch: "11111111-1111-4111-8111-111111111111", leaseFence: "2", leaseLive: false, liveBatches: [], siteBatches: ["11111111-1111-4111-8111-111111111111"], siteGenerations: [], prefixRows: [], prefixElsewhere: 0, ...o });
  it("accepts exactly the owned, expired state", () => expect(recoveryRefusals(own(), s())).toEqual([]));
  it("refuses a foreign active batch, a live lease, foreign batches/generations, foreign prefix rows and unexplained capture", () => {
    expect(recoveryRefusals(own(), s({ activeBatch: "22222222-2222-4222-8222-222222222222" })).join(";")).toMatch(/is not this run's/);
    expect(recoveryRefusals(own(), s({ leaseLive: true })).join(";")).toMatch(/lease is still live/);
    expect(recoveryRefusals(own(), s({ liveBatches: ["x"] })).join(";")).toMatch(/still holds a live lease/);
    expect(recoveryRefusals(own(), s({ siteBatches: ["11111111-1111-4111-8111-111111111111", "b2"] })).join(";")).toMatch(/\[b2\].*not this run's/);
    expect(recoveryRefusals(own(), s({ siteGenerations: ["g9"] })).join(";")).toMatch(/generations \[g9\]/);
    expect(recoveryRefusals(own(), s({ prefixRows: ["rw-0a1b2c3d-zz"] })).join(";")).toMatch(/not its fixture ids/);
    expect(recoveryRefusals(own(), s({ prefixElsewhere: 1 })).join(";")).toMatch(/another site/);
    expect(recoveryRefusals(own(), s({ captureEnabled: true })).join(";")).toMatch(/did not leave it on/);
    const on = { ...own(), captureTransitions: [{ enable: true, before: "19", after: "20", state: "confirmed" as const }] };
    expect(runLeftCaptureOn(on)).toBe(true);
    expect(recoveryRefusals(on, s({ captureEnabled: true }))).toEqual([]);
    expect(runLeftCaptureOn({ ...on, captureTransitions: [...on.captureTransitions, { enable: false, before: "20", after: "21", state: "uncertain" as const }] })).toBe(false);
  });
  it("refuses a report that is not this run's: wrong mode, wrong site, tampered prefix or fixtures, no baseline, never committed", () => {
    const ev = { ...newRuntimeEvidence(), before: { surfaces: {}, privateTables: {}, control: null, siteState: [] }, stableBefore: {} };
    const good = reportOf(own(), ev);
    expect(parseRunReport(good, "uk").own.runId).toBe("0a1b2c3d");
    expect(() => parseRunReport(good, "us")).toThrow(/is for site uk, not us/);
    expect(() => parseRunReport(good.replace("(worker-runtime)", "(rehearse-worker-state)"), "uk")).toThrow(/not a --worker-runtime report/);
    expect(() => parseRunReport(reportOf({ ...own(), prefix: "rw-ffffffff-" }, ev), "uk")).toThrow(/fixture prefix/);
    expect(() => parseRunReport(reportOf({ ...own(), fixtureIds: ["rw-0a1b2c3d-v1"] }, ev), "uk")).toThrow(/fixture ids are not exactly/);
    expect(() => parseRunReport(reportOf(own(), newRuntimeEvidence()), "uk")).toThrow(/no starting baseline/);
    expect(() => parseRunReport(reportOf({ ...own(), committedAnything: false }, ev), "uk")).toThrow(/nothing to recover/);
    expect(() => parseRunReport("# something else", "uk")).toThrow(/refusing to recover/);
  });
});

describe("recovery of a really interrupted run (PGlite, real SQL)", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await reportingDb();
    await seedClustered(db, 1100);
  }, 120_000);
  afterEach(async () => db?.close());

  it("refuses while the lease is live, writing nothing; after expiry: abandons the owned batch with its current fence, restores, and the fresh audit is clean", async () => {
    const { md } = await interrupted(db);
    const run = parseRunReport(md, "uk");
    const live = pgCtx(db, run.own);
    const writes = async () => (await db.query<{ e: string; a: string | null }>("select (select capture_epoch::text from reporting_private.control) as e, (select active_batch_id::text from reporting_private.site_state where site = 'uk') as a")).rows[0];
    const before = await writes();
    await expect(recoverWorkerRun(pgDb(db), live.ctx, run, [])).rejects.toThrow(/X1 failed/);
    expect(live.observations.find((o) => o.id === "X1")?.result).toMatch(/lease is still live/);
    expect(await writes()).toEqual(before);
    await expireLease(db);
    const run2 = parseRunReport(md, "uk");
    const { ctx, observations } = pgCtx(db, run2.own);
    const calls: string[] = [];
    const spy = { ...ctx, rpcClient: (c: Parameters<typeof ctx.rpcClient>[0], o?: Parameters<typeof ctx.rpcClient>[1]) => { const inner = ctx.rpcClient(c, o); return { ...inner, rpc: (fn: string, a: Record<string, unknown>) => { calls.push(fn); return inner.rpc(fn, a); } }; } };
    const failures: string[] = [];
    await recoverWorkerRun(pgDb(db), spy, run2, failures);
    expect(failures).toEqual([]);
    expect(observations.map((o) => `${o.id}:${o.ok}`)).toEqual(["X0:true", "X1:true", "X2:true", "X3:true", "X4:true", "X5:true"]);
    expect(calls).toContain("abandon_reporting_batch");
    expect(calls.some((f) => /resume_reporting_batch|renew_reporting_lease/.test(f))).toBe(false);
    const st = (await db.query<{ a: string | null; p: boolean; m: string; c: boolean; s: string }>("select s.active_batch_id::text as a, s.processor_enabled as p, s.read_mode as m, (select capture_enabled from reporting_private.control) as c, (select state from reporting_private.batches where batch_id = $1) as s from reporting_private.site_state s where site = 'uk'", [run2.own.batches[0]])).rows[0];
    expect(st).toMatchObject({ a: null, p: false, m: "legacy", c: false });
    expect(st.s).not.toMatch(/active|frozen|publishing/);
    const a = await auditRuntime(pgDb(db), ctx, run2.own, run2.ev);
    expect(a.problems).toEqual([]);
  }, 180_000);
  it("refuses a report whose ownership does not include the site's active batch (foreign batch), writing nothing", async () => {
    const { md } = await interrupted(db);
    await expireLease(db);
    const run = parseRunReport(md, "uk");
    run.own.batches = [];
    const { ctx, observations } = pgCtx(db, run.own);
    await expect(recoverWorkerRun(pgDb(db), ctx, run, [])).rejects.toThrow(/X1 failed/);
    expect(observations.find((o) => o.id === "X1")?.result).toMatch(/is not this run's/);
    expect((await db.query<{ c: boolean }>("select capture_enabled as c from reporting_private.control")).rows[0].c).toBe(true); // untouched
  }, 180_000);
  it("an injected failure in one step is kept and the later steps still run", async () => {
    const { md } = await interrupted(db);
    await expireLease(db);
    const run = parseRunReport(md, "uk");
    const { ctx } = pgCtx(db, run.own, { hooks: { beforeCleanupStep: async (id) => { if (id === "X2") throw new Error("injected: abandon failed"); } } });
    const failures: string[] = [];
    await recoverWorkerRun(pgDb(db), ctx, run, failures);
    expect(failures).toEqual(["X2 abandon ONLY the owned expired batch with its current fence (no resume or renew): injected: abandon failed"]);
    const st = (await db.query<{ p: boolean; c: boolean }>("select processor_enabled as p, (select capture_enabled from reporting_private.control) as c from reporting_private.site_state where site = 'uk'")).rows[0];
    expect(st).toEqual({ p: false, c: false });
    expect((await auditRuntime(pgDb(db), ctx, run.own, run.ev)).problems.join(";")).toMatch(/still has an active batch/);
  }, 180_000);
});
