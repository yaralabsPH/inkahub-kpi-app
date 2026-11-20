/**
 * B2b I4 plan-only diagnostic (tests/staging/reportingPlanDiagnostic.ts), without a
 * database: the exact statement, the allow-list (no publish/commit/DDL/VACUUM/
 * ANALYZE/setting change), the original workload check, the full plan, and
 * rollback + session close + fresh audit after prepare/EXPLAIN/persistence failures.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DIAG_SQL,
  DIAGNOSTIC_ALLOWED,
  DIAGNOSTIC_LABEL,
  diagnosticDb,
  EXPLAIN_SQL,
  runPlanDiagnostic,
  SEQ_PLACEHOLDER,
  SOURCE_VERSIONS_INSERT_SQL,
  type PlanDiagnostic,
} from "../staging/reportingPlanDiagnostic";
import { runCaptureLifecycle } from "../staging/reportingCapture";
import { become } from "../staging/writeCompatRun";
import { compareFullState, newPublicationReport, parsePublicationArgs, publicationMarkdown, publicationStatus, ROLLBACK_ONLY, type Db, type FullState, type Observation } from "../staging/reportingPublication";

const MIGRATION = readFileSync("supabase/migrations/0038_reporting_jobs.sql", "utf8");
const RUNNER = readFileSync("tests/staging/reporting-jobs.ts", "utf8");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// A scripted staging database
// ---------------------------------------------------------------------------
type Fail = Partial<Record<"copy" | "explain" | "rollback" | "mismatch" | "noPlan" | "relations", boolean>>;
function fakeDb(fail: Fail = {}) {
  const sent: Array<{ sql: string; params?: unknown[] }> = [];
  let role = "postgres";
  let copies = 0;
  const db: Db = {
    query: async (sql: string, params?: unknown[]) => {
      sent.push({ sql, params });
      const ok = (rows: Array<Record<string, unknown>> = []) => ({ rows, rowCount: rows.length });
      if (sql === "rollback" && fail.rollback) throw new Error("connection terminated");
      if (sql === "reset role") return void (role = "postgres"), ok();
      if (sql === "set local role service_role") return void (role = "service_role"), ok();
      if (sql.includes("set_reporting_capture")) return ok([{ capture_epoch: "14", capture_enabled: true }]);
      if (sql.includes("begin_reporting_rebuild")) return ok([{ batch_id: "11111111-1111-4111-8111-111111111111", lease_fence: "7" }]);
      if (sql.includes("copy_reporting_source_page")) {
        if (fail.copy) throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
        return ++copies === 1 ? ok([{ complete: false, next_after_event_id: "e-250" }]) : ok([{ complete: true, pages: "2", total_rows: "500" }]);
      }
      if (sql.includes("freeze_reporting_rebuild")) return ok([{ source_cutoff: "2026-11-15T02:00:00Z" }]);
      if (sql === DIAG_SQL.sourceRows) return ok([{ n: "500" }]);
      if (sql === DIAG_SQL.candidateRows) return ok([{ n: fail.mismatch ? "499" : "500" }]);
      if (sql === DIAG_SQL.currentVersions) return ok([{ n: "0" }]);
      if (sql === DIAG_SQL.settings) return ok([{ name: "work_mem", setting: "2184", unit: "kB", source: "configuration file" }]);
      if (sql === DIAG_SQL.relations) return ok(fail.relations ? [] : ["batches", "source_candidate", "source_current", "source_versions"].map((r) => ({ relname: r, relkind: "r", heap_bytes: "8192", last_autovacuum: null })));
      if (sql === DIAG_SQL.indexes) return ok([{ index_name: "source_versions_current", table_name: "source_versions", bytes: "8192", definition: "CREATE UNIQUE INDEX ..." }]);
      if (sql === DIAG_SQL.role) return ok([{ current_user: role, session_user: "postgres", search_path: '"$user", public', isolation: "read committed" }]);
      if (sql === EXPLAIN_SQL) {
        if (fail.explain) throw new Error("permission denied for table source_versions");
        return ok([{ "QUERY PLAN": fail.noPlan ? [] : [{ Plan: { "Node Type": "ModifyTable", Plans: [{ "Node Type": "Hash Anti Join" }] }, Settings: {} }] }]);
      }
      return ok();
    },
  };
  return { db, sent, sqls: () => sent.map((s) => s.sql) };
}

function ctxFor(over: { emit?: (d: PlanDiagnostic) => void; record?: (o: Observation) => void } = {}) {
  const recorded: Observation[] = [];
  const emitted: PlanDiagnostic[] = [];
  return {
    recorded,
    emitted,
    ctx: {
      site: "uk" as const,
      maxPages: 200,
      as: async (c: Db, service: boolean) => (service ? become(c as never, "service_role", {}) : void (await c.query("reset role"))),
      record: over.record ?? ((o: Observation) => void recorded.push(o)),
      redact: (s: string) => s,
      now: () => 0,
      emit: over.emit ?? ((d: PlanDiagnostic) => void emitted.push(d)),
    },
  };
}

describe("I4 plan diagnostic: the exact statement", () => {
  it("is the 0038 rebuild-branch source_versions INSERT with b.site/v_seq/p_batch bound as $1/$2/$3", () => {
    const m = norm(MIGRATION);
    const start = m.indexOf("ELSE UPDATE reporting_private.source_versions v SET valid_to_seq = v_seq");
    expect(start).toBeGreaterThan(0);
    const fromMigration = m.slice(start).split("INSERT INTO reporting_private.source_versions (site, event_id, valid_from_seq, image)")[1].split(";")[0];
    const bound = norm(fromMigration).replace(/\bb\.site\b/g, "$1::text").replace(/\bv_seq\b/g, "$2::bigint").replace(/\bp_batch\b/g, "$3::uuid");
    expect(norm(SOURCE_VERSIONS_INSERT_SQL)).toBe(norm(`INSERT INTO reporting_private.source_versions (site, event_id, valid_from_seq, image) ${bound}`));
    expect(MIGRATION.split(/\r?\n/).slice(1942, 1947).join("\n")).toContain("FROM reporting_private.source_candidate c"); // 0038 lines 1943-1947
  });

  it("EXPLAIN is VERBOSE, SETTINGS, FORMAT JSON and never ANALYZE; v_seq is projection-only", () => {
    expect(EXPLAIN_SQL.startsWith("EXPLAIN (VERBOSE, SETTINGS, FORMAT JSON) INSERT INTO reporting_private.source_versions")).toBe(true);
    expect(EXPLAIN_SQL).not.toMatch(/analy[sz]e|buffers|timing/i);
    expect(SOURCE_VERSIONS_INSERT_SQL.split("$2::bigint")).toHaveLength(2); // only in the SELECT list
    expect(SOURCE_VERSIONS_INSERT_SQL.indexOf("$2::bigint")).toBeLessThan(SOURCE_VERSIONS_INSERT_SQL.indexOf("FROM"));
    expect(DIAGNOSTIC_LABEL).toMatch(/NOT the cached PL\/pgSQL plan/);
  });
});

describe("I4 plan diagnostic: the allow-list", () => {
  const forbidden = [
    "select * from public.publish_reporting_batch($1, $2)",
    "commit",
    "end",
    "vacuum reporting_private.source_versions",
    "analyze reporting_private.source_versions",
    `EXPLAIN (ANALYZE, VERBOSE, SETTINGS, FORMAT JSON) ${SOURCE_VERSIONS_INSERT_SQL}`,
    "set local statement_timeout = '10min'",
    "select set_config('statement_timeout', '0', true)",
    "select set_config('lock_timeout', '0', true)",
    "set local enable_nestloop = off",
    "select set_config('work_mem', '64MB', true)",
    "create index on reporting_private.source_versions (site)",
    "insert into public.production_events values ('x')",
    "select * from public.seal_reporting_work($1, $2, 0, $3)",
    `${SOURCE_VERSIONS_INSERT_SQL}`,
  ];
  for (const sql of forbidden) {
    it(`refuses before sending: ${sql.slice(0, 60)}`, async () => {
      const f = fakeDb();
      await expect(diagnosticDb(f.db).query(sql, [])).rejects.toThrow(/refuses a statement outside its allow-list/);
      expect(f.sent).toEqual([]);
    });
  }
  it("allows nothing that publishes, commits, analyzes, vacuums, changes a setting or runs DDL", () => {
    for (const s of DIAGNOSTIC_ALLOWED) {
      expect(s).not.toMatch(/^\s*(commit|end|vacuum|analyze|create|alter|drop|grant|revoke|reindex|cluster|truncate|insert|delete)\b/i);
      expect(s).not.toMatch(/publish_reporting|seal_reporting|stage_reporting|claim_reporting|\(\s*analyze|statement_timeout'|lock_timeout'|enable_\w+\s*=/i);
      if (/^\s*set\b/i.test(s)) expect(s).toBe("set local role service_role");
      if (/^\s*update\b/i.test(s)) expect(s).toBe(DIAG_SQL.processorOn);
      if (/set_config/.test(s)) expect(s).toMatch(/^select set_config\('request\.jwt\.claims'/); // only become's request claims
    }
  });
});

describe("I4 plan diagnostic: a full run", () => {
  it("prepares the same-size candidate with reviewed helpers, measures BEFORE the plan, EXPLAINs as service_role and rolls back", async () => {
    const f = fakeDb();
    const t = ctxFor();
    const d = await runPlanDiagnostic(f.db, t.ctx);
    const q = f.sqls();
    expect(q[0]).toBe("begin");
    expect(q.at(-1)).toBe("rollback");
    expect(q.filter((x) => x === "rollback")).toHaveLength(1);
    expect(q.some((x) => /commit|publish_reporting_batch|seal_reporting|claim_reporting|stage_reporting/i.test(x))).toBe(false);
    const at = (needle: string) => q.findIndex((x) => x.includes(needle));
    expect(at("set_reporting_capture(true)")).toBeLessThan(at("begin_reporting_rebuild"));
    expect(at("begin_reporting_rebuild")).toBeLessThan(at("copy_reporting_source_page"));
    expect(at("copy_reporting_source_page")).toBeLessThan(at("freeze_reporting_rebuild"));
    for (const m of [DIAG_SQL.candidateRows, DIAG_SQL.settings, DIAG_SQL.relations, DIAG_SQL.indexes, DIAG_SQL.role]) expect(q.indexOf(m)).toBeLessThan(q.indexOf(EXPLAIN_SQL));
    expect(q.indexOf(EXPLAIN_SQL)).toBeGreaterThan(at("freeze_reporting_rebuild"));
    expect(q.filter((x) => x === EXPLAIN_SQL)).toHaveLength(1);
    // Original workload: candidate == source volume; the EXPLAIN binds exactly (site, placeholder seq, this batch).
    expect(d.candidateRows).toBe("500");
    expect(d.sourceRows).toBe("500");
    expect(f.sent.find((s) => s.sql === EXPLAIN_SQL)?.params).toEqual(["uk", SEQ_PLACEHOLDER, "11111111-1111-4111-8111-111111111111"]);
    expect(f.sent.find((s) => s.sql === DIAG_SQL.processorOn)?.params).toEqual(["uk"]);
    expect(d.role).toMatchObject({ current_user: "service_role" });
    // The full plan is emitted, with parameter identities and no source payload.
    expect(t.emitted).toHaveLength(1);
    expect(t.emitted[0].plan).toEqual([{ Plan: { "Node Type": "ModifyTable", Plans: [{ "Node Type": "Hash Anti Join" }] }, Settings: {} }]);
    expect(t.emitted[0].params).toMatchObject({ site: "uk", seq: "1", batchId: "11111111-1111-4111-8111-111111111111" });
    expect(t.emitted[0].relations).toHaveLength(4);
    expect(JSON.stringify(t.emitted[0])).not.toMatch(/"image"\s*:/);
    expect(q.some((x) => /\bimage\b/.test(x) && !x.startsWith("EXPLAIN") && !x.includes("copy_reporting"))).toBe(false); // no payload read
    expect(t.recorded.map((o) => `${o.id}:${o.ok}`)).toEqual(["P0:true", "P1:true", "P2:true", "P3:true", "P4:true", "P5:true", "P6:true", "P7:true"]);
    expect(t.recorded.find((o) => o.id === "P2")?.result).toBe("2 pages, 500 rows");
  });

  const failures: Array<[string, Fail, RegExp, string]> = [
    ["a prepare (copy) failure", { copy: true }, /P2 failed; later steps depend on it/, "P2"],
    ["a candidate that is not the original workload", { mismatch: true }, /P4 failed/, "P4"],
    ["missing relation statistics", { relations: true }, /P5 failed/, "P5"],
    ["an EXPLAIN failure", { explain: true }, /P6 failed/, "P6"],
    ["an EXPLAIN without a JSON plan", { noPlan: true }, /P6 failed/, "P6"],
  ];
  for (const [name, fail, err, id] of failures) {
    it(`stops at ${name}: nothing later runs, it rolls back, nothing is emitted`, async () => {
      const f = fakeDb(fail);
      const t = ctxFor();
      await expect(runPlanDiagnostic(f.db, t.ctx)).rejects.toThrow(err);
      const q = f.sqls();
      expect(q.at(-1)).toBe("rollback");
      expect(t.emitted).toEqual([]);
      expect(t.recorded.at(-1)).toMatchObject({ id, ok: false });
      if (id !== "P6") expect(q).not.toContain(EXPLAIN_SQL);
      expect(q.some((x) => /commit|publish_reporting/i.test(x))).toBe(false);
    });
  }

  it("a persistence failure (emit) after the plan: rolls back and the error propagates", async () => {
    const f = fakeDb();
    const t = ctxFor({ emit: () => { throw new Error("ENOSPC"); } });
    await expect(runPlanDiagnostic(f.db, t.ctx)).rejects.toThrow("ENOSPC");
    expect(f.sqls().at(-1)).toBe("rollback");
  });

  it("a persistence failure while RECORDING a step stops there and still rolls back", async () => {
    const f = fakeDb();
    let n = 0;
    const t = ctxFor({ record: () => { if (++n === 2) throw new Error("ENOSPC"); } });
    await expect(runPlanDiagnostic(f.db, t.ctx)).rejects.toThrow(/^P1 failed; later steps depend on it$/); // the shared step() helper reports it as P1's failure
    expect(f.sqls()).not.toContain("select * from public.copy_reporting_source_page($1, $2, $3)");
    expect(f.sqls().at(-1)).toBe("rollback");
  });

  it("a rollback failure after an earlier failure is kept BESIDE it", async () => {
    const f = fakeDb({ explain: true, rollback: true });
    const t = ctxFor();
    await expect(runPlanDiagnostic(f.db, t.ctx)).rejects.toThrow(/^P6 failed; later steps depend on it; cleanup failed: diagnostic rollback: connection terminated$/);
  });
});

describe("I4 plan diagnostic: inside the actual lifecycle (baseline first, every session closed, zero-change fresh audit)", () => {
  const state = (payload: string): FullState => ({ surfaces: { "source:production_events": payload }, privateTables: { source_versions: "rows=0" }, control: { capture_epoch: "13", capture_enabled: false, rule_version: "r1", updated_at: "t" }, siteState: [{ site: "uk", processor_enabled: false }] });
  for (const [name, fail, payloadAfter] of [["success", {}, "same"], ["a prepare failure", { copy: true }, "same"], ["an EXPLAIN failure", { explain: true }, "same"], ["an unexpected change", {}, "changed"]] as const) {
    it(`${name}: main rolled back and closed, a fresh audit with ZERO allowed changes`, async () => {
      const report = newPublicationReport("explain-source-versions", ["uk", "uk"], "rev", "t0", "sha");
      const opened: Array<{ ended: boolean; f: ReturnType<typeof fakeDb> }> = [];
      let before: FullState | null = null;
      const t = ctxFor({ record: (o) => void report.observations.push(o) });
      await runCaptureLifecycle(report, {
        open: async () => {
          const f = fakeDb(fail);
          const o = { ended: false, f };
          opened.push(o);
          return { query: f.db.query, end: async () => void (o.ended = true) };
        },
        body: async (main) => {
          before = state("same");
          await runPlanDiagnostic(main as unknown as Db, { ...t.ctx, record: (o) => void report.observations.push(o), emit: (d) => void (report.diagnostic = d as unknown as Record<string, unknown>) });
        },
        audit: async () => compareFullState(before!, state(payloadAfter), ROLLBACK_ONLY),
        save: () => undefined,
        now: () => "t1",
        redact: (s) => s,
        stderr: () => undefined,
      });
      expect(opened).toHaveLength(2); // main + the fresh auditor
      expect(opened.every((o) => o.ended)).toBe(true);
      expect(opened[0].f.sqls().at(-1)).toBe("rollback");
      expect(opened[0].f.sqls().some((x) => /commit|publish_reporting/i.test(x))).toBe(false);
      const status = publicationStatus(report);
      if (name === "success") {
        expect(status).toBe("STATUS: COMPLETE");
        expect(publicationMarkdown(report)).toContain('"Node Type": "Hash Anti Join"');
        expect(publicationMarkdown(report)).toContain("NOT the cached PL/pgSQL plan");
      } else expect(status).toMatch(/^STATUS: FAILED/);
      if (name === "an unexpected change") expect(report.restorationProblems.join()).toMatch(/source:production_events differs/);
    });
  }
});

describe("I4 plan diagnostic: runner wiring", () => {
  it("--explain-source-versions takes exactly one supported --site", () => {
    expect(parsePublicationArgs(["--explain-source-versions", "--site=uk"])).toMatchObject({ mode: "explain-source-versions", sites: ["uk", "uk"], maxPages: 200, problems: [] });
    expect(parsePublicationArgs(["--explain-source-versions", "--sites=uk,us"]).mode).toBeNull();
    expect(parsePublicationArgs(["--explain-source-versions", "--site=uk", "--sites=uk,us"]).problems).toEqual(["unknown flags: --sites=uk,us"]);
    expect(parsePublicationArgs(["--explain-source-versions", "--site=eu"]).mode).toBeNull();
    expect(parsePublicationArgs(["--explain-source-versions"]).mode).toBeNull();
    expect(parsePublicationArgs(["--check-installed", "--site=uk"]).mode).toBeNull();
  });

  it("the runner takes the full baseline first, then runs only the diagnostic; the audit for this mode is ROLLBACK_ONLY", () => {
    const pub = RUNNER.slice(RUNNER.indexOf("async function publicationMain"), RUNNER.indexOf("async function main()"));
    expect(pub.indexOf("before = await fullState(main);")).toBeLessThan(pub.indexOf('if (mode === "explain-source-versions") {'));
    expect(pub).toMatch(/if \(mode === "explain-source-versions"\) \{\r?\n(\s*\/\/.*\r?\n)?\s+await runPlanDiagnostic\(main, \{ site: sites\[0\], maxPages, as, record, redact: redactSecrets, now: \(\) => performance\.now\(\), emit: \(d\) => \{ report\.diagnostic = d as unknown as Record<string, unknown>; save\(\); \} \}\);\r?\n\s+return;/);
    expect(pub).toMatch(/const allow = mode === "committed-interleavings" && own \? committedAllowance\(own\) : ROLLBACK_ONLY;/);
  });
});
