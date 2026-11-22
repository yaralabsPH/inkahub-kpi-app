/**
 * F3 artwork thumbnails — job state machine, retry ladder and fair
 * scheduling (pure, no I/O).
 *
 * The database (Task 7) must enforce exactly these rules in its predicates;
 * these functions and their tests are the reference fixtures. Time and jitter
 * are explicit inputs (ms since epoch / a number in [0, 1)).
 *
 * Budgets kept apart on purpose:
 *   - failedExecutions: at most 6 per job (one job = one revision or one
 *     resolution generation). Successful checkpoint continuations and pauses
 *     never count.
 *   - claimCount: at most N + 8 for an N-component render (N component steps,
 *     composition and publication, plus failures). A backstop so lease churn
 *     can never loop.
 *
 * An expired lease charges one failure exactly once, unless that claim
 * checkpointed progress: then the job is re-queued free, which stays bounded
 * because progress itself is bounded (N + 1 checkpoints).
 */

export const ARTWORK_JOB_POLICY = {
  maxFailedExecutions: 6,
  /** Delay after failure 1…5; failure 6 is terminal. */
  retryDelaysMs: [30_000, 120_000, 600_000, 3_600_000, 21_600_000] as readonly number[],
  /** Jitter adds at most this fraction of the delay. */
  maxJitterFraction: 0.2,
  leaseMs: 120_000,
  /** Claims allowed beyond N for a render (composition + publication + failures). */
  extraClaims: 8,
  /** Every tenth dispatch slot goes to waiting backfill. */
  backfillReserveEvery: 10,
} as const;

export type ArtworkJobStatus = "queued" | "waiting_source" | "running" | "retry_wait" | "succeeded" | "failed" | "superseded";
/** resolve: find/verify current sources for a code. render: convert, compose, publish one manifest. */
export type ArtworkJobKind = "resolve" | "render";
export type ArtworkJobPriority = "interactive" | "replacement" | "backfill";
export type FailureClass = "retryable" | "permanent" | "missing_source";

export interface ArtworkJobLease {
  owner: string;
  /** Fencing token; strictly increases per claim of this job. */
  token: number;
  expiresAt: number;
  /** Did this claim persist at least one checkpoint? */
  checkpointed: boolean;
}

export interface ArtworkJob {
  id: string;
  code: string;
  kind: ArtworkJobKind;
  /** Desired generation this job serves. */
  generation: number;
  /** Manifest digest for render jobs; a non-null resolution token (e.g. `gen:4`) for resolve jobs. */
  revisionToken: string;
  /** Source-dirty token observed when the job was created. */
  sourceDirtyToken: string;
  priority: ArtworkJobPriority;
  /** N for a render; 0 for a resolve job. */
  componentCount: number;
  status: ArtworkJobStatus;
  claimCount: number;
  failedExecutions: number;
  /** Checkpointed steps: components 1…N, then composition as N + 1. */
  completedSteps: number;
  /** Highest fencing token issued. */
  fence: number;
  lease: ArtworkJobLease | null;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  lastError: { class: FailureClass; reason: string } | null;
  lastRetryActionId: string | null;
}

export interface JobFailure {
  class: FailureClass;
  /** Safe reason code; never a raw provider response. */
  reason: string;
  /** Provider Retry-After or shared cooldown remaining, ms. */
  retryAfterMs?: number | null;
}

export type ArtworkJobEvent =
  | { type: "claim"; owner: string; generationEnabled: boolean; cooldownUntil?: number | null }
  | { type: "checkpoint"; token: number; step: number }
  | { type: "yield"; token: number; reason: "continue" | "paused" }
  | { type: "fail"; token: number; failure: JobFailure; jitter: number }
  | { type: "succeed"; token: number }
  | { type: "expire"; jitter: number }
  | { type: "supersede"; generation: number }
  | { type: "admin_retry"; actionId: string };

export type TransitionRejection =
  | "not_due"
  | "paused"
  | "cooldown"
  | "invalid_status"
  | "stale_lease"
  | "lease_expired"
  | "lease_active"
  | "out_of_order"
  | "incomplete"
  | "no_progress";

export type TransitionNoop = "already_applied" | "not_running" | "not_older" | "terminal" | "not_failed";

/** `rejected` and `noop` always return the input job unchanged. */
export type TransitionResult =
  | { outcome: "applied"; job: ArtworkJob }
  | { outcome: "noop"; job: ArtworkJob; reason: TransitionNoop }
  | { outcome: "rejected"; job: ArtworkJob; reason: TransitionRejection };

export interface NewArtworkJob {
  id: string;
  code: string;
  kind: ArtworkJobKind;
  generation: number;
  revisionToken: string;
  sourceDirtyToken: string;
  priority: ArtworkJobPriority;
  componentCount: number;
}

