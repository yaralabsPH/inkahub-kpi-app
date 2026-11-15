/**
 * T13B2b-19: rollback-only rehearsal of the append-only 0039 rebuild-insert
 * repair (prepared; NOT run by the coder).
 *
 *   npm run staging:reporting-jobs -- --rehearse-rebuild-repair --sites=uk,us [--max-pages=N]
 *
 * STAGING ONLY (guarded client, target checked before every SQL), against the
 * installed immutable 0037/0038. The caller (reporting-jobs publicationMain)
 * takes the full-state baseline first and runs the fresh ZERO-change audit
 * afterwards. Here, in ONE outer transaction that ALWAYS rolls back:
 *   K0  file identities: the fixed 0039 path and its SHA-256; 0037/0038 must be
 *       the installed identities
 *   K1  the installed publish_reporting_batch must be the 0038 definition
 *       (not 0039), with its security, search_path and privileges recorded
 *   K2  0039's body applied (reviewed transaction-control parser)
 *   K3  the function inside the transaction is now 0039; security, search_path
 *       and privileges unchanged
 *   F*  the established full publication flow and its assertions, unchanged
 *   V*  the version-interval proof on the ORIGINAL full site volume: EXPLAIN
 *       (no ANALYZE) of the new rebuild INSERT as service_role (arbiter
 *       source_versions_current, no source_versions anti-join/inner scan),
 *       timed real publication, unchanged/changed/new/absent intervals across
 *       a SECOND rebuild, lost-response replay, and a savepoint probe showing
 *       an unrelated constraint failure still raises
 *   K9  ROLLBACK
 * No COMMIT, migration-history write, VACUUM/ANALYZE, timeout/planner change
 * or other DDL: every statement passes a deny-list guard before it is sent.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { reportingManifestHash } from "../../api/_lib/reporting-stage";
import { copyAll, insertFixtures, fixtureRows, migrationBody, publish, refused, rpc, runPublicationFlow, step, type Db, type FlowCtx, type Site } from "./reportingPublication";

export const MIGRATION_0037 = "supabase/migrations/0037_reporting_storage.sql";
export const MIGRATION_0038 = "supabase/migrations/0038_reporting_jobs.sql";
export const MIGRATION_0039 = "supabase/migrations/0039_reporting_rebuild_insert.sql";

/** Installed identities (LF = as git stores it; 0038 was installed from its CRLF working copy). */
export const INSTALLED = {
  "0037": ["531bb2c5706b9ac4d73a7ca3dc74dead7e34a53160e57fe2971aaf061c6a6a4f"],
  "0038": ["002d6e58034aef1c83f94863bb89ce83dadeb225106cd804d2a46798193dd68f", "14a808ea0787009650437444baaa886da218349353e3ee4a854a97ef68714b1d"],
} as const;

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const lf = (s: string) => s.replace(/\r\n/g, "\n");

export interface FileIdentity { path: string; sha256: string; lf: string; crlf: string }
export function fileIdentity(path: string, read: (p: string) => Buffer = (p) => readFileSync(p)): FileIdentity {
  const raw = read(path);
  const text = lf(raw.toString("utf8"));
  return { path, sha256: sha256(raw), lf: sha256(text), crlf: sha256(text.replace(/\n/g, "\r\n")) };
}

/** publish_reporting_batch's prosrc (the text between its $fn$ delimiters) in a migration's text. */
export function publishBody(text: string): string {
  const t = lf(text);
  const head = t.search(/CREATE (OR REPLACE )?FUNCTION public\.publish_reporting_batch\(p_batch uuid, p_fence bigint\)/);
  if (head < 0) throw new Error("publish_reporting_batch definition not found");
  const open = t.indexOf("AS $fn$", head) + "AS $fn$".length;
  const close = t.indexOf("$fn$;", open);
  return t.slice(open, close);
}
/** md5 of a body in both line-ending forms (installed prosrc may carry either). */
export const bodyHashes = (body: string) => [md5(lf(body)), md5(lf(body).replace(/\n/g, "\r\n"))];

