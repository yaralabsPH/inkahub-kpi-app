import { describe, expect, it } from "vitest";
import { checkItemCountingEvidence, overTarget, statusLine, type FileRun, type StatementResult } from "./itemCountingEvidence";
import type { MeasureResult, MeasureRow } from "./measure-item-counting";

function res(index: number, command: string, rows: Array<Record<string, unknown>> = [], fields?: string[]): StatementResult {
  return {
    index, line: index, label: `stmt ${index}`, command, rowCount: rows.length,
    fields: fields ?? (rows[0] ? Object.keys(rows[0]) : []), rows, notices: [], ms: 1, error: null,
  };
}
const ev = (pairs: Array<[string, string]>) => pairs.map(([what, detail]) => ({ what, detail }));
const plan = [{ "QUERY PLAN": "Limit ..." }, { "QUERY PLAN": "Execution Time: 3.2 ms" }];

function goodRuns(): FileRun[] {
  const sites = [
    res(1, "BEGIN"), res(2, "DO"),
    res(3, "INSERT"), res(4, "INSERT"), res(5, "INSERT"), res(6, "INSERT"), res(7, "INSERT"), res(8, "INSERT"),
    res(9, "SELECT", ev([
      ["locations", "au, staging, uk, us"],
      ["membership owner", "au, staging, uk, us"],
      ["membership kiosk", "au, staging, uk, us"],
      ["membership manager", "au, staging"],
      ["membership staff", "au, staging"],
      ["membership cs", "au, staging"],
      ["products per site", "au=10, uk=10, us=10"],
      ["barcodes", "5"],
    ])),
    res(10, "COMMIT"),
  ];
  const volume = [
    res(1, "BEGIN"), res(2, "DO"), res(3, "INSERT"), res(4, "INSERT"),
    res(5, "SELECT", ev([
      ["total synthetic rows", "240112"],
      ["rows at au", "160000"], ["rows at uk", "40000"], ["rows at us", "40000"],
      ["AU count rows 2026-08-01..2026-10-31 (production days)", "118226"],
      ["AU count rows on production day 2026-09-15", "1287"],
      ["tied timestamps (groups)", "9000"],
    ])),
    res(6, "COMMIT"),
  ];
  const query = [
    res(1, "BEGIN"),
    res(2, "SELECT", [{ indexname: "pkey", indexdef: "CREATE ..." }]),
    res(3, "SELECT", [{ total_size: "90 MB", rows: 240112 }]),
    res(4, "ANALYZE"), res(5, "SELECT", [{ set_config: "{}" }]), res(6, "SET"),
    ...[7, 8, 9, 10, 11, 12].map((i) => res(i, "EXPLAIN", plan)),
    res(13, "ROLLBACK"),
  ];
  return [
    { file: "01-sites.sql", statements: 10, results: sites },
    { file: "02-volume.sql", statements: 6, results: volume },
    { file: "03-query-evidence.sql", statements: 13, results: query },
  ];
}

function row(label: string, site: "au" | "uk" | "us", over: Partial<MeasureRow> = {}): MeasureRow {
  return {
    label, site, windowStartUtc: "a", windowEndUtc: "b", visibility: "site", serverCount: 10, loadedRows: 10,
    inWindowRows: 10, requests: 4, payloadBytes: 100, loadMs: 100, countMs: 5, targetMs: 2000,
    error: null, complete: true, withinTarget: true, ...over,
  };
}

function owner(): MeasureResult {
  return {
    email: "owner@x", role: "owner", sites: ["au", "uk", "us"], asOfUtc: "t", runs: 3,
    rows: [
      row("AU busy day", "au", { serverCount: 1287, inWindowRows: 1287 }),
      row("AU 3 months (busy)", "au", { serverCount: 118226, inWindowRows: 118226, targetMs: 10000 }),
      row("UK day", "uk"), row("UK 3 months", "uk"), row("US day", "us"), row("US 3 months", "us"),
    ],
  };
}

