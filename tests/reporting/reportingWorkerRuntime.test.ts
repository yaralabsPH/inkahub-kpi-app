/**
 * Task 15 runtime harness (offline): ownership, scoped audit, parity and (later
 * in this file) the scenario driver, over the REAL 0037-0044 SQL in PGlite.
 * Hosted runtime evidence is root's step; nothing here stands in for it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runReportingCycle } from "../../api/_lib/production-reporting-worker";
import { serviceRpcClient } from "../staging/serviceRpc";
import type { FullState } from "../staging/reportingPublication";
import {
  newRuntimeOwnership, OWNERSHIP_SQL, ownershipParams, parityProblems, PRIVATE_TABLES_SQL, runtimeAuditProblems, SITE_ATTRIBUTION, stableHashes, type RuntimeOwnership,
} from "../staging/reportingWorkerRuntime";
import { reportingDb } from "./pg/harness";
import { pgDb, seedClustered, smallState, W1 } from "./pg/runtimeFixtures";

describe("runtime ownership, scoped audit and parity (pure + real SQL)", () => {
  let db: PGlite;
  let own: RuntimeOwnership;
  let before: FullState;
  let stableBefore: Record<string, string>;
  beforeAll(async () => {
    db = await reportingDb();
    await seedClustered(db, 1500);
    own = newRuntimeOwnership("uk", "0a1b2c3d");
    own.startedAt = String((await db.query<{ t: string }>("select now()::text as t")).rows[0].t);
    before = await smallState(pgDb(db));
    stableBefore = await stableHashes(pgDb(db), own);
    const c = serviceRpcClient(pgDb(db));
    // receipts as the runner's owned toggle records them: the epoch before and after each committed transition
    const toggle = async (enable: boolean) => {
      const b = String((await db.query<{ e: string }>("select capture_epoch::text as e from reporting_private.control")).rows[0].e);
      expect((await c.rpc("set_reporting_capture", { p_enabled: enable })).error).toBeNull();
      const a = String((await db.query<{ e: string }>("select capture_epoch::text as e from reporting_private.control")).rows[0].e);
      own.captureTransitions.push({ enable, before: b, after: a, state: "confirmed" });
    };
    await toggle(true);
    expect((await c.rpc("set_reporting_site_mode", { p_site: "uk", p_read_mode: null, p_processor_enabled: true })).error).toBeNull();
    const r = await runReportingCycle({ client: c, now: () => Date.now(), sleep: async () => undefined }, { site: "uk", mode: "rebuild" });
    expect(r.state).toBe("published");
    own.batches.push(r.batchId!);
    own.generations.push(r.generationId!);
    own.invocations.push({ n: 1, label: "t", mode: "rebuild", paced: null, state: r.state, batchId: r.batchId, generationId: r.generationId, failureKind: null, problems: [], counts: {}, calls: 0, injected: [], fenceAfter: null });
    await toggle(false);
    expect(own.captureTransitions.map((t) => Number(t.after) - Number(t.before))).toEqual([1, 1]); // each toggle advances the epoch
    expect((await c.rpc("set_reporting_site_mode", { p_site: "uk", p_read_mode: null, p_processor_enabled: false })).error).toBeNull();
  }, 120_000);
  afterAll(async () => db?.close());

  const audit = async (o: RuntimeOwnership) => {
    const seqs = (await db.query<{ s: string }>("select generation_seq::text as s from reporting_private.generations where generation_id = any($1::uuid[])", [o.generations])).rows.map((x) => x.s);
    return runtimeAuditProblems(o, {
      before, after: await smallState(pgDb(db)), stableBefore, stableAfter: await stableHashes(pgDb(db), o),
      ownership: (await db.query<{ j: Record<string, unknown> }>(OWNERSHIP_SQL, ownershipParams(o, seqs))).rows[0].j,
    });
  };

  it("every reporting_private table is attributed (none silently compared in full by omission)", async () => {
    const tables = (await db.query<{ t: string }>(PRIVATE_TABLES_SQL)).rows.map((r) => r.t);
    expect(tables.filter((t) => !(t in SITE_ATTRIBUTION))).toEqual([]);
  });
  it("parity: the published mirror is the source and daily totals equal the reducer (site and self)", async () => {
    expect(await parityProblems(pgDb(db), "uk", W1)).toEqual([]);
  });
  it("parity fails on a source change after publication", async () => {
    await db.exec("begin");
    try {
      await db.query("update public.production_events set note = 'drift' where location = 'uk' and id = 'k00001'");
      expect((await parityProblems(pgDb(db), "uk", null))[0]).toMatch(/mirror differs from the source \(1 source rows not mirrored, 1 mirror rows/);
    } finally {
      await db.exec("rollback");
    }
  });
  it("the audit accepts exactly the declared, owned changes", async () => {
    expect(await audit(own)).toEqual([]);
  });
  it("the audit names an unowned generation/batch, a missing run log row, a wrong epoch and another site's change", async () => {
    const lost = { ...own, generations: [], batches: [] };
    const p = (await audit(lost)).join("\n");
    expect(p).toMatch(/generations? row\(s\) at uk do not belong to this run/);
    expect(p).toMatch(/batches row\(s\) at uk do not belong/);
    expect(p).toMatch(/mirror row\(s\) at uk do not belong/);
    expect((await audit({ ...own, invocations: [] })).join("\n")).toMatch(/run log rows at uk since the start: 1, expected exactly 0/);
    expect((await audit({ ...own, captureTransitions: [] })).join("\n")).toMatch(/capture_epoch is \d+, expected exactly \d+ \(\d+ \+ 0\)/);
    await db.exec("begin");
    try {
      await db.query("update reporting_private.site_state set processor_enabled = true where site = 'us'");
      expect((await audit(own)).join("\n")).toMatch(/site_state us\.processor_enabled is true, was false/);
    } finally {
      await db.exec("rollback");
    }
  });
});
