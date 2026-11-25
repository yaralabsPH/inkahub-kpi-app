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
import { ACTIVATION_LIMITS, activationWatch, audienceWork, coalescingChildren, durableOwnerInput, isoOfMicros, KEY_WALK_PAGES, materializeOwnerGroup, ownerDescriptors, ownerKey, PartitionTooLargeError, routedOwnerInput, sharedChildren, walkChangedKey, type CertainBound, type FrozenReader, type KeyWalkPages, type MaterializeStats, type Owner, type OwnerInput, type OwnerJournal, type OwnerJournalSnapshot, type StreamPosition } from "./production-reporting-materialize.js";
import { imageToEvent, rpcEnumerationPages, rpcFrozenReader, type EnumerationPages, type FrozenBatchRef, type FrozenReaderPages } from "./production-reporting-reader.js";
import { beginReportingBatch, beginReportingRebuild, copyReportingSourcePage, freezeReportingRebuild, getReportingJobStatus, renewReportingLease, ReportingJobError, resumeReportingBatch, type ReportingSite, type RpcClient } from "./reporting-jobs.js";
import { publishReportingBatch } from "./reporting-publish.js";
import { buildChunks, claimReportingWork, compareUtf8, packStageRequests, stageReportingResults, type ClaimedWork, type StageEntry, type WorkDescriptor } from "./reporting-stage.js";
import { checkpointOwnerInput, cleanupHistory, hashOwnerInputStep, listWorkerOwners, lookupOwnerInputs, manifestFromSaved, openOwnerInput, OWNER_INPUT_VERSION, ownerInputVersion, ownerJournal, ownerJournalSnapshot, planOwner, readStagedChunks, readWalkLine, readWorkerProgress, recordRun, releaseOwnerInputs, reloadOwnerInput, saveEnumeration, saveWalk, sealWithManifest, verifyPlan, type EnumCursor, type OwnerDiscovery, type OwnerInputHeader } from "./reporting-worker-state.js";

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
  /**
   * T15P-4d step 4: observes every durable-unit admission (IN-PROCESS TESTS ONLY; never changes the verdict). The record
   * carries the raw owner, so it must never be serialized into a production log.
   */
  onAdmission?: (a: AdmissionRecord) => void;
}
/** One admission decision, as the worker derived it (simplification §2-3). */
export interface AdmissionRecord {
  owner: Owner;
  unit: "read" | "commit" | "hash" | "stage";
  /** The exactly counted calls of the FRESH path (the only capacity input) and their time with renewals and reserve. */
  fresh: FreshCalls;
  freshMs: number;
  /** The unit's still-unpaid calls in this invocation, and the observed wall allowance (parking only). */
  currentRpcs: number;
  wallMs: number;
  nowMs: number;
  remainingMs: number;
  sinceBeatMs: number;
  budgetMs: number;
  verdict: AdmissionVerdict["verdict"];
  /** What the worker did with it: one authoritative decision. */
  action: "run" | "park" | "fail";
  /** Whether this is the invocation's qualified fresh attempt, and whether it had progressed before this admission. */
  freshAttempt: boolean;
  progressed: boolean;
}

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
const OWNER_INPUT_KINDS = new Set(["owner_input_unsupported", "owner_input_too_heavy", "owner_input_capacity", "owner_input_purpose", "owner_input_no_progress"]);
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

/**
 * One invocation's clock, budget, heartbeat and bounded retries. Every elapsed-time decision reads `now()`: the
 * worker's `env.now()` made NONDECREASING for this invocation (a backward clock step never grants budget back or makes
 * an invocation look fresher), and refused when not finite.
 */
