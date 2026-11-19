/**
 * Task 15: the protected scheduled reporting worker (one site per invocation).
 *
 *   runReportingCycle({site, mode: 'refresh'|'rebuild'|'cleanup', deadlineMs})
 *
 * One active batch per site. A live lease elsewhere returns `busy` without
 * work; an expired one is taken over (resume: new fence; leased work returns to
 * pending). Every phase is DURABLE and resumable within its batch/fence:
 *
 *   copy       (rebuild) bounded candidate pages; cursor saved by the database
 *   enumerate  refresh: changed keys in keyset order; each key's dependency
 *              closure (old/new owners, parents, inverse children, timing
 *              successors) is a resumable walk (walkChangedKey) checkpointed
 *              after every bounded source page, with each seed's DISTINCT
 *              consumed ids in durable storage (0043 save_reporting_walk); the
 *              outer cursor advances only when the key is complete. Rebuild:
 *              owner keysets. A crash replays at most the in-flight page.
 *   plan       one owner at a time: materialize every required audience
 *              (incl. old self audiences) and save its descriptors + planned
 *              mark atomically
 *   seal       only after verify_reporting_plan's exact per-owner proof; the
 *              count/hash come from a bounded traversal of the saved descriptors
 *   stage      claim bounded work, re-materialize each claimed owner from the
 *              frozen view (input hash must match), stage ≤1 MiB chunks
 *   publish    the existing atomic publication (replay-safe)
 *
 * The invocation stops taking new units at its deadline (default 240 s of the
 * 300 s function), renews the 360 s lease every 30 s, and returns `pending`.
 * Transient database/network failures are retried after 30/60/120 s only
 * while the remaining budget allows, then deferred to the next tick. Permanent
 * failures (partition_too_large, conflicting/malformed work, drift) stay
 * failed and visible; nothing is auto-abandoned or deleted. No whole-batch
 * arrays (materializeBatch/affectedOwners) are used here. Results carry ids,
 * counts and redacted problems only — never source payloads or keys.
 */
import { exactInstant } from "../../src/lib/domain/productionCounts.js";
import { ACTIVATION_LIMITS, activationWatch, coalescingChildren, isoOfMicros, KEY_WALK_PAGES, materializeOwnerGroup, ownerDescriptors, ownerKey, PartitionTooLargeError, routedOwnerInput, sharedChildren, walkChangedKey, type CertainBound, type FrozenReader, type KeyWalkPages, type MaterializeStats, type Owner, type OwnerInput, type OwnerJournalSnapshot, type StreamPosition } from "./production-reporting-materialize.js";
import { imageToEvent, rpcEnumerationPages, rpcFrozenReader, type EnumerationPages, type FrozenBatchRef, type FrozenReaderPages } from "./production-reporting-reader.js";
import { beginReportingBatch, beginReportingRebuild, copyReportingSourcePage, freezeReportingRebuild, getReportingJobStatus, renewReportingLease, ReportingJobError, resumeReportingBatch, type ReportingSite, type RpcClient } from "./reporting-jobs.js";
import { publishReportingBatch } from "./reporting-publish.js";
import { buildChunks, claimReportingWork, compareUtf8, packStageRequests, stageReportingResults, type StageEntry, type WorkDescriptor } from "./reporting-stage.js";
import { checkpointOwnerInput, cleanupHistory, hashOwnerInputStep, listWorkerOwners, lookupOwnerInputs, manifestFromSaved, openOwnerInput, OWNER_INPUT_VERSION, ownerInputVersion, ownerJournal, ownerJournalSnapshot, planOwner, readWalkLine, readWorkerProgress, recordRun, reloadOwnerInput, saveEnumeration, saveWalk, sealWithManifest, verifyPlan, type EnumCursor, type OwnerDiscovery, type OwnerInputHeader } from "./reporting-worker-state.js";

export const WORKER_BUDGET_MS = 240_000;
export const HEARTBEAT_MS = 30_000;
export const RETRY_DELAYS_MS = [30_000, 60_000, 120_000] as const;
export const PLAN_PAGE = 100;
export const CLAIM_PAGE = 100;
/** Owners materialized concurrently in plan/stage: bounds memory (at most this many owner inputs, each <= 50,000 events). */
export const OWNER_GROUP = 8;

export type CycleMode = "refresh" | "rebuild" | "cleanup";
export type CycleState = "published" | "pending" | "busy" | "idle" | "failed" | "done";
export interface CycleResult {
  site: ReportingSite;
  mode: CycleMode;
  state: CycleState;
  batchId: string | null;
  generationId: string | null;
  failureKind: string | null;
  counts: Record<string, number>;
  /** Redacted problems (no payloads, keys or tokens). */
  problems: string[];
  durationMs: number;
}

export interface WorkerEnv {
  client: RpcClient;
  /** Milliseconds (wall clock). */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Frozen reads for a batch (default: the 0040/0041 RPCs). */
  /** Test source. `pageGuard` is the worker's per-RPC budget/heartbeat guard; a source should await it before each page it reads. */
  source?: (ref: FrozenBatchRef, pageGuard?: () => Promise<void>) => { reader: FrozenReader; pages: EnumerationPages };
  /** Resumable-walk page sizes (tests use small pages; default KEY_WALK_PAGES). */
  walkPages?: KeyWalkPages;
  /** Redaction for problem text (default: strip anything that looks like a secret). */
  redact?: (s: string) => string;
  /** Owners materialized together in plan/stage (default OWNER_GROUP; 1 = one at a time). */
  ownerGroup?: number;
  /** T15P-4d step 4: the CPU clock in ms (default: this process's user+system CPU, which excludes I/O waits and sleeps). */
  cpuNow?: () => number;
  /** T15P-4d step 4: observes every durable-unit admission (tests; never changes the verdict). */
  onAdmission?: (a: AdmissionRecord) => void;
}
/** One admission decision, as the worker derived it. */
export interface AdmissionRecord { owner: Owner; unit: "read" | "commit" | "hash"; path: AdmissionPath; nowMs: number; remainingMs: number; sinceBeatMs: number; budgetMs: number; verdict: AdmissionVerdict["verdict"]; /** What the worker did with it: one authoritative decision. */ action: "run" | "park" | "fail" }

