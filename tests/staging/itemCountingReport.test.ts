import { describe, expect, it } from "vitest";
import { buildReport, type GateState } from "./itemCountingReport";
import { MEASURE_CASES, type MeasureResult, type MeasureRow, type RunMetrics } from "./measure-item-counting";
import type { FileRun, StatementResult } from "./itemCountingEvidence";

function res(index: number, command: string, rows: Array<Record<string, unknown>> = []): StatementResult {
  return {
    index, line: index, label: `stmt ${index}`, command, rowCount: rows.length,
    fields: rows[0] ? Object.keys(rows[0]) : [], rows, notices: [], ms: 1, error: null,
  };
}

function run(n: number, over: Partial<RunMetrics> = {}): RunMetrics {
  return {
    run: n, error: null, requests: 1, evidenceCalls: 1, headersMs: 300, bodyMs: 200, rawBytes: 250_000, wireBytes: 40_000,
    contentEncoding: "gzip", parseMs: 20, parseCalls: 1, loadMs: 700, validateMs: 180, reducerMs: 90, totalMs: 790,
    rows: 1313, inWindowRows: 1287, ...over,
  };
}

function row(scope: string, over: Partial<MeasureRow> = {}): MeasureRow {
  const c = MEASURE_CASES.find((x) => x.scope === scope)!;
  return {
    label: c.label, scope, site: c.site, windowStartUtc: "a", windowEndUtc: "b", visibility: "site", serverCount: 1287,
    runs: [run(1), run(2), run(3)], medianTotalMs: 790, firstTotalMs: 790, slowestTotalMs: 790, targetMs: c.targetMs,
    error: null, complete: true, withinTarget: true, ...over,
  };
}

function partialOwner(rows: MeasureRow[]): MeasureResult {
  return { email: "owner@x", role: "owner", sites: ["au", "uk", "us"], asOfUtc: "t", runs: 3, rows };
}

function state(over: Partial<GateState> = {}): GateState {
  const sites: FileRun = { file: "01-sites.sql", statements: 2, results: [res(1, "BEGIN"), res(2, "SELECT", [{ what: "locations", detail: "au" }])] };
  return {
    startedAt: "2026-11-13T00:00:00Z", revision: "abc1234", mode: "full", runs: [sites],
    measures: { owner: undefined, manager: undefined }, managerPhase: null, phaseRecords: [],
    current: null, lastProgress: null, stopped: null, fatal: null, finishedAt: null, ...over,
  };
}

const lastLine = (md: string) => md.trimEnd().split("\n").at(-1);

describe("buildReport", () => {
  it("a mid-run report keeps finished results, per-run metrics, and ends FAILED", () => {
    const r = buildReport(state({
      current: "measuring as owner · case 2/6 AU 3 months (busy) · run 1/3",
      lastProgress: "owner · run 1/3 · 0m04s · receiving · 12.0 MB received",
      measures: { owner: partialOwner([row("au-busy-day")]), manager: undefined },
    }));
    expect(r.markdown).toContain("| locations | au |");
    expect(r.markdown).toContain("| AU busy day |");
    expect(r.markdown).toContain("| AU busy day | 1 | 1 | 1 | 1313 | 1287 | 0.2 MB | 0.0 MB | gzip | 300 | 200 | 20 | 180 | 700 | 90 | 790 |");
    expect(r.markdown).toContain("(1 of 6 cases finished)");
    expect(r.markdown).toContain("12.0 MB received");
    expect(lastLine(r.markdown)).toBe(r.status);
    expect(r.status).toMatch(/^STATUS: FAILED – run not finished: measuring as owner · case 2\/6/);
  });

  it("a stopped run says where it stopped", () => {
    const r = buildReport(state({ current: "measuring as owner · case 2/6 AU 3 months (busy) · run 1/3", stopped: "SIGINT received" }));
    expect(r.status).toMatch(/^STATUS: FAILED – stopped during measuring as owner · case 2\/6 .* \(SIGINT received\); partial evidence only/);
    expect(r.markdown).toContain("stopped during: measuring as owner");
  });

  it("keeps finished over-target cases even when evidence is incomplete", () => {
    const slow = row("au-busy-day", { medianTotalMs: 9000, slowestTotalMs: 9500, withinTarget: false });
    const r = buildReport(state({ current: "measuring as owner · case 2/6", measures: { owner: partialOwner([slow]), manager: undefined } }));
    expect(r.slow).toEqual(["owner: AU busy day median 9000 ms (target 2000 ms; first 790, slowest 9500)"]);
    expect(r.markdown).toContain("- OVER TARGET: owner: AU busy day median 9000 ms");
  });

  it("shows the manager phase table and a settings error first", () => {
    const r = buildReport(state({
      runs: [], fatal: ".env.staging.local not found in the repo root.", finishedAt: "t",
      phaseRecords: [{ phase: "denied-before", finishedAt: "2026-11-13T01:00:00Z", revision: "r1", fnDefinitionMd5: "abc", problems: [] }],
    }));
    expect(r.status).toMatch(/^STATUS: FAILED – \.env\.staging\.local not found/);
    expect(r.markdown).toContain("| denied-before | 2026-11-13T01:00:00Z | r1 | passed |");
    expect(r.markdown).toContain("| all-sites | – | – | not recorded |");
    expect(r.markdown).not.toContain("## Progress");
  });
});
