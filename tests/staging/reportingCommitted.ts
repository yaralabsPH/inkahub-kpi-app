/**
 * Task 13 Part B2b — the bounded INSTALLED-COMMIT harness (plan: "Approved
 * bounded installed-commit harness"). PREPARED, NOT RUN: it is executed only
 * after independent review, on staging ybrzhrgfrnvtcwymjdrq (every query is
 * target-guarded), with the reviewed 0038 installed:
 *
 *   npm run staging:reporting-jobs -- --committed-interleavings --sites=A,B [--max-pages=N]
 *
 * It proves the cases that need COMMITTED state (the rollback-only modes
 * cannot):
 *   A  a lower change id, uncommitted while a higher id commits and freezes,
 *      commits later and stays pending until a later publication receives it;
 *   B  a committed active batch survives its worker's disconnect and is taken
 *      over from another connection; the old fence is refused;
 *   C  a committed publication whose response is "lost" replays the same
 *      generation with no duplicate credit;
 *   D  a controlled committed shared-site move: both sites publish
 *      concurrently, and the change is globally acknowledged (directly, or by
 *      at most one deferred acknowledgement pass, which is recorded).
 *
 * Isolation and cleanup (all enforced here):
 *   - preflight refuses unless capture is OFF, no batch is active anywhere,
 *     both sites are legacy/processor-off with NO published generation and
 *     NO derived/mirror/journal state, and the run-unique fixture ids collide
 *     with nothing; nothing is committed before the baseline and the
 *     ownership record are saved;
 *   - fixtures are run-unique source rows (rc-<run>-*) with no stock effect;
 *     no pre-existing source row, membership, stock item, journal row, batch
 *     or generation is ever updated or deleted;
 *   - the only committed settings are capture on/off (each change advances
 *     the epoch; the expected increments are reported, never reset) and the
 *     two processors (restored); lease fences only move forward;
 *   - cleanup ALWAYS runs, in dependency order, deleting only rows this run
 *     owns (exact ids or this run's generation sequences); an external change
 *     that touched the run's sites is detected and RETAINED (reported), never
 *     cleaned; every failure is kept; every session is ended; a fresh full
 *     audit (payloads, stock, ledger, memberships, catalog/ACL, all private
 *     rows) then allows ONLY the declared epoch/lease differences.
 */
import { randomBytes } from "node:crypto";
import { reportingManifestHash } from "../../api/_lib/reporting-stage";
import type { Owner } from "../fixtures/reporting-rows";
import {
  claimAll,
  copyAll,
  frozenEvents,
  insertFixtures,
  planAll,
  plannedFor,
  publish,
  rpc,
  stageAll,
  type Db,
  type FlowCtx,
  type Observation,
  type ServiceCall,
  type Site,
  type StateAllowance,
} from "./reportingPublication";

export type Conn = Db & { end(): Promise<void> };

export interface CommittedCtx {
  sites: [Site, Site];
  staff: string;
  maxPages: number;
  open(): Promise<Conn>;
  as(c: Db, service: boolean): Promise<void>;
  record(o: Observation): void;
  /** Persist the report (throws on failure: work stops before the next commit). */
  save(): void;
  redact(s: string): string;
  now(): number;
}

// ---------------------------------------------------------------------------
// Preflight (pure check over a queried snapshot)
// ---------------------------------------------------------------------------

export interface PreflightSnapshot {
  installed: boolean;
  captureEnabled: boolean;
  captureEpoch: string;
  activeBatchesAnywhere: number;
  sites: Array<{ site: string; processor: boolean; readMode: string; generation: string | null; activeBatch: string | null; derivedRows: number; batches: number; generations: number; pendingChanges: number }>;
  fixtureCollisions: number;
}

export const PREFLIGHT_SQL = `select json_build_object(
  'installed', exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'publish_reporting_batch'),
  'captureEnabled', (select capture_enabled from reporting_private.control where singleton),
  'captureEpoch', (select capture_epoch::text from reporting_private.control where singleton),
  'activeBatchesAnywhere', (select count(*) from reporting_private.batches where state in ('active', 'frozen', 'publishing')),
  'sites', (select json_agg(json_build_object('site', s.site, 'processor', s.processor_enabled, 'readMode', s.read_mode, 'generation', s.active_generation_id, 'activeBatch', s.active_batch_id,
      'derivedRows', (select count(*) from reporting_private.event_facts f where f.site = s.site) + (select count(*) from reporting_private.cancel_edges f where f.site = s.site)
        + (select count(*) from reporting_private.order_occurrences f where f.site = s.site) + (select count(*) from reporting_private.timing_facts f where f.site = s.site)
        + (select count(*) from reporting_private.source_issue_facts f where f.site = s.site) + (select count(*) from reporting_private.daily_totals f where f.site = s.site)
        + (select count(*) from reporting_private.source_current f where f.site = s.site) + (select count(*) from reporting_private.source_versions f where f.site = s.site)
        + (select count(*) from reporting_private.source_candidate f where f.site = s.site) + (select count(*) from reporting_private.batch_events f where f.site = s.site),
      'batches', (select count(*) from reporting_private.batches b where b.site = s.site),
      'generations', (select count(*) from reporting_private.generations g where g.site = s.site),
      'pendingChanges', (select count(*) from reporting_private.changes c where c.acknowledged_at is null and (c.old_site = s.site or c.new_site = s.site))) order by s.site)
     from reporting_private.site_state s where s.site = any($1::text[])),
  'fixtureCollisions', (select count(*) from public.production_events where id like $2)
) as j`;

export function preflightProblems(p: PreflightSnapshot, sites: readonly string[]): string[] {
  const out: string[] = [];
  if (!p.installed) out.push("0038 is not installed (publish_reporting_batch is missing)");
  if (p.captureEnabled) out.push("capture is enabled; the harness needs it OFF at the start so that no unrelated journal row joins the run");
  if (p.activeBatchesAnywhere > 0) out.push(`${p.activeBatchesAnywhere} reporting batch(es) are active; refuse to run beside another job`);
  for (const site of sites) {
    const s = p.sites.find((x) => x.site === site);
    if (!s) {
      out.push(`site_state for ${site} is missing`);
      continue;
    }
    if (s.processor) out.push(`${site}: processor is already enabled`);
    if (s.readMode !== "legacy") out.push(`${site}: read_mode is ${s.readMode}, not legacy`);
    if (s.generation) out.push(`${site}: a published generation exists; refuse rather than discard it`);
    if (s.activeBatch) out.push(`${site}: an active batch is recorded`);
    if (s.derivedRows > 0) out.push(`${site}: ${s.derivedRows} derived/mirror rows exist; an isolated restore is impossible`);
    if (s.batches > 0 || s.generations > 0) out.push(`${site}: ${s.batches} batch(es) and ${s.generations} generation(s) exist; an isolated restore is impossible`);
    if (s.pendingChanges > 0) out.push(`${site}: ${s.pendingChanges} unacknowledged journal row(s) exist`);
  }
  if (p.fixtureCollisions > 0) out.push(`${p.fixtureCollisions} source row(s) already use this run's fixture prefix`);
  return out;
}

