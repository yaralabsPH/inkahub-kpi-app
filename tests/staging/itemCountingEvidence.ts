/**
 * Pure checks for the item-counting staging evidence: decide whether every
 * expected result was captured AND passes. Kept free of I/O so it can be
 * unit-tested.
 *
 * STATUS COMPLETE needs all of:
 *  - the SQL files that ran finished, with every row-returning result non-empty;
 *  - 0035's v2 function (measured) and 0034's v1 (kept for old code): right
 *    signature, SQL, STABLE, SECURITY INVOKER, search_path='' and execute
 *    only for authenticated + service_role;
 *  - after every switch to authenticated, its own catalog statement_timeout
 *    (unchanged 8 s) applied and in effect, with RLS on;
 *  - three labelled EXPLAIN ANALYZE runs of the call and one of the body, and
 *    three real PostgREST-shape full-body text runs, for every owner/manager
 *    scope; the function's rowCount equal to an independent expectation;
 *    day scopes and staff matching field by field, dictionaries included;
 *  - owner and manager loads: three complete runs per case, one RPC each,
 *    rows equal to the independent expectation, timings recorded;
 *  - every permitted-site case's median paired total within its target;
 *  - the manager's three membership phases (AU-only before, all sites,
 *    AU-only after), in order, all recorded for this same v2 function
 *    definition, encoding and harness version.
 */
import { MEASURE_CASES, type MeasureResult, type MeasureRow } from "./measure-item-counting";
import {
  checkClaimsEvidence,
  checkParityArtifact,
  checkPolicySet,
  parityArtifactHash,
  policyHash,
  rolesOf,
  type ClaimsSource,
  type ParityArtifact,
  type PolicyRow,
} from "./itemCountingPolicyParity";

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

export const V2_FUNCTION = "load_production_evidence_v2";
export const V1_FUNCTION = "load_production_evidence";
export const ENCODING_VERSION = 2;
/** Bump when the evidence/gate rules change, so older manager phase records can't count. */
export const HARNESS_VERSION = "item-counting-gate-v2.2";

/** What a phase record must have been measured against. */
export interface GateIdentity {
  fnName: string;
  fnDefinitionMd5: string;
  encodingVersion: number;
  harnessVersion: string;
  /** SHA-256 of ALL production_events policies (canonical JSON). */
  policyHash: string;
  /** SHA-256 of the completed parity comparisons this run relied on. */
  parityHash: string;
}

/** A manager phase recorded by an earlier (or this) run. Only clean runs are recorded. */
export interface PhaseRecord {
  phase: ManagerPhase;
  finishedAt: string;
  revision: string;
  fnName?: string;
  fnDefinitionMd5: string | null;
  encodingVersion?: number;
  harnessVersion?: string;
  policyHash?: string;
  parityHash?: string;
  problems: string[];
}

export const SQL_FILES = ["01-sites.sql", "02-volume.sql", "03-query-evidence.sql"] as const;
export const FN_ARGS =
  "p_site text, p_start_utc timestamp with time zone, p_end_utc_exclusive timestamp with time zone, p_as_of_utc timestamp with time zone";
const RUNS_REQUIRED = 3;
const SCOPES = MEASURE_CASES.map((c) => c.scope);
const DAY_SCOPES = MEASURE_CASES.filter((c) => c.first === c.last).map((c) => c.scope);
const RETURNS_ROWS = new Set(["SELECT", "EXPLAIN", "SHOW"]);
const GATE_LABEL = /'gate:(call|body):(\w+):([\w-]+):(\d+)'/;
const TEXT_LABEL = /^gate:text:(\w+):([\w-]+):(\d+)$/;
/** authenticated's statement_timeout must stay exactly this (never raised). */
export const ROLE_TIMEOUT_MS = 8_000;
/** Role switches in 03 that must each apply the timeout: owner, manager, staff, owner again. */
const TIMEOUT_SWITCHES = ["owner", "manager", "staff", "owner"];

