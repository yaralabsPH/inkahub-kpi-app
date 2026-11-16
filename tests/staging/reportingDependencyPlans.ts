/**
 * Task 14 T14S3: bounded access-path diagnostic for the 0040 + 0041 owner-member
 * and worker-stream reads (prepared; NOT run by the coder).
 *
 *   npm run staging:reporting-jobs -- --diagnose-dependency-plans --sites=uk,us
 *
 * STAGING ONLY, through the same guarded lifecycle as the rehearsal (baseline
 * first, fresh ZERO-change audit after). Inside ONE always-rolled-back
 * transaction (the shared `dependencyTransaction` skeleton: D0/D1 refusals
 * before BEGIN, the exact reviewed 0040/0041 bodies, D3 checks, D9):
 *   S0/S1  capture/processors on; a few named fixtures in one real owner
 *   R0/R1  rebuild of the FULL original source, copied/frozen; candidate = source
 *   M-*, E-* exact extracted SELECTs (members original + ONE split-owner
 *          alternative; streams) run plainly for parity/cursors and under
 *          EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON, TIMING OFF)
 *   P0     SETUP ONLY zero-work publication (base mirror)
 *   F0     small fixture changes; a frozen refresh; the same probes on the overlay
 * A fixed matrix of at most 24 explained executions; no retries, no
 * materializer, no planner settings, no maintenance ANALYZE. COMPLETE means
 * the evidence was collected, NOT that performance is acceptable. The split
 * query is a diagnostic candidate, not an approved production fix.
 */
import { readFileSync } from "node:fs";
import { compareUtf8, reportingManifestHash } from "../../api/_lib/reporting-stage";
import { compareStream, ownerKey, ownerOfEvent, type Owner } from "../../api/_lib/production-reporting-materialize";
import { canonicalJson } from "../../src/lib/domain/productionReporting";
import { BLANK_ORDER, copyAll, publish, rpc, step, type Db, type FlowCtx, type Site } from "./reportingPublication";
import { failFast } from "./reportingRebuildRepair";
import { boundReadQuery, CASE_SQL, dependencyTransaction, insertDependencyFixtures, MIGRATION_0041, rawView, type DependencyBaseEvidence, type EmitCtx, type FixtureRow, type RawView } from "./reportingDependencyRehearsal";

export const DIAG_PREFIX = "EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON, TIMING OFF) ";
export const MAX_EXPLAINS = 24;
type Statement = "members-original" | "members-split" | "stream";

// ---------------------------------------------------------------------------
// The exact statements
// ---------------------------------------------------------------------------

/** The two mutually exclusive owner branches, as one OR join in 0041 (mirror, then candidate). */
export const OR_MIRROR = `        FROM o JOIN reporting_private.source_current s
          ON s.site = $2::text
         AND ((o.kind = 'order' AND s.order_key = o.key) OR (o.kind = 'event' AND s.event_id = o.key AND coalesce(s.order_key, '') = ''))
       WHERE $3::text = 'refresh'
         AND NOT EXISTS (SELECT 1 FROM reporting_private.batch_events be WHERE be.batch_id = $1::uuid AND be.site = $2::text AND be.event_id = s.event_id)`;
export const SPLIT_MIRROR = `        FROM o JOIN reporting_private.source_current s
          ON s.site = $2::text AND s.order_key = o.key
       WHERE $3::text = 'refresh' AND o.kind = 'order'
         AND NOT EXISTS (SELECT 1 FROM reporting_private.batch_events be WHERE be.batch_id = $1::uuid AND be.site = $2::text AND be.event_id = s.event_id)
      UNION ALL
      SELECT o.idx, s.event_id, s.image
        FROM o JOIN reporting_private.source_current s
          ON s.site = $2::text AND s.event_id = o.key AND coalesce(s.order_key, '') = ''
       WHERE $3::text = 'refresh' AND o.kind = 'event'
         AND NOT EXISTS (SELECT 1 FROM reporting_private.batch_events be WHERE be.batch_id = $1::uuid AND be.site = $2::text AND be.event_id = s.event_id)`;
