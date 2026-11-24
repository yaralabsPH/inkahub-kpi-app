import { describe, expect, it } from "vitest";
import type { ApplyArgs } from "@/lib/repository/supabase/orderPackaging";
import { createPackagingOutbox, OUTBOX_MAX_ENTRIES, type OutboxStorage } from "../packagingOutbox";

function memoryStorage(initial?: string): OutboxStorage & { value: string | null; failWrites: boolean } {
  const s = {
    value: initial ?? null,
    failWrites: false,
    other: new Map<string, string>(),
    getItem: (k: string) => (k === "inka.packagingOutbox.v1" ? s.value : s.other.get(k) ?? null),
    setItem: (k: string, v: string) => {
      if (s.failWrites) throw new Error("quota");
      if (k === "inka.packagingOutbox.v1") s.value = v;
      else s.other.set(k, v);
    },
  };
  return s;
}

const args = (n: number, location = "au"): ApplyArgs => ({
  location, requestId: `apply:ev-${n}`, eventId: `ev-${n}`, ruleSetId: "prs-1",
  resolved: true, predicted: { "box-a": 1 }, target: { "box-a": 1 }, snapshot: null,
});
const entry = (n: number, location = "au") => ({ args: args(n, location), orderNumber: `F4T-${n}` });
const fixedNow = () => new Date("2026-11-22T10:00:00Z");