/** The exact 0039 rebuild INSERT with b.site/v_seq/p_batch bound as $1/$2/$3 (proven against the file by a test). */
export const REPAIR_INSERT_SQL = `INSERT INTO reporting_private.source_versions (site, event_id, valid_from_seq, image)
    SELECT $1::text, c.event_id, $2::bigint, c.image
      FROM reporting_private.source_candidate c
     WHERE c.batch_id = $3::uuid AND c.site = $1::text
    ON CONFLICT (site, event_id) WHERE valid_to_seq IS NULL DO NOTHING`;
export const REPAIR_EXPLAIN_SQL = `EXPLAIN (VERBOSE, SETTINGS, FORMAT JSON) ${REPAIR_INSERT_SQL}`;

export const FUNCTION_SQL = `select md5(p.prosrc) as body_md5, p.prosecdef as security_definer, coalesce(p.proconfig::text, '') as config, coalesce(p.proacl::text, '') as acl,
  pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec,
  pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec,
  pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
  pg_catalog.pg_get_userbyid(p.proowner) as owner
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'publish_reporting_batch' and pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_batch uuid, p_fence bigint'`;

// ---------------------------------------------------------------------------
// Pure checks
// ---------------------------------------------------------------------------

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
function walk(n: PlanNode, f: (n: PlanNode, depth: number) => void, depth = 0): void {
  f(n, depth);
  for (const k of n.Plans ?? []) walk(k, f, depth + 1);
}
/** The new rebuild INSERT's plan: conflict arbiter source_versions_current, and no source_versions anti-join or inner scan. */
export function checkRebuildPlan(explain: unknown): string[] {
  const p: string[] = [];
  const root = Array.isArray(explain) && explain[0] && typeof explain[0] === "object" ? ((explain[0] as Record<string, unknown>).Plan as PlanNode | undefined) : undefined;
  if (!root) return ["EXPLAIN returned no JSON plan"];
  if (root["Node Type"] !== "ModifyTable" || root.Operation !== "Insert") p.push(`root is ${String(root["Node Type"])}/${String(root.Operation)}, expected ModifyTable/Insert`);
  if (root["Relation Name"] !== "source_versions") p.push(`inserts into ${String(root["Relation Name"])}`);
  if (root["Conflict Resolution"] !== "NOTHING") p.push(`conflict resolution is ${String(root["Conflict Resolution"])}, expected NOTHING`);
  if (JSON.stringify(root["Conflict Arbiter Indexes"]) !== JSON.stringify(["source_versions_current"])) p.push(`conflict arbiter is ${JSON.stringify(root["Conflict Arbiter Indexes"])}, expected ["source_versions_current"]`);
  walk(root, (n, depth) => {
    if (depth > 0 && n["Relation Name"] === "source_versions") p.push(`a ${String(n["Node Type"])} of source_versions remains under the insert`);
    if (n["Join Type"] === "Anti") p.push(`an anti-join remains (${String(n["Node Type"])})`);
  });
  return p;
}

export interface VersionRow { event_id: string; valid_from_seq: string; valid_to_seq: string | null; image_md5: string }
export interface IntervalCase { unchanged: string; changed: string; absent: string; created: string }
/**
 * Exact intervals for one site across rebuild g1 then rebuild g2:
 *  unchanged: one version [g1, current) with its g1 image
 *  changed:   [g1, g2) old image, then [g2, current) new image
 *  absent:    [g1, g2) and NO current version
 *  created:   one version [g2, current)
 */
