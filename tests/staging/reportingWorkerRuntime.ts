/**
 * Task 15 post-install protected runtime evidence (PREPARED; NOT run by the
 * coder). Root runs it on staging ybrzhrgfrnvtcwymjdrq only, after 0043 is
 * installed:
 *
 *   npm run staging:reporting-jobs -- --worker-runtime --site=X [--pace-calls=N] [--max-invocations=N] [--max-lease-wait-ms=N]
 *
 * The REAL runReportingCycle runs over a direct-pg service RpcClient
 * (serviceRpc.ts), one fresh guarded connection per invocation. Refused
 * before any mutation unless: wrong-project/marker checks pass (runner),
 * history/identities are the installed 0040-0043, capture is OFF, no batch is
 * active anywhere, the run site is processor-off/legacy with NO batch,
 * generation, derived/mirror row or pending journal row, no fixture id
 * collides, and two baselines taken back to back are identical.
 *
 * ALLOWED retained changes (declared, never hidden as restoration): capture
 * epoch increments of this run's CONFIRMED toggles; the run site's published
 * generation pointer, source epoch, verified cutoff, lease/heartbeat
 * bookkeeping; and run-site reporting rows that belong to this run's own
 * batches/generations, journal rows of its own fixture ids, and its own run
 * log rows. Everything else, every other site, all source rows (fixtures are
 * deleted), stock, ledger, memberships and the whole catalog must be
 * identical; capture and the site's processor/read mode return to their
 * starting values.
 */
import type { CaptureTransition } from "./reportingCommitted";
import { transitionIncrement } from "./reportingCommitted";
import { compareFullState, reducerDaily, sqlDaily, type Db, type FullState, type Site, type StateAllowance } from "./reportingPublication";
import type { ProductionEvidenceEvent } from "../../src/lib/domain/productionCounts";

export interface RuntimeInvocation {
  n: number;
  label: string;
  mode: "refresh" | "rebuild";
  paced: number | null;
  state: string;
  batchId: string | null;
  generationId: string | null;
  failureKind: string | null;
  problems: string[];
  counts: Record<string, number>;
  calls: number;
  injected: Array<{ fn: string; n: number; fault: string }>;
  fenceAfter: string | null;
}
export interface RuntimeOwnership {
  runId: string;
  prefix: string;
  site: Site;
  /** Database clock at the start (rows created at or after it at the run site are this run's). */
  startedAt: string | null;
  baselineMaxChangeId: string;
  original: { captureEnabled: boolean; captureEpoch: string; processor: boolean; readMode: string } | null;
  fixtureIds: string[];
  fixturesInserted: boolean;
  processorChanged: boolean;
  committedAnything: boolean;
  captureTransitions: CaptureTransition[];
  batches: string[];
  generations: string[];
  invocations: RuntimeInvocation[];
}
export function newRuntimeOwnership(site: Site, runId: string): RuntimeOwnership {
  if (!/^[0-9a-f]{8}$/.test(runId)) throw new Error("runId must be 8 hex characters");
  return { runId, prefix: `rw-${runId}-`, site, startedAt: null, baselineMaxChangeId: "0", original: null, fixtureIds: [], fixturesInserted: false, processorChanged: false, committedAnything: false, captureTransitions: [], batches: [], generations: [], invocations: [] };
}

// ---------------------------------------------------------------------------
// Scoped audit: what may differ is attributed, everything else must be identical
// ---------------------------------------------------------------------------

/** "Row belongs to the run site" per reporting_private table ($1 = site). Unknown tables are compared in full. */
export const SITE_ATTRIBUTION: Readonly<Record<string, string>> = Object.freeze({
  generations: "t.site = $1", batches: "t.site = $1", batch_events: "t.site = $1", source_current: "t.site = $1", source_candidate: "t.site = $1",
  source_versions: "t.site = $1", event_facts: "t.site = $1", cancel_edges: "t.site = $1", order_occurrences: "t.site = $1", daily_totals: "t.site = $1",
  timing_facts: "t.site = $1", source_issue_facts: "t.site = $1", worker_runs: "t.site = $1",
  changes: "(t.old_site = $1 or t.new_site = $1)",
  batch_changes: "exists (select 1 from reporting_private.batches b where b.batch_id = t.batch_id and b.site = $1)",
  partition_work: "exists (select 1 from reporting_private.batches b where b.batch_id = t.batch_id and b.site = $1)",
  worker_progress: "exists (select 1 from reporting_private.batches b where b.batch_id = t.batch_id and b.site = $1)",
  worker_owners: "exists (select 1 from reporting_private.batches b where b.batch_id = t.batch_id and b.site = $1)",
  worker_seen: "exists (select 1 from reporting_private.batches b where b.batch_id = t.batch_id and b.site = $1)",
  worker_walk_line: "exists (select 1 from reporting_private.batches b where b.batch_id = t.batch_id and b.site = $1)",
  partition_results: "exists (select 1 from reporting_private.partition_work w join reporting_private.batches b on b.batch_id = w.batch_id where w.work_id = t.work_id and b.site = $1)",
  owner_inputs: "t.site = $1",
  owner_input_events: "exists (select 1 from reporting_private.owner_inputs o where o.handle = t.handle and o.site = $1)",
  owner_input_pieces: "exists (select 1 from reporting_private.owner_inputs o where o.handle = t.handle and o.site = $1)",
});
/** Run-site rows that existed before the run and must stay identical (history the run never touches). */
const PRE_EXISTING: Readonly<Record<string, string>> = Object.freeze({ changes: "t.change_id <= $2::bigint", worker_runs: "t.started_at < $3::timestamptz" });
const IDENT = /^[a-z_][a-z0-9_]*$/;