// ---------------------------------------------------------------------------
// Ownership (exact identities; tentative before COMMIT)
// ---------------------------------------------------------------------------

/** One identity returned to this run by a service RPC. */
export interface Identity {
  kind: "batch" | "generation";
  id: string;
  seq: string | null;
  /**
   * tentative: recorded (and persisted) inside the RPC's transaction, BEFORE its commit;
   * confirmed: the commit succeeded, or a fresh connection found it;
   * absent: rolled back, or a fresh connection proved it does not exist;
   * uncertain: the commit outcome could not be resolved (cleanup then retains everything).
   */
  state: "tentative" | "confirmed" | "absent" | "uncertain";
  /**
   * When the COMMIT outcome was uncertain: the originating backend and whether it has been seen GONE.
   * Absence may only be concluded after settled = true (a still-pending commit is not absence).
   */
  origin?: { pid: number; settled: boolean };
}

export interface CaptureTransition {
  enable: boolean;
  before: string;
  after: string;
  /** tentative: persisted before COMMIT; confirmed: committed; absent: rolled back; uncertain: the COMMIT outcome is unknown. */
  state: "tentative" | "confirmed" | "absent" | "uncertain";
}

export interface Ownership {
  runId: string;
  prefix: string;
  sites: [Site, Site];
  /** Exact fixture source ids (journal rows are matched by these, never by a prefix). */
  fixtureIds: string[];
  original: { captureEnabled: boolean; captureEpoch: string; sites: Array<{ site: Site; processor: boolean; generation: string | null; sourceEpoch: string | null; lastVerifiedCutoff: string | null }> };
  /**
   * This run's OWN capture transitions: the control row is locked FOR UPDATE, its epoch read, the
   * transition made, and the before/after receipt persisted BEFORE COMMIT. Only confirmed receipts
   * count toward the audit's expected epoch increment; an observed delta is never trusted.
   */
  captureTransitions: CaptureTransition[];
  identities: Identity[];
  /** True once a transaction that may commit has started; before that, cleanup is never invoked. */
  committedAnything: boolean;
}

export function newOwnership(sites: [Site, Site], runId = randomBytes(4).toString("hex")): Ownership {
  return { runId, prefix: `rc-${runId}-`, sites, fixtureIds: [], original: { captureEnabled: false, captureEpoch: "0", sites: [] }, captureTransitions: [], identities: [], committedAnything: false };
}

export const confirmed = (own: Ownership, kind: Identity["kind"]) => own.identities.filter((i) => i.kind === kind && i.state === "confirmed");
const knownIds = (own: Ownership, kind: Identity["kind"]) => own.identities.filter((i) => i.kind === kind && i.state !== "absent").map((i) => i.id);

