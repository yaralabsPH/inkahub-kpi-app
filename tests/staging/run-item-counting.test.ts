/**
 * The gate's order: SQL evidence first, API timing only after it passes, and
 * a manager phase recorded only for a clean run. Uses the real checker on
 * fabricated results; no database or network.
 */
import { describe, expect, it, vi } from "vitest";
import { buildReport, type GateState } from "./itemCountingReport";
import { runGate, type GateIO } from "./itemCountingGate";
import { FN_ARGS, HARNESS_VERSION, V1_FUNCTION, V2_FUNCTION, type FileRun, type PhaseRecord, type StatementResult } from "./itemCountingEvidence";
import { MEASURE_CASES, type MeasureResult, type MeasureRow, type RunMetrics } from "./measure-item-counting";

const SCOPES = MEASURE_CASES.map((c) => c.scope);
const DAYS = MEASURE_CASES.filter((c) => c.first === c.last).map((c) => c.scope);
const TOTAL: Record<string, number> = { "au-busy-day": 1313, "au-3-months": 118244, "uk-day": 56, "uk-3-months": 5152, "us-day": 56, "us-3-months": 5152 };
let idx = 0;
const res = (command: string, rows: Array<Record<string, unknown>> = [], label = "stmt"): StatementResult => {
  idx++;
  return { index: idx, line: idx, label, command, rowCount: rows.length, fields: rows[0] ? Object.keys(rows[0]) : [], rows, notices: [], ms: 5, error: null };
};

/** A passing 03 run for an AU-only manager. */
function query03(): FileRun {
  idx = 0;
  const out: StatementResult[] = [res("BEGIN")];
  for (const name of [V2_FUNCTION, V1_FUNCTION]) {
    out.push(res("SELECT", [{ fn_name: name, fn_args: FN_ARGS, fn_result: "json", fn_language: "sql", fn_volatility: "s", fn_security_definer: false, fn_config: 'search_path=""', fn_definition_md5: name === V2_FUNCTION ? "v2md5" : "v1md5" }]));
    out.push(res("SELECT", ["PUBLIC", "anon", "authenticated", "service_role"].map((g) => ({ fn_privileges_for: name, fn_grantee: g, can_execute: g === "authenticated" || g === "service_role" }))));
  }
  out.push(res("SELECT", [{ total_size: "90 MB", rows: 240112 }]));
  const become = (who: string) => out.push(res("RESET"), res("SELECT", [{ b: 1 }]), res("SET"), res("DO"), res("SELECT", [{
    timeout_for: who, current_user_name: "authenticated", effective_timeout_ms: 8000, catalog_timeout: "8s", row_security: "on",
  }]));
  for (const role of ["owner", "manager"]) {
    become(role);
    for (const scope of SCOPES) {
      for (const n of [1, 2, 3]) out.push(res("EXPLAIN", [{ p: "Execution Time: 1 ms" }], `explain (analyze, buffers) select 'gate:call:${role}:${scope}:${n}' as gate,`));
      out.push(res("EXPLAIN", [{ p: "Execution Time: 1 ms" }], `explain (analyze, buffers) select 'gate:body:${role}:${scope}:1' as gate, (`));
      for (const n of [1, 2, 3]) out.push(res("SELECT", [{ gate: `gate:text:${role}:${scope}:${n}`, body_bytes: 100, effective_timeout: "8s" }]));
      const t = role === "manager" && !scope.startsWith("au") ? 0 : TOTAL[scope];
      out.push(res("SELECT", [{ role, scope, fn_row_count: t }]), res("SELECT", [{ role, scope, independent_total: t }]));
      if (DAYS.includes(scope)) out.push(res("SELECT", [{ role, scope, decoded_rows: t, only_in_function: 0, only_in_table: 0, staff_entries: 1, expected_staff: 1, sku_entries: 1, expected_skus: 1 }]));
    }
  }
  become("staff");
  out.push(res("SELECT", [{ role: "staff", scope: "au-busy-day", fn_row_count: 0 }]), res("SELECT", [{ role: "staff", scope: "au-busy-day", independent_total: 0 }]));
  out.push(res("SELECT", [{ role: "staff", scope: "au-busy-day", decoded_rows: 0, only_in_function: 0, only_in_table: 0, staff_entries: 0, expected_staff: 0, sku_entries: 0, expected_skus: 0 }]));
  become("owner");
  out.push(res("SELECT", [{ empty_window_row_count: 0, empty_window_body: '{"staffIds" : [], "skus" : []}', reversed_window_is_null: true, blank_site_is_null: true, infinite_start_is_null: true }]));
  out.push(res("ROLLBACK"));
  return { file: "03-query-evidence.sql", statements: out.length, results: out };
}