/** Hash of the rows the run may NOT change: other sites' rows, and the run site's pre-existing journal/run-log history. */
export function stableHashSql(table: string): string {
  if (!IDENT.test(table)) throw new Error(`unexpected table name ${table}`);
  const attr = SITE_ATTRIBUTION[table];
  const pre = PRE_EXISTING[table];
  const stable = attr ? `(not (${attr})${pre ? ` or ${pre}` : ""})` : "true";
  return `select count(*)::text || ':' || md5(coalesce(string_agg(x, '' order by x), '')) as h from (select md5(to_jsonb(t)::text) as x from reporting_private."${table}" t where ${stable} and ($1::text, $2::bigint, $3::timestamptz) is not null) s`;
}
export const PRIVATE_TABLES_SQL = "select c.relname::text as t from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'reporting_private' and c.relkind = 'r' and c.relname not in ('control', 'site_state') order by 1";

export async function stableHashes(c: Db, own: Pick<RuntimeOwnership, "site" | "baselineMaxChangeId" | "startedAt">): Promise<Record<string, string>> {
  if (!own.startedAt) throw new Error("the run start time is unknown");
  const out: Record<string, string> = {};
  for (const r of (await c.query(PRIVATE_TABLES_SQL)).rows) {
    const t = String(r.t);
    out[t] = String((await c.query(stableHashSql(t), [own.site, own.baselineMaxChangeId, own.startedAt])).rows[0].h);
  }
  return out;
}

/** Each violation count must be 0: every NEW run-site row belongs to this run's own identities/fixtures. */
export const OWNERSHIP_SQL = `select json_build_object(
  'batches', (select count(*) from reporting_private.batches t where t.site = $1 and t.batch_id <> all($2::uuid[])),
  'generations', (select count(*) from reporting_private.generations t where t.site = $1 and t.generation_id <> all($3::uuid[])),
  'journal', (select count(*) from reporting_private.changes t where (t.old_site = $1 or t.new_site = $1) and t.change_id > $5::bigint
                and not ((t.old_event_id is null or t.old_event_id = any($4::text[])) and (t.new_event_id is null or t.new_event_id = any($4::text[])))),
  'runLog', (select count(*) from reporting_private.worker_runs t where t.site = $1 and t.started_at >= $6::timestamptz and t.batch_id is not null and t.batch_id <> all($2::uuid[])),
  'mirror', (select count(*) from reporting_private.source_current t where t.site = $1 and t.generation_id <> all($3::uuid[])),
  'candidate', (select count(*) from reporting_private.source_candidate t where t.site = $1 and t.batch_id <> all($2::uuid[]))
             + (select count(*) from reporting_private.batch_events t where t.site = $1 and t.batch_id <> all($2::uuid[])),
  'versions', (select count(*) from reporting_private.source_versions t where t.site = $1 and (t.valid_from_seq <> all($7::bigint[]) or (t.valid_to_seq is not null and t.valid_to_seq <> all($7::bigint[])))),
  'facts', (select count(*) from (
       select valid_from_seq f, valid_to_seq v from reporting_private.event_facts where site = $1 union all select valid_from_seq, valid_to_seq from reporting_private.cancel_edges where site = $1
       union all select valid_from_seq, valid_to_seq from reporting_private.order_occurrences where site = $1 union all select valid_from_seq, valid_to_seq from reporting_private.daily_totals where site = $1
       union all select valid_from_seq, valid_to_seq from reporting_private.timing_facts where site = $1 union all select valid_from_seq, valid_to_seq from reporting_private.source_issue_facts where site = $1) x
     where x.f <> all($7::bigint[]) or (x.v is not null and x.v <> all($7::bigint[]))),
  'ownerInputs', (select count(*) from reporting_private.owner_inputs t where t.site = $1 and t.batch_id <> all($2::uuid[])),
  'runLogRows', (select count(*) from reporting_private.worker_runs t where t.site = $1 and t.started_at >= $6::timestamptz)
) as j`;
export const ownershipParams = (own: RuntimeOwnership, seqs: string[]) => [own.site, own.batches, own.generations, own.fixtureIds, own.baselineMaxChangeId, own.startedAt, seqs];

