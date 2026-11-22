/**
 * F6 shared scanner stations: the durable device queue.
 *
 * A scan is accepted only after its job is written to IndexedDB. The job
 * then moves queued -> prepared -> done (or blocked), and is never edited
 * once prepared: a retry after an unknown outcome resends exactly the same
 * request id and payload, and the server's receipt answers it.
 *
 * Jobs are scoped to backend + signed-in account + site + receiver and only
 * ever drained under that exact scope. Several tabs can share the queue:
 * every state change runs inside one IndexedDB transaction, and a short
 * lease stops two tabs sending the same job at once (the server receipt
 * makes even that harmless).
 *
 * The storage is behind JobStore so the logic is tested with an in-memory
 * store; `dexieJobStore` is the browser implementation.
 */
import Dexie, { type Table } from "dexie";
import { z } from "zod";
import type { CapturedOrder } from "./session";
import type { PreparedFraming } from "./order";
import { applyChoices, CHOICE_CODES, isPreparedDispatch, type FramerChoice, type PreparedDispatch, type ScanMode } from "./dispatch";

/** Unfinished jobs (queued, prepared, blocked, unreadable) a device may hold. */
export const MAX_ACTIVE_JOBS = 200;
/** Finished jobs kept per scope for the recent-results list. */
export const KEEP_FINISHED = 50;
export const LEASE_MS = 60_000;

export type JobStatus = "queued" | "prepared" | "blocked" | "done" | "dismissed";

export interface JobScope {
  backend: "supabase";
  callerId: string;
  location: string;
  receiverId: string;
}

export function scopeKey(s: JobScope): string {
  return [s.backend, s.callerId, s.location, s.receiverId].join("|");
}

/**
 * F7: dispatch jobs carry this suffix on their scope. The F6 app only ever
 * claims the exact scope key, so after a rollback to it a queued dispatch
 * job is kept but never sent as framing work. Framing jobs (old and new)
 * keep the unchanged F6 key.
 */
export const DISPATCH_SCOPE_SUFFIX = "|dispatch";

export function jobScopeKey(s: JobScope, mode: ScanMode): string {
  return mode === "dispatch" ? scopeKey(s) + DISPATCH_SCOPE_SUFFIX : scopeKey(s);
}

function inScopeKey(jobScope: string, key: string): boolean {
  return jobScope === key || jobScope === key + DISPATCH_SCOPE_SUFFIX;
}

/**
 * F7: the OLDEST dispatch job waiting for a framer choice that can still be
 * changed (nothing possibly saved). One at a time; the rest stay queued.
 */
export function firstWaitingChoice(jobs: readonly ScannerJob[]): (ScannerJob & { prepared: PreparedDispatch }) | null {
  const waiting = jobs
    .filter((j) => jobMode(j) === "dispatch" && j.status === "blocked" && !!j.blocked && CHOICE_CODES.has(j.blocked.code)
      && !j.uncertain && !(j.priorUnknown ?? false) && isPreparedDispatch(j.prepared))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return (waiting[0] as (ScannerJob & { prepared: PreparedDispatch }) | undefined) ?? null;
}

/** Jobs written before F7 have no mode: they are framing jobs. */
export function jobMode(job: Pick<ScannerJob, "mode">): ScanMode {
  return job.mode === "dispatch" ? "dispatch" : "framing";
}

export interface JobBlock {
  code: string;
  message: string;
  stage: "prepare" | "commit";
}

export interface JobOutcome {
  kind: "saved" | "already_recorded";
  message: string;
  pieces: number;
  warnings: string[];
}