/** Identities a service RPC returned: a begun batch, or a (new) published generation. */
export function noteIdentities(own: Ownership, sql: string, rows: Array<Record<string, unknown>>): Identity[] {
  const added: Identity[] = [];
  const add = (kind: Identity["kind"], id: string, seq: string | null) => {
    if (own.identities.some((i) => i.kind === kind && i.id === id)) return; // a replay returns a known identity
    const x: Identity = { kind, id, seq, state: "tentative" };
    own.identities.push(x);
    added.push(x);
  };
  for (const r of rows) {
    if (/public\.begin_reporting_(batch|rebuild)\(/.test(sql) && typeof r.batch_id === "string") {
      // A REUSED batch (an expired active batch returned by begin) is only acceptable when this run already owns it.
      if (r.reused === true && !own.identities.some((i) => i.kind === "batch" && i.id === r.batch_id && i.state !== "absent")) {
        throw new Error(`begin returned a reused batch ${r.batch_id} that this run does not own; refusing to adopt it`);
      }
      add("batch", r.batch_id, null);
    }
    if (/public\.publish_reporting_batch\(/.test(sql) && typeof r.generation_id === "string") add("generation", r.generation_id, r.generation_seq == null ? null : String(r.generation_seq));
  }
  return added;
}

/**
 * T13B2b-15: the begin RPCs' own lock order, taken in the SAME transaction
 * before the RPC runs: control FOR SHARE, then the site's row FOR UPDATE, then
 * the site's live batches FOR UPDATE. The locks are held through the RPC and
 * COMMIT, so nothing can change between this check and its use.
 */
export const BEGIN_GUARD_SQL = {
  control: "select c.capture_epoch::text as e from reporting_private.control c where c.singleton for share",
  site: "select s.active_batch_id::text as b from reporting_private.site_state s where s.site = $1 for update",
  batches: "select b.batch_id::text as b, b.state from reporting_private.batches b where b.site = $1 and b.state in ('active', 'frozen', 'publishing') order by b.batch_id for update",
} as const;

/**
 * T13B2b-15: refuse BEFORE begin_reporting_batch / begin_reporting_rebuild when
 * the site has a live batch (or an active pointer) this run does not own. Either
 * RPC may otherwise mark an unknown epoch-drifted batch failed, clear the
 * pointer and return a NEW id, so checking only the returned `reused` flag
 * cannot protect foreign state. On refusal the caller rolls back: the external
 * batch, its state and the site's pointer are left exactly as they were.
 */
export async function guardBeginOwnership(c: Db, own: Ownership, site: unknown): Promise<void> {
  if (typeof site !== "string") throw new Error("begin guard: the site argument is missing");
  const ctl = await c.query(BEGIN_GUARD_SQL.control);
  if (ctl.rows.length !== 1) throw new Error("begin guard: the reporting control row is missing; refusing to begin");
  const st = await c.query(BEGIN_GUARD_SQL.site, [site]);
  if (st.rows.length !== 1) throw new Error(`begin guard: site_state for ${site} is missing; refusing to begin`);
  const live = (await c.query(BEGIN_GUARD_SQL.batches, [site])).rows.map((r) => String(r.b));
  const pointer = st.rows[0].b == null ? [] : [String(st.rows[0].b)];
  const mine = new Set(knownIds(own, "batch"));
  const foreign = [...new Set([...pointer, ...live])].filter((b) => !mine.has(b));
  if (foreign.length) {
    throw new Error(`begin guard: ${site} has live batch(es) this run does not own [${foreign.join(", ")}]; refusing to begin so the RPC cannot invalidate or replace them`);
  }
}

/** EXPECTED epoch increments: only this run's own CONFIRMED capture transitions (after − before). */
export function expectedEpochIncrement(own: Ownership): number {
  return own.captureTransitions.filter((t) => t.state === "confirmed").reduce((n, t) => n + Number(BigInt(t.after) - BigInt(t.before)), 0);
}

/**
 * The exact audit allowance of a committed run: its EXPECTED epoch increments
 * (never an observed delta, so an unexplained or external toggle still fails
 * the audit, and an uncertain transition adds nothing) and the run sites'
 * lease bookkeeping.
 */
export function committedAllowance(own: Ownership): StateAllowance {
  const n = expectedEpochIncrement(own);
  return { epochIncrement: n, controlUpdatedAt: n > 0 || own.captureTransitions.some((t) => t.state === "confirmed"), siteFields: ["lease_fence", "lease_expires_at", "heartbeat_at", "updated_at"], sites: [...own.sites] };
}

// ---------------------------------------------------------------------------
// Cleanup decision (pure) over a locked discovery
// ---------------------------------------------------------------------------

export interface CleanupStep {
  label: string;
  sql: string;
  params: unknown[];
}

/** What cleanup discovered INSIDE its locked transaction. */
export interface Discovery {
  /** Capture is confirmed OFF (read under the control share lock). */
  captureOff: boolean;
  /** Journal rows of this run: both sides null or one of the exact fixture ids. */
  ourChangeIds: string[];
  /** Journal rows that touch the run's sites, were captured after the run enabled capture, and are not this run's. */
  externalJournal: number;
  /** Batches / generations at the run's sites that this run does not know. */
  externalBatches: string[];
  externalGenerations: string[];
  /** Current site pointers of the run's sites. */
  sites: Array<{ site: string; activeGeneration: string | null; activeBatch: string | null }>;
}

const FACT_TABLES = ["event_facts", "cancel_edges", "order_occurrences", "timing_facts", "source_issue_facts", "daily_totals", "source_versions"] as const;

/**
 * Fails closed: a failed discovery (null), any external or unknown
 * dependency, or any uncertain identity RETAINS every derived row,
 * generation, batch, journal row, site pointer and fixture, and touches no
 * site metadata that is not this run's. Otherwise every statement is scoped to
 * the run's sites AND its exact confirmed identities / fixture ids.
 */
export function cleanupDecision(own: Ownership, d: Discovery | null): { retainAll: boolean; reasons: string[]; steps: CleanupStep[] } {
  const reasons: string[] = [];
  const batches = confirmed(own, "batch").map((i) => i.id);
  const gens = confirmed(own, "generation");
  if (!d) reasons.push("dependency discovery failed");
  const unresolved = own.identities.filter((i) => i.state === "tentative" || i.state === "uncertain");
  if (unresolved.length) reasons.push(`commit outcome of [${unresolved.map((i) => `${i.kind} ${i.id}`).join(", ")}] is uncertain`);
  if (d) {
    if (d.externalJournal > 0) reasons.push(`${d.externalJournal} external journal row(s) touched the run's sites`);
    if (d.externalBatches.length) reasons.push(`external batches [${d.externalBatches.join(", ")}] exist at the run's sites`);
    if (d.externalGenerations.length) reasons.push(`external generations [${d.externalGenerations.join(", ")}] exist at the run's sites`);
    for (const s of d.sites) {
      if (s.activeBatch && !batches.includes(s.activeBatch)) reasons.push(`${s.site} has an active batch ${s.activeBatch} that is not this run's`);
      if (s.activeGeneration && !gens.some((g) => g.id === s.activeGeneration)) reasons.push(`${s.site} points at generation ${s.activeGeneration} that is not this run's`);
    }
  }
  const retainAll = reasons.length > 0;
  const steps: CleanupStep[] = [];
  const sites = own.sites;
  if (retainAll) {
    // Only this run's own processor setting, and only where the site has no foreign batch.
    for (const s of own.original.sites) {
      const cur = d?.sites.find((x) => x.site === s.site);
      if (!d || !cur || (cur.activeBatch && !batches.includes(cur.activeBatch))) continue;
      steps.push({ label: `restore ${s.site} processor setting`, sql: "update reporting_private.site_state set processor_enabled = $2 where site = $1 and (active_batch_id is null or active_batch_id = any($3::uuid[]))", params: [s.site, s.processor, batches] });
    }
    return { retainAll, reasons, steps };
  }
  const seqs = gens.map((g) => g.seq).filter((s): s is string => s !== null);
  for (const t of FACT_TABLES) steps.push({ label: `delete this run's ${t} rows`, sql: `delete from reporting_private.${t} where site = any($1::text[]) and valid_from_seq = any($2::bigint[])`, params: [sites, seqs] });
  steps.push({ label: "delete this run's mirror rows", sql: "delete from reporting_private.source_current where site = any($1::text[]) and generation_id = any($2::uuid[])", params: [sites, gens.map((g) => g.id)] });
  for (const s of own.original.sites) {
    steps.push({
      label: `restore ${s.site} site metadata`,
      sql: "update reporting_private.site_state set processor_enabled = $2, active_generation_id = $3::uuid, source_epoch = $4::bigint, last_verified_cutoff = $5::timestamptz, active_batch_id = null where site = $1 and (active_batch_id is null or active_batch_id = any($6::uuid[])) and (active_generation_id is null or active_generation_id = any($7::uuid[]))",
      params: [s.site, s.processor, s.generation, s.sourceEpoch, s.lastVerifiedCutoff, batches, gens.map((g) => g.id)],
    });
  }
  steps.push({ label: "delete this run's staged results", sql: "delete from reporting_private.partition_results r using reporting_private.partition_work w where w.work_id = r.work_id and w.batch_id = any($1::uuid[])", params: [batches] });
  for (const t of ["partition_work", "batch_events", "batch_changes", "source_candidate"]) steps.push({ label: `delete this run's ${t}`, sql: `delete from reporting_private.${t} where batch_id = any($1::uuid[])`, params: [batches] });
  steps.push({ label: "delete this run's journal rows (exact change ids)", sql: "delete from reporting_private.changes where change_id = any($1::bigint[])", params: [d!.ourChangeIds] });
  steps.push({ label: "delete this run's batches", sql: "delete from reporting_private.batches where batch_id = any($1::uuid[])", params: [batches] });
  for (const g of [...gens].reverse()) steps.push({ label: `delete this run's generation ${g.id}`, sql: "delete from reporting_private.generations where generation_id = $1::uuid and site = any($2::text[])", params: [g.id, sites] });
  if (d!.captureOff) {
    steps.push({ label: "delete this run's source fixtures (exact ids)", sql: "delete from public.production_events where id = any($1::text[]) and location = any($2::text[])", params: [own.fixtureIds, sites] });
  }
  return { retainAll, reasons: d!.captureOff ? [] : ["capture is not confirmed off: fixture source rows are kept"], steps };
}

/** Discovery queries (run inside cleanup's locked transaction). */
export const DISCOVERY = {
  capture: "select capture_enabled from reporting_private.control where singleton",
  ourChanges:
    "select coalesce(array_agg(change_id::text order by change_id), '{}') as ids from reporting_private.changes where (new_event_id = any($1::text[]) or old_event_id = any($1::text[])) and (new_event_id is null or new_event_id = any($1::text[])) and (old_event_id is null or old_event_id = any($1::text[]))",
  externalJournal: "select count(*)::int as n from reporting_private.changes where (old_site = any($1::text[]) or new_site = any($1::text[])) and capture_epoch > $2::bigint and not (change_id = any($3::bigint[]))",
  externalBatches: "select coalesce(array_agg(batch_id::text), '{}') as ids from reporting_private.batches where site = any($1::text[]) and not (batch_id = any($2::uuid[]))",
  externalGenerations: "select coalesce(array_agg(generation_id::text), '{}') as ids from reporting_private.generations where site = any($1::text[]) and not (generation_id = any($2::uuid[]))",
  sites: "select site, active_generation_id::text as g, active_batch_id::text as b from reporting_private.site_state where site = any($1::text[]) order by site for update",
};

// ---------------------------------------------------------------------------
// Execution helpers
// ---------------------------------------------------------------------------

const msgOf = (e: unknown, redact: (s: string) => string) => {
  const code = (e as { code?: string }).code;
  return `${code ? `${code} ` : ""}${redact(e instanceof Error ? e.message : String(e)).slice(0, 240)}`;
};

/** One committed owner-role transaction; any failure rolls it back and rethrows (a failed rollback is reported with it). */
async function tx<T>(c: Db, fn: () => Promise<T>): Promise<T> {
  await c.query("begin");
  try {
    const out = await fn();
    await c.query("commit");
    return out;
  } catch (e) {
    await rollbackOrJoin(c, e);
    throw e;
  }
}
async function rollbackOrJoin(c: Db, e: unknown): Promise<void> {
  try {
    await c.query("rollback");
  } catch (re) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}; rollback also failed: ${re instanceof Error ? re.message : String(re)}`);
  }
}

async function proveServiceRole(c: Db): Promise<void> {
  const who = (await c.query("select current_user as u, current_setting('request.jwt.claims', true) as claims")).rows[0];
  let role: unknown = null;
  try {
    role = JSON.parse(String(who?.claims ?? "null"))?.role;
  } catch {
    role = null;
  }
  if (who?.u !== "service_role" || role !== "service_role") throw new Error(`service RPC is not running as service_role (current_user ${String(who?.u)}, claims role ${String(role)})`);
}

/**
 * One committed service RPC in ITS OWN explicit transaction: begin, become
 * service_role, PROVE current_user and the claims, call. Identities the call
 * returns are recorded as TENTATIVE and persisted BEFORE COMMIT (a failed save
 * rolls back: nothing is committed without its ownership). After a successful
 * commit they are confirmed. If the COMMIT itself fails, the outcome is
 * uncertain: only those exact identities are resolved on a fresh guarded
 * connection (confirmed / absent / uncertain). Any failure rolls back, which
 * also undoes the role and claims.
 */
export function ownedCall(ctx: Pick<CommittedCtx, "as" | "save" | "open" | "redact"> & { sleep?: (ms: number) => Promise<void> }, own: Ownership, failures: string[]): ServiceCall {
  return async (c, sql, params) => {
    own.committedAnything = true;
    await c.query("begin");
    let added: Identity[] = [];
    let receipt: CaptureTransition | null = null;
    let rows: Array<Record<string, unknown>>;
    let pid = 0;
    try {
      pid = Number((await c.query("select pg_backend_pid() as p")).rows[0]?.p ?? 0);
      await ctx.as(c, true);
      await proveServiceRole(c);
      const capture = /public\.set_reporting_capture\(/.test(sql);
      let before = "";
      if (capture) {
        // The same transaction-local lock cap the RPC applies (at most 3 s, a stricter existing limit kept), BEFORE the prelock.
        const lockMs = Number((await c.query("select setting::bigint as ms from pg_catalog.pg_settings where name = 'lock_timeout'")).rows[0]?.ms ?? 0);
        if (lockMs === 0 || lockMs > 3000) await c.query("select set_config('lock_timeout', '3s', true)");
        // Lock the control row FIRST: no other transition can interleave between this read and this run's own.
        before = String((await c.query("select capture_epoch::text as e from reporting_private.control where singleton for update")).rows[0].e);
      }
      // T13B2b-15: foreign live batches are refused under the RPC's own locks, BEFORE it can invalidate them.
      if (/public\.begin_reporting_(batch|rebuild)\(/.test(sql)) await guardBeginOwnership(c, own, params[0]);
      rows = (await c.query(sql, params)).rows;
      added = noteIdentities(own, sql, rows);
      if (capture) {
        receipt = { enable: params[0] === true || /set_reporting_capture\(true\)/.test(sql), before, after: String(rows[0]?.capture_epoch), state: "tentative" };
        own.captureTransitions.push(receipt);
      }
      if (added.length || receipt) ctx.save(); // ownership and the transition receipt persisted BEFORE commit
    } catch (e) {
      for (const a of added) a.state = "absent";
      if (receipt) receipt.state = "absent";
      await rollbackOrJoin(c, e);
      throw e;
    }
    try {
      await c.query("commit");
    } catch (e) {
      // Uncertain COMMIT: settle/close the ORIGINATING session and see its backend gone before any absence is concluded.
      const gone = await settleOrigin(c, pid, ctx, failures);
      if (receipt) {
        receipt.state = "uncertain";
        failures.push(`capture transition ${receipt.before} -> ${receipt.after} has an uncertain commit; it is NOT added to the expected epoch`);
      }
      for (const a of added) a.origin = { pid, settled: gone };
      if (gone) await resolveIdentities(ctx, added, failures);
      else {
        for (const a of added) a.state = "uncertain";
        failures.push(`originating session ${pid} is still present; [${added.map((a) => a.id).join(", ")}] stay uncertain`);
      }
      throw e;
    }
    for (const a of added) a.state = "confirmed";
    if (receipt) receipt.state = "confirmed";
    if (added.length || receipt) ctx.save();
    return rows;
  };
}

/** End the session whose COMMIT failed, then wait (bounded) until its backend is gone, checked on a fresh guarded connection. */
export async function settleOrigin(c: Db, pid: number, ctx: Pick<CommittedCtx, "open" | "redact"> & { sleep?: (ms: number) => Promise<void> }, failures: string[]): Promise<boolean> {
  const end = (c as Partial<Conn>).end;
  if (end) await end.call(c).catch((e: unknown) => failures.push(`originating session disconnect: ${msgOf(e, ctx.redact)}`));
  if (!pid) return false;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let f: Conn | null = null;
  try {
    f = await ctx.open();
    for (let i = 0; i < 25; i++) {
      const alive = (await f.query("select exists (select 1 from pg_catalog.pg_stat_activity where pid = $1) as x", [pid])).rows[0]?.x === true;
      if (!alive) return true;
      await sleep(200);
    }
    return false;
  } catch (e) {
    failures.push(`could not check the originating session ${pid}: ${msgOf(e, ctx.redact)}`);
    return false;
  } finally {
    if (f) await f.end().catch((e) => failures.push(`origin check disconnect: ${msgOf(e, ctx.redact)}`));
  }
}

/**
 * Resolve ONLY the given identities on a fresh guarded connection. An identity
 * whose COMMIT was uncertain carries its originating backend: absence is
 * concluded only after that backend is seen GONE (bounded wait); while it is
 * present the identity stays uncertain. This holds on every path (the call
 * itself and cleanup's later retry).
 */
export async function resolveIdentities(ctx: Pick<CommittedCtx, "open" | "redact"> & { sleep?: (ms: number) => Promise<void> }, ids: Identity[], failures: string[]): Promise<void> {
  if (!ids.length) return;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let c: Conn | null = null;
  try {
    c = await ctx.open();
    for (const i of ids) {
      if (i.origin && !i.origin.settled) {
        let gone = false;
        for (let k = 0; k < 25 && !gone; k++) {
          gone = (await c.query("select exists (select 1 from pg_catalog.pg_stat_activity where pid = $1) as x", [i.origin.pid])).rows[0]?.x !== true;
          if (!gone) await sleep(200);
        }
        if (!gone) {
          i.state = "uncertain";
          failures.push(`originating session ${i.origin.pid} of ${i.kind} ${i.id} is still present; it stays uncertain`);
          continue;
        }
        i.origin.settled = true;
      }
      const sql = i.kind === "batch" ? "select exists (select 1 from reporting_private.batches where batch_id = $1::uuid) as x" : "select exists (select 1 from reporting_private.generations where generation_id = $1::uuid) as x";
      i.state = (await c.query(sql, [i.id])).rows[0]?.x === true ? "confirmed" : "absent";
    }
  } catch (e) {
    for (const i of ids) if (i.state === "tentative") i.state = "uncertain";
    failures.push(`could not resolve the commit outcome of [${ids.map((i) => i.id).join(", ")}]: ${msgOf(e, ctx.redact)}`);
  } finally {
    if (c) await c.end().catch((e) => failures.push(`resolution disconnect: ${msgOf(e, ctx.redact)}`));
  }
}

/** Roll back and end one session; every failure is kept (ROLLBACK with no open transaction only warns). */
async function settle(c: Conn, label: string, failures: string[], redact: (s: string) => string): Promise<void> {
  await c.query("rollback").catch((e) => failures.push(`${label} rollback: ${msgOf(e, redact)}`));
  await c.end().catch((e) => failures.push(`${label} disconnect: ${msgOf(e, redact)}`));
}

export const fxRow = (staff: string, id: string, order: string, at: string) => ({ id, event_type: "line_verified", order_number: order, line_sku: "INKA-KAN0566-A4-FB", line_quantity: 1, created_at: at, parent_event_id: null, department: "framed", staff_id: staff });

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runCommitted(ctx: CommittedCtx, own: Ownership, cleanupFailures: string[]): Promise<void> {
  const [A, B] = ctx.sites;
  const call = ownedCall(ctx, own, cleanupFailures);
  const fctx = { as: ctx.as, call, maxPages: ctx.maxPages } as unknown as FlowCtx;
  const secondary: Conn[] = [];
  let main: Conn | null = null;
  const open = async () => {
    const c = await ctx.open();
    secondary.push(c);
    return c;
  };
  const closeOne = async (c: Conn, label: string) => {
    secondary.splice(secondary.indexOf(c), 1);
    await c.end().catch((e) => cleanupFailures.push(`${label} disconnect: ${msgOf(e, ctx.redact)}`));
  };
  const check = (id: string, what: string, ok: boolean, result: string) => ctx.record({ id, what, expected: "holds", result, ok, ms: 0 });
  let failure: unknown = null;
  try {
    main = await ctx.open();
    // --- Preflight (nothing committed; failures here never trigger destructive cleanup) ---
    const snap = (await main.query(PREFLIGHT_SQL, [[A, B], `${own.prefix}%`])).rows[0].j as PreflightSnapshot;
    const problems = preflightProblems(snap, [A, B]);
    check("C0", "preflight: isolated starting state", problems.length === 0, problems.join("; ") || "isolated");
    if (problems.length) return;
    const orig = (await main.query("select site, processor_enabled, active_generation_id::text as g, source_epoch::text as e, last_verified_cutoff::text as c from reporting_private.site_state where site = any($1::text[]) order by site", [[A, B]])).rows;
    own.original = {
      captureEnabled: snap.captureEnabled,
      captureEpoch: String(snap.captureEpoch),
      sites: orig.map((r) => ({ site: r.site as Site, processor: Boolean(r.processor_enabled), generation: (r.g as string) ?? null, sourceEpoch: (r.e as string) ?? null, lastVerifiedCutoff: (r.c as string) ?? null })),
    };
    own.fixtureIds = ["low", "high", "b", "c", "m"].map((x) => `${own.prefix}${x}`);
    ctx.save(); // ownership is recorded BEFORE the first commit; a failed write stops here (finally still closes every session)

    // --- Setup: capture (its locked receipt is confirmed by the commit, BEFORE processor setup), then processors ---
    await rpc(main, fctx, "select * from public.set_reporting_capture($1)", [true]);
    await rpc(main, fctx, "update reporting_private.site_state set processor_enabled = true where site = any($1::text[])", [[A, B]]);

    // Zero-work rebuilds give both sites a committed base.
    for (const site of [A, B]) {
      const [b] = await rpc(main!, fctx, "select * from public.begin_reporting_rebuild($1)", [site]);
      await copyAll(main!, fctx, String(b.batch_id), Number(b.lease_fence));
      await rpc(main!, fctx, "select * from public.freeze_reporting_rebuild($1, $2)", [b.batch_id, b.lease_fence]);
      await rpc(main!, fctx, "select * from public.seal_reporting_work($1, $2, 0, $3)", [b.batch_id, b.lease_fence, reportingManifestHash([])]);
      (await publish(main!, fctx, String(b.batch_id), Number(b.lease_fence)));
    }

    /** Freeze (refresh), plan the owners of `ids`, stage, and publish on `c`. */
    const refreshAndPublish = async (c: Db, site: Site, ids: string[], publishOn: Db = c, empties: Owner[] = []) => {
      const [b] = await rpc(c, fctx, "select * from public.begin_reporting_batch($1)", [site]);
      const cutoff = new Date(String(b.source_cutoff)).toISOString();
      const ev = await frozenEvents(c, String(b.batch_id), ids);
      const planned = plannedFor(site, ev, cutoff, ctx.staff, () => true, empties);
      await planAll(c, fctx, String(b.batch_id), Number(b.lease_fence), planned.map((p) => p.desc));
      await rpc(c, fctx, "select * from public.seal_reporting_work($1, $2, $3, $4)", [b.batch_id, b.lease_fence, planned.length, reportingManifestHash(planned.map((p) => p.desc))]);
      const cl = await claimAll(c, fctx, String(b.batch_id), Number(b.lease_fence));
      await stageAll(c, fctx, String(b.batch_id), Number(b.lease_fence), planned, cl.ids);
      return { batch: b, result: (await publish(publishOn, fctx, String(b.batch_id), Number(b.lease_fence))) };
    };
    const changeIdOf = async (eventId: string) => String((await main!.query("select max(change_id)::text as id from reporting_private.changes where coalesce(new_event_id, old_event_id) = $1", [eventId])).rows[0].id);
    const pendingFor = async (site: Site, changeId: string) => Boolean((await main!.query("select exists (select 1 from reporting_private.site_pending_changes($1) p(id) where p.id = $2::bigint) as x", [site, changeId])).rows[0].x);

    // --- A: lower id committed after the freeze --------------------------------
    const w1 = await open();
    await w1.query("begin");
    await insertFixtures(w1, A, [fxRow(ctx.staff, own.fixtureIds[0], `RC-${own.runId}-A`, "2026-01-13T09:00:00Z")]);
    await insertFixtures(main, A, [fxRow(ctx.staff, own.fixtureIds[1], `RC-${own.runId}-A`, "2026-01-13T09:05:00Z")]); // autocommit: higher id, committed
    const [ra] = await rpc(main!, fctx, "select * from public.begin_reporting_batch($1)", [A]);
    await w1.query("commit"); // the lower id commits only now, after the freeze
    const low = await changeIdOf(own.fixtureIds[0]);
    const high = await changeIdOf(own.fixtureIds[1]);
    const members = ((await main!.query("select array_agg(change_id::text order by change_id) as ids from reporting_private.batch_changes where batch_id = $1", [ra.batch_id])).rows[0].ids ?? []) as string[];
    check("A1", "the frozen batch holds the committed higher id and NOT the lower id committed after the freeze", BigInt(low) < BigInt(high) && members.includes(high) && !members.includes(low), `low ${low}, high ${high}, members ${JSON.stringify(members)}`);
    {
      const cutoff = new Date(String(ra.source_cutoff)).toISOString();
      const ev = await frozenEvents(main, String(ra.batch_id), [own.fixtureIds[1]]);
      const planned = plannedFor(A, ev, cutoff, ctx.staff, () => true);
      await planAll(main!, fctx, String(ra.batch_id), Number(ra.lease_fence), planned.map((p) => p.desc));
      await rpc(main!, fctx, "select * from public.seal_reporting_work($1, $2, $3, $4)", [ra.batch_id, ra.lease_fence, planned.length, reportingManifestHash(planned.map((p) => p.desc))]);
      const cl = await claimAll(main!, fctx, String(ra.batch_id), Number(ra.lease_fence));
      await stageAll(main!, fctx, String(ra.batch_id), Number(ra.lease_fence), planned, cl.ids);
      (await publish(main!, fctx, String(ra.batch_id), Number(ra.lease_fence)));
    }
    check("A2", "after that publication the lower id is still pending for the site", await pendingFor(A, low), `pending=${await pendingFor(A, low)}`);
    await refreshAndPublish(main, A, [own.fixtureIds[0], own.fixtureIds[1]]);
    const ackLow = Boolean((await main!.query("select acknowledged_at is not null as x from reporting_private.changes where change_id = $1::bigint", [low])).rows[0].x);
    check("A3", "a later publication receives and acknowledges the lower id", !(await pendingFor(A, low)) && ackLow, `pending=${await pendingFor(A, low)}, acknowledged=${ackLow}`);

    // --- B: durable takeover from another connection ---------------------------
    await insertFixtures(main, A, [fxRow(ctx.staff, own.fixtureIds[2], `RC-${own.runId}-B`, "2026-01-13T10:00:00Z")]);
    const x = await open();
    const [rb] = await rpc(x, fctx, "select * from public.begin_reporting_batch($1)", [A]);
    const oldFence = Number(rb.lease_fence);
    const cutoffB = new Date(String(rb.source_cutoff)).toISOString();
    const plannedB = plannedFor(A, await frozenEvents(x, String(rb.batch_id), [own.fixtureIds[2]]), cutoffB, ctx.staff, () => true);
    await planAll(x, fctx, String(rb.batch_id), oldFence, plannedB.map((p) => p.desc));
    await rpc(x, fctx, "select * from public.seal_reporting_work($1, $2, $3, $4)", [rb.batch_id, oldFence, plannedB.length, reportingManifestHash(plannedB.map((p) => p.desc))]);
    await claimAll(x, fctx, String(rb.batch_id), oldFence);
    await closeOne(x, "case B worker"); // the worker disappears
    const y = await open();
    const survived = (await y.query("select state, lease_fence::text as f from reporting_private.batches where batch_id = $1", [rb.batch_id])).rows[0];
    check("B1", "the committed batch survives its worker's disconnect", survived?.state === "frozen" && survived?.f === String(oldFence), JSON.stringify(survived));
    // Bounded: shift ONLY this run's batch lease into the past (committed; this run owns the batch).
    await tx(y, async () => {
      await y.query("update reporting_private.batches set lease_expires_at = now() - interval '1 second' where batch_id = $1", [rb.batch_id]);
      await y.query("update reporting_private.site_state set lease_expires_at = now() - interval '1 second' where site = $1 and active_batch_id = $2", [A, rb.batch_id]);
    });
    const [rs] = await rpc(y, fctx, "select * from public.resume_reporting_batch($1, $2)", [rb.batch_id, oldFence]);
    const newFence = Number(rs.lease_fence);
    const refusedOld = async (sql: string, params: unknown[]) => rpc(y, fctx, sql, params).then(() => "accepted", (e) => msgOf(e, ctx.redact));
    const oldClaim = await refusedOld("select * from public.claim_reporting_work($1, $2, 10)", [rb.batch_id, oldFence]);
    const oldPublish = await refusedOld("select * from public.publish_reporting_batch($1, $2)", [rb.batch_id, oldFence]);
    check("B2", "after the durable takeover the old fence is refused (claim and publish)", newFence > oldFence && /obsolete/.test(oldClaim) && /obsolete/.test(oldPublish), `new fence ${newFence}; old claim: ${oldClaim}; old publish: ${oldPublish}`);
    const clB = await claimAll(y, fctx, String(rb.batch_id), newFence);
    await stageAll(y, fctx, String(rb.batch_id), newFence, plannedB, clB.ids);
    const pb = (await publish(y, fctx, String(rb.batch_id), newFence));
    check("B3", "the new worker completes and publishes the taken-over batch", pb.replay === false, `generation ${String(pb.generation_seq)}`);

    // --- C: committed publication, lost response, replay ------------------------
    await insertFixtures(main, A, [fxRow(ctx.staff, own.fixtureIds[3], `RC-${own.runId}-C`, "2026-01-13T11:00:00Z")]);
    const z = await open();
    const { batch: rc, result: pc } = await refreshAndPublish(main, A, [own.fixtureIds[3]], z); // committed on z; its response is treated as lost
    await closeOne(z, "case C publisher");
    const credit = async () => (await main!.query("select (select count(*) from reporting_private.event_facts where site = $1 and valid_from_seq = $2::bigint)::int as f, (select count(*) from reporting_private.daily_totals where site = $1 and valid_from_seq = $2::bigint)::int as d, (select count(*) from reporting_private.generations where site = $1)::int as g", [A, pc.generation_seq])).rows[0];
    const before = await credit();
    const [replay] = await rpc(main!, fctx, "select * from public.publish_reporting_batch($1, $2)", [rc.batch_id, rc.lease_fence]);
    const after = await credit();
    check("C1", "the retry after a lost response replays the SAME generation", replay.replay === true && replay.generation_id === pc.generation_id, `replay=${String(replay.replay)}, generation ${String(replay.generation_id)} vs ${String(pc.generation_id)}`);
    check("C2", "no duplicate credit and no new generation after the replay", JSON.stringify(before) === JSON.stringify(after) && Number(before.f) > 0, `before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);

    // --- D: controlled committed shared-site move ------------------------------
    const mId = own.fixtureIds[4];
    await insertFixtures(main, A, [fxRow(ctx.staff, mId, `RC-${own.runId}-M`, "2026-01-13T12:00:00Z")]);
    await refreshAndPublish(main, A, [mId]);
    await main!.query("update public.production_events set location = $2 where location = $1 and id = $3", [A, B, mId]); // the move (autocommit; this run's row)
    const move = String((await main!.query("select max(change_id)::text as id from reporting_private.changes where old_event_id = $1 and old_site = $2 and new_site = $3", [mId, A, B])).rows[0].id);
    check("D0", "the move is one journal row touching both sites", move !== "null", `change ${move}`);
    const pa = await open();
    const pbConn = await open();
    const [da, db] = await Promise.all([
      refreshAndPublish(pa, A, [mId], pa, [{ partitionKind: "order", partitionKey: `RC-${own.runId}-M` }]).then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e })),
      refreshAndPublish(pbConn, B, [mId]).then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e })),
    ]);
    check("D1", "both sites publish their receipts concurrently", da.ok && db.ok, `${A}: ${da.ok ? "published" : msgOf(da.e, ctx.redact)}; ${B}: ${db.ok ? "published" : msgOf(db.e, ctx.redact)}`);
    const acked = async () => Boolean((await main!.query("select acknowledged_at is not null as x from reporting_private.changes where change_id = $1::bigint", [move])).rows[0].x);
    let deferred = false;
    if (!(await acked())) {
      // The allowed deferred pass: begin (runs the acknowledgement pass) + a no-change publication.
      deferred = true;
      const [nb] = await rpc(main!, fctx, "select * from public.begin_reporting_batch($1)", [A]);
      await rpc(main!, fctx, "select * from public.seal_reporting_work($1, $2, 0, $3)", [nb.batch_id, nb.lease_fence, reportingManifestHash([])]);
      (await publish(main!, fctx, String(nb.batch_id), Number(nb.lease_fence)));
    }
    const done = await acked();
    check("D2", "the shared move is globally acknowledged after both receipts (at most one deferred pass)", done, `acknowledged=${done}; deferred pass used=${deferred}`);
    const where = (await main!.query("select (select count(*) from reporting_private.event_facts where site = $1 and event_id = $3 and valid_to_seq is null)::int as at_old, (select count(*) from reporting_private.event_facts where site = $2 and event_id = $3 and valid_to_seq is null)::int as at_new", [A, B, mId])).rows[0];
    check("D3", "the moved event's facts are current only at the new site (old owner emptied)", Number(where.at_old) === 0 && Number(where.at_new) > 0, JSON.stringify(where));
  } catch (e) {
    failure = e;
  } finally {
    // 1. Settle every secondary session FIRST: an open writer would hold the control SHARE lock and make capture-off time out.
    for (const c of secondary.splice(0)) await settle(c, "secondary session", cleanupFailures, ctx.redact);
    // 2. Destructive cleanup only if this run may have committed something.
    if (own.committedAnything) {
      let c: Conn | null = main;
      if (c) {
        try {
          await c.query("rollback");
        } catch (e) {
          cleanupFailures.push(`main session rollback: ${msgOf(e, ctx.redact)}; cleanup uses a fresh session`);
          await c.end().catch((x) => cleanupFailures.push(`main session disconnect: ${msgOf(x, ctx.redact)}`));
          main = null;
          c = null;
        }
      }
      try {
        if (!c) {
          c = await ctx.open();
          main = c;
        }
        await cleanup(c, ctx, own, cleanupFailures);
      } catch (e) {
        cleanupFailures.push(`cleanup could not run: ${msgOf(e, ctx.redact)}`);
      }
    }
    // 3. Close the main session whatever happened.
    if (main) await settle(main, "main session", cleanupFailures, ctx.redact);
  }
  if (failure) throw failure;
}

