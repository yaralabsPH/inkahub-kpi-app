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
  scannerId: string;
  personId: string;
  displayName: string;
  badge: string;
  /** Original scan time, UTC ISO. */
  scannedAt: string;
  orderNumber: string;
  status: JobStatus;
  /** Exact payload committed; immutable once set. */
  prepared: PreparedFraming | null;
  /** Commit requests sent. */
  attempts: number;
  /** A commit was sent and no definite answer has come back. */
  uncertain: boolean;
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
        if (e instanceof OutboxFullError || e instanceof OutboxStorageError) throw e;
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
          if (e instanceof OutboxFullError || e instanceof OutboxStorageError) throw e;
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
  return r.success ? (value as ScannerJob) : null;
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
  enqueue(order: CapturedOrder, scope: JobScope, requestId: string): Promise<ScannerJob>;
  claimNext(scope: JobScope, owner: string): Promise<ScannerJob | null>;
  setPrepared(requestId: string, owner: string, prepared: PreparedFraming): Promise<ScannerJob>;
  markAttempt(requestId: string, owner: string): Promise<ScannerJob>;
  markDone(requestId: string, outcome: JobOutcome): Promise<void>;
  markBlocked(requestId: string, block: JobBlock): Promise<void>;
  retryLater(requestId: string, error: string): Promise<void>;
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

  const backoff = (tries: number) => Math.min(60_000, 2_000 * 2 ** Math.min(tries, 5));

  return {
    async enqueue(order, scope, requestId) {
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
          scope: scopeKey(scope),
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
            !!j && j.scope === key && (j.status === "queued" || j.status === "prepared") &&
            j.nextAttemptAt <= at && (j.leaseOwner === null || j.leaseOwner === owner || j.leaseUntil <= at))
          .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
        const job = ready[0];
        if (!job) return null;
        const claimed: ScannerJob = { ...job, leaseOwner: owner, leaseUntil: at + LEASE_MS, updatedAt: iso() };
        await t.put(claimed);
        return claimed;
      });
    },

    async setPrepared(requestId, owner, prepared) {
      return store.tx(async (t) => {
        const job = await mustGet(t, requestId);
        if (job.leaseOwner !== owner) throw new OutboxStorageError("Lost the lease on a queued scan.");
        if (job.prepared !== null || job.status !== "queued") {
          // Immutable: never replace a payload that may already have been sent.
          return job;
        }
        if (prepared.orderNumber !== job.orderNumber) throw new OutboxStorageError("Prepared order does not match the scan.");
        const next: ScannerJob = { ...job, status: "prepared", prepared: JSON.parse(JSON.stringify(prepared)) as PreparedFraming, updatedAt: iso() };
        await t.put(next);
        return next;
      });
    },

    async markAttempt(requestId, owner) {
      return store.tx(async (t) => {
        const job = await mustGet(t, requestId);
        if (job.leaseOwner !== owner) throw new OutboxStorageError("Lost the lease on a queued scan.");
        if (job.status !== "prepared" || !job.prepared) throw new OutboxStorageError("Scan is not ready to send.");
        const next: ScannerJob = { ...job, attempts: job.attempts + 1, uncertain: true, leaseUntil: now() + LEASE_MS, updatedAt: iso() };
        await t.put(next);
        return next;
      });
    },

    async markDone(requestId, outcome) {
      await store.tx(async (t) => {
        const job = await mustGet(t, requestId);
        await t.put({ ...job, status: "done", uncertain: false, outcome, blocked: null, lastError: null, leaseOwner: null, leaseUntil: 0, updatedAt: iso() });
        // Keep the finished history bounded per scope (oldest first out).
        const finished = (await t.all())
          .map((r) => readJob(r.value))
          .filter((j): j is ScannerJob => !!j && j.scope === job.scope && (j.status === "done" || j.status === "dismissed"))
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        for (const old of finished.slice(KEEP_FINISHED)) await t.delete(old.requestId);
      });
    },

    async markBlocked(requestId, block) {
      await store.tx(async (t) => {
        const job = await mustGet(t, requestId);
        // A definite refusal settles any uncertainty: the server did not save it.
        await t.put({ ...job, status: "blocked", uncertain: false, blocked: block, lastError: block.message, leaseOwner: null, leaseUntil: 0, updatedAt: iso() });
      });
    },

    async retryLater(requestId, error) {
      await store.tx(async (t) => {
        const job = await mustGet(t, requestId);
        const tries = job.tries + 1;
        await t.put({ ...job, tries, nextAttemptAt: now() + backoff(tries), lastError: error, leaseOwner: null, leaseUntil: 0, updatedAt: iso() });
      });
    },

    async retryBlocked(requestId, scope) {
      await store.tx(async (t) => {
        const job = await mustGet(t, requestId);
        if (job.scope !== scopeKey(scope)) throw new OutboxStorageError("That scan belongs to another account, site or receiver.");
        if (job.status !== "blocked") return;
        await t.put({ ...job, status: job.prepared ? "prepared" : "queued", blocked: null, tries: 0, nextAttemptAt: 0, updatedAt: iso() });
      });
    },

    async dismiss(requestId, scope) {
      await store.tx(async (t) => {
        const job = await mustGet(t, requestId);
        if (job.scope !== scopeKey(scope)) throw new OutboxStorageError("That scan belongs to another account, site or receiver.");
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
          else if (j.scope === key) jobs.push(j);
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