/** PostgreSQL time setting text → ms ("8s", "8000", "8000ms", "1min"); NaN if unreadable. */
export function settingMs(v: unknown): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|min|h)?\s*$/.exec(String(v ?? ""));
  if (!m) return NaN;
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  return n * { ms: 1, s: 1_000, min: 60_000, h: 3_600_000 }[unit as "ms" | "s" | "min" | "h"];
}

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
  /** v2 definition hash (what manager phases are recorded against). */
  fnDefinitionMd5: string | null;
  /** Hash of the current production_events policies (from 03). */
  policyHash: string | null;
  identity: GateIdentity | null;
}

/** What the runner supplies besides the SQL results: real-session claims and the parity artifact. */
export interface GateExtras {
  claimsSources?: Record<string, ClaimsSource>;
  parity?: ParityArtifact | null;
}

function findWith(run: FileRun, field: string): StatementResult[] {
  return run.results.filter((r) => r.fields.includes(field));
}

function checkFunction(run: FileRun, fnName: string, p: (s: string) => void, migration: string): Record<string, unknown> | null {
  const fn = findWith(run, "fn_name").map((r) => r.rows[0]).find((row) => row?.fn_name === fnName);
  if (!fn) {
    p(`function public.${fnName} was not found (apply migration ${migration} on staging first)`);
    return null;
  }
  if (fn.fn_args !== FN_ARGS) p(`${fnName} arguments are "${String(fn.fn_args)}"`);
  if (fn.fn_result !== "json") p(`${fnName} returns ${String(fn.fn_result)}, expected json`);
  if (fn.fn_language !== "sql") p(`${fnName} language is ${String(fn.fn_language)}, expected sql`);
  if (fn.fn_volatility !== "s") p(`${fnName} volatility is ${String(fn.fn_volatility)}, expected STABLE (s)`);
  if (bool(fn.fn_security_definer) !== false) p(`${fnName} is SECURITY DEFINER; it must be SECURITY INVOKER`);
  if (!/search_path=(""|'')/.test(String(fn.fn_config))) p(`${fnName} search_path setting is "${String(fn.fn_config)}", expected search_path=""`);
  const grantRows = findWith(run, "fn_grantee").flatMap((r) => r.rows).filter((row) => row.fn_privileges_for === fnName);
  const grants = new Map(grantRows.map((r) => [String(r.fn_grantee), bool(r.can_execute)]));
  const want: Record<string, boolean> = { PUBLIC: false, anon: false, authenticated: true, service_role: true };
  for (const [who, ok] of Object.entries(want)) {
    if (grants.get(who) !== ok) p(`${fnName}: EXECUTE for ${who} should be ${ok ? "granted" : "revoked"} (got ${grants.has(who) ? String(grants.get(who)) : "nothing"})`);
  }
  return fn;
}

