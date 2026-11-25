import { describe, expect, it } from "vitest";
import { SharedScannerController, type ControllerDeps, type SoundKind } from "../station";
import { createScannerOutbox, memoryJobStore, type JobScope } from "../outbox";
import { processNext, type ActivateOutcome, type CommitOutcome } from "../client";
import type { OrderLookup } from "../order";

const scope: JobScope = { backend: "supabase", callerId: "kiosk-1", location: "au", receiverId: "wall-1" };
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const order = (n: string): OrderLookup => ({
  found: true, complete: true, truncated: false, order_name: `#${n}`, cancelled_at: null, tags: [],
  line_items: [{ sku: "INKA-S2ABC0001-A2-FB", quantity: 1 }],
});

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 20) {
  for (let i = 0; i < n; i++) await tick();
}

function setup(over: { activate?: ControllerDeps["activate"]; commit?: (personId: string) => Promise<CommitOutcome>; failWrites?: () => boolean; clock?: () => number } = {}) {
  const outbox = createScannerOutbox(memoryJobStore({ failWrites: over.failWrites }), over.clock);
  const sounds: SoundKind[] = [];
  const committedFor: string[] = [];
  const people: Record<string, { id: string; name: string }> = { AAAA0001: { id: ALICE, name: "Alice" }, BBBB0002: { id: BOB, name: "Bob" } };
  const make = () => {
  let self: SharedScannerController | null = null;
  self = new SharedScannerController({
    scannerIds: ["S1", "S2", "S3"],
    scope,
    outbox,
    activate: over.activate ?? (async ({ badge }): Promise<ActivateOutcome> =>
      people[badge] ? { outcome: "activated", personId: people[badge].id, displayName: people[badge].name, clockedIn: true } : { outcome: "unknown_badge" }),
    deliver: () => processNext({
      outbox, scope, owner: "tab",
      active: () => self !== null && !self.isDisposed,
      lookupOrder: async (n) => ({ kind: "ok", lookup: order(n) }),
      openCase: async () => false,
      products: () => [],
      packaging: async () => ({ mode: "scan", ruleSet: null }),
      commit: async (job) => {
        committedFor.push(`${job.orderNumber}:${job.displayName}`);
        return over.commit ? over.commit(job.personId) : { outcome: "saved", result: { pieces: 2, eventIds: [], negativeCodes: [], replayed: false } };
      },
    }),
    isOnline: () => true,
    now: () => 1_000_000,
    newRequestId: uuid,
    sound: (k) => sounds.push(k),
  });
  return self;
  };
  const c = make();
  return { c, outbox, sounds, committedFor, make };
}