/** The declared site_state allowance (other fields and other sites must be identical). */
export function runtimeAllowance(own: RuntimeOwnership): StateAllowance {
  const n = transitionIncrement(own.captureTransitions);
  return {
    epochIncrement: n,
    controlUpdatedAt: own.captureTransitions.some((t) => t.state === "confirmed"),
    siteFields: ["source_epoch", "active_generation_id", "lease_fence", "lease_expires_at", "heartbeat_at", "last_verified_cutoff", "updated_at"],
    sites: [own.site],
  };
}

export interface AuditInput {
  before: FullState;
  after: FullState;
  stableBefore: Record<string, string>;
  stableAfter: Record<string, string>;
  ownership: Record<string, unknown>;
}
/** Pure: every difference is either declared (and owned) or a problem. */
export function runtimeAuditProblems(own: RuntimeOwnership, a: AuditInput): string[] {
  const p: string[] = [];
  const known = new Set(Object.keys(SITE_ATTRIBUTION));
  const strip = (s: FullState): FullState => ({ ...s, privateTables: Object.fromEntries(Object.entries(s.privateTables).filter(([t]) => !known.has(t))) });
  p.push(...compareFullState(strip(a.before), strip(a.after), runtimeAllowance(own)));
  for (const t of new Set([...Object.keys(a.stableBefore), ...Object.keys(a.stableAfter)])) {
    if (a.stableBefore[t] !== a.stableAfter[t]) p.push(`reporting_private.${t}: rows the run may not change differ (${a.stableBefore[t] ?? "absent"} -> ${a.stableAfter[t] ?? "absent"})`);
  }
  for (const [k, v] of Object.entries(a.ownership)) {
    if (k === "runLogRows") {
      if (Number(v) !== own.invocations.length) p.push(`run log rows at ${own.site} since the start: ${String(v)}, expected exactly ${own.invocations.length} (one per invocation)`);
    } else if (Number(v) !== 0) p.push(`${String(v)} ${k} row(s) at ${own.site} do not belong to this run`);
  }
  const site = a.after.siteState.find((s) => s.site === own.site);
  if (site?.active_batch_id != null) p.push(`${own.site} still has an active batch ${String(site.active_batch_id)}`);
  if (site?.active_generation_id != null && !own.generations.includes(String(site.active_generation_id))) p.push(`${own.site} points at generation ${String(site.active_generation_id)}, not one of this run's`);
  return p;
}

// ---------------------------------------------------------------------------
// Exact publication parity (mirror = source; daily totals = the reducer)
// ---------------------------------------------------------------------------

export const MIRROR_DIFF_SQL = `select
  (select count(*) from (select pe.id, pg_catalog.to_jsonb(pe) from public.production_events pe where pe.location = $1 except select s.event_id, s.image from reporting_private.source_current s where s.site = $1) x)::int as source_not_mirror,
  (select count(*) from (select s.event_id, s.image from reporting_private.source_current s where s.site = $1 except select pe.id, pg_catalog.to_jsonb(pe) from public.production_events pe where pe.location = $1) x)::int as mirror_not_source,
  (select g.source_cutoff::text from reporting_private.site_state st join reporting_private.generations g on g.generation_id = st.active_generation_id where st.site = $1) as cutoff`;
export const MIRROR_IMAGES_SQL = "select s.image from reporting_private.source_current s where s.site = $1";

export const imageEvent = (i: Record<string, unknown>): ProductionEvidenceEvent => ({
  id: String(i.id), location: String(i.location), staff_id: (i.staff_id as string) ?? null, department: (i.department as string) ?? null,
  order_number: (i.order_number as string) ?? null, line_sku: (i.line_sku as string) ?? null, line_quantity: (i.line_quantity as number) ?? null,
  event_type: String(i.event_type), created_at: String(i.created_at), parent_event_id: (i.parent_event_id as string) ?? null, cs_case_id: (i.cs_case_id as string) ?? null,
});

/** The published mirror is exactly the site's source; site and (optionally) one worker's daily totals equal the independent reducer. */
export async function parityProblems(c: Db, site: Site, staff: string | null): Promise<string[]> {
  const d = (await c.query(MIRROR_DIFF_SQL, [site])).rows[0];
  const p: string[] = [];
  if (Number(d.source_not_mirror) || Number(d.mirror_not_source)) p.push(`mirror differs from the source (${String(d.source_not_mirror)} source rows not mirrored, ${String(d.mirror_not_source)} mirror rows not in the source)`);
  if (typeof d.cutoff !== "string") return [...p, `${site} has no published generation`];
  const events = (await c.query(MIRROR_IMAGES_SQL, [site])).rows.map((r) => imageEvent(r.image as Record<string, unknown>));
  for (const who of staff ? [null, staff] : [null]) {
    const got = await sqlDaily(c, site, who);
    const want = reducerDaily(site, events, d.cutoff, who);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      const missing = want.filter((x) => !got.includes(x)).length;
      const extra = got.filter((x) => !want.includes(x)).length;
      p.push(`daily totals (${who ? "self" : "site"}) differ from the reducer: ${missing} missing, ${extra} extra of ${want.length}`);
    }
  }
  return p;
}
