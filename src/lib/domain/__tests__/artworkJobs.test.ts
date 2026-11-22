import { describe, expect, it } from "vitest";
import {
  ARTWORK_JOB_POLICY,
  canPublish,
  createArtworkJob,
  maxClaims,
  pickNextJob,
  recordSourceEvidence,
  retryAt,
  transitionArtworkJob,
  type ArtworkJob,
  type ArtworkJobEvent,
  type ArtworkJobPriority,
} from "../artworkJobs";

const T0 = Date.UTC(2026, 10, 22, 6, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

function render(n = 3, over: Partial<Parameters<typeof createArtworkJob>[0]> = {}): ArtworkJob {
  return createArtworkJob(
    { id: "job-1", code: "S3WIL0049", kind: "render", generation: 4, revisionToken: "digest-a", sourceDirtyToken: "dirty-9", priority: "interactive", componentCount: n, ...over },
    T0,
  );
}

function resolveJob(): ArtworkJob {
  return createArtworkJob(
    { id: "job-r", code: "KAN0566", kind: "resolve", generation: 1, revisionToken: "gen:1", sourceDirtyToken: "dirty-1", priority: "replacement", componentCount: 0 },
    T0,
  );
}

/** Apply an event that must succeed. */
function apply(job: ArtworkJob, event: ArtworkJobEvent, now: number): ArtworkJob {
  const r = transitionArtworkJob(job, event, now);
  if (r.outcome !== "applied") throw new Error(`${event.type} not applied: ${JSON.stringify(r)}`);
  return r.job;
}

const claim = (owner = "w1"): ArtworkJobEvent => ({ type: "claim", owner, generationEnabled: true });
const token = (job: ArtworkJob) => job.lease!.token;
const retryable = { class: "retryable" as const, reason: "dropbox_5xx" };

describe("retryAt", () => {
  it("uses 30s, 2m, 10m, 1h, 6h for failures 1–5", () => {
    expect([1, 2, 3, 4, 5].map((f) => retryAt(f, T0, 0, null) - T0)).toEqual([30 * SEC, 2 * MIN, 10 * MIN, HOUR, 6 * HOUR]);
  });

  it("adds bounded jitter only", () => {
    const hi = retryAt(1, T0, 0.999999, null) - T0;
    expect(hi).toBeGreaterThan(30 * SEC);
    expect(hi).toBeLessThanOrEqual(30 * SEC * (1 + ARTWORK_JOB_POLICY.maxJitterFraction));
    expect(retryAt(1, T0, 5, null) - T0).toBeLessThanOrEqual(30 * SEC * (1 + ARTWORK_JOB_POLICY.maxJitterFraction)); // clamped
    expect(retryAt(1, T0, -1, null)).toBe(T0 + 30 * SEC);
    expect(retryAt(1, T0, Number.NaN, null)).toBe(T0 + 30 * SEC);
  });

  it("honours a longer Retry-After or shared cooldown, ignores a shorter one", () => {
    expect(retryAt(1, T0, 0, 10 * MIN)).toBe(T0 + 10 * MIN);
    expect(retryAt(3, T0, 0, 5 * SEC)).toBe(T0 + 10 * MIN);
  });

  it("refuses counts outside the retry ladder", () => {
    expect(() => retryAt(0, T0, 0, null)).toThrow(RangeError);
    expect(() => retryAt(6, T0, 0, null)).toThrow(RangeError);
  });
});

describe("transitionArtworkJob — happy path and checkpoints", () => {
  it("runs a 3-component render across invocations without spending failures", () => {
    let job = render(3);
    expect(job).toMatchObject({ status: "queued", claimCount: 0, failedExecutions: 0, completedSteps: 0, nextAttemptAt: T0 });

    let now = T0;
    for (let step = 1; step <= 4; step++) {
      job = apply(job, claim(), now);
      expect(job.status).toBe("running");
      job = apply(job, { type: "checkpoint", token: token(job), step }, now + SEC);
      if (step < 4) job = apply(job, { type: "yield", token: token(job), reason: "continue" }, now + 2 * SEC);
      now += 10 * SEC;
    }
    job = apply(job, { type: "succeed", token: token(job) }, now);
    expect(job).toMatchObject({ status: "succeeded", failedExecutions: 0, claimCount: 4, completedSteps: 4, lease: null });
  });

  it("issues a strictly increasing fencing token per claim", () => {
    let job = apply(render(), claim(), T0);
    const first = token(job);
    job = apply(job, { type: "checkpoint", token: first, step: 1 }, T0);
    job = apply(job, { type: "yield", token: first, reason: "continue" }, T0);
    job = apply(job, claim("w2"), T0);
    expect(token(job)).toBeGreaterThan(first);
    expect(job.lease).toMatchObject({ owner: "w2", expiresAt: T0 + ARTWORK_JOB_POLICY.leaseMs, checkpointed: false });
  });

  it("treats a repeated checkpoint as already applied and refuses skipped steps", () => {
    let job = apply(render(), claim(), T0);
    job = apply(job, { type: "checkpoint", token: token(job), step: 1 }, T0);
    expect(transitionArtworkJob(job, { type: "checkpoint", token: token(job), step: 1 }, T0)).toMatchObject({ outcome: "noop", reason: "already_applied" });
    expect(transitionArtworkJob(job, { type: "checkpoint", token: token(job), step: 3 }, T0)).toMatchObject({ outcome: "rejected", reason: "out_of_order" });
    // Publication is the success event, not a checkpoint.
    let full = job;
    for (const step of [2, 3, 4]) full = apply(full, { type: "checkpoint", token: token(full), step }, T0);
    expect(transitionArtworkJob(full, { type: "checkpoint", token: token(full), step: 5 }, T0)).toMatchObject({ outcome: "rejected", reason: "out_of_order" });
  });

  it("will not mark a render succeeded before composition is checkpointed", () => {
    let job = apply(render(2), claim(), T0);
    job = apply(job, { type: "checkpoint", token: token(job), step: 1 }, T0);
    expect(transitionArtworkJob(job, { type: "succeed", token: token(job) }, T0)).toMatchObject({ outcome: "rejected", reason: "incomplete" });
  });

  it("refuses a continuation that made no progress", () => {
    const job = apply(render(), claim(), T0);
    expect(transitionArtworkJob(job, { type: "yield", token: token(job), reason: "continue" }, T0)).toMatchObject({ outcome: "rejected", reason: "no_progress" });
  });

  it("does not claim work that is not due, and leaves a rejected job unchanged", () => {
    let job = apply(render(), claim(), T0);
    job = apply(job, { type: "fail", token: token(job), failure: retryable, jitter: 0 }, T0);
    const r = transitionArtworkJob(job, claim(), T0 + 29 * SEC);
    expect(r).toMatchObject({ outcome: "rejected", reason: "not_due" });
    expect(r.job).toBe(job);
    expect(apply(job, claim(), T0 + 30 * SEC).status).toBe("running");
  });
});

describe("transitionArtworkJob — failure budget", () => {
  it("fails visibly after six failed executions, never a seventh claim", () => {
    let job = render();
    let now = T0;
    for (let i = 1; i <= 5; i++) {
      job = apply(job, claim(), now);
      job = apply(job, { type: "fail", token: token(job), failure: retryable, jitter: 0 }, now);
      expect(job).toMatchObject({ status: "retry_wait", failedExecutions: i });
      now = job.nextAttemptAt;
    }
    job = apply(job, claim(), now);
    job = apply(job, { type: "fail", token: token(job), failure: retryable, jitter: 0 }, now);
    expect(job).toMatchObject({ status: "failed", failedExecutions: 6, lease: null, lastError: { class: "retryable", reason: "dropbox_5xx" } });
    expect(transitionArtworkJob(job, claim(), now + 7 * HOUR)).toMatchObject({ outcome: "rejected", reason: "invalid_status" });
  });

  it("fails validation/ambiguity immediately", () => {
    let job = apply(render(), claim(), T0);
    job = apply(job, { type: "fail", token: token(job), failure: { class: "permanent", reason: "unsupported_format" }, jitter: 0 }, T0);
    expect(job).toMatchObject({ status: "failed", failedExecutions: 1 });
  });

  it("puts missing-source resolution into waiting_source, bounded, then failed", () => {
    let job = resolveJob();
    let now = T0;
    for (let i = 1; i <= 6; i++) {
      job = apply(job, claim(), now);
      job = apply(job, { type: "fail", token: token(job), failure: { class: "missing_source", reason: "no_candidate" }, jitter: 0 }, now);
      now = job.nextAttemptAt;
    }
    expect(job).toMatchObject({ status: "failed", failedExecutions: 6, lastError: { class: "missing_source" } });
  });

  it("honours Retry-After on a failure", () => {
    let job = apply(render(), claim(), T0);
    job = apply(job, { type: "fail", token: token(job), failure: { ...retryable, retryAfterMs: 15 * MIN }, jitter: 0 }, T0);
    expect(job.nextAttemptAt).toBe(T0 + 15 * MIN);
  });

  it("takes no lease or attempt during an intentional provider cooldown", () => {
    const job = render();
    const r = transitionArtworkJob(job, { type: "claim", owner: "w1", generationEnabled: true, cooldownUntil: T0 + MIN }, T0);
    expect(r).toMatchObject({ outcome: "rejected", reason: "cooldown" });
    expect(r.job).toBe(job);
    expect(apply(job, { type: "claim", owner: "w1", generationEnabled: true, cooldownUntil: T0 }, T0).claimCount).toBe(1);
  });
});

describe("transitionArtworkJob — leases and fencing", () => {
  it("charges an expired, uncheckpointed claim exactly once (double expiry)", () => {
    let job = apply(render(), claim(), T0);
    const expiry = T0 + ARTWORK_JOB_POLICY.leaseMs;
    expect(transitionArtworkJob(job, { type: "expire", jitter: 0 }, expiry - 1)).toMatchObject({ outcome: "rejected", reason: "lease_active" });
    job = apply(job, { type: "expire", jitter: 0 }, expiry);
    expect(job).toMatchObject({ status: "retry_wait", failedExecutions: 1, lease: null, lastError: { reason: "lease_expired" } });
    expect(transitionArtworkJob(job, { type: "expire", jitter: 0 }, expiry + MIN)).toMatchObject({ outcome: "noop", reason: "not_running" });
    expect(job.failedExecutions).toBe(1);
  });

  it("re-queues an expired claim that checkpointed progress without a failure", () => {
    let job = apply(render(), claim(), T0);
    job = apply(job, { type: "checkpoint", token: token(job), step: 1 }, T0);
    job = apply(job, { type: "expire", jitter: 0 }, T0 + ARTWORK_JOB_POLICY.leaseMs);
    expect(job).toMatchObject({ status: "queued", failedExecutions: 0, completedSteps: 1, lease: null });
  });

  it("rejects fail/success/checkpoint from a stale or expired lease without changes", () => {
    let job = apply(render(1), claim("A"), T0);
    const a = token(job);
    job = apply(job, { type: "checkpoint", token: a, step: 1 }, T0);
    job = apply(job, { type: "checkpoint", token: a, step: 2 }, T0);
    // A's lease runs out; the job is reclaimed by B.
    expect(transitionArtworkJob(job, { type: "succeed", token: a }, T0 + ARTWORK_JOB_POLICY.leaseMs)).toMatchObject({ outcome: "rejected", reason: "lease_expired" });
    job = apply(job, { type: "expire", jitter: 0 }, T0 + ARTWORK_JOB_POLICY.leaseMs);
    job = apply(job, claim("B"), T0 + ARTWORK_JOB_POLICY.leaseMs);

    for (const event of [
      { type: "fail", token: a, failure: retryable, jitter: 0 },
      { type: "succeed", token: a },
      { type: "checkpoint", token: a, step: 3 },
      { type: "yield", token: a, reason: "paused" },
    ] as ArtworkJobEvent[]) {
      const r = transitionArtworkJob(job, event, T0 + ARTWORK_JOB_POLICY.leaseMs + SEC);
      expect(r).toMatchObject({ outcome: "rejected", reason: "stale_lease" });
      expect(r.job).toBe(job);
    }
    expect(apply(job, { type: "succeed", token: token(job) }, T0 + ARTWORK_JOB_POLICY.leaseMs + SEC).status).toBe("succeeded");
  });

  it("bounds a render to N+8 claims including failures", () => {
    const n = 2;
    let job = render(n);
    expect(maxClaims(job)).toBe(n + 8);
    let now = T0;
    // Worst case: every step is checkpointed and then the lease is lost, then every claim fails.
    for (let i = 0; i < 20 && job.status !== "failed"; i++) {
      job = apply(job, claim(), now);
      if (job.completedSteps < n + 1) job = apply(job, { type: "checkpoint", token: token(job), step: job.completedSteps + 1 }, now);
      now += ARTWORK_JOB_POLICY.leaseMs;
      job = apply(job, { type: "expire", jitter: 0 }, now);
      now = Math.max(now, job.nextAttemptAt);
    }
    expect(job).toMatchObject({ status: "failed", failedExecutions: 6, completedSteps: n + 1 });
    expect(job.claimCount).toBeLessThanOrEqual(n + 8);

    // The claim cap is the backstop: a queued job at the cap fails instead of being leased.
    const atCap = { ...render(n), claimCount: n + 8 };
    const r = transitionArtworkJob(atCap, claim(), T0);
    expect(r).toMatchObject({ outcome: "applied", job: { status: "failed", claimCount: n + 8, lease: null, lastError: { reason: "claim_budget_exhausted" } } });
  });
});

describe("pause, supersede, retry and generations", () => {
  it("pause denies claims and returns a running job without failure, keeping progress", () => {
    const queued = render();
    expect(transitionArtworkJob(queued, { type: "claim", owner: "w1", generationEnabled: false }, T0)).toMatchObject({ outcome: "rejected", reason: "paused" });

    let job = apply(queued, claim(), T0);
    job = apply(job, { type: "checkpoint", token: token(job), step: 1 }, T0);
    job = apply(job, { type: "yield", token: token(job), reason: "paused" }, T0 + SEC);
    expect(job).toMatchObject({ status: "queued", failedExecutions: 0, claimCount: 0, completedSteps: 1, lease: null });
  });

  it("supersedes older-generation work, including a running job, so its worker goes stale", () => {
    let job = apply(render(), claim(), T0);
    const old = token(job);
    job = apply(job, { type: "supersede", generation: 5 }, T0);
    expect(job).toMatchObject({ status: "superseded", lease: null });
    expect(transitionArtworkJob(job, { type: "succeed", token: old }, T0)).toMatchObject({ outcome: "rejected", reason: "stale_lease" });
    expect(transitionArtworkJob(job, { type: "supersede", generation: 6 }, T0)).toMatchObject({ outcome: "noop" });
    expect(transitionArtworkJob(render(), { type: "supersede", generation: 4 }, T0)).toMatchObject({ outcome: "noop", reason: "not_older" });
  });

  it("never supersedes a succeeded job (publication history is kept)", () => {
    let job = apply(render(1), claim(), T0);
    job = apply(job, { type: "checkpoint", token: token(job), step: 1 }, T0);
    job = apply(job, { type: "checkpoint", token: token(job), step: 2 }, T0);
    job = apply(job, { type: "succeed", token: token(job) }, T0);
    expect(transitionArtworkJob(job, { type: "supersede", generation: 9 }, T0)).toMatchObject({ outcome: "noop", reason: "terminal" });
  });

  it("audited retry resets selected failed work once per action id", () => {
    let job = apply(render(), claim(), T0);
    job = apply(job, { type: "fail", token: token(job), failure: { class: "permanent", reason: "corrupt" }, jitter: 0 }, T0);
    const retried = apply(job, { type: "admin_retry", actionId: "act-1" }, T0 + HOUR);
    expect(retried).toMatchObject({ status: "queued", failedExecutions: 0, claimCount: 0, nextAttemptAt: T0 + HOUR, lastRetryActionId: "act-1" });
    expect(transitionArtworkJob(retried, { type: "admin_retry", actionId: "act-1" }, T0 + HOUR)).toMatchObject({ outcome: "noop", reason: "already_applied" });
    expect(transitionArtworkJob(render(), { type: "admin_retry", actionId: "act-2" }, T0)).toMatchObject({ outcome: "noop", reason: "not_failed" });
  });

  it("new verified source evidence creates a new generation; unchanged reconcile does not", () => {
    const start = { desiredGeneration: 3, sourceEvidence: "missing:obs-1" };
    expect(recordSourceEvidence(start, "missing:obs-1")).toEqual({ state: start, changed: false });
    const next = recordSourceEvidence(start, "manifest:digest-b");
    expect(next).toEqual({ state: { desiredGeneration: 4, sourceEvidence: "manifest:digest-b" }, changed: true });
    expect(() => recordSourceEvidence(start, "")).toThrow(RangeError);
  });

  it("recovers a terminally failed missing-source job only through new evidence", () => {
    let job = resolveJob();
    let now = T0;
    for (let i = 0; i < 6; i++) {
      job = apply(job, claim(), now);
      job = apply(job, { type: "fail", token: token(job), failure: { class: "missing_source", reason: "no_candidate" }, jitter: 0 }, now);
      now = job.nextAttemptAt;
    }
    expect(job.status).toBe("failed");
    // Ordinary renders/reconciles carry the same evidence: nothing changes, the failure stands.
    const state = { desiredGeneration: 1, sourceEvidence: "missing:obs-1" };
    expect(recordSourceEvidence(state, "missing:obs-1").changed).toBe(false);
    // The file arrives.
    const { state: next } = recordSourceEvidence(state, "missing:obs-2");
    job = apply(job, { type: "supersede", generation: next.desiredGeneration }, now);
    expect(job.status).toBe("superseded");
    const fresh = createArtworkJob(
      { id: "job-r2", code: "KAN0566", kind: "resolve", generation: next.desiredGeneration, revisionToken: `gen:${next.desiredGeneration}`, sourceDirtyToken: "dirty-2", priority: "replacement", componentCount: 0 },
      now,
    );
    expect(fresh).toMatchObject({ status: "queued", failedExecutions: 0, claimCount: 0, generation: 2 });
  });
});

describe("canPublish", () => {
  function ready() {
    let job = apply(render(1), claim("A"), T0);
    for (const step of [1, 2]) job = apply(job, { type: "checkpoint", token: token(job), step }, T0);
    return job;
  }
  const desired = { generation: 4, revisionToken: "digest-a", sourceDirtyToken: "dirty-9" };
  const on = { generationEnabled: true };

  it("allows the current lease holder of the current revision", () => {
    const job = ready();
    expect(canPublish(job, desired, { owner: "A", token: token(job) }, on, T0 + SEC)).toBe(true);
  });

  it("refuses a newer generation, revision or dirty token (A held while B is desired)", () => {
    const job = ready();
    const lease = { owner: "A", token: token(job) };
    expect(canPublish(job, { ...desired, generation: 5 }, lease, on, T0)).toBe(false);
    expect(canPublish(job, { ...desired, revisionToken: "digest-b" }, lease, on, T0)).toBe(false);
    expect(canPublish(job, { ...desired, sourceDirtyToken: "dirty-10" }, lease, on, T0)).toBe(false);
  });

  it("refuses an expired, foreign or stale lease, a pause, and incomplete work", () => {
    const job = ready();
    const lease = { owner: "A", token: token(job) };
    expect(canPublish(job, desired, lease, on, T0 + ARTWORK_JOB_POLICY.leaseMs)).toBe(false);
    expect(canPublish(job, desired, { owner: "B", token: token(job) }, on, T0)).toBe(false);
    expect(canPublish(job, desired, { owner: "A", token: token(job) - 1 }, on, T0)).toBe(false);
    expect(canPublish(job, desired, lease, { generationEnabled: false }, T0)).toBe(false);
    const partial = apply(render(1), claim("A"), T0);
    expect(canPublish(partial, desired, { owner: "A", token: token(partial) }, on, T0)).toBe(false);
    expect(canPublish({ ...job, kind: "resolve" }, desired, lease, on, T0)).toBe(false);
  });
});

describe("pickNextJob — fair priority", () => {
  function due(id: string, priority: ArtworkJobPriority, at = T0): ArtworkJob {
    return { ...render(1, { id, priority }), nextAttemptAt: at };
  }

  it("serves interactive/replacement work first, oldest due first", () => {
    const jobs = [due("b1", "backfill", T0 - HOUR), due("r1", "replacement", T0 - MIN), due("i1", "interactive", T0)];
    expect(pickNextJob(jobs, 0, T0)?.id).toBe("r1");
    expect(pickNextJob([due("b1", "backfill")], 0, T0)?.id).toBe("b1");
    expect(pickNextJob([], 0, T0)).toBeNull();
  });

  it("ignores work that is not due or not claimable", () => {
    const later = due("i-later", "interactive", T0 + MIN);
    const running = { ...due("i-run", "interactive"), status: "running" as const };
    expect(pickNextJob([later, running, due("b1", "backfill")], 0, T0)?.id).toBe("b1");
  });

  it("reserves one of every ten dispatch slots for waiting backfill", () => {
    const live = Array.from({ length: 50 }, (_, i) => due(`i${i}`, "interactive"));
    const backfill = Array.from({ length: 50 }, (_, i) => due(`b${i}`, "backfill"));
    const picks = Array.from({ length: 100 }, (_, seq) => pickNextJob([...live, ...backfill], seq, T0)!.priority);
    expect(picks.filter((p) => p === "backfill")).toHaveLength(10);
    expect(picks.slice(0, 10)).toEqual([...Array(9).fill("interactive"), "backfill"]);
    // No backfill waiting: the reserved slot goes to live work.
    expect(pickNextJob(live, 9, T0)?.priority).toBe("interactive");
  });
});
