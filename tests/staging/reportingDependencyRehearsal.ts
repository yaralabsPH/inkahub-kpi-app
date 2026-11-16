/**
 * Task 14 T14S1: rollback-only rehearsal of the 0040 + 0041 dependency reads
 * (prepared; NOT run by the coder).
 *
 *   npm run staging:reporting-jobs -- --rehearse-dependency-reads --sites=uk,us
 *
 * STAGING ONLY (guarded client: target checked before every SQL), against
 * installed 0037/0038/0039. The caller (reporting-jobs publicationMain) takes
 * the full-state baseline first and runs the fresh ZERO-change audit after.
 * Here, in ONE outer transaction that ALWAYS rolls back:
 *   D0  file identities: 0037-0039 installed, 0040/0041 the exact reviewed drafts
 *   D1  installed state: the 0039 publisher, NO 0040 helper/reads/indexes, no active batch
 *   D2  0040 then 0041 bodies applied (reviewed transaction-control parser)
 *   D3  effective functions: invoker, empty search_path, service-only, 0041 bodies; indexes present
 *   S*  setup (capture/processors on inside the transaction, fixtures)
 *   R*  a rebuild of the first site (ORIGINAL full volume + fixtures) frozen: candidate reads
 *   P*  setup-only zero-work publication of that rebuild (builds the base mirror)
 *   F*  source changes, a refresh frozen: mirror-plus-overlay reads
 *   X*  security/immutability probes (savepoints), full-volume timings and plans
 * All six real SQL functions are called through a fixed allowlisted RpcClient
 * on that same transaction and fed to the ACTUAL rpcFrozenReader and
 * materializer. This is SQL-serialization evidence (json_agg of the rows), NOT
 * an observed PostgREST HTTP response; wire verification is a later gate.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { reportingManifestHash } from "../../api/_lib/reporting-stage";
import type { RpcClient } from "../../api/_lib/reporting-jobs";
import { compareUtf8, type ResultRows } from "../../api/_lib/reporting-stage";
import { compareStream, diffFrozenViews, materializeBatch, materializeOwners, memoryFrozenReader, ownerKey, ownerOfEvent, rowsByOwner, type ChangedKey, type FrozenReader, type MaterializedWork, type MaterializeStats, type Owner } from "../../api/_lib/production-reporting-materialize";
import { imageToEvent, rpcFrozenReader } from "../../api/_lib/production-reporting-reader";
import type { ProductionEvidenceEvent } from "../../src/lib/domain/productionCounts";
import { canonicalJson, REPORTING_RULE_VERSION, type ReportingAudience } from "../../src/lib/domain/productionReporting";
import { projectReportingPartition } from "../../src/lib/domain/productionReportingProjection";
import { copyAll, migrationBody, productionEventAdmissibility, publish, refused, rpc, step, type Db, type FlowCtx, type Site } from "./reportingPublication";
import { bodyHashes, failFast, fileIdentity, FUNCTION_SQL, INSTALLED, MIGRATION_0037, MIGRATION_0038, MIGRATION_0039, publishBody } from "./reportingRebuildRepair";

type Ev = ProductionEvidenceEvent;

export const MIGRATION_0040 = "supabase/migrations/0040_reporting_dependency_reads.sql";
export const MIGRATION_0041 = "supabase/migrations/0041_reporting_dependency_read_bounds.sql";
/** Reviewed draft identities (LF = git; CRLF = a Windows working copy). */
export const REVIEWED = {
  "0039": ["05d7eff179993a6eeeba3fadaddd345b83bd20c68676cb6bda709937984c3bd5", "96deeed5667ba7d769bb5e6b3a558141b5769cf297b11572aa1ef7b2bbc713cb"],
  "0040": ["4e39243e2ee6526f656eb1b462156d6bc9eabf17cac78fcb2d873cd4498968b2"],
  "0041": ["dfa49d597cc37cef92314a4d2dcaf79d195949741fc0534fc57345c12f419646"],
} as const;
export const MIB = 1024 * 1024;

// ---------------------------------------------------------------------------
// The six reads: a fixed allowlist with exact SQL argument types
// ---------------------------------------------------------------------------

export const DEPENDENCY_RPCS: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  read_reporting_changed_keys: [["p_batch", "uuid"], ["p_fence", "bigint"], ["p_after_event_id", "text"], ["p_limit", "integer"]],
  list_reporting_owners: [["p_batch", "uuid"], ["p_fence", "bigint"], ["p_after_kind", "text"], ["p_after_key", "text"], ["p_limit", "integer"]],
  read_reporting_owner_members: [["p_batch", "uuid"], ["p_fence", "bigint"], ["p_owners", "jsonb"], ["p_after_index", "integer"], ["p_after_event_id", "text"], ["p_limit", "integer"]],
  read_reporting_events_by_id: [["p_batch", "uuid"], ["p_fence", "bigint"], ["p_ids", "text[]"]],
  read_reporting_children: [["p_batch", "uuid"], ["p_fence", "bigint"], ["p_parent_ids", "text[]"], ["p_after_parent_id", "text"], ["p_after_event_id", "text"], ["p_limit", "integer"]],
  read_reporting_staff_stream: [["p_batch", "uuid"], ["p_fence", "bigint"], ["p_staff", "uuid"], ["p_direction", "text"], ["p_at", "timestamptz"], ["p_at_event_id", "text"], ["p_limit", "integer"]],
};

/** The exact SQL of one allowlisted read: the function's rows aggregated by PostgreSQL's own JSON serialization. */
export function dependencyRpcSql(fn: string, args: Record<string, unknown>): { sql: string; params: unknown[] } {
  const spec = DEPENDENCY_RPCS[fn];
  if (!spec) throw new Error(`dependency rehearsal refuses an unknown function ${JSON.stringify(fn)}`);
  const want = spec.map(([k]) => k);
  const got = Object.keys(args).sort();
  if (JSON.stringify(got) !== JSON.stringify([...want].sort())) throw new Error(`${fn} arguments must be exactly ${want.join(", ")} (got ${got.join(", ")})`);
  const params = spec.map(([k, type]) => (type === "jsonb" && args[k] !== null ? JSON.stringify(args[k]) : args[k]));
  const call = spec.map(([, type], i) => `$${i + 1}::${type}`).join(", ");
  return { sql: `select coalesce(pg_catalog.json_agg(t), '[]'::json)::text as body from public.${fn}(${call}) t`, params };
}

/**
 * Per-read counts. `nonEmptyUnderLimit` is a RAW count (it includes ordinary
 * final pages and every non-empty by-id response). `cappedContinuations` is
 * the byte-cap evidence: a non-empty response that stopped short of its row
 * limit (by id: short of the requested present ids) AND was followed by a
 * call continuing EXACTLY from its last returned key that again returned rows.
 */
export interface RpcStat { calls: number; rows: number; maxRows: number; maxPgBytes: number; maxCompactBytes: number; nonEmptyUnderLimit: number; cappedContinuations: number; ms: number }
export const newRpcStats = (): Record<string, RpcStat> => Object.fromEntries(Object.keys(DEPENDENCY_RPCS).map((k) => [k, { calls: 0, rows: 0, maxRows: 0, maxPgBytes: 0, maxCompactBytes: 0, nonEmptyUnderLimit: 0, cappedContinuations: 0, ms: 0 }]));

type Row = Record<string, unknown>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const lastOf = (rows: Row[]) => rows[rows.length - 1];
/** Is `args` the exact keyset continuation of a previous call of `fn` that returned `prev` rows? (pure; tested) */
export function isContinuation(fn: string, prevArgs: Record<string, unknown>, prev: Row[], args: Record<string, unknown>): boolean {
  if (!prev.length || prevArgs.p_batch !== args.p_batch || prevArgs.p_fence !== args.p_fence) return false;
  const l = lastOf(prev);
  switch (fn) {
    case "read_reporting_changed_keys":
      return args.p_after_event_id === l.event_id;
    case "list_reporting_owners":
      return args.p_after_kind === l.partition_kind && args.p_after_key === l.partition_key;
    case "read_reporting_owner_members":
      return same(args.p_owners, prevArgs.p_owners) && args.p_after_index === l.owner_index && args.p_after_event_id === l.event_id;
    case "read_reporting_events_by_id": {
      const ids = args.p_ids as string[];
      return Array.isArray(ids) && ids.length > 0 && same(ids, (prevArgs.p_ids as string[]).filter((id) => compareUtf8(id, String(l.event_id)) > 0));
    }
    case "read_reporting_children":
      return same(args.p_parent_ids, prevArgs.p_parent_ids) && args.p_after_parent_id === l.parent_event_id && args.p_after_event_id === l.event_id;
    case "read_reporting_staff_stream":
      return args.p_staff === prevArgs.p_staff && args.p_direction === prevArgs.p_direction && args.p_at === (l.image as Row | undefined)?.created_at && args.p_at_event_id === l.event_id;
    default:
      return false;
  }
}
/** Did a non-empty response stop short of its row limit (by id: of the ids it could still return)? */
const underLimit = (fn: string, args: Record<string, unknown>, rows: Row[]) =>
  rows.length > 0 && (fn === "read_reporting_events_by_id" ? rows.length < (args.p_ids as unknown[]).length : rows.length < Number(args.p_limit));

/**
 * An RpcClient on the rehearsal's own transaction: switches to service_role for
 * the one call, records PostgreSQL's serialized length and the compact client
 * length, and FAILS (never slices) a response over 1,000 rows or 1 MiB.
 */
export function sqlRpcClient(c: Db, as: (c: Db, service: boolean) => Promise<void>, stats: Record<string, RpcStat>, now: () => number): RpcClient {
  const previous = new Map<string, { args: Record<string, unknown>; rows: Row[]; short: boolean }>();
  return {
    rpc: async (fn, args) => {
      const { sql, params } = dependencyRpcSql(fn, args);
      const t0 = now();
      await as(c, true);
      const r = await c.query(sql, params);
      await as(c, false);
      const body = String(r.rows[0]?.body ?? "[]");
      const rows = JSON.parse(body) as Array<Record<string, unknown>>;
      const pg = Buffer.byteLength(body, "utf8");
      const compact = Buffer.byteLength(JSON.stringify(rows), "utf8");
      const s = stats[fn];
      s.calls++;
      s.rows += rows.length;
      s.maxRows = Math.max(s.maxRows, rows.length);
      s.maxPgBytes = Math.max(s.maxPgBytes, pg);
      s.maxCompactBytes = Math.max(s.maxCompactBytes, compact);
      const short = underLimit(fn, args, rows);
      if (short) s.nonEmptyUnderLimit++;
      const p = previous.get(fn);
      if (p?.short && rows.length > 0 && isContinuation(fn, p.args, p.rows, args)) s.cappedContinuations++;
      previous.set(fn, { args, rows, short });
      s.ms += now() - t0;
      if (rows.length > 1000) throw new Error(`${fn} returned ${rows.length} rows (more than 1,000)`);
      if (compact > MIB) throw new Error(`${fn} returned ${compact} compact bytes (more than 1 MiB)`);
      return { data: rows, error: null };
    },
  };
}

// ---------------------------------------------------------------------------
// The effective (0040 + 0041) read queries, for plans
// ---------------------------------------------------------------------------

