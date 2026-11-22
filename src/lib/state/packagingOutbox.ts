import type { ApplyArgs } from "@/lib/repository/supabase/orderPackaging";

/**
 * F4 box-auto-pick: on-device queue for packaging applies that got no answer.
 *
 * The completion event is already saved when an entry lands here. Each entry
 * keeps its request id, so sending it again can never deduct twice (the
 * server replays its first answer). Entries leave the queue only on a
 * definitive server answer.
 *
 * This is deliberately small. F6 (scanner stations) will bring a general
 * device queue; packaging_apply is already safe for it to call.
 */

const STORAGE_KEY = "inka.packagingOutbox.v1";
export const OUTBOX_MAX_ENTRIES = 200;

export interface OutboxEntry {
  args: ApplyArgs;
  /** For the worker-facing notice. */
  orderNumber: string;
  queuedAt: string;
  attempts: number;
}

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
  /** Returns false when the entry could not be stored (storage unavailable or full). */
  enqueue(entry: Omit<OutboxEntry, "queuedAt" | "attempts">): boolean;
  remove(requestId: string): void;
  /**
   * Try every queued entry once, oldest first. `send` returns "done" for any
   * definitive server answer (applied, already applied, or rejected) and
   * "retry" when there was no answer. Stops at the first "retry" so a dead
   * connection is not hammered. Returns how many entries were completed.
   */
  drain(send: (entry: OutboxEntry) => Promise<"done" | "retry">): Promise<number>;
}

export function createPackagingOutbox(storage: OutboxStorage | null, now: () => Date = () => new Date()): PackagingOutbox {
  let memory: OutboxEntry[] = [];
  let draining = false;

  const read = (): OutboxEntry[] => {
    if (!storage) return memory;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
    } catch {
      return memory;
    }
  };

  const write = (entries: OutboxEntry[]): boolean => {
    memory = entries;
    if (!storage) return true;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(entries));
      return true;
    } catch {
      return false;
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
      if (all.some((e) => e.args.requestId === entry.args.requestId)) return true;
      if (all.length >= OUTBOX_MAX_ENTRIES) return false;
      return write([...all, { ...entry, queuedAt: now().toISOString(), attempts: 0 }]);
    },
    remove(requestId) {
      write(read().filter((e) => e.args.requestId !== requestId));
    },
    async drain(send) {
      if (draining) return 0;
      draining = true;
      let done = 0;
      try {
        for (const entry of read()) {
          let result: "done" | "retry";
          try {
            result = await send(entry);
          } catch {
            result = "retry";
          }
          if (result === "done") {
            write(read().filter((e) => e.args.requestId !== entry.args.requestId));
            done++;
          } else {
            write(read().map((e) => (e.args.requestId === entry.args.requestId ? { ...e, attempts: e.attempts + 1 } : e)));
            break;
          }
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