function checkQueryEvidence(run: FileRun, problems: string[], extras: GateExtras = {}): QueryFacts {
  const facts: QueryFacts = { expected: new Map(), fnDefinitionMd5: null, policyHash: null, identity: null };
  const p = (s: string) => problems.push(`03-query-evidence: ${s}`);

  // Real-session claims after every switch (sizes/shapes/booleans only).
  const claims = findWith(run, "claims_for").map((r) => r.rows[0]).filter(Boolean);
  if (claims.map((c) => String(c.claims_for)).join(",") !== TIMEOUT_SWITCHES.join(",")) {
    p(`claims evidence after role switches is ${claims.map((c) => String(c.claims_for)).join(",") || "missing"}, expected ${TIMEOUT_SWITCHES.join(",")}`);
  }
  for (const c of claims) {
    const who = String(c.claims_for);
    for (const x of checkClaimsEvidence(c, extras.claimsSources?.[who])) p(x);
    if (c.profile_role !== who) p(`${who}: the session's profile role is ${String(c.profile_role ?? "none")}`);
  }

  // All production_events policies: the reviewed post-0036 set, hashed.
  const policyRows: PolicyRow[] = findWith(run, "policy_catalog").flatMap((r) => r.rows).map((r) => ({
    schemaname: String(r.schemaname), tablename: String(r.tablename), policyname: String(r.policyname), permissive: String(r.permissive),
    roles: rolesOf(r.roles), cmd: String(r.cmd), qual: r.qual == null ? null : String(r.qual), with_check: r.with_check == null ? null : String(r.with_check),
  }));
  if (!policyRows.length) p("production_events policy catalog is missing");
  else {
    for (const x of checkPolicySet(policyRows, "post")) p(x);
    facts.policyHash = policyHash(policyRows).hash;
  }
  for (const x of checkParityArtifact(extras.parity ?? null, facts.policyHash)) p(x);

  const v2 = checkFunction(run, V2_FUNCTION, p, "0035");
  checkFunction(run, V1_FUNCTION, p, "0034");
  if (v2 && typeof v2.fn_definition_md5 === "string") {
    facts.fnDefinitionMd5 = v2.fn_definition_md5;
    if (facts.policyHash && extras.parity) {
      facts.identity = {
        fnName: V2_FUNCTION, fnDefinitionMd5: v2.fn_definition_md5, encodingVersion: ENCODING_VERSION, harnessVersion: HARNESS_VERSION,
        policyHash: facts.policyHash, parityHash: parityArtifactHash(extras.parity),
      };
    }
  }
  const size = findWith(run, "total_size")[0];
  if (!size || size.rows.length === 0) p("table size/row count is missing");

  // The API role's own statement_timeout, applied after every role switch.
  const switches = findWith(run, "timeout_for").map((r) => r.rows[0]).filter(Boolean);
  if (switches.map((s) => String(s.timeout_for)).join(",") !== TIMEOUT_SWITCHES.join(",")) {
    p(`statement_timeout evidence after role switches is ${switches.map((s) => String(s.timeout_for)).join(",") || "missing"}, expected ${TIMEOUT_SWITCHES.join(",")}`);
  }
  for (const s of switches) {
    const who = String(s.timeout_for);
    const catalog = settingMs(s.catalog_timeout);
    const effective = num(s.effective_timeout_ms);
    if (String(s.catalog_timeout).includes(",")) p(`${who}: authenticated has more than one statement_timeout setting`);
    if (catalog !== ROLE_TIMEOUT_MS) p(`${who}: authenticated's catalog statement_timeout is ${String(s.catalog_timeout)}, expected the unchanged 8s`);
    if (effective !== catalog) p(`${who}: effective statement_timeout ${effective} ms does not match the catalog value ${String(s.catalog_timeout)}`);
    if (s.current_user_name !== "authenticated") p(`${who}: measured as ${String(s.current_user_name)}, expected authenticated`);
    if (s.row_security !== "on") p(`${who}: row_security is ${String(s.row_security)}, expected on`);
  }

  const plans = new Map<string, StatementResult>();
  for (const r of run.results.filter((x) => x.command === "EXPLAIN")) {
    const m = GATE_LABEL.exec(r.label);
    if (m) plans.set(`${m[1]}:${m[2]}:${m[3]}:${m[4]}`, r);
  }
  const texts = new Map<string, { r: StatementResult; row: Record<string, unknown> }[]>();
  for (const r of findWith(run, "body_bytes")) {
    for (const row of r.rows) {
      const m = TEXT_LABEL.exec(String(row.gate));
      if (!m) continue;
      const key = `${m[1]}:${m[2]}:${m[3]}`;
      texts.set(key, [...(texts.get(key) ?? []), { r, row }]);
    }
  }
  for (const role of ["owner", "manager"]) {
    for (const scope of SCOPES) {
      for (const key of [...[1, 2, 3].map((n) => `call:${role}:${scope}:${n}`), `body:${role}:${scope}:1`]) {
        const r = plans.get(key);
        const text = r ? r.rows.map((row) => Object.values(row).join(" ")).join("\n") : "";
        if (!r) p(`query plan ${key} is missing`);
        else if (!/Execution Time/.test(text)) p(`query plan ${key} has no measured execution time`);
      }
      for (const n of [1, 2, 3]) {
        const key = `${role}:${scope}:${n}`;
        const found = texts.get(key) ?? [];
        if (found.length !== 1) {
          p(`full-body text run ${key} ${found.length ? "appears more than once" : "is missing"}`);
          continue;
        }
        const { r, row } = found[0];
        if (!(num(row.body_bytes) > 0)) p(`full-body text run ${key} produced no body`);
        if (!Number.isFinite(r.ms) || r.ms < 0) p(`full-body text run ${key} has no elapsed time`);
        if (settingMs(row.effective_timeout) !== ROLE_TIMEOUT_MS) p(`full-body text run ${key} ran under statement_timeout ${String(row.effective_timeout)}, not 8s`);
      }
    }
  }

  const fnCounts = new Map(findWith(run, "fn_row_count").map((r) => r.rows[0]).filter(Boolean).map((row) => [`${String(row.role)}:${String(row.scope)}`, num(row.fn_row_count)]));
  for (const r of findWith(run, "independent_total")) {
    const row = r.rows[0];
    if (!row) continue;
    const key = `${String(row.role)}:${String(row.scope)}`;
    const independent = num(row.independent_total);
    const fnRows = fnCounts.get(key);
    if (fnRows === undefined || !Number.isFinite(fnRows)) p(`${key}: the function's rowCount is missing`);
    else if (fnRows !== independent) p(`${key}: the function returned ${fnRows} rows but the independent expectation is ${independent}`);
    facts.expected.set(key, independent);
  }
  for (const role of ["owner", "manager"]) {
    for (const scope of SCOPES) if (!facts.expected.has(`${role}:${scope}`)) p(`independent expectation for ${role}:${scope} is missing`);
  }
  if (!facts.expected.has("staff:au-busy-day")) p("staff fixture expectation is missing");

  // Field-by-field comparisons (day scopes and staff), dictionaries included.
  const fields = new Map(findWith(run, "only_in_function").map((r) => r.rows[0]).filter(Boolean).map((row) => [`${String(row.role)}:${String(row.scope)}`, row]));
  for (const key of [...["owner", "manager"].flatMap((role) => DAY_SCOPES.map((s) => `${role}:${s}`)), "staff:au-busy-day"]) {
    const row = fields.get(key);
    if (!row) {
      p(`field comparison for ${key} is missing`);
      continue;
    }
    if (num(row.only_in_function) !== 0 || num(row.only_in_table) !== 0) {
      p(`${key}: decoded rows differ from the table (${String(row.only_in_function)} only in the function, ${String(row.only_in_table)} only in the table)`);
    }
    if (num(row.decoded_rows) !== facts.expected.get(key)) p(`${key}: decoded ${String(row.decoded_rows)} rows, expected ${facts.expected.get(key) ?? "?"}`);
    if (num(row.staff_entries) !== num(row.expected_staff)) p(`${key}: staff dictionary has ${String(row.staff_entries)} entries, expected ${String(row.expected_staff)}`);
    if (num(row.sku_entries) !== num(row.expected_skus)) p(`${key}: SKU dictionary has ${String(row.sku_entries)} entries, expected ${String(row.expected_skus)}`);
  }

  const small = findWith(run, "empty_window_row_count")[0]?.rows[0];
  if (!small) p("empty-window / invalid-input fixture is missing");
  else {
    if (num(small.empty_window_row_count) !== 0) p(`empty window returned ${String(small.empty_window_row_count)} rows`);
    if (!/"staffIds"\s*:\s*\[\]/.test(String(small.empty_window_body)) || !/"skus"\s*:\s*\[\]/.test(String(small.empty_window_body))) {
      p("empty window must return empty staffIds and skus dictionaries");
    }
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
    if (x.otherEvidenceCalls !== 0) out.push(`${run} called another evidence RPC (v1 fallback?) ${x.otherEvidenceCalls} time(s)`);
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
/** Does a record belong to this exact v2 function, encoding and harness? */
export function sameIdentity(r: PhaseRecord, id: GateIdentity | null): boolean {
  return !!id && r.fnName === id.fnName && r.fnDefinitionMd5 === id.fnDefinitionMd5
    && r.encodingVersion === id.encodingVersion && r.harnessVersion === id.harnessVersion
    && r.policyHash === id.policyHash && r.parityHash === id.parityHash;
}

/** Which phase the manager's memberships put this run in (only this identity's records count). */
export function inferManagerPhase(sites: readonly string[], recorded: readonly PhaseRecord[], id: GateIdentity | null = null): ManagerPhase | null {
  const all = ["au", "uk", "us"].every((s) => sites.includes(s));
  if (all) return "all-sites";
  if (!sites.includes("au") || sites.includes("uk") || sites.includes("us")) return null;
  return recorded.some((r) => r.phase === "all-sites" && r.problems.length === 0 && sameIdentity(r, id)) ? "denied-after" : "denied-before";
}

/** An explicit --manager-phase must agree with the manager's actual memberships. */
export function phaseMatchesMemberships(phase: ManagerPhase, sites: readonly string[]): boolean {
  const all = ["au", "uk", "us"].every((s) => sites.includes(s));
  const auOnly = sites.includes("au") && !sites.includes("uk") && !sites.includes("us");
  return phase === "all-sites" ? all : auOnly;
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

/** Problems that only mean "a later manager phase hasn't been run yet". */
export const PENDING_PHASE = /^manager phase (denied-before|all-sites|denied-after) not recorded yet /;

/** The three manager phases must all be recorded, clean, in order, for this v2 identity. */
export function checkManagerPhases(records: readonly PhaseRecord[], id: GateIdentity | null): string[] {
  const out: string[] = [];
  const how: Record<ManagerPhase, string> = {
    "denied-before": "run with the manager AU-only: --measure-only --manager-phase=denied-before",
    "all-sites": "add the manager to uk and us, then run --measure-only --manager-phase=all-sites",
    "denied-after": "restore the manager to AU-only, then run --measure-only --manager-phase=denied-after",
  };
  if (!id) return ["manager phases cannot be checked: the v2 function identity is unknown"];
  const mine = records.filter((r) => sameIdentity(r, id));
  for (const phase of MANAGER_PHASES) {
    const latest = [...mine].reverse().find((r) => r.phase === phase);
    if (!latest) out.push(`manager phase ${phase} not recorded yet (${how[phase]})`);
    else if (latest.problems.length) out.push(`manager phase ${phase} failed: ${latest.problems[0]}`);
  }
  const before = mine.find((r) => r.phase === "denied-before" && !r.problems.length);
  const all = [...mine].reverse().find((r) => r.phase === "all-sites" && !r.problems.length);
  const after = [...mine].reverse().find((r) => r.phase === "denied-after" && !r.problems.length);
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
  /** Real-session claims and the policy parity artifact. */
  extras?: GateExtras;
}

/** SQL-file problems and 03's facts. */
export function checkSqlRuns(mode: GateMode, runs: FileRun[], extras: GateExtras = {}): { problems: string[]; facts: QueryFacts | null } {
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
    if (file === "03-query-evidence.sql") facts = checkQueryEvidence(run, problems, extras);
  }
  return { problems, facts };
}

/** Every missing, wrong or over-target item; empty means the gate passed. */
export function checkItemCountingEvidence(input: GateInput): string[] {
  const { problems, facts } = checkSqlRuns(input.mode, input.runs, input.extras);
  problems.push(...checkOwner(input.measures.owner, facts));
  problems.push(...checkManager(input.measures.manager, input.managerPhase, facts));
  problems.push(...checkManagerPhases(input.phaseRecords, facts?.identity ?? null));
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

/**
 * The handoff line. When the only gaps are manager phases not run yet, say
 * so plainly, so expected missing evidence isn't mistaken for a query or
 * performance failure. It is still FAILED until all phases pass.
 */
export function statusLine(problems: string[]): string {
  if (problems.length === 0) return "STATUS: COMPLETE";
  if (problems.every((p) => PENDING_PHASE.test(p))) {
    const phases = problems.map((p) => PENDING_PHASE.exec(p)![1]);
    return `STATUS: FAILED – awaiting manager phase${phases.length > 1 ? "s" : ""} ${phases.join(", ")} (expected; no query or performance failure)`;
  }
  return `STATUS: FAILED – ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}`;
}