/** The SELECT inside a 0041 read function (between `FOR r IN` and its `LOOP`), exactly as the migration text has it. */
export function effectiveReadQuery(text0041: string, fn: string): string {
  const t = text0041.replace(/\r\n/g, "\n");
  const i = t.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  if (i < 0) throw new Error(`${fn} is not replaced in 0041`);
  const a = t.indexOf("FOR r IN\n", i) + "FOR r IN\n".length;
  const b = t.indexOf("\n  LOOP\n", a);
  if (a < "FOR r IN\n".length || b < 0) throw new Error(`${fn}: query not found`);
  return t.slice(a, b);
}
const PLAN_VARS: Record<string, ReadonlyArray<readonly [RegExp, string]>> = {
  read_reporting_owner_members: [[/\bp_owners\b/g, "$4::jsonb"], [/\bp_after_index\b/g, "$5::integer"], [/\bp_after_event_id\b/g, "$6::text"], [/\bp_limit\b/g, "$7::integer"]],
  read_reporting_staff_stream: [[/\bp_staff\b/g, "$4::uuid"], [/\bp_direction\b/g, "$5::text"], [/\bp_at_event_id\b/g, "$7::text"], [/\bp_at\b/g, "$6::timestamptz"], [/\bp_limit\b/g, "$8::integer"]],
};
/** The effective query with the batch's columns and the call's parameters bound ($1 batch, $2 site, $3 kind, then the parameters). */
export function planSql(text0041: string, fn: "read_reporting_owner_members" | "read_reporting_staff_stream"): string {
  let q = effectiveReadQuery(text0041, fn).replace(/\bb\.batch_id\b/g, "$1::uuid").replace(/\bb\.site\b/g, "$2::text").replace(/\bb\.kind\b/g, "$3::text");
  for (const [re, to] of PLAN_VARS[fn]) q = q.replace(re, to);
  if (/\bp_\w+|\bb\.(batch_id|site|kind)\b|\bv_\w+/.test(q)) throw new Error(`${fn}: an unbound variable remains in the plan statement`);
  return `EXPLAIN (VERBOSE, SETTINGS, FORMAT JSON) ${q}`;
}

// ---------------------------------------------------------------------------
// Exact comparisons
// ---------------------------------------------------------------------------

const evKey = (e: Ev) => canonicalJson(e);
/** Missing, extra, repeated or different events between an independent frozen set and what the reads returned. */
export function compareEvents(what: string, expected: readonly Ev[], actual: readonly Ev[]): string[] {
  const p: string[] = [];
  const want = new Map(expected.map((e) => [e.id, evKey(e)]));
  const seen = new Set<string>();
  for (const e of actual) {
    if (seen.has(e.id)) p.push(`${what}: ${JSON.stringify(e.id)} returned twice`);
    seen.add(e.id);
    const w = want.get(e.id);
    if (w === undefined) p.push(`${what}: ${JSON.stringify(e.id)} is not in the frozen view`);
    else if (w !== evKey(e)) p.push(`${what}: ${JSON.stringify(e.id)} differs from the frozen image`);
  }
  for (const id of want.keys()) if (!seen.has(id)) p.push(`${what}: ${JSON.stringify(id)} is missing`);
  return p;
}

const workKey = (w: Pick<MaterializedWork, "desc">) => `${w.desc.audienceKind}|${w.desc.audienceStaff ?? ""}|${w.desc.partitionKind}\u0000${w.desc.partitionKey}`;
/** RPC-path works vs the in-memory reader over the independent view (descriptors incl. input hash, rows) and vs the full-view oracle rows. */
export function compareMaterialization(viaRpc: readonly MaterializedWork[], viaMemory: readonly MaterializedWork[], oracle: (audience: ReportingAudience, owner: string) => ResultRows | undefined): string[] {
  const p: string[] = [];
  const mem = new Map(viaMemory.map((w) => [workKey(w), w]));
  const rpcKeys = new Set(viaRpc.map(workKey));
  for (const k of mem.keys()) if (!rpcKeys.has(k)) p.push(`work ${k} is missing from the RPC path`);
  for (const w of viaRpc) {
    const k = workKey(w);
    const m = mem.get(k);
    if (!m) p.push(`work ${k} is extra on the RPC path`);
    else {
      if (canonicalJson(m.desc) !== canonicalJson(w.desc)) p.push(`work ${k}: descriptor/input hash differs from the independent view`);
      if (canonicalJson(m.rows) !== canonicalJson(w.rows)) p.push(`work ${k}: rows differ from the independent view`);
    }
    const aud: ReportingAudience = w.desc.audienceKind === "site" ? { kind: "site" } : { kind: "self", staffId: w.desc.audienceStaff! };
    const want = oracle(aud, `${w.desc.partitionKind}\u0000${w.desc.partitionKey}`) ?? { event_facts: [], cancel_edges: [], order_occurrences: [], timing_facts: [], source_issue_facts: [] };
    if (canonicalJson(want) !== canonicalJson(w.rows)) p.push(`work ${k}: rows differ from the full frozen-view oracle`);
  }
  return p;
}

/** The full frozen-view oracle: one projection of the complete view per audience, owner rows by owner key. */
export function frozenOracle(site: string, cutoff: string, view: readonly Ev[]): (audience: ReportingAudience, owner: string) => ResultRows | undefined {
  const cache = new Map<string, Map<string, ResultRows>>();
  return (audience, owner) => {
    const k = audience.kind === "site" ? "site" : `self:${audience.staffId}`;
    if (!cache.has(k)) {
      const events = audience.kind === "self" ? view.filter((e) => e.staff_id === audience.staffId) : view;
      const r = projectReportingPartition({ site, audience, ruleVersion: REPORTING_RULE_VERSION, sourceCutoffUtc: cutoff, events });
      cache.set(k, new Map([...rowsByOwner(r).entries()].map(([key, v]) => [key, v.rows])));
    }
    return cache.get(k)!.get(owner);
  };
}

/** One site's independent frozen view: every FULL raw source image (as PostgreSQL's to_jsonb) and its projector event. */
export interface RawView { raw: Map<string, unknown>; events: Ev[] }
export function rawView(rows: ReadonlyArray<{ img: unknown }>, site: string): RawView {
  const raw = new Map<string, unknown>();
  const events: Ev[] = [];
  for (const r of rows) {
    const e = imageToEvent(r.img, site);
    if (raw.has(e.id)) throw new Error(`independent view: ${JSON.stringify(e.id)} twice`);
    raw.set(e.id, r.img);
    events.push(e);
  }
  return { raw, events };
}
/**
 * The expected refresh changed keys: membership from the FULL raw images (a
 * note-only change is a captured change) plus keys that became due, then each
 * side reduced to the projector's evidence event. Sorted bytewise by id.
 */
export function expectedChangedKeys(before: RawView, after: RawView, prevCutoff: string, cutoff: string): ChangedKey[] {
  const b = new Map(before.events.map((e) => [e.id, e]));
  const a = new Map(after.events.map((e) => [e.id, e]));
  const ids = new Set<string>(diffFrozenViews(before.events, after.events, prevCutoff, cutoff).map((k) => k.id)); // reduced changes + due keys
  for (const id of new Set([...before.raw.keys(), ...after.raw.keys()])) if (canonicalJson(before.raw.get(id) ?? null) !== canonicalJson(after.raw.get(id) ?? null)) ids.add(id);
  return [...ids].sort(compareUtf8).map((id) => ({ id, before: b.get(id) ?? null, after: a.get(id) ?? null }));
}

const audKey = (a: ReportingAudience) => (a.kind === "site" ? "site|" : `self|${a.staffId}`);
/**
 * Every (audience, owner) whose owner rows differ between the full projection
 * of `before` and of `after` (absent = empty), for the site audience and each
 * given worker. Derived without the materializer's dependency enumeration.
 */