export function createArtworkJob(input: NewArtworkJob, now: number): ArtworkJob {
  if (!input.revisionToken) throw new RangeError("revisionToken must be non-empty (resolution jobs use a generation token)");
  if (!Number.isInteger(input.generation) || input.generation < 1) throw new RangeError("generation must be a positive integer");
  const n = input.componentCount;
  if (input.kind === "render" ? !Number.isInteger(n) || n < 1 : n !== 0) {
    throw new RangeError(`componentCount ${n} is invalid for a ${input.kind} job`);
  }
  return {
    ...input,
    status: "queued",
    claimCount: 0,
    failedExecutions: 0,
    completedSteps: 0,
    fence: 0,
    lease: null,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
    lastError: null,
    lastRetryActionId: null,
  };
}

export function maxClaims(job: Pick<ArtworkJob, "componentCount">): number {
  return job.componentCount + ARTWORK_JOB_POLICY.extraClaims;
}

/** Checkpointable steps before success: N components + composition; none for resolve. */
function checkpointSteps(job: ArtworkJob): number {
  return job.kind === "render" ? job.componentCount + 1 : 0;
}

/**
 * Next attempt time after the `failedExecutions`-th failure (1…5).
 * Jitter adds up to 20 % of the delay; a longer Retry-After/cooldown wins.
 */
export function retryAt(failedExecutions: number, now: number, jitter: number, retryAfter: number | null | undefined): number {
  const delays = ARTWORK_JOB_POLICY.retryDelaysMs;
  if (!Number.isInteger(failedExecutions) || failedExecutions < 1 || failedExecutions > delays.length) {
    throw new RangeError(`no retry after failure ${failedExecutions}; ${ARTWORK_JOB_POLICY.maxFailedExecutions} is terminal`);
  }
  const j = Number.isFinite(jitter) ? Math.min(Math.max(jitter, 0), 1) : 0;
  const base = delays[failedExecutions - 1];
  const jittered = base + Math.floor(base * ARTWORK_JOB_POLICY.maxJitterFraction * j);
  const providerDelay = typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0;
  return now + Math.max(jittered, providerDelay);
}

const CLAIMABLE: ReadonlySet<ArtworkJobStatus> = new Set(["queued", "waiting_source", "retry_wait"]);
const TERMINAL: ReadonlySet<ArtworkJobStatus> = new Set(["succeeded", "superseded"]);

export function isClaimable(job: ArtworkJob, now: number): boolean {
  return CLAIMABLE.has(job.status) && job.nextAttemptAt <= now;
}

function rejected(job: ArtworkJob, reason: TransitionRejection): TransitionResult {
  return { outcome: "rejected", job, reason };
}
function noop(job: ArtworkJob, reason: TransitionNoop): TransitionResult {
  return { outcome: "noop", job, reason };
}
function applied(job: ArtworkJob, changes: Partial<ArtworkJob>, now: number): TransitionResult {
  return { outcome: "applied", job: { ...job, ...changes, updatedAt: now } };
}

/** Lease check for worker events: current token, unexpired, job still running. */
function leaseProblem(job: ArtworkJob, token: number, now: number): TransitionRejection | null {
  if (job.status !== "running" || !job.lease || job.lease.token !== token) return "stale_lease";
  if (job.lease.expiresAt <= now) return "lease_expired";
  return null;
}

/** Record one failed execution; terminal at the sixth or for permanent errors. */
function failure(job: ArtworkJob, f: JobFailure, jitter: number, now: number): TransitionResult {
  const failedExecutions = job.failedExecutions + 1;
  const lastError = { class: f.class, reason: f.reason };
  if (f.class === "permanent" || failedExecutions >= ARTWORK_JOB_POLICY.maxFailedExecutions) {
    return applied(job, { status: "failed", failedExecutions, lease: null, lastError }, now);
  }
  return applied(
    job,
    {
      status: f.class === "missing_source" ? "waiting_source" : "retry_wait",
      failedExecutions,
      lease: null,
      lastError,
      nextAttemptAt: retryAt(failedExecutions, now, jitter, f.retryAfterMs),
    },
    now,
  );
}

