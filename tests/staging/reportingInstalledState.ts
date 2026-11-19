/**
 * Read-only installed-state inspection (planner checkpoint 2026-11-18, T15P-3).
 *
 *   npm run staging:reporting-jobs -- --inspect-installed --sites=au,uk,us
 *
 * STAGING ONLY (ybrzhrgfrnvtcwymjdrq). Never invokes a reporting RPC, never
 * acquires or renews a lease, never enables capture, never changes a role or
 * setting, never runs DDL or EXPLAIN ANALYZE and never writes to the database.
 * Every statement goes through an exact allowlist; the whole collection runs
 * in ONE `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction that is
 * always rolled back and closed, then repeated on a fresh read-only
 * connection to detect drift. Only the local report file is written.
 *
 * STATUS: COMPLETE means the evidence was completely collected and every
 * identity/receipt/collation check holds; runtime readiness is reported
 * separately (runtimeReady, with each failed R0 condition per site). Neither
 * outcome launches a worker.
 */
import { createHash } from "node:crypto";
import { bodyHashes } from "./reportingRebuildRepair";
import { CASE_SQL, functionBody, MIGRATION_0040, MIGRATION_0041 } from "./reportingDependencyRehearsal";
import { COLLATION_INVARIANT_SQL, collationInvariantProblems, MIGRATION_0042 } from "./reportingDependencyPlans";
import { dependencyIdentityProblems, historyProblems, INSTALLED_HISTORY, MIGRATION_0043, WORKER_CATALOG_SQL, workerCatalogParams, workerCatalogProblems, workerObjects, type WorkerCatalog } from "./reportingWorkerHarness";
import { PREFLIGHT_SQL, preflightProblems, type PreflightSnapshot } from "./reportingCommitted";
import type { Db } from "./reportingPublication";

export const INSPECT_FLAG = "--inspect-installed";
export const INSPECT_SITES = ["au", "uk", "us"] as const;
export const MIGRATION_0044 = "supabase/migrations/0044_reporting_reads.sql";
export const MIGRATION_0045 = "supabase/migrations/0045_reporting_predecessor_page.sql";
export const MIGRATION_0046 = "supabase/migrations/0046_reporting_owner_inputs.sql";
/** The migrations whose objects are inspected by name (functions, tables, indexes, security). */
export const WORKER_MIGRATIONS = ["0043", "0044", "0045", "0046"] as const;
/** The staging-only, already-accepted exception: these receipts may be ABSENT when every effective identity check holds. */
export const ACCEPTED_ABSENT_RECEIPTS = ["0044_reporting_reads", "0045_reporting_predecessor_page"] as const;

/** The reviewed files (LF SHA-256 at the reviewed head). No silent repinning: an edit must update this table and its test. */
export const REVIEWED_LF: Readonly<Record<string, { path: string; sha256: string }>> = {
  "0040": { path: MIGRATION_0040, sha256: "4e39243e2ee6526f656eb1b462156d6bc9eabf17cac78fcb2d873cd4498968b2" },
  "0041": { path: MIGRATION_0041, sha256: "dfa49d597cc37cef92314a4d2dcaf79d195949741fc0534fc57345c12f419646" },
  "0042": { path: MIGRATION_0042, sha256: "e38aba760a19a70fa3afdddd5155244fb94acb73a53362855d1f63b1a3536a1c" },
  "0043": { path: MIGRATION_0043, sha256: "156ee4d525433c8999c52d83ac4175c44629ce6a8f848796a5638ed944c7f633" },
  "0044": { path: MIGRATION_0044, sha256: "84a07d1bd61d2e69df66bf6efa437f541a184512cb1820cc75217db20e5c9b07" },
  "0045": { path: MIGRATION_0045, sha256: "5f42f300ba391aa36845329e53d39581a56d4e60c94ab342bb95f91fe8ccefb8" },
  // the reviewed DRAFT 0046 (T15P-4); CJ applies exactly these bytes to staging
  "0046": { path: MIGRATION_0046, sha256: "4641d7cd4dd3ca48d0ccf5350584bb6c23efec6bac4c5a4e6c26d60b7b0b6141" },
};