export const OR_CANDIDATE = `        FROM o JOIN reporting_private.source_candidate sc
          ON sc.batch_id = $1::uuid AND sc.site = $2::text
         AND ((o.kind = 'order' AND sc.order_key = o.key) OR (o.kind = 'event' AND sc.event_id = o.key AND coalesce(sc.order_key, '') = ''))
       WHERE $3::text = 'rebuild'`;
export const SPLIT_CANDIDATE = `        FROM o JOIN reporting_private.source_candidate sc
          ON sc.batch_id = $1::uuid AND sc.site = $2::text AND sc.order_key = o.key
       WHERE $3::text = 'rebuild' AND o.kind = 'order'
      UNION ALL
      SELECT o.idx, sc.event_id, sc.image
        FROM o JOIN reporting_private.source_candidate sc
          ON sc.batch_id = $1::uuid AND sc.site = $2::text AND sc.event_id = o.key AND coalesce(sc.order_key, '') = ''
       WHERE $3::text = 'rebuild' AND o.kind = 'event'`;

/**
 * The SELECT-only split-owner alternative: the exact bound 0041 member query
 * with ONLY its two OR joins split into mutually exclusive order/event
 * branches (same equality semantics and collations, ordinality, overlay,
 * tombstone exclusion, outer cursor filter, ORDER BY and LIMIT).
 */
export function splitMembersSql(text0041: string): string {
  const q = boundReadQuery(text0041, "read_reporting_owner_members");
  if (q.split(OR_MIRROR).length !== 2 || q.split(OR_CANDIDATE).length !== 2) throw new Error("the 0041 member query no longer has exactly the two expected OR joins");
  return q.replace(OR_MIRROR, SPLIT_MIRROR).replace(OR_CANDIDATE, SPLIT_CANDIDATE);
}
export function diagnosticStatements(text0041: string): Record<Statement, string> {
  return { "members-original": boundReadQuery(text0041, "read_reporting_owner_members"), "members-split": splitMembersSql(text0041), stream: boundReadQuery(text0041, "read_reporting_staff_stream") };
}
/** The exact EXPLAIN ANALYZE statements the guard allows (nothing else may be executed under ANALYZE). */
export const explainAllowlist = (text0041: string): Set<string> => new Set(Object.values(diagnosticStatements(text0041)).map((q) => DIAG_PREFIX + q));

// ---------------------------------------------------------------------------
// Plan summaries (no payloads)
// ---------------------------------------------------------------------------

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
const KEEP = ["Node Type", "Parent Relationship", "Relation Name", "Alias", "Index Name", "Scan Direction", "Index Cond", "Recheck Cond", "Filter", "Join Filter", "Hash Cond", "Merge Cond", "Join Type", "Strategy",
  "Plan Rows", "Actual Rows", "Actual Loops", "Rows Removed by Filter", "Rows Removed by Join Filter", "Rows Removed by Index Recheck", "Sort Key", "Sort Method", "Sort Space Used", "Sort Space Type", "Presorted Key", "Full-sort Groups",
  "Shared Hit Blocks", "Shared Read Blocks", "Temp Read Blocks", "Temp Written Blocks", "Function Name", "Subplan Name"];
export interface PlanSummary { planningMs: number | null; executionMs: number | null; rootRows: number | null; settings: unknown; nodes: Array<Record<string, unknown>>; truncated: boolean }
/** The fields the diagnosis needs, per node (depth-first, at most 80 nodes); never the Output column lists. */
export function summarizePlan(explain: unknown): PlanSummary {
  const top = (Array.isArray(explain) ? explain[0] : explain) as Record<string, unknown> | undefined;
  const root = top?.Plan as PlanNode | undefined;
  if (!top || !root) throw new Error("EXPLAIN returned no JSON plan");
  const nodes: Array<Record<string, unknown>> = [];
  let truncated = false;
  const walk = (n: PlanNode, depth: number) => {
    if (nodes.length >= 80) return void (truncated = true);
    nodes.push({ depth, ...Object.fromEntries(KEEP.filter((k) => n[k] !== undefined).map((k) => [k, n[k]])) });
    for (const k of n.Plans ?? []) walk(k, depth + 1);
  };
  walk(root, 0);
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return { planningMs: num(top["Planning Time"]), executionMs: num(top["Execution Time"]), rootRows: num(root["Actual Rows"]), settings: top.Settings ?? {}, nodes, truncated };
}

