/**
 * scanner-wall-redesign: when the wall re-reads today's totals.
 *
 * One read at a time (a cancelled read still owns the slot until it
 * settles, so reads never overlap); reads start at least MIN_GAP_MS apart;
 * a refresh every REFRESH_MS while enabled; any number of requests while a
 * read runs (saves, a new person on a scanner) coalesce into one trailing
 * read, which never waits behind the periodic timer. No immediate retry
 * after a failure: the next scheduled refresh tries again. Disabled
 * (offline, hidden, wrong mode, no access) = the running read is aborted and
 * no reads start. Dispose = no late publication.
 */
import type { ProductionSnapshot } from "@/lib/domain/productionCounts";

export const WALL_MIN_GAP_MS = 5_000;
export const WALL_REFRESH_MS = 60_000;

export interface WallRefreshResult {
  snapshot: ProductionSnapshot | null;
  error: string | null;
}

export interface WallRefreshDeps<H> {
  now(): number;
  schedule(fn: () => void, ms: number): H;
  cancel(handle: H): void;
  /** One read; builds its request (day, cutoff) when it actually starts. */
  read(signal: AbortSignal): Promise<ProductionSnapshot>;
  publish(result: WallRefreshResult): void;
}

export interface WallRefresh {
  /** Ask for a read as soon as the rules allow. */
  request(): void;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

export function createWallTotalsRefresh<H>(d: WallRefreshDeps<H>): WallRefresh {
  let enabled = false;
  let disposed = false;
  let inFlight: AbortController | null = null;
  let dirty = false;
  let lastStart = Number.NEGATIVE_INFINITY;
  let timer: H | null = null;
  let timerDue = Number.POSITIVE_INFINITY;
  /** Bumped when reads must stop publishing (disable, dispose). */
  let generation = 0;

  const clearTimer = () => {
    if (timer !== null) d.cancel(timer);
    timer = null;
    timerDue = Number.POSITIVE_INFINITY;
  };
  const setTimer = (ms: number, fn: () => void) => {
    clearTimer();
    timerDue = d.now() + ms;
    timer = d.schedule(() => { timer = null; timerDue = Number.POSITIVE_INFINITY; fn(); }, ms);
  };

  const start = () => {
    clearTimer();
    dirty = false;
    const ac = new AbortController();
    inFlight = ac;
    lastStart = d.now();
    const g = generation;
    let p: Promise<ProductionSnapshot>;
    try {
      p = d.read(ac.signal);
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (snapshot) => {
        if (g === generation && !disposed) d.publish({ snapshot, error: null });
      },
      (e: unknown) => {
        if (g === generation && !disposed) d.publish({ snapshot: null, error: e instanceof Error ? e.message : String(e) });
      },
    ).finally(() => {
      if (inFlight === ac) inFlight = null;
      if (disposed || !enabled) return;
      if (dirty) kick();
      else setTimer(WALL_REFRESH_MS, () => { dirty = true; kick(); });
    });
  };

  const kick = () => {
    if (disposed || !enabled || inFlight) return;
    const wait = lastStart + WALL_MIN_GAP_MS - d.now();
    if (wait <= 0) {
      start();
      return;
    }
    // Never leave a request waiting behind a later (periodic) timer.
    if (timer === null || timerDue > d.now() + wait) setTimer(wait, kick);
  };

  return {
    request() {
      if (disposed) return;
      dirty = true;
      kick();
    },
    setEnabled(next: boolean) {
      if (disposed || next === enabled) return;
      enabled = next;
      if (next) {
        dirty = true;
        kick();
      } else {
        generation++; // the running read will not publish...
        inFlight?.abort(); // ...and is asked to stop; it keeps the slot until it settles
        clearTimer();
      }
    },
    dispose() {
      disposed = true;
      generation++;
      inFlight?.abort();
      clearTimer();
    },
  };
}
