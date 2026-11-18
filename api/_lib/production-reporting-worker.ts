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
import { coalescingChildren, isoOfMicros, KEY_WALK_PAGES, materializeOwnerGroup, ownerKey, PartitionTooLargeError, walkChangedKey, type CertainBound, type FrozenReader, type KeyWalkPages, type MaterializeStats, type Owner, type StreamPosition } from "./production-reporting-materialize.js";
import { imageToEvent, rpcEnumerationPages, rpcFrozenReader, type EnumerationPages, type FrozenBatchRef } from "./production-reporting-reader.js";
import { beginReportingBatch, beginReportingRebuild, copyReportingSourcePage, freezeReportingRebuild, getReportingJobStatus, renewReportingLease, ReportingJobError, resumeReportingBatch, type ReportingSite, type RpcClient } from "./reporting-jobs.js";
import { publishReportingBatch } from "./reporting-publish.js";
import { buildChunks, claimReportingWork, packStageRequests, stageReportingResults, type StageEntry } from "./reporting-stage.js";
import { cleanupHistory, listWorkerOwners, manifestFromSaved, planOwner, readWalkLine, readWorkerProgress, recordRun, saveEnumeration, saveWalk, sealWithManifest, verifyPlan, type EnumCursor, type OwnerDiscovery } from "./reporting-worker-state.js";

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
export function failureKind(e: unknown): string {
  if (e instanceof PartitionTooLargeError) return "partition_too_large";
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

/** One invocation's clock, budget, heartbeat and bounded retries. */
class Budget {
  private lastBeat: number;
  constructor(private readonly env: WorkerEnv, private readonly deadline: number) {
    this.lastBeat = env.now();
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
async function plan(env: WorkerEnv, b: Budget, a: ActiveBatch, reader: FrozenReader, stats: MaterializeStats, counts: Record<string, number>): Promise<void> {
  const size = ownerGroupSize(env);
  for (;;) {
    b.need();
    const owners = await b.retry(() => listWorkerOwners(env.client, a.batchId, a.fence, true, null, PLAN_PAGE));
    if (!owners.length) return;
    for (let i = 0; i < owners.length; i += size) {
      b.need();
      await b.beat(a.batchId, a.fence);
      const group = owners.slice(i, i + size);
      const settled = await materializeOwnerGroup(reader, group, stats, (f) => b.retry(f));
      for (let k = 0; k < group.length; k++) {
        const s = settled[k];
        if (s.status === "rejected") throw s.reason;
        await b.beat(a.batchId, a.fence);
        await b.retry(() => planOwner(env.client, a.batchId, a.fence, group[k].owner, s.value.map((w) => w.desc)));
        counts.ownersPlanned = (counts.ownersPlanned ?? 0) + 1;
      }
    }
  }
}
const ownerGroupSize = (env: WorkerEnv) => Math.max(1, Math.min(env.ownerGroup ?? OWNER_GROUP, 32));

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
  const b = new Budget(env, t0 + (req.deadlineMs ?? WORKER_BUDGET_MS));
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
        };
        const src = env.source ? env.source(ref, pageGuard) : { reader: rpcFrozenReader(env.client, ref), pages: rpcEnumerationPages(env.client, ref) };
        // Planning and staging materialize owner groups over ONE coalescing view of the frozen reads (enumeration stays sequential
        // on the unguarded reader, with its own per-page checks). For the production RPC reader, the guard also runs before
        // EACH internal page (members/byIds/children pages, coalesced flushes, fallbacks, 0045), so one long owner can neither
        // starve the 30 s heartbeat nor run past the 240 s budget (OutOfTime -> pending, owners before it kept). The outer guard
        // stays for injected readers and non-RPC work.
        const materializing = env.source ? src.reader : rpcFrozenReader(env.client, ref, { beforeRead: pageGuard });
        const coalesced = guardedReader(coalescingChildren(materializing), pageGuard);
        const prog = await b.retry(() => readWorkerProgress(env.client, a.batchId, a.fence));
        if (!prog.sealed) {
          if (!prog.complete) await enumerate(env, b, a, src.reader, src.pages, prog.cursor, counts);
          await plan(env, b, a, coalesced, stats, counts);
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