function manager(): MeasureResult {
  const none = { visibility: "limited" as const, serverCount: 0, loadedRows: 0, inWindowRows: 0 };
  return {
    email: "manager@x", role: "manager", sites: ["au"], asOfUtc: "t", runs: 3,
    rows: [
      row("AU busy day", "au"), row("AU 3 months (busy)", "au"),
      row("UK day", "uk", none), row("UK 3 months", "uk", none), row("US day", "us", none), row("US 3 months", "us", none),
    ],
  };
}

describe("checkItemCountingEvidence", () => {
  it("passes complete evidence", () => {
    const problems = checkItemCountingEvidence(goodRuns(), { owner: owner(), manager: manager() });
    expect(problems).toEqual([]);
    expect(statusLine(problems)).toBe("STATUS: COMPLETE");
  });

  it("fails when 03 stopped early (only the last result captured)", () => {
    const runs = goodRuns();
    runs[2].results = runs[2].results.slice(-1);
    const problems = checkItemCountingEvidence(runs, { owner: owner(), manager: manager() });
    expect(problems).toContain("03-query-evidence.sql: only 1 of 13 statements produced a result");
  });

  it("fails when the owner/manager measurements did not run", () => {
    const problems = checkItemCountingEvidence(goodRuns(), { owner: undefined, manager: undefined });
    expect(problems).toEqual(["measurement as owner: not run", "measurement as manager: not run"]);
    expect(statusLine(problems)).toBe("STATUS: FAILED – measurement as owner: not run (+1 more)");
  });

  it("fails on an empty result set, a failed statement or a missing file", () => {
    const runs = goodRuns();
    runs[2].results[1] = res(2, "SELECT", [], ["indexname", "indexdef"]);
    runs[1].results[2] = { ...res(3, "INSERT"), command: null, error: "statement timeout" };
    runs.shift();
    const problems = checkItemCountingEvidence(runs, { owner: owner(), manager: manager() });
    expect(problems).toContain("01-sites.sql: not run");
    expect(problems.some((p) => p.includes("02-volume.sql: statement 3") && p.includes("statement timeout"))).toBe(true);
    expect(problems.some((p) => p.includes("03-query-evidence.sql: statement 2") && p.includes("returned no rows"))).toBe(true);
  });

  it("fails when a plan has no measured execution time or volume is too small", () => {
    const runs = goodRuns();
    runs[2].results[7] = res(8, "EXPLAIN", [{ "QUERY PLAN": "Limit" }]);
    runs[1].results[4] = res(5, "SELECT", ev([["total synthetic rows", "5"]]));
    const problems = checkItemCountingEvidence(runs, { owner: owner(), manager: manager() });
    expect(problems.some((p) => p.includes("plan at line 8"))).toBe(true);
    expect(problems.some((p) => p.includes("AU three-month window must exceed 100,000"))).toBe(true);
  });

  it("fails on incomplete loads, wrong role and manager seeing UK rows", () => {
    const o = owner();
    o.rows[1] = { ...o.rows[1], inWindowRows: 99, complete: false, withinTarget: false };
    const m = manager();
    m.role = "staff";
    m.rows[2] = { ...m.rows[2], visibility: "site", serverCount: 4, loadedRows: 4 };
    const problems = checkItemCountingEvidence(goodRuns(), { owner: o, manager: m });
    expect(problems.some((p) => p.includes("AU 3 months (busy) loaded 99"))).toBe(true);
    expect(problems).toContain("measurement as manager: signed-in user has role staff");
    expect(problems.some((p) => p.includes("UK day should be limited with 0 rows"))).toBe(true);
  });

  it("reports missed latency targets separately from missing evidence", () => {
    const o = owner();
    o.rows[1] = { ...o.rows[1], loadMs: 15000, withinTarget: false };
    const measures = { owner: o, manager: manager() };
    expect(checkItemCountingEvidence(goodRuns(), measures)).toEqual([]);
    expect(overTarget(measures)).toEqual(["owner: AU 3 months (busy) took 15005 ms (target 10000 ms)"]);
  });
});