export function checkVersionIntervals(rows: readonly VersionRow[], ids: IntervalCase, g1: string, g2: string, images: { before: Record<string, string>; after: Record<string, string> }): string[] {
  const p: string[] = [];
  const of = (id: string) => rows.filter((r) => r.event_id === id).map((r) => `${r.valid_from_seq}-${r.valid_to_seq ?? "cur"}:${r.image_md5}`);
  const want: Record<string, string[]> = {
    [ids.unchanged]: [`${g1}-cur:${images.before[ids.unchanged]}`],
    [ids.changed]: [`${g1}-${g2}:${images.before[ids.changed]}`, `${g2}-cur:${images.after[ids.changed]}`],
    [ids.absent]: [`${g1}-${g2}:${images.before[ids.absent]}`],
    [ids.created]: [`${g2}-cur:${images.after[ids.created]}`],
  };
  for (const [id, w] of Object.entries(want)) {
    const got = of(id);
    if (JSON.stringify(got) !== JSON.stringify(w)) p.push(`${id}: versions ${JSON.stringify(got)}, expected ${JSON.stringify(w)}`);
  }
  if (images.before[ids.changed] === images.after[ids.changed]) p.push(`${ids.changed}: the source change did not change its image`);
  return p;
}

// ---------------------------------------------------------------------------
// Statement guard (deny-list: the flow's statements are many, so forbidden kinds are refused)
// ---------------------------------------------------------------------------

export function repairGuard(c: Db, allowedDdl: ReadonlySet<string>, sent: string[] = []): Db {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const s = sql.replace(/^\s+/, "");
      const ddl = /^(create|alter|drop|grant|revoke|truncate|reindex|cluster|comment|security label)\b/i.test(s);
      const bad =
        /^(commit|end|abort|vacuum|analyze|checkpoint|prepare transaction|commit prepared|set\s+(session\s+)?(statement_timeout|lock_timeout|idle_in_transaction_session_timeout|work_mem|enable_\w+|jit|plan_cache_mode|random_page_cost))\b/i.test(s) ||
        /supabase_migrations|schema_migrations/i.test(s) ||
        /set_config\(\s*'(statement_timeout|lock_timeout|idle_in_transaction_session_timeout|work_mem|enable_\w+|jit|plan_cache_mode|random_page_cost)'/i.test(s) ||
        /^explain\s*\([^)]*\banalyze\b/i.test(s) ||
        (ddl && !allowedDdl.has(sql));
      if (bad) throw new Error(`rebuild-repair rehearsal refuses: ${s.replace(/\s+/g, " ").slice(0, 120)}`);
      sent.push(sql);
      return c.query(sql, params);
    },
  };
}

// ---------------------------------------------------------------------------
// The version-interval proof (real SQL, original full volume)
// ---------------------------------------------------------------------------

export interface RepairEvidence {
  files: FileIdentity[];
  installedFunction: Record<string, unknown> | null;
  repairedFunction: Record<string, unknown> | null;
  statementsApplied: number;
  proof: {
    site: Site | null;
    sourceRows: string | null;
    candidateRows: string | null;
    plan: unknown;
    planProblems: string[];
    publishMs: number[];
    generations: string[];
    intervals: VersionRow[];
    intervalProblems: string[];
    siteVersions: Record<string, unknown> | null;
    replay: Record<string, unknown> | null;
  };
}
export const newRepairEvidence = (): RepairEvidence => ({
  files: [], installedFunction: null, repairedFunction: null, statementsApplied: 0,
  proof: { site: null, sourceRows: null, candidateRows: null, plan: null, planProblems: [], publishMs: [], generations: [], intervals: [], intervalProblems: [], siteVersions: null, replay: null },
});

export const PROOF_IDS: IntervalCase = { unchanged: "rr-unchanged", changed: "rr-changed", absent: "rr-absent", created: "rr-created" };

