/**
 * Task 15 staging harness for 0043 (PREPARED; NOT run by the coder).
 *
 *   npm run staging:reporting-jobs -- --rehearse-worker-state --site=X
 *     rollback-only: the exact pinned 0043 applied inside ONE transaction that
 *     always rolls back, against installed 0040-0042; catalog, security and a
 *     few refusals checked inside; zero change proven by the fresh audit.
 *
 * Installation of 0043 stays root-only, after this rehearsal passes.
 * The post-install runtime gate (--worker-runtime) is added separately.
 *
 * Every refusal here happens before BEGIN (file identity/shape) or before
 * any mutation (installed identities, 0043 state, active batches).
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { bodyHashes } from "./reportingRebuildRepair";
import { CASE_SQL, dependencyGuard, functionBody, MIGRATION_0040, MIGRATION_0041, stripSqlComments } from "./reportingDependencyRehearsal";
import { MIGRATION_0042 } from "./reportingDependencyPlans";
import { migrationBody, type Db, type Observation, type Site } from "./reportingPublication";
import type { LifecycleReport } from "./reportingCapture";

// ---------------------------------------------------------------------------
// Arguments, report and STATUS
// ---------------------------------------------------------------------------

export type WorkerMode = "rehearse-worker-state" | "worker-runtime" | "recover-worker-run";
export const WORKER_FLAGS = ["--rehearse-worker-state", "--worker-runtime", "--recover-worker-run"] as const;
/** The interrupted run's own report: a plain file name in the repo root (no directories, no traversal). */
export const RUN_REPORT_NAME = /^staging-results-reporting-worker-worker-runtime-[0-9TZ]+-[0-9a-f]{8}\.md$/;
export interface WorkerArgs { mode: WorkerMode | null; site: Site | null; paceCalls: number; maxInvocations: number; maxLeaseWaitMs: number; report: string | null; problems: string[] }
export function parseWorkerArgs(argv: readonly string[]): WorkerArgs {
  const problems: string[] = [];
  const modes = argv.filter((a) => (WORKER_FLAGS as readonly string[]).includes(a));
  if (modes.length !== 1) problems.push("exactly one of --rehearse-worker-state, --worker-runtime or --recover-worker-run is required");
  const report = argv.find((a) => a.startsWith("--report="))?.slice(9) ?? null;
  if (modes[0] === "--recover-worker-run" && (!report || !RUN_REPORT_NAME.test(report))) problems.push("--recover-worker-run needs --report=<the interrupted run's staging-results-reporting-worker-worker-runtime-*.md file name>");
  if (modes[0] !== "--recover-worker-run" && report !== null) problems.push("--report only applies to --recover-worker-run");
  const mode = modes.length === 1 ? (modes[0].slice(2) as WorkerMode) : null;
  const siteArg = argv.find((a) => a.startsWith("--site="))?.slice(7);
  const site = siteArg === "au" || siteArg === "uk" || siteArg === "us" ? siteArg : null;
  if (!site) problems.push("--site=au|uk|us is required");
  const int = (name: string, dflt: number, min: number, max: number) => {
    const raw = argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    if (raw === undefined) return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`--${name} must be an integer ${min}..${max}`);
      return dflt;
    }
    return n;
  };
  const paceCalls = int("pace-calls", 4, 2, 50);
  const maxInvocations = int("max-invocations", 12, 3, 60);
  const maxLeaseWaitMs = int("max-lease-wait-ms", 420_000, 1_000, 900_000);
  const known = new Set([...WORKER_FLAGS, "--site", "--pace-calls", "--max-invocations", "--max-lease-wait-ms", "--report"]);
  for (const a of argv) if (!known.has(a.split("=")[0])) problems.push(`unknown argument ${a}`);
  if (mode !== "worker-runtime" && argv.some((a) => /^--(pace-calls|max-invocations|max-lease-wait-ms)=/.test(a))) problems.push("runtime limits only apply to --worker-runtime");
  return { mode, site, paceCalls, maxInvocations, maxLeaseWaitMs, report, problems };
}

