/**
 * Task 15 review repair: walkChangedKey (the resumable dependency closure of
 * one changed key) against the whole-key reference changedKeyDependencies,
 * with a durable fake checkpoint store. Every checkpoint is a possible
 * interruption point; each resume must reach the same owners and the same
 * DISTINCT per-seed budget, without fetching any completed source page again.
 */
import { describe, expect, it } from "vitest";
import {
  changedKeyDependencies, diffFrozenViews, memoryFrozenReader, ownerKey, parseKeyProgress, PartitionTooLargeError, walkChangedKey,
  compareStream, type ChangedKey, type FrozenReader, type StreamPosition, type KeyCheckpoint, type KeyProgress, type KeyWalkIo,
} from "../../api/_lib/production-reporting-materialize";
import type { ProductionEvidenceEvent as Ev } from "../../src/lib/domain/productionCounts";

const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const CUT = "2026-03-09T00:00:00.000000Z";
const PAGES = { keyChildren: 2, lineKids: 2, stream: 2 };
const at = (m: number, s = 0) => `2026-03-02T09:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}+00:00`;
const ev = (id: string, o: Partial<Ev> = {}): Ev => ({ id, location: "uk", staff_id: W1, department: "framed", order_number: `O-${id}`, line_sku: "INKA-KAN0566-A4-FB", line_quantity: 1, event_type: "line_verified", created_at: at(0), parent_event_id: null, cs_case_id: null, ...o });
const cancel = (id: string, parent: Ev, o: Partial<Ev> = {}): Ev => ev(id, { event_type: "cancelled", order_number: parent.order_number, parent_event_id: parent.id, line_sku: null, line_quantity: null, ...o });

function views(): { base: Ev[]; next: Ev[]; changed: ChangedKey[] } {
  const a0 = ev("a0", { created_at: at(0) });
  const p0 = ev("p0", { staff_id: W2, created_at: at(0, 5) });
  const kid = ev("kid0", { created_at: at(0, 20), parent_event_id: "p0", event_type: "cancelled", line_sku: null, line_quantity: null, order_number: "O-p0" });
  const s = [1, 2, 3, 4].map((m) => ev(`s${m}`, { created_at: at(m), department: m === 3 ? "unframed" : "framed" }));
  const base: Ev[] = [a0, p0, kid, ...s, ev("fin", { created_at: at(6) }), ev("fin2", { created_at: at(7), department: "unframed" }), ev("z", { created_at: at(9) })];
  for (const [i, line] of s.entries()) {
    base.push(cancel(`k-${line.id}-w`, line, { created_at: at(i + 1, 30) })); // W1: also in W1's stream (two paths)
    for (let j = 0; j < 4; j++) base.push(cancel(`k-${line.id}-${j}`, line, { staff_id: W2, created_at: at(i + 1, 10 + j) }));
  }
  for (let j = 0; j < 5; j++) base.push(cancel(`x${j}`, a0, { staff_id: W2, created_at: at(0, 40 + j) })); // the key's inverse children
  // s5: its ONLY valid cancellation is on its FIRST child page; later pages hold cancellations created before
  // the line (invalid edges). The monotonic flag must keep s5 cancelled across pages (a walk that judged only
  // the last page would stop at s5 and miss fin/fin2).
  const s5 = ev("s5", { created_at: at(5, 30) });
  base.push(s5, cancel("k-s5-a", s5, { staff_id: W2, created_at: at(5, 40) }));
  for (const id of ["k-s5-x1", "k-s5-x2", "k-s5-x3"]) base.push(cancel(id, s5, { staff_id: W2, created_at: at(5, 20) }));
  // changes: a0 moves later and changes order (old/new positions: two seeds), the parent-holding kid is edited (parent seed), s2 is deleted
  const next = base.filter((e) => e.id !== "s2").map((e) => (e.id === "a0" ? { ...e, created_at: at(5), order_number: "O-a0-new" } : e.id === "kid0" ? { ...e, department: "unframed" } : e));
  return { base, next, changed: diffFrozenViews(base, next, CUT, CUT) };
}

