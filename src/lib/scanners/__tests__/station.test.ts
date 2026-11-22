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

function setup(over: { activate?: ControllerDeps["activate"]; commit?: (personId: string) => Promise<CommitOutcome>; failWrites?: () => boolean } = {}) {
  const outbox = createScannerOutbox(memoryJobStore({ failWrites: over.failWrites }));
  const sounds: SoundKind[] = [];
  const committedFor: string[] = [];
  const people: Record<string, { id: string; name: string }> = { AAAA0001: { id: ALICE, name: "Alice" }, BBBB0002: { id: BOB, name: "Bob" } };
  const c = new SharedScannerController({
    scannerIds: ["S1", "S2", "S3"],
    scope,
    outbox,
    activate: over.activate ?? (async ({ badge }): Promise<ActivateOutcome> =>
      people[badge] ? { outcome: "activated", personId: people[badge].id, displayName: people[badge].name, clockedIn: true } : { outcome: "unknown_badge" }),
    deliver: () => processNext({
      outbox, scope, owner: "tab",
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
  return { c, outbox, sounds, committedFor };
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
});
