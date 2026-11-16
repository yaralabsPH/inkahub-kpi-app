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
import { BLANK_ORDER, copyAll, migrationBody, publish, rpc, step, type Db, type FlowCtx, type Site } from "./reportingPublication";
import { bodyHashes, failFast, fileIdentity } from "./reportingRebuildRepair";
import { boundReadQuery, CASE_SQL, dependencyTransaction, functionBody, insertDependencyFixtures, MIGRATION_0041, rawView, stripSqlComments, type DependencyBaseEvidence, type EmitCtx, type FixtureRow, type RawView } from "./reportingDependencyRehearsal";

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
/**
 * Rows each reporting relation's scans read, over the WHOLE plan (not the
 * 80-node summary): (actual rows + rows removed by its own filter/recheck) x
 * loops, summed per relation. The overlay (batch_events) is reported, never
 * assumed bounded.
 */
export function relationReads(explain: unknown): Record<string, number> {
  const top = (Array.isArray(explain) ? explain[0] : explain) as Record<string, unknown> | undefined;
  const root = top?.Plan as PlanNode | undefined;
  if (!root) throw new Error("EXPLAIN returned no JSON plan");
  const out: Record<string, number> = {};
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const walk = (p: PlanNode) => {
    const rel = p["Relation Name"];
    if (typeof rel === "string") out[rel] = (out[rel] ?? 0) + (n(p["Actual Rows"]) + n(p["Rows Removed by Filter"]) + n(p["Rows Removed by Index Recheck"])) * n(p["Actual Loops"]);
    for (const k of p.Plans ?? []) walk(k);
  };
  walk(root);
  return out;
}

