import { describe, expect, it } from "vitest";
import { createScannerOutbox, memoryJobStore, type JobScope, type ScannerJob } from "../outbox";
import { processNext, type ActivateOutcome, type CommitOutcome, type DeliveryDeps, type LookupOutcome } from "../client";
import { SharedScannerController, type ControllerDeps } from "../station";
import type { CapturedOrder } from "../session";
import type { OrderLookup } from "../order";

// scanner-wall-redesign Task 3: truthful per-scan progress, display only.

const scope: JobScope = { backend: "supabase", callerId: "kiosk-1", location: "au", receiverId: "wall-1" };
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const lookup = (n: string): OrderLookup => ({
  found: true, complete: true, truncated: false, order_name: `#${n}`, cancelled_at: null, tags: [],
  line_items: [{ sku: "INKA-ABC0001-A2-FB", quantity: 2 }],
});
const captured = (): CapturedOrder => ({ scannerId: "S1", orderNumber: "10190203", person: { personId: ALICE, displayName: "Alice", badge: "AAAA0001" }, scannedAt: 1_000 });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("processNext onProgress", () => {
  it("checking only after a claim, saving only right before the commit; a prepared retry skips checking", async () => {
    let clock = 1_000;
    const ob = createScannerOutbox(memoryJobStore(), () => clock);
    await ob.enqueue(captured(), scope, uuid());
    const events: string[] = [];
    const sent: string[] = [];
    let answer: CommitOutcome = { outcome: "network_error", message: "timeout" };
    const d: DeliveryDeps = {
      outbox: ob, scope, owner: "tab",
      lookupOrder: async (): Promise<LookupOutcome> => { events.push("lookup"); return { kind: "ok", lookup: lookup("10190203") }; },
      openCase: async () => false,
      products: () => [],
      packaging: async () => ({ mode: "scan", ruleSet: null }),
      commit: async (job, prepared) => { events.push("commit"); sent.push(JSON.stringify(prepared)); return answer; },
      onProgress: (e) => events.push(e.phase),
    };
    expect(await processNext(d)).toMatchObject({ kind: "waiting" });
    expect(events).toEqual(["checking", "lookup", "saving", "commit"]);
    events.length = 0;
    clock += 120_000; // past the back-off
    answer = { outcome: "saved", result: { pieces: 2, eventIds: [], negativeCodes: [], replayed: true } };
    expect(await processNext(d)).toMatchObject({ kind: "saved" });
    expect(events).toEqual(["saving", "commit"]); // the stored payload is resent; nothing is checked again
    expect(sent[1]).toBe(sent[0]);
  });

  it("a throwing observer changes nothing about delivery", async () => {
    const run = async (onProgress?: DeliveryDeps["onProgress"]) => {
      const ob = createScannerOutbox(memoryJobStore());
      await ob.enqueue(captured(), scope, uuid());
      let commits = 0;
      const report = await processNext({
        outbox: ob, scope, owner: "tab",
        lookupOrder: async () => ({ kind: "ok", lookup: lookup("10190203") }),
        openCase: async () => false,
        products: () => [],
        packaging: async () => ({ mode: "scan", ruleSet: null }),
        commit: async () => { commits++; return { outcome: "saved", result: { pieces: 2, eventIds: [], negativeCodes: [], replayed: false } }; },
        onProgress,
      });
      return { report, commits, view: await ob.view(scope) };
    };
    const plain = await run();
    const throwing = await run(() => { throw new Error("observer broke"); });
    expect(throwing.report?.kind).toBe(plain.report?.kind);
    expect(throwing.commits).toBe(plain.commits);
    expect(throwing.view.jobs[0].status).toBe(plain.view.jobs[0].status);
  });
});