const TRANSIENT_CODES = new Set(["57014", "55P03", "40001", "40P01", "53300", "57P01", "08000", "08001", "08003", "08006"]);
/** A transient failure may succeed on retry; everything else is permanent for this batch. */
export function isTransient(e: unknown): boolean {
  if (e instanceof PartitionTooLargeError) return false;
  if (/partition_too_large/i.test(e instanceof Error ? e.message : String(e))) return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  const m = e instanceof Error ? e.message : String(e);
  return /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|network error|\b50[234]\b|statement timeout|could not serialize|deadlock detected/i.test(m);
}
/** A short, stable failure kind for the run log and metadata. */
const OWNER_INPUT_KINDS = new Set(["owner_input_unsupported", "owner_input_too_heavy", "owner_input_capacity", "owner_input_purpose"]);
export function failureKind(e: unknown): string {
  if (e instanceof PartitionTooLargeError) return "partition_too_large";
  const ownerCode = (e as { code?: unknown } | null)?.code;
  if (typeof ownerCode === "string" && OWNER_INPUT_KINDS.has(ownerCode)) return ownerCode;
  const m = e instanceof Error ? e.message : String(e);
  if (/partition_too_large/i.test(m)) return "partition_too_large";
  if (/no continuous published base|a rebuild is required/i.test(m)) return "rebuild_required";
  if (/no longer valid|cannot be resumed: /i.test(m)) return "invalidated";
  if (/fence .* is obsolete/i.test(m)) return "fence_obsolete";
  if (/lease expired/i.test(m)) return "lease_expired";
  if (/conflicting descriptor|input hash/i.test(m)) return "conflicting_work";
  if (/processor is disabled/i.test(m)) return "processor_disabled";
  if (/capture is disabled|capture must be enabled/i.test(m)) return "capture_disabled";
  if (isTransient(e)) return "transient";
  return "error";
}
const defaultRedact = (s: string) => s.replace(/(Bearer\s+)\S+/gi, "$1[redacted]").replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[jwt]").replace(/\b(sk|key|secret|token)[=:]\s*\S+/gi, "$1=[redacted]").slice(0, 300);

class Deferred extends Error {
  constructor(readonly cause: unknown) {
    super("deferred to the next cycle");
  }
}
class OutOfTime extends Error {}
/** A durable owner that fits a fresh run but not the time left now: parked first, continued by the next invocation. */
class Parked extends OutOfTime {}

/** One invocation's clock, budget, heartbeat and bounded retries. */
class Budget {
  private lastBeat: number;
  constructor(private readonly env: WorkerEnv, private readonly deadline: number, readonly budgetMs: number) {
    this.lastBeat = env.now();
  }
  /** Milliseconds since the last lease renewal (or since the invocation started). */
  sinceBeat(): number {
    return Math.max(0, this.env.now() - this.lastBeat);
  }
  /** Milliseconds left before this invocation's deadline (never negative). */
  remainingMs(): number {
    return Math.max(0, this.deadline - this.env.now());
  }
  hasTime(): boolean {
    return this.env.now() < this.deadline;
  }
  need(): void {
    if (!this.hasTime()) throw new OutOfTime();
  }
  private beating: Promise<void> | null = null;
  /** Renew when 30 s have passed; single-flight, so concurrently materialized owners never send duplicate renewals. */
  async beat(batchId: string, fence: number): Promise<void> {
    if (this.beating) return this.beating;
    if (this.env.now() - this.lastBeat < HEARTBEAT_MS) return;
    this.beating = (async () => {
      try {
        await this.retry(() => renewReportingLease(this.env.client, batchId, fence));
        this.lastBeat = this.env.now();
      } finally {
        this.beating = null;
      }
    })();
    return this.beating;
  }
  /** Retry a transient failure after 30/60/120 s while the budget allows; otherwise defer to the next tick. */
  async retry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!isTransient(e)) throw e;
        const wait = RETRY_DELAYS_MS[attempt];
        if (wait === undefined || this.env.now() + wait >= this.deadline) throw new Deferred(e);
        await this.env.sleep(wait);
      }
    }
  }
}

interface ActiveBatch { batchId: string; fence: number; kind: "refresh" | "rebuild"; state: string; cutoff: string | null; copyAfter: string | null }

const canonicalInstant = (s: string): string => {
  const us = exactInstant(s);
  if (us === null) throw new ReportingJobError("the frozen cutoff is not an exact instant");
  return isoOfMicros(us);
};

/** A frozen reader whose every read first awaits `guard` (budget check + due heartbeat). Results are untouched. */
export function guardedReader(r: FrozenReader, guard: () => Promise<void>): FrozenReader {
  const it = <T>(f: () => AsyncIterable<T>): AsyncIterable<T> =>
    (async function* () {
      await guard();
      yield* f();
    })();
  return {
    ...r,
    changedKeys: () => it(() => r.changedKeys()),
    owners: () => it(() => r.owners()),
    children: (ids) => it(() => r.children(ids)),
    members: async (owners, cap) => (await guard(), r.members(owners, cap)),
    byIds: async (ids) => (await guard(), r.byIds(ids)),
    childPage: async (p, after, limit) => (await guard(), r.childPage(p, after, limit)),
    stream: async (staff, direction, from, limit) => (await guard(), r.stream(staff, direction, from, limit)),
    ...(r.predecessorPage ? { predecessorPage: async (staff: string, from: StreamPosition, certain: CertainBound | null, limit: number) => (await guard(), r.predecessorPage!(staff, from, certain, limit)) } : {}),
  };
}

