/**
 * The Task 15 harness's direct-pg service RpcClient, over the REAL 0037-0044
 * SQL in PGlite: PostgREST-shaped calls as service_role, one transaction per
 * call, faults (lost response after commit, failure before send), and the real
 * worker driven through it. Offline proof of the client only; hosted runtime
 * evidence is root's step.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runReportingCycle } from "../../api/_lib/production-reporting-worker";
import { FAILED_BEFORE, LOST_RESPONSE, serviceRpcClient, type SqlConn } from "../staging/serviceRpc";
import { reportingDb } from "./pg/harness";
import { seedClustered } from "./pg/runtimeFixtures";

const conn = (db: PGlite, log: string[] = []): SqlConn => ({ query: async (sql, params) => { log.push(sql); return { rows: (await db.query<Record<string, unknown>>(sql, params as unknown[])).rows }; } });

describe("serviceRpcClient over the real reporting SQL (PGlite)", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await reportingDb();
    await seedClustered(db, 1200); // orders clustered in time (a spread-out seed makes every order walk the whole stream)
  }, 120_000);
  afterAll(async () => db?.close());

  it("one transaction per call as service_role with request claims; named, typed args; set and scalar shapes", async () => {
    const log: string[] = [];
    const c = serviceRpcClient(conn(db, log));
    const r = await c.rpc("set_reporting_capture", { p_enabled: true });
    expect(r.error).toBeNull();
    expect(r.data).toEqual([expect.objectContaining({ capture_enabled: true })]);
    expect(log.filter((s) => s === "begin")).toHaveLength(1);
    expect(log.filter((s) => s === "commit")).toHaveLength(1);
    expect(log).toContain("set local role service_role");
    expect(log.some((s) => /request\.jwt\.claims/.test(s))).toBe(true);
    expect(log.some((s) => /statement_timeout|lock_timeout/.test(s))).toBe(false); // nothing invented; PGlite has no service_role setting
    expect(await c.roleSettings()).toEqual([]);
    expect((await c.rpc("set_reporting_site_mode", { p_site: "uk", p_read_mode: null, p_processor_enabled: true })).error).toBeNull();
    // the session is back to its own role and outside any transaction
    expect((await db.query<{ u: string }>("select current_user as u")).rows[0].u).not.toBe("service_role");
  });
  it("errors are returned (never thrown), rolled back, with the SQLSTATE; unknown arguments are refused before sending", async () => {
    const log: string[] = [];
    const c = serviceRpcClient(conn(db, log));
    const bad = await c.rpc("set_reporting_site_mode", { p_site: "uk", p_read_mode: null, p_processor_enabled: null });
    expect(bad.error?.message).toMatch(/nothing to change/);
    expect(log).toContain("rollback");
    expect(log).not.toContain("commit");
    const unknown = await c.rpc("set_reporting_site_mode", { p_site: "uk", p_whatever: 1 });
    expect(unknown.error).toMatchObject({ code: "PGRST202" });
    expect((await c.rpc("no_such_function", {})).error?.code).toBe("PGRST202");
  });
  it("a client role is refused like the gateway would (permission denied on a service-only function)", async () => {
    await db.exec("begin; set local role authenticated");
    await expect(db.query("select * from public.get_reporting_job_status('uk')")).rejects.toThrow(/permission denied/);
    await db.exec("rollback");
  });
  it("drives the REAL worker: a rebuild publishes; a lost publish response is retried as a replay of the SAME generation", async () => {
    const c = serviceRpcClient(conn(db), { fault: (fn, n) => (fn === "publish_reporting_batch" && n === 1 ? "lost-after-commit" : null) });
    const r = await runReportingCycle({ client: c, now: () => Date.now(), sleep: async () => undefined }, { site: "uk", mode: "rebuild" });
    expect(r.problems).toEqual([]);
    expect(r.state).toBe("published");
    expect(c.injected).toEqual([{ fn: "publish_reporting_batch", n: 1, fault: "lost-after-commit" }]);
    expect(c.calls.filter((f) => f === "publish_reporting_batch")).toHaveLength(2);
    const g = await db.query<{ n: number; id: string }>("select count(*)::int as n, max(generation_id::text) as id from reporting_private.generations where site = 'uk'");
    expect(g.rows[0]).toEqual({ n: 1, id: r.generationId });
    expect((await db.query<{ n: number }>("select count(*)::int as n from reporting_private.worker_runs where site = 'uk' and outcome = 'published'")).rows[0].n).toBe(1);
  }, 120_000);
  it("a failure before send is transient: nothing is executed and the worker defers or retries", async () => {
    const log: string[] = [];
    const c = serviceRpcClient(conn(db, log), { fault: (fn) => (fn === "get_reporting_job_status" ? "fail-before" : null) });
    const r = await c.rpc("get_reporting_job_status", { p_site: "uk" });
    expect(r.error).toEqual({ message: FAILED_BEFORE, code: "08006" });
    expect(log).toEqual([]);
    expect(LOST_RESPONSE).toMatch(/^fetch failed/); // classified transient by the worker
  });
});