/** Exact names expected in supabase_migrations.schema_migrations; 0040-0042 also with their recorded versions. */
export const EXPECTED_RECEIPTS = [
  ...INSTALLED_HISTORY.map((h) => ({ name: h.name, version: h.version as string | null })),
  { name: "0043_reporting_worker_state", version: null },
  { name: "0044_reporting_reads", version: null },
  { name: "0045_reporting_predecessor_page", version: null },
  { name: "0046_reporting_owner_inputs", version: null },
] as const;

/** The seven effective Task 14 dependency functions: 0040 for frozen_read_batch, 0042 for members/stream, 0041 for the rest. */
export const DEPENDENCY_FUNCTIONS = [
  "public.list_reporting_owners", "public.read_reporting_changed_keys", "public.read_reporting_children", "public.read_reporting_events_by_id",
  "public.read_reporting_owner_members", "public.read_reporting_staff_stream", "reporting_private.frozen_read_batch",
] as const;
export const DEPENDENCY_INDEXES = ["source_candidate_owner_event", "source_candidate_owner_order", "source_candidate_staff_time", "source_current_staff_time"] as const;

const lf = (s: string) => s.replace(/\r\n/g, "\n");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// Arguments (refused before any connection)
// ---------------------------------------------------------------------------

export function parseInspectArgs(argv: readonly string[]): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (argv.filter((a) => a === INSPECT_FLAG).length !== 1) problems.push(`${INSPECT_FLAG} must be given exactly once`);
  const sites = argv.filter((a) => a.startsWith("--sites="));
  if (sites.length !== 1 || sites[0] !== "--sites=au,uk,us") problems.push("--sites=au,uk,us is required exactly (all three sites are inspected)");
  for (const a of argv) if (a !== INSPECT_FLAG && !a.startsWith("--sites=")) problems.push(`unknown or mixed argument ${a} (the inspection takes no other mode or option)`);
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// The only statements this mode may send (exact allowlist)
// ---------------------------------------------------------------------------

export const BEGIN_RO = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
export const READ_ONLY_SQL = "select current_setting('transaction_read_only') as ro, current_setting('transaction_isolation') as iso";
export const SETTINGS_SQL = "select current_setting('statement_timeout') as st, current_setting('lock_timeout') as lt, current_setting('idle_in_transaction_session_timeout') as it, now()::text as db_now";
export const ROLLBACK = "ROLLBACK";

/** Every installed migration receipt 004x, with an installation-artifact hash when the history table records statements. */
export const RECEIPTS_SQL = `select m.version::text as version, m.name::text as name,
  (pg_catalog.to_jsonb(m) ? 'statements') as has_statements,
  case when pg_catalog.to_jsonb(m) ? 'statements' then md5((pg_catalog.to_jsonb(m) -> 'statements')::text) end as statements_md5
from supabase_migrations.schema_migrations m where m.name ~ '^004[0-9]_' order by m.version, m.name`;

/** Contract, body and security of every overload of the named functions (so an unexpected overload is visible). */
export const CONTRACT_SQL = `select n.nspname::text as schema, p.proname::text as name,
  pg_catalog.pg_get_function_identity_arguments(p.oid) as args, pg_catalog.pg_get_function_result(p.oid) as result,
  coalesce(pg_catalog.pg_get_expr(p.proargdefaults, 0), '') as defaults, l.lanname::text as language, p.provolatile::text as volatility,
  md5(p.prosrc) as body_md5, md5(pg_catalog.pg_get_functiondef(p.oid)) as functiondef_md5,
  p.prosecdef as definer, coalesce(array_to_string(p.proconfig, ','), '') as config,
  pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon, pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
  pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as service,
  exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a where a.grantee = 0) as public
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace join pg_catalog.pg_language l on l.oid = p.prolang
where n.nspname || '.' || p.proname = any($1::text[])
order by 1, 2, 3`;

export const INDEX_SQL = `select c.relname::text as name, i.indisvalid as valid, i.indisready as ready
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace join pg_catalog.pg_index i on i.indexrelid = c.oid
where n.nspname = 'reporting_private' and c.relname = any($1::text[]) order by 1`;

