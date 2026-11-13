import { describe, expect, it } from "vitest";
import { prePolicies } from "./gateTestFixtures";
import {
  checkItemCountingEvidence,
  checkManager,
  checkManagerPhases,
  FN_ARGS,
  HARNESS_VERSION,
  inferManagerPhase,
  phaseMatchesMemberships,
  settingMs,
  V1_FUNCTION,
  V2_FUNCTION,
  overTarget,
  statusLine,
  type FileRun,
  type GateInput,
  type PhaseRecord,
  type StatementResult,
} from "./itemCountingEvidence";
import { MEASURE_CASES, type MeasureResult, type MeasureRow, type RunMetrics } from "./measure-item-counting";
import { claimsRow, claimsSources, gateIdentity, parityArtifact, policyCatalogRows } from "./gateTestFixtures";

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

const DAYS = MEASURE_CASES.filter((c) => c.first === c.last).map((c) => c.scope);

interface QueryOver {
  policies?: Parameters<typeof policyCatalogRows>[0];
  claims?: Record<string, unknown>;
  fn?: Record<string, unknown>;
  grants?: Record<string, boolean>;
  timeout?: Record<string, unknown>;
}

function timeoutRow(who: string, over: Record<string, unknown> = {}) {
  return {
    timeout_for: who, current_user_name: "authenticated", session_user_name: "postgres", effective_timeout_ms: 8000,
    effective_timeout: "8s", catalog_timeout: "8s", authenticated_config: "statement_timeout=8s", authenticator_config: "",
    anon_config: "statement_timeout=3s", row_security: "on", work_mem: "2184kB", jwt_sub: "x", server_version: "PostgreSQL 17", ...over,
  };
}

function fieldRow(role: string, scope: string, total: number) {
  return { role, scope, decoded_rows: total, only_in_function: 0, only_in_table: 0, staff_entries: 3, expected_staff: 3, sku_entries: 9, expected_skus: 9 };
}

