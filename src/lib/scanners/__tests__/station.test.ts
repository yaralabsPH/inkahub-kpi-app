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

function setup(over: { activate?: ControllerDeps["activate"]; commit?: (personId: string) => Promise<CommitOutcome>; failWrites?: () => boolean; clock?: () => number; mode?: ControllerDeps["mode"]; elapsed?: () => number } = {}) {
  const outbox = createScannerOutbox(memoryJobStore({ failWrites: over.failWrites }), over.clock);
  const sounds: SoundKind[] = [];
  const committedFor: string[] = [];
  const people: Record<string, { id: string; name: string }> = { AAAA0001: { id: ALICE, name: "Alice" }, BBBB0002: { id: BOB, name: "Bob" } };
  const make = () => {
  let self: SharedScannerController | null = null;
  self = new SharedScannerController({
    scannerIds: ["S1", "S2", "S3"],
    scope,
    mode: over.mode,
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
    now: over.clock ?? (() => 1_000_000),
    elapsedNow: over.elapsed,
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

  it("corruption retains identities pending activation and activity timestamps", async () => {
    const reasons = ["stray_text", "too_long", "too_slow", "frame_timeout", "bad_structure", "mismatched_markers", "unknown_scanner", "bad_payload", "unexpected_key"] as const;
    for (const mode of ["framing", "dispatch"] as const) {
      for (const reason of reasons) {
        for (const source of [null, "S1"] as const) {
          let release!: () => void;
          const slow = new Promise<void>((r) => (release = r));
          let activations = 0;
          const { c, sounds, outbox } = setup({
            mode,
            activate: async ({ badge }) => {
              activations++;
              if (badge === "BBBB0002") await slow;
              return { outcome: "activated", personId: badge === "AAAA0001" ? ALICE : BOB, displayName: badge === "AAAA0001" ? "Alice" : "Bob", clockedIn: false };
            },
          });
          c.onFrame("S1", "AAAA0001");
          await settle();
          c.onFrame("S2", "BBBB0002"); // still pending when the error arrives
          const before = JSON.stringify(c.state.slots);
          const soundsBefore = sounds.length;
          c.onProtocolError(reason, source);
          const label = `${mode}/${reason}/${source}`;
          expect(JSON.stringify(c.state.slots), label).toBe(before); // identities, pending, epochs, idle times
          expect(sounds.slice(soundsBefore), label).toEqual(["error"]);
          expect(activations, label).toBe(2);
          expect((await outbox.view(scope)).jobs, label).toHaveLength(0);
          expect(c.state.recovery?.title, label).toBe("That scan didn't come through.");
          expect(c.state.recovery?.setupHint !== null, label).toBe(reason === "unknown_scanner");
          // The earlier valid activation still binds its worker, but cannot dismiss recovery.
          release();
          await settle();
          expect(c.state.slots.S2.identity?.displayName, label).toBe("Bob");
          expect(c.state.slots.S1.identity?.displayName, label).toBe("Alice");
          expect(c.state.recovery, label).not.toBeNull();
        }
      }
    }
  });

  it("recovery survives old completions and refused frames", async () => {
    let releaseBadge!: () => void;
    const slowBadge = new Promise<void>((r) => (releaseBadge = r));
    let releaseCommit!: () => void;
    const slowCommit = new Promise<void>((r) => (releaseCommit = r));
    const { c } = setup({
      activate: async ({ badge }) => {
        if (badge === "BBBB0002") await slowBadge;
        return { outcome: "activated", personId: badge === "AAAA0001" ? ALICE : BOB, displayName: badge === "AAAA0001" ? "Alice" : "Bob", clockedIn: false };
      },
      commit: async () => {
        await slowCommit;
        return { outcome: "saved", result: { pieces: 2, eventIds: [], negativeCodes: [], replayed: false } };
      },
    });
    c.onFrame("S1", "AAAA0001");
    await settle();
    c.onFrame("S1", "190203"); // accepted before the error; its delivery is still running
    c.onFrame("S2", "BBBB0002"); // activation still running
    await settle(3);
    c.onProtocolError("bad_structure", null);
    // Old completions, a refused frame and an invalid payload leave recovery up.
    c.onFrame("S3", "190204"); // no person on S3: refused
    c.onFrame("S1", "NOT-A-CODE"); // invalid payload: refused
    c.tick();
    await c.refreshView();
    releaseBadge();
    releaseCommit();
    await settle();
    expect(c.state.last?.kind).toBe("saved");
    expect(c.state.recovery).not.toBeNull();
    // A good scan after the error clears it, from any scanner.
    c.onFrame("S2", "190205");
    await settle();
    expect(c.state.recovery).toBeNull();
    // Two errors with a good scan between them: the earlier good scan cannot clear the newer error.
    c.onProtocolError("too_slow", null);
    c.onFrame("S1", "190206");
    c.onProtocolError("mismatched_markers", "S1");
    await settle();
    expect(c.state.recovery).not.toBeNull();
  });

  it("a failed queue write or a refused badge does not clear recovery", async () => {
    let fail = false;
    const { c } = setup({ failWrites: () => fail });
    c.onFrame("S1", "AAAA0001");
    await settle();
    c.onProtocolError("bad_structure", null);
    fail = true;
    c.onFrame("S1", "190203");
    await settle();
    expect(c.state.last?.title).toMatch(/NOT SAVED/);
    expect(c.state.recovery).not.toBeNull();
    fail = false;
    c.onFrame("S2", "CCCC0003"); // unknown badge
    await settle();
    expect(c.state.recovery).not.toBeNull();
    c.resetAll("Signed out by the operator.");
    expect(c.state.recovery).not.toBeNull();
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

  it("badge x3: two repeat checks, then only that scanner signs out, with no third call and no clock-out", async () => {
    let elapsed = 0;
    const calls: string[] = [];
    const { c, sounds, committedFor } = setup({
      elapsed: () => elapsed,
      activate: async ({ badge, scannerId }) => {
        calls.push(`${scannerId}:${badge}`);
        return badge === "AAAA0001"
          ? { outcome: "activated", personId: ALICE, displayName: "Alice", clockedIn: calls.length === 1 }
          : { outcome: "activated", personId: BOB, displayName: "Bob", clockedIn: true };
      },
    });
    c.onFrame("S1", "AAAA0001");
    c.onFrame("S2", "BBBB0002");
    await settle();
    // Alice frames an order, then signs out; the queued order keeps her as the person.
    c.onFrame("S1", "190203");
    await settle();
    elapsed = 2_000;
    c.onFrame("S1", "AAAA0001");
    await settle();
    expect(c.state.last).toMatchObject({ kind: "info", title: "S1 · Alice · Sign out 1/3", detail: "Remove badge; wait one second before scanning again." });
    elapsed = 2_500; // held badge: suppressed locally, nothing sent
    c.onFrame("S1", "AAAA0001");
    expect(c.state.slotNotes.S1).toBe("Remove the badge, wait one second, then scan again");
    await settle();
    elapsed = 4_000;
    c.onFrame("S1", "AAAA0001");
    await settle();
    expect(c.state.slotNotes.S1).toBeUndefined();
    expect(c.state.last).toMatchObject({ title: "S1 · Alice · Sign out 2/3" });
    elapsed = 6_000;
    c.onFrame("S1", "AAAA0001");
    expect(c.state.last).toMatchObject({ kind: "signed_out", title: "S1 signed out", detail: "Alice is still clocked in. Scan a badge to use S1." });
    expect(c.state.slots.S1.identity).toBeNull();
    expect(c.state.slots.S2.identity?.displayName).toBe("Bob");
    await settle();
    // Initial sign-in plus exactly two repeat checks; the third read made no call.
    expect(calls).toEqual(["S1:AAAA0001", "S2:BBBB0002", "S1:AAAA0001", "S1:AAAA0001"]);
    expect(committedFor).toEqual(["10190203:Alice"]);
    expect(sounds.filter((x) => x === "error")).toEqual([]);
    // A late answer cannot sign her back in, and S1 needs a badge for orders.
    c.onFrame("S1", "190204");
    expect(c.state.last).toMatchObject({ kind: "rejected", detail: "Scan your badge on this scanner first." });
  });

  it("successful repeats and sign-out clear recovery; suppressed reads do not", async () => {
    let elapsed = 0;
    const { c } = setup({ elapsed: () => elapsed });
    c.onFrame("S1", "AAAA0001");
    await settle();
    c.onProtocolError("bad_structure", null);
    elapsed = 500;
    c.onFrame("S1", "AAAA0001"); // suppressed
    await settle();
    expect(c.state.recovery).not.toBeNull();
    elapsed = 2_000;
    c.onFrame("S1", "AAAA0001"); // counted repeat
    await settle();
    expect(c.state.recovery).toBeNull();
    expect(c.state.slots.S1.signOut?.count).toBe(1);
    // An unknown-source parser error cancels the progress but keeps Alice.
    c.onProtocolError("too_slow", null);
    expect(c.state.slots.S1.signOut).toBeNull();
    expect(c.state.slots.S1.identity?.displayName).toBe("Alice");
  });

  it("dispatch shows no sign-out progress for repeated badge reads", async () => {
    let elapsed = 0;
    const { c } = setup({ elapsed: () => elapsed, mode: "dispatch" });
    for (const at of [0, 300, 600, 900]) {
      elapsed = at;
      c.onFrame("S1", "AAAA0001");
      await settle();
      expect(c.state.slots.S1.signOut).toBeNull();
      expect(c.state.last?.kind).toBe("signed_in");
    }
    expect(c.state.slots.S1.identity?.displayName).toBe("Alice");
  });
});