describe("packaging outbox", () => {
  it("stores entries and survives a reload", () => {
    const storage = memoryStorage();
    const a = createPackagingOutbox(storage, fixedNow);
    expect(a.enqueue(entry(1))).toBe(true);
    expect(a.enqueue(entry(2, "uk"))).toBe(true);
    const b = createPackagingOutbox(storage, fixedNow);
    expect(b.list().map((e) => e.args.requestId)).toEqual(["apply:ev-1", "apply:ev-2"]);
    expect(b.list()[0]).toMatchObject({ orderNumber: "F4T-1", attempts: 0, queuedAt: "2026-11-22T10:00:00.000Z" });
    expect(b.pendingCount()).toBe(2);
    expect(b.pendingCount("au")).toBe(1);
  });

  it("does not queue the same request twice", () => {
    const o = createPackagingOutbox(memoryStorage(), fixedNow);
    o.enqueue(entry(1));
    o.enqueue(entry(1));
    expect(o.pendingCount()).toBe(1);
  });

  it("removes entries on a definitive answer and keeps them otherwise", async () => {
    const o = createPackagingOutbox(memoryStorage(), fixedNow);
    o.enqueue(entry(1));
    o.enqueue(entry(2));
    o.enqueue(entry(3));
    const seen: string[] = [];
    const done = await o.drain(async (e) => {
      seen.push(e.args.requestId);
      return e.args.eventId === "ev-2" ? "retry" : "done";
    });
    // Stops at the first entry with no answer; nothing after it is attempted.
    expect(done).toBe(1);
    expect(seen).toEqual(["apply:ev-1", "apply:ev-2"]);
    expect(o.list().map((e) => [e.args.eventId, e.attempts])).toEqual([["ev-2", 1], ["ev-3", 0]]);

    expect(await o.drain(async () => "done")).toBe(2);
    expect(o.pendingCount()).toBe(0);
  });

  it("treats a throwing sender as no answer", async () => {
    const o = createPackagingOutbox(memoryStorage(), fixedNow);
    o.enqueue(entry(1));
    expect(await o.drain(async () => { throw new Error("offline"); })).toBe(0);
    expect(o.list()[0].attempts).toBe(1);
  });

  it("does not run two drains at once", async () => {
    const o = createPackagingOutbox(memoryStorage(), fixedNow);
    o.enqueue(entry(1));
    let sends = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const first = o.drain(async () => { sends++; await gate; return "done"; });
    const second = await o.drain(async () => { sends++; return "done"; });
    release();
    expect(second).toBe(0);
    expect(await first).toBe(1);
    expect(sends).toBe(1);
  });

  it("keeps entries added while draining", async () => {
    const o = createPackagingOutbox(memoryStorage(), fixedNow);
    o.enqueue(entry(1));
    await o.drain(async () => { o.enqueue(entry(2)); return "done"; });
    expect(o.list().map((e) => e.args.eventId)).toEqual(["ev-2"]);
  });

  it("ignores corrupted or foreign storage contents", () => {
    expect(createPackagingOutbox(memoryStorage("{not json"), fixedNow).list()).toEqual([]);
    expect(createPackagingOutbox(memoryStorage('{"a":1}'), fixedNow).list()).toEqual([]);
    const mixed = JSON.stringify([{ nope: true }, { args: args(7), orderNumber: "F4T-7", queuedAt: "x", attempts: 0 }]);
    expect(createPackagingOutbox(memoryStorage(mixed), fixedNow).list().map((e) => e.args.eventId)).toEqual(["ev-7"]);
  });

  it("refuses new entries at the cap instead of dropping old ones", () => {
    const o = createPackagingOutbox(memoryStorage(), fixedNow);
    for (let i = 0; i < OUTBOX_MAX_ENTRIES; i++) expect(o.enqueue(entry(i))).toBe(true);
    expect(o.enqueue(entry(9999))).toBe(false);
    expect(o.pendingCount()).toBe(OUTBOX_MAX_ENTRIES);
    expect(o.list()[0].args.eventId).toBe("ev-0");
  });

  it("reports when storage refuses the write, and works without storage", () => {
    const storage = memoryStorage();
    storage.failWrites = true;
    expect(createPackagingOutbox(storage, fixedNow).enqueue(entry(1))).toBe(false);
    // No storage at all: held in memory for this page only, and enqueue says so (false).
    const mem = createPackagingOutbox(null, fixedNow);
    expect(mem.enqueue(entry(1))).toBe(false);
    expect(mem.pendingCount()).toBe(1);
    mem.remove("apply:ev-1");
    expect(mem.pendingCount()).toBe(0);
  });

  it("a failed write still keeps the request in memory for this page", () => {
    const storage = memoryStorage();
    storage.failWrites = true;
    const box = createPackagingOutbox(storage, fixedNow);
    expect(box.enqueue(entry(1))).toBe(false);
    expect(box.pendingCount()).toBe(1);
  });

  it("only sends entries of the signed-in account and site, and keeps the others", async () => {
    const box = createPackagingOutbox(memoryStorage(), fixedNow);
    box.enqueue({ ...entry(1), userId: "u-a" });
    box.enqueue({ ...entry(2), userId: "u-b" });
    box.enqueue({ ...entry(3), userId: "u-a", args: { ...entry(3).args, location: "uk" } });
    const sent: string[] = [];
    const settled = await box.drain(async (e) => {
      sent.push(e.args.requestId);
      return "done";
    }, { userId: "u-a", location: "au" });
    expect(settled).toBe(1);
    expect(sent).toEqual(["apply:ev-1"]);
    expect(box.list().map((e) => e.args.requestId)).toEqual(["apply:ev-2", "apply:ev-3"]);
  });

  it("an entry from before accounts were recorded may be sent by anyone", async () => {
    const box = createPackagingOutbox(memoryStorage(), fixedNow);
    box.enqueue(entry(1));
    expect(await box.drain(async () => "done", { userId: "u-x" })).toBe(1);
  });

  it("moves a settled refusal to the rejected list with its reason", async () => {
    const box = createPackagingOutbox(memoryStorage(), fixedNow);
    box.enqueue({ ...entry(1), userId: "u-a" });
    await box.drain(async () => ({ rejected: "The completion was not found." }), { userId: "u-a" });
    expect(box.pendingCount()).toBe(0);
    expect(box.listRejected().map((e) => [e.args.requestId, e.reason])).toEqual([["apply:ev-1", "The completion was not found."]]);
  });

  it("keeps the entry and stops when there is no usable answer", async () => {
    const box = createPackagingOutbox(memoryStorage(), fixedNow);
    box.enqueue({ ...entry(1), userId: "u-a" });
    box.enqueue({ ...entry(2), userId: "u-a" });
    expect(await box.drain(async () => "retry", { userId: "u-a" })).toBe(0);
    expect(box.list().map((e) => [e.args.requestId, e.attempts])).toEqual([["apply:ev-1", 1], ["apply:ev-2", 0]]);
  });
});