export function requiredWorks(site: string, before: { view: readonly Ev[]; cutoff: string } | null, after: { view: readonly Ev[]; cutoff: string }, staff: readonly string[]): Set<string> {
  const out = new Set<string>();
  const empty = canonicalJson({ event_facts: [], cancel_edges: [], order_occurrences: [], timing_facts: [], source_issue_facts: [] });
  for (const audience of [{ kind: "site" } as ReportingAudience, ...[...new Set(staff)].sort(compareUtf8).map((staffId) => ({ kind: "self", staffId }) as ReportingAudience)]) {
    const rows = (x: { view: readonly Ev[]; cutoff: string } | null) => (x ? new Map([...rowsByOwner(projectReportingPartition({ site, audience, ruleVersion: REPORTING_RULE_VERSION, sourceCutoffUtc: x.cutoff, events: audience.kind === "self" ? x.view.filter((e) => e.staff_id === audience.staffId) : x.view })).entries()].map(([k, v]) => [k, canonicalJson(v.rows)])) : new Map<string, string>());
    const b = rows(before);
    const a = rows(after);
    for (const k of new Set([...b.keys(), ...a.keys()])) if ((b.get(k) ?? empty) !== (a.get(k) ?? empty)) out.add(`${audKey(audience)}|${k}`);
  }
  return out;
}
/** Each required (audience, owner) must be a work on BOTH paths: missing on both fails too. */
export function missingRequired(required: Iterable<string>, viaRpc: readonly MaterializedWork[], viaMemory: readonly MaterializedWork[]): string[] {
  const rpcKeys = new Set(viaRpc.map(workKey));
  const memKeys = new Set(viaMemory.map(workKey));
  const p: string[] = [];
  for (const k of required) {
    if (!rpcKeys.has(k)) p.push(`required work ${k} is missing from the RPC path`);
    if (!memKeys.has(k)) p.push(`required work ${k} is missing from the in-memory path`);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Statement guard
// ---------------------------------------------------------------------------

/** Deny-list (the flow's statements are many): no commit, history, maintenance, timeout/planner change, unrelated DDL, EXPLAIN ANALYZE or network. */
export function dependencyGuard(c: Db, allowedDdl: ReadonlySet<string>, sent: string[] = []): Db {
  return {
    query: async (sql: string, params?: unknown[]) => {
      // Classify the first real token: leading whitespace and SQL comments cannot hide a statement's kind.
      const s = sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "");
      const ddl = /^(create|alter|drop|grant|revoke|truncate|reindex|cluster|comment|security label|do)\b/i.test(s);
      const bad =
        /^(commit|end|abort|vacuum|analyze|checkpoint|prepare transaction|commit prepared|listen|notify|copy)\b/i.test(s) ||
        /^set\s+(session\s+)?(statement_timeout|lock_timeout|idle_in_transaction_session_timeout|work_mem|enable_\w+|jit|plan_cache_mode|random_page_cost)\b/i.test(s) ||
        /^set\s+(local\s+)?role\s+(?!anon\b|authenticated\b|service_role\b)/i.test(s) ||
        /supabase_migrations|schema_migrations|\bhttp_(get|post|request)\b|\bnet\.http|\bdblink\b|pg_read_file|lo_import/i.test(s) ||
        /set_config\(\s*'(statement_timeout|lock_timeout|idle_in_transaction_session_timeout|work_mem|enable_\w+|jit|plan_cache_mode|random_page_cost)'/i.test(s) ||
        /^explain\s*\([^)]*\banalyze\b/i.test(s) ||
        (ddl && !allowedDdl.has(sql));
      if (bad) throw new Error(`dependency-read rehearsal refuses: ${s.replace(/\s+/g, " ").slice(0, 120)}`);
      sent.push(sql);
      return c.query(sql, params);
    },
  };
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** Every case the rehearsal must record before it may be COMPLETE. */
export const REQUIRED_CASES = [
  "D0", "D1", "D2", "D3", "S0", "S1",
  "R0", "R1", "R2", "R2c", "R3", "R4", "R5", "R6", "R7", "R7m", "R7s", "R8", "R9",
  "P0",
  "F0", "F1", "F2", "F3", "F4", "F5", "F5x",
  "X1", "X2", "X3", "X4", "X5", "X6d", "X6", "X7", "X8", "X9",
  "T1", "T2", "X8t",
  "U1", "U2", "U3",
  "D9",
] as const;

export interface DependencyEvidence {
  label: string;
  files: Array<{ path: string; sha256: string; lf: string; crlf: string }>;
  statementsApplied: number;
  functions: Record<string, unknown>;
  rpc: Record<string, RpcStat>;
  fullVolume: Record<string, unknown> | null;
  materialization: Record<string, unknown>;
  timings: Record<string, unknown>;
  plans: Record<string, unknown>;
  /** The controlled due-probe (U*) cutoffs and key count. */
  dueProbe: Record<string, unknown> | null;
  /** T14S2: the anchored owner byte-cap probe's per-page rows/bytes and coverage. */
  ownerByteProbe: Record<string, unknown> | null;
  recorded: string[];
  complete: boolean;
}
export const newDependencyEvidence = (): DependencyEvidence => ({
  label: "SQL-serialization evidence (json_agg of the real function rows on the rehearsal transaction), NOT an observed PostgREST HTTP response; full-volume timings are single observations, not a scale certification",
  files: [], statementsApplied: 0, functions: {}, rpc: newRpcStats(), fullVolume: null, materialization: {}, timings: {}, plans: {}, dueProbe: null, ownerByteProbe: null, recorded: [], complete: false,
});
/** Missing required cases (never COMPLETE with any). */
export function evidenceProblems(ev: DependencyEvidence): string[] {
  const missing = REQUIRED_CASES.filter((id) => !ev.recorded.includes(id));
  return missing.length ? [`required rehearsal cases were not recorded: ${missing.join(", ")}`] : [];
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export { MIGRATION_0037, MIGRATION_0038, MIGRATION_0039 };
export type { FrozenReader, MaterializeStats, Owner, Site, FlowCtx };

// ---------------------------------------------------------------------------
// Fixtures (fixed, named; source-admissible; rolled back with everything else)
// ---------------------------------------------------------------------------

export interface Workers { w1: string; w2: string; w3: string; w4: string }
export type FixtureRow = Record<string, unknown> & { id: string; note: string };
const BLANK = "   "; // a trimmed-blank order (an event-partition owner), admissible under 0030
/** ~90 KB of multibyte, escaped and non-BMP text (10 jsonb bytes per 8 source bytes). */
export const BIG_NOTE = '"é\\\u{1F600}'.repeat(9_000);
export const BIG_NOTE_2 = '\\"\u{1F600}é'.repeat(9_000);
const bigId = (i: number) => `dr-big-${"é".repeat(60)}-${String(i).padStart(2, "0")}`;
const T = (day: string, hm: string, frac = "") => `2026-02-${day}T${hm}:00${frac}Z`;

/** The named rows at the first site (A) and the second (B). Every case below refers to these ids. */
export function dependencyFixtures(w: Workers): { a: FixtureRow[]; b: FixtureRow[] } {
  const r = (id: string, type: string, order: string, staff: string, at: string, o: Partial<FixtureRow> = {}): FixtureRow => ({
    id, event_type: type, order_number: order, staff_id: staff, created_at: at, department: "framed",
    line_sku: type === "line_verified" ? "INKA-KAN0566-A4-FB" : null, line_quantity: type === "line_verified" ? 1 : null,
    parent_event_id: null, cs_case_id: null, note: "", ...o,
  });
  const UN = { department: "unframed", line_sku: "INKA-KAN0566-A4-UN" };
  const a: FixtureRow[] = [
    // T14R2: tied members (U+1F600 / U+FFFD) with an any-type and a same-type predecessor
    r("dr-pf", "line_verified", "DR-0", w.w1, T("10", "07:40")),
    r("dr-pu", "line_verified", "DR-U", w.w1, T("10", "08:00"), UN),
    r("dr-\u{1F600}", "line_verified", "DR-1", w.w1, T("10", "08:10", ".000001")),
    r("dr-\uFFFD", "line_verified", "DR-1", w.w1, T("10", "08:10", ".000001")),
    // T14R1: prev/next (the refresh inserts dr-new between them)
    r("dr-prev", "line_verified", "DR-P", w.w1, T("10", "09:00")),
    r("dr-next", "line_verified", "DR-N", w.w1, T("10", "09:20")),
    // inverse children: a hidden (other-worker, blank-order) and an own cancellation
    r("dr-v", "line_verified", "DR-C", w.w1, T("10", "10:00")),
    r("dr-cx", "cancelled", BLANK, w.w2, T("10", "10:05"), { parent_event_id: "dr-v", line_sku: null, line_quantity: null }),
    r("dr-c-own", "cancelled", "DR-C", w.w1, T("10", "10:06"), { parent_event_id: "dr-v" }),
    // a cancellation whose parent arrives later (in the refresh)
    r("dr-orph", "cancelled", BLANK, w.w2, T("10", "11:00"), { parent_event_id: "dr-late" }),
    // changed owner + worker, a deletion and a site move (in the refresh)
    r("dr-chg", "line_verified", "DR-A", w.w1, T("10", "12:00")),
    r("dr-del", "line_verified", "DR-D", w.w1, T("10", "12:10")),
    r("dr-mv", "line_verified", "DR-MV", w.w1, T("10", "12:20")),
    // a future row (not due), bytewise keys and a timestamp tie
    r("dr-fut", "line_verified", "DR-F", w.w1, "2099-01-01T00:00:00Z"),
    r("dr-Ta", "line_verified", "DR-T", w.w1, T("10", "13:00")),
    r("dr-tb", "line_verified", "DR-T", w.w1, T("10", "13:00")),
    // the same id exists at the other site (scope isolation)
    r("dr-dup", "started", "DR-DUP", w.w1, T("10", "13:10")),
    // byte cases: a big owner, a big parent's children (multibyte/escaped/non-BMP, long ids)
    ...Array.from({ length: 15 }, (_, i) => r(bigId(i), "started", "DR-BIG", w.w3, T("12", `01:${String(i).padStart(2, "0")}`), { note: BIG_NOTE })),
    r("dr-bp", "line_verified", "DR-BP", w.w3, T("12", "02:00")),
    ...Array.from({ length: 15 }, (_, i) => r(`dr-bpc-${String(i).padStart(2, "0")}`, "cancelled", BLANK, w.w3, T("12", `02:${String(i + 1).padStart(2, "0")}`), { parent_event_id: "dr-bp", line_sku: null, line_quantity: null, note: BIG_NOTE })),
    // one row whose image alone fits the copy page but whose complete read row does not (padded after insert)
    r("dr-huge", "started", "DR-HUGE", w.w4, T("13", "00:00")),
    // 1,000 owners with ~1,200-byte keys
    ...Array.from({ length: 1000 }, (_, i) => r(`dr-k${String(i).padStart(4, "0")}`, "started", `DRK-${String(i).padStart(4, "0")}-${"k".repeat(1191)}`, w.w2, new Date(Date.parse("2026-02-11T00:00:00Z") + i * 1000).toISOString())),
  ];
  const b: FixtureRow[] = [
    r("dr-dup", "started", "DR-DUP-B", w.w1, T("10", "13:10")),
    r("dr-dupc", "cancelled", BLANK, w.w2, T("10", "10:07"), { parent_event_id: "dr-v", line_sku: null, line_quantity: null }),
  ];
  return { a, b };
}
/** Rows the refresh inserts at A. */
export const refreshInserts = (w: Workers): FixtureRow[] => [
  { id: "dr-new", event_type: "line_verified", order_number: "DR-X", staff_id: w.w1, created_at: T("10", "09:10"), department: "framed", line_sku: "INKA-KAN0566-A4-FB", line_quantity: 1, parent_event_id: null, cs_case_id: null, note: "" },
  { id: "dr-late", event_type: "line_verified", order_number: "DR-L", staff_id: w.w1, created_at: T("10", "10:50"), department: "framed", line_sku: "INKA-KAN0566-A4-FB", line_quantity: 1, parent_event_id: null, cs_case_id: null, note: "" },
];
export const BIG_IDS = Array.from({ length: 15 }, (_, i) => bigId(i));

const INSERT_SQL = `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id)
  select $1, x.id, x.staff_id, x.department, x.order_number, x.line_sku, x.line_quantity, x.event_type, 'dr-station', x.note, x.created_at, x.cs_case_id, x.parent_event_id
    from pg_catalog.jsonb_to_recordset($2::jsonb) as x(id text, staff_id uuid, department text, order_number text, line_sku text, line_quantity integer, event_type text, note text, created_at timestamptz, cs_case_id text, parent_event_id text)`;
export async function insertDependencyFixtures(c: Db, site: Site, rows: readonly FixtureRow[]): Promise<void> {
  const bad = rows.flatMap((x) => productionEventAdmissibility(x, site));
  if (bad.length) throw new Error(`fixture rows the source constraints would refuse: ${bad.join("; ")}`);
  for (let i = 0; i < rows.length; i += 200) await c.query(INSERT_SQL, [site, JSON.stringify(rows.slice(i, i + 200))]);
}

// ---------------------------------------------------------------------------
// SQL used by the cases (reads of the source/private state as the session owner; no writes but the named setup)
// ---------------------------------------------------------------------------

export const CASE_SQL = {
  users: "select u.id::text as id, u.email from auth.users u where u.email in ('staff@inka-staging.test', 'manager@inka-staging.test', 'cs@inka-staging.test', 'owner@inka-staging.test')",
  collisions: "select count(*)::int as n from public.production_events where location = any($1::text[]) and id like 'dr-%'",
  absent: `select
  (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'public' and p.proname in ('read_reporting_changed_keys', 'list_reporting_owners', 'read_reporting_owner_members', 'read_reporting_events_by_id', 'read_reporting_children', 'read_reporting_staff_stream'))
       or (n.nspname = 'reporting_private' and p.proname = 'frozen_read_batch'))::int as functions,
  (select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'reporting_private' and c.relname in ('source_current_staff_time', 'source_candidate_staff_time', 'source_candidate_owner_order', 'source_candidate_owner_event'))::int as indexes,
  (select count(*) from reporting_private.batches b where b.state in ('active', 'frozen', 'publishing'))::int as active,
  (select count(*) from public.locations l where l.key = 'staging')::int as marker`,
  effective: `select p.proname::text as name, md5(p.prosrc) as body_md5, p.prosecdef as definer, coalesce(array_to_string(p.proconfig, ','), '') as config,
  pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon, pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
  pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as service
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where (n.nspname = 'public' and p.proname in ('read_reporting_changed_keys', 'list_reporting_owners', 'read_reporting_owner_members', 'read_reporting_events_by_id', 'read_reporting_children', 'read_reporting_staff_stream'))
   or (n.nspname = 'reporting_private' and p.proname = 'frozen_read_batch')
order by 1`,
  indexes: "select count(*)::int as n from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'reporting_private' and c.relname in ('source_current_staff_time', 'source_candidate_staff_time', 'source_candidate_owner_order', 'source_candidate_owner_event')",
  view: "select pg_catalog.to_jsonb(pe) as img from public.production_events pe where pe.location = $1",
  padHuge: "update public.production_events set note = pg_catalog.repeat('h', $2::int - (select pg_catalog.octet_length(pg_catalog.to_jsonb(x)::text) from public.production_events x where x.location = $1 and x.id = 'dr-huge')) where location = $1 and id = 'dr-huge'",
  hugeSize: "select pg_catalog.octet_length(pg_catalog.to_jsonb(pe)::text)::int as n from public.production_events pe where pe.location = $1 and pe.id = 'dr-huge'",
  candidateEquality: `select
  (select count(*) from reporting_private.source_candidate sc where sc.batch_id = $1::uuid and sc.site = $2)::text as candidate_rows,
  (select count(*) from public.production_events pe where pe.location = $2)::text as source_rows,
  (select md5(coalesce(string_agg(sc.event_id || ':' || md5(sc.image::text), ',' order by sc.event_id collate "C"), '')) from reporting_private.source_candidate sc where sc.batch_id = $1::uuid and sc.site = $2) as candidate_md5,
  (select md5(coalesce(string_agg(pe.id || ':' || md5(pg_catalog.to_jsonb(pe)::text), ',' order by pe.id collate "C"), '')) from public.production_events pe where pe.location = $2) as source_md5,
  (select coalesce(sum(pg_catalog.octet_length(sc.image::text)), 0)::text from reporting_private.source_candidate sc where sc.batch_id = $1::uuid and sc.site = $2) as candidate_bytes`,
  batch: "select b.batch_id::text as batch_id, b.lease_fence::text as fence, pg_catalog.to_char(b.source_cutoff at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as cutoff, b.state, b.kind from reporting_private.batches b where b.batch_id = $1::uuid",
  fingerprint: `select md5(concat_ws('|',
  (select md5(coalesce(string_agg(sc.event_id || md5(sc.image::text), ',' order by sc.event_id collate "C"), '')) from reporting_private.source_candidate sc where sc.batch_id = $1::uuid),
  (select md5(coalesce(string_agg(be.event_id || coalesce(md5(be.image::text), 'null'), ',' order by be.event_id collate "C"), '')) from reporting_private.batch_events be where be.batch_id = $1::uuid),
  (select md5(coalesce(string_agg(s.site || s.event_id || md5(s.image::text), ',' order by s.site, s.event_id collate "C"), '')) from reporting_private.source_current s where s.site = any($2::text[])),
  (select md5(coalesce(string_agg(pe.location || pe.id || md5(pg_catalog.to_jsonb(pe)::text), ',' order by pe.location, pe.id collate "C"), '')) from public.production_events pe where pe.location = any($2::text[])),
  (select b.state || b.lease_fence::text || coalesce(b.lease_expires_at::text, '') || coalesce(b.source_cutoff::text, '') from reporting_private.batches b where b.batch_id = $1::uuid)
)) as h`,
  largestOwner: "select sc.order_key as k, count(*)::int as n from reporting_private.source_candidate sc where sc.batch_id = $1::uuid and sc.site = $2 and coalesce(sc.order_key, '') <> '' and sc.event_id not like 'dr-%' group by sc.order_key order by count(*) desc, sc.order_key collate \"C\" limit 1",
  busiestStaff: "select sc.staff_id::text as s, count(*)::int as n from reporting_private.source_candidate sc where sc.batch_id = $1::uuid and sc.site = $2 and sc.event_id not like 'dr-%' and sc.staff_id is not null and sc.staff_id <> $3::uuid group by sc.staff_id order by count(*) desc, sc.staff_id limit 1",
  /** Same-length change of the oversized row (its base and frozen images together cannot fit one response). */
  /** The due-probe row: 500 ms before this transaction's timestamp (fixed SQL; admissibility mirrored in S1). */
  insertDue: "insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id) values ($1, 'dr-due', $2::uuid, 'framed', 'DR-DUE', 'INKA-KAN0566-A4-FB', 1, 'line_verified', 'dr-station', '', pg_catalog.transaction_timestamp() - interval '500 milliseconds', null, null)",
  /** Due probe (inside a savepoint): ONLY the run-owned, still-frozen, unsealed rebuild's cutoff moves back 1 s. */
  dueCutoff: "update reporting_private.batches set source_cutoff = pg_catalog.transaction_timestamp() - interval '1 second' where batch_id = $1::uuid and kind = 'rebuild' and state = 'frozen' and sealed_at is null",
  duePending: "select count(*)::int as n from reporting_private.site_pending_changes($1) as p(change_id) join reporting_private.changes c on c.change_id = p.change_id where 'dr-due' in (c.old_event_id, c.new_event_id)",
  dueWindow: "select (b.source_cutoff < pe.created_at and pe.created_at <= r.source_cutoff) as inside from reporting_private.batches b, reporting_private.batches r, public.production_events pe where b.batch_id = $1::uuid and r.batch_id = $2::uuid and pe.location = $3 and pe.id = 'dr-due'",
  touchHuge: "update public.production_events set note = pg_catalog.translate(note, 'h', 'g') where location = $1 and id = 'dr-huge'",
} as const;

// ---------------------------------------------------------------------------
// T14S2: deterministic owner byte-cap probe (anchored immediately before the long-key group)
// ---------------------------------------------------------------------------

/** Anchor: strictly before every `DRK-…` key (owner keyset is (kind, key COLLATE "C")). */
export const OWNER_PROBE_ANCHOR = { kind: "order" as const, key: "DRK-" };
type OwnerRow = { partition_kind: string; partition_key: string };
const ownerRowBytes = (rows: readonly unknown[]) => Buffer.byteLength(JSON.stringify(rows), "utf8");
export interface OwnerProbeEvidence { anchor: string; suffixOwners: number; uncappedCompactBytes: number; pages: Array<{ rows: number; compactBytes: number }>; longKeysCovered: number }
/**
 * Pure check of the anchored probe's two pages against the INDEPENDENT sorted
 * owner list. The suffix after the anchor must begin with exactly the 1,000
 * fixture owners (anything interleaved fails, never assumed away); the full
 * requested page of that suffix must exceed 1 MiB; the first response must be
 * non-empty and SHORT of the 1,000-row limit; the second must be a non-empty
 * exact continuation; both pages must be the exact suffix in order (no
 * missing, repeated or skipped owner), together hold all 1,000 fixture owners,
 * and each stay within 1 MiB.
 */
export function checkOwnerByteProbe(expected: readonly Owner[], fixtureKeys: readonly string[], page1: readonly OwnerRow[], page2: readonly OwnerRow[]): { problems: string[]; evidence: OwnerProbeEvidence } {
  const anchor = ownerKey({ partitionKind: OWNER_PROBE_ANCHOR.kind, partitionKey: OWNER_PROBE_ANCHOR.key });
  const suffix = expected.filter((o) => compareUtf8(ownerKey(o), anchor) > 0);
  const wantLong = [...fixtureKeys].sort(compareUtf8);
  const asRows = (os: readonly Owner[]): OwnerRow[] => os.map((o) => ({ partition_kind: o.partitionKind, partition_key: o.partitionKey }));
  const uncapped = ownerRowBytes(asRows(suffix.slice(0, 1000)));
  const p: string[] = [];
  const head = suffix.slice(0, wantLong.length);
  if (head.length !== wantLong.length || head.some((o, i) => o.partitionKind !== "order" || o.partitionKey !== wantLong[i])) {
    const bad = head.findIndex((o, i) => o.partitionKind !== "order" || o.partitionKey !== wantLong[i]);
    p.push(`the independent owner suffix after (order, ${JSON.stringify(OWNER_PROBE_ANCHOR.key)}) does not begin with the ${wantLong.length} long-key fixture owners (first difference at ${bad < 0 ? head.length : bad}: ${JSON.stringify(head[bad]?.partitionKey?.slice(0, 40) ?? null)})`);
  }
  if (uncapped <= MIB) p.push(`the uncapped requested page would be ${uncapped} bytes; the probe needs more than 1 MiB`);
  const id = (r: OwnerRow) => `${r.partition_kind}\u0000${r.partition_key}`;
  const want = asRows(suffix).map(id);
  if (page1.length === 0) p.push("the anchored first owner page is empty");
  if (page1.length >= 1000) p.push(`the anchored first owner page is full (${page1.length} rows); it must be byte-capped short of 1,000`);
  if (page2.length === 0) p.push("the exact continuation after the byte-capped owner page is empty");
  const got = [...page1, ...page2].map(id);
  const seen = new Set<string>();
  for (const [i, k] of got.entries()) {
    if (seen.has(k)) p.push(`owner probe: ${JSON.stringify(k.slice(0, 48))} returned twice`);
    seen.add(k);
    if (want[i] !== k) {
      p.push(`owner probe position ${i}${i < page1.length ? " (first page)" : " (continuation)"}: got ${JSON.stringify(k.slice(0, 48))}, the independent suffix has ${JSON.stringify(want[i]?.slice(0, 48) ?? null)}`);
      break;
    }
  }
  const covered = wantLong.filter((k) => seen.has(`order\u0000${k}`)).length;
  if (covered !== wantLong.length) p.push(`the two pages hold ${covered} of the ${wantLong.length} long-key owners`);
  const b1 = ownerRowBytes(page1);
  const b2 = ownerRowBytes(page2);
  if (b1 > MIB || b2 > MIB) p.push(`an owner probe response exceeds 1 MiB (${b1}, ${b2})`);
  return { problems: p, evidence: { anchor: `order/${OWNER_PROBE_ANCHOR.key}`, suffixOwners: suffix.length, uncappedCompactBytes: uncapped, pages: [{ rows: page1.length, compactBytes: b1 }, { rows: page2.length, compactBytes: b2 }], longKeysCovered: covered } };
}
/** The probe's two real calls: anchored first page (limit 1,000), then the exact continuation from its last returned key. */
export async function runOwnerByteProbe(call: (fn: string, args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>, ref: { p_batch: string; p_fence: number }): Promise<{ page1: OwnerRow[]; page2: OwnerRow[] }> {
  const page1 = (await call("list_reporting_owners", { ...ref, p_after_kind: OWNER_PROBE_ANCHOR.kind, p_after_key: OWNER_PROBE_ANCHOR.key, p_limit: 1000 })) as OwnerRow[];
  if (!page1.length) return { page1, page2: [] };
  const last = page1[page1.length - 1];
  const page2 = (await call("list_reporting_owners", { ...ref, p_after_kind: last.partition_kind, p_after_key: last.partition_key, p_limit: 1000 })) as OwnerRow[];
  return { page1, page2 };
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

export interface CaseEnv { text0041: string; ev: DependencyEvidence }
/** The independent frozen view: FULL raw images (membership/diffs) and their projector events (projection input). */
async function independentView(c: Db, site: Site): Promise<RawView> {
  return rawView((await c.query(CASE_SQL.view, [site])).rows as Array<{ img: unknown }>, site);
}
/** The frozen stream order (exact instant, bytewise id), as the reads and the materializer define it. */
const sortStream = (xs: Ev[]) => [...xs].sort(compareStream);
async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
/** A complete stream walk through the real reader: page until an EMPTY page, refusing non-progress. */
async function fullStream(reader: FrozenReader, staff: string, direction: "before" | "after", from: { createdAt: string; id: string }): Promise<Ev[]> {
  const out: Ev[] = [];
  let cursor = from;
  for (let pages = 0; ; pages++) {
    if (pages > 100_000) throw new Error("stream walk did not finish (non-progress guard)");
    const page = await reader.stream(staff, direction, cursor, 1000);
    if (!page.length) return out;
    const last = page[page.length - 1];
    if (last.id === cursor.id && last.created_at === cursor.createdAt) throw new Error("stream walk made no progress");
    out.push(...page);
    cursor = { createdAt: last.created_at, id: last.id };
  }
}
function expectNone(what: string, problems: string[]): string {
  if (problems.length) throw new Error(`${what}: ${problems.slice(0, 8).join("; ")}${problems.length > 8 ? ` (+${problems.length - 8} more)` : ""}`);
  return "exact";
}
async function batchRow(c: Db, batch: string) {
  const r = (await c.query(CASE_SQL.batch, [batch])).rows[0];
  if (!r || typeof r.cutoff !== "string") throw new Error(`batch ${batch} has no frozen cutoff`);
  return { batchId: String(r.batch_id), fence: Number(r.fence), cutoff: r.cutoff, state: String(r.state), kind: String(r.kind) };
}
const owner = (kind: "order" | "event", key: string): Owner => ({ partitionKind: kind, partitionKey: key });

/** The real-SQL cases (all inside the caller's rolled-back transaction). */
export async function runDependencyCases(c: Db, ctx: FlowCtx, env: CaseEnv): Promise<void> {
  const ev = env.ev;
  const [A, B] = ctx.sites;
  const client = sqlRpcClient(c, ctx.as, ev.rpc, ctx.now);
  const call = async (fn: string, args: Record<string, unknown>) => {
    const r = await client.rpc(fn, args);
    return r.data as Array<Record<string, unknown>>;
  };
  // ---- setup ----
  const users = new Map((await c.query(CASE_SQL.users)).rows.map((r) => [String(r.email), String(r.id)]));
  const w: Workers = { w1: users.get("staff@inka-staging.test")!, w2: users.get("manager@inka-staging.test")!, w3: users.get("cs@inka-staging.test")!, w4: users.get("owner@inka-staging.test")! };
  await step(c, ctx, "S0", "enable capture and both processors INSIDE the rolled-back transaction", async () => {
    if (Object.values(w).some((x) => !x)) throw new Error("the four staging test users are required");
    await rpc(c, ctx, "select * from public.set_reporting_capture(true)", []);
    await rpc(c, ctx, "update reporting_private.site_state set processor_enabled = true where site = any($1::text[])", [[A, B]]);
  });
  const fx = dependencyFixtures(w);
  await step(c, ctx, "S1", `insert ${fx.a.length} named fixture rows at ${A} and ${fx.b.length} at ${B}; pad dr-huge to a just-copyable image`, async () => {
    await insertDependencyFixtures(c, A, fx.a);
    await insertDependencyFixtures(c, B, fx.b);
    await c.query(CASE_SQL.padHuge, [A, MIB - 16]);
    const n = Number((await c.query(CASE_SQL.hugeSize, [A])).rows[0].n);
    if (n !== MIB - 16) throw new Error(`dr-huge image is ${n} bytes, expected ${MIB - 16}`);
    // The due-probe row (U*): 500 ms before this transaction's timestamp, so it is due at the rebuild cutoff (now()).
    const dueBad = productionEventAdmissibility({ id: "dr-due", staff_id: w.w1, department: "framed", order_number: "DR-DUE", line_sku: "INKA-KAN0566-A4-FB", line_quantity: 1, event_type: "line_verified", parent_event_id: null, created_at: "2026-01-01T00:00:00Z" }, A);
    if (dueBad.length) throw new Error(dueBad.join("; "));
    const due = await c.query(CASE_SQL.insertDue, [A, w.w1]);
    if (due.rowCount !== 1) throw new Error("dr-due was not inserted");
    return n;
  }, (n) => `dr-huge image ${n} bytes; dr-due at transaction_timestamp() - 500 ms`);

  // ---- rebuild of A: candidate reads ----
  const rb = await step(c, ctx, "R0", `begin, copy (bounded pages) and freeze a rebuild of ${A} (original full volume + fixtures)`, async () => {
    const [x] = await rpc(c, ctx, "select * from public.begin_reporting_rebuild($1)", [A]);
    const pages = await copyAll(c, ctx, String(x.batch_id), Number(x.lease_fence));
    await rpc(c, ctx, "select * from public.freeze_reporting_rebuild($1, $2)", [x.batch_id, x.lease_fence]);
    return { ...(await batchRow(c, String(x.batch_id))), pages };
  }, (x) => `${x.pages.pages} pages, ${x.pages.rows} rows`);
  const reader = rpcFrozenReader(client, { batchId: rb.batchId, fence: rb.fence, site: A, cutoff: rb.cutoff, kind: "rebuild" });
  const rv1 = await independentView(c, A);
  const view1 = rv1.events;
  await step(c, ctx, "R1", "full volume: the frozen candidate is exactly the source (count, ids and images)", async () => {
    const e = (await c.query(CASE_SQL.candidateEquality, [rb.batchId, A])).rows[0];
    ev.fullVolume = e;
    if (e.candidate_rows !== e.source_rows || e.candidate_md5 !== e.source_md5) throw new Error(`candidate ${e.candidate_rows}/${e.candidate_md5} vs source ${e.source_rows}/${e.source_md5}`);
    if (String(view1.length) !== e.source_rows) throw new Error("the independent view does not match the source count");
    return e;
  }, (e) => `${String(e.source_rows)} rows, ${String(e.candidate_bytes)} image bytes`);
  // Immutability baseline BEFORE the first successful ordinary read (R2), so a read that mutates cannot be absorbed into it.
  const fp = async (batch: string) => String((await c.query(CASE_SQL.fingerprint, [batch, [A, B]])).rows[0].h);
  const before1 = await fp(rb.batchId);
  const capped = (fn: string, what: string, p: string[]) => {
    if (ev.rpc[fn].cappedContinuations < 1) p.push(`no byte-capped non-final ${what} page was followed by its exact continuation`);
  };
  const ownersExpected = [...new Map(view1.map((e) => [ownerKey(ownerOfEvent(e)), ownerOfEvent(e)])).values()].sort((x, y) => compareUtf8(ownerKey(x), ownerKey(y)));
  await step(c, ctx, "R2", "list_reporting_owners: complete enumeration through the real reader; every owner exactly once in bytewise order, incl. all 1,000 ~1,200-byte keys", async () => {
    const got = await drain(reader.owners());
    const p: string[] = [];
    if (canonicalJson(got) !== canonicalJson(ownersExpected)) p.push(`owners differ (${got.length} vs ${ownersExpected.length})`);
    if (got.filter((o) => o.partitionKey.startsWith("DRK-")).length !== 1000) p.push("not all 1,000 long-key owners were listed");
    return expectNone("R2", p);
  });
  // T14S2: the byte cap is proven by its OWN anchored probe, never by wherever ordinary 1,000-row pages happened to fall in R2.
  const longKeys = fx.a.filter((x) => String(x.order_number).startsWith("DRK-")).map((x) => String(x.order_number));
  await step(c, ctx, "R2c", "owner byte cap (deterministic): anchored at (order, 'DRK-') with limit 1,000, the first response is non-empty and byte-capped short, its exact continuation is non-empty, both pages are the independent owner suffix and hold all 1,000 long keys", async () => {
    const { page1, page2 } = await runOwnerByteProbe(call, { p_batch: rb.batchId, p_fence: rb.fence });
    const r = checkOwnerByteProbe(ownersExpected, longKeys, page1, page2);
    ev.ownerByteProbe = r.evidence as unknown as Record<string, unknown>;
    const p = [...r.problems];
    capped("list_reporting_owners", "owner", p); // the existing owner cap check, now evaluated where its evidence is deterministic
    return expectNone("R2c", p);
  });
  const controlled: Owner[] = [
    owner("order", "DR-0"), owner("order", "DR-U"), owner("order", "DR-1"), owner("order", "DR-P"), owner("order", "DR-N"), owner("order", "DR-C"), owner("event", "dr-cx"),
    owner("event", "dr-orph"), owner("order", "DR-A"), owner("order", "DR-D"), owner("order", "DR-MV"), owner("order", "DR-F"), owner("order", "DR-T"), owner("order", "DR-DUP"),
    owner("order", "DR-BIG"), owner("order", "DR-BP"), owner("event", "dr-bpc-00"),
  ];
  const membersOf = (view: Ev[], o: Owner) => view.filter((e) => ownerKey(ownerOfEvent(e)) === ownerKey(o));
  await step(c, ctx, "R3", "owner members (candidate): exact frozen images for every controlled owner; the 15 big rows continue past a byte-capped page", async () => {
    const p: string[] = [];
    for (const o of controlled) {
      const got = (await reader.members([o], 50_000)).get(ownerKey(o)) ?? [];
      p.push(...compareEvents(`members ${o.partitionKey}`, membersOf(view1, o), got));
    }
    capped("read_reporting_owner_members", "members", p);
    return expectNone("R3", p);
  });
  const byId = (view: Ev[], ids: string[]) => view.filter((e) => ids.includes(e.id));
  const probeIds = ["dr-absent", "dr-dup", "dr-fut", "dr-Ta", "dr-tb", "dr-\u{1F600}", "dr-�", ...BIG_IDS];
  await step(c, ctx, "R4", "events by id (candidate): present ids exact (the A copy of a cross-site duplicate), absent ids absent, byte-capped continuation", async () => {
    const got = [...(await reader.byIds(probeIds)).values()];
    const p = compareEvents("byIds", byId(view1, probeIds), got);
    capped("read_reporting_events_by_id", "by-id", p);
    return expectNone("R4", p);
  });
  const kidsOf = (view: Ev[], parents: string[]) => view.filter((e) => e.parent_event_id !== null && parents.includes(e.parent_event_id));
  await step(c, ctx, "R5", "inverse children (candidate): exact, scoped to the site (B's child of the same parent id excluded), 15 big children continue past a byte-capped page", async () => {
    const parents = ["dr-v", "dr-late", "dr-bp"];
    const p = compareEvents("children", kidsOf(view1, parents), await drain(reader.children(parents)));
    capped("read_reporting_children", "children", p);
    return expectNone("R5", p);
  });
  const FAR_PAST = { createdAt: "2000-01-01T00:00:00.000000Z", id: "" };
  const FAR_FUTURE = { createdAt: "2100-01-01T00:00:00.000000Z", id: "" };
  await step(c, ctx, "R6", "worker streams (candidate): complete before/after walks equal the frozen order (time, bytewise id; ties), big rows continue past byte-capped pages", async () => {
    const p: string[] = [];
    for (const s of [w.w1, w.w3]) {
      const want = sortStream(view1.filter((e) => e.staff_id === s));
      const after = await fullStream(reader, s, "after", FAR_PAST);
      const before = await fullStream(reader, s, "before", FAR_FUTURE);
      if (canonicalJson(after.map((e) => e.id)) !== canonicalJson(want.map((e) => e.id))) p.push(`after-walk order differs for ${s}`);
      if (canonicalJson(before.map((e) => e.id)) !== canonicalJson([...want].reverse().map((e) => e.id))) p.push(`before-walk order differs for ${s}`);
      p.push(...compareEvents(`stream ${s}`, want, after));
    }
    capped("read_reporting_staff_stream", "stream", p);
    return expectNone("R6", p);
  });
  const ref = { p_batch: rb.batchId, p_fence: rb.fence };
  await refused(c, ctx, "R7", "a single returned row that cannot fit 1 MiB fails visibly (events by id, members, stream)", /one response row \(dr-huge\) is larger than 1 MiB/, async () => {
    await call("read_reporting_events_by_id", { ...ref, p_ids: ["dr-huge"] });
  });
  await refused(c, ctx, "R7m", "…members of the oversized row's owner", /one response row \(dr-huge\) is larger than 1 MiB/, async () => {
    await call("read_reporting_owner_members", { ...ref, p_owners: [["order", "DR-HUGE"]], p_after_index: null, p_after_event_id: null, p_limit: 1000 });
  });
  // Anchored at dr-huge's exact instant with the smallest id and limit 1: the oversized row is the FIRST row, whatever the worker's other history.
  const hugeAt = String(fx.a.find((x) => x.id === "dr-huge")!.created_at);
  await refused(c, ctx, "R7s", "…the oversized row's worker stream, anchored immediately before it (limit 1)", /one response row \(dr-huge\) is larger than 1 MiB/, async () => {
    await call("read_reporting_staff_stream", { ...ref, p_staff: w.w4, p_direction: "after", p_at: hugeAt, p_at_event_id: "", p_limit: 1 });
  });
  const oracle1 = frozenOracle(A, rb.cutoff, view1);
  await step(c, ctx, "R8", "materializer (rebuild) through the REAL reader for the controlled owners: every independently required audience present on both paths; descriptors/input hashes and five families equal the independent view and the full frozen-view oracle (incl. T14R2 tied members)", async () => {
    const t0 = ctx.now();
    const stats: MaterializeStats = { owners: 0, works: 0, maxInput: 0, totalInput: 0, requests: 0, peakInput: 0 };
    const viaRpc: MaterializedWork[] = [];
    const baseCalls = Object.values(ev.rpc).reduce((n, s) => n + s.calls, 0);
    await materializeOwners(reader, controlled, new Map(), (x) => void viaRpc.push(x), stats);
    const calls = Object.values(ev.rpc).reduce((n, s) => n + s.calls, 0) - baseCalls;
    const viaMem: MaterializedWork[] = [];
    await materializeOwners(memoryFrozenReader({ site: A, cutoff: rb.cutoff, kind: "rebuild", view: view1, changed: [] }), controlled, new Map(), (x) => void viaMem.push(x), { owners: 0, works: 0, maxInput: 0, totalInput: 0, requests: 0, peakInput: 0 });
    ev.materialization.rebuild = { owners: stats.owners, works: stats.works, maxInput: stats.maxInput, totalInput: stats.totalInput, sqlCalls: calls, ms: Math.round(ctx.now() - t0) };
    // Independent requirement: every audience with non-empty full-view rows for a controlled owner (before = nothing).
    const keep = new Set(controlled.map(ownerKey));
    const staff = [...new Set(controlled.flatMap((o) => membersOf(view1, o)).map((e) => e.staff_id).filter((s): s is string => !!s))];
    const required = [...requiredWorks(A, null, { view: view1, cutoff: rb.cutoff }, staff)].filter((k) => keep.has(k.slice(k.indexOf("|", k.indexOf("|") + 1) + 1)));
    const p = [...missingRequired(required, viaRpc, viaMem), ...compareMaterialization(viaRpc, viaMem, oracle1)];
    if (required.length < controlled.length) p.push(`only ${required.length} required works for ${controlled.length} controlled owners (vacuous)`);
    const dr1 = viaRpc.find((x) => x.desc.audienceKind === "site" && x.desc.partitionKey === "DR-1");
    const tf = (dr1?.rows.timing_facts ?? []) as Array<Record<string, unknown>>;
    if (tf[0]?.event_id !== "dr-\u{1F600}" || tf[0]?.prev_all_event_id !== "dr-pu" || tf[0]?.prev_same_type_event_id !== "dr-pf") p.push(`T14R2 tied-member predecessors are ${JSON.stringify(tf[0] ?? null)}`);
    ev.materialization.rebuildRequired = required.length;
    return expectNone("R8", p);
  }, () => "exact");
  await step(c, ctx, "R9", "every applicable read stayed within 1,000 rows and 1 MiB (PostgreSQL json_agg and compact client JSON)", async () => {
    const p: string[] = [];
    for (const [fn, s] of Object.entries(ev.rpc)) {
      if (s.maxRows > 1000) p.push(`${fn} ${s.maxRows} rows`);
      if (s.maxCompactBytes > MIB) p.push(`${fn} ${s.maxCompactBytes} compact bytes`);
    }
    return expectNone("R9", p);
  });
  await step(c, ctx, "X8", "the successful ordinary reads R2-R9 changed nothing: candidate, base mirror, source rows and batch metadata fingerprints equal the pre-R2 baseline", async () => {
    const after = await fp(rb.batchId);
    if (after !== before1) throw new Error("a read mutated frozen/base/source state");
    return after;
  });

  // ---- security probes on the frozen rebuild (each in its own savepoint) ----
  await refused(c, ctx, "X1", "an obsolete fence is refused", /fence .* is obsolete/, () => call("read_reporting_events_by_id", { p_batch: rb.batchId, p_fence: rb.fence + 1, p_ids: ["dr-v"] }));
  await refused(c, ctx, "X2", "a refresh-only read of a rebuild batch is refused", /read_reporting_changed_keys is a refresh read/, () => call("read_reporting_changed_keys", { ...ref, p_after_event_id: null, p_limit: 10 }));
  await refused(c, ctx, "X3", "anon cannot execute the reads", /permission denied for function read_reporting_events_by_id/, async () => {
    await c.query("set local role anon");
    const q = dependencyRpcSql("read_reporting_events_by_id", { ...ref, p_ids: ["dr-v"] });
    await c.query(q.sql, q.params);
  });
  await refused(c, ctx, "X4", "authenticated cannot execute the reads", /permission denied for function read_reporting_staff_stream/, async () => {
    await c.query("set local role authenticated");
    const q = dependencyRpcSql("read_reporting_staff_stream", { ...ref, p_staff: w.w1, p_direction: "after", p_at: FAR_PAST.createdAt, p_at_event_id: "", p_limit: 10 });
    await c.query(q.sql, q.params);
  });
  await refused(c, ctx, "X5", "an expired lease is refused (lease moved into the past inside a savepoint)", /lease expired/, async () => {
    await c.query("update reporting_private.batches set lease_expires_at = now() - interval '1 second' where batch_id = $1::uuid", [rb.batchId]);
    await call("read_reporting_children", { ...ref, p_parent_ids: ["dr-v"], p_after_parent_id: null, p_after_event_id: null, p_limit: 10 });
  });
  await refused(c, ctx, "X6d", "drift: capture disabled (inside a savepoint) is refused", /is no longer valid: capture is disabled/, async () => {
    await rpc(c, ctx, "select * from public.set_reporting_capture(false)", []);
    await call("read_reporting_owner_members", { ...ref, p_owners: [["order", "DR-C"]], p_after_index: null, p_after_event_id: null, p_limit: 10 });
  });
  await refused(c, ctx, "X6", "drift: capture epoch changed (off then on inside a savepoint) is refused", /is no longer valid: capture epoch changed/, async () => {
    await rpc(c, ctx, "select * from public.set_reporting_capture(false)", []);
    await rpc(c, ctx, "select * from public.set_reporting_capture(true)", []);
    await call("read_reporting_owner_members", { ...ref, p_owners: [["order", "DR-C"]], p_after_index: null, p_after_event_id: null, p_limit: 10 });
  });
  await refused(c, ctx, "X7", "a batch that is not frozen (a fresh active rebuild of the other site) is refused", /dependency reads need a frozen batch/, async () => {
    const [x] = await rpc(c, ctx, "select * from public.begin_reporting_rebuild($1)", [B]);
    await call("read_reporting_events_by_id", { p_batch: x.batch_id, p_fence: Number(x.lease_fence), p_ids: ["dr-dup"] });
  });

  // ---- full-volume timings and plans (single observations; not a scale certification) ----
  const plansOf = async (fn: "read_reporting_owner_members" | "read_reporting_staff_stream", params: unknown[]) => {
    await ctx.as(c, true);
    const r = await c.query(planSql(env.text0041, fn), params);
    await ctx.as(c, false);
    return r.rows[0]?.["QUERY PLAN"] ?? null;
  };
  const timed = async (fn: string, args: Record<string, unknown>) => {
    const t0 = ctx.now();
    const rows = await call(fn, args);
    return { rows, ms: Math.round(ctx.now() - t0) };
  };
  await step(c, ctx, "T1", "owner members on the full volume: first and later page timed; the effective statement's plan recorded", async () => {
    const lo = (await c.query(CASE_SQL.largestOwner, [rb.batchId, A])).rows[0];
    if (!lo) throw new Error("no real owner in the candidate");
    const owners = [["order", String(lo.k)]];
    const first = await timed("read_reporting_owner_members", { ...ref, p_owners: owners, p_after_index: null, p_after_event_id: null, p_limit: 1000 });
    const lastId = first.rows.length ? String(first.rows[first.rows.length - 1].event_id) : null;
    const later = await timed("read_reporting_owner_members", { ...ref, p_owners: owners, p_after_index: lastId === null ? null : 0, p_after_event_id: lastId, p_limit: 1000 });
    const kind = "rebuild";
    ev.plans.members_first = await plansOf("read_reporting_owner_members", [rb.batchId, A, kind, JSON.stringify(owners), null, null, 1000]);
    ev.plans.members_later = await plansOf("read_reporting_owner_members", [rb.batchId, A, kind, JSON.stringify(owners), lastId === null ? null : 0, lastId, 1000]);
    ev.timings.members = { owner_rows: lo.n, first: { rows: first.rows.length, ms: first.ms }, later: { rows: later.rows.length, ms: later.ms } };
    return ev.timings.members;
  }, (x) => JSON.stringify(x));
  await step(c, ctx, "T2", "worker streams on the full volume: before/after first and later pages timed; both directions' plans recorded", async () => {
    const bs = (await c.query(CASE_SQL.busiestStaff, [rb.batchId, A, w.w4])).rows[0]; // the oversized row's worker is excluded (its stream refuses by design, R7s)
    if (!bs) throw new Error("no real worker in the candidate");
    const out: Record<string, unknown> = { staff_rows: bs.n };
    for (const [dir, from] of [["before", FAR_FUTURE], ["after", FAR_PAST]] as const) {
      const args = (at: { createdAt: string; id: string }) => ({ ...ref, p_staff: String(bs.s), p_direction: dir, p_at: at.createdAt, p_at_event_id: at.id, p_limit: 1000 });
      const first = await timed("read_reporting_staff_stream", args(from));
      const last = first.rows[first.rows.length - 1] as { event_id?: string; image?: { created_at?: string } } | undefined;
      const next = last ? { createdAt: String(last.image?.created_at), id: String(last.event_id) } : from;
      const later = await timed("read_reporting_staff_stream", args(next));
      out[dir] = { first: { rows: first.rows.length, ms: first.ms }, later: { rows: later.rows.length, ms: later.ms } };
      ev.plans[`stream_${dir}_first`] = await plansOf("read_reporting_staff_stream", [rb.batchId, A, "rebuild", String(bs.s), dir, from.createdAt, from.id, 1000]);
      ev.plans[`stream_${dir}_later`] = await plansOf("read_reporting_staff_stream", [rb.batchId, A, "rebuild", String(bs.s), dir, next.createdAt, next.id, 1000]);
    }
    ev.timings.stream = out;
    return out;
  }, (x) => JSON.stringify(x));
  await step(c, ctx, "X8t", "the timed full-volume reads T1-T2 changed nothing either (same pre-R2 baseline)", async () => {
    const after = await fp(rb.batchId);
    if (after !== before1) throw new Error("a timed read mutated frozen/base/source state");
    return after;
  });

  // ---- due probe (setup only, in ONE savepoint; restored before P0) ----
  // Both normal cutoffs are now() of this one transaction, so they are equal. To exercise the refresh due branch
  // (base cutoff < event time <= refresh cutoff) this probe moves ONLY this run's still-frozen, unsealed rebuild
  // cutoff to transaction_timestamp() - 1 s, publishes it with zero work, and freezes a refresh at now(). Controlled
  // time transition, not a wall-clock observation. Everything is rolled back to the savepoint afterwards.
  await c.query("savepoint dr_due");
  let dueError: unknown = null;
  try {
    const base = await step(c, ctx, "U1", "DUE PROBE SETUP: this run's frozen unsealed rebuild cutoff -> transaction_timestamp() - 1 s; seal zero work and publish (no source edit afterwards); dr-due has no pending journal entry", async () => {
      const r = await c.query(CASE_SQL.dueCutoff, [rb.batchId]);
      if (r.rowCount !== 1) throw new Error("the run's rebuild is not a still-frozen, unsealed batch");
      const b = await batchRow(c, rb.batchId);
      await rpc(c, ctx, "select * from public.seal_reporting_work($1, $2, 0, $3)", [rb.batchId, rb.fence, reportingManifestHash([])]);
      await publish(c, ctx, rb.batchId, rb.fence);
      const pending = Number((await c.query(CASE_SQL.duePending, [A])).rows[0].n);
      if (pending !== 0) throw new Error(`dr-due still has ${pending} pending journal entr${pending === 1 ? "y" : "ies"}`);
      return b;
    }, (b) => `base cutoff ${b.cutoff}`);
    await step(c, ctx, "U2", "begin_reporting_batch at now(): dr-due enters through the DUE branch only (base cutoff < event time <= refresh cutoff), raw before/after images identical; dr-fut (2099) absent; the set is exactly the independent due set", async () => {
      const [x] = await rpc(c, ctx, "select * from public.begin_reporting_batch($1)", [A]);
      const r = await batchRow(c, String(x.batch_id));
      const rows: Array<Record<string, unknown>> = [];
      for (let after: string | null = null, n = 0; ; n++) {
        if (n > 50) throw new Error("due changed-key read did not finish");
        const page = await call("read_reporting_changed_keys", { p_batch: r.batchId, p_fence: r.fence, p_after_event_id: after, p_limit: 1000 });
        if (!page.length) break;
        rows.push(...page);
        after = String(page[page.length - 1].event_id);
      }
      const p: string[] = [];
      const want = expectedChangedKeys(rv1, rv1, base.cutoff, r.cutoff).map((k) => k.id);
      const got = rows.map((k) => String(k.event_id));
      if (canonicalJson(got) !== canonicalJson(want)) p.push(`due keys ${JSON.stringify(got.slice(0, 10))} differ from the independent due set ${JSON.stringify(want.slice(0, 10))}`);
      const due = rows.find((k) => k.event_id === "dr-due");
      if (!due) p.push("dr-due is not a changed key");
      else if (due.before_image == null || canonicalJson(due.before_image) !== canonicalJson(due.after_image)) p.push("dr-due's raw base and frozen images differ (it must enter through the due branch, unchanged)");
      if (rows.some((k) => k.event_id === "dr-fut")) p.push("dr-fut (2099) is due");
      const win = (await c.query(CASE_SQL.dueWindow, [rb.batchId, r.batchId, A])).rows[0];
      if (win?.inside !== true) p.push(`dr-due is not strictly after the base cutoff and at/before the refresh cutoff (${JSON.stringify(win ?? null)})`);
      ev.dueProbe = { baseCutoff: base.cutoff, refreshCutoff: r.cutoff, keys: got.length, label: "controlled rollback-only time transition (base cutoff moved back 1 s inside a savepoint); not a wall-clock observation" };
      return expectNone("U2", p);
    });
  } catch (e) {
    dueError = e;
  }
  try {
    await c.query("rollback to savepoint dr_due");
    await c.query("release savepoint dr_due");
  } catch (r) {
    throw new Error(`${dueError ? `${dueError instanceof Error ? dueError.message : String(dueError)}; ` : ""}cleanup failed: due-probe savepoint: ${r instanceof Error ? r.message : String(r)}`);
  }
  if (dueError) throw dueError;
  await step(c, ctx, "U3", "the savepoint restored the original frozen, unsealed rebuild (same cutoff, state, fence; fingerprint equal to the pre-R2 baseline)", async () => {
    const b = await batchRow(c, rb.batchId);
    if (b.state !== "frozen" || b.cutoff !== rb.cutoff || b.fence !== rb.fence) throw new Error(`rebuild after the probe: ${JSON.stringify(b)}`);
    if ((await fp(rb.batchId)) !== before1) throw new Error("the due probe left a change behind");
    return b.cutoff;
  });

  // ---- setup-only publication of the rebuild (builds the base mirror; NOT materialization evidence) ----
  await step(c, ctx, "P0", "SETUP ONLY: seal zero work and publish the rebuild to create the base mirror (not counted as materialization evidence)", async () => {
    await rpc(c, ctx, "select * from public.seal_reporting_work($1, $2, 0, $3)", [rb.batchId, rb.fence, reportingManifestHash([])]);
    return publish(c, ctx, rb.batchId, rb.fence);
  }, (r) => `generation ${String(r.generation_seq)}`);

  // ---- refresh: base mirror + frozen overlay ----
  const rf = await step(c, ctx, "F0", "source changes at A (insert dr-new/dr-late, re-owner+re-staff dr-chg, delete dr-del, move dr-mv to B, change ONLY the note of 15 big rows); begin a frozen refresh", async () => {
    await insertDependencyFixtures(c, A, refreshInserts(w));
    await c.query("update public.production_events set order_number = 'DR-B', staff_id = $2::uuid where location = $1 and id = 'dr-chg'", [A, w.w2]);
    await c.query("delete from public.production_events where location = $1 and id = 'dr-del'", [A]);
    await c.query("update public.production_events set location = $2 where location = $1 and id = 'dr-mv'", [A, B]);
    await c.query("update public.production_events set note = $2 where location = $1 and id = any($3::text[])", [A, BIG_NOTE_2, BIG_IDS]);
    const [x] = await rpc(c, ctx, "select * from public.begin_reporting_batch($1)", [A]);
    return batchRow(c, String(x.batch_id));
  }, (x) => `refresh ${x.batchId} frozen at ${x.cutoff}`);
  const rv2 = await independentView(c, A);
  const view2 = rv2.events;
  const rreader = rpcFrozenReader(client, { batchId: rf.batchId, fence: rf.fence, site: A, cutoff: rf.cutoff, kind: "refresh" });
  // Membership from the FULL raw images (the 15 note-only changes are captured changes), then reduced for the projector.
  const changed = expectedChangedKeys(rv1, rv2, rb.cutoff, rf.cutoff);
  const before2 = await fp(rf.batchId); // before the first successful refresh read (F1)
  await step(c, ctx, "F1", "changed keys: exactly the independent raw-image base->frozen diff (ids incl. 15 note-only changes, reduced base/frozen images, tombstones), continuing past a byte-capped page", async () => {
    const got = await drain(rreader.changedKeys());
    const p: string[] = [];
    if (canonicalJson(got) !== canonicalJson(changed)) p.push(`changed keys differ (${got.length} vs ${changed.length})`);
    for (const id of ["dr-new", "dr-late", "dr-chg", "dr-del", "dr-mv", ...BIG_IDS]) if (!got.some((k) => k.id === id)) p.push(`${id} is not a changed key`);
    if (got.find((k) => k.id === "dr-del")?.after !== null) p.push("dr-del is not a tombstone");
    capped("read_reporting_changed_keys", "changed-key", p);
    return expectNone("F1", p);
  });
  await step(c, ctx, "F2", "overlay reads (mirror + frozen batch): members, events by id, children and streams equal the independent frozen view (inserted, re-owned, deleted, moved, future, ties, cross-site)", async () => {
    const p: string[] = [];
    const owners2 = [...controlled, owner("order", "DR-X"), owner("order", "DR-L"), owner("order", "DR-B")];
    for (const o of owners2) p.push(...compareEvents(`overlay members ${o.partitionKey}`, membersOf(view2, o), (await rreader.members([o], 50_000)).get(ownerKey(o)) ?? []));
    const ids = [...probeIds, "dr-new", "dr-late", "dr-chg", "dr-del", "dr-mv"];
    p.push(...compareEvents("overlay byIds", byId(view2, ids), [...(await rreader.byIds(ids)).values()]));
    p.push(...compareEvents("overlay children", kidsOf(view2, ["dr-v", "dr-late", "dr-bp"]), await drain(rreader.children(["dr-v", "dr-late", "dr-bp"]))));
    for (const s of [w.w1, w.w2]) {
      const want = sortStream(view2.filter((e) => e.staff_id === s));
      const got = await fullStream(rreader, s, "after", FAR_PAST);
      if (canonicalJson(got.map((e) => e.id)) !== canonicalJson(want.map((e) => e.id))) p.push(`overlay stream order differs for ${s}`);
      p.push(...compareEvents(`overlay stream ${s}`, want, got));
    }
    return expectNone("F2", p);
  });
  const oracle2 = frozenOracle(A, rf.cutoff, view2);
  await step(c, ctx, "F3", "materializer (refresh) through the REAL reader: every (audience, owner) whose full-view rows changed is a work on BOTH paths (incl. dr-orph after its late parent); descriptors/input hashes and five families equal the independent view and oracle (T14R1 middle insert, old-owner empty replacements)", async () => {
    const t0 = ctx.now();
    const baseCalls = Object.values(ev.rpc).reduce((n, s) => n + s.calls, 0);
    const viaRpc = await materializeBatch(rreader);
    const calls = Object.values(ev.rpc).reduce((n, s) => n + s.calls, 0) - baseCalls;
    const viaMem = await materializeBatch(memoryFrozenReader({ site: A, cutoff: rf.cutoff, kind: "refresh", view: view2, changed }));
    ev.materialization.refresh = { ...viaRpc.stats, sqlCalls: calls, ms: Math.round(ctx.now() - t0) };
    // Independent requirement from before/after FULL-view projections (no dependency enumeration involved).
    const staff = [...new Set(changed.flatMap((k) => [k.before?.staff_id, k.after?.staff_id]).filter((s): s is string => !!s))];
    const required = requiredWorks(A, { view: view1, cutoff: rb.cutoff }, { view: view2, cutoff: rf.cutoff }, staff);
    const p = [...missingRequired(required, viaRpc.works, viaMem.works), ...compareMaterialization(viaRpc.works, viaMem.works, oracle2)];
    for (const k of ["site||event\u0000dr-orph", "site||order\u0000DR-X", "site||order\u0000DR-N"]) if (!required.has(k)) p.push(`the independent requirement lacks ${k} (fixture is vacuous)`);
    for (const key of ["DR-D", "DR-MV", "DR-A"]) {
      const site = viaRpc.works.find((x) => x.desc.audienceKind === "site" && x.desc.partitionKey === key);
      const self = viaRpc.works.find((x) => x.desc.audienceStaff === w.w1 && x.desc.partitionKey === key);
      if (!site || !self || canonicalJson(site.rows) !== canonicalJson(self.rows) || site.rows.event_facts.length !== 0) p.push(`old owner ${key} lacks an empty site/self replacement`);
    }
    ev.materialization.refreshRequired = required.size;
    return expectNone("F3", p);
  });
  await step(c, ctx, "X9", "the successful refresh reads F1-F3 changed nothing: overlay, base mirror, source rows and batch metadata fingerprints equal the pre-F1 baseline", async () => {
    const after = await fp(rf.batchId);
    if (after !== before2) throw new Error("a refresh read mutated state");
    return after;
  });
  await refused(c, ctx, "F4", "a rebuild-only read of a refresh batch is refused", /list_reporting_owners is a rebuild read/, () => call("list_reporting_owners", { p_batch: rf.batchId, p_fence: rf.fence, p_after_kind: null, p_after_key: null, p_limit: 10 }));
  await step(c, ctx, "F5", "SETUP ONLY: publish the refresh (zero work), change dr-huge, freeze another refresh, and refuse its single oversized changed key", async () => {
    await rpc(c, ctx, "select * from public.seal_reporting_work($1, $2, 0, $3)", [rf.batchId, rf.fence, reportingManifestHash([])]);
    await publish(c, ctx, rf.batchId, rf.fence);
    await c.query(CASE_SQL.touchHuge, [A]);
    const [x] = await rpc(c, ctx, "select * from public.begin_reporting_batch($1)", [A]);
    await refused(c, ctx, "F5x", "a changed key whose base + frozen images cannot fit 1 MiB fails visibly", /one response row \(dr-huge\) is larger than 1 MiB/, () => call("read_reporting_changed_keys", { p_batch: x.batch_id, p_fence: Number(x.lease_fence), p_after_event_id: null, p_limit: 1000 }));
    return "refused";
  });
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export interface DependencyCtx extends FlowCtx {
  /** Persist evidence (saves the report); throws on a persistence failure. */
  emit(ev: DependencyEvidence): void;
}
export interface DependencyDeps {
  read(path: string): Buffer;
  cases(c: Db, ctx: FlowCtx, env: CaseEnv): Promise<void>;
}
export const DEFAULT_DEPENDENCY_DEPS: DependencyDeps = { read: (p) => readFileSync(p), cases: runDependencyCases };

const READS = ["read_reporting_changed_keys", "list_reporting_owners", "read_reporting_owner_members", "read_reporting_events_by_id", "read_reporting_children", "read_reporting_staff_stream"];
/** The prosrc of a function in a migration's text (between `AS $fn$` and `$fn$;`). */
export function functionBody(text: string, qualified: string): string {
  const t = text.replace(/\r\n/g, "\n");
  const i = t.search(new RegExp(`CREATE (OR REPLACE )?FUNCTION ${qualified.replace(".", "\\.")}\\(`));
  if (i < 0) throw new Error(`${qualified} not found`);
  const a = t.indexOf("AS $fn$", i) + "AS $fn$".length;
  return t.slice(a, t.indexOf("$fn$;", a));
}

/**
 * D0..D9. Refuses before BEGIN unless the files are the reviewed identities and
 * staging has 0039 installed and none of 0040; then applies 0040 then 0041 in
 * ONE transaction, runs the cases, and ALWAYS rolls back (a rollback failure is
 * kept beside the first error). Every recorded failure stops it; missing
 * evidence is never COMPLETE.
 */
export async function rehearseDependencyReads(raw: Db, ctxIn: DependencyCtx, deps: DependencyDeps = DEFAULT_DEPENDENCY_DEPS): Promise<DependencyEvidence> {
  const ev = newDependencyEvidence();
  const text40 = deps.read(MIGRATION_0040).toString("utf8");
  const text41 = deps.read(MIGRATION_0041).toString("utf8");
  const body40 = migrationBody(text40);
  const body41 = migrationBody(text41);
  const c = dependencyGuard(raw, new Set([...body40, ...body41]));
  const tracked: DependencyCtx = { ...ctxIn, record: (o) => { ctxIn.record(o); if (o.ok && !ev.recorded.includes(o.id)) ev.recorded.push(o.id); } };
  const ctx = failFast(tracked);
  await step(c, ctx, "D0", "file identities: installed 0037/0038/0039 and the exact reviewed 0040/0041 drafts", async () => {
    ev.files = [MIGRATION_0037, MIGRATION_0038, MIGRATION_0039, MIGRATION_0040, MIGRATION_0041].map((p) => fileIdentity(p, deps.read));
    const [f37, f38, f39, f40, f41] = ev.files;
    const ok = (want: readonly string[], f: { lf: string; crlf: string }) => want.includes(f.lf) || want.includes(f.crlf);
    if (!ok(INSTALLED["0037"], f37) || !ok(INSTALLED["0038"], f38)) throw new Error("0037/0038 are not the installed identities");
    if (!ok(REVIEWED["0039"], f39)) throw new Error(`0039 is not the installed identity (${f39.lf})`);
    if (!ok(REVIEWED["0040"], f40)) throw new Error(`0040 is not the reviewed draft (${f40.lf})`);
    if (!ok(REVIEWED["0041"], f41)) throw new Error(`0041 is not the reviewed draft (${f41.lf})`);
    if (body40.length !== 25) throw new Error(`0040 has ${body40.length} statements, expected 25`);
    if (body41.length !== 6 || !body41.every((s, i) => s.trimStart().startsWith(`CREATE OR REPLACE FUNCTION public.${["read_reporting_changed_keys", "list_reporting_owners", "read_reporting_owner_members", "read_reporting_events_by_id", "read_reporting_children", "read_reporting_staff_stream"][i]}(`))) throw new Error("0041 is not the six reviewed replacements");
    ctx.emit(ev);
    return `${f40.lf.slice(0, 12)}…/${f41.lf.slice(0, 12)}…`;
  }, (x) => `0040/0041 ${x}`);
  const b39 = bodyHashes(publishBody(deps.read(MIGRATION_0039).toString("utf8")));
  await step(c, ctx, "D1", "staging has 0039 installed (invoker, service-only), NONE of 0040, no active batch, the staging marker, and no dr- fixture ids", async () => {
    const f = (await c.query(FUNCTION_SQL)).rows[0];
    if (!f || !b39.includes(String(f.body_md5))) throw new Error(`the installed publisher is not 0039 (${String(f?.body_md5)})`);
    if (f.security_definer !== false || f.service_exec !== true || f.authenticated_exec !== false || f.anon_exec !== false) throw new Error(`unexpected publisher security ${JSON.stringify(f)}`);
    const a = (await c.query(CASE_SQL.absent)).rows[0];
    if (a.functions !== 0 || a.indexes !== 0) throw new Error(`0040 objects already exist (functions ${String(a.functions)}, indexes ${String(a.indexes)})`);
    if (a.active !== 0) throw new Error(`${String(a.active)} active reporting batch(es); refusing rather than adapting`);
    if (a.marker !== 1) throw new Error("the staging marker is missing");
    const col = (await c.query(CASE_SQL.collisions, [ctx.sites])).rows[0].n;
    if (col !== 0) throw new Error(`${String(col)} dr- fixture ids already exist`);
    ev.functions.installedPublisher = f;
    ctx.emit(ev);
  });
  await c.query("begin");
  try {
    await step(c, ctx, "D2", "apply 0040 then 0041 (parsed bodies) inside the rolled-back transaction", async () => {
      for (const sql of body40) await c.query(sql);
      for (const sql of body41) await c.query(sql);
      ev.statementsApplied = body40.length + body41.length;
    }, () => `${body40.length} + ${body41.length} statements`);
    await step(c, ctx, "D3", "effective functions: 0041 bodies, SECURITY INVOKER, empty search_path, service-only execute; the four indexes exist", async () => {
      const rows = (await c.query(CASE_SQL.effective)).rows;
      ev.functions.effective = rows;
      const p: string[] = [];
      if (rows.length !== 7) p.push(`${rows.length} functions found, expected 7`);
      for (const r of rows) {
        const want = r.name === "frozen_read_batch" ? bodyHashes(functionBody(text40, "reporting_private.frozen_read_batch")) : bodyHashes(functionBody(text41, `public.${String(r.name)}`));
        if (!want.includes(String(r.body_md5))) p.push(`${String(r.name)} body is not the reviewed one`);
        if (r.definer !== false || r.config !== 'search_path=""' || r.anon !== false || r.authenticated !== false || r.service !== true) p.push(`${String(r.name)} security ${JSON.stringify(r)}`);
      }
      if (!READS.every((n) => rows.some((r) => r.name === n))) p.push("a read function is missing");
      if ((await c.query(CASE_SQL.indexes)).rows[0].n !== 4) p.push("the four 0040 indexes are not all present");
      if (p.length) throw new Error(p.join("; "));
      ctx.emit(ev);
    });
    await deps.cases(c, ctx, { text0041: text41, ev });
    ctx.emit(ev);
  } catch (e) {
    try {
      await c.query("rollback");
    } catch (r) {
      throw new Error(`${ctxIn.redact(e instanceof Error ? e.message : String(e))}; cleanup failed: rehearsal rollback: ${ctxIn.redact(r instanceof Error ? r.message : String(r))}`);
    }
    throw e;
  }
  await c.query("rollback");
  ctx.record({ id: "D9", what: "the rehearsal transaction rolled back (0040/0041 not installed)", expected: "rollback", result: "rolled back", ok: true, ms: 0 });
  const missing = evidenceProblems(ev);
  if (missing.length) throw new Error(missing.join("; "));
  ev.complete = true;
  ctx.emit(ev);
  return ev;
}
