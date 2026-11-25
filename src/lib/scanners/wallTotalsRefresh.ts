/**
 * scanner-wall-redesign: when the wall re-reads today's totals.
 *
 * One read at a time; reads start at least MIN_GAP_MS apart; a refresh every
 * REFRESH_MS while enabled; any number of requests while a read runs (saves,
 * a new person on a scanner) coalesce into one trailing read. No immediate
 * retry after a failure: the next scheduled refresh tries again. Disabled
 * (offline, hidden, wrong mode) = no reads. Dispose = no late publication.
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
  read(): Promise<ProductionSnapshot>;
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
  let inFlight = false;
  let dirty = false;
  let lastStart = Number.NEGATIVE_INFINITY;
  let timer: H | null = null;
  /** Bumped when reads must stop publishing (disable, dispose). */
  let generation = 0;

  const clearTimer = () => {
    if (timer !== null) d.cancel(timer);
    timer = null;
  };

  const start = () => {
    clearTimer();
    dirty = false;
    inFlight = true;
    lastStart = d.now();
    const g = generation;
    let p: Promise<ProductionSnapshot>;
    try {
      p = d.read();
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
      if (g !== generation) return; // superseded: whoever bumped the generation owns the state now
      inFlight = false;
      if (disposed || !enabled) return;
      if (dirty) kick();
      else timer = d.schedule(() => { timer = null; dirty = true; kick(); }, WALL_REFRESH_MS);
    });
  };

  const kick = () => {
    if (disposed || !enabled || inFlight) return;
    const wait = lastStart + WALL_MIN_GAP_MS - d.now();
    if (wait <= 0) {
      start();
      return;
    }
    if (timer === null) timer = d.schedule(() => { timer = null; kick(); }, wait);
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
        generation++; // a read still running will not publish
        inFlight = false;
        clearTimer();
      }
    },
    dispose() {
      disposed = true;
      generation++;
      clearTimer();
    },
  };
}
