import { describe, expect, it } from "vitest";
import {
  checkItemCountingEvidence,
  checkManager,
  checkManagerPhases,
  FN_ARGS,
  inferManagerPhase,
  overTarget,
  statusLine,
  type FileRun,
  type GateInput,
  type PhaseRecord,
  type StatementResult,
} from "./itemCountingEvidence";
import { MEASURE_CASES, type MeasureResult, type MeasureRow, type RunMetrics } from "./measure-item-counting";

let idx = 0;
function res(command: string, rows: Array<Record<string, unknown>> = [], label = `stmt`): StatementResult {
  idx++;
  return {
    index: idx, line: idx, label, command, rowCount: rows.length,
    fields: rows[0] ? Object.keys(rows[0]) : [], rows, notices: [], ms: 1, error: null,
  };
}
const ev = (pairs: Array<[string, string]>) => pairs.map(([what, detail]) => ({ what, detail }));
const plan = [{ "QUERY PLAN": "Result" }, { "QUERY PLAN": "Execution Time: 3.2 ms" }];
const SCOPES = MEASURE_CASES.map((c) => c.scope);
/** Independent totals per scope (owner); AU-only manager sees 0 at uk/us. */
const TOTAL: Record<string, number> = { "au-busy-day": 1313, "au-3-months": 118244, "uk-day": 40, "uk-3-months": 3000, "us-day": 41, "us-3-months": 3100 };

function queryRun(managerAllSites = false, over: { fn?: Record<string, unknown>; grants?: Record<string, boolean> } = {}): FileRun {
  idx = 0;
  const results: StatementResult[] = [res("BEGIN")];
  results.push(res("SELECT", [{
    fn_name: "load_production_evidence", fn_args: FN_ARGS, fn_result: "json", fn_language: "sql", fn_volatility: "s",
    fn_security_definer: false, fn_config: 'search_path=""', fn_definition_md5: "abc", ...over.fn,
  }]));
  const grants = { PUBLIC: false, anon: false, authenticated: true, service_role: true, ...over.grants };
  results.push(res("SELECT", Object.entries(grants).map(([fn_grantee, can_execute]) => ({ fn_grantee, can_execute }))));
  results.push(res("SELECT", [{ total_size: "90 MB", rows: 240112 }]), res("ANALYZE"));
  for (const role of ["owner", "manager"]) {
    results.push(res("RESET"), res("SELECT", [{ become: "{}" }]), res("SET"));
    for (const scope of SCOPES) {
      for (const n of [1, 2, 3]) results.push(res("EXPLAIN", plan, `explain (analyze, buffers) select 'gate:call:${role}:${scope}:${n}' as gate,`));
      results.push(res("EXPLAIN", plan, `explain (analyze, buffers) select 'gate:body:${role}:${scope}:1' as gate, (`));
      const t = role === "manager" && !managerAllSites && !scope.startsWith("au") ? 0 : TOTAL[scope];
      results.push(res("SELECT", [{ role, scope, fn_row_count: t, window_rows: t, qualification_rows: 0, parent_rows: 0, later_rows: 0, independent_total: t }]));
    }
  }
  results.push(res("SELECT", [{ role: "staff", scope: "au-busy-day", fn_row_count: 0, window_rows: 0, qualification_rows: 0, parent_rows: 0, later_rows: 0, independent_total: 0 }]));
  results.push(res("SELECT", [{ empty_window_row_count: 0, reversed_window_is_null: true, blank_site_is_null: true, infinite_start_is_null: true }]));
  results.push(res("ROLLBACK"));
  return { file: "03-query-evidence.sql", statements: results.length, results };
}