/** Control, per-site state, active batches (state/fence/lease/heartbeat) and retained row counts. No source payloads or staff details. */
export const STATE_SQL = `select json_build_object(
  'control', (select json_build_object('captureEnabled', capture_enabled, 'captureEpoch', capture_epoch::text) from reporting_private.control where singleton),
  'sites', (select json_agg(json_build_object('site', s.site, 'processor', s.processor_enabled, 'readMode', s.read_mode,
      'activeGeneration', s.active_generation_id, 'activeBatch', s.active_batch_id, 'leaseFence', s.lease_fence::text,
      'leaseExpiresAt', s.lease_expires_at, 'heartbeatAt', s.heartbeat_at, 'lastVerifiedCutoff', s.last_verified_cutoff,
      'batchesByState', (select coalesce(json_object_agg(x.state, x.n), '{}'::json) from (select b.state, count(*) as n from reporting_private.batches b where b.site = s.site group by b.state) x),
      'generationsByState', (select coalesce(json_object_agg(x.state, x.n), '{}'::json) from (select g.state, count(*) as n from reporting_private.generations g where g.site = s.site group by g.state) x),
      'candidateRows', (select count(*) from reporting_private.source_candidate c where c.site = s.site)) order by s.site)
     from reporting_private.site_state s where s.site = any($1::text[])),
  'activeBatches', (select coalesce(json_agg(json_build_object('batch', b.batch_id, 'site', b.site, 'kind', b.kind, 'state', b.state, 'leaseFence', b.lease_fence::text,
      'leaseExpiresAt', b.lease_expires_at, 'updatedAt', b.updated_at, 'createdAt', b.created_at) order by b.site, b.created_at), '[]'::json)
     from reporting_private.batches b where b.state in ('active', 'frozen', 'publishing'))
) as j`;

export const ALLOWED_SQL: ReadonlySet<string> = new Set([
  BEGIN_RO, READ_ONLY_SQL, SETTINGS_SQL, ROLLBACK, RECEIPTS_SQL, CASE_SQL.effective, CONTRACT_SQL, WORKER_CATALOG_SQL, INDEX_SQL,
  COLLATION_INVARIANT_SQL, PREFLIGHT_SQL, STATE_SQL,
]);