function queryRun(managerAllSites = false, over: QueryOver = {}): FileRun {
  idx = 0;
  const results: StatementResult[] = [res("BEGIN")];
  for (const name of [V2_FUNCTION, V1_FUNCTION]) {
    results.push(res("SELECT", [{
      fn_name: name, fn_args: FN_ARGS, fn_result: "json", fn_language: "sql", fn_volatility: "s",
      fn_security_definer: false, fn_config: 'search_path=""', fn_definition_md5: name === V2_FUNCTION ? "abc" : "v1md5",
      ...(name === V2_FUNCTION ? over.fn : {}),
    }]));
    const grants = { PUBLIC: false, anon: false, authenticated: true, service_role: true, ...(name === V2_FUNCTION ? over.grants : {}) };
    results.push(res("SELECT", Object.entries(grants).map(([fn_grantee, can_execute]) => ({ fn_privileges_for: name, fn_grantee, can_execute }))));
  }
  results.push(res("SELECT", policyCatalogRows(over.policies)));
  results.push(res("SELECT", [{ total_size: "90 MB", rows: 240112 }]));
  const become = (who: string) => results.push(res("RESET"), res("SELECT", [{ claims_set: true, legacy_cleared: true }]),
    res("SELECT", [claimsRow(who, who === "manager" ? over.claims : {})]), res("SET"), res("DO"),
    res("SELECT", [timeoutRow(who, who === "manager" ? over.timeout : {})]));
  for (const role of ["owner", "manager"]) {
    become(role);
    for (const scope of SCOPES) {
      for (const n of [1, 2, 3]) results.push(res("EXPLAIN", plan, `explain (analyze, buffers) select 'gate:call:${role}:${scope}:${n}' as gate,`));
      results.push(res("EXPLAIN", plan, `explain (analyze, buffers) select 'gate:body:${role}:${scope}:1' as gate, (`));
      for (const n of [1, 2, 3]) results.push(res("SELECT", [{ gate: `gate:text:${role}:${scope}:${n}`, body_bytes: 5000, effective_timeout: "8s" }], "WITH pgrst_source AS ("));
      const t = role === "manager" && !managerAllSites && !scope.startsWith("au") ? 0 : TOTAL[scope];
      results.push(res("SELECT", [{ role, scope, fn_row_count: t }]));
      results.push(res("SELECT", [{ role, scope, window_rows: t, qualification_rows: 0, parent_rows: 0, later_rows: 0, independent_total: t }]));
      if (DAYS.includes(scope)) results.push(res("SELECT", [fieldRow(role, scope, t)]));
    }
  }
  become("staff");
  results.push(res("SELECT", [{ role: "staff", scope: "au-busy-day", fn_row_count: 0 }]));
  results.push(res("SELECT", [{ role: "staff", scope: "au-busy-day", window_rows: 0, qualification_rows: 0, parent_rows: 0, later_rows: 0, independent_total: 0 }]));
  results.push(res("SELECT", [{ ...fieldRow("staff", "au-busy-day", 0), staff_entries: 0, expected_staff: 0, sku_entries: 0, expected_skus: 0 }]));
  become("owner");
  results.push(res("SELECT", [{
    empty_window_row_count: 0, empty_window_body: '{"version" : 2, "staffIds" : [], "skus" : [], "rows" : []}',
    reversed_window_is_null: true, blank_site_is_null: true, infinite_start_is_null: true,
  }]));
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
    run: n, error: null, requests: 1, evidenceCalls: 1, otherEvidenceCalls: 0, headersMs: 300, bodyMs: 200, rawBytes: rows * 170 + 100,
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

const ID = gateIdentity("abc");
const rec = (phase: PhaseRecord["phase"], finishedAt: string, over: Partial<PhaseRecord> = {}): PhaseRecord => ({
  phase, finishedAt, revision: "r", fnName: ID.fnName, fnDefinitionMd5: ID.fnDefinitionMd5,
  encodingVersion: ID.encodingVersion, harnessVersion: ID.harnessVersion, policyHash: ID.policyHash, parityHash: ID.parityHash,
  problems: [], ...over,
});
const phases = (over: Partial<PhaseRecord> = {}): PhaseRecord[] => [
  rec("denied-before", "2026-11-13T01:00:00Z", over),
  rec("all-sites", "2026-11-13T02:00:00Z", over),
  rec("denied-after", "2026-11-13T03:00:00Z", over),
];

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    mode: "full", runs: fullRuns(), measures: { owner: owner(), manager: managerAuOnly() },
    managerPhase: "denied-after", phaseRecords: phases(), extras: { claimsSources: claimsSources(), parity: parityArtifact() }, ...over,
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
  it("infers the phase from memberships and this identity's history only", () => {
    expect(inferManagerPhase(["au", "staging"], [], ID)).toBe("denied-before");
    expect(inferManagerPhase(["au", "staging", "uk", "us"], [], ID)).toBe("all-sites");
    expect(inferManagerPhase(["au", "staging"], phases().slice(0, 2), ID)).toBe("denied-after");
    // A v1 / old-harness all-sites record does not move a fresh run to denied-after.
    expect(inferManagerPhase(["au", "staging"], [rec("all-sites", "t", { fnName: V1_FUNCTION, encodingVersion: 1 })], ID)).toBe("denied-before");
    expect(inferManagerPhase(["au", "uk"], [], ID)).toBeNull();
  });

  it("an explicit phase must match the real memberships", () => {
    expect(phaseMatchesMemberships("all-sites", ["au", "uk", "us", "staging"])).toBe(true);
    expect(phaseMatchesMemberships("all-sites", ["au", "staging"])).toBe(false);
    expect(phaseMatchesMemberships("denied-after", ["au", "staging"])).toBe(true);
    expect(phaseMatchesMemberships("denied-before", ["au", "uk", "us"])).toBe(false);
  });

  it("AU-only: UK/US must be denied with no rows; all-sites: every site must be readable and timed", () => {
    expect(checkManager(managerAuOnly(), "denied-before", null).some((p) => p.includes("no independent SQL expectation"))).toBe(true);
    const leaky = managerAuOnly();
    leaky.rows[2] = row("uk-day");
    expect(checkManager(leaky, "denied-before", null).some((p) => p.includes("UK day should be denied with 0 rows"))).toBe(true);
    expect(checkManager(managerAuOnly(), "all-sites", null).some((p) => p.includes("UK day should be a site-wide read"))).toBe(true);
    const wrongRole = managerAllSites();
    wrongRole.role = "staff";
    expect(checkManager(wrongRole, "all-sites", null)).toContain("measurement as manager: signed-in user has role staff");
  });

  it("all three phases must be recorded, clean and in order for this exact v2 identity", () => {
    expect(checkManagerPhases(phases(), ID)).toEqual([]);
    expect(checkManagerPhases(phases().slice(0, 1), ID)).toEqual([
      "manager phase all-sites not recorded yet (add the manager to uk and us, then run --measure-only --manager-phase=all-sites)",
      "manager phase denied-after not recorded yet (restore the manager to AU-only, then run --measure-only --manager-phase=denied-after)",
    ]);
    const stale: Array<Partial<PhaseRecord>> = [
      { fnDefinitionMd5: "other" }, { fnName: V1_FUNCTION }, { encodingVersion: 1 }, { harnessVersion: "old" }, { fnName: undefined },
      { policyHash: "pre-0036" }, { parityHash: undefined },
    ];
    for (const old of stale) {
      expect(checkManagerPhases(phases(old), ID).length, JSON.stringify(old)).toBe(3);
    }
    const outOfOrder = phases();
    outOfOrder[2] = { ...outOfOrder[2], finishedAt: "2026-11-13T00:30:00Z" };
    expect(checkManagerPhases(outOfOrder, ID)).toContain("manager phase denied-after was recorded before all-sites");
    expect(checkManagerPhases(phases(), null)).toEqual(["manager phases cannot be checked: the v2 function identity is unknown"]);
  });

  it("a gate missing only later phases says so as expected, not as a query failure", () => {
    const problems = checkItemCountingEvidence(input({ phaseRecords: phases().slice(0, 1), managerPhase: "denied-before" }));
    expect(problems.every((p) => p.startsWith("manager phase "))).toBe(true);
    expect(statusLine(problems)).toBe("STATUS: FAILED – awaiting manager phases all-sites, denied-after (expected; no query or performance failure)");
    expect(statusLine(["manager phase all-sites not recorded yet (x)", "measurement as owner: AU 3 months (busy) run 1 errored (x)"]))
      .toMatch(/^STATUS: FAILED – manager phase all-sites/);
  });
});

