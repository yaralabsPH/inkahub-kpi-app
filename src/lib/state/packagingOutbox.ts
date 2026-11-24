import type { ApplyArgs } from "@/lib/repository/supabase/orderPackaging";

/**
 * F4 box-auto-pick: on-device queue for packaging applies that got no answer.
 *
 * The completion event is already saved when an entry lands here. Each entry
 * keeps its request id, so sending it again can never deduct twice (the
 * server replays its first answer). Entries leave the queue only on a
 * definitive server answer. A sign-in problem (expired session, signed out)
 * is NOT a definitive answer: the entry stays until the same account is
 * signed in again. Each entry remembers the account that captured it, and
 * only that account (at that site) may send it.
 *
 * This is deliberately small. F6 (scanner stations) will bring a general
 * device queue; packaging_apply is already safe for it to call.
 */

const STORAGE_KEY = "inka.packagingOutbox.v1";
const REJECTED_KEY = "inka.packagingOutbox.rejected.v1";
export const OUTBOX_MAX_ENTRIES = 200;
export const REJECTED_MAX_ENTRIES = 50;

export interface OutboxEntry {
  args: ApplyArgs;
  /** For the worker-facing notice. */
  orderNumber: string;
  queuedAt: string;
  attempts: number;
  /** The account that captured the request; absent on entries queued before this was recorded. */
  userId?: string | null;
}

/** A request the server settled with a refusal. Kept so a person can see what was not recorded. */
export interface RejectedEntry extends OutboxEntry {
  rejectedAt: string;
  reason: string;
}

/** Who may send now. An entry from another account or site is skipped and kept. */
export interface DrainScope {
  userId?: string | null;
  location?: string;
}

/** What one send attempt means for the queue. */
export type SendResult = "done" | "retry" | { rejected: string };

export type OutboxStorage = Pick<Storage, "getItem" | "setItem">;

function isEntry(x: unknown): x is OutboxEntry {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  const a = e.args as Record<string, unknown> | undefined;
  return (
    !!a &&
    typeof a === "object" &&
    typeof a.requestId === "string" &&
    typeof a.location === "string" &&
    typeof a.eventId === "string" &&
    typeof a.ruleSetId === "string" &&
    typeof a.resolved === "boolean" &&
    !!a.predicted &&
    typeof a.predicted === "object" &&
    !!a.target &&
    typeof a.target === "object" &&
    typeof e.orderNumber === "string" &&
    typeof e.queuedAt === "string" &&
    typeof e.attempts === "number"
  );
}

export interface PackagingOutbox {
  list(): OutboxEntry[];
  pendingCount(location?: string): number;
  /**
   * Keeps the request. Returns true only when it is stored on the device, so
   * it survives a reload. False means it is held in memory only (storage
   * unavailable or full) or the queue is full; the caller must say so.
   */
  enqueue(entry: Omit<OutboxEntry, "queuedAt" | "attempts">): boolean;
  remove(requestId: string): void;
  /** Requests the server refused, oldest first. */
  listRejected(): RejectedEntry[];
  /**
   * Try each queued entry in `scope` once, oldest first. `send` returns
   * "done" for a definitive success, { rejected } for a definitive refusal
   * (the entry moves to the rejected list with the reason), and "retry" when
   * there was no usable answer (offline, expired session). Stops at the first
   * "retry" so a dead connection is not hammered. Entries outside `scope`
   * are never sent and never removed. Returns how many entries were settled.
   */
  drain(send: (entry: OutboxEntry) => Promise<SendResult>, scope?: DrainScope): Promise<number>;
}

export function createPackagingOutbox(storage: OutboxStorage | null, now: () => Date = () => new Date()): PackagingOutbox {
  let memory: OutboxEntry[] = [];
  let memoryRejected: RejectedEntry[] = [];
  let draining = false;
  /** True after a failed write: the memory copy is newer than storage. */
  let degraded = false;

  const read = (): OutboxEntry[] => {
    if (!storage || degraded) return memory;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
    } catch {
      return memory;
    }
  };

  /** True only when the entries are now stored on the device. */
  const write = (entries: OutboxEntry[]): boolean => {
    memory = entries;
    if (!storage) return false;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(entries));
      degraded = false;
      return true;
    } catch {
      degraded = true;
      return false;
    }
  };

  const readRejected = (): RejectedEntry[] => {
    if (!storage) return memoryRejected;
    try {
      const raw = storage.getItem(REJECTED_KEY);
      if (!raw) return memoryRejected;
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed.filter(isEntry) as RejectedEntry[]) : memoryRejected;
    } catch {
      return memoryRejected;
    }
  };

  const writeRejected = (entries: RejectedEntry[]): void => {
    memoryRejected = entries.slice(-REJECTED_MAX_ENTRIES);
    if (!storage) return;
    try {
      storage.setItem(REJECTED_KEY, JSON.stringify(memoryRejected));
    } catch {
      /* the in-memory copy stays; the refusal was already shown to the person */
    }
  };

  return {
    list: read,
    pendingCount(location) {
      const all = read();
      return location ? all.filter((e) => e.args.location === location).length : all.length;
    },
    enqueue(entry) {
      const all = read();
      if (all.some((e) => e.args.requestId === entry.args.requestId)) return !degraded && storage !== null;
      if (all.length >= OUTBOX_MAX_ENTRIES) return false;
      return write([...all, { ...entry, queuedAt: now().toISOString(), attempts: 0 }]);
    },
    remove(requestId) {
      write(read().filter((e) => e.args.requestId !== requestId));
    },
    listRejected: readRejected,
    async drain(send, scope) {
      if (draining) return 0;
      draining = true;
      let done = 0;
      try {
        for (const entry of read()) {
          if (scope?.location !== undefined && entry.args.location !== scope.location) continue;
          // Entries queued before accounts were recorded have no owner: any account may send them.
          if (scope?.userId !== undefined && entry.userId != null && entry.userId !== scope.userId) continue;
          let result: SendResult;
          try {
            result = await send(entry);
          } catch {
            result = "retry";
          }
          if (result === "retry") {
            write(read().map((e) => (e.args.requestId === entry.args.requestId ? { ...e, attempts: e.attempts + 1 } : e)));
            break;
          }
          if (typeof result === "object") {
            writeRejected([...readRejected(), { ...entry, rejectedAt: now().toISOString(), reason: result.rejected }]);
          }
          write(read().filter((e) => e.args.requestId !== entry.args.requestId));
          done++;
        }
      } finally {
        draining = false;
      }
      return done;
    },
  };
}

let shared: PackagingOutbox | null = null;

/** The device's queue, backed by localStorage when available. */
export function getPackagingOutbox(): PackagingOutbox {
  if (!shared) {
    let storage: OutboxStorage | null = null;
    try {
      storage = typeof window !== "undefined" ? window.localStorage : null;
    } catch {
      storage = null;
    }
    shared = createPackagingOutbox(storage);
  }
  return shared;
}