export const PROOF_SQL = {
  sourceRows: "select count(*)::text as n from public.production_events where location = $1",
  candidateRows: "select count(*)::text as n from reporting_private.source_candidate where batch_id = $1::uuid and site = $2",
  images: "select pe.id as event_id, md5(pg_catalog.to_jsonb(pe)::text) as h from public.production_events pe where pe.location = $1 and pe.id = any($2::text[])",
  versions: "select v.event_id, v.valid_from_seq::text as valid_from_seq, v.valid_to_seq::text as valid_to_seq, md5(v.image::text) as image_md5 from reporting_private.source_versions v where v.site = $1 and v.event_id = any($2::text[]) order by v.event_id, v.valid_from_seq",
  /** Whole site: current versions are exactly the source images (both directions); only changed/created rows were (re)issued by g2. */
  siteVersions: `select
  (select count(*) from reporting_private.source_versions v where v.site = $1 and v.valid_to_seq is null)::text as current_versions,
  (select count(*) from public.production_events pe where pe.location = $1)::text as source_rows,
  (select count(*) from (select pe.id, pg_catalog.to_jsonb(pe) from public.production_events pe where pe.location = $1
     except select v.event_id, v.image from reporting_private.source_versions v where v.site = $1 and v.valid_to_seq is null) x)::text as source_not_current,
  (select count(*) from (select v.event_id, v.image from reporting_private.source_versions v where v.site = $1 and v.valid_to_seq is null
     except select pe.id, pg_catalog.to_jsonb(pe) from public.production_events pe where pe.location = $1) x)::text as current_not_source,
  (select count(*) from reporting_private.source_versions v where v.site = $1 and v.valid_to_seq is null and v.valid_from_seq = $2::bigint and not (v.event_id = any($3::text[])))::text as reissued_unchanged`,
  fingerprint: "select count(*)::text as n, md5(coalesce(string_agg(v.event_id || '|' || v.valid_from_seq || '|' || coalesce(v.valid_to_seq::text, '') || '|' || md5(v.image::text), ',' order by v.event_id, v.valid_from_seq), '')) as h from reporting_private.source_versions v where v.site = $1",
  pkProbe: `INSERT INTO reporting_private.source_versions (site, event_id, valid_from_seq, image)
    SELECT v.site, v.event_id, v.valid_from_seq, v.image FROM reporting_private.source_versions v WHERE v.site = $1 AND v.event_id = $2 AND v.valid_to_seq IS NOT NULL
    ON CONFLICT (site, event_id) WHERE valid_to_seq IS NULL DO NOTHING`,
  checkProbe: `INSERT INTO reporting_private.source_versions (site, event_id, valid_from_seq, image)
    SELECT $1::text, 'rr-check-probe', 999999999::bigint, '{"id": "not-this-id", "location": "nowhere"}'::jsonb
    ON CONFLICT (site, event_id) WHERE valid_to_seq IS NULL DO NOTHING`,
} as const;

async function rebuildOnce(c: Db, ctx: FlowCtx, site: Site, id: string, explain: ((batch: string) => Promise<void>) | null, ev: RepairEvidence): Promise<{ batch: string; fence: number; seq: string }> {
  const [rb] = await step(c, ctx, `${id}a`, `begin rebuild of ${site}`, () => rpc(c, ctx, "select * from public.begin_reporting_rebuild($1)", [site]));
  const batch = String(rb.batch_id);
  const fence = Number(rb.lease_fence);
  await step(c, ctx, `${id}b`, `copy every ${site} source page and freeze (original volume)`, async () => {
    const r = await copyAll(c, ctx, batch, fence);
    await rpc(c, ctx, "select * from public.freeze_reporting_rebuild($1, $2)", [batch, fence]);
    return r;
  }, (r) => `${r.pages} pages, ${r.rows} rows`);
  if (explain) await explain(batch);
  await rpc(c, ctx, "select * from public.seal_reporting_work($1, $2, 0, $3)", [batch, fence, reportingManifestHash([])]);
  const t0 = ctx.now();
  const r = await step(c, ctx, `${id}c`, `publish the ${site} rebuild (existing limits; timed)`, () => publish(c, ctx, batch, fence), (x) => `generation ${String(x.generation_seq)}`);
  ev.proof.publishMs.push(Math.round(ctx.now() - t0));
  ev.proof.generations.push(String(r.generation_seq));
  return { batch, fence, seq: String(r.generation_seq) };
}