// ---------------------------------------------------------------------------
// Independent expectations and exact comparison
// ---------------------------------------------------------------------------

export interface MemberRow { idx: number; event_id: string; img: unknown }
/** Every member of the given owners in the frozen view, as the read orders them (owner index, bytewise id). */
export function expectedMembers(view: RawView, owners: readonly Owner[]): MemberRow[] {
  const pos = new Map(owners.map((o, i) => [ownerKey(o), i]));
  const out: MemberRow[] = [];
  for (const e of view.events) {
    const i = pos.get(ownerKey(ownerOfEvent(e)));
    if (i !== undefined) out.push({ idx: i, event_id: e.id, img: view.raw.get(e.id) });
  }
  return out.sort((a, b) => a.idx - b.idx || compareUtf8(a.event_id, b.event_id));
}
/** One keyset page of `all` (after (idx, id) exclusive; null = first page). */
export function memberPage(all: readonly MemberRow[], after: { idx: number; id: string } | null, limit: number): MemberRow[] {
  return all.filter((r) => after === null || r.idx > after.idx || (r.idx === after.idx && compareUtf8(r.event_id, after.id) > 0)).slice(0, limit);
}
/** A small diagnostic limit that makes the later page genuinely non-empty (pagination diagnosis, not throughput). */
export function smallLimit(total: number): number {
  if (total < 2) throw new Error(`the diagnostic owners have ${total} member(s); at least 2 are needed for a non-empty later page`);
  return Math.floor(total / 2);
}
/** Exact ordered identities and image hashes; missing, extra, duplicate, reordered or different images all fail. */
export function comparePages(what: string, expected: readonly MemberRow[], actual: ReadonlyArray<Record<string, unknown>>): string[] {
  const p: string[] = [];
  const key = (r: Record<string, unknown>) => `${String(r.idx)}|${String(r.event_id)}`;
  if (new Set(actual.map((r) => key(r))).size !== actual.length) p.push(`${what}: a row is returned twice`);
  if (actual.length !== expected.length) p.push(`${what}: ${actual.length} rows, expected ${expected.length}`);
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
    const a = actual[i];
    const e = expected[i];
    if (!a || !e) break;
    if (key(a) !== key({ idx: e.idx, event_id: e.event_id })) {
      p.push(`${what}: position ${i} is ${JSON.stringify(key(a))}, expected ${JSON.stringify(key({ idx: e.idx, event_id: e.event_id }))}`);
      break;
    }
    if (canonicalJson(a.image) !== canonicalJson(e.img)) {
      p.push(`${what}: ${JSON.stringify(e.event_id)} image differs from the independent frozen image`);
      break;
    }
  }
  return p;
}
/** Expected stream page size from the independent view (exact instant, bytewise id), away from `from`. */
export function expectedStreamCount(view: RawView, staff: string, direction: "before" | "after", from: { at: string; id: string }, limit: number): number {
  const anchor = { created_at: from.at, id: from.id };
  const n = view.events.filter((e) => e.staff_id === staff && (direction === "after" ? compareStream(e, anchor) > 0 : compareStream(e, anchor) < 0)).length;
  return Math.min(n, limit);
}

// ---------------------------------------------------------------------------
// Evidence and the fixed case matrix
// ---------------------------------------------------------------------------

