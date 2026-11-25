/**
 * Task 13 B2b I4 diagnostic (plan-only; prepared, NOT run by the coder).
 *
 *   npm run staging:reporting-jobs -- --explain-source-versions --site=uk [--max-pages=N]
 *
 * STAGING ONLY (guarded client: target checked before every SQL), against the
 * installed immutable 0038. ONE outer transaction that always ends in
 * ROLLBACK:
 *   P0  capture and the site's processor enabled INSIDE the transaction
 *   P1  begin_reporting_rebuild(site)           (reviewed helper)
 *   P2  copy every source page                  (reviewed helper, existing --max-pages bound)
 *   P3  freeze_reporting_rebuild                (reviewed helper)
 *   P4  candidate rows == the site's original source rows (the I4 workload)
 *   P5  role, settings, relation heap/index/TOAST sizes and stats timestamps
 *   P6  EXPLAIN (VERBOSE, SETTINGS, FORMAT JSON) — WITHOUT ANALYZE — of the
 *       exact rebuild source_versions INSERT (0038 publish_reporting_batch,
 *       rebuild branch) as service_role, with that candidate
 *   P7  ROLLBACK
 * It never publishes, commits, runs DDL/VACUUM/ANALYZE, changes a planner or
 * timeout setting, or benchmarks anything: every statement goes through an
 * exact allow-list (DIAGNOSTIC_ALLOWED) and anything else is refused before
 * it is sent. The plan is a CURRENT STANDALONE plan with the bound values; it
 * is not the cached PL/pgSQL plan that timed out. The caller (reporting-jobs
 * publicationMain) takes the full baseline first and runs the fresh
 * full-state audit with ZERO allowed changes afterwards.
 */
import { copyAll, rpc, step, type Db, type FlowCtx, type Site } from "./reportingPublication";

/**
 * The exact INSERT from 0038 publish_reporting_batch (rebuild branch), with the
 * PL/pgSQL variables as bind parameters: b.site -> $1::text, v_seq -> $2::bigint,
 * p_batch -> $3::uuid. Proven identical to the migration text by a test.
 */
export const SOURCE_VERSIONS_INSERT_SQL = `INSERT INTO reporting_private.source_versions (site, event_id, valid_from_seq, image)
    SELECT $1::text, c.event_id, $2::bigint, c.image
      FROM reporting_private.source_candidate c
     WHERE c.batch_id = $3::uuid AND c.site = $1::text
       AND NOT EXISTS (SELECT 1 FROM reporting_private.source_versions v WHERE v.site = $1::text AND v.event_id = c.event_id AND v.valid_to_seq IS NULL)`;

export const EXPLAIN_SQL = `EXPLAIN (VERBOSE, SETTINGS, FORMAT JSON) ${SOURCE_VERSIONS_INSERT_SQL}`;

/**
 * v_seq appears only in the SELECT list (never in a predicate or join), so its
 * value cannot change the plan; a fixed placeholder is bound and recorded.
 */
export const SEQ_PLACEHOLDER = "1";

export const DIAGNOSTIC_RELATIONS = ["source_candidate", "source_versions", "source_current", "batches"] as const;

export const DIAGNOSTIC_SETTINGS = [
  "work_mem", "maintenance_work_mem", "effective_cache_size", "shared_buffers", "random_page_cost", "seq_page_cost", "cpu_tuple_cost",
  "jit", "jit_above_cost", "plan_cache_mode", "default_statistics_target", "max_parallel_workers_per_gather", "enable_hashjoin",
  "enable_mergejoin", "enable_nestloop", "enable_seqscan", "enable_indexscan", "enable_bitmapscan", "statement_timeout", "lock_timeout",
  "idle_in_transaction_session_timeout", "search_path", "server_version",
] as const;