/** Refuses (before sending) any statement outside the allowlist; records every statement sent. */
export function inspectionGuard<C extends Db>(c: C, sent: string[]): C {
  return new Proxy(c, {
    get(target, prop, recv) {
      if (prop !== "query") return Reflect.get(target, prop, recv);
      return (sql: string, params?: unknown[]) => {
        if (!ALLOWED_SQL.has(sql)) return Promise.reject(new Error(`inspection refused a statement outside its read-only allowlist: ${sql.replace(/\s+/g, " ").slice(0, 80)}`));
        sent.push(sql);
        return target.query(sql, params);
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Expected objects and pure checks
// ---------------------------------------------------------------------------

export interface Texts { [migration: string]: string }

export function fileProblems(texts: Texts): { problems: string[]; files: Array<{ migration: string; path: string; sha256Lf: string; pinned: string; ok: boolean }> } {
  const files = Object.entries(REVIEWED_LF).map(([m, pin]) => {
    const got = texts[m] === undefined ? "(missing)" : sha256(lf(texts[m]));
    return { migration: m, path: pin.path, sha256Lf: got, pinned: pin.sha256, ok: got === pin.sha256 };
  });
  return { files, problems: files.filter((f) => !f.ok).map((f) => `the local ${f.migration} file is not the reviewed one (LF SHA-256 ${f.sha256Lf}, pinned ${f.pinned})`) };
}

/** Every function the inspection must find exactly once: the 7 dependency reads plus all 0043-0046 functions, private helpers included. */
export function expectedFunctions(texts: Texts): string[] {
  const fromFile = (m: string) => workerObjects(texts[m]).functions.map((f) => `${f.schema}.${f.name}`);
  return [...new Set([...DEPENDENCY_FUNCTIONS, ...WORKER_MIGRATIONS.flatMap(fromFile)])].sort();
}
/** Every index the inspection must find valid and ready: the dependency indexes plus 0043's and 0046's. */
export function expectedIndexes(texts: Texts): string[] {
  return [...DEPENDENCY_INDEXES, ...workerObjects(texts["0043"]).indexes, ...workerObjects(texts["0046"]).indexes];
}

/** The local text that defines each expected function's effective body. */
export function effectiveSource(texts: Texts, qualified: string): string {
  if (qualified === "reporting_private.frozen_read_batch") return texts["0040"];
  if (qualified === "public.read_reporting_owner_members" || qualified === "public.read_reporting_staff_stream") return texts["0042"];
  if ((DEPENDENCY_FUNCTIONS as readonly string[]).includes(qualified)) return texts["0041"];
  for (const m of WORKER_MIGRATIONS) if (workerObjects(texts[m]).functions.some((f) => `${f.schema}.${f.name}` === qualified)) return texts[m];
  throw new Error(`${qualified} is not an expected function`);
}

export type Row = Record<string, unknown>;
const CONTRACT_KEYS = ["args", "result", "defaults", "language", "volatility"] as const;

export interface FunctionEvidence { name: string; args: string; bodyMd5: string; functiondefMd5: string; bodyMatch: "lf" | "crlf" | "none"; contract: string }

/** Each expected name exactly once, no unexpected overload, body = local (LF or CRLF only), contract = local definition, invoker/empty search_path/service-only. */
export function functionProblems(installed: readonly Row[], expectedContracts: readonly Row[], texts: Texts): { problems: string[]; functions: FunctionEvidence[] } {
  const p: string[] = [];
  const functions: FunctionEvidence[] = [];
  const names = expectedFunctions(texts);
  const q = (r: Row) => `${String(r.schema)}.${String(r.name)}`;
  for (const r of installed) if (!names.includes(q(r))) p.push(`unexpected function ${q(r)}(${String(r.args)})`);
  for (const nm of names) {
    const rows = installed.filter((r) => q(r) === nm);
    const exp = expectedContracts.filter((r) => q(r) === nm);
    if (rows.length !== 1) {
      p.push(`${nm} found ${rows.length} times (expected exactly once; an overload or a missing function)`);
      continue;
    }
    const r = rows[0];
    const [lfHash, crlfHash] = bodyHashes(functionBody(effectiveSource(texts, nm), nm));
    const match = r.body_md5 === lfHash ? "lf" : r.body_md5 === crlfHash ? "crlf" : "none";
    if (match === "none") p.push(`${nm} body is not the reviewed local one`);
    if (exp.length !== 1) p.push(`${nm}: the local expected catalog has ${exp.length} definitions`);
    else for (const k of CONTRACT_KEYS) if (String(r[k]) !== String(exp[0][k])) p.push(`${nm} ${k} differs: installed ${JSON.stringify(r[k])}, local ${JSON.stringify(exp[0][k])}`);
    if (r.definer !== false || r.config !== 'search_path=""' || r.anon !== false || r.authenticated !== false || r.service !== true || r.public !== false) {
      p.push(`${nm} security differs: ${JSON.stringify({ definer: r.definer, config: r.config, anon: r.anon, authenticated: r.authenticated, service: r.service, public: r.public })}`);
    }
    functions.push({ name: nm, args: String(r.args), bodyMd5: String(r.body_md5), functiondefMd5: String(r.functiondef_md5), bodyMatch: match, contract: CONTRACT_KEYS.map((k) => `${k}=${String(r[k])}`).join("; ") });
  }
  return { problems: p, functions };
}

/** 0040-0042 exactly as recorded; 0043/0044/0045 exactly once by name; nothing else in 004x. Never inferred from function presence. */
export function receiptProblems(rows: readonly Row[]): string[] {
  const p = historyProblems(rows, "installed");
  for (const e of EXPECTED_RECEIPTS) {
    const got = rows.filter((r) => String(r.name) === e.name);
    if (got.length !== 1) p.push(`migration history has ${got.length} receipts for ${e.name} (expected exactly one)`);
    else if (e.version && String(got[0].version) !== e.version) p.push(`${e.name} receipt version is ${String(got[0].version)}, recorded ${e.version}`);
  }
  for (const r of rows) if (!EXPECTED_RECEIPTS.some((e) => e.name === String(r.name))) p.push(`unexpected 004x migration receipt ${String(r.version)}/${String(r.name)}`);
  return [...new Set(p)];
}
const ABSENT = (name: string) => `migration history has 0 receipts for ${name} (expected exactly one)`;
/**
 * The raw receipt findings split into BLOCKING problems and ACCEPTED findings: only an ABSENT 0044/0045 receipt can be
 * accepted (the staging-specific, already-decided exception), and only when `effectiveOk` (every effective
 * function/table/index/security check holds). A duplicate, a wrong version, an unexpected receipt, an absent 0046 or any
 * other finding always blocks.
 */
export function receiptFindings(rows: readonly Row[], effectiveOk: boolean): { raw: string[]; problems: string[]; accepted: string[] } {
  const raw = receiptProblems(rows);
  const acceptable = new Set(ACCEPTED_ABSENT_RECEIPTS.map(ABSENT));
  const accepted = effectiveOk ? raw.filter((x) => acceptable.has(x)) : [];
  return { raw, accepted, problems: raw.filter((x) => !accepted.includes(x)) };
}

export function indexProblems(rows: readonly Row[], expected: readonly string[]): string[] {
  const p: string[] = [];
  for (const nm of expected) {
    const r = rows.filter((x) => x.name === nm);
    if (r.length !== 1) p.push(`index reporting_private.${nm} found ${r.length} times`);
    else if (r[0].valid !== true || r[0].ready !== true) p.push(`index reporting_private.${nm} is not valid/ready (valid=${String(r[0].valid)}, ready=${String(r[0].ready)})`);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Collection (one read-only transaction; always rolled back and closed)
// ---------------------------------------------------------------------------

export interface Snapshot {
  readOnly: string;
  isolation: string;
  settings: Row;
  receipts: Row[];
  dependencyRows: Row[];
  contracts: Row[];
  catalogs: Record<string, WorkerCatalog>;
  indexes: Row[];
  collation: Row | undefined;
  preflight: PreflightSnapshot;
  state: Row;
}

export async function collect(c: Db, texts: Texts): Promise<Snapshot> {
  const one = async (sql: string, params?: unknown[]) => (await c.query(sql, params)).rows;
  await c.query(BEGIN_RO);
  const ro = (await one(READ_ONLY_SQL))[0] ?? {};
  if (ro.ro !== "on") throw new Error(`the inspection transaction is not read-only (transaction_read_only=${String(ro.ro)})`);
  const settings = (await one(SETTINGS_SQL))[0] ?? {};
  const receipts = await one(RECEIPTS_SQL);
  const dependencyRows = await one(CASE_SQL.effective);
  const contracts = await one(CONTRACT_SQL, [expectedFunctions(texts)]);
  const catalogs: Record<string, WorkerCatalog> = {};
  for (const m of WORKER_MIGRATIONS) catalogs[m] = (await one(WORKER_CATALOG_SQL, workerCatalogParams(workerObjects(texts[m]))))[0].j as WorkerCatalog;
  const indexes = await one(INDEX_SQL, [expectedIndexes(texts)]);
  const collation = (await one(COLLATION_INVARIANT_SQL))[0];
  const preflight = (await one(PREFLIGHT_SQL, [[...INSPECT_SITES], "rw-%"]))[0].j as PreflightSnapshot;
  const state = (await one(STATE_SQL, [[...INSPECT_SITES]]))[0].j as Row;
  return { readOnly: String(ro.ro), isolation: String(ro.iso), settings, receipts, dependencyRows, contracts, catalogs, indexes, collation, preflight, state };
}

/** Run collect inside the read-only transaction; ROLLBACK and close ALWAYS run, and their failures are reported beside the first error. */
export async function collectOnce(open: () => Promise<Db & { end(): Promise<void> }>, texts: Texts, sent: string[]): Promise<Snapshot> {
  const raw = await open();
  const c = inspectionGuard(raw, sent);
  let snap: Snapshot | undefined;
  let failure: unknown = null;
  try {
    snap = await collect(c, texts);
  } catch (e) {
    failure = e;
  }
  const cleanup: string[] = [];
  await c.query(ROLLBACK).catch((e) => cleanup.push(`rollback: ${e instanceof Error ? e.message : String(e)}`));
  await raw.end().catch((e) => cleanup.push(`disconnect: ${e instanceof Error ? e.message : String(e)}`));
  if (failure || cleanup.length) {
    const first = failure ? (failure instanceof Error ? failure.message : String(failure)) : "";
    throw new Error([first, ...cleanup.map((x) => `cleanup failed: ${x}`)].filter(Boolean).join("; "));
  }
  return snap!;
}

/** The parts that must not change between the two snapshots (identity + control/site/active-batch metadata). */
export function stablePart(s: Snapshot): string {
  return JSON.stringify({ receipts: s.receipts, dependency: s.dependencyRows, contracts: s.contracts, catalogs: s.catalogs, indexes: s.indexes, preflight: s.preflight, state: s.state });
}
export function driftProblems(a: Snapshot, b: Snapshot): string[] {
  const pa = JSON.parse(stablePart(a)) as Record<string, unknown>;
  const pb = JSON.parse(stablePart(b)) as Record<string, unknown>;
  return Object.keys(pa).filter((k) => JSON.stringify(pa[k]) !== JSON.stringify(pb[k])).map((k) => `the fresh read-only snapshot differs in ${k}`);
}

// ---------------------------------------------------------------------------
// Inspection, report and STATUS
// ---------------------------------------------------------------------------

export interface PriorRun { file: string; sha256: string; mode: string; site: string; status: string }

export interface InspectionReport {
  revision: string;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  files: ReturnType<typeof fileProblems>["files"];
  readOnly: { first: string; fresh: string; isolation: string; statementsSent: number; nonSelect: string[]; rolledBack: boolean };
  settings: Row | null;
  receipts: Row[];
  functions: FunctionEvidence[];
  indexes: Row[];
  collation: Row | null;
  control: Row | null;
  sites: Array<{ site: string; eligible: boolean; failedR0: string[]; state: Row | null }>;
  activeBatches: Row[];
  priorRuns: PriorRun[];
  identityProblems: string[];
  receiptProblems: string[];
  /** Every raw receipt finding, and the ones accepted under the staging exception (reported, never suppressed). */
  rawReceiptFindings: string[];
  acceptedReceiptFindings: string[];
  collationProblems: string[];
  drift: string[];
  errors: string[];
  runtimeReady: boolean;
  complete: boolean;
}

export interface InspectDeps {
  revision: string;
  read(path: string): string;
  open(): Promise<Db & { end(): Promise<void> }>;
  /** The local expected catalog (CONTRACT_SQL rows from the real migrations applied offline). */
  expectedContracts(names: string[]): Promise<Row[]>;
  priorRuns(): PriorRun[];
  now(): Date;
  redact(s: string): string;
  save(r: InspectionReport): void;
}

export function newInspectionReport(revision: string, startedAt: string): InspectionReport {
  return {
    revision, startedAt, finishedAt: "", elapsedMs: 0, files: [], readOnly: { first: "", fresh: "", isolation: "", statementsSent: 0, nonSelect: [], rolledBack: false },
    settings: null, receipts: [], functions: [], indexes: [], collation: null, control: null, sites: [], activeBatches: [], priorRuns: [],
    identityProblems: [], receiptProblems: [], rawReceiptFindings: [], acceptedReceiptFindings: [], collationProblems: [], drift: [], errors: [], runtimeReady: false, complete: false,
  };
}

export async function inspectInstalled(deps: InspectDeps): Promise<InspectionReport> {
  const t0 = deps.now();
  const r = newInspectionReport(deps.revision, t0.toISOString());
  const finish = () => {
    const t1 = deps.now();
    r.finishedAt = t1.toISOString();
    r.elapsedMs = t1.getTime() - t0.getTime();
    deps.save(r);
    return r;
  };
  const texts: Texts = {};
  try {
    for (const [m, pin] of Object.entries(REVIEWED_LF)) texts[m] = deps.read(pin.path);
  } catch (e) {
    r.errors.push(`a local migration file could not be read: ${deps.redact(e instanceof Error ? e.message : String(e))}`);
    return finish();
  }
  const files = fileProblems(texts);
  r.files = files.files;
  try {
    r.priorRuns = deps.priorRuns();
  } catch (e) {
    r.errors.push(`prior run evidence could not be listed: ${deps.redact(e instanceof Error ? e.message : String(e))}`);
  }
  if (files.problems.length) {
    r.identityProblems.push(...files.problems); // refused before any connection
    return finish();
  }
  deps.save(r);
  const sent: string[] = [];
  let first: Snapshot;
  let fresh: Snapshot;
  let expected: Row[];
  try {
    expected = await deps.expectedContracts(expectedFunctions(texts));
    first = await collectOnce(deps.open, texts, sent);
    r.readOnly.first = first.readOnly;
    r.readOnly.isolation = first.isolation;
    fresh = await collectOnce(deps.open, texts, sent);
    r.readOnly.fresh = fresh.readOnly;
  } catch (e) {
    r.errors.push(deps.redact(e instanceof Error ? e.message : String(e)));
    r.readOnly.statementsSent = sent.length;
    r.readOnly.nonSelect = sent.filter((s) => !/^select\b/i.test(s.trim()) && s !== BEGIN_RO && s !== ROLLBACK);
    r.readOnly.rolledBack = sent.filter((s) => s === ROLLBACK).length === sent.filter((s) => s === BEGIN_RO).length;
    return finish();
  }
  r.readOnly.statementsSent = sent.length;
  r.readOnly.nonSelect = sent.filter((s) => !/^select\b/i.test(s.trim()) && s !== BEGIN_RO && s !== ROLLBACK);
  r.readOnly.rolledBack = sent.filter((s) => s === ROLLBACK).length === 2 && sent.filter((s) => s === BEGIN_RO).length === 2;
  r.settings = first.settings;
  r.receipts = first.receipts;
  r.indexes = first.indexes;
  r.collation = first.collation ?? null;
  r.control = (first.state.control as Row) ?? null;
  r.activeBatches = (first.state.activeBatches as Row[]) ?? [];

  const fn = functionProblems(first.contracts, expected, texts);
  r.functions = fn.functions;
  const depNames = first.dependencyRows.map((x) => String(x.name)).sort();
  const wantDep = DEPENDENCY_FUNCTIONS.map((q) => q.split(".")[1]).sort();
  r.identityProblems.push(
    ...fn.problems,
    ...(JSON.stringify(depNames) === JSON.stringify(wantDep) ? [] : [`dependency functions are ${JSON.stringify(depNames)}, expected ${JSON.stringify(wantDep)}`]),
    ...dependencyIdentityProblems(first.dependencyRows, texts["0040"], texts["0041"], texts["0042"]),
    ...WORKER_MIGRATIONS.flatMap((m) => workerCatalogProblems(first.catalogs[m], texts[m], "installed").map((x) => `${m}: ${x}`)),
    ...indexProblems(first.indexes, expectedIndexes(texts)),
  );
  const rf = receiptFindings(first.receipts, r.identityProblems.length === 0);
  r.rawReceiptFindings = rf.raw;
  r.acceptedReceiptFindings = rf.accepted;
  r.receiptProblems = rf.problems;
  r.collationProblems = collationInvariantProblems(first.collation);
  r.drift = driftProblems(first, fresh);
  const identityOk = !r.identityProblems.length && !r.receiptProblems.length && !r.collationProblems.length;
  const states = (first.state.sites as Row[]) ?? [];
  r.sites = INSPECT_SITES.map((site) => {
    const failedR0 = [...(identityOk ? [] : ["installed identities, receipts or collation do not hold"]), ...preflightProblems(first.preflight, [site])];
    return { site, eligible: failedR0.length === 0, failedR0, state: states.find((s) => s.site === site) ?? null };
  });
  r.runtimeReady = r.sites.some((s) => s.eligible);
  r.complete = r.readOnly.first === "on" && r.readOnly.fresh === "on" && r.readOnly.rolledBack && r.readOnly.nonSelect.length === 0;
  return finish();
}

export function inspectionStatus(r: InspectionReport): string {
  const all = [
    ...r.errors,
    ...r.identityProblems,
    ...r.receiptProblems,
    ...r.collationProblems,
    ...r.drift,
    ...(r.readOnly.nonSelect.length ? [`a non-read statement was sent: ${r.readOnly.nonSelect[0].slice(0, 60)}`] : []),
  ];
  if (!r.complete && !all.length) all.push("the inspection evidence is incomplete");
  return all.length ? `STATUS: FAILED – ${all[0]}${all.length > 1 ? ` (+${all.length - 1} more)` : ""}` : "STATUS: COMPLETE";
}

export function inspectionMarkdown(r: InspectionReport): string {
  const esc = (s: unknown) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const list = (title: string, xs: readonly string[]) => (xs.length ? [`### ${title}`, "", ...xs.map((x) => `- ${esc(x)}`), ""] : []);
  return [
    "# Reporting installed-state inspection (read-only)",
    "",
    `- project: ybrzhrgfrnvtcwymjdrq (staging) · sites: au, uk, us · revision: ${r.revision}`,
    `- started (UTC): ${r.startedAt} · finished (UTC): ${r.finishedAt || "(running)"} · elapsed: ${r.elapsedMs} ms`,
    `- read-only: first=${r.readOnly.first || "?"}, fresh=${r.readOnly.fresh || "?"}, isolation=${r.readOnly.isolation || "?"}, statements sent=${r.readOnly.statementsSent}, non-read statements=${r.readOnly.nonSelect.length}, rolled back=${r.readOnly.rolledBack}`,
    `- existing settings (read only, unchanged): ${r.settings ? `statement_timeout=${String(r.settings.st)}, lock_timeout=${String(r.settings.lt)}, idle_in_transaction_session_timeout=${String(r.settings.it)}` : "(not read)"}`,
    `- runtimeReady: ${r.runtimeReady} (this inspection never launches a worker; --worker-runtime is not authorised by it)`,
    "",
    "## Local files",
    "",
    "| migration | path | LF SHA-256 | pinned | ok |",
    "|---|---|---|---|---|",
    ...r.files.map((f) => `| ${f.migration} | ${f.path} | ${f.sha256Lf} | ${f.pinned} | ${f.ok ? "yes" : "NO"} |`),
    "",
    "## Migration receipts (004x)",
    "",
    "| version | name | statements recorded | statements md5 |",
    "|---|---|---|---|",
    ...r.receipts.map((x) => `| ${esc(x.version)} | ${esc(x.name)} | ${esc(x.has_statements)} | ${esc(x.statements_md5 ?? "(none)")} |`),
    "",
    "## Functions",
    "",
    "| function | arguments | prosrc md5 | body match | pg_get_functiondef md5 | contract |",
    "|---|---|---|---|---|---|",
    ...r.functions.map((f) => `| ${f.name} | ${esc(f.args)} | ${f.bodyMd5} | ${f.bodyMatch} | ${f.functiondefMd5} | ${esc(f.contract)} |`),
    "",
    "## Indexes",
    "",
    ...r.indexes.map((x) => `- ${esc(x.name)}: valid=${esc(x.valid)}, ready=${esc(x.ready)}`),
    "",
    "## Control and sites",
    "",
    `- control: ${esc(JSON.stringify(r.control))}`,
    ...r.sites.flatMap((s) => [`- **${s.site}**: eligible=${s.eligible}`, `  - state: ${esc(JSON.stringify(s.state))}`, ...s.failedR0.map((f) => `  - R0 fails: ${esc(f)}`)]),
    `- active batches: ${esc(JSON.stringify(r.activeBatches))}`,
    "",
    "## Prior run evidence (local reports)",
    "",
    ...(r.priorRuns.length ? r.priorRuns.map((p) => `- ${p.file} · sha256 ${p.sha256} · ${p.mode} · site ${p.site} · ${esc(p.status)}`) : ["- (none found locally; explicitly absent)"]),
    "",
    `## Collation invariant`,
    "",
    `- ${esc(JSON.stringify(r.collation))}`,
    "",
    ...list("Identity problems", r.identityProblems),
    ...list("Receipt problems", r.receiptProblems),
    ...list("Accepted receipt findings (staging exception: absent 0044/0045 receipts, every effective identity check holds)", r.acceptedReceiptFindings),
    ...list("Collation problems", r.collationProblems),
    ...list("Fresh-snapshot drift", r.drift),
    ...list("Errors", r.errors),
    inspectionStatus(r),
    "",
  ].join("\n");
}

/** Summarise a local staging-results-reporting-worker-*.md report: mode/site from its header, final STATUS line, SHA-256 of the exact bytes. */
export function summarisePriorRun(file: string, bytes: Buffer): PriorRun {
  const text = bytes.toString("utf8");
  const head = /^# Reporting worker staging evidence \(([^)]+)\)/m.exec(text);
  const site = /· site: (\w+) ·/.exec(text);
  const status = [...text.matchAll(/^STATUS: .*$/gm)].pop()?.[0] ?? "(no STATUS line)";
  return { file, sha256: createHash("sha256").update(bytes).digest("hex"), mode: head?.[1] ?? "(unknown)", site: site?.[1] ?? "(unknown)", status };
}