/** Take over the site's active batch, or start one for `mode`; null = busy. */
async function acquire(env: WorkerEnv, b: Budget, site: ReportingSite, mode: "refresh" | "rebuild", counts: Record<string, number>): Promise<ActiveBatch | null> {
  const status = await b.retry(() => getReportingJobStatus(env.client, site));
  counts.pendingChanges = status.pendingChanges;
  if (!status.processorEnabled) throw new ReportingJobError(`reporting processor is disabled for ${site}`);
  if (status.activeBatchId) {
    try {
      const r = await b.retry(() => resumeReportingBatch(env.client, status.activeBatchId!, status.leaseFence));
      counts.returnedWork = r.returnedWork;
      return { batchId: r.batchId, fence: r.leaseFence, kind: r.kind, state: r.state, cutoff: r.sourceCutoffUtc, copyAfter: r.rebuildProgress?.afterEventId ?? null };
    } catch (e) {
      if (/is busy until/i.test(e instanceof Error ? e.message : String(e))) return null;
      throw e;
    }
  }
  try {
    if (mode === "rebuild") {
      const r = await b.retry(() => beginReportingRebuild(env.client, site));
      return { batchId: r.batchId, fence: r.leaseFence, kind: "rebuild", state: r.state, cutoff: null, copyAfter: null };
    }
    const r = await b.retry(() => beginReportingBatch(env.client, site));
    if (r.reused) {
      // Raced with another starter: take it over properly (never two workers on one fence).
      const t = await b.retry(() => resumeReportingBatch(env.client, r.batchId, r.leaseFence));
      return { batchId: t.batchId, fence: t.leaseFence, kind: t.kind, state: t.state, cutoff: t.sourceCutoffUtc, copyAfter: t.rebuildProgress?.afterEventId ?? null };
    }
    counts.changes = r.changeCount;
    counts.events = r.eventCount;
    return { batchId: r.batchId, fence: r.leaseFence, kind: "refresh", state: r.state, cutoff: r.sourceCutoffUtc, copyAfter: null };
  } catch (e) {
    if (/is busy until/i.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
}

/** Rebuild: copy the remaining candidate pages (database-saved cursor), then freeze. */
async function copyAndFreeze(env: WorkerEnv, b: Budget, a: ActiveBatch, counts: Record<string, number>): Promise<void> {
  let after = a.copyAfter;
  for (;;) {
    b.need();
    await b.beat(a.batchId, a.fence);
    const p = await b.retry(() => copyReportingSourcePage(env.client, a.batchId, a.fence, after));
    counts.copiedPages = (counts.copiedPages ?? 0) + (p.replay ? 0 : 1);
    if (p.complete) break;
    after = p.nextAfterEventId;
  }
  b.need();
  const f = await b.retry(() => freezeReportingRebuild(env.client, a.batchId, a.fence));
  a.state = "frozen";
  a.cutoff = f.sourceCutoffUtc;
}

/** Durable enumeration: discoveries saved with each cursor advance; resumes from the saved cursor. */
async function enumerate(env: WorkerEnv, b: Budget, a: ActiveBatch, reader: FrozenReader, pages: EnumerationPages, from: EnumCursor | null, counts: Record<string, number>): Promise<void> {
  let cursor = from;
  const save = async (next: EnumCursor, found: OwnerDiscovery[], complete: boolean) => {
    const r = await b.retry(() => saveEnumeration(env.client, a.batchId, a.fence, cursor, next, found, complete));
    cursor = next;
    counts.checkpoints = (counts.checkpoints ?? 0) + 1;
    counts.ownersDiscovered = r.ownersDiscovered;
  };
  if (a.kind === "rebuild") {
    let after = cursor?.kind === "rebuild" ? cursor.after : null;
    for (;;) {
      b.need();
      await b.beat(a.batchId, a.fence);
      const owners = await b.retry(() => pages.ownerPage(after === null ? null : { partitionKind: after[0], partitionKey: after[1] }));
      if (!owners.length) return void (await save({ kind: "rebuild", after, end: true }, [], true));
      const last = owners[owners.length - 1];
      after = [last.partitionKind, last.partitionKey];
      await save({ kind: "rebuild", after }, owners.map((o) => ({ owner: o, oldStaff: [] })), false);
    }
  }
  // Refresh: one changed key at a time, each a resumable walk (checkpoint after every bounded source page).
  let after = cursor?.kind === "refresh" ? cursor.after : null;
  let resume = cursor?.kind === "refresh" ? cursor.key ?? null : null;
  for (;;) {
    b.need();
    await b.beat(a.batchId, a.fence);
    const keys = await b.retry(() => pages.changedKeyPage(after));
    if (!keys.length) {
      if (resume) throw new ReportingJobError("the saved in-progress changed key is no longer a changed key of this batch");
      return void (await save({ kind: "refresh", after, end: true }, [], true));
    }
    for (const k of keys) {
      if (resume && resume.id !== k.id) throw new ReportingJobError("the saved in-progress changed key is not the next changed key of this batch");
      await walkChangedKey(reader, k, resume, {
        checkpoint: async (next, step) => {
          await b.beat(a.batchId, a.fence);
          const nextCursor: EnumCursor = next ? { kind: "refresh", after, key: next } : { kind: "refresh", after: k.id };
          const r = await b.retry(() => saveWalk(env.client, a.batchId, a.fence, cursor, nextCursor, k.id, step, next === null));
          cursor = nextCursor;
          counts.checkpoints = (counts.checkpoints ?? 0) + 1;
          counts.ownersDiscovered = r.ownersDiscovered;
          if (!b.hasTime()) throw new OutOfTime(); // saved first: the next invocation continues from here
          return r.seenCount;
        },
        lineImage: async (seed, line) => {
          const image = await b.retry(() => readWalkLine(env.client, a.batchId, a.fence, k.id, seed, line));
          return image === null ? null : imageToEvent(image, reader.site, line);
        },
      }, env.walkPages ?? KEY_WALK_PAGES);
      resume = null;
      after = k.id;
      counts.changedKeys = (counts.changedKeys ?? 0) + 1;
    }
  }
}

/**
 * Plan every discovered, unplanned owner (one owner per atomic call). Owners
 * are materialized in bounded groups (concurrently, over the coalescing
 * reader) and planned strictly in list order; the first failure in that order
 * is raised after the owners before it are planned, exactly as one at a time.
 */
async function plan(env: WorkerEnv, b: Budget, a: ActiveBatch, reader: FrozenReader, stats: MaterializeStats, counts: Record<string, number>, routing: OwnerRouting | null): Promise<void> {
  const size = ownerGroupSize(env);
  for (;;) {
    b.need();
    const owners = await b.retry(() => listWorkerOwners(env.client, a.batchId, a.fence, true, null, PLAN_PAGE));
    if (!owners.length) return;
    for (let i = 0; i < owners.length; i += size) {
      b.need();
      await b.beat(a.batchId, a.fence);
      const group = owners.slice(i, i + size);
      const settled: Array<PromiseSettledResult<WorkDescriptor[]>> = routing
        ? await routedGroup(env, b, a, routing, group, stats, counts)
        : (await materializeOwnerGroup(reader, group, stats, (f) => b.retry(f))).map((s) => (s.status === "fulfilled" ? { status: "fulfilled", value: s.value.map((w) => w.desc) } : s));
      for (let k = 0; k < group.length; k++) {
        const s = settled[k];
        if (s.status === "rejected") throw s.reason;
        await b.beat(a.batchId, a.fence);
        await b.retry(() => planOwner(env.client, a.batchId, a.fence, group[k].owner, s.value));
        counts.ownersPlanned = (counts.ownersPlanned ?? 0) + 1;
      }
    }
  }
}
const ownerGroupSize = (env: WorkerEnv) => Math.max(1, Math.min(env.ownerGroup ?? OWNER_GROUP, 32));

/**
 * T15P-4d step 3: how planning reads an owner. `light(before)` is a fresh per-owner reader whose EVERY read first runs
 * `before` (the owner's activation check) and then the page guard; `base` (page guard only) serves the shared children
 * flushes and the durable route. Null when the source has no one-call pages (the legacy group path is used instead).
 */
interface OwnerRouting {
  light(before: () => Promise<void>): FrozenReader & { pages: FrozenReaderPages };
  base: FrozenReader & { pages: FrozenReaderPages };
  cutoffUs: bigint;
  site: ReportingSite;
  guard: () => Promise<void>;
  /** A due lease renewal only (no deadline check): admission judges the time left itself. */
  beat: () => Promise<void>;
}
const hasPages = (r: FrozenReader): r is FrozenReader & { pages: FrozenReaderPages } => !!(r as { pages?: unknown }).pages;
/** An injected reader with `before` awaited ahead of every read, page methods included. */
function hookedReader(r: FrozenReader & { pages: FrozenReaderPages }, before: () => Promise<void>): FrozenReader & { pages: FrozenReaderPages } {
  return {
    ...guardedReader(r, before),
    pages: {
      membersPage: async (o, after, limit) => (await before(), r.pages.membersPage(o, after, limit)),
      byIdsPage: async (ids) => (await before(), r.pages.byIdsPage(ids)),
      childrenPage: async (ids, after, limit) => (await before(), r.pages.childrenPage(ids, after, limit)),
    },
  };
}

/**
 * Plan-phase reads of one bounded owner group: each owner starts on its own light reader (activation counters kept
 * across transient retries: ONE watch per owner) with an allowance-bounded shared children view. An activating owner
 * restarts on the durable route: it waits for the group's single durable turn (never two durable owners at once),
 * recovers or opens its plan journal (`recoverOwnerJournal`), continues the read from the journal, and hashes its
 * audiences into the journal one bounded checkpoint at a time before its descriptors are returned. A light owner never
 * touches the journal. Results come back in group order, settled each on its own (planned strictly in order).
 */
async function routedGroup(
  env: WorkerEnv, b: Budget, a: ActiveBatch, routing: OwnerRouting,
  items: ReadonlyArray<{ owner: Owner; oldStaff: Iterable<string> }>, stats: MaterializeStats, counts: Record<string, number>,
): Promise<Array<PromiseSettledResult<WorkDescriptor[]>>> {
  const shared = sharedChildren(routing.base);
  let turn: Promise<void> = Promise.resolve();
  /** Wait for the group's durable turn; resolves to its release. */
  const durableTurn = (): Promise<() => void> => {
    let release!: () => void;
    const prev = turn;
    turn = new Promise<void>((r) => (release = r));
    return prev.then(() => release);
  };
  const cpuNow = env.cpuNow ?? processCpuMs;
  // journal and hash RPCs run inside an admitted unit: the heartbeat/deadline guard runs before EACH of them, so a
  // renewal that falls due between a unit's calls is taken at that call boundary
  const jc: RpcClient = { rpc: async (fn, args) => (await routing.guard(), env.client.rpc(fn, args)) };
  return Promise.allSettled(items.map(async (item) => {
    const watch = activationWatch(item.owner, ACTIVATION_LIMITS);
    /**
     * What a FRESH invocation would redo before this owner's next durable unit, kept current as the journal grows:
     * the fixed calls, the light attempts, lookup, the committed journal's live reload calls, its reconstruction CPU and,
     * once reading is done, the descriptor CPU. An open or discard already done is not repeated by a fresh invocation.
     */
    const cost = { fixed: 0, reloadCalls: 0, reloadCpuMs: 0, descCpuMs: 0, hashing: false, readCpuMs: null as number | null, hashCpuMs: null as number | null };
    let readEnd: number | null = null;
    const prerequisites = () => ({ rpcs: cost.fixed + cost.reloadCalls, cpuMs: cost.reloadCpuMs + (cost.hashing ? cost.descCpuMs : 0) });
    /**
     * Admit the owner's next durable leg (T15P-4d step 4): a due renewal is taken first (so the phase since the beat is
     * below one interval), then the path is judged against the time left now and against a fresh STANDARD run.
     * `capacity` fails visibly (evidence kept); `pending` parks the owner with its committed journal unchanged.
     */
    const admit = async (unit: AdmissionRecord["unit"], rpcs: number, cpuMs: number) => {
      await routing.beat();
      const path: AdmissionPath = { prerequisites: prerequisites(), unit: { rpcs, cpuMs }, prerequisitesPaid: true };
      const remainingMs = b.remainingMs();
      const sinceBeatMs = b.sinceBeat();
      // "fits a fresh run" is judged against a STANDARD invocation (WORKER_BUDGET_MS), never this one's own deadline
      const v = admitDurableUnit(path, remainingMs, WORKER_BUDGET_MS, sinceBeatMs);
      const action = v.verdict === "capacity" ? "fail" : v.verdict === "pending" ? "park" : "run";
      env.onAdmission?.({ owner: item.owner, unit, path, nowMs: env.now(), remainingMs, sinceBeatMs, budgetMs: WORKER_BUDGET_MS, verdict: v.verdict, action });
      if (v.verdict === "capacity") throw new OwnerInputCapacityError(item.owner, v.freshMs, WORKER_BUDGET_MS);
      if (v.verdict === "pending") {
        counts.ownersParked = (counts.ownersParked ?? 0) + 1;
        throw new Parked();
      }
    };
    /** A durable source read: admitted at its smallest legal size (the read plus a one-call commit), then timed. */
    const read = <A extends unknown[], R>(f: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
      await admit("read", READ_LEG_RPCS, cost.readCpuMs ?? FIRST_UNIT_CPU_MS);
      const out = await f(...args);
      readEnd = cpuNow();
      return out;
    };
    // the durable turn's release and the journal handle (set inside the durable callback)
    const held: { release: (() => void) | null; handle: string | null } = { release: null, handle: null };
    try {
      const r = await b.retry(() => routedOwnerInput((before, share) => shared.forOwner(routing.light(before), share), item.owner, async () => {
        if (!held.release) {
          // counted at activation (a parked or failed owner is counted too)
          counts.ownersActivated = (counts.ownersActivated ?? 0) + 1;
          counts.activationCalls = Math.max(counts.activationCalls ?? 0, watch.calls);
          held.release = await durableTurn();
        }
        const c0 = cpuNow();
        const rec = await recoverOwnerJournal(env.client, a.batchId, a.fence, item.owner, routing.site, "plan");
        cost.fixed = FIXED_PREREQUISITE_RPCS + watch.calls + 1; // + lookup
        cost.reloadCalls = rec.reloadCalls;
        cost.reloadCpuMs = Math.max(0, cpuNow() - c0);
        held.handle = rec.handle;
        if (rec.input) return { input: rec.input }; // already read (hashing or complete): no source read, no second reload
        const journal = ownerJournal(jc, a.batchId, a.fence, rec.handle, rec.seq, routing.cutoffUs, rec.reloadCalls);
        const base = routing.base;
        const reader: FrozenReader & { pages: FrozenReaderPages } = {
          ...base,
          pages: { membersPage: read(base.pages.membersPage.bind(base.pages)), byIdsPage: read(base.pages.byIdsPage.bind(base.pages)), childrenPage: read(base.pages.childrenPage.bind(base.pages)) },
          childPage: read(base.childPage.bind(base)),
          stream: read(base.stream.bind(base)),
          ...(base.predecessorPage ? { predecessorPage: read(base.predecessorPage.bind(base)) } : {}),
        };
        return {
          reader,
          journal: {
            async commit(pg) {
              // the exact commit, known now that the page is: admitted before its first call (the read is not redone)
              const c1 = cpuNow();
              if (readEnd !== null) cost.readCpuMs = Math.max(cost.readCpuMs ?? 0, c1 - readEnd);
              readEnd = null;
              const calls = journal.pageCalls(pg);
              const serializeMs = Math.max(0, cpuNow() - c1);
              await admit("commit", calls, serializeMs);
              await journal.commit(pg);
              cost.reloadCalls = journal.reloadCalls;
              cost.reloadCpuMs += serializeMs; // reconstructing these bytes costs about what serializing them did
              counts.durableUnits = (counts.durableUnits ?? 0) + 1;
            },
          },
          resume: rec.snapshot,
        };
      }, ACTIVATION_LIMITS, watch));
      // one audience projected at a time; only descriptors (identity + input hash) are kept for ordered planning
      const d0 = cpuNow();
      const descs = ownerDescriptors(routing.base, item.owner, r.input, item.oldStaff, stats);
      if (r.route === "durable") {
        counts.ownersDurable = (counts.ownersDurable ?? 0) + 1;
        // a fresh invocation past reading recomputes every descriptor before its next hash unit: charged once, there
        cost.descCpuMs = Math.max(0, cpuNow() - d0);
        cost.hashing = true;
        const hashes = descs.map((d) => ({ audienceKind: d.audienceKind, audienceStaff: d.audienceStaff, inputHash: d.inputHash }));
        for (;;) {
          await admit("hash", HASH_UNIT_RPCS, cost.hashCpuMs ?? FIRST_UNIT_CPU_MS);
          const h0 = cpuNow();
          const step = await b.retry(() => hashOwnerInputStep(jc, a.batchId, a.fence, held.handle!, hashes));
          cost.hashCpuMs = Math.max(cost.hashCpuMs ?? 0, cpuNow() - h0);
          if (step.result) cost.reloadCalls = step.result.reloadCalls;
          counts.durableUnits = (counts.durableUnits ?? 0) + 1;
          if (step.complete) break;
        }
      }
      return descs;
    } finally {
      held.release?.();
    }
  }));
}

/** Seal only with the exact completeness proof and the saved-descriptor manifest. */
async function seal(env: WorkerEnv, b: Budget, a: ActiveBatch, counts: Record<string, number>): Promise<void> {
  b.need();
  const v = await b.retry(() => verifyPlan(env.client, a.batchId, a.fence));
  const m = await b.retry(() => manifestFromSaved(env.client, a.batchId, a.fence));
  if (m.count !== v.descriptors) throw new ReportingJobError(`the saved descriptor traversal found ${m.count} descriptors; the plan proof has ${v.descriptors}`);
  await b.retry(() => sealWithManifest(env.client, a.batchId, a.fence, m.count, m.hash));
  counts.sealedWork = m.count;
  counts.owners = v.owners;
}

/** Claim bounded work, re-materialize each claimed owner once from the frozen view, stage its chunks. Returns true when nothing is left. */
async function stage(env: WorkerEnv, b: Budget, a: ActiveBatch, reader: FrozenReader, stats: MaterializeStats, counts: Record<string, number>): Promise<boolean> {
  for (;;) {
    if (!b.hasTime()) return false;
    await b.beat(a.batchId, a.fence);
    const claimed = await b.retry(() => claimReportingWork(env.client, a.batchId, a.fence, CLAIM_PAGE));
    if (!claimed.length) return true;
    const groups = new Map<string, typeof claimed>();
    for (const c of claimed) {
      const k = ownerKey({ partitionKind: c.partitionKind, partitionKey: c.partitionKey });
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
    }
    // Owners in bounded groups: materialized concurrently (coalescing reader), staged strictly in claim order.
    const all = [...groups.values()];
    const size = ownerGroupSize(env);
    for (let i = 0; i < all.length; i += size) {
      if (!b.hasTime()) return false; // unstaged claimed work returns to pending on the next takeover
      await b.beat(a.batchId, a.fence);
      const part = all.slice(i, i + size);
      const items = part.map((group) => ({
        owner: { partitionKind: group[0].partitionKind, partitionKey: group[0].partitionKey } as Owner,
        oldStaff: group.filter((c) => c.audienceKind === "self").map((c) => c.audienceStaff!),
      }));
      const settled = await materializeOwnerGroup(reader, items, stats, (f) => b.retry(f));
      for (let k = 0; k < part.length; k++) {
        const group = part[k];
        const s = settled[k];
        if (s.status === "rejected") throw s.reason;
        await b.beat(a.batchId, a.fence);
        const entries: StageEntry[] = [];
        for (const c of group) {
          const w = s.value.find((x) => x.desc.audienceKind === c.audienceKind && x.desc.audienceStaff === c.audienceStaff);
          if (!w || w.desc.inputHash !== c.inputHash) throw new ReportingJobError(`claimed work ${c.workId}: the frozen input hash differs from the planned descriptor`);
          for (const chunk of buildChunks(w.rows)) entries.push({ partition: c.workId, chunk });
        }
        for (const req of packStageRequests(entries)) await b.retry(() => stageReportingResults(env.client, a.batchId, a.fence, req));
        counts.staged = (counts.staged ?? 0) + group.length;
      }
    }
  }
}

export async function runReportingCycle(env: WorkerEnv, req: { site: ReportingSite; mode: CycleMode; deadlineMs?: number }): Promise<CycleResult> {
  const t0 = env.now();
  const startedAtUtc = new Date(t0).toISOString();
  const b = new Budget(env, t0 + (req.deadlineMs ?? WORKER_BUDGET_MS), req.deadlineMs ?? WORKER_BUDGET_MS);
  const redact = env.redact ?? defaultRedact;
  const counts: Record<string, number> = {};
  const problems: string[] = [];
  const stats: MaterializeStats = { owners: 0, works: 0, maxInput: 0, totalInput: 0, requests: 0, peakInput: 0 };
  const out: CycleResult = { site: req.site, mode: req.mode, state: "failed", batchId: null, generationId: null, failureKind: null, counts, problems, durationMs: 0 };
  try {
    if (req.mode === "cleanup") {
      for (;;) {
        b.need();
        const p = await b.retry(() => cleanupHistory(env.client, req.site));
        counts.expiredGenerations = (counts.expiredGenerations ?? 0) + p.expiredGenerations;
        counts.deletedVersions = (counts.deletedVersions ?? 0) + p.deletedVersions;
        counts.deletedRuns = (counts.deletedRuns ?? 0) + p.deletedRuns;
        counts.deletedWorkerRows = (counts.deletedWorkerRows ?? 0) + p.deletedWorkerRows;
        if (!p.more) break;
      }
      out.state = "done";
    } else {
      // T15P-4d step 3: the 0046 owner-input protocol FIRST, before any batch work (a transient probe failure keeps its code
      // and goes through the bounded retry / Deferred path; only a missing or other version is unsupported)
      await b.retry(() => requireOwnerInputProtocol(env.client));
      const a = await acquire(env, b, req.site, req.mode, counts);
      if (!a) out.state = "busy";
      else {
        out.batchId = a.batchId;
        if (a.kind === "rebuild" && a.state === "active") await copyAndFreeze(env, b, a, counts);
        if (a.cutoff === null) throw new ReportingJobError("the batch has no frozen cutoff");
        const ref: FrozenBatchRef = { batchId: a.batchId, fence: a.fence, site: req.site, cutoff: canonicalInstant(a.cutoff), kind: a.kind };
        // T15P-1: the budget check + due heartbeat, awaited before every actual frozen-read RPC of planning/staging.
        const pageGuard = async () => {
          b.need();
          await b.beat(a.batchId, a.fence);
          // T15P-1a: a renewal (or its retry) can cross the deadline; check again so no new frozen read starts after expiry.
          b.need();
        };
        const src = env.source ? env.source(ref, pageGuard) : { reader: rpcFrozenReader(env.client, ref), pages: rpcEnumerationPages(env.client, ref) };
        // Planning and staging materialize owner groups over ONE coalescing view of the frozen reads (enumeration stays sequential
        // on the unguarded reader, with its own per-page checks). For the production RPC reader, the guard also runs before
        // EACH internal page (members/byIds/children pages, coalesced flushes, fallbacks, 0045), so one long owner can neither
        // starve the 30 s heartbeat nor run past the 240 s budget (OutOfTime -> pending, owners before it kept). The outer guard
        // stays for injected readers and non-RPC work.
        const materializing = env.source ? src.reader : rpcFrozenReader(env.client, ref, { beforeRead: pageGuard });
        const coalesced = guardedReader(coalescingChildren(materializing), pageGuard);
        const cutoffUs = exactInstant(ref.cutoff)!;
        const routing: OwnerRouting | null = env.source
          ? hasPages(src.reader)
            ? { light: (before) => hookedReader(src.reader as FrozenReader & { pages: FrozenReaderPages }, async () => { await before(); await pageGuard(); }), base: hookedReader(src.reader, pageGuard), cutoffUs, site: req.site, guard: pageGuard, beat: () => b.beat(a.batchId, a.fence) }
            : null
          : { light: (before) => rpcFrozenReader(env.client, ref, { beforeRead: async () => { await before(); await pageGuard(); } }), base: materializing as FrozenReader & { pages: FrozenReaderPages }, cutoffUs, site: req.site, guard: pageGuard, beat: () => b.beat(a.batchId, a.fence) };
        const prog = await b.retry(() => readWorkerProgress(env.client, a.batchId, a.fence));
        if (!prog.sealed) {
          if (!prog.complete) await enumerate(env, b, a, src.reader, src.pages, prog.cursor, counts);
          await plan(env, b, a, coalesced, stats, counts, routing);
          await seal(env, b, a, counts);
        }
        if (await stage(env, b, a, coalesced, stats, counts)) {
          b.need();
          const p = await b.retry(() => publishReportingBatch(env.client, a.batchId, a.fence));
          out.generationId = p.generationId;
          counts.receipts = p.receipts;
          counts.acknowledged = p.acknowledged;
          out.state = "published";
        } else out.state = "pending";
      }
    }
  } catch (e) {
    if (e instanceof OutOfTime) out.state = "pending";
    else if (e instanceof Deferred) {
      out.state = "pending";
      problems.push(`deferred: ${redact(e.cause instanceof Error ? e.cause.message : String(e.cause))}`);
    } else {
      out.state = "failed";
      out.failureKind = failureKind(e);
      problems.push(redact(e instanceof Error ? e.message : String(e)));
      // an unsupported protocol did no batch work: it is reported, but records no run (the run log is part of the protocol)
      if (e instanceof OwnerInputUnsupportedError) {
        out.durationMs = Math.max(0, env.now() - t0);
        return out;
      }
    }
  }
  counts.ownersMaterialized = stats.owners;
  counts.maxInput = stats.maxInput;
  counts.totalInput = stats.totalInput;
  out.durationMs = Math.max(0, env.now() - t0);
  try {
    await recordRun(env.client, { site: req.site, mode: req.mode, action: req.mode, outcome: out.state, batchId: out.batchId, generationId: out.generationId, startedAtUtc, durationMs: out.durationMs, counts, failureKind: out.state === "failed" ? out.failureKind ?? "error" : null });
  } catch (e) {
    problems.push(`run log not recorded: ${redact(e instanceof Error ? e.message : String(e))}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// T15P-4d step 2: phase-specific cumulative admission to the NEXT durable progress boundary (approval condition 3)
// ---------------------------------------------------------------------------

/** The deterministic RPC cost (ms) used by admission, and the run-record reserve kept back from every budget. */
export const ADMISSION_RPC_MS = 1_000;
export const ADMISSION_RESERVE_MS = 2_000;
/** One leg of a path to durable progress: RPCs (each at ADMISSION_RPC_MS) plus measured/estimated CPU and serialization. */
export interface AdmissionCost { rpcs: number; cpuMs: number }
/**
 * The smallest legal path to the next durable boundary for one unit:
 *  - `prerequisites`: what a FRESH invocation must redo first (version/status/acquire/progress, the owner list or claim,
 *    lookup, every reload call, reload parsing/reassembly/digests/sorting, old-staff reads, preparation CPU);
 *  - `unit`: the unit itself INCLUDING its committing RPC (reading: the source page plus its pending/final checkpoint
 *    calls; hashing: the chosen hashes and their hash checkpoint; stage: projection/hash/chunks, complete sparse
 *    discovery and at least the first missing upload).
 * `prerequisitesPaid` is true when this invocation already holds the prerequisites (they are then not charged again).
 */
export interface AdmissionPath { prerequisites: AdmissionCost; unit: AdmissionCost; prerequisitesPaid: boolean }
/** Every admission input is validated at runtime: NaN/Infinity/negative/fractional estimates are refused, never admitted. */
function admissionMs(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new ReportingJobError(`admission ${what} must be a finite non-negative number`);
  return v;
}
function admissionRpcs(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new ReportingJobError(`admission ${what} must be a non-negative safe integer`);
  return v;
}
const legMs = (c: AdmissionCost, what: string) => {
  if (!c || typeof c !== "object") throw new ReportingJobError(`admission ${what} is missing`);
  return admissionRpcs(c.rpcs, `${what}.rpcs`) * ADMISSION_RPC_MS + admissionMs(c.cpuMs, `${what}.cpuMs`);
};
/** Elapsed time including every due lease renewal (each one RPC), to a fixed point, plus the run-record reserve. */
export function withRenewals(workMs: number, sinceBeatMs = 0): number {
  admissionMs(workMs, "workMs");
  admissionMs(sinceBeatMs, "sinceBeatMs");
  if (sinceBeatMs >= HEARTBEAT_MS) throw new ReportingJobError("admission sinceBeatMs must be below the heartbeat interval (a due renewal is taken first)");
  let renewals = 0;
  for (;;) {
    const total = workMs + renewals * ADMISSION_RPC_MS;
    // renewals fall due HEARTBEAT_MS after the last one: the phase already elapsed brings the first one forward
    const due = Math.floor((sinceBeatMs + total) / HEARTBEAT_MS);
    if (due === renewals) return total + ADMISSION_RESERVE_MS;
    renewals = due;
  }
}
export type AdmissionVerdict = { verdict: "run" } | { verdict: "pending"; freshMs: number; nowMs: number } | { verdict: "capacity"; freshMs: number };
/** Calls a fresh invocation makes before planning an owner: version, status, resume, progress and the owner page. */
export const FIXED_PREREQUISITE_RPCS = 5;
/**
 * The smallest legal durable read: the source RPC plus a one-call commit. Its EXACT commit is admitted separately once
 * the page is known (`ownerJournal.pageCalls`), so no unproved pre-read bound is needed.
 */
export const READ_LEG_RPCS = 1 + 1;
/** An explicit CPU estimate for a unit kind not yet measured in this invocation (one RPC's worth), never zero. */
export const FIRST_UNIT_CPU_MS = 1_000;
/** This process's CPU time in ms (user + system): I/O waits, sleeps and backoff do not advance it. */
export const processCpuMs = (): number => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
/** One hash unit: the pinned header load plus its hash checkpoint. */
export const HASH_UNIT_RPCS = 2;
/** The current invocation's verdict from its actual clock: time left now and the phase since the last renewal. */
export function admissionAt(path: AdmissionPath, nowMs: number, deadlineMs: number, lastBeatMs: number, budgetMs = WORKER_BUDGET_MS): AdmissionVerdict {
  return admitDurableUnit(path, Math.max(0, deadlineMs - nowMs), budgetMs, Math.max(0, nowMs - lastBeatMs));
}
/** An owner whose next durable unit cannot fit even a fresh invocation: visible, journal retained, publication blocked. */
export class OwnerInputCapacityError extends ReportingJobError {
  constructor(owner: Owner, freshMs: number, budgetMs: number, why = "its smallest path to the next durable boundary does not fit a fresh run") {
    // diagnostics carry only the owner KIND and the times, never the raw order/event key
    super(`owner_input_capacity: an ${owner.partitionKind} owner cannot progress: ${why} (${Math.ceil(freshMs)} ms of ${budgetMs} ms)`, "owner_input_capacity");
  }
}

/**
 * Admit a unit: `capacity` (visible `owner_input_capacity`, evidence retained, publication blocked) when even a fresh
 * uninterrupted invocation could not reach the boundary; `pending` (the owner is parked first for the next invocation)
 * when it fits fresh but not the time left now; otherwise `run`. Every cost counts once.
 */
export function admitDurableUnit(path: AdmissionPath, remainingMs: number, budgetMs = WORKER_BUDGET_MS, sinceBeatMs = 0): AdmissionVerdict {
  admissionMs(remainingMs, "remainingMs");
  admissionMs(budgetMs, "budgetMs");
  if (budgetMs <= ADMISSION_RESERVE_MS) throw new ReportingJobError("admission budgetMs must leave a usable budget after the run-record reserve");
  if (!path || typeof path !== "object" || typeof path.prerequisitesPaid !== "boolean") throw new ReportingJobError("admission path is malformed");
  const pre = legMs(path.prerequisites, "prerequisites");
  const unit = legMs(path.unit, "unit");
  const freshMs = withRenewals(pre + unit);
  if (freshMs > budgetMs) return { verdict: "capacity", freshMs };
  // the CURRENT invocation: the time already elapsed since its last heartbeat counts (the fresh path starts at a beat)
  const nowMs = withRenewals((path.prerequisitesPaid ? 0 : pre) + unit, sinceBeatMs);
  if (nowMs > remainingMs) return { verdict: "pending", freshMs, nowMs };
  return { verdict: "run" };
}

// ---------------------------------------------------------------------------
// T15P-4d step 3a: worker seams over the 0046 journal (not yet called by runReportingCycle)
// ---------------------------------------------------------------------------

/** Raised before any batch work when the 0046 protocol is missing or unsupported; the caller records no run. */
export class OwnerInputUnsupportedError extends ReportingJobError {
  constructor(detail: string) {
    super(`owner_input_unsupported: ${detail}`, "owner_input_unsupported");
  }
}
/**
 * Version FIRST: the owner-input protocol must exist and be exactly OWNER_INPUT_VERSION before the worker touches a
 * batch. A missing function (the migration is not installed) or another version is a typed refusal, not a run.
 */
export async function requireOwnerInputProtocol(client: RpcClient): Promise<void> {
  let v: number;
  try {
    v = await ownerInputVersion(client);
  } catch (e) {
    // a temporarily unavailable database is NOT an unsupported protocol: transient errors keep their code for the
    // existing bounded retry / Deferred path; only a missing function or a malformed answer is unsupported
    if (isTransient(e)) throw e;
    throw new OwnerInputUnsupportedError("reporting_owner_input_version is unavailable");
  }
  if (v !== OWNER_INPUT_VERSION) throw new OwnerInputUnsupportedError(`protocol version ${v}, this worker speaks ${OWNER_INPUT_VERSION}`);
}

/** A journal that proved too heavy to reload: visible failure, evidence retained, publication blocked. */
export class OwnerInputTooHeavyError extends ReportingJobError {
  constructor(owner: Owner, calls: number) {
    // diagnostics carry only the owner KIND and counts, never the raw order/event key
    super(`owner_input_too_heavy: an ${owner.partitionKind} owner needs ${calls} reload calls (max 120)`, "owner_input_too_heavy");
  }
}
export const MAX_RELOAD_CALLS = 120;
/**
 * The protocol's purpose rule: a PLAN request may use only a plan journal (a stage journal is never downgraded); a
 * STAGE request may recover a plan journal (stage takeover of an incomplete plan read, or sealed reuse of a complete
 * one: its first sealed write upgrades the stored purpose) or a stage journal.
 */
export const purposeCompatible = (found: "plan" | "stage", wanted: "plan" | "stage"): boolean => wanted === "stage" || found === "plan";
/** An existing journal whose purpose the request may not use (a stage journal for a plan request). */
export class OwnerInputPurposeError extends ReportingJobError {
  constructor(owner: Owner, found: string, wanted: string) {
    super(`owner_input_purpose: an ${owner.partitionKind} owner has a ${found} journal, not ${wanted}`, "owner_input_purpose");
  }
}

/**
 * Recover one owner's durable journal in a (possibly new) process, in the r6 order: `lookup` first, failing fast on a
 * persisted heavy proof or a reload cost above 120 BEFORE any reload or discard; open the journal if there is none;
 * discard only NON-heavy pending data of an unfinished page (a new process never re-sends an unpersisted payload);
 * then the snapshot-pinned reload. Returns the handle, the current seq and a resumable snapshot (null when the journal
 * is past reading, i.e. hashing/complete: the caller continues with the hash step). For a journal past reading it also
 * returns the already reloaded and validated INPUT (member prefix and evidence, bytewise, exactly as buildOwnerInput), so
 * the next hash/stage unit needs no second event reload and no source read.
 */
export async function recoverOwnerJournal(
  client: RpcClient, batchId: string, fence: number, owner: Owner, site: string, purpose: "plan" | "stage",
): Promise<{ handle: string; seq: string; snapshot: OwnerJournalSnapshot | null; input: OwnerInput | null; discarded: number; header: OwnerInputHeader; reloadCalls: number; opened: boolean }> {
  const [found] = await lookupOwnerInputs(client, batchId, fence, [owner]);
  const j = found.journal;
  if (j && (j.heavyProven || j.reloadCalls > MAX_RELOAD_CALLS || j.provisionalReloadCalls > MAX_RELOAD_CALLS)) {
    throw new OwnerInputTooHeavyError(owner, Math.max(j.reloadCalls, j.provisionalReloadCalls));
  }
  // purpose compatibility (item-counting §4 / 0046: plan -> stage is the single legal upgrade), BEFORE any discard or reload
  if (j && !purposeCompatible(j.purpose, purpose)) throw new OwnerInputPurposeError(owner, j.purpose, purpose);
  const handle = j ? j.handle : (await openOwnerInput(client, batchId, fence, owner, purpose)).handle;
  let discarded = 0;
  if (j && j.pendingEvents > 0) {
    const r = await checkpointOwnerInput(client, batchId, fence, handle, j.seq, { kind: "discard_pending" });
    discarded = j.pendingEvents;
    if (r.pendingEvents !== 0) throw new ReportingJobError("discard_pending left pending events");
  }
  const back = await reloadOwnerInput(client, batchId, fence, handle, site);
  // re-verified after the reload with the same rule: an incompatible header is rejected, never adopted
  if (!purposeCompatible(back.header.purpose, purpose)) throw new OwnerInputPurposeError(owner, back.header.purpose, purpose);
  const snapshot = back.header.phase === "reading" ? ownerJournalSnapshot(back) : null;
  let input: OwnerInput | null = null;
  if (!snapshot) {
    // a finished read: the committed journal IS the input (ordinals contiguous, the member prefix fixed by members_count)
    const n = back.header.membersCount;
    if (n === null || n > back.events.length) throw new ReportingJobError("a finished journal has no valid member prefix");
    back.events.forEach((e, i) => {
      if (e.ord !== i + 1) throw new ReportingJobError("journal ordinals are not contiguous");
    });
    const byId = (x: { id: string }, y: { id: string }) => compareUtf8(x.id, y.id);
    input = { owner, members: back.events.slice(0, n).map((e) => e.ev).sort(byId), events: back.events.map((e) => e.ev).sort(byId) };
  }
  return { handle, seq: back.header.seq, snapshot, input, discarded, header: back.header, reloadCalls: back.calls, opened: !j };
}
