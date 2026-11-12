/**
 * Pure checks for the item-counting staging evidence: decide whether every
 * expected result was captured. Kept free of I/O so it can be unit-tested.
 */
import type { MeasureResult } from "./measure-item-counting";

export interface StatementResult {
  index: number;
  line: number;
  label: string;
  /** pg command tag, e.g. SELECT, INSERT, EXPLAIN, BEGIN. */
  command: string | null;
  rowCount: number | null;
  fields: string[];
  rows: Array<Record<string, unknown>>;
  notices: string[];
  ms: number;
  error: string | null;
}

export interface FileRun {
  file: string;
  /** Statements found in the script. */
  statements: number;
  results: StatementResult[];
}

export type MeasureOutcome = MeasureResult | { error: string } | undefined;

export const SQL_FILES = ["01-sites.sql", "02-volume.sql", "03-query-evidence.sql"] as const;

const RETURNS_ROWS = new Set(["SELECT", "EXPLAIN", "SHOW"]);

function lastSelect(run: FileRun): StatementResult | undefined {
  return [...run.results].reverse().find((r) => r.command === "SELECT");
}

function evidenceMap(r: StatementResult | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const row of r?.rows ?? []) m.set(String(row.what), String(row.detail));
  return m;
}

function listHas(detail: string | undefined, sites: string[]): boolean {
  if (detail === undefined) return false;
  const have = new Set(detail.split(",").map((s) => s.trim()));
  return sites.every((s) => have.has(s));
}

function num(detail: string | undefined): number {
  const n = Number(detail);
  return Number.isFinite(n) ? n : NaN;
}

function checkSites(run: FileRun, problems: string[]): void {
  const ev = evidenceMap(lastSelect(run));
  if (!listHas(ev.get("locations"), ["au", "uk", "us", "staging"])) problems.push("01-sites: locations au, uk, us and staging are not all present");
  for (const who of ["owner", "kiosk"]) {
    if (!listHas(ev.get(`membership ${who}`), ["au", "uk", "us"])) problems.push(`01-sites: ${who} is not a member of au, uk and us`);
  }
  for (const who of ["manager", "staff", "cs"]) {
    const d = ev.get(`membership ${who}`);
    if (!listHas(d, ["au"])) problems.push(`01-sites: ${who} is not a member of au`);
    if (listHas(d, ["uk"]) || listHas(d, ["us"])) problems.push(`01-sites: ${who} must be AU-only but has UK/US membership`);
  }
  if (!listHas(ev.get("products per site"), ["au=10", "uk=10", "us=10"])) problems.push("01-sites: expected 10 test products at each of au, uk, us");
  if (!(num(ev.get("barcodes")) > 0)) problems.push("01-sites: no worker barcodes were created");
}

function checkVolume(run: FileRun, problems: string[]): void {
  const ev = evidenceMap(lastSelect(run));
  const total = num(ev.get("total synthetic rows"));
  const quarter = num(ev.get("AU count rows 2026-08-01..2026-10-31 (production days)"));
  const day = num(ev.get("AU count rows on production day 2026-09-15"));
  const tied = num(ev.get("tied timestamps (groups)"));
  if (!(total >= 235_732)) problems.push(`02-volume: expected at least 235,732 synthetic rows, got ${ev.get("total synthetic rows") ?? "nothing"}`);
  if (!(quarter > 100_000)) problems.push(`02-volume: AU three-month window must exceed 100,000 rows, got ${ev.get("AU count rows 2026-08-01..2026-10-31 (production days)") ?? "nothing"}`);
  if (!(day > 1_000)) problems.push(`02-volume: AU busy day must exceed 1,000 rows, got ${ev.get("AU count rows on production day 2026-09-15") ?? "nothing"}`);
  if (!(tied > 0)) problems.push("02-volume: no tied timestamps were generated");
  for (const site of ["au", "uk", "us"]) {
    if (!(num(ev.get(`rows at ${site}`)) > 0)) problems.push(`02-volume: no synthetic rows at ${site}`);
  }
}

function checkQueryEvidence(run: FileRun, problems: string[]): void {
  const indexes = run.results.find((r) => r.fields.includes("indexdef"));
  if (!indexes || indexes.rows.length === 0) problems.push("03-query-evidence: index definitions are missing");
  const size = run.results.find((r) => r.fields.includes("total_size"));
  if (!size || size.rows.length === 0) problems.push("03-query-evidence: table size/row count is missing");
  const explains = run.results.filter((r) => r.command === "EXPLAIN");
  if (explains.length !== 6) problems.push(`03-query-evidence: expected 6 query plans, got ${explains.length}`);
  explains.forEach((r) => {
    const text = r.rows.map((row) => Object.values(row).join(" ")).join("\n");
    if (!/Execution Time/.test(text)) problems.push(`03-query-evidence: plan at line ${r.line} has no measured execution time`);
  });
}