describe("controller progress, last saved and goodbye", () => {
  function rig(over: { commit?: () => Promise<CommitOutcome>; lookup?: () => Promise<LookupOutcome> } = {}) {
    const outbox = createScannerOutbox(memoryJobStore());
    let elapsed = 0;
    const people: Record<string, { id: string; name: string }> = { AAAA0001: { id: ALICE, name: "Alice" }, BBBB0002: { id: BOB, name: "Bob" } };
    let c!: SharedScannerController;
    const deps: ControllerDeps = {
      scannerIds: ["S1", "S2", "S3"], scope, outbox,
      activate: async ({ badge }): Promise<ActivateOutcome> => (people[badge]
        ? { outcome: "activated", personId: people[badge].id, displayName: people[badge].name, clockedIn: false }
        : { outcome: "unknown_badge" }),
      deliver: () => processNext({
        outbox, scope, owner: "tab",
        lookupOrder: over.lookup ?? (async () => ({ kind: "ok", lookup: lookup("10190203") })),
        openCase: async () => false,
        products: () => [],
        packaging: async () => ({ mode: "scan", ruleSet: null }),
        commit: over.commit ?? (async () => ({ outcome: "saved", result: { pieces: 2, eventIds: [], negativeCodes: [], replayed: false } })),
        onProgress: (e) => c.onDeliveryProgress(e),
      }),
      isOnline: () => true,
      now: () => 5_000,
      elapsedNow: () => elapsed,
      newRequestId: uuid,
      sound: () => {},
    };
    c = new SharedScannerController(deps);
    return { c, setElapsed: (v: number) => { elapsed = v; } };
  }

  it("received after the durable write, then checking, saving, and gone once saved; only saved is green", async () => {
    const lookupGate = deferred<LookupOutcome>();
    const commitGate = deferred<CommitOutcome>();
    const { c } = rig({ lookup: () => lookupGate.promise, commit: () => commitGate.promise });
    c.onFrame("S1", "AAAA0001");
    await settle();
    c.onFrame("S1", "190203");
    expect(Object.values(c.state.progress)).toEqual([]); // nothing before the queue write
    await settle();
    expect(Object.values(c.state.progress).map((p) => p.phase)).toEqual(["checking"]);
    expect(c.state.last?.kind).toBe("queued");
    lookupGate.resolve({ kind: "ok", lookup: lookup("10190203") });
    await settle();
    expect(Object.values(c.state.progress)).toMatchObject([{ phase: "saving", scannerId: "S1", personId: ALICE, orderNumber: "10190203", mode: "framing" }]);
    expect(c.state.last?.kind).not.toBe("saved");
    commitGate.resolve({ outcome: "saved", result: { pieces: 2, eventIds: [], negativeCodes: [], replayed: false } });
    await settle();
    expect(c.state.progress).toEqual({});
    expect(c.state.last?.kind).toBe("saved");
    expect(c.state.slotSaved.S1).toMatchObject({ personId: ALICE, orderNumber: "10190203", pieces: 2, mode: "framing" });
    expect(c.state.saveRevision).toBe(1);
  });

  it("already-recorded bumps the re-read counter but records no saved order; a refusal clears busy state", async () => {
    let n = 0;
    const { c } = rig({
      commit: async () => (++n === 1
        ? { outcome: "already_recorded", reason: "framed already completed" }
        : { outcome: "rejected", code: "badge_inactive", message: "revoked" }),
    });
    c.onFrame("S1", "AAAA0001");
    await settle();
    c.onFrame("S1", "190203");
    await settle();
    expect(c.state.saveRevision).toBe(1);
    expect(c.state.slotSaved.S1).toBeUndefined();
    c.onFrame("S1", "190204");
    await settle();
    expect(c.state.progress).toEqual({});
    expect(c.state.last?.kind).toBe("rejected");
  });

  it("a save for the old person after a rebind is kept under that person, not the new one", async () => {
    const gate = deferred<CommitOutcome>();
    const { c } = rig({ commit: () => gate.promise });
    c.onFrame("S1", "AAAA0001");
    await settle();
    c.onFrame("S1", "190203"); // Alice's order
    await settle();
    c.onFrame("S1", "BBBB0002"); // Bob takes the scanner before it saved
    await settle();
    gate.resolve({ outcome: "saved", result: { pieces: 2, eventIds: [], negativeCodes: [], replayed: false } });
    await settle();
    expect(c.state.slots.S1.identity?.personId).toBe(BOB);
    expect(c.state.slotSaved.S1.personId).toBe(ALICE); // the wall shows it only for Alice
  });

  it("progress from another scope is ignored", () => {
    const { c } = rig();
    const foreign = { requestId: "x", scannerId: "S1", personId: ALICE, orderNumber: "1", scannedAt: new Date(0).toISOString(),
      backend: "supabase", callerId: "someone-else", location: "au", receiverId: "wall-1" } as unknown as ScannerJob;
    c.onDeliveryProgress({ job: foreign, phase: "checking" });
    expect(c.state.progress).toEqual({});
  });

  it("goodbye after a badge sign-out, cleared by the next scan on that scanner; expiry and reset are not goodbyes", async () => {
    const { c, setElapsed } = rig();
    c.onFrame("S1", "AAAA0001");
    await settle();
    for (const at of [2_000, 4_000]) {
      setElapsed(at);
      c.onFrame("S1", "AAAA0001");
      await settle();
    }
    setElapsed(6_000);
    c.onFrame("S1", "AAAA0001");
    expect(c.state.goodbye.S1).toMatchObject({ personId: ALICE, displayName: "Alice" });
    setElapsed(8_000);
    c.onFrame("S1", "190203"); // next scan on S1 (refused: nobody there) ends the goodbye
    expect(c.state.goodbye.S1).toBeUndefined();
    c.onFrame("S2", "BBBB0002");
    await settle();
    c.resetAll("Signed out by the operator.");
    expect(c.state.goodbye).toEqual({});
  });
});