export interface ScannerJob extends JobScope {
  requestId: string;
  scope: string;
  /** F7. Absent on F6 jobs (= framing). Captured at scan time; delivery never uses the screen's mode. */
  mode?: ScanMode;
  scannerId: string;
  personId: string;
  displayName: string;
  badge: string;
  /** Original scan time, UTC ISO. */
  scannedAt: string;
  orderNumber: string;
  status: JobStatus;
  /**
   * Exact payload committed; immutable once a commit may have been sent.
   * (F7: a dispatch job waiting for a framer choice is definitely unsent and
   * changes only through chooseFramers.)
   */
  prepared: PreparedFraming | PreparedDispatch | null;
  /** Commit requests sent. */
  attempts: number;
  /**
   * A commit may have been saved and that is not yet settled. Set when a
   * commit is sent; cleared only by a saved/already-recorded answer, or by a
   * refusal of the FIRST attempt. A refusal after an earlier unanswered
   * attempt does not settle it (that earlier attempt may have saved).
   */
  uncertain: boolean;
  /** An earlier commit attempt never got a definite answer. */
  priorUnknown?: boolean;
  /** Failed attempts of any kind, for back-off. */
  tries: number;
  nextAttemptAt: number;
  lastError: string | null;
  blocked: JobBlock | null;
  outcome: JobOutcome | null;
  leaseOwner: string | null;
  leaseUntil: number;
  createdAt: string;
  updatedAt: string;
}

