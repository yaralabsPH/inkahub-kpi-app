/**
 * Pure checks for the item-counting staging evidence: decide whether every
 * expected result was captured AND passes. Kept free of I/O so it can be
 * unit-tested.
 *
 * STATUS COMPLETE needs all of:
 *  - the SQL files that ran finished, with every row-returning result non-empty;
 *  - 0034's function: right signature, SQL, STABLE, SECURITY INVOKER,
 *    search_path='' and execute only for authenticated + service_role;
 *  - three labelled EXPLAIN ANALYZE runs of the call and one of the body for
 *    every role/scope, and independent expectations equal to the function's
 *    rowCount (owner, manager, staff, empty window, invalid input);
 *  - owner and manager loads: three complete runs per case, one RPC each,
 *    rows equal to the independent expectation, timings recorded;
 *  - every permitted-site case's median paired total within its target;
 *  - the manager's three membership phases (AU-only before, all sites,
 *    AU-only after) recorded against the same function definition.
 */
import { MEASURE_CASES, type MeasureResult, type MeasureRow } from "./measure-item-counting";

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
export type GateMode = "full" | "measure-only";
export type ManagerPhase = "denied-before" | "all-sites" | "denied-after";
export const MANAGER_PHASES: readonly ManagerPhase[] = ["denied-before", "all-sites", "denied-after"];

/** A manager phase recorded by an earlier (or this) run. */
export interface PhaseRecord {
  phase: ManagerPhase;
  finishedAt: string;
  revision: string;
  fnDefinitionMd5: string | null;
  problems: string[];
}

export const SQL_FILES = ["01-sites.sql", "02-volume.sql", "03-query-evidence.sql"] as const;
export const FN_ARGS =
  "p_site text, p_start_utc timestamp with time zone, p_end_utc_exclusive timestamp with time zone, p_as_of_utc timestamp with time zone";
const RUNS_REQUIRED = 3;
const SCOPES = MEASURE_CASES.map((c) => c.scope);
const RETURNS_ROWS = new Set(["SELECT", "EXPLAIN", "SHOW"]);
const GATE_LABEL = /'gate:(call|body):(\w+):([\w-]+):(\d+)'/;

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

function num(v: unknown): number {
  const n = Number(v);
  return v === null || v === undefined || v === "" ? NaN : Number.isFinite(n) ? n : NaN;
}

function bool(v: unknown): boolean | null {
  if (v === true || v === "t" || v === "true") return true;
  if (v === false || v === "f" || v === "false") return false;
  return null;
}