describe("SharedScannerController", () => {
  it("badge -> order -> amber queued, then green saved with person, order and pieces", async () => {
    const { c, sounds } = setup();
    c.onFrame("S1", "AAAA0001");
    await settle();
    expect(c.state.slots.S1.identity?.displayName).toBe("Alice");
    c.onFrame("S1", "190203");
    // Nothing is shown as accepted until the queue write has succeeded.
    expect(c.state.last?.kind).toBe("signed_in");
    await settle();
    expect(c.state.last).toMatchObject({ kind: "saved", person: "Alice", order: "10190203", pieces: 2 });
    expect(sounds).toEqual(["ok", "queued", "ok"]);
  });

  it("a later badge scan cannot re-credit an order already accepted", async () => {
    const { c, committedFor } = setup();
    c.onFrame("S1", "AAAA0001");
    await settle();
    c.onFrame("S1", "190203");
    c.onFrame("S1", "BBBB0002"); // immediately, before anything was saved
    await settle();
    expect(committedFor).toEqual(["10190203:Alice"]);
    expect(c.state.slots.S1.identity?.displayName).toBe("Bob");
  });

  it("does not ignore scans while another request is busy", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const { c, committedFor } = setup({
      activate: async ({ badge }) => {
        if (badge === "BBBB0002") await slow; // S2's sign-in hangs
        return { outcome: "activated", personId: badge === "AAAA0001" ? ALICE : BOB, displayName: badge === "AAAA0001" ? "Alice" : "Bob", clockedIn: false };
      },
    });
    c.onFrame("S1", "AAAA0001");
    await settle();
    c.onFrame("S2", "BBBB0002");
    c.onFrame("S1", "190203");
    c.onFrame("S1", "190204");
    await settle();
    expect(committedFor).toEqual(["10190203:Alice", "10190204:Alice"]);
    // S2 is still signing in: its order is refused loudly, not swallowed.
    c.onFrame("S2", "190205");
    expect(c.state.last).toMatchObject({ kind: "rejected", scannerId: "S2" });
    release();
    await settle();
    expect(c.state.slots.S2.identity?.displayName).toBe("Bob");
  });

  it("a storage failure is red NOT SAVED, never queued or green", async () => {
    const { c, committedFor } = setup({ failWrites: () => true });
    c.onFrame("S1", "AAAA0001");
    await settle();
    c.onFrame("S1", "190203");
    await settle();
    expect(c.state.last).toMatchObject({ kind: "rejected", title: "NOT SAVED: #10190203" });
    expect(c.state.storageError).toMatch(/storage/i);
    expect(committedFor).toEqual([]);
  });

  it("a garbled stream signs every scanner out; a late activation answer is ignored", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const { c } = setup({
      activate: async ({ badge }) => {
        if (badge === "BBBB0002") await slow;
        return { outcome: "activated", personId: ALICE, displayName: badge, clockedIn: false };
      },
    });
    c.onFrame("S1", "AAAA0001");
    await settle();
    c.onFrame("S2", "BBBB0002");
    c.onProtocolError("bad_structure", null);
    expect(c.state.slots.S1.identity).toBeNull();
    expect(c.state.last).toMatchObject({ kind: "rejected", title: expect.stringMatching(/every scanner signed out/) });
    release();
    await settle();
    expect(c.state.slots.S2.identity).toBeNull();
  });

  it("an unknown outcome stays amber and retries; already-recorded is not green", async () => {
    let calls = 0;
    const { c } = setup({
      commit: async () => (++calls === 1
        ? { outcome: "network_error", message: "timeout" }
        : { outcome: "already_recorded", reason: "framed already completed" }),
    });
    c.onFrame("S1", "AAAA0001");
    await settle();
    c.onFrame("S1", "190203");
    await settle();
    expect(c.state.last).toMatchObject({ kind: "queued" });
    expect(c.state.deliveryWaiting).toBe("timeout");
    expect(c.state.view?.uncertain).toBe(1);
  });

  it("R1-11: StrictMode setup -> cleanup -> setup gives a live controller: badge -> order -> saved", async () => {
    const { c: first, make, committedFor } = setup();
    first.dispose(); // StrictMode's immediate cleanup
    const second = make(); // ...and setup again
    first.onFrame("S1", "AAAA0001"); // the disposed one starts nothing
    await settle();
    expect(first.state.slots.S1.identity).toBeNull();
    second.onFrame("S1", "AAAA0001");
    await settle();
    second.onFrame("S1", "190203");
    await settle();
    expect(second.state.last).toMatchObject({ kind: "saved", person: "Alice", order: "10190203" });
    expect(committedFor).toEqual(["10190203:Alice"]);
  });

  it("R1-1: a known but unusable 8-digit badge signs the scanner out and saves nothing for the old person", async () => {
    const { c, committedFor } = setup({
      activate: async ({ badge }) => (badge === "AAAA0001"
        ? { outcome: "activated", personId: ALICE, displayName: "Alice", clockedIn: false }
        : { outcome: "unusable_badge" }),
    });
    c.onFrame("S1", "AAAA0001");
    await settle();
    c.onFrame("S1", "10190203");
    await settle();
    expect(committedFor).toEqual([]);
    expect(c.state.slots.S1.identity).toBeNull();
    expect(c.state.last).toMatchObject({ kind: "rejected", detail: expect.stringMatching(/cannot be used here/) });
  });

  it("R1-2: a refusal after an unanswered save says 'not confirmed', never 'not saved — use classic'", async () => {
    let n = 0;
    let clock = 1_000_000;
    const { c } = setup({
      clock: () => clock,
      commit: async () => (++n === 1 ? { outcome: "network_error", message: "timeout" } : { outcome: "rejected", code: "unavailable", message: "RPC missing" }),
    });
    c.onFrame("S1", "AAAA0001");
    await settle();
    c.onFrame("S1", "190203");
    await settle();
    expect(n).toBe(1);
    clock += 120_000; // past the back-off
    c.pump();
    await settle();
    expect(n).toBe(2);
    expect(c.state.last?.kind).not.toBe("rejected");
    expect(c.state.last?.title).toMatch(/not confirmed/);
    expect(c.state.last?.detail).toMatch(/Do NOT record it on the classic station/);
    expect(c.state.view?.jobs[0]).toMatchObject({ status: "blocked", uncertain: true });
  });

  it("R2-1: a stale tab's late refusal leaves its wall without a false NOT SAVED", async () => {
    let clock = 1_000_000;
    const outbox = createScannerOutbox(memoryJobStore(), () => clock);
    let releaseA!: (o: CommitOutcome) => void;
    const mk = (owner: string, commit: () => Promise<CommitOutcome>) => new SharedScannerController({
      scannerIds: ["S1"], scope, outbox,
      activate: async () => ({ outcome: "activated", personId: ALICE, displayName: "Alice", clockedIn: false }),
      deliver: () => processNext({
        outbox, scope, owner,
        lookupOrder: async (n) => ({ kind: "ok", lookup: order(n) }),
        openCase: async () => false, products: () => [], packaging: async () => ({ mode: "scan", ruleSet: null }), commit,
      }),
      isOnline: () => true, now: () => clock, newRequestId: uuid, sound: () => {},
    });
    const a = mk("tab-A", () => new Promise<CommitOutcome>((r) => (releaseA = r)));
    const b = mk("tab-B", async () => ({ outcome: "saved", result: { pieces: 2, eventIds: [], negativeCodes: [], replayed: true } }));
    a.onFrame("S1", "AAAA0001");
    await settle();
    a.onFrame("S1", "190203");
    await settle(); // A sends and hangs
    clock += 61_000; // A's lease expires
    b.pump();
    await settle();
    expect(b.state.last).toMatchObject({ kind: "saved" });
    releaseA({ outcome: "rejected", code: "forbidden_role", message: "late" });
    await settle();
    expect(a.state.last?.kind).not.toBe("rejected");
    expect(a.state.last?.title ?? "").not.toMatch(/not saved/i);
  });
});