function checkMeasure(who: "owner" | "manager", m: MeasureOutcome, problems: string[]): void {
  if (!m) {
    problems.push(`measurement as ${who}: not run`);
    return;
  }
  if ("error" in m) {
    problems.push(`measurement as ${who}: failed (${m.error})`);
    return;
  }
  if (m.role !== who) problems.push(`measurement as ${who}: signed-in user has role ${m.role ?? "unknown"}`);
  if (m.rows.length !== 6) problems.push(`measurement as ${who}: expected 6 cases, got ${m.rows.length}`);
  for (const r of m.rows) {
    if (r.error) problems.push(`measurement as ${who}: ${r.label} errored (${r.error})`);
    else if (!r.complete) problems.push(`measurement as ${who}: ${r.label} loaded ${r.inWindowRows} in-window rows but the server counts ${r.serverCount}`);
    if (r.loadMs === null && !r.error) problems.push(`measurement as ${who}: ${r.label} has no timing`);
  }
  const au = m.rows.filter((r) => r.site === "au");
  if (who === "owner") {
    for (const r of m.rows) if (r.visibility !== "site") problems.push(`measurement as owner: ${r.label} visibility is ${r.visibility}, expected site`);
    const quarter = m.rows.find((r) => r.label.startsWith("AU 3 months"));
    const day = m.rows.find((r) => r.label === "AU busy day");
    if (!quarter || !((quarter.serverCount ?? 0) > 100_000)) problems.push("measurement as owner: AU three-month read did not cover more than 100,000 rows");
    if (!day || !((day.serverCount ?? 0) > 1_000)) problems.push("measurement as owner: AU busy-day read did not cover more than 1,000 rows");
  } else {
    for (const r of au) {
      if (r.visibility !== "site" || !((r.serverCount ?? 0) > 0)) problems.push(`measurement as manager: ${r.label} should be a site-wide read with rows`);
    }
    for (const r of m.rows.filter((x) => x.site !== "au")) {
      if (r.visibility !== "limited" || r.serverCount !== 0 || r.loadedRows !== 0) {
        problems.push(`measurement as manager: ${r.label} should be limited with 0 rows (got ${r.visibility}, ${r.serverCount ?? "?"} server / ${r.loadedRows} loaded)`);
      }
    }
  }
}

/** Every missing or wrong item; empty means the evidence is complete. */
export function checkItemCountingEvidence(
  runs: FileRun[],
  measures: { owner: MeasureOutcome; manager: MeasureOutcome },
): string[] {
  const problems: string[] = [];
  for (const file of SQL_FILES) {
    const run = runs.find((r) => r.file === file);
    if (!run) {
      problems.push(`${file}: not run`);
      continue;
    }
    const failed = run.results.find((r) => r.error);
    if (failed) problems.push(`${file}: statement ${failed.index} (line ${failed.line}, "${failed.label}") failed: ${failed.error}`);
    if (run.results.length !== run.statements) {
      problems.push(`${file}: only ${run.results.length} of ${run.statements} statements produced a result`);
    }
    for (const r of run.results) {
      if (!r.error && r.command !== null && RETURNS_ROWS.has(r.command) && r.rows.length === 0) {
        problems.push(`${file}: statement ${r.index} (line ${r.line}, "${r.label}") returned no rows`);
      }
    }
    if (failed || run.results.length !== run.statements) continue;
    if (file === "01-sites.sql") checkSites(run, problems);
    if (file === "02-volume.sql") checkVolume(run, problems);
    if (file === "03-query-evidence.sql") checkQueryEvidence(run, problems);
  }
  checkMeasure("owner", measures.owner, problems);
  checkMeasure("manager", measures.manager, problems);
  return problems;
}

/** Cases with valid timing that missed their latency target. */
export function overTarget(measures: { owner: MeasureOutcome; manager: MeasureOutcome }): string[] {
  const out: string[] = [];
  for (const [who, m] of Object.entries(measures)) {
    if (!m || "error" in m) continue;
    for (const r of m.rows) {
      if (r.complete && r.loadMs !== null && !r.withinTarget) {
        out.push(`${who}: ${r.label} took ${r.loadMs + (r.countMs ?? 0)} ms (target ${r.targetMs} ms)`);
      }
    }
  }
  return out;
}

export function statusLine(problems: string[]): string {
  return problems.length === 0 ? "STATUS: COMPLETE" : `STATUS: FAILED – ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}`;
}