/** V*: run on the site's ORIGINAL full volume plus four run-local proof rows; all inside the caller's rolled-back transaction. */
export async function runVersionProof(c: Db, ctx: FlowCtx, ev: RepairEvidence): Promise<void> {
  const site = ctx.sites[0];
  ev.proof.site = site;
  const base = fixtureRows(ctx.staff)[0];
  const row = (id: string, at: string) => ({ ...base, id, order_number: `RR-${id}`, created_at: at });
  const ids = [PROOF_IDS.unchanged, PROOF_IDS.changed, PROOF_IDS.absent, PROOF_IDS.created];
  await step(c, ctx, "V0", "insert the unchanged/changed/absent proof rows (rolled back)", () =>
    insertFixtures(c, site, [row(PROOF_IDS.unchanged, "2026-01-14T09:00:00Z"), row(PROOF_IDS.changed, "2026-01-14T09:05:00Z"), row(PROOF_IDS.absent, "2026-01-14T09:10:00Z")]));
  // Rebuild 1, with the plan checked BEFORE publication.
  const g1 = await rebuildOnce(c, ctx, site, "V1", async (batch) => {
    await step(c, ctx, "V1p", "candidate equals the original source volume", async () => {
      ev.proof.sourceRows = String((await c.query(PROOF_SQL.sourceRows, [site])).rows[0].n);
      ev.proof.candidateRows = String((await c.query(PROOF_SQL.candidateRows, [batch, site])).rows[0].n);
      if (ev.proof.sourceRows !== ev.proof.candidateRows) throw new Error(`candidate ${ev.proof.candidateRows} rows, source ${ev.proof.sourceRows}`);
      return ev.proof.candidateRows;
    }, (n) => `${n} rows`);
    await step(c, ctx, "V1e", "EXPLAIN (no ANALYZE) of the 0039 rebuild INSERT as service_role: arbiter source_versions_current, no anti-join/inner scan", async () => {
      await ctx.as(c, true);
      const r = await c.query(REPAIR_EXPLAIN_SQL, [site, "1", batch]);
      await ctx.as(c, false);
      ev.proof.plan = r.rows[0]?.["QUERY PLAN"] ?? null;
      ev.proof.planProblems = checkRebuildPlan(ev.proof.plan);
      if (ev.proof.planProblems.length) throw new Error(ev.proof.planProblems.join("; "));
    }, () => "plan as expected");
  }, ev);
  const before = Object.fromEntries((await c.query(PROOF_SQL.images, [site, ids])).rows.map((r) => [String(r.event_id), String(r.h)]));
  await step(c, ctx, "V2", "source changes inside the transaction: change one, delete one, create one", async () => {
    await c.query(`update public.production_events set line_quantity = line_quantity + 1 where location = $1 and id = '${PROOF_IDS.changed}'`, [site]);
    await c.query(`delete from public.production_events where location = $1 and id = '${PROOF_IDS.absent}'`, [site]);
    await insertFixtures(c, site, [row(PROOF_IDS.created, "2026-01-14T09:15:00Z")]);
  });
  const g2 = await rebuildOnce(c, ctx, site, "V3", null, ev);
  const after = Object.fromEntries((await c.query(PROOF_SQL.images, [site, ids])).rows.map((r) => [String(r.event_id), String(r.h)]));
  await step(c, ctx, "V4", "exact images AND version intervals for unchanged/changed/absent/created across the second rebuild", async () => {
    ev.proof.intervals = (await c.query(PROOF_SQL.versions, [site, ids])).rows as unknown as VersionRow[];
    ev.proof.intervalProblems = checkVersionIntervals(ev.proof.intervals, PROOF_IDS, g1.seq, g2.seq, { before, after });
    if (ev.proof.intervalProblems.length) throw new Error(ev.proof.intervalProblems.join("; "));
  });
  await step(c, ctx, "V5", "whole site: current versions are exactly the source images; the second rebuild reissued only changed/created rows", async () => {
    const s = (await c.query(PROOF_SQL.siteVersions, [site, g2.seq, [PROOF_IDS.changed, PROOF_IDS.created]])).rows[0];
    ev.proof.siteVersions = s;
    const bad = [s.current_versions !== s.source_rows && `current ${s.current_versions} vs source ${s.source_rows}`, s.source_not_current !== "0" && `${s.source_not_current} source images without an equal current version`,
      s.current_not_source !== "0" && `${s.current_not_source} current versions without an equal source image`, s.reissued_unchanged !== "0" && `${s.reissued_unchanged} unchanged rows reissued by the second rebuild`].filter(Boolean);
    if (bad.length) throw new Error(bad.join("; "));
  });
  await step(c, ctx, "V6", "lost-response replay of the second publication returns the same generation and leaves every version unchanged", async () => {
    const f0 = (await c.query(PROOF_SQL.fingerprint, [site])).rows[0];
    const r = await publish(c, ctx, g2.batch, g2.fence);
    const f1 = (await c.query(PROOF_SQL.fingerprint, [site])).rows[0];
    ev.proof.replay = { replay: r.replay, generation: String(r.generation_seq), before: f0, after: f1 };
    if (r.replay !== true || String(r.generation_seq) !== g2.seq) throw new Error(`replay ${String(r.replay)} at generation ${String(r.generation_seq)} (expected true at ${g2.seq})`);
    if (f0.n !== f1.n || f0.h !== f1.h) throw new Error("source_versions changed on replay");
  });
  await runConstraintProbes(c, ctx, site);
}

