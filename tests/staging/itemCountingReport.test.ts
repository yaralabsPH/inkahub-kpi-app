import { describe, expect, it } from "vitest";
import { buildReport, type GateState } from "./itemCountingReport";
import { rowsFromContentRange, type MeasureResult, type MeasureRow } from "./measure-item-counting";
import type { FileRun, StatementResult } from "./itemCountingEvidence";

function res(index: number, command: string, rows: Array<Record<string, unknown>> = []): StatementResult {
  return {
    index, line: index, label: `stmt ${index}`, command, rowCount: rows.length,
    fields: rows[0] ? Object.keys(rows[0]) : [], rows, notices: [], ms: 1, error: null,
  };
}

function row(label: string, over: Partial<MeasureRow> = {}): MeasureRow {
  return {
    label, site: "au", windowStartUtc: "a", windowEndUtc: "b", visibility: "site", serverCount: 1287, loadedRows: 1287,
    inWindowRows: 1287, requests: 6, payloadBytes: 100, loadMs: 900, countMs: 5, targetMs: 2000,
    error: null, complete: true, withinTarget: true, ...over,
  };
}

function partialOwner(rows: MeasureRow[]): MeasureResult {
  return { email: "owner@x", role: "owner", sites: ["au", "uk", "us"], asOfUtc: "t", runs: 3, rows };
}

function state(over: Partial<GateState> = {}): GateState {
  const sites: FileRun = { file: "01-sites.sql", statements: 2, results: [res(1, "BEGIN"), res(2, "SELECT", [{ what: "locations", detail: "au" }])] };
  return {
    startedAt: "2026-11-12T00:00:00Z", revision: "abc1234", runs: [sites],
    measures: { owner: undefined, manager: undefined },
    current: null, lastProgress: null, stopped: null, fatal: null, finishedAt: null, ...over,
  };
}

const lastLine = (md: string) => md.trimEnd().split("\n").at(-1);

describe("buildReport", () => {
  it("a mid-run report keeps finished results and ends FAILED", () => {
    const r = buildReport(state({
      current: "measuring as owner · case 2/6 AU 3 months (busy) · run 1/3",
      lastProgress: "owner · run 1/3 · 4m10s · 300 requests",
      measures: { owner: partialOwner([row("AU busy day")]), manager: undefined },
    }));
    expect(r.markdown).toContain("| locations | au |");
    expect(r.markdown).toContain("| AU busy day |");
    expect(r.markdown).toContain("(1 of 6 cases finished)");
    expect(r.markdown).toContain("4m10s · 300 requests");
    expect(lastLine(r.markdown)).toBe(r.status);
    expect(r.status).toMatch(/^STATUS: FAILED – run not finished: measuring as owner · case 2\/6/);
  });

  it("a stopped run says where it stopped", () => {
    const r = buildReport(state({ current: "measuring as owner · case 2/6 AU 3 months (busy) · run 1/3", stopped: "SIGINT received" }));
    expect(r.status).toMatch(/^STATUS: FAILED – stopped during measuring as owner · case 2\/6 .* \(SIGINT received\); partial evidence only/);
    expect(r.markdown).toContain("stopped during: measuring as owner");
  });

  it("keeps finished over-target cases even when evidence is incomplete", () => {
    const slow = row("AU busy day", { loadMs: 9000, withinTarget: false });
    const r = buildReport(state({ current: "measuring as owner · case 2/6", measures: { owner: partialOwner([slow]), manager: undefined } }));
    expect(r.slow).toEqual(["owner: AU busy day took 9005 ms (target 2000 ms)"]);
    expect(r.markdown).toContain("- OVER TARGET: owner: AU busy day took 9005 ms");
  });

  it("a finished run with a settings error ends FAILED with that error first", () => {
    const r = buildReport(state({ runs: [], fatal: ".env.staging.local not found in the repo root.", finishedAt: "t" }));
    expect(r.status).toMatch(/^STATUS: FAILED – \.env\.staging\.local not found/);
    expect(r.markdown).not.toContain("## Progress");
  });
});

describe("rowsFromContentRange", () => {
  it("reads PostgREST ranges", () => {
    expect(rowsFromContentRange("0-499/*")).toBe(500);
    expect(rowsFromContentRange("500-512/*")).toBe(13);
    expect(rowsFromContentRange("*/0")).toBe(0);
    expect(rowsFromContentRange(null)).toBe(0);
  });
});
