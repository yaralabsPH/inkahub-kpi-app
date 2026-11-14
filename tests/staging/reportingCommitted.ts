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
  activeBatchesAnywhere: number;
  sites: Array<{ site: string; processor: boolean; readMode: string; generation: string | null; activeBatch: string | null; derivedRows: number; batches: number; generations: number; pendingChanges: number }>;
  fixtureCollisions: number;
}

export const PREFLIGHT_SQL = `select json_build_object(
  'installed', exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'publish_reporting_batch'),
  'captureEnabled', (select capture_enabled from reporting_private.control where singleton),
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
// Ownership and cleanup (pure plan, exact scope)
// ---------------------------------------------------------------------------

export interface Ownership {
  runId: string;
  prefix: string;
  sites: [Site, Site];
  fixtureIds: string[];
  /** Original settings to restore. */
  original: { captureEnabled: boolean; sites: Array<{ site: Site; processor: boolean; generation: string | null; sourceEpoch: string | null; lastVerifiedCutoff: string | null }> };
  captureToggles: number;
  batches: string[];
  generations: string[];
  generationSeqs: string[];
}

export function newOwnership(sites: [Site, Site], runId = randomBytes(4).toString("hex")): Ownership {
  return { runId, prefix: `rc-${runId}-`, sites, fixtureIds: [], original: { captureEnabled: false, sites: [] }, captureToggles: 0, batches: [], generations: [], generationSeqs: [] };
}

export interface CleanupStep {
  label: string;
  sql: string;
  params: unknown[];
}

const FACT_TABLES = ["event_facts", "cancel_edges", "order_occurrences", "timing_facts", "source_issue_facts", "daily_totals", "source_versions"] as const;

/**
 * Every statement is scoped to this run's exact sites AND (generation
 * sequences | generation ids | batch ids | fixture ids | change ids collected
 * by id). There is no unscoped delete and no trigger/constraint suppression.
 * `retainBatches` are batches entangled with someone else's journal rows:
 * they and their generations are kept and reported.
 */
export interface CleanupOptions {
  /** Batches entangled with someone else's journal rows: kept, with everything that depends on them. */
  retainBatches?: string[];
  /** Run sites whose site_state names an active batch that is NOT this run's: their metadata is never touched. */
  externalActiveSites?: string[];
}

export function cleanupPlan(own: Ownership, ourChangeIds: string[], opts: CleanupOptions = {}): CleanupStep[] {
  const retain = opts.retainBatches ?? [];
  const external = opts.externalActiveSites ?? [];
  const retaining = retain.length > 0;
  const sites = own.sites;
  const batches = own.batches.filter((b) => !retain.includes(b));
  const steps: CleanupStep[] = [];
  // Derived rows, mirror and retained versions depend on the run's generations. If ANY batch must be retained,
  // all of them (and the generations and site pointers) are kept as evidence: a partial delete would leave a
  // retained generation whose rows were half removed.
  if (!retaining) {
    for (const t of FACT_TABLES) {
      steps.push({ label: `delete this run's ${t} rows`, sql: `delete from reporting_private.${t} where site = any($1::text[]) and valid_from_seq = any($2::bigint[])`, params: [sites, own.generationSeqs] });
    }
    steps.push({ label: "delete this run's mirror rows", sql: "delete from reporting_private.source_current where site = any($1::text[]) and generation_id = any($2::uuid[])", params: [sites, own.generations] });
  }
  for (const s of own.original.sites) {
    if (external.includes(s.site)) continue; // someone else's active batch owns this site's metadata now
    steps.push(
      retaining
        ? { label: `restore ${s.site} processor setting`, sql: "update reporting_private.site_state set processor_enabled = $2 where site = $1", params: [s.site, s.processor] }
        : {
            label: `restore ${s.site} site metadata`,
            sql: "update reporting_private.site_state set processor_enabled = $2, active_generation_id = $3::uuid, source_epoch = $4::bigint, last_verified_cutoff = $5::timestamptz, active_batch_id = null where site = $1 and (active_batch_id is null or active_batch_id = any($6::uuid[]))",
            params: [s.site, s.processor, s.generation, s.sourceEpoch, s.lastVerifiedCutoff, own.batches],
          },
    );
  }
  steps.push({ label: "delete this run's staged results", sql: "delete from reporting_private.partition_results r using reporting_private.partition_work w where w.work_id = r.work_id and w.batch_id = any($1::uuid[])", params: [batches] });
  for (const t of ["partition_work", "batch_events", "batch_changes", "source_candidate"]) {
    steps.push({ label: `delete this run's ${t}`, sql: `delete from reporting_private.${t} where batch_id = any($1::uuid[])`, params: [batches] });
  }
  steps.push({
    label: "delete this run's journal rows (by exact change id, unless a retained batch received them)",
    sql: "delete from reporting_private.changes ch where ch.change_id = any($1::bigint[]) and not exists (select 1 from reporting_private.batch_changes bc where bc.change_id = ch.change_id and bc.batch_id = any($2::uuid[])) and not (ch.batch_id = any($2::uuid[]))",
    params: [ourChangeIds, retain],
  });
  steps.push({ label: "delete this run's batches", sql: "delete from reporting_private.batches where batch_id = any($1::uuid[])", params: [batches] });
  if (!retaining) {
    // Newest first: a generation's base may be an older one of this run.
    for (const g of [...own.generations].reverse()) steps.push({ label: `delete this run's generation ${g}`, sql: "delete from reporting_private.generations where generation_id = $1::uuid and site = any($2::text[])", params: [g, sites] });
  }
  steps.push({ label: "delete this run's source fixtures", sql: "delete from public.production_events where id = any($1::text[]) and location = any($2::text[]) and id like $3", params: [own.fixtureIds, sites, `${own.prefix}%`] });
  return steps;
}