const run = (n: number, rows: number, inWindow = rows): RunMetrics => ({
  run: n, error: null, requests: 1, evidenceCalls: 1, otherEvidenceCalls: 0, headersMs: 100, bodyMs: 50, rawBytes: 100, wireBytes: null,
  contentEncoding: null, parseMs: 10, parseCalls: 1, loadMs: 300, validateMs: 140, reducerMs: 20, totalMs: 320, rows, inWindowRows: inWindow,
});
function row(scope: string, total: number, visibility: "site" | "limited" = "site"): MeasureRow {
  const c = MEASURE_CASES.find((x) => x.scope === scope)!;
  return {
    label: c.label, scope, site: c.site, windowStartUtc: "a", windowEndUtc: "b", visibility, serverCount: total,
    runs: [1, 2, 3].map((n) => run(n, total)), medianTotalMs: 320, firstTotalMs: 320, slowestTotalMs: 320, targetMs: c.targetMs,
    error: null, complete: true, withinTarget: true,
  };
}
const owner = (): MeasureResult => ({ email: "o", role: "owner", sites: ["au", "uk", "us"], asOfUtc: "t", runs: 3, rows: SCOPES.map((s) => row(s, TOTAL[s])) });
const managerAuOnly = (): MeasureResult => ({
  email: "m", role: "manager", sites: ["au", "staging"], asOfUtc: "t", runs: 3,
  rows: SCOPES.map((s) => (s.startsWith("au") ? row(s, TOTAL[s]) : row(s, 0, "limited"))),
});

function setup(sql: () => FileRun, measures: { owner: MeasureResult; manager: MeasureResult } = { owner: owner(), manager: managerAuOnly() }, records: PhaseRecord[] = []) {
  const state: GateState = {
    startedAt: "s", revision: "r", mode: "measure-only", runs: [], measures: { owner: undefined, manager: undefined },
    managerPhase: null, phaseRecords: records, current: null, lastProgress: null, stopped: null, fatal: null, finishedAt: null,
  };
  const written: PhaseRecord[][] = [];
  const io: GateIO = {
    runSql: vi.fn(async () => void state.runs.push(sql())),
    measure: vi.fn(async (who: "owner" | "manager", onUpdate: (m: MeasureResult) => void) => {
      onUpdate(measures[who]);
      return measures[who];
    }),
    save: () => {},
    writePhases: (r) => void written.push(r),
    now: () => "2026-11-13T10:00:00Z",
    log: () => {},
  };
  return { state, io, written };
}