class Budget {
  private lastBeat: number;
  private last: number;
  readonly startMs: number;
  constructor(private readonly env: WorkerEnv, private readonly deadline: number, readonly budgetMs: number) {
    this.last = Number.NEGATIVE_INFINITY;
    this.startMs = this.now();
    this.lastBeat = this.startMs;
  }
  now(): number {
    const t = this.env.now();
    if (!Number.isFinite(t)) throw new ReportingJobError("the worker clock returned a non-finite time");
    if (t > this.last) this.last = t;
    return this.last;
  }
  /** Milliseconds since the invocation started. */
  elapsedMs(): number {
    return this.now() - this.startMs;
  }
  /** Milliseconds since the last lease renewal (or since the invocation started). */
  sinceBeat(at = this.now()): number {
    return Math.max(0, at - this.lastBeat);
  }
  /** Milliseconds left before this invocation's deadline (never negative). */
  remainingMs(at = this.now()): number {
    return Math.max(0, this.deadline - at);
  }
  hasTime(): boolean {
    return this.now() < this.deadline;
  }
  /** Whether the next nominal call (and any renewal due during it) still leaves the run-record reserve. */
  fitsCall(): boolean {
    const at = this.now();
    return this.remainingMs(at) >= withRenewals(ADMISSION_RPC_MS, Math.min(this.sinceBeat(at), HEARTBEAT_MS - 1));
  }
  /** OutOfTime unless the next nominal call (and any renewal due during it) still leaves the run-record reserve. */
  needCall(): void {
    const at = this.now();
    const since = Math.min(this.sinceBeat(at), HEARTBEAT_MS - 1); // a due renewal is counted inside the fixed point
    if (this.remainingMs(at) < withRenewals(ADMISSION_RPC_MS, since)) throw new OutOfTime();
  }
  need(): void {
    if (!this.hasTime()) throw new OutOfTime();
  }
  private beating: Promise<void> | null = null;
  /** Renew when 30 s have passed; single-flight, so concurrently materialized owners never send duplicate renewals. */
  async beat(batchId: string, fence: number): Promise<void> {
    if (this.beating) return this.beating;
    if (this.now() - this.lastBeat < HEARTBEAT_MS) return;
    this.beating = (async () => {
      try {
        await this.retry(() => renewReportingLease(this.env.client, batchId, fence));
        this.lastBeat = this.now();
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
        if (wait === undefined || this.now() + wait >= this.deadline) throw new Deferred(e);
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
 *
 * T15P-4d step 4 (simplification §4): in a FRESH invocation (`fresh`: standard budget, no copy/enumeration done here)
 * whose startup took at most FRESH_STARTUP_MS, the first pending owner runs ALONE first as the qualified fresh
 * attempt. If a budget guard or admission stops it before its first substantive progress (an acknowledged page commit,
 * a committed hash unit, or its plan save), the run fails visibly with `owner_input_no_progress` (journal kept,
 * publication blocked) instead of parking unchanged forever. Every other stop stays an ordinary `pending`.
 */
async function plan(env: WorkerEnv, b: Budget, a: ActiveBatch, reader: FrozenReader, stats: MaterializeStats, counts: Record<string, number>, routing: OwnerRouting | null, fresh = false): Promise<void> {
  const size = ownerGroupSize(env);
  let first = fresh;
  const planGroup = async (group: ReadonlyArray<{ owner: Owner; oldStaff: Iterable<string> }>, attempt: FreshAttempt | null) => {
    b.need();
    await b.beat(a.batchId, a.fence);
    const settled: Array<PromiseSettledResult<WorkDescriptor[]>> = routing
      ? await routedGroup(env, b, a, routing, group, counts, attempt, "plan", planFinish(env, b, a, routing, stats, counts))
      : (await materializeOwnerGroup(reader, group, stats, (f) => b.retry(f))).map((s) => (s.status === "fulfilled" ? { status: "fulfilled", value: s.value.map((w) => w.desc) } : s));
    for (let k = 0; k < group.length; k++) {
      const s = settled[k];
      if (s.status === "rejected") throw s.reason;
      await b.beat(a.batchId, a.fence);
      await b.retry(() => planOwner(env.client, a.batchId, a.fence, group[k].owner, s.value));
      if (attempt) attempt.progressed = true; // the plan save is the light owner's progress boundary
      counts.ownersPlanned = (counts.ownersPlanned ?? 0) + 1;
    }
  };
  for (;;) {
    b.need();
    const owners = await b.retry(() => listWorkerOwners(env.client, a.batchId, a.fence, true, null, PLAN_PAGE));
    if (!owners.length) return;
    let i = 0;
    if (first) {
      first = false;
      // the startup (only the fixed restart prerequisites ran) must have left essentially the whole standard budget
      if (routing && b.elapsedMs() <= FRESH_STARTUP_MS) {
        const attempt: FreshAttempt = { started: false, progressed: false, unresolved: false };
        counts.freshAttempts = (counts.freshAttempts ?? 0) + 1;
        try {
          await planGroup(owners.slice(0, 1), attempt);
        } catch (e) {
          // only a budget stop of an attempt that did owner work and made no durable progress; every other error keeps its kind
          // a write whose outcome is still unknown (lost response, not yet recovered) is never declared "no progress"
          if (e instanceof OutOfTime && attempt.started && !attempt.progressed && !attempt.unresolved) {
            counts.ownersNoProgress = (counts.ownersNoProgress ?? 0) + 1;
            throw new OwnerInputNoProgressError(owners[0].owner, counts.durableUnits ?? 0);
          }
          throw e;
        }
        i = 1;
      }
    }
    for (; i < owners.length; i += size) await planGroup(owners.slice(i, i + size), null);
  }
}
const ownerGroupSize = (env: WorkerEnv) => Math.max(1, Math.min(env.ownerGroup ?? OWNER_GROUP, 32));

/**
 * T15P-4d step 3: how planning reads an owner. `light(before)` is a fresh per-owner reader whose EVERY read first runs
 * `before` (the owner's activation check) and then the page guard; `base` (page guard only) serves the shared children
 * flushes; `durable` is the activated owner's reader, whose every read first runs `unitGuard`. Null when the source has
 * no one-call pages (the legacy group path is used instead).
 */
interface OwnerRouting {
  light(before: () => Promise<void>): FrozenReader & { pages: FrozenReaderPages };
  base: FrozenReader & { pages: FrozenReaderPages };
  durable: FrozenReader & { pages: FrozenReaderPages };
  cutoffUs: bigint;
  site: ReportingSite;
  /** Before EVERY durable source/journal/hash RPC: the next call plus the reserve fits, a due renewal, then again. */
  unitGuard: () => Promise<void>;
  /** A due lease renewal only (no deadline check): admission judges the time left itself. */
  beat: () => Promise<void>;
}
const hasPages = (r: FrozenReader): r is FrozenReader & { pages: FrozenReaderPages } => !!(r as { pages?: unknown }).pages;
/** An injected reader with `before` awaited ahead of every read, page methods included. */
function hookedReader(r: FrozenReader & { pages: FrozenReaderPages }, before: () => Promise<void>): FrozenReader & { pages: FrozenReaderPages } {
  const at = async <T>(read: () => T | Promise<T>): Promise<T> => {
    await before();
    return read();
  };
  const it = <T>(f: () => AsyncIterable<T>): AsyncIterable<T> =>
    (async function* () {
      await before();
      yield* f();
    })();
  return {
    ...r,
    changedKeys: () => it(() => r.changedKeys()),
    owners: () => it(() => r.owners()),
    children: (ids) => it(() => r.children(ids)),
    members: (owners, cap) => at(() => r.members(owners, cap)),
    byIds: (ids) => at(() => r.byIds(ids)),
    childPage: (p, after, limit) => at(() => r.childPage(p, after, limit)),
    stream: (staff, direction, from, limit) => at(() => r.stream(staff, direction, from, limit)),
    ...(r.predecessorPage ? { predecessorPage: (staff: string, from: StreamPosition, certain: CertainBound | null, limit: number) => at(() => r.predecessorPage!(staff, from, certain, limit)) } : {}),
    pages: {
      membersPage: (o, after, limit) => at(() => r.pages.membersPage(o, after, limit)),
      byIdsPage: (ids) => at(() => r.pages.byIdsPage(ids)),
      childrenPage: (ids, after, limit) => at(() => r.pages.childrenPage(ids, after, limit)),
    },
  };
}

/** The qualified fresh attempt of one owner (simplification §4): did it start owner work, and did it make progress? */
interface FreshAttempt {
  started: boolean;
  progressed: boolean;
  /** A journal write failed in a way that may still have committed; cleared once recovery or a retry establishes the outcome. */
  unresolved: boolean;
}
/** Journal writes whose lost response may hide a committed change. */
const JOURNAL_WRITES = new Set(["open_reporting_owner_input", "checkpoint_reporting_owner_input"]);

/**
 * Plan-phase reads of one bounded owner group (T15P-4d steps 3-4). Every owner first runs its light read (one
 * activation watch per owner, kept across transient retries) with an allowance-bounded shared children view. An
 * activating owner waits for the group's single durable turn (never two durable owners at once), recovers or opens its
 * plan journal, continues the read from it and hashes its audiences one bounded unit at a time, every unit admitted
 * first (simplification §2-3): CAPACITY from exactly counted calls only; PARKING from this invocation's observed wall
 * time. No CPU measurement takes part in either. A light owner never touches the journal. Results come back in group
 * order, settled each on its own.
 */
async function routedGroup<I extends { owner: Owner; oldStaff: Iterable<string>; journaled?: boolean }, T>(
  env: WorkerEnv, b: Budget, a: ActiveBatch, routing: OwnerRouting,
  items: ReadonlyArray<I>, counts: Record<string, number>,
  attempt: FreshAttempt | null, purpose: "plan" | "stage",
  /** What to do with the owner's input, while its durable turn (if any) is still held. */
  finish: (o: OwnerReady<I>) => Promise<T>,
): Promise<Array<PromiseSettledResult<T>>> {
  const shared = sharedChildren(routing.base);
  let turn: Promise<void> = Promise.resolve();
  /** Wait for the group's durable turn; resolves to its release. */
  const durableTurn = (): Promise<() => void> => {
    let release!: () => void;
    const prev = turn;
    turn = new Promise<void>((r) => (release = r));
    return prev.then(() => release);
  };
  // journal, recovery and hash RPCs: the unit guard runs before EACH of them (a renewal due between a unit's calls is
  // taken at that call boundary, and no call starts without its own time plus the reserve)
  const jc: RpcClient = { rpc: async (fn, args) => {
    await routing.unitGuard();
    try {
      const out = await env.client.rpc(fn, args);
      if (out.error && attempt && JOURNAL_WRITES.has(fn) && isTransient(out.error)) attempt.unresolved = true;
      return out;
    } catch (e) {
      if (attempt && JOURNAL_WRITES.has(fn)) attempt.unresolved = true; // a network failure: the write may have landed
      throw e;
    }
  } };
  return Promise.allSettled(items.map(async (item) => {
    if (attempt) attempt.started = true;
    const progressed = () => {
      if (attempt) attempt.progressed = true;
    };
    const watch = activationWatch(item.owner, ACTIVATION_LIMITS);
    /** The watch's count when the current (retried) attempt began: transient duplicates are not fresh calls. */
    let attemptStart = 0;
    /**
     * The calls a FRESH standard invocation makes before this owner's next unit, kept current as its journal grows:
     * `fixed` = the restart prerequisites + this owner's no-failure light path + lookup; `reload` = the committed
     * journal's exact reload calls. Exact counts only (simplification §2).
     */
    const cost = { fixed: 0, reload: 0 };
    /** This invocation's largest COMPLETED unit of each kind for this owner (wall ms; absent until one completes). */
    const samples: Record<UnitKind, number | null> = { read: null, hash: null, stage: null };
    /** When the current read+commit leg started (its first admitted source read), until its commit is acknowledged. */
    let legStart: number | null = null;
    const admit = async (unit: AdmissionRecord["unit"], kind: UnitKind, freshUnitRpcs: number, currentRpcs: number) => {
      // a due renewal first, then ONE clock sample for every field of the decision; concurrent owners can use up the phase
      // between the renewal and the sample, so a sample that is already a full interval past the beat renews again
      let at = b.now();
      for (;;) {
        await routing.beat();
        at = b.now();
        if (b.sinceBeat(at) < HEARTBEAT_MS) break;
      }
      const remainingMs = b.remainingMs(at);
      const sinceBeatMs = b.sinceBeat(at);
      const fresh: FreshCalls = { fixed: cost.fixed, reload: cost.reload, unit: freshUnitRpcs };
      const wallMs = samples[kind] ?? FIRST_UNIT_WALL_MS;
      const v = admitUnit({ fresh, currentRpcs, wallMs }, remainingMs, sinceBeatMs);
      const action = v.verdict === "capacity" ? "fail" : v.verdict === "pending" ? "park" : "run";
      env.onAdmission?.({ owner: item.owner, unit, fresh, freshMs: v.freshMs, currentRpcs, wallMs, nowMs: at, remainingMs, sinceBeatMs, budgetMs: WORKER_BUDGET_MS, verdict: v.verdict, action, freshAttempt: !!attempt, progressed: attempt?.progressed ?? false });
      if (v.verdict === "capacity") throw new OwnerInputCapacityError(item.owner, v.freshMs, WORKER_BUDGET_MS);
      if (v.verdict === "pending") {
        counts.ownersParked = (counts.ownersParked ?? 0) + 1;
        throw new Parked();
      }
    };
    /** A durable source read: admitted at the minimum legal leg (the read plus a one-call commit); starts the leg's clock. */
    const read = <A extends unknown[], R>(f: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
      await admit("read", "read", READ_LEG_RPCS, READ_LEG_RPCS);
      if (legStart === null) legStart = b.now();
      return f(...args);
    };
    // the durable turn's release, the journal handle and whether the recovered journal was already complete
    const held: { release: (() => void) | null; handle: string | null; complete: boolean } = { release: null, handle: null, complete: false };
    let freshLight = 0;
    /** This attempt's committed position at its first recovery. */
    let startPos: string | null = null;
    const durable = async (): Promise<{ reader: FrozenReader & { pages: FrozenReaderPages }; journal: OwnerJournal; resume: OwnerJournalSnapshot | null } | { input: OwnerInput }> => {
          if (!held.release) {
            // counted at activation (a parked or failed owner is counted too)
            counts.ownersActivated = (counts.ownersActivated ?? 0) + 1;
            counts.activationCalls = Math.max(counts.activationCalls ?? 0, watch.calls);
            // the no-failure light path a fresh run would replay: the call limit when that is what triggered, otherwise
            // this attempt's own calls (rows/bytes are deduplicated, so they trigger at the same read as a fresh run)
            freshLight = watch.trigger() === "calls" ? ACTIVATION_LIMITS.calls : watch.calls - attemptStart;
            held.release = await durableTurn();
          }
          const rec = await recoverOwnerJournal(jc, a.batchId, a.fence, item.owner, routing.site, purpose);
          // the committed semantic position (pending pieces were discarded before this reload): a later recovery that
          // finds it advanced adopts progress a lost response hid; either way the outcome is now known
          const pos = JSON.stringify([rec.header.phase, rec.header.state, rec.header.eventCount, rec.header.hashesDone]);
          if (startPos === null) startPos = pos;
          else if (pos !== startPos) progressed();
          if (attempt) attempt.unresolved = false;
          cost.fixed = FIXED_PREREQUISITE_RPCS + freshLight + 1; // + lookup
          cost.reload = rec.reloadCalls;
          held.handle = rec.handle;
          held.complete = rec.header.phase === "complete";
          if (rec.input) return { input: rec.input }; // already read (hashing or complete): no source read, no second reload
          const journal = ownerJournal(jc, a.batchId, a.fence, rec.handle, rec.seq, routing.cutoffUs, rec.reloadCalls);
          const base = routing.durable;
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
                // the EXACT commit, known now that the page is: fresh = re-read + every call; now = the unpaid calls
                const calls = journal.pageCalls(pg);
                await admit("commit", "read", 1 + calls, calls);
                await journal.commit(pg);
                cost.reload = journal.reloadCalls;
                progressed();
                counts.durableUnits = (counts.durableUnits ?? 0) + 1;
                if (legStart !== null) samples.read = Math.max(samples.read ?? 0, b.now() - legStart);
                legStart = null;
              },
            },
            resume: rec.snapshot,
          };
    };
    try {
      const r: { input: OwnerInput; route: "light" | "durable" } = await b.retry(async () => {
        attemptStart = watch.calls;
        if (item.journaled && !held.release) {
          // a known durable owner (its journal exists) is recovered directly: no light attempt is repeated before it
          held.release = await durableTurn();
          counts.stageDurable = (counts.stageDurable ?? 0) + 1;
        }
        if (held.release) {
          const d = await durable();
          return { input: "input" in d ? d.input : await durableOwnerInput(d.reader, item.owner, d.journal, d.resume), route: "durable" as const };
        }
        const lr = await routedOwnerInput((before, share) => shared.forOwner(routing.light(before), share), item.owner, durable, ACTIVATION_LIMITS, watch);
        // a light owner's fresh path: the restart prerequisites, the stage lookup and its own no-failure light reads
        if (lr.route === "light") cost.fixed = FIXED_PREREQUISITE_RPCS + 1 + (watch.calls - attemptStart);
        return lr;
      });
      return await finish({
        item, input: r.input, route: r.route, complete: held.complete, handle: held.handle, admit, progressed,
        sample: (kind, ms) => void (samples[kind] = Math.max(samples[kind] ?? 0, ms)),
        resolved: () => void (attempt && (attempt.unresolved = false)),
        setReload: (n) => void (cost.reload = n),
        client: jc,
      });
    } finally {
      held.release?.();
    }
  }));
}

/** The admitted unit kinds whose completed wall samples are kept (per owner, per invocation). */
type UnitKind = "read" | "hash" | "stage";
/** One owner's input, ready for its phase's own work (inside the owner's durable turn, when it has one). */
interface OwnerReady<I> {
  item: I;
  input: OwnerInput;
  route: "light" | "durable";
  /** The recovered journal was already complete (no checkpoint is due), and its handle. */
  complete: boolean;
  handle: string | null;
  admit(unit: AdmissionRecord["unit"], kind: UnitKind, freshUnitRpcs: number, currentRpcs: number): Promise<void>;
  sample(kind: UnitKind, ms: number): void;
  progressed(): void;
  resolved(): void;
  setReload(n: number): void;
  /** The guarded client: the unit guard runs before every call. */
  client: RpcClient;
}

/** Planning's own work for one owner: its descriptors and, for a durable owner, its audience hashes (bounded units). */
function planFinish(env: WorkerEnv, b: Budget, a: ActiveBatch, routing: OwnerRouting, stats: MaterializeStats, counts: Record<string, number>) {
  return async (o: OwnerReady<{ owner: Owner; oldStaff: Iterable<string> }>): Promise<WorkDescriptor[]> => {
    // one audience projected at a time; only descriptors (identity + input hash) are kept for ordered planning
    const descs = ownerDescriptors(routing.base, o.item.owner, o.input, o.item.oldStaff, stats);
    if (o.route === "durable") {
      counts.ownersDurable = (counts.ownersDurable ?? 0) + 1;
      // a journal recovered complete needs no further checkpoint: it is reused as it is, never admitted for one
      if (!o.complete) {
        const hashes = descs.map((d) => ({ audienceKind: d.audienceKind, audienceStaff: d.audienceStaff, inputHash: d.inputHash }));
        for (;;) {
          await o.admit("hash", "hash", HASH_UNIT_RPCS, HASH_UNIT_RPCS);
          const h0 = b.now();
          const step = await b.retry(() => hashOwnerInputStep(o.client, a.batchId, a.fence, o.handle!, hashes));
          // committed hashes, or a completion a lost response hid (a journal recovered complete never enters this loop)
          o.progressed();
          o.resolved();
          o.sample("hash", b.now() - h0);
          if (step.result) o.setReload(step.result.reloadCalls);
          counts.durableUnits = (counts.durableUnits ?? 0) + 1;
          if (step.complete) break;
        }
      }
    }
    return descs;
  };
}

/**
 * Staging's own work for one owner (T15P-4 trim, step 6): each claimed audience is projected ONE at a time from the
 * owner's input, its input hash checked against the claimed descriptor, and only its MISSING chunks uploaded. Chunks
 * already stored (a lost reply, an interrupted invocation) are discovered and verified, never sent again; a stored
 * chunk that differs fails visibly without overwriting it. Each audience's discovery plus its first upload is admitted
 * as one unit (counted calls for capacity, observed wall time for parking); every RPC runs behind the unit guard.
 */
function stageFinish(b: Budget, a: ActiveBatch, routing: OwnerRouting, counts: Record<string, number>) {
  return async (o: OwnerReady<{ owner: Owner; oldStaff: Iterable<string>; works: ClaimedWork[] }>): Promise<void> => {
    let pending: StageEntry[] = [];
    const flush = async () => {
      for (const req of packStageRequests(pending)) await b.retry(() => stageReportingResults(o.client, a.batchId, a.fence, req));
      pending = [];
    };
    for (const c of o.item.works) {
      const audience: Parameters<typeof audienceWork>[3] = c.audienceKind === "site" ? { kind: "site" } : { kind: "self", staffId: c.audienceStaff! };
      const w = audienceWork(routing.base, o.item.owner, o.input, audience);
      if (w.desc.inputHash !== c.inputHash) throw new ReportingJobError(`claimed work ${c.workId}: the frozen input hash differs from the planned descriptor`);
      const chunks = buildChunks(w.rows);
      // discovery of s stored chunks takes floor(s / 1000) + 1 calls; none when the claim reports none stored
      const discovery = c.stagedChunks > 0 ? Math.floor(c.stagedChunks / 1000) + 1 : 0;
      await o.admit("stage", "stage", discovery + 1, discovery + 1);
      const t0 = b.now();
      const stored = new Map<number, string>();
      if (discovery) {
        let after: { work: string; chunk: number } | null = null;
        for (;;) {
          const page = await b.retry(() => readStagedChunks(o.client, a.batchId, a.fence, [c.workId], after, 1000));
          for (const x of page) stored.set(x.chunkNo, x.chunkHash);
          if (page.length < 1000) break;
          after = { work: c.workId, chunk: page[page.length - 1].chunkNo };
        }
      }
      for (const [n, h] of stored) {
        if (!chunks[n] || chunks[n].chunkHash !== h) throw new ReportingJobError(`claimed work ${c.workId}: a stored chunk differs from the frozen result (not overwritten)`);
      }
      for (const chunk of chunks) if (!stored.has(chunk.chunkNo)) pending.push({ partition: c.workId, chunk });
      counts.reusedChunks = (counts.reusedChunks ?? 0) + stored.size;
      counts.uploadedChunks = (counts.uploadedChunks ?? 0) + chunks.length - stored.size;
      // a durable owner keeps only one audience's output in memory; a light owner's small works share requests
      if (o.route === "durable") await flush();
      o.sample("stage", b.now() - t0);
    }
    await flush();
  };
}

/** ONE bounded release of a site's published journals; `more` is left for a later publication or cleanup (no loop). */
async function releasePass(env: WorkerEnv, site: ReportingSite, counts: Record<string, number>): Promise<void> {
  const r = await releaseOwnerInputs(env.client, site);
  counts.releasedJournalRows = (counts.releasedJournalRows ?? 0) + r.deleted;
  if (r.more) counts.releaseMore = 1;
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
async function stage(env: WorkerEnv, b: Budget, a: ActiveBatch, reader: FrozenReader, stats: MaterializeStats, counts: Record<string, number>, routing: OwnerRouting | null = null): Promise<boolean> {
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
        works: group,
      }));
      // T15P-4 trim step 6: ONE lookup per owner group tells which owners are durable. A durable owner's complete journal
      // is reused (never re-read light), one audience at a time, with only its MISSING chunks uploaded. Owners without
      // a journal were light in planning (small by construction) and keep the proven coalesced path.
      let journaled = items.map(() => false);
      if (routing) {
        const guarded: RpcClient = { rpc: async (fn, args) => (await routing.unitGuard(), env.client.rpc(fn, args)) };
        const found = await b.retry(() => lookupOwnerInputs(guarded, a.batchId, a.fence, items.map((x) => x.owner)));
        journaled = items.map((_, i) => !!found[i]?.journal);
      }
      const lightItems = items.filter((_, i) => !journaled[i]);
      const durableItems = items.filter((_, i) => journaled[i]).map((x) => ({ ...x, journaled: true }));
      const lightSettled = lightItems.length ? await materializeOwnerGroup(reader, lightItems, stats, (f) => b.retry(f)) : [];
      const durableSettled = routing && durableItems.length ? await routedGroup(env, b, a, routing, durableItems, counts, null, "stage", stageFinish(b, a, routing, counts)) : [];
      let li = 0;
      let di = 0;
      for (let k = 0; k < part.length; k++) {
        const group = part[k];
        if (journaled[k]) {
          const s = durableSettled[di++];
          if (s.status === "rejected") throw s.reason; // the first failure in claim order
          counts.staged = (counts.staged ?? 0) + group.length;
          continue;
        }
        const s = lightSettled[li++];
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
      // one bounded release pass, so a quiet site's published journals are also released (a failure is visible)
      if (b.fitsCall()) await releasePass(env, req.site, counts);
      out.state = "done";
    } else {
      // T15P-4d step 3: the 0046 owner-input protocol FIRST, before any batch work (a transient probe failure keeps its code
      // and goes through the bounded retry / Deferred path; only a missing or other version is unsupported)
      await b.retry(() => requireOwnerInputProtocol(env.client));
      const a = await acquire(env, b, req.site, req.mode, counts);
      if (!a) out.state = "busy";
      else {
        out.batchId = a.batchId;
        const copiedHere = a.kind === "rebuild" && a.state === "active";
        if (copiedHere) await copyAndFreeze(env, b, a, counts);
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
        // T15P-4d step 4: before EVERY durable source/journal/hash RPC, the next call plus the reserve must fit, then a due
        // renewal, then the same check again (a renewal can consume the time the call needed)
        const unitGuard = async () => {
          b.needCall();
          await b.beat(a.batchId, a.fence);
          b.needCall();
        };
        const beat = () => b.beat(a.batchId, a.fence);
        const routing: OwnerRouting | null = env.source
          ? hasPages(src.reader)
            ? { light: (before) => hookedReader(src.reader as FrozenReader & { pages: FrozenReaderPages }, async () => { await pageGuard(); await before(); }), base: hookedReader(src.reader, pageGuard), durable: hookedReader(src.reader, unitGuard), cutoffUs, site: req.site, unitGuard, beat }
            : null
          : { light: (before) => rpcFrozenReader(env.client, ref, { beforeRead: async () => { await before(); await pageGuard(); } }), base: materializing as FrozenReader & { pages: FrozenReaderPages }, durable: rpcFrozenReader(env.client, ref, { beforeRead: unitGuard }), cutoffUs, site: req.site, unitGuard, beat };
        const copied = a.kind === "rebuild" && copiedHere;
        const prog = await b.retry(() => readWorkerProgress(env.client, a.batchId, a.fence));
        if (!prog.sealed) {
          if (!prog.complete) await enumerate(env, b, a, src.reader, src.pages, prog.cursor, counts);
          // simplification §4: only a standard-budget invocation that did no copy or enumeration may make the fresh attempt
          const fresh = b.budgetMs === WORKER_BUDGET_MS && !copied && prog.complete;
          await plan(env, b, a, coalesced, stats, counts, routing, fresh);
          await seal(env, b, a, counts);
        }
        if (await stage(env, b, a, coalesced, stats, counts, routing)) {
          b.need();
          const p = await b.retry(() => publishReportingBatch(env.client, a.batchId, a.fence));
          out.generationId = p.generationId;
          counts.receipts = p.receipts;
          counts.acknowledged = p.acknowledged;
          out.state = "published";
          // T15P-4 trim step 7: AFTER publication, at most one bounded release of published journals, only if a call fits.
          // Housekeeping never turns a committed publication into a failure: a failed release is a safe warning.
          if (b.fitsCall()) {
            try {
              await releasePass(env, req.site, counts);
            } catch (e) {
              counts.releaseFailed = 1;
              problems.push(`owner input release deferred (${failureKind(e)})`);
            }
          }
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
    // allowlisted: the failure KIND only (a database error text may carry keys or payload); the returned diagnosis stays
    problems.push(`run log not recorded (${failureKind(e)})`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// T15P-4d step 2: phase-specific cumulative admission to the NEXT durable progress boundary (approval condition 3)
// ---------------------------------------------------------------------------

/** The deterministic RPC cost (ms) used by admission, and the run-record reserve kept back from every budget. */
export const ADMISSION_RPC_MS = 1_000;
export const ADMISSION_RESERVE_MS = 2_000;
/**
 * The calls a FRESH standard invocation makes to reach a unit's durable boundary: `fixed` (the restart prerequisites,
 * this owner's no-failure light path and lookup), `reload` (the committed journal's exact reload calls) and `unit` (the
 * unit itself including its committing call(s); a commit also re-reads its source page). Exact counts only.
 */
export interface FreshCalls { fixed: number; reload: number; unit: number }
/** One unit's admission inputs: its fresh calls (capacity), its unpaid calls now and the observed wall allowance (parking). */
export interface UnitAdmission { fresh: FreshCalls; currentRpcs: number; wallMs: number }
function admissionMs(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new ReportingJobError(`admission ${what} must be a finite non-negative number`);
  return v;
}
function admissionRpcs(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new ReportingJobError(`admission ${what} must be a non-negative safe integer`);
  return v;
}
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
export type AdmissionVerdict = { verdict: "run"; freshMs: number; nowMs: number } | { verdict: "pending"; freshMs: number; nowMs: number } | { verdict: "capacity"; freshMs: number };
/** The standard-invocation time of a fresh path: every counted call at ADMISSION_RPC_MS, its renewals and the reserve. */
export function freshCallsMs(c: FreshCalls): number {
  if (!c || typeof c !== "object") throw new ReportingJobError("admission fresh calls are missing");
  const total = admissionRpcs(c.fixed, "fresh.fixed") + admissionRpcs(c.reload, "fresh.reload") + admissionRpcs(c.unit, "fresh.unit");
  if (!Number.isSafeInteger(total * ADMISSION_RPC_MS)) throw new ReportingJobError("admission fresh calls overflow");
  return withRenewals(total * ADMISSION_RPC_MS, 0);
}
/**
 * Admit a unit (simplification §2-3): `capacity` (visible `owner_input_capacity`, evidence retained, publication
 * blocked) when its exactly counted fresh path exceeds the STANDARD budget, whatever this invocation's own deadline;
 * `pending` (the owner is parked first) when the unit's unpaid calls plus the observed wall allowance, with the renewals
 * due from the current phase and the reserve, exceed the time left now; otherwise `run`. No CPU value enters either.
 */
export function admitUnit(u: UnitAdmission, remainingMs: number, sinceBeatMs = 0): AdmissionVerdict {
  if (!u || typeof u !== "object") throw new ReportingJobError("admission input is malformed");
  admissionMs(remainingMs, "remainingMs");
  admissionMs(sinceBeatMs, "sinceBeatMs");
  if (sinceBeatMs >= HEARTBEAT_MS) throw new ReportingJobError("admission sinceBeatMs must be below the heartbeat interval (a due renewal is taken first)");
  const freshMs = freshCallsMs(u.fresh);
  if (freshMs > WORKER_BUDGET_MS) return { verdict: "capacity", freshMs };
  const nowMs = withRenewals(admissionRpcs(u.currentRpcs, "currentRpcs") * ADMISSION_RPC_MS + admissionMs(u.wallMs, "wallMs"), sinceBeatMs);
  return nowMs > remainingMs ? { verdict: "pending", freshMs, nowMs } : { verdict: "run", freshMs, nowMs };
}
/** Calls a fresh invocation makes before planning an owner: version, status, resume, progress and the owner page. */
export const FIXED_PREREQUISITE_RPCS = 5;
/** The startup a qualified fresh attempt may follow: just the fixed prerequisites at the nominal call cost (5,000 ms). */
export const FRESH_STARTUP_MS = withRenewals(FIXED_PREREQUISITE_RPCS * ADMISSION_RPC_MS, 0) - ADMISSION_RESERVE_MS;
/**
 * The smallest legal durable read: the source RPC plus a one-call commit. It can prove that even the minimum is over
 * budget; the page's EXACT commit is admitted again before its first call (`ownerJournal.pageCalls`).
 */
export const READ_LEG_RPCS = 1 + 1;
/** The wall allowance for a unit kind not yet completed by this owner in this invocation (never zero). */
export const FIRST_UNIT_WALL_MS = 1_000;
/** One hash unit: the pinned header load plus its hash checkpoint. */
export const HASH_UNIT_RPCS = 2;
/** An owner whose next durable unit cannot fit even a fresh invocation: visible, journal retained, publication blocked. */
export class OwnerInputCapacityError extends ReportingJobError {
  constructor(owner: Owner, freshMs: number, budgetMs: number, why = "the counted calls to its next durable boundary do not fit a fresh run") {
    // diagnostics carry only the owner KIND and the times, never the raw order/event key
    super(`owner_input_capacity: an ${owner.partitionKind} owner cannot progress: ${why} (${Math.ceil(freshMs)} ms of ${budgetMs} ms)`, "owner_input_capacity");
  }
}
/**
 * The invocation's qualified fresh attempt did not reach its first durable progress boundary within the guarded budget
 * (simplification §4). An observation of THIS attempt, not a proof of permanent incapacity: the journal is kept, the
 * batch stays resumable and publication is blocked. Diagnostics carry the owner KIND and counts only.
 */
export class OwnerInputNoProgressError extends ReportingJobError {
  constructor(owner: Owner, units: number) {
    super(`owner_input_no_progress: an ${owner.partitionKind} owner's fresh attempt did not reach its first durable progress boundary within the guarded budget (${units} durable units)`, "owner_input_no_progress");
  }
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