export interface WorkerReport extends LifecycleReport {
  mode: WorkerMode;
  site: Site;
  revision: string;
  startedAt: string;
  file43: string;
  settings: string;
  observations: Observation[];
  cleanup: string[];
  /** Mode evidence (no source payloads, keys or credentials). */
  evidence: Record<string, unknown> | null;
  /** Runtime only: exactly what the run owns, persisted before its first commit. */
  ownership: Record<string, unknown> | null;
}
export function newWorkerReport(mode: WorkerMode, site: Site, revision: string, startedAt: string, file43: string): WorkerReport {
  return { mode, site, revision, startedAt, file43, settings: "", observations: [], cleanup: [], evidence: null, ownership: null, errors: [], finishedAt: "", restorationVerified: null, restoration: null, restorationProblems: [] };
}
/** COMPLETE only with evidence complete, every observation ok, no error/cleanup failure and a verified restoration. */
export function workerStatus(r: WorkerReport): string {
  const all = [
    ...r.errors,
    ...r.cleanup.map((c) => `cleanup failed: ${c}`),
    ...r.observations.filter((o) => !o.ok).map((o) => `${o.id} ${o.what}: ${o.result}`),
    ...r.restorationProblems,
  ];
  if (r.evidence?.complete !== true && !all.length) all.push(`${r.mode} evidence is missing or incomplete`);
  if (r.restorationVerified !== true && !all.some((x) => x.startsWith("restoration not verified"))) all.push("restoration not verified");
  return all.length ? `STATUS: FAILED – ${all[0]}${all.length > 1 ? ` (+${all.length - 1} more)` : ""}` : "STATUS: COMPLETE";
}
export function workerMarkdown(r: WorkerReport): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const lines = [
    `# Reporting worker staging evidence (${r.mode})`,
    "",
    `- project: ybrzhrgfrnvtcwymjdrq (staging) · site: ${r.site} · revision: ${r.revision}`,
    `- started: ${r.startedAt} · finished: ${r.finishedAt || "(running)"}`,
    `- 0043 file LF SHA-256: ${r.file43}`,
    `- existing settings (read only): ${r.settings || "(not read)"}`,
    `- restoration: ${r.restorationVerified === true ? "verified" : r.restorationVerified === false ? "NOT verified" : "not checked"}${r.restoration ? ` (${r.restoration})` : ""}`,
    "",
    "| id | check | expected | result | ok | ms |",
    "|---|---|---|---|---|---|",
    ...r.observations.map((o) => `| ${o.id} | ${esc(o.what)} | ${esc(o.expected)} | ${esc(o.result)} | ${o.ok ? "yes" : "NO"} | ${o.ms} |`),
    "",
    ...r.cleanup.map((c) => `- CLEANUP FAILED: ${c}`),
    ...r.restorationProblems.map((p) => `- PROBLEM: ${p}`),
    ...r.errors.map((e) => `- ERROR: ${e}`),
    ...(r.ownership ? ["", "## Ownership", "", "```json", JSON.stringify(r.ownership, null, 2), "```"] : []),
    ...(r.evidence ? ["", "## Evidence", "", "```json", JSON.stringify(r.evidence, null, 2), "```"] : []),
    "",
    workerStatus(r),
    "",
  ];
  return lines.join("\n");
}

export const MIGRATION_0043 = "supabase/migrations/0043_reporting_worker_state.sql";
/** The exact reviewed 0043 (LF sha256); any edit must update this pin and its test. */
export const REVIEWED_0043_LF = "156ee4d525433c8999c52d83ac4175c44629ce6a8f848796a5638ed944c7f633";
/** Root's recorded staging history for the installed Task 14 migrations (exact). */
export const INSTALLED_HISTORY = [
  { version: "20261116165846", name: "0040_reporting_dependency_reads" },
  { version: "20261116165854", name: "0041_reporting_dependency_read_bounds" },
  { version: "20261116165901", name: "0042_reporting_access_paths" },
] as const;
export const HISTORY_SQL = "select version::text as version, name::text as name from supabase_migrations.schema_migrations where name ~ '^004[0-9]_' order by version";