export const DIAG_SQL = {
  processorOn: "update reporting_private.site_state set processor_enabled = true where site = $1",
  sourceRows: "select count(*)::text as n from public.production_events where location = $1",
  candidateRows: "select count(*)::text as n from reporting_private.source_candidate where batch_id = $1::uuid and site = $2",
  currentVersions: "select count(*)::text as n from reporting_private.source_versions where site = $1 and valid_to_seq is null",
  role: "select current_user::text as current_user, session_user::text as session_user, current_setting('search_path') as search_path, current_setting('transaction_isolation') as isolation",
  settings: "select name, setting, unit, source from pg_catalog.pg_settings where name = any($1::text[]) order by name",
  relations: `select c.relname::text as relname, c.relkind::text as relkind, c.reltuples::float8 as reltuples, c.relpages::bigint as relpages,
  pg_catalog.pg_relation_size(c.oid)::text as heap_bytes, pg_catalog.pg_indexes_size(c.oid)::text as index_bytes,
  (case when c.reltoastrelid = 0 then 0 else pg_catalog.pg_total_relation_size(c.reltoastrelid) end)::text as toast_bytes,
  pg_catalog.pg_total_relation_size(c.oid)::text as total_bytes,
  s.n_live_tup::text as n_live_tup, s.n_dead_tup::text as n_dead_tup, s.n_mod_since_analyze::text as n_mod_since_analyze,
  s.last_vacuum::text as last_vacuum, s.last_autovacuum::text as last_autovacuum, s.last_analyze::text as last_analyze, s.last_autoanalyze::text as last_autoanalyze,
  s.vacuum_count::text as vacuum_count, s.autovacuum_count::text as autovacuum_count, s.analyze_count::text as analyze_count, s.autoanalyze_count::text as autoanalyze_count
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
left join pg_catalog.pg_stat_all_tables s on s.relid = c.oid
where n.nspname = 'reporting_private' and c.relname = any($1::text[]) order by c.relname`,
  indexes: `select ci.relname::text as index_name, ct.relname::text as table_name, pg_catalog.pg_relation_size(i.indexrelid)::text as bytes,
  ci.reltuples::float8 as reltuples, ci.relpages::bigint as relpages, si.idx_scan::text as idx_scan, pg_catalog.pg_get_indexdef(i.indexrelid) as definition
from pg_catalog.pg_index i join pg_catalog.pg_class ci on ci.oid = i.indexrelid join pg_catalog.pg_class ct on ct.oid = i.indrelid
join pg_catalog.pg_namespace n on n.oid = ct.relnamespace left join pg_catalog.pg_stat_all_indexes si on si.indexrelid = i.indexrelid
where n.nspname = 'reporting_private' and ct.relname = any($1::text[]) order by ct.relname, ci.relname`,
} as const;

const BECOME_CLAIMS = "select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', '', true)";

/** Every statement the diagnostic may send; anything else is refused BEFORE it reaches the database. */
export const DIAGNOSTIC_ALLOWED: ReadonlySet<string> = new Set<string>([
  "begin",
  "rollback",
  "reset role",
  "set local role service_role",
  BECOME_CLAIMS,
  "select * from public.set_reporting_capture(true)",
  DIAG_SQL.processorOn,
  "select * from public.begin_reporting_rebuild($1)",
  "select * from public.copy_reporting_source_page($1, $2, $3)",
  "select * from public.freeze_reporting_rebuild($1, $2)",
  DIAG_SQL.sourceRows,
  DIAG_SQL.candidateRows,
  DIAG_SQL.currentVersions,
  DIAG_SQL.role,
  DIAG_SQL.settings,
  DIAG_SQL.relations,
  DIAG_SQL.indexes,
  EXPLAIN_SQL,
]);

/** The allow-list guard: every statement is checked, logged, and only then sent. */
export function diagnosticDb(c: Db, sent: string[] = []): Db & { sent: string[] } {
  return {
    sent,
    query: async (sql: string, params?: unknown[]) => {
      if (!DIAGNOSTIC_ALLOWED.has(sql)) throw new Error(`plan diagnostic refuses a statement outside its allow-list: ${sql.replace(/\s+/g, " ").slice(0, 120)}`);
      sent.push(sql);
      return c.query(sql, params);
    },
  } as Db & { sent: string[] };
}

export interface PlanDiagnostic {
  label: string;
  site: Site;
  batchId: string | null;
  copy: { pages: number; rows: number } | null;
  sourceRows: string | null;
  candidateRows: string | null;
  currentVersions: string | null;
  role: Record<string, unknown> | null;
  settings: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
  indexes: Array<Record<string, unknown>>;
  sql: string;
  params: { site: Site; seq: string; seqNote: string; batchId: string | null };
  plan: unknown;
}

export const DIAGNOSTIC_LABEL =
  "CURRENT STANDALONE plan (EXPLAIN without ANALYZE, bound parameter values, current statistics) of the exact rebuild source_versions INSERT; NOT the cached PL/pgSQL plan that timed out in I4, and the uncommitted candidate rows are invisible to the table statistics";

export interface PlanDiagnosticCtx extends Pick<FlowCtx, "as" | "record" | "redact" | "now" | "maxPages"> {
  site: Site;
  /** Persist the diagnostic (saves the report); throws on a persistence failure. */
  emit(d: PlanDiagnostic): void;
}

/**
 * Run the plan-only diagnostic on `raw` inside ONE transaction that ALWAYS
 * rolls back (also after a prepare, EXPLAIN or persistence failure). Stops at
 * the first failure; the caller's lifecycle still closes every session and
 * runs the fresh zero-change audit.
 */