describe("SQL evidence rules", () => {
  it("reads time settings in any PostgreSQL unit", () => {
    expect([settingMs("8s"), settingMs("8000"), settingMs("8000ms"), settingMs("1min"), settingMs("0")]).toEqual([8000, 8000, 8000, 60000, 0]);
    expect(settingMs("eight")).toBeNaN();
  });

  it("fails when the role timeout is missing, raised, not applied, or RLS is off", () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ catalog_timeout: "30s", effective_timeout_ms: 30000 }, /catalog statement_timeout is 30s, expected the unchanged 8s/],
      [{ catalog_timeout: null }, /expected the unchanged 8s/],
      [{ effective_timeout_ms: 120000 }, /effective statement_timeout 120000 ms does not match/],
      [{ catalog_timeout: "8s,9s" }, /more than one statement_timeout/],
      [{ current_user_name: "postgres" }, /measured as postgres/],
      [{ row_security: "off" }, /row_security is off/],
    ];
    for (const [timeout, re] of cases) {
      const runs = fullRuns();
      runs[2] = queryRun(false, { timeout });
      expect(checkItemCountingEvidence(input({ runs })).some((p) => re.test(p)), String(re)).toBe(true);
    }
    const runs = fullRuns();
    runs[2].results = runs[2].results.filter((r) => !(r.fields.includes("timeout_for") && r.rows[0].timeout_for === "staff"));
    runs[2].statements = runs[2].results.length;
    expect(checkItemCountingEvidence(input({ runs })).some((p) => p.includes("expected owner,manager,staff,owner"))).toBe(true);
  });

  it("fails on missing or duplicated full-body text runs, an empty body or a field mismatch", () => {
    const runs = fullRuns();
    const q = runs[2].results;
    q.splice(q.findIndex((r) => r.rows[0]?.gate === "gate:text:owner:au-3-months:2"), 1);
    const dup = q.find((r) => r.rows[0]?.gate === "gate:text:manager:uk-day:1")!;
    q.push({ ...dup, index: 999 });
    const empty = q.find((r) => r.rows[0]?.gate === "gate:text:owner:us-day:3")!;
    empty.rows = [{ ...empty.rows[0], body_bytes: 0 }];
    const field = q.find((r) => r.fields.includes("only_in_function") && r.rows[0].role === "manager" && r.rows[0].scope === "au-busy-day")!;
    field.rows = [{ ...field.rows[0], only_in_table: 2, sku_entries: 10 }];
    runs[2].statements = q.length;
    const problems = checkItemCountingEvidence(input({ runs }));
    expect(problems).toContain("03-query-evidence: full-body text run owner:au-3-months:2 is missing");
    expect(problems).toContain("03-query-evidence: full-body text run manager:uk-day:1 appears more than once");
    expect(problems).toContain("03-query-evidence: full-body text run owner:us-day:3 produced no body");
    expect(problems).toContain("03-query-evidence: manager:au-busy-day: decoded rows differ from the table (0 only in the function, 2 only in the table)");
    expect(problems).toContain("03-query-evidence: manager:au-busy-day: SKU dictionary has 10 entries, expected 9");
  });

  it("v1 must stay in place with its grants, and the empty window must return empty dictionaries", () => {
    const runs = fullRuns();
    runs[2].results = runs[2].results.filter((r) => r.rows[0]?.fn_name !== V1_FUNCTION);
    const small = runs[2].results.find((r) => r.fields.includes("empty_window_row_count"))!;
    small.rows = [{ ...small.rows[0], empty_window_body: '{"staffIds" : ["x"], "skus" : []}' }];
    runs[2].statements = runs[2].results.length;
    const problems = checkItemCountingEvidence(input({ runs }));
    expect(problems.some((p) => p.includes("load_production_evidence was not found (apply migration 0034"))).toBe(true);
    expect(problems).toContain("03-query-evidence: empty window must return empty staffIds and skus dictionaries");
  });

  it("a run calling the old v1 RPC fails", () => {
    const o = owner();
    o.rows[0].runs[1] = run(2, TOTAL["au-busy-day"], { otherEvidenceCalls: 1 });
    expect(checkItemCountingEvidence(input({ measures: { owner: o, manager: managerAuOnly() } })))
      .toContain("measurement as owner: AU busy day run 2 called another evidence RPC (v1 fallback?) 1 time(s)");
  });
});