function fullRuns(): FileRun[] {
  idx = 0;
  const sites: FileRun = {
    file: "01-sites.sql", statements: 3, results: [res("BEGIN"), res("SELECT", ev([
      ["locations", "au, staging, uk, us"], ["membership owner", "au, staging, uk, us"], ["membership kiosk", "au, staging, uk, us"],
      ["membership manager", "au, staging"], ["membership staff", "au, staging"], ["membership cs", "au, staging"],
      ["products per site", "au=10, uk=10, us=10"], ["barcodes", "5"],
    ])), res("COMMIT")],
  };
  const volume: FileRun = {
    file: "02-volume.sql", statements: 3, results: [res("BEGIN"), res("SELECT", ev([
      ["total synthetic rows", "240112"], ["rows at au", "160000"], ["rows at uk", "40000"], ["rows at us", "40000"],
      ["AU count rows 2026-08-01..2026-10-31 (production days)", "118226"], ["AU count rows on production day 2026-09-15", "1287"],
      ["tied timestamps (groups)", "9000"],
    ])), res("COMMIT")],
  };
  return [sites, volume, queryRun()];
}

function run(n: number, rows: number, over: Partial<RunMetrics> = {}): RunMetrics {
  return {
    run: n, error: null, requests: 1, evidenceCalls: 1, headersMs: 300, bodyMs: 200, rawBytes: rows * 170 + 100,
    wireBytes: null, contentEncoding: null, parseMs: 50, parseCalls: 1, loadMs: 700, validateMs: 150, reducerMs: 100,
    totalMs: 800, rows, inWindowRows: rows, ...over,
  };
}

function row(scope: string, over: Partial<MeasureRow> = {}, total = TOTAL[scope]): MeasureRow {
  const c = MEASURE_CASES.find((x) => x.scope === scope)!;
  return {
    label: c.label, scope, site: c.site, windowStartUtc: "a", windowEndUtc: "b", visibility: "site",
    serverCount: total, runs: [1, 2, 3].map((n) => run(n, total)), medianTotalMs: 800, firstTotalMs: 800, slowestTotalMs: 800,
    targetMs: c.targetMs, error: null, complete: true, withinTarget: true, ...over,
  };
}

function owner(): MeasureResult {
  return { email: "owner@x", role: "owner", sites: ["au", "uk", "us"], asOfUtc: "t", runs: 3, rows: SCOPES.map((s) => row(s)) };
}

function managerAuOnly(): MeasureResult {
  const denied = (s: string) => row(s, { visibility: "limited", serverCount: 0, runs: [1, 2, 3].map((n) => run(n, 0)) }, 0);
  return { email: "manager@x", role: "manager", sites: ["au", "staging"], asOfUtc: "t", runs: 3, rows: SCOPES.map((s) => (s.startsWith("au") ? row(s) : denied(s))) };
}

function managerAllSites(): MeasureResult {
  return { ...managerAuOnly(), sites: ["au", "staging", "uk", "us"], rows: SCOPES.map((s) => row(s)) };
}

const phases = (md5 = "abc"): PhaseRecord[] => [
  { phase: "denied-before", finishedAt: "2026-11-13T01:00:00Z", revision: "r", fnDefinitionMd5: md5, problems: [] },
  { phase: "all-sites", finishedAt: "2026-11-13T02:00:00Z", revision: "r", fnDefinitionMd5: md5, problems: [] },
  { phase: "denied-after", finishedAt: "2026-11-13T03:00:00Z", revision: "r", fnDefinitionMd5: md5, problems: [] },
];

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    mode: "full", runs: fullRuns(), measures: { owner: owner(), manager: managerAuOnly() },
    managerPhase: "denied-after", phaseRecords: phases(), ...over,
  };
}