describe("runGate", () => {
  it("measures only after the SQL evidence passes, then records a clean phase with its identity", async () => {
    const { state, io, written } = setup(query03);
    await runGate(state, io, { mode: "measure-only", files: ["03-query-evidence.sql"] });
    expect(io.measure).toHaveBeenCalledTimes(2);
    expect(state.managerPhase).toBe("denied-before");
    expect(written).toHaveLength(1);
    expect(written[0][0]).toMatchObject({ phase: "denied-before", fnName: V2_FUNCTION, fnDefinitionMd5: "v2md5", encodingVersion: 2, harnessVersion: HARNESS_VERSION, problems: [] });
    const report = buildReport({ ...state, current: null, finishedAt: "f" });
    expect(report.status).toBe("STATUS: FAILED – awaiting manager phases all-sites, denied-after (expected; no query or performance failure)");
  });

  it("an SQL timeout keeps the failed statement and starts no API measurement", async () => {
    const { state, io, written } = setup(() => {
      const q = query03();
      const at = q.results.findIndex((r) => r.rows[0]?.gate === "gate:text:owner:au-3-months:1");
      q.results = q.results.slice(0, at + 1);
      q.results[at] = { ...q.results[at], command: null, rows: [], fields: [], error: "canceling statement due to statement timeout" };
      return q;
    });
    await runGate(state, io, { mode: "measure-only", files: ["03-query-evidence.sql"] });
    expect(io.measure).not.toHaveBeenCalled();
    expect(written).toHaveLength(0);
    const report = buildReport({ ...state, current: null, finishedAt: "f" });
    expect(report.status).toMatch(/^STATUS: FAILED – 03-query-evidence.sql: statement \d+ .* failed: canceling statement due to statement timeout/);
    expect(report.markdown).toContain("**ERROR:** canceling statement due to statement timeout");
  });

  it("a semantic SQL failure (no error, wrong evidence) also starts no API measurement", async () => {
    const { state, io } = setup(() => {
      const q = query03();
      const t = q.results.find((r) => r.fields.includes("timeout_for"))!;
      t.rows = [{ ...t.rows[0], catalog_timeout: "30s", effective_timeout_ms: 30000 }];
      return q;
    });
    await runGate(state, io, { mode: "measure-only", files: ["03-query-evidence.sql"] });
    expect(io.measure).not.toHaveBeenCalled();
    expect(buildReport({ ...state, current: null, finishedAt: "f" }).status).toMatch(/expected the unchanged 8s/);
  });

  it("an SQL connection error starts no API measurement", async () => {
    const { state, io } = setup(query03);
    io.runSql = vi.fn(async () => {
      throw new Error("connection refused");
    });
    await runGate(state, io, { mode: "measure-only", files: ["03-query-evidence.sql"] });
    expect(io.measure).not.toHaveBeenCalled();
    expect(state.fatal).toBe("connection refused");
  });

  it("refuses an explicit phase that contradicts the manager's memberships, and records nothing", async () => {
    const { state, io, written } = setup(query03);
    await runGate(state, io, { mode: "measure-only", files: ["03-query-evidence.sql"], phaseArg: "all-sites" });
    expect(state.fatal).toMatch(/--manager-phase=all-sites does not match the manager's memberships/);
    expect(written).toHaveLength(0);
  });

  it("a failed run is not recorded, so a later run can't be satisfied by it", async () => {
    const o = owner();
    o.rows[1].runs[0] = { ...run(1, 0), error: "incomplete: timeout", totalMs: null };
    const { state, io, written } = setup(query03, { owner: o, manager: managerAuOnly() });
    await runGate(state, io, { mode: "measure-only", files: ["03-query-evidence.sql"] });
    expect(io.measure).toHaveBeenCalledTimes(2);
    expect(written).toHaveLength(0);
    expect(buildReport({ ...state, current: null, finishedAt: "f" }).status).toMatch(/^STATUS: FAILED – measurement as owner: AU 3 months \(busy\) run 1 errored/);
  });

  it("an old (v1) all-sites record does not make this run denied-after", async () => {
    const old: PhaseRecord = { phase: "all-sites", finishedAt: "2026-11-13T01:00:00Z", revision: "a127c1f", fnDefinitionMd5: "ffef", problems: [] };
    const { state, io } = setup(query03, undefined, [old]);
    await runGate(state, io, { mode: "measure-only", files: ["03-query-evidence.sql"] });
    expect(state.managerPhase).toBe("denied-before");
  });
});