export async function runPlanDiagnostic(raw: Db, ctx: PlanDiagnosticCtx): Promise<PlanDiagnostic> {
  const c = diagnosticDb(raw);
  const site = ctx.site;
  const flow = { ...ctx, sites: [site, site] as [Site, Site], staff: "" } as FlowCtx;
  const d: PlanDiagnostic = {
    label: DIAGNOSTIC_LABEL, site, batchId: null, copy: null, sourceRows: null, candidateRows: null, currentVersions: null, role: null,
    settings: [], relations: [], indexes: [], sql: SOURCE_VERSIONS_INSERT_SQL, params: { site, seq: SEQ_PLACEHOLDER, seqNote: "v_seq is only projected, never a predicate", batchId: null }, plan: null,
  };
  await c.query("begin");
  try {
    await step(c, flow, "P0", `enable capture and the ${site} processor inside the rolled-back transaction`, async () => {
      await rpc(c, flow, "select * from public.set_reporting_capture(true)", []);
      await rpc(c, flow, DIAG_SQL.processorOn, [site]);
    });
    const [rb] = await step(c, flow, "P1", `begin rebuild of ${site}`, () => rpc(c, flow, "select * from public.begin_reporting_rebuild($1)", [site]), (r) => `batch ${String(r[0]?.batch_id)}`);
    const batch = String(rb.batch_id);
    const fence = Number(rb.lease_fence);
    d.batchId = batch;
    d.params.batchId = batch;
    d.copy = await step(c, flow, "P2", `copy every ${site} source page (existing bound ${ctx.maxPages} pages)`, () => copyAll(c, flow, batch, fence), (r) => `${r.pages} pages, ${r.rows} rows`);
    await step(c, flow, "P3", "freeze the rebuild (one statement)", () => rpc(c, flow, "select * from public.freeze_reporting_rebuild($1, $2)", [batch, fence]));
    await step(c, flow, "P4", `candidate rows equal the original ${site} source rows (the I4 workload)`, async () => {
      d.sourceRows = String((await c.query(DIAG_SQL.sourceRows, [site])).rows[0].n);
      d.candidateRows = String((await c.query(DIAG_SQL.candidateRows, [batch, site])).rows[0].n);
      d.currentVersions = String((await c.query(DIAG_SQL.currentVersions, [site])).rows[0].n);
      if (d.candidateRows !== d.sourceRows) throw new Error(`candidate has ${d.candidateRows} rows but ${site} has ${d.sourceRows} source rows; not the original workload`);
      if (d.candidateRows === "0") throw new Error(`${site} has no source rows; nothing to diagnose`);
      return d.candidateRows;
    }, (n) => `${n} rows (current source_versions for ${site}: ${d.currentVersions})`);
    await step(c, flow, "P5", "role, settings, relation sizes and statistics (before any publication)", async () => {
      d.settings = (await c.query(DIAG_SQL.settings, [[...DIAGNOSTIC_SETTINGS]])).rows;
      d.relations = (await c.query(DIAG_SQL.relations, [[...DIAGNOSTIC_RELATIONS]])).rows;
      d.indexes = (await c.query(DIAG_SQL.indexes, [[...DIAGNOSTIC_RELATIONS]])).rows;
      if (d.relations.length !== DIAGNOSTIC_RELATIONS.length) throw new Error(`expected ${DIAGNOSTIC_RELATIONS.length} relations, found ${d.relations.length}`);
    }, () => `${d.settings.length} settings, ${d.relations.length} relations, ${d.indexes.length} indexes`);
    await step(c, flow, "P6", "EXPLAIN (VERBOSE, SETTINGS, FORMAT JSON) without ANALYZE of the exact source_versions INSERT, as service_role", async () => {
      await ctx.as(c, true);
      d.role = (await c.query(DIAG_SQL.role)).rows[0] ?? null;
      if (d.role?.current_user !== "service_role") throw new Error(`EXPLAIN must run as service_role, not ${String(d.role?.current_user)}`);
      const r = await c.query(EXPLAIN_SQL, [site, SEQ_PLACEHOLDER, batch]);
      await ctx.as(c, false);
      const plan = r.rows[0]?.["QUERY PLAN"];
      if (!Array.isArray(plan) || !plan[0] || typeof plan[0] !== "object" || !("Plan" in plan[0])) throw new Error("EXPLAIN returned no JSON plan");
      d.plan = plan;
      return plan;
    }, () => "full JSON plan captured");
    ctx.emit(d); // persisted before the rollback is recorded
  } catch (e) {
    // Unconditional rollback; a rollback failure is kept BESIDE the first failure, never replacing it.
    try {
      await c.query("rollback");
    } catch (r) {
      throw new Error(`${ctx.redact(e instanceof Error ? e.message : String(e))}; cleanup failed: diagnostic rollback: ${ctx.redact(r instanceof Error ? r.message : String(r))}`);
    }
    throw e;
  }
  await c.query("rollback"); // nothing here is ever committed
  ctx.record({ id: "P7", what: "the diagnostic transaction rolled back", expected: "rollback", result: "rolled back", ok: true, ms: 0 });
  return d;
}

/** Report section: the full plan and environment, without source payloads. */
export function planDiagnosticMarkdown(d: PlanDiagnostic | null): string[] {
  if (!d) return [];
  return ["## Plan diagnostic (source_versions INSERT)", "", `- ${d.label}`, "", "```json", JSON.stringify(d, null, 2), "```", ""];
}