/**
 * V7: an unrelated constraint failure is NOT suppressed by the targeted
 * conflict clause. Each probe runs in its own savepoint (refused() rolls the
 * savepoint back and releases it BEFORE recording); under the rehearsal's
 * fail-fast recorder a wrong outcome at V7a stops before V7b is sent.
 */
export async function runConstraintProbes(c: Db, ctx: FlowCtx, site: Site): Promise<void> {
  await refused(c, ctx, "V7a", "a primary-key duplicate (closed version re-inserted) still raises under the targeted ON CONFLICT", /source_versions_pkey/, () => c.query(PROOF_SQL.pkProbe, [site, PROOF_IDS.absent]));
  await refused(c, ctx, "V7b", "a check-constraint violation still raises under the targeted ON CONFLICT", /violates check constraint/, () => c.query(PROOF_SQL.checkProbe, [site]));
}

/**
 * T13B2b-20: the rehearsal's recorder. It persists the ORIGINAL observation
 * first (a persistence failure stays fatal), then throws on ok:false, so no
 * later step, assertion or publication runs after any recorded failure. Shared
 * helpers (step, expectEqual, refused) are unchanged; refused() has already
 * rolled back and released its savepoint before it records.
 */
export function failFast<T extends Pick<FlowCtx, "record">>(ctx: T): T {
  return {
    ...ctx,
    record: (o) => {
      ctx.record(o);
      if (!o.ok) throw new Error(`${o.id} failed; later steps depend on it`);
    },
  };
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export interface RepairCtx extends FlowCtx {
  /** Persist evidence (saves the report); throws on a persistence failure. */
  emit(ev: RepairEvidence): void;
}
export interface RepairDeps {
  read(path: string): Buffer;
  flow(c: Db, ctx: FlowCtx): Promise<void>;
  proof(c: Db, ctx: FlowCtx, ev: RepairEvidence): Promise<void>;
}
export const DEFAULT_REPAIR_DEPS: RepairDeps = { read: (p) => readFileSync(p), flow: runPublicationFlow, proof: runVersionProof };

/**
 * K0..K9. Refuses before BEGIN unless the files are the installed identities
 * and the database runs the 0038 publisher; then applies 0039 inside ONE
 * transaction, runs the established flow and the proof, and ALWAYS rolls back
 * (a rollback failure is kept beside the first error). Stops at the first failure.
 */
export async function rehearseRebuildRepair(raw: Db, ctx: RepairCtx, deps: RepairDeps = DEFAULT_REPAIR_DEPS): Promise<RepairEvidence> {
  const ev = newRepairEvidence();
  const text39 = deps.read(MIGRATION_0039).toString("utf8");
  const body = migrationBody(text39);
  const c = repairGuard(raw, new Set(body));
  const outer = ctx;
  ctx = failFast(ctx); // T13B2b-20: every rehearsal step, the established flow and the proof stop at the first recorded failure
  await step(c, ctx, "K0", "file identities: fixed 0039 path; 0037/0038 are the installed identities", async () => {
    ev.files = [MIGRATION_0037, MIGRATION_0038, MIGRATION_0039].map((p) => fileIdentity(p, deps.read));
    const [f37, f38] = ev.files;
    if (!INSTALLED["0037"].some((h) => h === f37.lf)) throw new Error(`0037 is not the installed identity (${f37.lf})`);
    if (!INSTALLED["0038"].some((h) => h === f38.lf || h === f38.crlf)) throw new Error(`0038 is not the installed identity (${f38.lf})`);
    if (body.length !== 1 || !/^\s*CREATE OR REPLACE FUNCTION public\.publish_reporting_batch\(p_batch uuid, p_fence bigint\)/.test(body[0])) throw new Error("0039 is not the single reviewed CREATE OR REPLACE of publish_reporting_batch");
    ctx.emit(ev);
    return ev.files[2].sha256;
  }, (h) => `0039 sha256 ${h}`);
  const b38 = bodyHashes(publishBody(deps.read(MIGRATION_0038).toString("utf8")));
  const b39 = bodyHashes(publishBody(text39));
  await step(c, ctx, "K1", "installed publish_reporting_batch is the 0038 definition (baseline before any change)", async () => {
    const f = (await c.query(FUNCTION_SQL)).rows[0];
    if (!f) throw new Error("publish_reporting_batch(uuid, bigint) is not installed");
    ev.installedFunction = f;
    if (b39.includes(String(f.body_md5))) throw new Error("the installed publisher is already 0039; this rehearsal needs the 0038 baseline");
    if (!b38.includes(String(f.body_md5))) throw new Error(`the installed publisher is not the 0038 definition (md5 ${String(f.body_md5)})`);
    if (f.security_definer !== false || f.service_exec !== true || f.authenticated_exec !== false || f.anon_exec !== false) throw new Error(`unexpected security/privileges ${JSON.stringify(f)}`);
    ctx.emit(ev);
  });
  await c.query("begin");
  try {
    await step(c, ctx, "K2", "apply 0039's body inside the rolled-back transaction", async () => {
      for (const sql of body) await c.query(sql);
      ev.statementsApplied = body.length;
    }, () => `${body.length} statement`);
    await step(c, ctx, "K3", "inside the transaction the publisher is 0039; security, search_path, owner and privileges unchanged", async () => {
      const f = (await c.query(FUNCTION_SQL)).rows[0];
      ev.repairedFunction = f ?? null;
      if (!f || !b39.includes(String(f.body_md5))) throw new Error(`publisher body after 0039 is ${String(f?.body_md5)}`);
      const i = ev.installedFunction!;
      for (const k of ["security_definer", "config", "acl", "service_exec", "authenticated_exec", "anon_exec", "owner"]) if (JSON.stringify(f[k]) !== JSON.stringify(i[k])) throw new Error(`${k} changed: ${JSON.stringify(i[k])} -> ${JSON.stringify(f[k])}`);
      ctx.emit(ev);
    });
    await deps.flow(c, ctx); // the established flow and assertions, unchanged
    await deps.proof(c, ctx, ev);
    ctx.emit(ev);
  } catch (e) {
    try {
      await c.query("rollback");
    } catch (r) {
      throw new Error(`${outer.redact(e instanceof Error ? e.message : String(e))}; cleanup failed: rehearsal rollback: ${outer.redact(r instanceof Error ? r.message : String(r))}`);
    }
    throw e;
  }
  await c.query("rollback");
  ctx.record({ id: "K9", what: "the rehearsal transaction rolled back (0039 not installed)", expected: "rollback", result: "rolled back", ok: true, ms: 0 });
  return ev;
}