function checkSites(run: FileRun, problems: string[]): void {
  const ev = evidenceMap(lastSelect(run));
  if (!listHas(ev.get("locations"), ["au", "uk", "us", "staging"])) problems.push("01-sites: locations au, uk, us and staging are not all present");
  for (const who of ["owner", "kiosk"]) {
    if (!listHas(ev.get(`membership ${who}`), ["au", "uk", "us"])) problems.push(`01-sites: ${who} is not a member of au, uk and us`);
  }
  for (const who of ["staff", "cs"]) {
    const d = ev.get(`membership ${who}`);
    if (!listHas(d, ["au"])) problems.push(`01-sites: ${who} is not a member of au`);
    if (listHas(d, ["uk"]) || listHas(d, ["us"])) problems.push(`01-sites: ${who} must be AU-only but has UK/US membership`);
  }
  if (!listHas(ev.get("membership manager"), ["au"])) problems.push("01-sites: manager is not a member of au");
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

/** What 03 established, for the measurement checks. */
export interface QueryFacts {
  /** `${role}:${scope}` → independent evidence total. */
  expected: Map<string, number>;
  fnDefinitionMd5: string | null;
}

function findWith(run: FileRun, field: string): StatementResult[] {
  return run.results.filter((r) => r.fields.includes(field));
}

function checkQueryEvidence(run: FileRun, problems: string[]): QueryFacts {
  const facts: QueryFacts = { expected: new Map(), fnDefinitionMd5: null };
  const p = (s: string) => problems.push(`03-query-evidence: ${s}`);

  const fn = findWith(run, "fn_name")[0]?.rows[0];
  if (!fn) p("function public.load_production_evidence was not found (apply migration 0034 on staging first)");
  else {
    if (fn.fn_args !== FN_ARGS) p(`function arguments are "${String(fn.fn_args)}"`);
    if (fn.fn_result !== "json") p(`function returns ${String(fn.fn_result)}, expected json`);
    if (fn.fn_language !== "sql") p(`function language is ${String(fn.fn_language)}, expected sql`);
    if (fn.fn_volatility !== "s") p(`function volatility is ${String(fn.fn_volatility)}, expected STABLE (s)`);
    if (bool(fn.fn_security_definer) !== false) p("function is SECURITY DEFINER; it must be SECURITY INVOKER");
    if (!/search_path=(""|'')/.test(String(fn.fn_config))) p(`function search_path setting is "${String(fn.fn_config)}", expected search_path=""`);
    facts.fnDefinitionMd5 = typeof fn.fn_definition_md5 === "string" ? fn.fn_definition_md5 : null;
  }

  const grants = new Map((findWith(run, "fn_grantee")[0]?.rows ?? []).map((r) => [String(r.fn_grantee), bool(r.can_execute)]));
  const want: Record<string, boolean> = { PUBLIC: false, anon: false, authenticated: true, service_role: true };
  for (const [who, ok] of Object.entries(want)) {
    if (grants.get(who) !== ok) p(`EXECUTE for ${who} should be ${ok ? "granted" : "revoked"} (got ${grants.has(who) ? String(grants.get(who)) : "nothing"})`);
  }
  const size = findWith(run, "total_size")[0];
  if (!size || size.rows.length === 0) p("table size/row count is missing");

  const plans = new Map<string, StatementResult>();
  for (const r of run.results.filter((x) => x.command === "EXPLAIN")) {
    const m = GATE_LABEL.exec(r.label);
    if (m) plans.set(`${m[1]}:${m[2]}:${m[3]}:${m[4]}`, r);
  }
  for (const role of ["owner", "manager"]) {
    for (const scope of SCOPES) {
      const want = [...[1, 2, 3].map((n) => `call:${role}:${scope}:${n}`), `body:${role}:${scope}:1`];
      for (const key of want) {
        const r = plans.get(key);
        const text = r ? r.rows.map((row) => Object.values(row).join(" ")).join("\n") : "";
        if (!r) p(`query plan ${key} is missing`);
        else if (!/Execution Time/.test(text)) p(`query plan ${key} has no measured execution time`);
      }
    }
  }

  for (const r of findWith(run, "independent_total")) {
    const row = r.rows[0];
    if (!row) continue;
    const key = `${String(row.role)}:${String(row.scope)}`;
    const fnRows = num(row.fn_row_count);
    const independent = num(row.independent_total);
    if (!Number.isFinite(fnRows)) p(`${key}: the function returned no rowCount`);
    else if (fnRows !== independent) p(`${key}: the function returned ${fnRows} rows but the independent expectation is ${independent}`);
    facts.expected.set(key, independent);
  }
  for (const role of ["owner", "manager"]) {
    for (const scope of SCOPES) if (!facts.expected.has(`${role}:${scope}`)) p(`independent expectation for ${role}:${scope} is missing`);
  }
  if (!facts.expected.has("staff:au-busy-day")) p("staff fixture expectation is missing");
  const small = findWith(run, "empty_window_row_count")[0]?.rows[0];
  if (!small) p("empty-window / invalid-input fixture is missing");
  else {
    if (num(small.empty_window_row_count) !== 0) p(`empty window returned ${String(small.empty_window_row_count)} rows`);
    for (const k of ["reversed_window_is_null", "blank_site_is_null", "infinite_start_is_null"]) {
      if (bool(small[k]) !== true) p(`${k.replace(/_/g, " ")} is not true`);
    }
  }
  const au = facts.expected.get("owner:au-3-months");
  if (au !== undefined && !(au > 100_000)) p(`owner AU three-month evidence must exceed 100,000 rows, got ${au}`);
  return facts;
}

function runProblems(who: string, r: MeasureRow, expected: number | undefined, requireTarget: boolean): string[] {
  const out: string[] = [];
  const at = `measurement as ${who}: ${r.label}`;
  if (r.error) out.push(`${at} failed (${r.error})`);
  if (r.runs.length < RUNS_REQUIRED) out.push(`${at} has ${r.runs.length} of ${RUNS_REQUIRED} runs`);
  for (const x of r.runs) {
    const run = `${at} run ${x.run}`;
    if (x.error) {
      out.push(`${run} errored (${x.error})`);
      continue;
    }
    if (x.evidenceCalls !== 1) out.push(`${run} made ${x.evidenceCalls} evidence RPCs, expected exactly 1`);
    if (x.inWindowRows !== r.serverCount) out.push(`${run} loaded ${x.inWindowRows} in-window rows but the server counts ${r.serverCount ?? "?"}`);
    if (expected === undefined) out.push(`${run} has no independent SQL expectation to compare with`);
    else if (x.rows !== expected) out.push(`${run} loaded ${x.rows} evidence rows but the independent expectation is ${expected}`);
    for (const k of ["headersMs", "bodyMs", "parseMs", "loadMs", "reducerMs", "totalMs"] as const) {
      if (x[k] === null) out.push(`${run} has no ${k} measurement`);
    }
    if (x.parseCalls < 1) out.push(`${run} recorded no JSON parse`);
    if (!(x.rawBytes > 0)) out.push(`${run} recorded no response bytes`);
  }
  if (requireTarget && r.medianTotalMs !== null && r.medianTotalMs > r.targetMs) {
    out.push(`${at} median ${r.medianTotalMs} ms is over its ${r.targetMs} ms target`);
  }
  return out;
}

function casesPresent(who: string, m: MeasureResult): string[] {
  const missing = SCOPES.filter((s) => !m.rows.some((r) => r.scope === s));
  return missing.length ? [`measurement as ${who}: cases not measured: ${missing.join(", ")}`] : [];
}

/** Owner: every case site-wide, complete, correct and within target. */
export function checkOwner(m: MeasureOutcome, facts: QueryFacts | null): string[] {
  if (!m) return ["measurement as owner: not run"];
  if ("error" in m) return [`measurement as owner: failed (${m.error})`];
  const out: string[] = [];
  if (m.role !== "owner") out.push(`measurement as owner: signed-in user has role ${m.role ?? "unknown"}`);
  out.push(...casesPresent("owner", m));
  for (const r of m.rows) {
    if (r.visibility !== "site") out.push(`measurement as owner: ${r.label} visibility is ${r.visibility}, expected site`);
    out.push(...runProblems("owner", r, facts?.expected.get(`owner:${r.scope}`), true));
  }
  const quarter = m.rows.find((r) => r.scope === "au-3-months");
  const day = m.rows.find((r) => r.scope === "au-busy-day");
  if (quarter && !((quarter.serverCount ?? 0) > 100_000)) out.push("measurement as owner: AU three-month read did not cover more than 100,000 rows");
  if (day && !((day.serverCount ?? 0) > 1_000)) out.push("measurement as owner: AU busy-day read did not cover more than 1,000 rows");
  return out;
}

/** Which phase the manager's memberships put this run in. */
export function inferManagerPhase(sites: readonly string[], recorded: readonly PhaseRecord[]): ManagerPhase | null {
  const all = ["au", "uk", "us"].every((s) => sites.includes(s));
  if (all) return "all-sites";
  if (!sites.includes("au") || sites.includes("uk") || sites.includes("us")) return null;
  return recorded.some((r) => r.phase === "all-sites" && r.problems.length === 0) ? "denied-after" : "denied-before";
}

/** Manager in one membership phase. */
export function checkManager(m: MeasureOutcome, phase: ManagerPhase | null, facts: QueryFacts | null): string[] {
  if (!m) return ["measurement as manager: not run"];
  if ("error" in m) return [`measurement as manager: failed (${m.error})`];
  const out: string[] = [];
  if (m.role !== "manager") out.push(`measurement as manager: signed-in user has role ${m.role ?? "unknown"}`);
  if (!phase) {
    out.push(`measurement as manager: memberships ${m.sites.join(", ") || "none"} are neither AU-only nor all three sites`);
    return out;
  }
  out.push(...casesPresent("manager", m));
  for (const r of m.rows) {
    const permitted = phase === "all-sites" || r.site === "au";
    if (permitted) {
      if (r.visibility !== "site") out.push(`measurement as manager: ${r.label} should be a site-wide read (got ${r.visibility})`);
      if (!((r.serverCount ?? 0) > 0)) out.push(`measurement as manager: ${r.label} should return rows`);
      out.push(...runProblems("manager", r, facts?.expected.get(`manager:${r.scope}`), true));
    } else {
      const leaked = r.runs.some((x) => x.rows !== 0);
      if (r.visibility !== "limited" || r.serverCount !== 0 || leaked) {
        out.push(`measurement as manager: ${r.label} should be denied with 0 rows (got ${r.visibility}, ${r.serverCount ?? "?"} server / ${r.runs.map((x) => x.rows).join(",")} loaded)`);
      }
      for (const x of r.runs) if (x.error) out.push(`measurement as manager: ${r.label} run ${x.run} errored (${x.error})`);
    }
  }
  return out;
}

/** The three manager phases must all be recorded, clean, against this function definition. */
export function checkManagerPhases(records: readonly PhaseRecord[], fnMd5: string | null): string[] {
  const out: string[] = [];
  const how: Record<ManagerPhase, string> = {
    "denied-before": "run with the manager AU-only",
    "all-sites": "CJ temporarily adds the manager to uk and us, then rerun with --measure-only",
    "denied-after": "CJ restores the manager to AU-only, then rerun with --measure-only",
  };
  for (const phase of MANAGER_PHASES) {
    const latest = [...records].reverse().find((r) => r.phase === phase);
    if (!latest) out.push(`manager phase ${phase} not recorded yet (${how[phase]})`);
    else if (latest.problems.length) out.push(`manager phase ${phase} failed: ${latest.problems[0]}`);
    else if (fnMd5 && latest.fnDefinitionMd5 !== fnMd5) out.push(`manager phase ${phase} was recorded against a different function definition; rerun it`);
  }
  const before = records.find((r) => r.phase === "denied-before" && !r.problems.length);
  const all = records.find((r) => r.phase === "all-sites" && !r.problems.length);
  const after = [...records].reverse().find((r) => r.phase === "denied-after" && !r.problems.length);
  if (before && all && all.finishedAt < before.finishedAt) out.push("manager phase all-sites was recorded before denied-before");
  if (all && after && after.finishedAt < all.finishedAt) out.push("manager phase denied-after was recorded before all-sites");
  return out;
}

export interface GateInput {
  mode: GateMode;
  runs: FileRun[];
  measures: { owner: MeasureOutcome; manager: MeasureOutcome };
  managerPhase: ManagerPhase | null;
  /** Earlier recorded phases plus this run's, if it finished. */
  phaseRecords: readonly PhaseRecord[];
}

/** SQL-file problems and 03's facts. */
export function checkSqlRuns(mode: GateMode, runs: FileRun[]): { problems: string[]; facts: QueryFacts | null } {
  const problems: string[] = [];
  let facts: QueryFacts | null = null;
  const files = mode === "full" ? SQL_FILES : (["03-query-evidence.sql"] as const);
  for (const file of files) {
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
    if (file === "03-query-evidence.sql") facts = checkQueryEvidence(run, problems);
  }
  return { problems, facts };
}

/** Every missing, wrong or over-target item; empty means the gate passed. */
export function checkItemCountingEvidence(input: GateInput): string[] {
  const { problems, facts } = checkSqlRuns(input.mode, input.runs);
  problems.push(...checkOwner(input.measures.owner, facts));
  problems.push(...checkManager(input.measures.manager, input.managerPhase, facts));
  problems.push(...checkManagerPhases(input.phaseRecords, facts?.fnDefinitionMd5 ?? null));
  return problems;
}

/** Finished cases over their target (also counted as problems; listed separately for the report). */
export function overTarget(measures: { owner: MeasureOutcome; manager: MeasureOutcome }): string[] {
  const out: string[] = [];
  for (const [who, m] of Object.entries(measures)) {
    if (!m || "error" in m) continue;
    for (const r of m.rows) {
      if (r.medianTotalMs !== null && r.medianTotalMs > r.targetMs && r.visibility === "site") {
        out.push(`${who}: ${r.label} median ${r.medianTotalMs} ms (target ${r.targetMs} ms; first ${r.firstTotalMs ?? "–"}, slowest ${r.slowestTotalMs ?? "–"})`);
      }
    }
  }
  return out;
}

export function statusLine(problems: string[]): string {
  return problems.length === 0 ? "STATUS: COMPLETE" : `STATUS: FAILED – ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}`;
}