/** A reader that records every source call (the resume must not repeat a completed one). */
interface StreamRead { seed: number | null; from: StreamPosition; out: Array<{ id: string; created_at: string }> }
/** `seedNow` attributes a stream read to the seed of the last saved cursor (a checkpoint precedes every read). */
function recorded(inner: FrozenReader, seedNow: () => number | null = () => null) {
  const calls: string[] = [];
  const streams: StreamRead[] = [];
  const reader: FrozenReader = {
    ...inner,
    byIds: (ids) => (calls.push(`byIds:${ids.join(",")}`), inner.byIds(ids)),
    childPage: (p, after, limit) => (calls.push(`kids:${p}>${after ?? ""}`), inner.childPage(p, after, limit)),
    stream: async (s, d, from, limit) => {
      calls.push(`stream:${s}:${from.createdAt}|${from.id}`);
      const out = await inner.stream(s, d, from, limit);
      streams.push({ seed: seedNow(), from, out: out.map((e) => ({ id: e.id, created_at: e.created_at })) });
      return out;
    },
  };
  return { reader, calls, streams };
}

class Stop extends Error {}
/** Durable store as the SQL keeps it: cursor, owners, per-seed DISTINCT ids, the paged line's image; stop after checkpoint N. */
class Store implements KeyWalkIo {
  cursor: KeyProgress | null = null;
  complete = false;
  owners = new Map<string, Set<string>>();
  seen = new Map<number, Set<string>>();
  pushes = new Map<number, string[]>();
  image: Ev | null = null;
  saves = 0;
  maxCount = new Map<number, number>();
  onSave: () => void = () => undefined;
  constructor(public stopAt = Number.POSITIVE_INFINITY, public force?: number) {}
  async checkpoint(next: KeyProgress | null, step: KeyCheckpoint) {
    if (next) expect(parseKeyProgress(JSON.parse(JSON.stringify(next)))).toEqual(next); // always a valid saved cursor
    if (next?.phase === "children") expect(step.seed).toBeNull();
    if (next?.phase === "seeds") expect(step.seed).toBe(next.seed); // ids only into the cursor's seed budget
    for (const f of step.found) {
      const s = this.owners.get(ownerKey(f.owner)) ?? this.owners.set(ownerKey(f.owner), new Set()).get(ownerKey(f.owner))!;
      for (const x of f.oldStaff) s.add(x);
    }
    let n: number | null = null;
    if (step.seed !== null) {
      const s = this.seen.get(step.seed) ?? this.seen.set(step.seed, new Set()).get(step.seed)!;
      for (const id of step.seen) s.add(id);
      (this.pushes.get(step.seed) ?? this.pushes.set(step.seed, []).get(step.seed)!).push(...step.seen);
      n = this.force ?? s.size;
      this.maxCount.set(step.seed, Math.max(this.maxCount.get(step.seed) ?? 0, s.size));
    }
    if (step.lineImage) this.image = step.lineImage;
    this.cursor = next;
    this.complete = next === null;
    this.saves++;
    this.onSave();
    if (this.saves === this.stopAt) throw new Stop();
    return n;
  }
  async lineImage(_seed: number, line: string) {
    return this.image?.id === line ? this.image : null;
  }
}

const expectedOwners = async (reader: FrozenReader, k: ChangedKey) => {
  const d = await changedKeyDependencies(reader, k);
  const m = new Map<string, string[]>(d.owners.map((o) => [ownerKey(o), []]));
  for (const [ok, s] of d.oldStaff) m.get(ok)!.push(s);
  return new Map([...m].map(([k2, v]) => [k2, [...new Set(v)].sort()]));
};
const ownersOf = (s: Store) => new Map([...s.owners].map(([k, v]) => [k, [...v].sort()]));