/** The exact audit allowance of a completed committed run: declared epoch increments and the run sites' lease bookkeeping. */
export function committedAllowance(own: Ownership): StateAllowance {
  return { epochIncrement: own.captureToggles, controlUpdatedAt: own.captureToggles > 0, siteFields: ["lease_fence", "lease_expires_at", "heartbeat_at", "updated_at"], sites: [...own.sites] };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

const msgOf = (e: unknown, redact: (s: string) => string) => {
  const code = (e as { code?: string }).code;
  return `${code ? `${code} ` : ""}${redact(e instanceof Error ? e.message : String(e)).slice(0, 240)}`;
};

/** One committed transaction; any failure rolls it back and rethrows (a failed rollback is reported with it). */
async function tx<T>(c: Db, fn: () => Promise<T>): Promise<T> {
  await c.query("begin");
  try {
    const out = await fn();
    await c.query("commit");
    return out;
  } catch (e) {
    try {
      await c.query("rollback");
    } catch (re) {
      throw new Error(`${e instanceof Error ? e.message : String(e)}; rollback also failed: ${re instanceof Error ? re.message : String(re)}`);
    }
    throw e;
  }
}

/**
 * Note (1): SET LOCAL ROLE and the JWT claims only live inside a transaction.
 * Each committed service RPC therefore runs in ITS OWN explicit transaction:
 * begin, become service_role, PROVE current_user and the claims, call, commit.
 * Any failure rolls the transaction back, which also undoes the role/claims,
 * so no role or aborted state leaks into the next statement.
 */
export function serviceCall(as: CommittedCtx["as"]): ServiceCall {
  return (c, sql, params) =>
    tx(c, async () => {
      await as(c, true);
      const who = (await c.query("select current_user as u, current_setting('request.jwt.claims', true) as claims")).rows[0];
      let role: unknown = null;
      try {
        role = JSON.parse(String(who?.claims ?? "null"))?.role;
      } catch {
        role = null;
      }
      if (who?.u !== "service_role" || role !== "service_role") throw new Error(`service RPC is not running as service_role (current_user ${String(who?.u)}, claims role ${String(role)})`);
      return (await c.query(sql, params)).rows;
    });
}

const fxRow = (staff: string, id: string, order: string, at: string) => ({ id, event_type: "line_verified", order_number: order, line_sku: "INKA-KAN0566-A4-FB", line_quantity: 1, created_at: at, parent_event_id: null, department: "framed", staff_id: staff });

export async function runCommitted(ctx: CommittedCtx, own: Ownership, cleanupFailures: string[]): Promise<void> {
  const [A, B] = ctx.sites;
  const fctx = { as: ctx.as, call: serviceCall(ctx.as), maxPages: ctx.maxPages } as unknown as FlowCtx;
  const conns: Conn[] = [];
  const open = async () => {
    const c = await ctx.open();
    conns.push(c);
    return c;
  };
  const check = (id: string, what: string, ok: boolean, result: string) => ctx.record({ id, what, expected: "holds", result, ok, ms: 0 });
  const main = await open();

  // --- Preflight (no commit yet) -------------------------------------------
  const snap = (await main.query(PREFLIGHT_SQL, [[A, B], `${own.prefix}%`])).rows[0].j as PreflightSnapshot;
  const problems = preflightProblems(snap, [A, B]);
  check("C0", "preflight: isolated starting state", problems.length === 0, problems.join("; ") || "isolated");
  if (problems.length) {
    await endAll(conns, cleanupFailures, ctx);
    return;
  }
  const orig = (await main.query("select site, processor_enabled, active_generation_id::text as g, source_epoch::text as e, last_verified_cutoff::text as c from reporting_private.site_state where site = any($1::text[]) order by site", [[A, B]])).rows;
  own.original = { captureEnabled: snap.captureEnabled, sites: orig.map((r) => ({ site: r.site as Site, processor: Boolean(r.processor_enabled), generation: (r.g as string) ?? null, sourceEpoch: (r.e as string) ?? null, lastVerifiedCutoff: (r.c as string) ?? null })) };
  own.fixtureIds = ["low", "high", "b", "c", "m"].map((x) => `${own.prefix}${x}`);
  ctx.save(); // ownership is recorded BEFORE the first commit; a failed write stops here

  let failure: unknown = null;
  try {
    // --- Setup: capture + processors (committed, recorded) -------------------
    await rpc(main, fctx, "select * from public.set_reporting_capture(true)", []);
    await rpc(main, fctx, "update reporting_private.site_state set processor_enabled = true where site = any($1::text[])", [[A, B]]);
    own.captureToggles += own.original.captureEnabled ? 0 : 1;
    ctx.save();
    const own_ = (r: Record<string, unknown>) => {
      own.batches.push(String(r.batch_id));
      ctx.save();
    };
    const published = (r: Record<string, unknown>) => {
      own.generations.push(String(r.generation_id));
      own.generationSeqs.push(String(r.generation_seq));
      ctx.save();
      return r;
    };
    // Zero-work rebuilds give both sites a committed base.
    for (const site of [A, B]) {
      const [b] = await rpc(main, fctx, "select * from public.begin_reporting_rebuild($1)", [site]);
      own_(b);
      await copyAll(main, fctx, String(b.batch_id), Number(b.lease_fence));
      await rpc(main, fctx, "select * from public.freeze_reporting_rebuild($1, $2)", [b.batch_id, b.lease_fence]);
      await rpc(main, fctx, "select * from public.seal_reporting_work($1, $2, 0, $3)", [b.batch_id, b.lease_fence, reportingManifestHash([])]);
      published(await publish(main, fctx, String(b.batch_id), Number(b.lease_fence)));
    }

    /** Freeze (refresh), plan the owners of `ids`, stage, and publish on `c`. */
    const refreshAndPublish = async (c: Db, site: Site, ids: string[], publishOn: Db = c, empties: Owner[] = []) => {
      const [b] = await rpc(c, fctx, "select * from public.begin_reporting_batch($1)", [site]);
      own_(b);
      const cutoff = new Date(String(b.source_cutoff)).toISOString();
      const ev = await frozenEvents(c, String(b.batch_id), ids);
      const planned = plannedFor(site, ev, cutoff, ctx.staff, () => true, empties);
      await planAll(c, fctx, String(b.batch_id), Number(b.lease_fence), planned.map((p) => p.desc));
      await rpc(c, fctx, "select * from public.seal_reporting_work($1, $2, $3, $4)", [b.batch_id, b.lease_fence, planned.length, reportingManifestHash(planned.map((p) => p.desc))]);
      const cl = await claimAll(c, fctx, String(b.batch_id), Number(b.lease_fence));
      await stageAll(c, fctx, String(b.batch_id), Number(b.lease_fence), planned, cl.ids);
      return { batch: b, result: published(await publish(publishOn, fctx, String(b.batch_id), Number(b.lease_fence))) };
    };
    const changeIdOf = async (eventId: string) => String((await main.query("select max(change_id)::text as id from reporting_private.changes where coalesce(new_event_id, old_event_id) = $1", [eventId])).rows[0].id);
    const pendingFor = async (site: Site, changeId: string) => Boolean((await main.query("select exists (select 1 from reporting_private.site_pending_changes($1) p(id) where p.id = $2::bigint) as x", [site, changeId])).rows[0].x);

    // --- A: lower id committed after the freeze --------------------------------
    const w1 = await open();
    await w1.query("begin");
    await insertFixtures(w1, A, [fxRow(ctx.staff, own.fixtureIds[0], `RC-${own.runId}-A`, "2026-01-13T09:00:00Z")]);
    await insertFixtures(main, A, [fxRow(ctx.staff, own.fixtureIds[1], `RC-${own.runId}-A`, "2026-01-13T09:05:00Z")]); // autocommit: higher id, committed
    const [ra] = await rpc(main, fctx, "select * from public.begin_reporting_batch($1)", [A]);
    own_(ra);
    await w1.query("commit"); // the lower id commits only now, after the freeze
    const low = await changeIdOf(own.fixtureIds[0]);
    const high = await changeIdOf(own.fixtureIds[1]);
    const members = ((await main.query("select array_agg(change_id::text order by change_id) as ids from reporting_private.batch_changes where batch_id = $1", [ra.batch_id])).rows[0].ids ?? []) as string[];
    check("A1", "the frozen batch holds the committed higher id and NOT the lower id committed after the freeze", BigInt(low) < BigInt(high) && members.includes(high) && !members.includes(low), `low ${low}, high ${high}, members ${JSON.stringify(members)}`);
    {
      const cutoff = new Date(String(ra.source_cutoff)).toISOString();
      const ev = await frozenEvents(main, String(ra.batch_id), [own.fixtureIds[1]]);
      const planned = plannedFor(A, ev, cutoff, ctx.staff, () => true);
      await planAll(main, fctx, String(ra.batch_id), Number(ra.lease_fence), planned.map((p) => p.desc));
      await rpc(main, fctx, "select * from public.seal_reporting_work($1, $2, $3, $4)", [ra.batch_id, ra.lease_fence, planned.length, reportingManifestHash(planned.map((p) => p.desc))]);
      const cl = await claimAll(main, fctx, String(ra.batch_id), Number(ra.lease_fence));
      await stageAll(main, fctx, String(ra.batch_id), Number(ra.lease_fence), planned, cl.ids);
      published(await publish(main, fctx, String(ra.batch_id), Number(ra.lease_fence)));
    }
    check("A2", "after that publication the lower id is still pending for the site", await pendingFor(A, low), `pending=${await pendingFor(A, low)}`);
    await refreshAndPublish(main, A, [own.fixtureIds[0], own.fixtureIds[1]]);
    const ackLow = Boolean((await main.query("select acknowledged_at is not null as x from reporting_private.changes where change_id = $1::bigint", [low])).rows[0].x);
    check("A3", "a later publication receives and acknowledges the lower id", !(await pendingFor(A, low)) && ackLow, `pending=${await pendingFor(A, low)}, acknowledged=${ackLow}`);

    // --- B: durable takeover from another connection ---------------------------
    await insertFixtures(main, A, [fxRow(ctx.staff, own.fixtureIds[2], `RC-${own.runId}-B`, "2026-01-13T10:00:00Z")]);
    const x = await open();
    const [rb] = await rpc(x, fctx, "select * from public.begin_reporting_batch($1)", [A]);
    own_(rb);
    const oldFence = Number(rb.lease_fence);
    const cutoffB = new Date(String(rb.source_cutoff)).toISOString();
    const plannedB = plannedFor(A, await frozenEvents(x, String(rb.batch_id), [own.fixtureIds[2]]), cutoffB, ctx.staff, () => true);
    await planAll(x, fctx, String(rb.batch_id), oldFence, plannedB.map((p) => p.desc));
    await rpc(x, fctx, "select * from public.seal_reporting_work($1, $2, $3, $4)", [rb.batch_id, oldFence, plannedB.length, reportingManifestHash(plannedB.map((p) => p.desc))]);
    await claimAll(x, fctx, String(rb.batch_id), oldFence);
    await x.end(); // the worker disappears
    conns.splice(conns.indexOf(x), 1);
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
    const pb = published(await publish(y, fctx, String(rb.batch_id), newFence));
    check("B3", "the new worker completes and publishes the taken-over batch", pb.replay === false, `generation ${String(pb.generation_seq)}`);

    // --- C: committed publication, lost response, replay ------------------------
    await insertFixtures(main, A, [fxRow(ctx.staff, own.fixtureIds[3], `RC-${own.runId}-C`, "2026-01-13T11:00:00Z")]);
    const z = await open();
    const { batch: rc, result: pc } = await refreshAndPublish(main, A, [own.fixtureIds[3]], z); // committed on z; its response is treated as lost
    await z.end();
    conns.splice(conns.indexOf(z), 1);
    const credit = async () => (await main.query("select (select count(*) from reporting_private.event_facts where site = $1 and valid_from_seq = $2::bigint)::int as f, (select count(*) from reporting_private.daily_totals where site = $1 and valid_from_seq = $2::bigint)::int as d, (select count(*) from reporting_private.generations where site = $1)::int as g", [A, pc.generation_seq])).rows[0];
    const before = await credit();
    const [replay] = await rpc(main, fctx, "select * from public.publish_reporting_batch($1, $2)", [rc.batch_id, rc.lease_fence]);
    const after = await credit();
    check("C1", "the retry after a lost response replays the SAME generation", replay.replay === true && replay.generation_id === pc.generation_id, `replay=${String(replay.replay)}, generation ${String(replay.generation_id)} vs ${String(pc.generation_id)}`);
    check("C2", "no duplicate credit and no new generation after the replay", JSON.stringify(before) === JSON.stringify(after) && Number(before.f) > 0, `before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);

    // --- D: controlled committed shared-site move ------------------------------
    const mId = own.fixtureIds[4];
    await insertFixtures(main, A, [fxRow(ctx.staff, mId, `RC-${own.runId}-M`, "2026-01-13T12:00:00Z")]);
    await refreshAndPublish(main, A, [mId]);
    await main.query("update public.production_events set location = $2 where location = $1 and id = $3", [A, B, mId]); // the move (autocommit; this run's row)
    const move = String((await main.query("select max(change_id)::text as id from reporting_private.changes where old_event_id = $1 and old_site = $2 and new_site = $3", [mId, A, B])).rows[0].id);
    check("D0", "the move is one journal row touching both sites", move !== "null", `change ${move}`);
    const pa = await open();
    const pbConn = await open();
    const [da, db] = await Promise.all([
      refreshAndPublish(pa, A, [mId], pa, [{ partitionKind: "order", partitionKey: `RC-${own.runId}-M` }]).then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e })),
      refreshAndPublish(pbConn, B, [mId]).then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e })),
    ]);
    check("D1", "both sites publish their receipts concurrently", da.ok && db.ok, `${A}: ${da.ok ? "published" : msgOf(da.e, ctx.redact)}; ${B}: ${db.ok ? "published" : msgOf(db.e, ctx.redact)}`);
    const acked = async () => Boolean((await main.query("select acknowledged_at is not null as x from reporting_private.changes where change_id = $1::bigint", [move])).rows[0].x);
    let deferred = false;
    if (!(await acked())) {
      // The allowed deferred pass: begin (runs the acknowledgement pass) + a no-change publication.
      deferred = true;
      const [nb] = await rpc(main, fctx, "select * from public.begin_reporting_batch($1)", [A]);
      own_(nb);
      await rpc(main, fctx, "select * from public.seal_reporting_work($1, $2, 0, $3)", [nb.batch_id, nb.lease_fence, reportingManifestHash([])]);
      published(await publish(main, fctx, String(nb.batch_id), Number(nb.lease_fence)));
    }
    const done = await acked();
    check("D2", "the shared move is globally acknowledged after both receipts (at most one deferred pass)", done, `acknowledged=${done}; deferred pass used=${deferred}`);
    const where = (await main.query("select (select count(*) from reporting_private.event_facts where site = $1 and event_id = $3 and valid_to_seq is null)::int as at_old, (select count(*) from reporting_private.event_facts where site = $2 and event_id = $3 and valid_to_seq is null)::int as at_new", [A, B, mId])).rows[0];
    check("D3", "the moved event's facts are current only at the new site (old owner emptied)", Number(where.at_old) === 0 && Number(where.at_new) > 0, JSON.stringify(where));
  } catch (e) {
    failure = e;
  } finally {
    await cleanup(main, ctx, own, cleanupFailures);
    await endAll(conns, cleanupFailures, ctx);
  }
  if (failure) throw failure;
}

async function endAll(conns: Conn[], cleanupFailures: string[], ctx: Pick<CommittedCtx, "redact">): Promise<void> {
  for (const c of conns.splice(0)) {
    // With no open transaction ROLLBACK only warns, so a rejection here is unexpected: keep it even if end() succeeds.
    await c.query("rollback").catch((e) => cleanupFailures.push(`rollback: ${msgOf(e, ctx.redact)}`));
    await c.end().catch((e) => cleanupFailures.push(`disconnect: ${msgOf(e, ctx.redact)}`));
  }
}

/**
 * Always runs. Order: abandon this run's unfinished batches, restore capture
 * (committed; recorded as an expected epoch increment), detect external
 * journal rows, then the exact-scope delete plan. Every failure is kept.
 */
export async function cleanup(c: Db, ctx: Pick<CommittedCtx, "as" | "redact" | "save">, own: Ownership, cleanupFailures: string[]): Promise<void> {
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      cleanupFailures.push(`${label}: ${msgOf(e, ctx.redact)}`);
      await c.query("rollback").catch((re) => cleanupFailures.push(`${label}: rollback: ${msgOf(re, ctx.redact)}`));
    }
  };
  const fctx = { as: ctx.as, call: serviceCall(ctx.as) } as unknown as FlowCtx;
  await c.query("rollback").catch((e) => cleanupFailures.push(`cleanup start rollback: ${msgOf(e, ctx.redact)}`));
  for (const b of own.batches) {
    await step(`abandon unfinished batch ${b}`, async () => {
      const r = (await c.query("select state, lease_fence from reporting_private.batches where batch_id = $1", [b])).rows[0];
      if (!r || !["active", "frozen", "publishing"].includes(String(r.state))) return;
      await c.query("update reporting_private.batches set lease_expires_at = now() - interval '1 second' where batch_id = $1", [b]);
      await rpc(c, fctx, "select * from public.abandon_reporting_batch($1, $2, $3)", [b, r.lease_fence, "committed harness cleanup"]);
    });
  }
  if (!own.original.captureEnabled) {
    await step("restore capture off", async () => {
      const r = (await c.query("select capture_enabled from reporting_private.control where singleton")).rows[0];
      if (r?.capture_enabled) {
        await rpc(c, fctx, "select * from public.set_reporting_capture(false)", []);
        own.captureToggles += 1;
      }
    });
  }
  // Journal rows: this run's fixtures only; anything else that touched the run's sites while capture was on is EXTERNAL.
  let ourChangeIds: string[] = [];
  let retain: string[] = [];
  await step("classify journal rows", async () => {
    ourChangeIds = (await c.query("select coalesce(array_agg(change_id::text), '{}') as ids from reporting_private.changes where coalesce(new_event_id, old_event_id) like $1 and (new_event_id is null or new_event_id like $1) and (old_event_id is null or old_event_id like $1)", [`${own.prefix}%`])).rows[0].ids as string[];
    const ext = (await c.query(
      `select coalesce(array_agg(distinct b.batch_id::text), '{}') as batches, count(*)::int as n from reporting_private.changes ch
         left join reporting_private.batch_changes bc on bc.change_id = ch.change_id
         left join reporting_private.batches b on b.batch_id = coalesce(bc.batch_id, ch.batch_id)
        where (ch.old_site = any($1::text[]) or ch.new_site = any($1::text[])) and not (ch.change_id = any($2::bigint[]))
          and (b.batch_id = any($3::uuid[]) or (ch.acknowledged_at is null and ch.captured_at >= (select min(created_at) from reporting_private.batches where batch_id = any($3::uuid[]))))`,
      [own.sites, ourChangeIds, own.batches],
    )).rows[0];
    if (Number(ext.n) > 0) {
      retain = (ext.batches as string[]).filter((x) => x);
      cleanupFailures.push(`external journal rows touched the run's sites during the run (${ext.n}); they and batches [${retain.join(", ")}] are RETAINED, not cleaned`);
    }
  });
  let externalActiveSites: string[] = [];
  await step("detect external active batches", async () => {
    const r = await c.query("select site from reporting_private.site_state where site = any($1::text[]) and active_batch_id is not null and not (active_batch_id = any($2::uuid[]))", [own.sites, own.batches]);
    externalActiveSites = r.rows.map((x) => String(x.site));
    if (externalActiveSites.length) cleanupFailures.push(`sites [${externalActiveSites.join(", ")}] have an active batch that is not this run's; their metadata is left untouched`);
  });
  if (retain.length) cleanupFailures.push(`retaining every derived row, generation and site pointer of this run because batches [${retain.join(", ")}] are entangled with external journal rows`);
  for (const s of cleanupPlan(own, ourChangeIds, { retainBatches: retain, externalActiveSites })) await step(s.label, () => c.query(s.sql, s.params));
  try {
    ctx.save();
  } catch (e) {
    cleanupFailures.push(`report persistence during cleanup: ${msgOf(e, ctx.redact)}`);
  }
}