export function transitionArtworkJob(job: ArtworkJob, event: ArtworkJobEvent, now: number): TransitionResult {
  switch (event.type) {
    case "claim": {
      if (!CLAIMABLE.has(job.status)) return rejected(job, "invalid_status");
      if (job.nextAttemptAt > now) return rejected(job, "not_due");
      if (!event.generationEnabled) return rejected(job, "paused");
      if (event.cooldownUntil != null && event.cooldownUntil > now) return rejected(job, "cooldown");
      if (job.claimCount >= maxClaims(job)) {
        return applied(job, { status: "failed", lease: null, lastError: { class: "permanent", reason: "claim_budget_exhausted" } }, now);
      }
      const token = job.fence + 1;
      return applied(
        job,
        {
          status: "running",
          claimCount: job.claimCount + 1,
          fence: token,
          lease: { owner: event.owner, token, expiresAt: now + ARTWORK_JOB_POLICY.leaseMs, checkpointed: false },
        },
        now,
      );
    }

    case "checkpoint": {
      const problem = leaseProblem(job, event.token, now);
      if (problem) return rejected(job, problem);
      if (Number.isInteger(event.step) && event.step >= 1 && event.step <= job.completedSteps) return noop(job, "already_applied");
      if (event.step !== job.completedSteps + 1 || event.step > checkpointSteps(job)) return rejected(job, "out_of_order");
      return applied(job, { completedSteps: event.step, lease: { ...job.lease!, checkpointed: true } }, now);
    }

    case "yield": {
      const problem = leaseProblem(job, event.token, now);
      if (problem) return rejected(job, problem);
      if (event.reason === "paused") {
        // Pause is not the job's fault: refund the claim, keep progress, no failure.
        return applied(job, { status: "queued", lease: null, claimCount: job.claimCount - 1, nextAttemptAt: now }, now);
      }
      if (!job.lease!.checkpointed) return rejected(job, "no_progress");
      return applied(job, { status: "queued", lease: null, nextAttemptAt: now }, now);
    }

    case "fail": {
      const problem = leaseProblem(job, event.token, now);
      if (problem) return rejected(job, problem);
      return failure(job, event.failure, event.jitter, now);
    }

    case "succeed": {
      const problem = leaseProblem(job, event.token, now);
      if (problem) return rejected(job, problem);
      if (job.completedSteps < checkpointSteps(job)) return rejected(job, "incomplete");
      return applied(job, { status: "succeeded", lease: null, lastError: null }, now);
    }

    case "expire": {
      if (job.status !== "running" || !job.lease) return noop(job, "not_running");
      if (job.lease.expiresAt > now) return rejected(job, "lease_active");
      if (job.lease.checkpointed) return applied(job, { status: "queued", lease: null, nextAttemptAt: now }, now);
      return failure(job, { class: "retryable", reason: "lease_expired" }, event.jitter, now);
    }

    case "supersede": {
      if (TERMINAL.has(job.status)) return noop(job, "terminal");
      if (event.generation <= job.generation) return noop(job, "not_older");
      return applied(job, { status: "superseded", lease: null }, now);
    }

    case "admin_retry": {
      if (job.lastRetryActionId === event.actionId) return noop(job, "already_applied");
      if (job.status !== "failed") return noop(job, "not_failed");
      // Checkpoints stay: they belong to the same revision and are revalidated on reuse.
      return applied(
        job,
        { status: "queued", failedExecutions: 0, claimCount: 0, lease: null, nextAttemptAt: now, lastRetryActionId: event.actionId },
        now,
      );
    }
  }
}

export interface PublishDesired {
  generation: number;
  revisionToken: string;
  sourceDirtyToken: string;
}

/**
 * May this worker publish now? Every check must hold in the same transaction
 * as the pointer write (Task 7): current lease and fence, unexpired, all
 * steps checkpointed, still the desired generation/revision/dirty token, and
 * generation not paused.
 */
export function canPublish(
  job: ArtworkJob,
  desired: PublishDesired,
  lease: { owner: string; token: number },
  controls: { generationEnabled: boolean },
  now: number,
): boolean {
  return (
    job.kind === "render" &&
    controls.generationEnabled &&
    leaseProblem(job, lease.token, now) === null &&
    job.lease!.owner === lease.owner &&
    job.completedSteps >= checkpointSteps(job) &&
    job.generation === desired.generation &&
    job.revisionToken === desired.revisionToken &&
    job.sourceDirtyToken === desired.sourceDirtyToken
  );
}

/** Per-artwork evidence of the current source state. */
export interface ArtworkGenerationState {
  desiredGeneration: number;
  /** Fingerprint of the last verified source evidence (manifest digest, or a missing/ambiguous observation). */
  sourceEvidence: string | null;
}

/**
 * New verified evidence starts a new monotonic generation; repeating the same
 * evidence (renders, unchanged reconciles) changes nothing, so a terminal
 * failure stands until the source really changes or an owner/manager retries.
 */
export function recordSourceEvidence(state: ArtworkGenerationState, evidence: string): { state: ArtworkGenerationState; changed: boolean } {
  if (!evidence) throw new RangeError("source evidence must be non-empty");
  if (state.sourceEvidence === evidence) return { state, changed: false };
  return { state: { desiredGeneration: state.desiredGeneration + 1, sourceEvidence: evidence }, changed: true };
}

function byDue(a: ArtworkJob, b: ArtworkJob): number {
  return a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Choose the next job to dispatch. Interactive and replacement work share the
 * first tier, oldest due first; every tenth slot (`dispatchSeq % 10 === 9`)
 * goes to waiting backfill so the launch run is never starved. `dispatchSeq`
 * is a durable shared counter. Quotas/budgets are checked separately and
 * apply to both tiers.
 */
export function pickNextJob(jobs: readonly ArtworkJob[], dispatchSeq: number, now: number): ArtworkJob | null {
  const eligible = jobs.filter((j) => isClaimable(j, now));
  const live = eligible.filter((j) => j.priority !== "backfill").sort(byDue);
  const backfill = eligible.filter((j) => j.priority === "backfill").sort(byDue);
  const reserved = dispatchSeq % ARTWORK_JOB_POLICY.backfillReserveEvery === ARTWORK_JOB_POLICY.backfillReserveEvery - 1;
  if (reserved && backfill.length > 0) return backfill[0];
  return live[0] ?? backfill[0] ?? null;
}
