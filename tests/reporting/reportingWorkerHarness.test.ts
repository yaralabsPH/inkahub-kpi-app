/**
 * Task 15 staging harness (offline): the 0043 rollback rehearsal core.
 * Real SQL in PGlite (migrations through 0042, i.e. the staging install
 * state); hosted execution is root's step and is never faked here.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { reportingDb } from "./pg/harness";
import { stagingTarget } from "../staging/reportingCapture";
import { CASE_SQL } from "../staging/reportingDependencyRehearsal";
import type { Db, Observation } from "../staging/reportingPublication";
import {
  dependencyIdentityProblems, historyProblems, INSTALLED_HISTORY, MIGRATION_0043, newWorkerReport, parseWorkerArgs, rehearseWorkerState, REVIEWED_0043_LF, sha256Lf, workerMarkdown, workerStatus,
  WORKER_CATALOG_SQL, workerCatalogParams, workerCatalogProblems, workerObjects, workerStateShapeProblems, type RehearseCtx, type WorkerCatalog,
} from "../staging/reportingWorkerHarness";

const read = (p: string) => readFileSync(p, "utf8");
const T43 = read(MIGRATION_0043);
const PRIOR = ["0037_reporting_storage", "0038_reporting_jobs", "0039_reporting_rebuild_insert", "0040_reporting_dependency_reads", "0041_reporting_dependency_read_bounds", "0042_reporting_access_paths"].map((f) => read(`supabase/migrations/${f}.sql`));
const HISTORY = INSTALLED_HISTORY.map((h) => ({ ...h }));

const pgDb = (db: PGlite): Db => ({ query: async (sql, params) => { const r = await db.query<Record<string, unknown>>(sql, params as unknown[]); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; } });
const asRole: RehearseCtx["asRole"] = async (c, role) => {
  await c.query("reset role");
  if (role !== "postgres") await c.query(`set local role ${role}`);
};
function ctxFor(over: Partial<RehearseCtx> = {}) {
  const observations: Observation[] = [];
  const ctx: RehearseCtx = { site: "uk", asRole, history: async () => HISTORY, record: (o) => observations.push(o), redact: (s) => s, now: () => performance.now(), ...over };
  return { ctx, observations };
}
const state = async (db: PGlite) => (await db.query<{ h: string }>(`select md5(coalesce((select string_agg(c.relname::text, ',' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'reporting_private'), '')
  || coalesce((select string_agg(p.proname::text || md5(p.prosrc), ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'reporting_private')), '')
  || coalesce((select string_agg(to_jsonb(s)::text, ',' order by s.site) from reporting_private.site_state s), '')) as h`)).rows[0].h;

describe("0043 identity and shape (pure)", () => {
  it("the pin is the current file; the shape is additive only", () => {
    expect(sha256Lf(T43)).toBe(REVIEWED_0043_LF);
    expect(workerStateShapeProblems(T43, PRIOR)).toEqual([]);
    const o = workerObjects(T43);
    expect(o.tables).toEqual(["worker_owners", "worker_progress", "worker_runs", "worker_seen", "worker_walk_line"]);
    expect(o.indexes).toEqual(["worker_owners_keyset", "worker_owners_unplanned", "worker_runs_site_time"]);
    expect(o.functions.map((f) => `${f.schema}.${f.name}`)).toContain("public.save_reporting_walk");
    expect(o.functions).toHaveLength(12);
  });
  it("refuses a replacement, a drop, a timeout, a definer, an unknown statement or an object that already exists", () => {
    const bad = (t: string) => workerStateShapeProblems(t, PRIOR);
    expect(bad(T43.replace("CREATE FUNCTION public.set_reporting_site_mode(", "CREATE OR REPLACE FUNCTION public.set_reporting_site_mode(")).join(";")).toMatch(/not an allowed additive statement|replaces/);
    expect(bad(T43.replace("COMMIT;", "DROP TABLE reporting_private.changes;\nCOMMIT;")).join(";")).toMatch(/DROP|not an allowed/);
    expect(bad(T43.replace("COMMIT;", "SET statement_timeout = 0;\nCOMMIT;")).join(";")).toMatch(/not an allowed|timeout/);
    expect(bad(T43.replace("COMMIT;", "UPDATE reporting_private.control SET capture_enabled = true;\nCOMMIT;")).join(";")).toMatch(/not an allowed additive statement/);
    expect(bad(T43.replace("CREATE FUNCTION public.record_reporting_run(", "CREATE FUNCTION public.publish_reporting_batch(")).join(";")).toMatch(/already exists in 0037-0042/);
  });
  it("history: exact 0040-0042 rows; 0043 absent for the rehearsal, exactly once after install; unknown rows refused", () => {
    expect(historyProblems(HISTORY, "absent")).toEqual([]);
    expect(historyProblems(HISTORY.slice(1), "absent")[0]).toMatch(/lacks 20261116165846\/0040/);
    expect(historyProblems([...HISTORY, { version: "1", name: "0043_reporting_worker_state" }], "absent")[0]).toMatch(/already in the migration history/);
    expect(historyProblems([...HISTORY, { version: "1", name: "0043_reporting_worker_state" }], "installed")).toEqual([]);
    expect(historyProblems(HISTORY, "installed")[0]).toMatch(/exactly once/);
    expect(historyProblems([...HISTORY, { version: "2", name: "0040_other" }], "absent")[0]).toMatch(/unexpected 004x/);
  });
  it("catalog checks name every drift", () => {
    const good = (): WorkerCatalog => {
      const o = workerObjects(T43);
      return { tables: o.tables.map((name) => ({ name, rls: true, anon: false, authenticated: false, service: true })), indexes: [...o.indexes], functions: [] };
    };
    expect(workerCatalogProblems({ tables: [], functions: [], indexes: [] }, T43, "absent")).toEqual([]);
    expect(workerCatalogProblems(good(), T43, "absent")[0]).toMatch(/already exist/);
    const c = good();
    c.tables[0].anon = true;
    expect(workerCatalogProblems(c, T43, "installed").join(";")).toMatch(/access differs[\s\S]*12 expected|worker functions found/);
  });
});

describe("0043 rollback rehearsal over the real 0037-0042 SQL (PGlite)", () => {
  let db: PGlite;
  beforeAll(async () => { db = await reportingDb({ through: "0042_reporting_access_paths.sql" }); }, 120_000);
  afterAll(async () => db?.close());

  it("the staging install state is reproduced: 0042 identities hold and 0043 is absent", async () => {
    expect(dependencyIdentityProblems((await db.query<Record<string, unknown>>(CASE_SQL.effective)).rows, ...([1, 2, 3].map((i) => PRIOR[2 + i]) as [string, string, string]))).toEqual([]);
    const cat = (await db.query<{ j: WorkerCatalog }>(WORKER_CATALOG_SQL, workerCatalogParams(workerObjects(T43)))).rows[0].j;
    expect(workerCatalogProblems(cat, T43, "absent")).toEqual([]);
  });
  it("COMPLETE: W0-W8 recorded, 0043 fully checked inside, rolled back, catalog and site state unchanged", async () => {
    const before = await state(db);
    const { ctx, observations } = ctxFor();
    const ev = await rehearseWorkerState(pgDb(db), ctx);
    expect(ev.complete).toBe(true);
    expect(ev.rolledBack).toBe(true);
    expect(observations.map((o) => o.id)).toEqual(["W0", "W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8"]);
    expect(observations.every((o) => o.ok)).toBe(true);
    expect(observations.find((o) => o.id === "W6")?.result).toMatch(/authenticated set_reporting_site_mode refused/);
    expect(workerCatalogProblems(ev.catalogInside!, T43, "installed")).toEqual([]);
    expect(await state(db)).toBe(before);
  }, 60_000);
  it("refuses before any SQL on an unreviewed 0043 file", async () => {
    const sent: string[] = [];
    const spy: Db = { query: async (sql) => { sent.push(sql); return { rows: [], rowCount: 0 }; } };
    const { ctx } = ctxFor({ pin: "0".repeat(64) });
    await expect(rehearseWorkerState(spy, ctx)).rejects.toThrow(/W0 failed/);
    expect(sent).toEqual([]);
  });
  it("refuses before BEGIN on wrong history, and when 0043 is already installed", async () => {
    const sent: string[] = [];
    const spy: Db = { query: async (sql, p) => { sent.push(sql); return pgDb(db).query(sql, p); } };
    await expect(rehearseWorkerState(spy, ctxFor({ history: async () => HISTORY.slice(0, 2) }).ctx)).rejects.toThrow(/W1 failed/);
    expect(sent).not.toContain("begin");
    const installed = await reportingDb({ through: "0043_reporting_worker_state.sql" });
    try {
      const sent2: string[] = [];
      const spy2: Db = { query: async (sql, p) => { sent2.push(sql); return pgDb(installed).query(sql, p); } };
      const { ctx, observations } = ctxFor();
      await expect(rehearseWorkerState(spy2, ctx)).rejects.toThrow(/W3 failed/);
      expect(observations.find((o) => o.id === "W3")?.result).toMatch(/already exist/);
      expect(sent2).not.toContain("begin");
    } finally {
      await installed.close();
    }
  }, 120_000);
  it("refuses with an active batch; a failure inside rolls back and leaves nothing", async () => {
    const before = await state(db);
    const failing: Db = { query: async (sql, p) => { if (/^select \* from public\.record_reporting_run/.test(sql)) throw new Error("injected failure during W6"); return pgDb(db).query(sql, p); } };
    const { ctx, observations } = ctxFor();
    await expect(rehearseWorkerState(failing, ctx)).rejects.toThrow(/W6 failed/);
    expect(observations.find((o) => o.id === "W6")?.ok).toBe(false);
    expect(await state(db)).toBe(before);
    const active: Db = { query: async (sql, p) => (/state in \('active', 'frozen', 'publishing'\)/.test(sql) ? { rows: [{ n: 1 }], rowCount: 1 } : pgDb(db).query(sql, p)) };
    await expect(rehearseWorkerState(active, ctxFor().ctx)).rejects.toThrow(/W3 failed/);
  }, 60_000);
  it("redacts problem text in observations", async () => {
    const leaky: Db = { query: async (sql, p) => { if (/^select \* from public\.record_reporting_run/.test(sql)) throw new Error("postgresql://postgres:hunter2@db.example/x eyJabc.def.ghi"); return pgDb(db).query(sql, p); } };
    const redact = (s: string) => s.replace(/postgres(ql)?:\/\/[^\s]+/g, "[url]").replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[jwt]");
    const { ctx, observations } = ctxFor({ redact });
    await expect(rehearseWorkerState(leaky, ctx)).rejects.toThrow(/W6 failed/);
    const w6 = observations.find((o) => o.id === "W6")!.result;
    expect(w6).not.toMatch(/hunter2|eyJabc/);
  }, 60_000);
});

describe("worker harness arguments, STATUS and wiring", () => {
  it("parses exactly one mode and one site; limits only for the runtime; unknown flags refused", () => {
    expect(parseWorkerArgs(["--rehearse-worker-state", "--site=uk"])).toMatchObject({ mode: "rehearse-worker-state", site: "uk", problems: [] });
    expect(parseWorkerArgs(["--worker-runtime", "--site=us", "--pace-calls=4"])).toMatchObject({ mode: "worker-runtime", paceCalls: 4, problems: [] });
    expect(parseWorkerArgs(["--rehearse-worker-state"]).problems).toContain("--site=au|uk|us is required");
    expect(parseWorkerArgs(["--rehearse-worker-state", "--worker-runtime", "--site=uk"]).problems[0]).toMatch(/exactly one/);
    expect(parseWorkerArgs(["--rehearse-worker-state", "--site=uk", "--pace-calls=4"]).problems.join(";")).toMatch(/only apply to --worker-runtime/);
    expect(parseWorkerArgs(["--worker-runtime", "--site=uk", "--pace-calls=0"]).problems.join(";")).toMatch(/pace-calls must be/);
    expect(parseWorkerArgs(["--worker-runtime", "--site=staging"]).problems).toContain("--site=au|uk|us is required");
    expect(parseWorkerArgs(["--worker-runtime", "--site=uk", "--force"]).problems).toContain("unknown argument --force");
  });
  it("STATUS: COMPLETE only with complete evidence, every observation ok and a verified restoration", () => {
    const r = newWorkerReport("rehearse-worker-state", "uk", "abc", "t", REVIEWED_0043_LF);
    expect(workerStatus(r)).toBe("STATUS: FAILED – rehearse-worker-state evidence is missing or incomplete (+1 more)");
    r.evidence = { complete: true };
    r.restorationVerified = true;
    expect(workerStatus(r)).toBe("STATUS: COMPLETE");
    r.cleanup.push("delete fixtures: boom");
    expect(workerStatus(r)).toBe("STATUS: FAILED – cleanup failed: delete fixtures: boom");
    expect(workerMarkdown(r).trim().split("\n").at(-1)).toMatch(/^STATUS: FAILED/);
  });
  it("the runner routes both flags to the worker harness and audits the rehearsal with ZERO allowed change", () => {
    const main = read("tests/staging/reporting-jobs.ts");
    expect(main).toMatch(/if \(flags\.some\(\(f\) => \(WORKER_FLAGS as readonly string\[\]\)\.includes\(f\)\)\) return workerMain\(flags\);/);
    const wm = main.slice(main.indexOf("async function workerMain"), main.indexOf("async function main()"));
    expect(wm).toContain("compareFullState(before, await fullState(fresh), ROLLBACK_ONLY)");
    expect(wm).toContain("stagingTarget(s.STAGING_DB_URL)");
    expect(wm).toContain("redactSecrets");
    // timeouts are only READ for the report, never set
    expect(wm).not.toMatch(/\bset\s+(local\s+|session\s+)?(statement|lock|idle_in_transaction_session)_timeout|set_config\('(statement|lock|idle_in_transaction_session)_timeout/i);
    expect(wm).toContain("current_setting('statement_timeout')");
  });
  it("recovery arguments: a plain run-report file name is required (no directories or traversal); limits are refused", () => {
    const name = "staging-results-reporting-worker-worker-runtime-20261117T101500000Z-0a1b2c3d.md";
    expect(parseWorkerArgs(["--recover-worker-run", "--site=uk", `--report=${name}`])).toMatchObject({ mode: "recover-worker-run", site: "uk", report: name, problems: [] });
    expect(parseWorkerArgs(["--recover-worker-run", "--site=uk"]).problems.join(";")).toMatch(/needs --report=/);
    expect(parseWorkerArgs(["--recover-worker-run", "--site=uk", `--report=../${name}`]).problems.join(";")).toMatch(/needs --report=/);
    expect(parseWorkerArgs(["--recover-worker-run", "--site=uk", "--report=staging-results-reporting-worker-rehearse-worker-state-1-0a1b2c3d.md"]).problems.join(";")).toMatch(/needs --report=/);
    expect(parseWorkerArgs(["--recover-worker-run", "--site=uk", `--report=${name}`, "--pace-calls=4"]).problems.join(";")).toMatch(/only apply to --worker-runtime/);
    expect(parseWorkerArgs(["--worker-runtime", "--site=uk", `--report=${name}`]).problems.join(";")).toMatch(/only applies to --recover-worker-run/);
  });
  it("recovery wiring: the report is parsed before any connection; recovery never waits for a lease; the audit uses the original baseline", () => {
    const main = read("tests/staging/reporting-jobs.ts");
    const wm = main.slice(main.indexOf("async function workerMain"), main.indexOf("async function main()"));
    expect(wm.indexOf("recovered = parseRunReport(readFileSync(args.report!, \"utf8\"), site);")).toBeGreaterThan(0);
    expect(wm.indexOf("recovered = parseRunReport(")).toBeLessThan(wm.indexOf("await runCaptureLifecycle("));
    expect(wm).toContain('awaitLeaseExpiry: async () => { throw new Error("recovery never waits for a lease"); }');
    expect(wm).toMatch(/if \(mode === "recover-worker-run" && recoveryWrote\) \{[\s\S]*?auditRuntime\(fresh, \{ state: \(c\) => fullState\(c\) \}, own, rev\)/);
    const rec = read("tests/staging/reportingWorkerRecovery.ts");
    expect(rec).not.toMatch(/resume_reporting_batch|renew_reporting_lease|resumeReportingBatch|renewReportingLease|awaitLeaseExpiry\(/);
  });
  it("wrong target: a non-staging database URL is refused before any connection", () => {
    expect(() => stagingTarget("postgresql://postgres:x@db.lkboboagiikvozvbcpvg.supabase.co:5432/postgres")).toThrow(/not the staging project ybrzhrgfrnvtcwymjdrq/);
    expect(() => stagingTarget("postgresql://postgres.ybrzhrgfrnvtcwymjdrq:x@aws-0.pooler.supabase.com:6543/postgres")).not.toThrow();
  });
  it("runtime wiring: cleanup in finally before the fresh audit; owned toggles; real lease wait (read only); the service client; rollback-only audit when nothing was committed", () => {
    const main = read("tests/staging/reporting-jobs.ts");
    const wm = main.slice(main.indexOf("async function workerMain"), main.indexOf("async function main()"));
    expect(wm).toMatch(/try \{\s+await runWorkerRuntime\(main, runtimeCtx\(staff\), own, rev\);\s+\} finally \{\s+await cleanupRuntime\(runtimeCtx\(staff\), own, report\.cleanup\);\s+\}/);
    expect(wm).toContain("toggle: (enabled, restoring = false) => ownedToggle({ transitions: own.captureTransitions");
    expect(wm).toContain("rpcClient: (c, opts) => serviceRpcClient(c, opts)");
    expect(wm).toContain("const a = await auditRuntime(fresh, { state: (c) => fullState(c) }, own, rev);");
    expect(wm).toMatch(/if \(!own\.committedAnything\) \{[\s\S]*?ROLLBACK_ONLY/);
    // the lease is only read: no write to any lease column anywhere in the runner's worker path
    expect(wm).not.toMatch(/update\s+reporting_private\.(site_state|batches)/i);
    expect(wm).toContain("over --max-lease-wait-ms=");
    expect(wm).toContain("report.ownership = own");
  });
});