describe("Task 15 review: the resumable changed-key walk", () => {
  const { next, changed } = views();
  const mk = () => memoryFrozenReader({ site: "uk", cutoff: CUT, kind: "refresh", view: next, changed });
  it("the fixture exercises every path (non-vacuous): several seeds, multi-page key children and line cancellations, a parent seed", async () => {
    const a0 = changed.find((k) => k.id === "a0")!;
    const s = new Store();
    await walkChangedKey(mk(), a0, null, s, PAGES);
    expect(s.saves).toBeGreaterThan(10);
    expect(s.seen.size).toBe(2); // old and new stream positions
    const kid = new Store();
    await walkChangedKey(mk(), changed.find((k) => k.id === "kid0")!, null, kid, PAGES);
    expect(kid.seen.size).toBeGreaterThanOrEqual(1); // the parent's successor seed
    const pages = await mk().childPage("s5", null, PAGES.lineKids);
    expect(pages.map((e) => e.id)).toEqual(["k-s5-a", "k-s5-x1"]); // the valid cancellation is on page 1 of 2
    expect([...s.seen.values()].some((ids) => ids.has("fin") && ids.has("k-s5-x3"))).toBe(true); // the walk passed s5 (to fin)
  });
  it("uninterrupted, every changed key discovers exactly changedKeyDependencies' owners and old self audiences", async () => {
    expect(changed.length).toBeGreaterThanOrEqual(3);
    for (const k of changed) {
      const s = new Store();
      await walkChangedKey(mk(), k, null, s, PAGES);
      expect(s.complete).toBe(true);
      expect(ownersOf(s)).toEqual(await expectedOwners(mk(), k));
    }
  });
  it("an id met as a line's cancellation AND as a stream event is one budget id (duplicates occur; the count is distinct)", async () => {
    const s = new Store();
    await walkChangedKey(mk(), changed.find((k) => k.id === "a0")!, null, s, PAGES);
    for (const [seed, ids] of s.pushes) expect(s.maxCount.get(seed)).toBe(new Set(ids).size); // every budget is DISTINCT
    const met = [...s.pushes.values()].find((ids) => ids.includes("k-s1-w"))!;
    expect(met.filter((x) => x === "k-s1-w")).toHaveLength(2); // met as s1's cancellation and in W1's stream…
    expect(met.length).toBeGreaterThan(new Set(met).size); // …so duplicates occur, and count once
  });
  it("interrupted at EVERY checkpoint, a fresh resume reaches the same owners and budgets and never repeats a completed source page", async () => {
    const count = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
    for (const k of changed) {
      const full = new Store();
      const all = recorded(mk());
      await walkChangedKey(all.reader, k, null, full, PAGES);
      const fullCalls = count(all.calls);
      for (let stop = 1; stop < full.saves; stop++) {
        const s = new Store(stop);
        const one = recorded(mk());
        let mark = 0;
        s.onSave = () => void (mark = one.calls.length);
        await expect(walkChangedKey(one.reader, k, null, s, PAGES)).rejects.toBeInstanceOf(Stop);
        const done = one.calls.slice(0, mark); // every source page read before the saved checkpoint is complete
        const saved = s.cursor ? (JSON.parse(JSON.stringify(s.cursor)) as KeyProgress) : null; // before the resume clears it
        const two = recorded(mk(), () => (s.cursor && s.cursor.phase === "seeds" ? s.cursor.seed : null));
        s.stopAt = Number.POSITIVE_INFINITY;
        await walkChangedKey(two.reader, k, s.cursor, s, PAGES);
        expect(s.complete).toBe(true);
        expect(ownersOf(s)).toEqual(ownersOf(full));
        for (const [seed, ids] of full.seen) expect(s.seen.get(seed)).toEqual(ids);
        // Point reads and child pages: strict. Completed + resumed requests never exceed the uninterrupted walk's
        // (identical requests may legitimately occur twice in one walk, e.g. a0's key children and a0 as a stream line).
        expect(two.calls.filter((c) => c.startsWith("byIds:"))).toEqual([]);
        const strict = (xs: string[]) => xs.filter((c) => !c.startsWith("stream:"));
        for (const [c, n] of count([...strict(done), ...strict(two.calls)])) expect([k.id, stop, c, n]).toEqual([k.id, stop, c, Math.min(n, fullCalls.get(c) ?? 0)]);
        // Stream: resuming inside a seed's walk re-segments its keyset pages after the saved position, so request
        // boundaries may shift; semantically the first resumed request of that seed starts EXACTLY at the saved
        // consumed position and no resumed output of that seed is at/before it. Other seeds' requests are strict.
        const w = saved?.phase === "seeds" ? saved.walk : null;
        const inSeed = two.streams.filter((r) => w && r.seed === saved!.seed);
        if (w?.at) {
          if (!w.done) expect(inSeed.length).toBeGreaterThan(0); // a finished walk needs no further stream read
          else expect(inSeed).toEqual([]);
          if (inSeed.length) expect(inSeed[0].from).toEqual(w.at);
          for (const r of inSeed) for (const o of r.out) expect([o.id, compareStream(o, { created_at: w.at.createdAt, id: w.at.id }) > 0]).toEqual([o.id, true]);
        }
        const streamKey = (r: StreamRead) => `stream:${r.from.createdAt}|${r.from.id}`;
        const otherResumed = two.streams.filter((r) => !(w?.at && r.seed === saved!.seed)).map(streamKey);
        const fullStreams = count(all.streams.map(streamKey));
        const doneStreams = one.streams.slice(0, done.filter((c) => c.startsWith("stream:")).length).map(streamKey);
        for (const [c, n] of count([...doneStreams, ...otherResumed])) expect([k.id, stop, c, n]).toEqual([k.id, stop, c, Math.min(n, fullStreams.get(c) ?? 0)]);
      }
    }
  });
  it("interrupted after several child pages of one line: the resume continues at the saved kidsAfter with zero rereads", async () => {
    const k = changed.find((x) => x.id === "a0")!;
    let stopAt = 0;
    const probe = new Store();
    const ck = probe.checkpoint.bind(probe);
    probe.checkpoint = async (n, st) => {
      const r = await ck(n, st);
      if (!stopAt && n?.walk?.line?.id === "s1" && n.walk.line.kidsAfter === "k-s1-3") stopAt = probe.saves; // after page 2 of 3
      return r;
    };
    await walkChangedKey(mk(), k, null, probe, PAGES);
    expect(stopAt).toBeGreaterThan(0); // a checkpoint after page 2 of s1's cancellations exists
    const s = new Store(stopAt);
    await expect(walkChangedKey(mk(), k, null, s, PAGES)).rejects.toBeInstanceOf(Stop);
    expect(s.cursor?.walk?.line).toEqual({ id: "s1", kidsAfter: "k-s1-3", cancelled: true });
    const two = recorded(mk());
    s.stopAt = Number.POSITIVE_INFINITY;
    await walkChangedKey(two.reader, k, s.cursor, s, PAGES);
    expect(two.calls.filter((c) => c.startsWith("byIds:"))).toEqual([]);
    const s1 = two.calls.filter((c) => c.startsWith("kids:s1>"));
    expect(s1[0]).toBe("kids:s1>k-s1-3");
    expect(s1).not.toContain("kids:s1>");
    expect(s1).not.toContain("kids:s1>k-s1-1");
    expect(ownersOf(s)).toEqual(await expectedOwners(mk(), k));
  });
  it("a checkpoint whose durable distinct count exceeds 50,000 stops the walk before any further read", async () => {
    const one = recorded(mk());
    const s = new Store(Number.POSITIVE_INFINITY, 50_001);
    let mark = -1;
    s.onSave = () => void (mark = one.calls.length);
    const k = changed.find((x) => x.id === "a0")!;
    await expect(walkChangedKey(one.reader, k, null, s, PAGES)).rejects.toBeInstanceOf(PartitionTooLargeError);
    expect(s.cursor?.phase).toBe("seeds"); // it failed at a seed checkpoint
    expect(one.calls.length).toBe(mark); // no source read after the over-budget checkpoint
  });
  it("saved progress is validated strictly", () => {
    const ok: KeyProgress = { id: "k", phase: "seeds", kidsAfter: null, anchors: [{ staff: W1, at: "2026-03-02T09:00:00.000000Z", id: "a", wt: null, owner: ["order", "O"] }], seed: 0, walk: { at: { createdAt: "2026-03-02T09:00:00.000000Z", id: "a" }, stop: null, need: ["*"], line: { id: "a", kidsAfter: null, cancelled: false }, done: false } };
    expect(parseKeyProgress(ok)).toEqual(ok);
    const bad: Array<(p: any) => void> = [
      (p) => (p.extra = 1),
      (p) => (p.phase = "parents"),
      (p) => (p.seed = 2),
      (p) => (p.walk.line.cancelled = "no"),
      (p) => (p.walk.line.id = "other"), // a paged line is the last consumed event
      (p) => (p.walk.done = true), // a finished walk pages no line
      (p) => (p.walk.stop = "1.5"),
      (p) => (p.anchors[0].owner = ["x", "O"]),
      (p) => ((p.phase = "children"), (p.walk = null), (p.seed = 1)),
    ];
    for (const m of bad) {
      const p = JSON.parse(JSON.stringify(ok));
      m(p);
      expect(() => parseKeyProgress(p)).toThrow(/key progress/);
    }
  });
});