/**
 * Always runs once something may have been committed:
 *   1. resolve any identity whose commit outcome is still open;
 *   2. abandon this run's unfinished batches (each its own proven transaction);
 *   3. restore capture OFF; account the epoch from the observed value;
 *   4. ONE transaction: control share lock + the run sites' rows FOR UPDATE,
 *      discovery, decision, every delete; any failure rolls ALL of it back
 *      (nothing half-deleted) and is kept. Discovery failure or any external /
 *      uncertain dependency retains everything.
 */
export async function cleanup(c: Conn, ctx: Pick<CommittedCtx, "as" | "redact" | "save" | "open">, own: Ownership, cleanupFailures: string[]): Promise<void> {
  const call = ownedCall(ctx, own, cleanupFailures);
  const fctx = { as: ctx.as, call } as unknown as FlowCtx;
  await resolveIdentities(ctx, own.identities.filter((i) => i.state === "tentative" || i.state === "uncertain"), cleanupFailures);
  for (const b of confirmed(own, "batch").map((i) => i.id)) {
    try {
      const r = (await c.query("select state, lease_fence from reporting_private.batches where batch_id = $1", [b])).rows[0];
      if (!r || !["active", "frozen", "publishing"].includes(String(r.state))) continue;
      await tx(c, () => c.query("update reporting_private.batches set lease_expires_at = now() - interval '1 second' where batch_id = $1", [b]));
      await rpc(c, fctx, "select * from public.abandon_reporting_batch($1, $2, $3)", [b, r.lease_fence, "committed harness cleanup"]);
    } catch (e) {
      cleanupFailures.push(`abandon unfinished batch ${b}: ${msgOf(e, ctx.redact)}`);
    }
  }
  if (!own.original.captureEnabled) {
    try {
      const r = (await c.query("select capture_enabled from reporting_private.control where singleton")).rows[0];
      if (r?.capture_enabled) await rpc(c, fctx, "select * from public.set_reporting_capture($1)", [false]);
    } catch (e) {
      cleanupFailures.push(`restore capture off: ${msgOf(e, ctx.redact)}`);
    }
  }
  // The locked, all-or-nothing discovery + delete.
  let decided: ReturnType<typeof cleanupDecision> | null = null;
  try {
    await c.query("begin");
    await c.query("select 1 from reporting_private.control where singleton for share");
    let d: Discovery | null = null;
    try {
      const siteRows = (await c.query(DISCOVERY.sites, [own.sites])).rows;
      const ours = ((await c.query(DISCOVERY.ourChanges, [own.fixtureIds])).rows[0].ids ?? []) as string[];
      d = {
        captureOff: (await c.query(DISCOVERY.capture)).rows[0]?.capture_enabled === false,
        ourChangeIds: ours,
        externalJournal: Number((await c.query(DISCOVERY.externalJournal, [own.sites, own.original.captureEpoch, ours])).rows[0].n),
        externalBatches: ((await c.query(DISCOVERY.externalBatches, [own.sites, knownIds(own, "batch")])).rows[0].ids ?? []) as string[],
        externalGenerations: ((await c.query(DISCOVERY.externalGenerations, [own.sites, knownIds(own, "generation")])).rows[0].ids ?? []) as string[],
        sites: siteRows.map((r) => ({ site: String(r.site), activeGeneration: (r.g as string) ?? null, activeBatch: (r.b as string) ?? null })),
      };
    } catch (e) {
      cleanupFailures.push(`dependency discovery failed; everything is retained: ${msgOf(e, ctx.redact)}`);
      await rollbackOrJoin(c, e).catch((x) => cleanupFailures.push(`discovery rollback: ${msgOf(x, ctx.redact)}`));
      await c.query("begin");
      d = null;
    }
    decided = cleanupDecision(own, d);
    for (const r of decided.reasons) cleanupFailures.push(`${decided.retainAll ? "retained" : "kept"}: ${r}`);
    for (const s of decided.steps) await c.query(s.sql, s.params);
    await c.query("commit");
  } catch (e) {
    cleanupFailures.push(`cleanup transaction failed and was rolled back (nothing deleted): ${msgOf(e, ctx.redact)}`);
    await c.query("rollback").catch((x) => cleanupFailures.push(`cleanup rollback: ${msgOf(x, ctx.redact)}`));
  }
  try {
    ctx.save();
  } catch (e) {
    cleanupFailures.push(`report persistence during cleanup: ${msgOf(e, ctx.redact)}`);
  }
}