/** An owner-key equality against the per-owner lateral key (default or bytewise rendering). */
export const OWNER_KEY_COND = /(order_key|event_id)\)?(::text)? = \(?o(_\d+)?\.key\b/;
/**
 * Structural (runtime-independent) owner-key check over the WHOLE plan: every
 * scan of the candidate must be an index access whose Index Cond (or, for a
 * bitmap heap scan, Recheck Cond) carries the owner key. A scan keyed only on
 * (batch_id, site) is rejected however fast it ran (T14 0042 hosted run:
 * 14 ms, yet 43,804 candidate rows read for 7).
 */
export function ownerKeyProblems(explain: unknown): string[] {
  const top = (Array.isArray(explain) ? explain[0] : explain) as Record<string, unknown> | undefined;
  const root = top?.Plan as PlanNode | undefined;
  if (!root) throw new Error("EXPLAIN returned no JSON plan");
  const out: string[] = [];
  const walk = (p: PlanNode) => {
    if (p["Relation Name"] === "source_candidate") {
      const type = String(p["Node Type"]);
      const cond = String(p["Index Cond"] ?? p["Recheck Cond"] ?? "");
      if (!/Index Scan|Index Only Scan|Bitmap Heap Scan/.test(type)) out.push(`${type} on source_candidate is not an index access`);
      else if (!OWNER_KEY_COND.test(cond)) out.push(`${type}${p["Index Name"] ? ` ${String(p["Index Name"])}` : ""} on source_candidate: the index condition lacks the owner key (${cond || "none"})`);
    }
    for (const k of p.Plans ?? []) walk(k);
  };
  walk(root);
  return out;
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

export interface ProbeEvidence { statement: string; batch: "rebuild" | "refresh"; page: string; limit: number; cursor: unknown; expectedRows: number; actualRows: number | null; reads: Record<string, number>; ownerKey?: string[]; plan: PlanSummary }
export interface PlanEvidence extends DependencyBaseEvidence {
  label: string;
  fullVolume: Record<string, unknown> | null;
  owner: Record<string, unknown> | null;
  staff: Record<string, unknown> | null;
  comparisons: Record<string, string>;
  probes: Record<string, ProbeEvidence>;
  explains: number;
  /** 0042 follow-up only: the structural acceptance verdict (separate from COMPLETE, which means evidence collected). */
  acceptance?: { accepted: boolean; problems: string[] };
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

/** `statements`/`names` (0042 follow-up only) replace the three slots' SQL and their recorded names; the matrix is unchanged. */
export interface PlanCaseEnv { text0041: string; ev: PlanEvidence; statements?: Record<Statement, string>; names?: Record<Statement, string> }
/** The fixed diagnostic (all inside the caller's rolled-back transaction). */
export async function runPlanCases(c: Db, ctx: FlowCtx, env: PlanCaseEnv): Promise<void> {
  const { ev } = env;
  const [A, B] = ctx.sites;
  const st = env.statements ?? diagnosticStatements(env.text0041);
  const name = (s: Statement) => env.names?.[s] ?? s;
  const plain = async (s: Statement, params: unknown[]) => {
    await ctx.as(c, true);
    const r = await c.query(st[s], params);
    await ctx.as(c, false);
    return r.rows;
  };
  const explain = async (id: string, s: Statement, batch: "rebuild" | "refresh", page: string, params: unknown[], limit: number, cursor: unknown, expectedRows: number) =>
    step(c, ctx, id, `EXPLAIN ANALYZE ${name(s)} (${batch}, ${page})`, async () => {
      if (ev.explains >= MAX_EXPLAINS) throw new Error(`more than ${MAX_EXPLAINS} explained executions`);
      ev.explains++;
      await ctx.as(c, true);
      const r = await c.query(DIAG_PREFIX + st[s], params);
      await ctx.as(c, false);
      const plan = summarizePlan(r.rows[0]?.["QUERY PLAN"]);
      ev.probes[id] = { statement: name(s), batch, page, limit, cursor, expectedRows, actualRows: plan.rootRows, reads: relationReads(r.rows[0]?.["QUERY PLAN"]), ...(s === "stream" ? {} : { ownerKey: ownerKeyProblems(r.rows[0]?.["QUERY PLAN"]) }), plan };
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

// ---------------------------------------------------------------------------
// Task 14 0042 follow-up (prepared; NOT run by the coder)
//
//   npm run staging:reporting-jobs -- --diagnose-access-paths --sites=uk,us
//
// The SAME guarded lifecycle, skeleton (D0..D3, D9) and fixed 20-explain case
// matrix as T14S3, with the exact 0042 draft ALSO applied inside the one
// rolled-back transaction (A0) and verified (A1). The three statement slots:
//   members-original  -> the bound 0041 member SELECT (the T14S3 baseline)
//   members-split     -> the bound 0042 member SELECT (per-owner keyed lookups)
//   stream            -> the bound 0042 stream SELECT (branch-local limits)
// Every probe records rows read per relation (relationReads). The refresh
// overlay (batch_events) is measured, not assumed bounded: its stream branch
// still filters the frozen overlay of the batch on JSON staff/created_at.
// COMPLETE means the evidence was collected, NOT that performance is accepted.
// ---------------------------------------------------------------------------

export const MIGRATION_0042 = "supabase/migrations/0042_reporting_access_paths.sql";
/** The exact reviewed 0042 draft (LF sha256); any edit must update this pin and its test. */
export const REVIEWED_0042_LF = "e38aba760a19a70fa3afdddd5155244fb94acb73a53362855d1f63b1a3536a1c";
export const ACCESS_NAMES: Record<Statement, string> = { "members-original": "members-0041", "members-split": "members-0042", stream: "stream-0042" };
export const ACCESS_FUNCTIONS = ["read_reporting_owner_members", "read_reporting_staff_stream"] as const;
export function accessStatements(text0041: string, text0042: string): Record<Statement, string> {
  return { "members-original": boundReadQuery(text0041, "read_reporting_owner_members"), "members-split": boundReadQuery(text0042, "read_reporting_owner_members"), stream: boundReadQuery(text0042, "read_reporting_staff_stream") };
}
export const accessAllowlist = (text0041: string, text0042: string): Set<string> => new Set(Object.values(accessStatements(text0041, text0042)).map((q) => DIAG_PREFIX + q));
/** 0042 must be exactly the two same-signature replacements plus their restated grants. */
export function accessBodyProblems(body: readonly string[]): string[] {
  const want = [
    "CREATE OR REPLACE FUNCTION public.read_reporting_owner_members(p_batch uuid, p_fence bigint, p_owners jsonb, p_after_index integer, p_after_event_id text, p_limit integer DEFAULT 1000)",
    "CREATE OR REPLACE FUNCTION public.read_reporting_staff_stream(p_batch uuid, p_fence bigint, p_staff uuid, p_direction text, p_at timestamptz, p_at_event_id text, p_limit integer DEFAULT 200)",
    "REVOKE ALL ON FUNCTION public.read_reporting_owner_members(uuid, bigint, jsonb, integer, text, integer) FROM PUBLIC, anon, authenticated",
    "REVOKE ALL ON FUNCTION public.read_reporting_staff_stream(uuid, bigint, uuid, text, timestamptz, text, integer) FROM PUBLIC, anon, authenticated",
    "GRANT EXECUTE ON FUNCTION public.read_reporting_owner_members(uuid, bigint, jsonb, integer, text, integer) TO service_role",
    "GRANT EXECUTE ON FUNCTION public.read_reporting_staff_stream(uuid, bigint, uuid, text, timestamptz, text, integer) TO service_role",
  ];
  if (body.length !== want.length) return [`0042 has ${body.length} statements, expected ${want.length}`];
  return body.flatMap((s, i) => ((stripSqlComments(s) ?? "").trimStart().startsWith(want[i]) ? [] : [`0042 statement ${i + 1} is not: ${want[i].slice(0, 80)}`]));
}
/**
 * 0042 keeps the default-collation owner equality AND adds a bytewise one
 * (order_key/event_id COLLATE "C" = key COLLATE "C") so the 0040 bytewise owner
 * indexes are keyed. That adds no narrowing only when the compared columns and
 * the key use the database default collation and that collation is
 * deterministic (PostgreSQL then compares equal text bytewise). Read-only.
 */
export const COLLATION_INVARIANT_SQL = `select
  (select array_agg(a.attname::text || '=' || a.attcollation::text order by a.attname::text) from pg_catalog.pg_attribute a
    where a.attrelid = 'reporting_private.source_candidate'::regclass and a.attname in ('order_key', 'event_id') and not a.attisdropped) as columns,
  pg_catalog.pg_collation_for('["k"]'::jsonb ->> 0) as key_collation,
  (select c.collisdeterministic from pg_catalog.pg_collation c where c.oid = 100) as default_deterministic,
  (select d.datlocprovider::text || ':' || coalesce(d.datcollate, '') from pg_catalog.pg_database d where d.datname = pg_catalog.current_database()) as database_locale,
  (select bool_and((x.a = x.b) IS NOT DISTINCT FROM (x.a COLLATE "C" = x.b COLLATE "C"))
     from (values ('ä', 'a' || pg_catalog.chr(776)), ('A', 'a'), ('ß', 'ss'), ('ﬁ', 'fi'), ('a ', 'a'), ('', ''), ('BULK-1', 'BULK-1'), ('Zq-1', 'zq-1')) x(a, b)) as equality_agrees`;
export function collationInvariantProblems(r: Record<string, unknown> | undefined): string[] {
  if (!r) return ["the collation invariant query returned no row"];
  const p: string[] = [];
  if (JSON.stringify(r.columns) !== JSON.stringify(["event_id=100", "order_key=100"])) p.push(`candidate owner columns are not the database default collation: ${JSON.stringify(r.columns)}`);
  if (r.key_collation !== '"default"') p.push(`the owner key is not the default collation: ${String(r.key_collation)}`);
  if (r.default_deterministic !== true) p.push("the database default collation is not deterministic");
  if (r.equality_agrees !== true) p.push("default-collation equality and bytewise equality disagree on a probe pair");
  return p;
}
/** Structural acceptance of the 0042 follow-up: every 0042 rebuild member probe read the candidate only by owner-keyed index conditions. */
export function accessAcceptanceProblems(ev: PlanEvidence): string[] {
  const probes = Object.entries(ev.probes).filter(([, p]) => p.statement === ACCESS_NAMES["members-split"] && p.batch === "rebuild");
  if (!probes.length) return ["no 0042 rebuild member probe was recorded"];
  return probes.flatMap(([id, p]) => (p.ownerKey === undefined ? [`${id}: owner-key evidence is missing`] : p.ownerKey.map((x) => `${id}: ${x}`)));
}
export const REQUIRED_ACCESS_CASES = [...REQUIRED_PLAN_CASES, "A0", "A1", "A2"] as const;
export const newAccessEvidence = (): PlanEvidence => ({
  ...newPlanEvidence(),
  label: "0042 access-path follow-up: 0040+0041+0042 applied inside a rolled-back transaction; slots members-original = 0041 members (baseline), members-split = 0042 members, stream = 0042 stream; EXPLAIN ANALYZE (TIMING OFF) single observations on the full original source; reads = rows read per relation; the refresh overlay (batch_events) branch is measured, not claimed bounded; COMPLETE means evidence collected, not accepted performance",
});
export interface AccessDeps extends PlanDeps { pin?: string }
export const DEFAULT_ACCESS_DEPS: AccessDeps = DEFAULT_PLAN_DEPS;

/** D0..D3 (0040/0041) via the shared skeleton, then A0/A1 (the exact 0042), then the fixed cases; always rolled back. */
export async function diagnoseAccessPaths(raw: Db, ctxIn: PlanCtx, deps: AccessDeps = DEFAULT_ACCESS_DEPS): Promise<PlanEvidence> {
  const ev = newAccessEvidence();
  const text41 = deps.read(MIGRATION_0041).toString("utf8");
  const id42 = fileIdentity(MIGRATION_0042, deps.read);
  const text42 = deps.read(MIGRATION_0042).toString("utf8");
  const body42 = migrationBody(text42);
  // Refused before BEGIN: an unreviewed 0042 file or an unexpected statement list.
  const pin = deps.pin ?? REVIEWED_0042_LF;
  if (id42.lf !== pin && id42.crlf !== pin) throw new Error(`0042 is not the reviewed draft (${id42.lf})`);
  const shape = accessBodyProblems(body42);
  if (shape.length) throw new Error(shape.join("; "));
  await dependencyTransaction(raw, ctxIn, deps.read, ev, accessAllowlist(text41, text42), async (c, ctx, t) => {
    await step(c, ctx, "A0", "apply the exact 0042 draft (parsed body) after 0040/0041 inside the rolled-back transaction", async () => {
      for (const sql of body42) await c.query(sql);
      ev.files.push(id42);
      ev.statementsApplied += body42.length;
    }, () => `${body42.length} statements (${id42.lf.slice(0, 12)}…)`);
    await step(c, ctx, "A1", "effective functions: the two 0042 bodies, the other reads still 0041, all SECURITY INVOKER, empty search_path, service-only", async () => {
      const rows = (await c.query(CASE_SQL.effective)).rows;
      ev.functions.effective0042 = rows;
      const p: string[] = [];
      if (rows.length !== 7) p.push(`${rows.length} functions found, expected 7`);
      for (const r of rows) {
        const nm = String(r.name);
        if (nm === "frozen_read_batch") continue;
        const src = (ACCESS_FUNCTIONS as readonly string[]).includes(nm) ? text42 : t.text41;
        if (!bodyHashes(functionBody(src, `public.${nm}`)).includes(String(r.body_md5))) p.push(`${nm} body is not the ${src === text42 ? "0042" : "0041"} one`);
        if (r.definer !== false || r.config !== 'search_path=""' || r.anon !== false || r.authenticated !== false || r.service !== true) p.push(`${nm} security ${JSON.stringify(r)}`);
      }
      if (p.length) throw new Error(p.join("; "));
      ctx.emit(ev);
    });
    await step(c, ctx, "A2", "collation invariant: candidate owner columns and the owner key use the deterministic database default collation, so the added bytewise owner equality narrows nothing", async () => {
      const row = (await c.query(COLLATION_INVARIANT_SQL)).rows[0];
      ev.functions.collation0042 = row ?? null;
      const p = collationInvariantProblems(row);
      if (p.length) throw new Error(p.join("; "));
      return row;
    }, (r) => `${String(r?.database_locale)}; deterministic`);
    await deps.cases(c, ctx, { text0041: t.text41, ev, statements: accessStatements(t.text41, text42), names: ACCESS_NAMES });
  }, "the access-path transaction rolled back (0040/0041/0042 not installed)", body42);
  const missing = [...REQUIRED_ACCESS_CASES.filter((id) => !ev.recorded.includes(id)).map((id) => `required case ${id} was not recorded`), ...planEvidenceProblems(ev)];
  if (missing.length) throw new Error(missing.join("; "));
  const rejected = accessAcceptanceProblems(ev);
  ev.acceptance = { accepted: rejected.length === 0, problems: rejected };
  ev.complete = true;
  failFast(ctxIn).emit(ev);
  return ev;
}