const JobSchema = z.object({
  requestId: z.string().uuid(),
  scope: z.string().min(1),
  mode: z.enum(["framing", "dispatch"]).optional(),
  backend: z.literal("supabase"),
  callerId: z.string().min(1),
  location: z.string().min(1),
  receiverId: z.string().min(1),
  scannerId: z.string().min(1),
  personId: z.string().min(1),
  displayName: z.string(),
  badge: z.string().min(1),
  scannedAt: z.string().min(1),
  orderNumber: z.string().regex(/^10\d{6}$/),
  status: z.enum(["queued", "prepared", "blocked", "done", "dismissed"]),
  prepared: z.unknown().nullable(),
  attempts: z.number().int().min(0),
  uncertain: z.boolean(),
  priorUnknown: z.boolean().optional(),
  tries: z.number().int().min(0),
  nextAttemptAt: z.number(),
  lastError: z.string().nullable(),
  blocked: z.object({ code: z.string(), message: z.string(), stage: z.enum(["prepare", "commit"]) }).nullable(),
  outcome: z.unknown().nullable(),
  leaseOwner: z.string().nullable(),
  leaseUntil: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** A stored row that does not read back as a job. Kept and shown, never dropped. */
export interface CorruptRow {
  key: string;
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface JobTx {
  get(requestId: string): Promise<unknown | undefined>;
  put(job: ScannerJob): Promise<void>;
  delete(requestId: string): Promise<void>;
  /** Every stored row (all scopes), for bounds and corruption checks. */
  all(): Promise<Array<{ key: string; value: unknown }>>;
}

export interface JobStore {
  tx<T>(fn: (t: JobTx) => Promise<T>): Promise<T>;
}

export class OutboxStorageError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "OutboxStorageError";
  }
}

/** Another tab (or a later claim by this tab) owns the job now. */
export class LeaseLostError extends Error {
  constructor() {
    super("Another tab took over this queued scan.");
    this.name = "LeaseLostError";
  }
}

export class OutboxFullError extends Error {
  constructor() {
    super(`The device queue is full (${MAX_ACTIVE_JOBS} unfinished scans). Resolve blocked scans before scanning more.`);
    this.name = "OutboxFullError";
  }
}

class ScannerOutboxDB extends Dexie {
  jobs!: Table<ScannerJob, string>;
  constructor() {
    super("inka-scanner-outbox");
    this.version(1).stores({ jobs: "&requestId, scope, status, createdAt" });
  }
}

let dexieDb: ScannerOutboxDB | null = null;

/** The browser store. Any IndexedDB failure becomes an OutboxStorageError. */
export function dexieJobStore(): JobStore {
  return {
    async tx<T>(fn: (t: JobTx) => Promise<T>): Promise<T> {
      try {
        if (!dexieDb) dexieDb = new ScannerOutboxDB();
        const db = dexieDb;
        return await db.transaction("rw", db.jobs, () =>
          fn({
            get: (id) => db.jobs.get(id),
            put: async (job) => {
              await db.jobs.put(job);
            },
            delete: (id) => db.jobs.delete(id),
            all: async () => {
              const rows: Array<{ key: string; value: unknown }> = [];
              await db.jobs.toCollection().each((value, cursor) => {
                rows.push({ key: String(cursor.primaryKey), value });
              });
              return rows;
            },
          }),
        );
      } catch (e) {
        if (e instanceof OutboxFullError || e instanceof OutboxStorageError || e instanceof LeaseLostError) throw e;
        throw new OutboxStorageError(`Device storage failed: ${e instanceof Error ? e.message : String(e)}`, e);
      }
    },
  };
}

/** In-memory store with serialized transactions (tests, and a failing-store double). */
export function memoryJobStore(opts: { failWrites?: () => boolean } = {}): JobStore & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  let chain: Promise<unknown> = Promise.resolve();
  return {
    rows,
    tx<T>(fn: (t: JobTx) => Promise<T>): Promise<T> {
      const run = async () => {
        // Work on a copy; commit only if fn succeeds (all-or-nothing like IndexedDB).
        const draft = new Map(rows);
        const t: JobTx = {
          get: async (id) => (draft.has(id) ? structuredClone(draft.get(id)) : undefined),
          put: async (job) => {
            if (opts.failWrites?.()) throw new Error("QuotaExceededError");
            draft.set(job.requestId, structuredClone(job));
          },
          delete: async (id) => {
            draft.delete(id);
          },
          all: async () => [...draft.entries()].map(([key, value]) => ({ key, value: structuredClone(value) })),
        };
        try {
          const out = await fn(t);
          rows.clear();
          for (const [k, v] of draft) rows.set(k, v);
          return out;
        } catch (e) {
          if (e instanceof OutboxFullError || e instanceof OutboxStorageError || e instanceof LeaseLostError) throw e;
          throw new OutboxStorageError(`Device storage failed: ${e instanceof Error ? e.message : String(e)}`, e);
        }
      };
      const p = chain.then(run, run);
      chain = p.catch(() => undefined);
      return p;
    },
  };
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

function readJob(value: unknown): ScannerJob | null {
  const r = JobSchema.safeParse(value);
  if (!r.success) return null;
  const job = value as ScannerJob;
  // Mode, scope suffix and payload must agree; anything else is shown as unreadable, never guessed.
  const dispatch = jobMode(job) === "dispatch";
  if (dispatch !== job.scope.endsWith(DISPATCH_SCOPE_SUFFIX)) return null;
  if (job.prepared !== null && isPreparedDispatch(job.prepared) !== dispatch) return null;
  return job;
}

const ACTIVE: ReadonlySet<JobStatus> = new Set(["queued", "prepared", "blocked"]);

export interface ScopeView {
  jobs: ScannerJob[];
  corrupt: CorruptRow[];
  waiting: number;
  blocked: number;
  uncertain: number;
}

export interface ScannerOutbox {
  enqueue(order: CapturedOrder, scope: JobScope, requestId: string, mode?: ScanMode): Promise<ScannerJob>;
  /**
   * Claim the next ready job. The returned job's `leaseOwner` is a fresh
   * per-claim lease token: pass it to every later step. Steps with a stale
   * token are refused (setPrepared/markAttempt throw LeaseLostError) or
   * ignored (markBlocked/retryLater), so a late answer from an expired claim
   * can never change a job another claim has moved on.
   */
  claimNext(scope: JobScope, owner: string): Promise<ScannerJob | null>;
  setPrepared(requestId: string, lease: string, prepared: PreparedFraming | PreparedDispatch): Promise<ScannerJob>;
  /**
   * F7: a dispatch job whose framed lines lack a measured framer. Stores the
   * unsent draft and blocks the job until the dispatcher chooses. False (and
   * nothing changed) when the lease is stale.
   */
  awaitChoice(requestId: string, lease: string, draft: PreparedDispatch, block: JobBlock): Promise<boolean>;
  /**
   * F7: the dispatcher's choice for one waiting job. Only a blocked dispatch
   * job with no possibly-saved attempt can change; anything else is refused.
   */
  chooseFramers(requestId: string, scope: JobScope, choices: readonly FramerChoice[]): Promise<void>;
  markAttempt(requestId: string, lease: string): Promise<ScannerJob>;
  /** Saved / already recorded: the server's truth, accepted from any claim; never undone. */
  markDone(requestId: string, outcome: JobOutcome): Promise<void>;
  /** Returns false (and changes nothing) when the lease is stale. */
  markBlocked(requestId: string, lease: string, block: JobBlock): Promise<boolean>;
  /** Returns false (and changes nothing) when the lease is stale. */
  retryLater(requestId: string, lease: string, error: string): Promise<boolean>;
  /**
   * Undo a markAttempt whose request was never sent (the station stopped in
   * between): restores the attempt count and uncertainty exactly as before
   * and releases the claim. The prepared payload is kept. False when stale.
   */
  releaseUnsent(requestId: string, lease: string, before: Pick<ScannerJob, "attempts" | "uncertain" | "priorUnknown">): Promise<boolean>;
  /** Operator: try a blocked job again (same request id, same payload once prepared). */
  retryBlocked(requestId: string, scope: JobScope): Promise<void>;
  /** Operator: give up on a blocked job and record it on the classic station instead. */
  dismiss(requestId: string, scope: JobScope): Promise<void>;
  view(scope: JobScope): Promise<ScopeView>;
}

export function createScannerOutbox(store: JobStore, now: () => number = Date.now): ScannerOutbox {
  const iso = () => new Date(now()).toISOString();

  const mustGet = async (t: JobTx, requestId: string): Promise<ScannerJob> => {
    const job = readJob(await t.get(requestId));
    if (!job) throw new OutboxStorageError(`Queued scan ${requestId} is missing or unreadable.`);
    return job;
  };

  let claims = 0;
  const live = (job: ScannerJob, lease: string) =>
    job.leaseOwner === lease && (job.status === "queued" || job.status === "prepared");

  const backoff = (tries: number) => Math.min(60_000, 2_000 * 2 ** Math.min(tries, 5));

  return {
    async enqueue(order, scope, requestId, mode = "framing") {
      return store.tx(async (t) => {
        const rows = await t.all();
        const active = rows.filter((r) => {
          const j = readJob(r.value);
          return !j || ACTIVE.has(j.status); // unreadable rows count: they are never silently dropped
        }).length;
        if (active >= MAX_ACTIVE_JOBS) throw new OutboxFullError();
        if (await t.get(requestId)) throw new OutboxStorageError(`Duplicate request id ${requestId}.`);
        const ts = iso();
        const job: ScannerJob = {
          ...scope,
          requestId,
          scope: jobScopeKey(scope, mode),
          ...(mode === "dispatch" ? { mode } : {}),
          scannerId: order.scannerId,
          personId: order.person.personId,
          displayName: order.person.displayName,
          badge: order.person.badge,
          scannedAt: new Date(order.scannedAt).toISOString(),
          orderNumber: order.orderNumber,
          status: "queued",
          prepared: null,
          attempts: 0,
          uncertain: false,
          priorUnknown: false,
          tries: 0,
          nextAttemptAt: 0,
          lastError: null,
          blocked: null,
          outcome: null,
          leaseOwner: null,
          leaseUntil: 0,
          createdAt: ts,
          updatedAt: ts,
        };
        await t.put(job);
        // Read back inside the transaction: a write that did not stick is a failure, not an acceptance.
        if (!readJob(await t.get(requestId))) throw new OutboxStorageError("The queued scan did not read back.");
        return job;
      });
    },

    async claimNext(scope, owner) {
      const key = scopeKey(scope);
      return store.tx(async (t) => {
        const at = now();
        const ready = (await t.all())
          .map((r) => readJob(r.value))
          .filter((j): j is ScannerJob =>
            !!j && inScopeKey(j.scope, key) && (j.status === "queued" || j.status === "prepared") &&
            j.nextAttemptAt <= at && (j.leaseOwner === null || j.leaseUntil <= at))
          .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
        const job = ready[0];
        if (!job) return null;
        const lease = `${owner}#${++claims}-${Math.random().toString(36).slice(2, 10)}`;
        const claimed: ScannerJob = { ...job, leaseOwner: lease, leaseUntil: at + LEASE_MS, updatedAt: iso() };
        await t.put(claimed);
        return claimed;
      });
    },

    async setPrepared(requestId, lease, prepared) {
      return store.tx(async (t) => {
        const job = await mustGet(t, requestId);
        if (!live(job, lease)) throw new LeaseLostError();
        if (job.prepared !== null || job.status !== "queued") {
          // Immutable: never replace a payload that may already have been sent.
          return job;
        }
        if (prepared.orderNumber !== job.orderNumber) throw new OutboxStorageError("Prepared order does not match the scan.");
        if (isPreparedDispatch(prepared) !== (jobMode(job) === "dispatch")) throw new OutboxStorageError("Prepared payload does not match the scan's mode.");
        const next: ScannerJob = { ...job, status: "prepared", prepared: JSON.parse(JSON.stringify(prepared)) as PreparedFraming | PreparedDispatch, updatedAt: iso() };
        await t.put(next);
        return next;
      });
    },

    async awaitChoice(requestId, lease, draft, block) {
      return store.tx(async (t) => {
        const job = await mustGet(t, requestId);
        if (!live(job, lease)) return false;
        // Nothing may have been saved for it: never sent, or every send was definitely refused.
        if (jobMode(job) !== "dispatch" || job.status !== "queued" || job.prepared !== null || job.uncertain || (job.priorUnknown ?? false)) {
          throw new OutboxStorageError("Only an unsent dispatch scan can wait for a framer choice.");
        }
        if (draft.orderNumber !== job.orderNumber || !CHOICE_CODES.has(block.code)) throw new OutboxStorageError("Framer choice does not match the scan.");
        await t.put({
          ...job, status: "blocked", prepared: JSON.parse(JSON.stringify(draft)) as PreparedDispatch, blocked: block,
          lastError: block.message, leaseOwner: null, leaseUntil: 0, updatedAt: iso(),
        });
        return true;
      });
    },

    async chooseFramers(requestId, scope, choices) {
      await store.tx(async (t) => {
        const job = await mustGet(t, requestId);
        if (!inScopeKey(job.scope, scopeKey(scope))) throw new OutboxStorageError("That scan belongs to another account, site or receiver.");
        // Pre-commit only: a send that may have saved freezes the payload (exact replay only).
        if (jobMode(job) !== "dispatch" || job.status !== "blocked" || !job.blocked || !CHOICE_CODES.has(job.blocked.code)
            || job.uncertain || (job.priorUnknown ?? false) || !isPreparedDispatch(job.prepared)) {
          throw new OutboxStorageError("This scan is not waiting for a framer choice.");
        }
        const applied = applyChoices(job.prepared, choices);
        if (!applied.ok) throw new OutboxStorageError(`Choose who framed every line without a framing scan (${applied.error}).`);
        await t.put({ ...job, status: "prepared", prepared: applied.prepared, blocked: null, lastError: null, tries: 0, nextAttemptAt: 0, updatedAt: iso() });
      });
    },

    async markAttempt(requestId, lease) {
      return store.tx(async (t) => {
        const job = await mustGet(t, requestId);
        if (!live(job, lease)) throw new LeaseLostError();
        if (job.status !== "prepared" || !job.prepared) throw new OutboxStorageError("Scan is not ready to send.");
        const next: ScannerJob = {
          ...job,
          attempts: job.attempts + 1,
          // Still uncertain from an earlier send that never got an answer?
          priorUnknown: (job.priorUnknown ?? false) || job.uncertain,
          uncertain: true,
          leaseUntil: now() + LEASE_MS,
          updatedAt: iso(),
        };
        await t.put(next);
        return next;
      });
    },

    async markDone(requestId, outcome) {
      await store.tx(async (t) => {
        const job = await mustGet(t, requestId);
        if (job.status === "done" || job.status === "dismissed") return; // never rewrite a finished job
        await t.put({ ...job, status: "done", uncertain: false, priorUnknown: false, outcome, blocked: null, lastError: null, leaseOwner: null, leaseUntil: 0, updatedAt: iso() });
        // Keep the finished history bounded per scope (oldest first out).
        const finished = (await t.all())
          .map((r) => readJob(r.value))
          .filter((j): j is ScannerJob => !!j && j.scope === job.scope && (j.status === "done" || j.status === "dismissed"))
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        for (const old of finished.slice(KEEP_FINISHED)) await t.delete(old.requestId);
      });
    },

    async markBlocked(requestId, lease, block) {
      return store.tx(async (t) => {
        const job = await mustGet(t, requestId);
        if (!live(job, lease)) return false; // a stale claim's answer: ignored
        // A refusal proves only that THIS attempt saved nothing. If an earlier
        // attempt went unanswered it may have saved: stay uncertain until a
        // retry gets the receipt's answer.
        const uncertain = block.stage === "commit" ? (job.priorUnknown ?? false) : job.uncertain;
        await t.put({ ...job, status: "blocked", uncertain, blocked: block, lastError: block.message, leaseOwner: null, leaseUntil: 0, updatedAt: iso() });
        return true;
      });
    },

    async releaseUnsent(requestId, lease, before) {
      return store.tx(async (t) => {
        const job = await mustGet(t, requestId);
        if (!live(job, lease)) return false;
        await t.put({
          ...job,
          attempts: before.attempts,
          uncertain: before.uncertain,
          priorUnknown: before.priorUnknown ?? false,
          leaseOwner: null,
          leaseUntil: 0,
          updatedAt: iso(),
        });
        return true;
      });
    },

    async retryLater(requestId, lease, error) {
      return store.tx(async (t) => {
        const job = await mustGet(t, requestId);
        if (!live(job, lease)) return false;
        const tries = job.tries + 1;
        await t.put({ ...job, tries, nextAttemptAt: now() + backoff(tries), lastError: error, leaseOwner: null, leaseUntil: 0, updatedAt: iso() });
        return true;
      });
    },

    async retryBlocked(requestId, scope) {
      await store.tx(async (t) => {
        const job = await mustGet(t, requestId);
        if (!inScopeKey(job.scope, scopeKey(scope))) throw new OutboxStorageError("That scan belongs to another account, site or receiver.");
        if (job.status !== "blocked") return;
        // F7: Retry on a dispatch job waiting for a framer choice re-reads the
        // order and the framing records (a scan may have arrived since). Safe
        // only because nothing can have been saved for it.
        if (jobMode(job) === "dispatch" && job.blocked && CHOICE_CODES.has(job.blocked.code) && !job.uncertain && !(job.priorUnknown ?? false)) {
          await t.put({ ...job, status: "queued", prepared: null, blocked: null, lastError: null, tries: 0, nextAttemptAt: 0, updatedAt: iso() });
          return;
        }
        await t.put({ ...job, status: job.prepared ? "prepared" : "queued", blocked: null, tries: 0, nextAttemptAt: 0, updatedAt: iso() });
      });
    },

    async dismiss(requestId, scope) {
      await store.tx(async (t) => {
        const job = await mustGet(t, requestId);
        if (!inScopeKey(job.scope, scopeKey(scope))) throw new OutboxStorageError("That scan belongs to another account, site or receiver.");
        // Only a definitely-refused job can be dropped; an unknown outcome must be resolved first.
        if (job.status !== "blocked" || job.uncertain) throw new OutboxStorageError("Only a blocked scan can be dismissed.");
        await t.put({ ...job, status: "dismissed", updatedAt: iso() });
      });
    },

    async view(scope) {
      const key = scopeKey(scope);
      return store.tx(async (t) => {
        const jobs: ScannerJob[] = [];
        const corrupt: CorruptRow[] = [];
        for (const r of await t.all()) {
          const j = readJob(r.value);
          if (!j) corrupt.push({ key: r.key, raw: r.value });
          else if (inScopeKey(j.scope, key)) jobs.push(j);
        }
        jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return {
          jobs,
          corrupt,
          waiting: jobs.filter((j) => j.status === "queued" || j.status === "prepared").length,
          blocked: jobs.filter((j) => j.status === "blocked").length,
          uncertain: jobs.filter((j) => j.uncertain).length,
        };
      });
    },
  };
}