describe("checkItemCountingEvidence", () => {
  it("passes complete, correct, within-target evidence with all three manager phases", () => {
    const problems = checkItemCountingEvidence(input());
    expect(problems).toEqual([]);
    expect(statusLine(problems)).toBe("STATUS: COMPLETE");
  });

  it("measure-only needs 03 but not 01/02", () => {
    expect(checkItemCountingEvidence(input({ mode: "measure-only", runs: [queryRun()] }))).toEqual([]);
    expect(checkItemCountingEvidence(input({ mode: "measure-only", runs: [] }))).toContain("03-query-evidence.sql: not run");
  });

  it("fails when 03 stopped early or the measurements did not run", () => {
    const runs = fullRuns();
    runs[2].results = runs[2].results.slice(-1);
    const problems = checkItemCountingEvidence(input({ runs, measures: { owner: undefined, manager: undefined } }));
    expect(problems.some((p) => /03-query-evidence.sql: only 1 of \d+ statements/.test(p))).toBe(true);
    expect(problems).toContain("measurement as owner: not run");
    expect(problems).toContain("measurement as manager: not run");
  });

  it("fails on a missing, definer, volatile or wrongly granted function", () => {
    const cases: Array<[Parameters<typeof queryRun>[1], RegExp]> = [
      [{ fn: { fn_security_definer: true } }, /SECURITY DEFINER/],
      [{ fn: { fn_volatility: "v" } }, /volatility is v/],
      [{ fn: { fn_config: "" } }, /search_path/],
      [{ fn: { fn_args: "p_site text" } }, /arguments are/],
      [{ grants: { anon: true } }, /EXECUTE for anon should be revoked/],
      [{ grants: { service_role: false } }, /EXECUTE for service_role should be granted/],
    ];
    for (const [over, re] of cases) {
      const runs = fullRuns();
      runs[2] = queryRun(false, over);
      expect(checkItemCountingEvidence(input({ runs })).some((p) => re.test(p)), String(re)).toBe(true);
    }
    const runs = fullRuns();
    runs[2].results = runs[2].results.filter((r) => !r.fields.includes("fn_name"));
    runs[2].statements = runs[2].results.length;
    expect(checkItemCountingEvidence(input({ runs })).some((p) => p.includes("apply migration 0034"))).toBe(true);
  });

  it("fails on a missing labelled plan, a plan without timing or a function/expectation mismatch", () => {
    const runs = fullRuns();
    const q = runs[2].results;
    q.splice(q.findIndex((r) => r.label.includes("gate:call:owner:au-3-months:2")), 1);
    q[q.findIndex((r) => r.label.includes("gate:body:manager:uk-day"))] = res("EXPLAIN", [{ "QUERY PLAN": "Result" }], "explain (analyze, buffers) select 'gate:body:manager:uk-day:1' as gate, (");
    const exp = q.find((r) => r.rows[0]?.scope === "us-day" && r.rows[0]?.role === "owner")!;
    exp.rows[0] = { ...exp.rows[0], fn_row_count: 40 };
    runs[2].statements = q.length;
    const problems = checkItemCountingEvidence(input({ runs }));
    expect(problems).toContain("03-query-evidence: query plan call:owner:au-3-months:2 is missing");
    expect(problems).toContain("03-query-evidence: query plan body:manager:uk-day:1 has no measured execution time");
    expect(problems).toContain("03-query-evidence: owner:us-day: the function returned 40 rows but the independent expectation is 41");
  });

  it("fails when any run errors, makes a second RPC, loads the wrong rows or lacks a metric", () => {
    const o = owner();
    o.rows[0].runs[0] = run(1, 1313, { error: "incomplete: boom", totalMs: null });
    o.rows[1].runs[1] = run(2, 118244, { evidenceCalls: 2 });
    o.rows[2].runs[2] = run(3, 39);
    o.rows[3].runs = o.rows[3].runs.slice(0, 2);
    o.rows[4].runs[0] = run(1, TOTAL["us-day"], { parseMs: null });
    const problems = checkItemCountingEvidence(input({ measures: { owner: o, manager: managerAuOnly() } }));
    expect(problems).toContain("measurement as owner: AU busy day run 1 errored (incomplete: boom)");
    expect(problems).toContain("measurement as owner: AU 3 months (busy) run 2 made 2 evidence RPCs, expected exactly 1");
    expect(problems).toContain("measurement as owner: UK day run 3 loaded 39 evidence rows but the independent expectation is 40");
    expect(problems).toContain("measurement as owner: UK 3 months has 2 of 3 runs");
    expect(problems).toContain("measurement as owner: US day run 1 has no parseMs measurement");
  });

  it("an early failing run is not hidden by later successful runs", () => {
    const o = owner();
    o.rows[1].runs[0] = run(1, 118000, { inWindowRows: 118000 });
    const problems = checkItemCountingEvidence(input({ measures: { owner: o, manager: managerAuOnly() } }));
    expect(problems.some((p) => p.includes("AU 3 months (busy) run 1 loaded 118000"))).toBe(true);
  });

  it("a missed latency target fails the gate", () => {
    const o = owner();
    o.rows[1] = { ...o.rows[1], medianTotalMs: 15000, withinTarget: false };
    const measures = { owner: o, manager: managerAuOnly() };
    const problems = checkItemCountingEvidence(input({ measures }));
    expect(problems).toContain("measurement as owner: AU 3 months (busy) median 15000 ms is over its 10000 ms target");
    expect(statusLine(problems)).toMatch(/^STATUS: FAILED – /);
    expect(overTarget(measures)[0]).toMatch(/^owner: AU 3 months \(busy\) median 15000 ms \(target 10000 ms/);
  });
});

describe("manager phases", () => {
  it("infers the phase from memberships and the recorded history", () => {
    expect(inferManagerPhase(["au", "staging"], [])).toBe("denied-before");
    expect(inferManagerPhase(["au", "staging", "uk", "us"], [])).toBe("all-sites");
    expect(inferManagerPhase(["au", "staging"], phases().slice(0, 2))).toBe("denied-after");
    expect(inferManagerPhase(["au", "uk"], [])).toBeNull();
  });

  it("AU-only: UK/US must be denied with no rows; all-sites: every site must be readable and timed", () => {
    expect(checkManager(managerAuOnly(), "denied-before", null).some((p) => p.includes("no independent SQL expectation"))).toBe(true);
    const leaky = managerAuOnly();
    leaky.rows[2] = row("uk-day");
    expect(checkManager(leaky, "denied-before", null).some((p) => p.includes("UK day should be denied with 0 rows"))).toBe(true);
    const stillDenied = managerAuOnly();
    expect(checkManager(stillDenied, "all-sites", null).some((p) => p.includes("UK day should be a site-wide read"))).toBe(true);
    const wrongRole = managerAllSites();
    wrongRole.role = "staff";
    expect(checkManager(wrongRole, "all-sites", null)).toContain("measurement as manager: signed-in user has role staff");
  });

  it("all three phases must be recorded, clean, in order and against the same function", () => {
    expect(checkManagerPhases(phases(), "abc")).toEqual([]);
    expect(checkManagerPhases(phases().slice(0, 1), "abc")).toEqual([
      "manager phase all-sites not recorded yet (CJ temporarily adds the manager to uk and us, then rerun with --measure-only)",
      "manager phase denied-after not recorded yet (CJ restores the manager to AU-only, then rerun with --measure-only)",
    ]);
    expect(checkManagerPhases(phases("old"), "abc")[0]).toMatch(/different function definition/);
    const failed = phases();
    failed[1] = { ...failed[1], problems: ["measurement as manager: UK day run 1 errored (x)"] };
    expect(checkManagerPhases(failed, "abc")[0]).toMatch(/^manager phase all-sites failed/);
    const outOfOrder = phases();
    outOfOrder[2] = { ...outOfOrder[2], finishedAt: "2026-11-13T00:30:00Z" };
    expect(checkManagerPhases(outOfOrder, "abc")).toContain("manager phase denied-after was recorded before all-sites");
  });

  it("the gate reports which phase is still missing", () => {
    const problems = checkItemCountingEvidence(input({ phaseRecords: phases().slice(0, 1), managerPhase: "denied-before" }));
    expect(problems.some((p) => p.startsWith("manager phase all-sites not recorded yet"))).toBe(true);
  });
});
