import { describe, expect, it } from "vitest";
import type { ProductionSnapshot } from "@/lib/domain/productionCounts";
import { createWallTotalsRefresh, WALL_MIN_GAP_MS, WALL_REFRESH_MS, type WallRefreshResult } from "../wallTotalsRefresh";

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function harness() {
  let clock = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const reads: Array<{ at: number; resolve: (s: ProductionSnapshot) => void; reject: (e: Error) => void }> = [];
  const published: WallRefreshResult[] = [];
  const r = createWallTotalsRefresh<number>({
    now: () => clock,
    schedule: (fn, ms) => { const id = nextId++; timers.set(id, { at: clock + ms, fn }); return id; },
    cancel: (id) => { timers.delete(id); },
    read: () => new Promise<ProductionSnapshot>((resolve, reject) => reads.push({ at: clock, resolve, reject })),
    publish: (p) => published.push(p),
  });
  /** Advance the fake clock, firing due timers in order. */
  const advance = async (ms: number) => {
    const end = clock + ms;
    await flush(); // settle reads resolved before time moves
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
      await flush();
    }
    clock = end;
    await flush();
  };
  const snap = (tag: string) => ({ asOfUtc: tag } as unknown as ProductionSnapshot);
  return { r, reads, published, advance, snap, get clock() { return clock; }, timers };
}

describe("createWallTotalsRefresh", () => {
  it("reads at once when enabled, then refreshes every minute", async () => {
    const h = harness();
    h.r.setEnabled(true);
    expect(h.reads).toHaveLength(1);
    h.reads[0].resolve(h.snap("a"));
    await h.advance(0);
    expect(h.published).toEqual([{ snapshot: h.snap("a"), error: null }]);
    await h.advance(WALL_REFRESH_MS - 1);
    expect(h.reads).toHaveLength(1);
    await h.advance(1);
    expect(h.reads).toHaveLength(2);
    expect(h.reads[1].at).toBe(WALL_REFRESH_MS);
  });

  it("one read at a time; saves during a read coalesce into one trailing read after the minimum gap", async () => {
    const h = harness();
    h.r.setEnabled(true);
    for (let i = 0; i < 5; i++) h.r.request();
    expect(h.reads).toHaveLength(1);
    await h.advance(1_000);
    h.reads[0].resolve(h.snap("a"));
    await h.advance(0);
    expect(h.reads).toHaveLength(1); // still inside the five-second gap
    await h.advance(WALL_MIN_GAP_MS - 1_000);
    expect(h.reads).toHaveLength(2);
    expect(h.reads[1].at).toBe(WALL_MIN_GAP_MS);
  });

  it("continued saves are not starved: a read still starts every five seconds", async () => {
    const h = harness();
    h.r.setEnabled(true);
    for (let k = 1; k <= 4; k++) {
      h.r.request();
      h.reads[k - 1].resolve(h.snap(String(k)));
      await h.advance(WALL_MIN_GAP_MS);
      expect(h.reads).toHaveLength(k + 1);
    }
  });

  it("a failure is published and not retried immediately", async () => {
    const h = harness();
    h.r.setEnabled(true);
    h.reads[0].reject(new Error("timeout"));
    await h.advance(0);
    expect(h.published).toEqual([{ snapshot: null, error: "timeout" }]);
    await h.advance(WALL_MIN_GAP_MS * 3);
    expect(h.reads).toHaveLength(1);
    await h.advance(WALL_REFRESH_MS);
    expect(h.reads).toHaveLength(2);
  });

  it("pauses while disabled (offline or hidden) and resumes with a read", async () => {
    const h = harness();
    h.r.setEnabled(true);
    h.r.setEnabled(false);
    h.reads[0].resolve(h.snap("late"));
    await h.advance(WALL_REFRESH_MS * 3);
    expect(h.published).toEqual([]); // the read that ran when it was disabled never publishes
    expect(h.reads).toHaveLength(1);
    h.r.request();
    expect(h.reads).toHaveLength(1);
    h.r.setEnabled(true);
    expect(h.reads).toHaveLength(2);
  });

  it("the request is built when the read starts, not when it was asked for", async () => {
    const h = harness();
    h.r.setEnabled(true);
    h.r.request(); // queued behind the first read
    await h.advance(3_000);
    h.reads[0].resolve(h.snap("a"));
    await h.advance(WALL_MIN_GAP_MS);
    expect(h.reads[1].at).toBe(WALL_MIN_GAP_MS); // started later; read() computes day/cutoff then
  });

  it("dispose prevents every late publication and timer", async () => {
    const h = harness();
    h.r.setEnabled(true);
    h.r.dispose();
    h.reads[0].resolve(h.snap("late"));
    await h.advance(WALL_REFRESH_MS * 2);
    expect(h.published).toEqual([]);
    expect(h.reads).toHaveLength(1);
    expect(h.timers.size).toBe(0);
  });
});