const lf = (s: string) => s.replace(/\r\n/g, "\n");
export const sha256Lf = (s: string) => createHash("sha256").update(lf(s)).digest("hex");

// ---------------------------------------------------------------------------
// 0043 identity and shape (pure; before any SQL)
// ---------------------------------------------------------------------------

export interface WorkerObjects { tables: string[]; indexes: string[]; functions: Array<{ schema: string; name: string }> }
export function workerObjects(text43: string): WorkerObjects {
  const t = lf(text43);
  return {
    tables: [...t.matchAll(/^CREATE TABLE reporting_private\.(\w+) \(/gm)].map((m) => m[1]).sort(),
    indexes: [...t.matchAll(/^CREATE INDEX (\w+) ON /gm)].map((m) => m[1]).sort(),
    functions: [...t.matchAll(/^CREATE FUNCTION (public|reporting_private)\.(\w+)\(/gm)].map((m) => ({ schema: m[1], name: m[2] })).sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`)),
  };
}

const ALLOWED_STATEMENT = [
  /^CREATE TABLE reporting_private\.\w+ \(/,
  /^CREATE INDEX \w+ ON reporting_private\.\w+ /,
  /^ALTER TABLE reporting_private\.\w+ ENABLE ROW LEVEL SECURITY$/,
  /^CREATE FUNCTION (public|reporting_private)\.\w+\(/,
  /^REVOKE ALL ON (TABLE|FUNCTION) (public|reporting_private)\.\w+(\([^)]*\))? FROM PUBLIC, anon, authenticated$/,
  /^GRANT (SELECT, INSERT, UPDATE, DELETE ON TABLE reporting_private\.\w+|EXECUTE ON FUNCTION (public|reporting_private)\.\w+\([^)]*\)) TO service_role$/,
];

/**
 * 0043 may only ADD worker objects: every statement is one of the allowed
 * kinds, nothing is dropped/replaced/truncated, no timeout or definer, and no
 * created table/function already exists in 0037-0042 (so installing it can
 * never replace an installed object).
 */
export function workerStateShapeProblems(text43: string, prior: readonly string[]): string[] {
  const p: string[] = [];
  const body = migrationBody(lf(text43)).map((s) => (stripSqlComments(s) ?? "").trim());
  if (!body.length) p.push("0043 has no statements");
  body.forEach((s, i) => {
    if (!ALLOWED_STATEMENT.some((re) => re.test(s))) p.push(`0043 statement ${i + 1} is not an allowed additive statement: ${s.replace(/\s+/g, " ").slice(0, 100)}`);
  });
  const code = (stripSqlComments(lf(text43)) ?? "").replace(/\$fn\$[\s\S]*?\$fn\$/g, "$fn$$fn$");
  if (/\b(DROP|TRUNCATE|OR\s+REPLACE|SECURITY\s+DEFINER|statement_timeout|lock_timeout|idle_in_transaction_session_timeout)\b/i.test(code)) p.push("0043 drops, replaces, truncates, uses a definer or changes a timeout outside function bodies");
  const o = workerObjects(text43);
  const before = prior.map(lf).join("\n");
  for (const t of o.tables) if (new RegExp(`CREATE TABLE reporting_private\\.${t} \\(`).test(before)) p.push(`0043 table reporting_private.${t} already exists in 0037-0042`);
  for (const f of o.functions) if (new RegExp(`FUNCTION ${f.schema}\\.${f.name}\\(`).test(before)) p.push(`0043 function ${f.schema}.${f.name} already exists in 0037-0042`);
  return p;
}

// ---------------------------------------------------------------------------
// Installed identities (catalog snapshot checks; pure)
// ---------------------------------------------------------------------------

export function historyProblems(rows: ReadonlyArray<Record<string, unknown>>, mode: "absent" | "installed"): string[] {
  const p: string[] = [];
  for (const h of INSTALLED_HISTORY) {
    if (!rows.some((r) => String(r.version) === h.version && String(r.name) === h.name)) p.push(`migration history lacks ${h.version}/${h.name}`);
  }
  const w = rows.filter((r) => /reporting_worker_state$/.test(String(r.name)));
  if (mode === "absent" && w.length) p.push(`0043 is already in the migration history (${w.map((r) => `${String(r.version)}/${String(r.name)}`).join(", ")})`);
  if (mode === "installed" && w.length !== 1) p.push(`0043 must be in the migration history exactly once (found ${w.length})`);
  const unknown = rows.filter((r) => !INSTALLED_HISTORY.some((h) => h.name === String(r.name)) && !/^0043_reporting_worker_state$/.test(String(r.name)) && !/^004[4-9]_/.test(String(r.name)));
  if (unknown.length) p.push(`unexpected 004x history rows: ${unknown.map((r) => String(r.name)).join(", ")}`);
  if (mode === "absent" && rows.some((r) => /^004[4-9]_/.test(String(r.name)))) p.push("a migration after 0043 is already in the history");
  return p;
}

/** The 7 Task 14 dependency functions are exactly the installed 0040/0041/0042 bodies, invoker, empty search_path, service-only. */
export function dependencyIdentityProblems(rows: ReadonlyArray<Record<string, unknown>>, t40: string, t41: string, t42: string): string[] {
  const p: string[] = [];
  if (rows.length !== 7) p.push(`${rows.length} Task 14 dependency functions found, expected 7`);
  for (const r of rows) {
    const nm = String(r.name);
    const body = nm === "frozen_read_batch" ? functionBody(t40, "reporting_private.frozen_read_batch") : functionBody(["read_reporting_owner_members", "read_reporting_staff_stream"].includes(nm) ? t42 : t41, `public.${nm}`);
    if (!bodyHashes(body).includes(String(r.body_md5))) p.push(`${nm} body is not the installed reviewed one`);
    if (r.definer !== false || r.config !== 'search_path=""' || r.anon !== false || r.authenticated !== false || r.service !== true) p.push(`${nm} security differs: ${JSON.stringify({ definer: r.definer, config: r.config, anon: r.anon, authenticated: r.authenticated, service: r.service })}`);
  }
  return p;
}

export const WORKER_CATALOG_SQL = `select json_build_object(
  'tables', (select coalesce(json_agg(json_build_object('name', c.relname::text, 'rls', c.relrowsecurity,
      'anon', pg_catalog.has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
      'authenticated', pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
      'service', pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT') and pg_catalog.has_table_privilege('service_role', c.oid, 'INSERT')
             and pg_catalog.has_table_privilege('service_role', c.oid, 'UPDATE') and pg_catalog.has_table_privilege('service_role', c.oid, 'DELETE')) order by c.relname), '[]'::json)
     from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'reporting_private' and c.relkind = 'r' and c.relname = any($1::text[])),
  'functions', (select coalesce(json_agg(json_build_object('schema', n.nspname::text, 'name', p.proname::text, 'body_md5', md5(p.prosrc), 'definer', p.prosecdef,
      'config', coalesce(array_to_string(p.proconfig, ','), ''),
      'anon', pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE'), 'authenticated', pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      'service', pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'),
      'public', exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a where a.grantee = 0)) order by n.nspname, p.proname), '[]'::json)
     from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname || '.' || p.proname = any($2::text[])),
  'indexes', (select coalesce(json_agg(c.relname::text order by c.relname), '[]'::json)
     from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'reporting_private' and c.relkind = 'i' and c.relname = any($3::text[]))
) as j`;
export const workerCatalogParams = (o: WorkerObjects) => [o.tables, o.functions.map((f) => `${f.schema}.${f.name}`), o.indexes];

export interface WorkerCatalog {
  tables: Array<Record<string, unknown>>;
  functions: Array<Record<string, unknown>>;
  indexes: string[];
}
/** absent: no 0043 object exists. installed: every 0043 object exactly as the reviewed file, RLS on, service-only. */
export function workerCatalogProblems(cat: WorkerCatalog, text43: string, mode: "absent" | "installed"): string[] {
  const o = workerObjects(text43);
  if (mode === "absent") {
    const n = cat.tables.length + cat.functions.length + cat.indexes.length;
    return n ? [`0043 objects already exist (${cat.tables.length} tables, ${cat.functions.length} functions, ${cat.indexes.length} indexes)`] : [];
  }
  const p: string[] = [];
  const names = (xs: Array<Record<string, unknown>>) => xs.map((x) => String(x.name)).sort();
  if (JSON.stringify(names(cat.tables)) !== JSON.stringify(o.tables)) p.push(`worker tables are ${JSON.stringify(names(cat.tables))}, expected ${JSON.stringify(o.tables)}`);
  for (const t of cat.tables) if (t.rls !== true || t.anon !== false || t.authenticated !== false || t.service !== true) p.push(`table ${String(t.name)} access differs: ${JSON.stringify(t)}`);
  if (JSON.stringify([...cat.indexes].sort()) !== JSON.stringify(o.indexes)) p.push(`worker indexes are ${JSON.stringify(cat.indexes)}, expected ${JSON.stringify(o.indexes)}`);
  if (cat.functions.length !== o.functions.length) p.push(`${cat.functions.length} worker functions found, expected ${o.functions.length} (an overload or a missing function)`);
  for (const f of o.functions) {
    const rows = cat.functions.filter((x) => x.schema === f.schema && x.name === f.name);
    if (rows.length !== 1) {
      p.push(`${f.schema}.${f.name} found ${rows.length} times`);
      continue;
    }
    const r = rows[0];
    if (!bodyHashes(functionBody(text43, `${f.schema}.${f.name}`)).includes(String(r.body_md5))) p.push(`${f.schema}.${f.name} body is not the reviewed 0043 one`);
    if (r.definer !== false || r.config !== 'search_path=""' || r.anon !== false || r.authenticated !== false || r.service !== true || r.public !== false) p.push(`${f.schema}.${f.name} security differs: ${JSON.stringify({ definer: r.definer, config: r.config, anon: r.anon, authenticated: r.authenticated, service: r.service, public: r.public })}`);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Mode 1: rollback-only rehearsal
// ---------------------------------------------------------------------------

export interface RehearseCtx {
  site: Site;
  /** Switch the connection's role inside the open transaction (postgres = reset). */
  asRole(c: Db, role: "postgres" | "service_role" | "authenticated"): Promise<void>;
  /** Migration history rows (read-only, outside the guarded transaction). */
  history(c: Db): Promise<Array<Record<string, unknown>>>;
  record(o: Observation): void;
  redact(s: string): string;
  now(): number;
  read?: (path: string) => string;
  pin?: string;
  emit?(ev: WorkerRehearsalEvidence): void;
}
export interface WorkerRehearsalEvidence {
  file: { path: string; lf: string; statements: number } | null;
  history: Array<Record<string, unknown>>;
  catalogInside: WorkerCatalog | null;
  recorded: string[];
  rolledBack: boolean;
  complete: boolean;
}
export const REQUIRED_REHEARSAL_CASES = ["W0", "W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8"] as const;

const ACTIVE_SQL = "select count(*)::int as n from reporting_private.batches where state in ('active', 'frozen', 'publishing')";

/**
 * W0 file identity/shape (before any SQL); W1 history; W2 installed Task 14
 * identities; W3 0043 absent and no active batch; then BEGIN: W4 apply the
 * exact parsed body through the deny-list guard (only these DDL statements);
 * W5 catalog/security of every 0043 object; W6 behaviour inside savepoints
 * (run log as service_role, refusals, client role refused); ROLLBACK; W7 the
 * catalog is absent again; W8 nothing active. The runner's fresh audit then
 * allows ZERO change. Stops at the first failure; always rolls back.
 */
export async function rehearseWorkerState(c: Db, ctx: RehearseCtx): Promise<WorkerRehearsalEvidence> {
  const read = ctx.read ?? ((p: string) => readFileSync(p, "utf8"));
  const ev: WorkerRehearsalEvidence = { file: null, history: [], catalogInside: null, recorded: [], rolledBack: false, complete: false };
  const emit = () => ctx.emit?.(ev);
  const step = async <T>(id: string, what: string, fn: () => Promise<T>, show: (t: T) => string = () => "ok"): Promise<T> => {
    const t0 = ctx.now();
    try {
      const v = await fn();
      ctx.record({ id, what, expected: "succeeds", result: ctx.redact(show(v)), ok: true, ms: Math.round(ctx.now() - t0) });
      ev.recorded.push(id);
      emit();
      return v;
    } catch (e) {
      ctx.record({ id, what, expected: "succeeds", result: ctx.redact(e instanceof Error ? e.message : String(e)), ok: false, ms: Math.round(ctx.now() - t0) });
      emit();
      throw new Error(`${id} failed; later steps depend on it`);
    }
  };
  const text43 = read(MIGRATION_0043);
  const t40 = read(MIGRATION_0040);
  const t41 = read(MIGRATION_0041);
  const t42 = read(MIGRATION_0042);
  const body = migrationBody(lf(text43));
  const objects = workerObjects(text43);
  await step("W0", "the 0043 file is the pinned reviewed draft and only adds worker objects", async () => {
    const got = sha256Lf(text43);
    if (got !== (ctx.pin ?? REVIEWED_0043_LF)) throw new Error(`0043 is not the reviewed draft (${got})`);
    const prior = ["0037_reporting_storage.sql", "0038_reporting_jobs.sql", "0039_reporting_rebuild_insert.sql"].map((f) => read(`supabase/migrations/${f}`)).concat([t40, t41, t42]);
    const p = workerStateShapeProblems(text43, prior);
    if (p.length) throw new Error(p.join("; "));
    ev.file = { path: MIGRATION_0043, lf: got, statements: body.length };
  }, () => `${body.length} statements; ${objects.tables.length} tables, ${objects.indexes.length} indexes, ${objects.functions.length} functions`);
  await step("W1", "migration history: 0040/0041/0042 exactly as root recorded; no 0043 or later", async () => {
    ev.history = await ctx.history(c);
    const p = historyProblems(ev.history, "absent");
    if (p.length) throw new Error(p.join("; "));
  });
  await step("W2", "installed Task 14 dependency functions are exactly 0040/0041/0042, invoker, empty search_path, service-only", async () => {
    const p = dependencyIdentityProblems((await c.query(CASE_SQL.effective)).rows, t40, t41, t42);
    if (p.length) throw new Error(p.join("; "));
  });
  await step("W3", "no 0043 object exists and no reporting batch is active", async () => {
    const cat = (await c.query(WORKER_CATALOG_SQL, workerCatalogParams(objects))).rows[0].j as WorkerCatalog;
    const p = workerCatalogProblems(cat, text43, "absent");
    const active = Number((await c.query(ACTIVE_SQL)).rows[0].n);
    if (active) p.push(`${active} reporting batch(es) are active`);
    if (p.length) throw new Error(p.join("; "));
  });
  const g = dependencyGuard(c, new Set(body));
  let failure: unknown = null;
  await c.query("begin");
  try {
    await step("W4", "apply the exact parsed 0043 body inside the rolled-back transaction (guard: only these DDL statements)", async () => {
      for (const s of body) await g.query(s);
    }, () => `${body.length} statements`);
    await step("W5", "every 0043 object as reviewed: tables with RLS and service-only access, indexes, functions (body, invoker, empty search_path, service-only)", async () => {
      const cat = (await g.query(WORKER_CATALOG_SQL, workerCatalogParams(objects))).rows[0].j as WorkerCatalog;
      ev.catalogInside = cat;
      const p = workerCatalogProblems(cat, text43, "installed");
      if (p.length) throw new Error(p.join("; "));
    });
    await step("W6", "behaviour inside savepoints: run log as service_role; nothing-to-change and unknown-batch refusals; client roles refused", async () => {
      const out: string[] = [];
      const attempt = async (role: "service_role" | "authenticated", sql: string, params: unknown[]): Promise<string | null> => {
        await g.query("savepoint w6");
        try {
          await ctx.asRole(g, role);
          await g.query(sql, params);
          await ctx.asRole(g, "postgres");
          await g.query("release savepoint w6");
          return null;
        } catch (e) {
          await g.query("rollback to savepoint w6");
          await ctx.asRole(g, "postgres");
          return e instanceof Error ? e.message : String(e);
        }
      };
      const logged = await attempt("service_role", "select * from public.record_reporting_run($1, 'refresh', 'refresh', 'idle', null, null, now(), 0, '{}'::jsonb, null)", [ctx.site]);
      if (logged !== null) throw new Error(`record_reporting_run as service_role failed: ${logged}`);
      const n = Number((await g.query("select count(*)::int as n from reporting_private.worker_runs where site = $1", [ctx.site])).rows[0].n);
      if (n < 1) throw new Error("the run log row is not visible inside the transaction");
      out.push("run log ok");
      const expect = async (label: string, role: "service_role" | "authenticated", sql: string, params: unknown[], re: RegExp) => {
        const err = await attempt(role, sql, params);
        if (err === null || !re.test(err)) throw new Error(`${label}: expected ${re}, got ${err === null ? "success" : err}`);
        out.push(`${label} refused`);
      };
      await expect("set_reporting_site_mode with nothing to change", "service_role", "select * from public.set_reporting_site_mode($1, null, null)", [ctx.site], /nothing to change/);
      await expect("read_reporting_worker_progress for an unknown batch", "service_role", "select * from public.read_reporting_worker_progress('00000000-0000-4000-8000-000000000000'::uuid, 1)", [], /./);
      await expect("authenticated set_reporting_site_mode", "authenticated", "select * from public.set_reporting_site_mode($1, null, false)", [ctx.site], /permission denied/);
      await expect("authenticated worker_runs read", "authenticated", "select count(*) from reporting_private.worker_runs", [], /permission denied/);
      return out;
    }, (o) => o.join("; "));
  } catch (e) {
    failure = e;
  } finally {
    await c.query("rollback");
    ev.rolledBack = true;
    emit();
  }
  if (failure) throw failure;
  await step("W7", "after ROLLBACK: no 0043 object exists", async () => {
    const cat = (await c.query(WORKER_CATALOG_SQL, workerCatalogParams(objects))).rows[0].j as WorkerCatalog;
    const p = workerCatalogProblems(cat, text43, "absent");
    if (p.length) throw new Error(p.join("; "));
  });
  await step("W8", "after ROLLBACK: no reporting batch is active", async () => {
    const active = Number((await c.query(ACTIVE_SQL)).rows[0].n);
    if (active) throw new Error(`${active} reporting batch(es) are active`);
  });
  const missing = REQUIRED_REHEARSAL_CASES.filter((id) => !ev.recorded.includes(id));
  if (missing.length) throw new Error(`required cases not recorded: ${missing.join(", ")}`);
  ev.complete = true;
  emit();
  return ev;
}