describe("policy and real-session claims evidence", () => {
  it("fails on minimal claims, a size/shape mismatch or a wrong subject", () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ claims_bytes: 74 }, /manager: SQL claims are 74 bytes but the session's are \d+/],
      [{ claims_shape: "role:string,sub:string" }, /manager: SQL claims shape differs/],
      [{ claims_subject_ok: false }, /manager: claims subject ok is not true/],
      [{ legacy_overrides_empty: false }, /manager: legacy overrides empty is not true/],
      [{ profile_role: "staff" }, /manager: the session's profile role is staff/],
    ];
    for (const [claims, re] of cases) {
      const runs = fullRuns();
      runs[2] = queryRun(false, { claims });
      expect(checkItemCountingEvidence(input({ runs })).some((p) => re.test(p)), String(re)).toBe(true);
    }
    const missing = checkItemCountingEvidence(input({ extras: { claimsSources: {}, parity: parityArtifact() } }));
    expect(missing).toContain("03-query-evidence: owner: no real session claims were supplied");
  });

  it("fails when the policies are still the pre-0036 ones, or parity is missing or for other policies", () => {
    const runs = fullRuns();
    runs[2] = queryRun(false, { policies: prePolicies() });
    const p = checkItemCountingEvidence(input({ runs }));
    expect(p).toContain("03-query-evidence: policy production_events_read still calls can_access_location per row");
    expect(p.some((x) => x.includes("captured under different policies"))).toBe(true);
    expect(checkItemCountingEvidence(input({ extras: { claimsSources: claimsSources(), parity: null } })).some((x) => x.includes("policy parity has not been run"))).toBe(true);
  });

  it("phases recorded under the old policies (no policy hash) don't count", () => {
    const old = phases({ policyHash: undefined, parityHash: undefined });
    expect(checkManagerPhases(old, ID)).toHaveLength(3);
  });
});