export interface ProbeEvidence { statement: Statement; batch: "rebuild" | "refresh"; page: string; limit: number; cursor: unknown; expectedRows: number; actualRows: number | null; plan: PlanSummary }
export interface PlanEvidence extends DependencyBaseEvidence {
  label: string;
  fullVolume: Record<string, unknown> | null;
  owner: Record<string, unknown> | null;
  staff: Record<string, unknown> | null;
  comparisons: Record<string, string>;
  probes: Record<string, ProbeEvidence>;
  explains: number;
  complete: boolean;
}
export const newPlanEvidence = (): PlanEvidence => ({
  label: "Access-path diagnostic: exact extracted SELECTs on the full original source, EXPLAIN ANALYZE (TIMING OFF) single observations inside a rolled-back transaction; the small member limit is pagination diagnosis, not throughput; COMPLETE means evidence collected, not acceptable performance; the split query is a diagnostic candidate, not an approved fix",
  files: [], statementsApplied: 0, functions: {}, fullVolume: null, owner: null, staff: null, comparisons: {}, probes: {}, explains: 0, recorded: [], complete: false,
});
/** The 20 explained executions (fixed; at most MAX_EXPLAINS). */
export const EXPLAIN_CASES = (["rb", "rf"] as const).flatMap((b) => [
  `E-${b}-mo-1`, `E-${b}-mo-2`, `E-${b}-ms-1`, `E-${b}-ms-2`, `E-${b}-mo-n`, `E-${b}-ms-n`, `E-${b}-sa-1`, `E-${b}-sa-2`, `E-${b}-sb-1`, `E-${b}-sb-2`,
]);
export const REQUIRED_PLAN_CASES = ["D0", "D1", "D2", "D3", "S0", "S1", "R0", "R1", "M-rb-small", "M-rb-normal", "C-rb-stream", "P0", "F0", "M-rf-small", "M-rf-normal", "C-rf-stream", ...EXPLAIN_CASES, "D9"] as const;
export function planEvidenceProblems(ev: PlanEvidence): string[] {
  const p: string[] = [];
  const missing = REQUIRED_PLAN_CASES.filter((id) => !ev.recorded.includes(id));
  if (missing.length) p.push(`required diagnostic cases were not recorded: ${missing.join(", ")}`);
  const probes = EXPLAIN_CASES.filter((id) => !ev.probes[id]);
  if (probes.length) p.push(`plan evidence is missing for: ${probes.join(", ")}`);
  if (ev.explains !== EXPLAIN_CASES.length) p.push(`${ev.explains} explained executions, expected exactly ${EXPLAIN_CASES.length}`);
  return p;
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

export const PLAN_SQL = {
  /** The largest real order owner at the site (bytewise tie-break) and one raw order number for it. */
  owner: `select reporting_private.order_key(pe.order_number) as k, min(pe.order_number) as raw, count(*)::int as n
  from public.production_events pe
 where pe.location = $1 and pe.id not like 'dr-%' and coalesce(reporting_private.order_key(pe.order_number), '') <> ''
 group by 1 order by count(*) desc, reporting_private.order_key(pe.order_number) collate "C" limit 1`, // tie-break on the TEXT key (not the ordinal 1)
  /** The busiest real worker at the site (full volume). */
  staff: "select pe.staff_id::text as s, count(*)::int as n from public.production_events pe where pe.location = $1 and pe.id not like 'dr-%' and pe.staff_id is not null group by 1 order by count(*) desc, 1 limit 1",
} as const;
const FAR_PAST = { at: "2000-01-01T00:00:00.000000Z", id: "" };
const FAR_FUTURE = { at: "2100-01-01T00:00:00.000000Z", id: "" };
const at = (d: string) => `2026-02-14T${d}:00Z`;
export function planFixtures(staff: string, raw: string): { before: FixtureRow[]; inserted: FixtureRow[] } {
  const r = (id: string, order: string, when: string): FixtureRow => ({ id, event_type: "started", order_number: order, staff_id: staff, created_at: at(when), department: "framed", line_sku: null, line_quantity: null, parent_event_id: null, cs_case_id: null, note: "" });
  return { before: [r("dr-pm-1", raw, "01:00"), r("dr-pm-3", raw, "01:10"), r("dr-pe", BLANK_ORDER, "01:20")], inserted: [r("dr-pm-2", raw, "01:05")] };
}

export interface PlanCaseEnv { text0041: string; ev: PlanEvidence }
/** The fixed diagnostic (all inside the caller's rolled-back transaction). */
export async function runPlanCases(c: Db, ctx: FlowCtx, env: PlanCaseEnv): Promise<void> {
  const { ev } = env;
  const [A, B] = ctx.sites;
  const st = diagnosticStatements(env.text0041);
  const plain = async (s: Statement, params: unknown[]) => {
    await ctx.as(c, true);
    const r = await c.query(st[s], params);
    await ctx.as(c, false);
    return r.rows;
  };
  const explain = async (id: string, s: Statement, batch: "rebuild" | "refresh", page: string, params: unknown[], limit: number, cursor: unknown, expectedRows: number) =>
    step(c, ctx, id, `EXPLAIN ANALYZE ${s} (${batch}, ${page})`, async () => {
      if (ev.explains >= MAX_EXPLAINS) throw new Error(`more than ${MAX_EXPLAINS} explained executions`);
      ev.explains++;
      await ctx.as(c, true);
      const r = await c.query(DIAG_PREFIX + st[s], params);
      await ctx.as(c, false);
      const plan = summarizePlan(r.rows[0]?.["QUERY PLAN"]);
      ev.probes[id] = { statement: s, batch, page, limit, cursor, expectedRows, actualRows: plan.rootRows, plan };
      if (plan.rootRows !== expectedRows) throw new Error(`the explained statement returned ${String(plan.rootRows)} rows, expected ${expectedRows}`);
      return plan;
    }, (p) => `${String(p.rootRows)} rows; planning ${String(p.planningMs)} ms, execution ${String(p.executionMs)} ms`);

  await step(c, ctx, "S0", "enable capture and both processors INSIDE the rolled-back transaction", async () => {
    await rpc(c, ctx, "select * from public.set_reporting_capture(true)", []);
    await rpc(c, ctx, "update reporting_private.site_state set processor_enabled = true where site = any($1::text[])", [[A, B]]);
  });
  const chosen = await step(c, ctx, "S1", `choose the largest real order owner and the busiest real worker at ${A}; add 3 named rows (2 to that owner, 1 event owner)`, async () => {
    const o = (await c.query(PLAN_SQL.owner, [A])).rows[0];
    const w = (await c.query(PLAN_SQL.staff, [A])).rows[0];
    if (!o || !w) throw new Error("the site has no real owner or worker");
    const fx = planFixtures(ctx.staff, String(o.raw));
    await insertDependencyFixtures(c, A, fx.before);
    ev.owner = { key: String(o.k), realRows: Number(o.n), fixtureRows: 2, eventOwner: "dr-pe" };
    ev.staff = { id: String(w.s), rows: Number(w.n) };
    return { key: String(o.k), raw: String(o.raw), staff: String(w.s), fx };
  }, (x) => `owner rows ${String(ev.owner?.realRows)} + 2 fixtures; worker rows ${String(ev.staff?.rows)}`);
  const owners: Owner[] = [{ partitionKind: "order", partitionKey: chosen.key }, { partitionKind: "event", partitionKey: "dr-pe" }];
  const ownersJson = JSON.stringify(owners.map((o) => [o.partitionKind, o.partitionKey]));

  // One batch: plain parity (original vs split vs independent) for small first/later and normal pages, then the explains.
  const probeBatch = async (tag: "rb" | "rf", batch: { batchId: string; site: Site; kind: "rebuild" | "refresh" }, view: RawView) => {
    const all = expectedMembers(view, owners);
    const L = smallLimit(all.length);
    const mp = (after: { idx: number; id: string } | null, limit: number) => [batch.batchId, batch.site, batch.kind, ownersJson, after?.idx ?? null, after?.id ?? null, limit];
    const want1 = memberPage(all, null, L);
    const cur = { idx: want1[want1.length - 1].idx, id: want1[want1.length - 1].event_id };
    const want2 = memberPage(all, cur, L);
    await step(c, ctx, `M-${tag}-small`, `members (${batch.kind}) small limit ${L}: original and split first/later pages equal the independent frozen pages exactly; the later page is non-empty`, async () => {
      if (!want2.length) throw new Error("the later page would be empty");
      const p = [
        ...comparePages("original first", want1, await plain("members-original", mp(null, L))),
        ...comparePages("split first", want1, await plain("members-split", mp(null, L))),
        ...comparePages("original later", want2, await plain("members-original", mp(cur, L))),
        ...comparePages("split later", want2, await plain("members-split", mp(cur, L))),
      ];
      if (p.length) throw new Error(p.join("; "));
      ev.comparisons[`${tag}-small`] = `exact (${want1.length} + ${want2.length} of ${all.length})`;
      return `${want1.length} + ${want2.length}`;
    }, (x) => x);
    const wantN = memberPage(all, null, 1000);
    await step(c, ctx, `M-${tag}-normal`, `members (${batch.kind}) normal limit 1,000: original and split equal the independent frozen members exactly`, async () => {
      const p = [...comparePages("original normal", wantN, await plain("members-original", mp(null, 1000))), ...comparePages("split normal", wantN, await plain("members-split", mp(null, 1000)))];
      if (p.length) throw new Error(p.join("; "));
      ev.comparisons[`${tag}-normal`] = `exact (${wantN.length})`;
    });
    await explain(`E-${tag}-mo-1`, "members-original", batch.kind, "first (small)", mp(null, L), L, null, want1.length);
    await explain(`E-${tag}-mo-2`, "members-original", batch.kind, "later (small)", mp(cur, L), L, cur, want2.length);
    await explain(`E-${tag}-ms-1`, "members-split", batch.kind, "first (small)", mp(null, L), L, null, want1.length);
    await explain(`E-${tag}-ms-2`, "members-split", batch.kind, "later (small)", mp(cur, L), L, cur, want2.length);
    await explain(`E-${tag}-mo-n`, "members-original", batch.kind, "first (normal)", mp(null, 1000), 1000, null, wantN.length);
    await explain(`E-${tag}-ms-n`, "members-split", batch.kind, "first (normal)", mp(null, 1000), 1000, null, wantN.length);
    // Streams: the full-volume worker, 1,000-row pages; the later cursor is the first page's exact last row.
    const sp = (dir: "before" | "after", from: { at: string; id: string }) => [batch.batchId, batch.site, batch.kind, chosen.staff, dir, from.at, from.id, 1000];
    const cursors = await step(c, ctx, `C-${tag}-stream`, `stream (${batch.kind}) first pages run plainly for exact later cursors; result counts equal the independent view`, async () => {
      const out: Record<string, { at: string; id: string }> = {};
      for (const [dir, from] of [["after", FAR_PAST], ["before", FAR_FUTURE]] as const) {
        const rows = await plain("stream", sp(dir, from));
        const want = expectedStreamCount(view, chosen.staff, dir, from, 1000);
        if (rows.length !== want) throw new Error(`${dir} first page has ${rows.length} rows, expected ${want}`);
        if (!rows.length) throw new Error(`${dir}: the worker has no rows`);
        const last = rows[rows.length - 1] as { event_id: string; image: { created_at: string } };
        out[dir] = { at: last.image.created_at, id: last.event_id };
      }
      return out;
    }, (o) => JSON.stringify(o));
    for (const [dir, from, code] of [["after", FAR_PAST, "sa"], ["before", FAR_FUTURE, "sb"]] as const) {
      await explain(`E-${tag}-${code}-1`, "stream", batch.kind, `${dir} first`, sp(dir, from), 1000, from, expectedStreamCount(view, chosen.staff, dir, from, 1000));
      const next = cursors[dir];
      await explain(`E-${tag}-${code}-2`, "stream", batch.kind, `${dir} later`, sp(dir, next), 1000, next, expectedStreamCount(view, chosen.staff, dir, next, 1000));
    }
  };

  const view = async () => rawView((await c.query(CASE_SQL.view, [A])).rows as Array<{ img: unknown }>, A);
  const batchOf = async (id: unknown) => {
    const r = (await c.query(CASE_SQL.batch, [String(id)])).rows[0];
    return { batchId: String(r.batch_id), fence: Number(r.fence), state: String(r.state) };
  };
  const rb = await step(c, ctx, "R0", `begin, copy (bounded pages) and freeze a rebuild of ${A} (the full original source + 3 named rows)`, async () => {
    const [x] = await rpc(c, ctx, "select * from public.begin_reporting_rebuild($1)", [A]);
    const pages = await copyAll(c, ctx, String(x.batch_id), Number(x.lease_fence));
    await rpc(c, ctx, "select * from public.freeze_reporting_rebuild($1, $2)", [x.batch_id, x.lease_fence]);
    return { ...(await batchOf(x.batch_id)), pages };
  }, (x) => `${x.pages.pages} pages, ${x.pages.rows} rows`);
  const v1 = await view();
  await step(c, ctx, "R1", "full volume: the frozen candidate is exactly the source (count, ids and images)", async () => {
    const e = (await c.query(CASE_SQL.candidateEquality, [rb.batchId, A])).rows[0];
    ev.fullVolume = e;
    if (e.candidate_rows !== e.source_rows || e.candidate_md5 !== e.source_md5) throw new Error(`candidate ${String(e.candidate_rows)} vs source ${String(e.source_rows)}`);
    if (String(v1.events.length) !== e.source_rows) throw new Error("the independent view does not match the source count");
  }, () => `${String(ev.fullVolume?.source_rows)} rows`);
  await probeBatch("rb", { batchId: rb.batchId, site: A, kind: "rebuild" }, v1);

  await step(c, ctx, "P0", "SETUP ONLY: seal zero work and publish the rebuild to create the base mirror (not counted as evidence)", async () => {
    await rpc(c, ctx, "select * from public.seal_reporting_work($1, $2, 0, $3)", [rb.batchId, rb.fence, reportingManifestHash([])]);
    return publish(c, ctx, rb.batchId, rb.fence);
  });
  const rf = await step(c, ctx, "F0", "named-row changes only (overlay replace dr-pm-1 and dr-pe, insert dr-pm-2, tombstone dr-pm-3); begin a frozen refresh", async () => {
    await insertDependencyFixtures(c, A, chosen.fx.inserted);
    await c.query("update public.production_events set note = 'diagnostic overlay' where location = $1 and id = any(array['dr-pm-1', 'dr-pe'])", [A]);
    await c.query("delete from public.production_events where location = $1 and id = 'dr-pm-3'", [A]);
    const [x] = await rpc(c, ctx, "select * from public.begin_reporting_batch($1)", [A]);
    return batchOf(x.batch_id);
  }, (x) => `refresh ${x.batchId} ${x.state}`);
  await probeBatch("rf", { batchId: rf.batchId, site: A, kind: "refresh" }, await view());
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export type PlanCtx = EmitCtx<PlanEvidence>;
export interface PlanDeps { read(path: string): Buffer; cases(c: Db, ctx: FlowCtx, env: PlanCaseEnv): Promise<void> }
export const DEFAULT_PLAN_DEPS: PlanDeps = { read: (p) => readFileSync(p), cases: runPlanCases };

/** D0..D9 via the shared skeleton, with ONLY the three exact diagnostic SELECTs allowed under EXPLAIN ANALYZE. Never COMPLETE with missing evidence. */
export async function diagnoseDependencyPlans(raw: Db, ctxIn: PlanCtx, deps: PlanDeps = DEFAULT_PLAN_DEPS): Promise<PlanEvidence> {
  const ev = newPlanEvidence();
  const text41 = deps.read(MIGRATION_0041).toString("utf8");
  await dependencyTransaction(raw, ctxIn, deps.read, ev, explainAllowlist(text41), (c, ctx, t) => deps.cases(c, ctx, { text0041: t.text41, ev }), "the diagnostic transaction rolled back (0040/0041 not installed)");
  const missing = planEvidenceProblems(ev);
  if (missing.length) throw new Error(missing.join("; "));
  ev.complete = true;
  failFast(ctxIn).emit(ev);
  return ev;
}
