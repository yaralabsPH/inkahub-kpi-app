import { describe, expect, it } from "vitest";
import { SharedScannerController } from "../station";
import { createScannerOutbox, memoryJobStore, type JobScope } from "../outbox";
import { processNext, type ActivateOutcome, type CommitOutcome } from "../client";
import type { OrderLookup } from "../order";
import type { RuleSetBody } from "@/lib/domain/packaging/ruleSet";

// Synthetic rules; not real box rules.
const body: RuleSetBody = {
  schema_version: 1,
  catalogue: [{ key: "BOXM", product_id: "p-box", label: "Medium box", packing_points: ["dispatch"] }],
  rules: [{ id: "d", packing_point: "dispatch", kinds: ["framed"], output: { mode: "per_capacity", capacity: 4, package: "BOXM" } }],
  examples: [],
};

const scope: JobScope = { backend: "supabase", callerId: "kiosk-1", location: "au", receiverId: "desk-1" };
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const DEE = "33333333-3333-4333-8333-333333333333";
const SKU = "INKA-S2ABC0001-A2-FB";
const order = (n: string): OrderLookup => ({
  found: true, complete: true, truncated: false, order_name: `#${n}`, cancelled_at: null, tags: [],
  line_items: [{ sku: SKU, quantity: 1 }],
});
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 40) {
  for (let i = 0; i < n; i++) await tick();
}

function setup(evidence: "measured" | "missing") {
  const outbox = createScannerOutbox(memoryJobStore());
  const dispatched: Array<{ order: string; person: string; choices: unknown }> = [];
  let now = Date.UTC(2026, 10, 22, 8, 0, 0);
  const c = new SharedScannerController({
    scannerIds: ["S1"], scope, outbox, mode: "dispatch",
    activate: async (): Promise<ActivateOutcome> => ({
      outcome: "activated", personId: DEE, displayName: "Dee", clockedIn: true, workdayEndsAt: Date.UTC(2026, 10, 22, 17, 0, 0),
    }),
    deliver: () => processNext({
      outbox, scope, owner: "tab",
      lookupOrder: async (n) => ({ kind: "ok", lookup: order(n) }),
      openCase: async () => false,
      products: () => [{ id: "p", code: "A2-Black" }],
      packaging: async () => ({ mode: "auto", ruleSet: { id: "rs", version: 1, body } }),
      commit: async () => { throw new Error("the framing commit must not be used for a dispatch job"); },
      evidence: async () => ({
        outcome: "ok",
        evidence: [evidence === "measured"
          ? { sku: SKU, status: "measured", personId: ALICE, displayName: "Alice", verifiedEventId: "v", completedEventId: "c" }
          : { sku: SKU, status: "missing", personId: null, displayName: null, verifiedEventId: null, completedEventId: null }],
      }),
      commitDispatch: async (job, prepared): Promise<CommitOutcome> => {
        dispatched.push({ order: job.orderNumber, person: job.personId, choices: prepared.choices });
        const manual = prepared.choices[0];
        return { outcome: "saved", result: { pieces: prepared.items, eventIds: ["d"], negativeCodes: [], replayed: false,
          attributions: [{ sku: SKU, source: manual ? "manual" : "scan", personId: manual?.personId ?? ALICE, displayName: manual?.displayName ?? "Alice" }] } };
      },
    }),
    isOnline: () => true, now: () => now, newRequestId: uuid, sound: () => {},
  });
  return { c, outbox, dispatched, advance: (ms: number) => { now += ms; } };
}

describe("SharedScannerController: F7 dispatch mode", () => {
  it("one badge per shift (no 10-minute sign-out); jobs carry dispatch mode; the result names the framer", async () => {
    const { c, outbox, dispatched, advance } = setup("measured");
    c.onFrame("S1", "DDDD0001");
    await settle();
    expect(c.state.slots.S1.identity).toMatchObject({ personId: DEE, expiresAt: Date.UTC(2026, 10, 22, 17, 0, 0) });
    advance(2 * 60 * 60 * 1000); // two quiet hours
    c.tick();
    expect(c.state.slots.S1.identity?.personId).toBe(DEE);
    c.onFrame("S1", "190203");
    await settle();
    expect(dispatched).toEqual([{ order: "10190203", person: DEE, choices: [] }]);
    expect(c.state.last).toMatchObject({ kind: "saved", title: "Dispatched #10190203", framers: [{ source: "scan", displayName: "Alice" }] });
    expect((await outbox.view(scope)).jobs[0]).toMatchObject({ mode: "dispatch", status: "done" });
  });

  it("missing framing: amber 'choose who framed it', nothing sent; the choice then dispatches it as manual", async () => {
    const { c, outbox, dispatched } = setup("missing");
    c.onFrame("S1", "DDDD0001");
    await settle();
    c.onFrame("S1", "190203");
    await settle();
    expect(dispatched).toHaveLength(0);
    expect(c.state.last).toMatchObject({ kind: "queued", title: "#10190203: framing scan missing" });
    const job = (await outbox.view(scope)).jobs[0];
    await c.chooseFramers(job.requestId, [{ sku: SKU, personId: BOB, displayName: "Bob" }]);
    await settle();
    expect(dispatched).toEqual([{ order: "10190203", person: DEE, choices: [{ sku: SKU, personId: BOB, displayName: "Bob" }] }]);
    expect(c.state.last).toMatchObject({ kind: "saved", framers: [{ source: "manual", displayName: "Bob" }] });
  });

  it("a choice for the wrong SKU is refused loudly and the job keeps waiting", async () => {
    const { c, outbox, dispatched } = setup("missing");
    c.onFrame("S1", "DDDD0001");
    await settle();
    c.onFrame("S1", "190203");
    await settle();
    const job = (await outbox.view(scope)).jobs[0];
    await c.chooseFramers(job.requestId, [{ sku: "INKA-XYZ0001-A2-FB", personId: BOB, displayName: "Bob" }]);
    expect(c.state.last).toMatchObject({ kind: "rejected", title: "Framer choice not saved" });
    expect((await outbox.view(scope)).jobs[0]).toMatchObject({ status: "blocked", blocked: { code: "framer_missing" } });
    expect(dispatched).toHaveLength(0);
  });

  it("after the shift ends the next order is refused, never queued for the old dispatcher", async () => {
    const { c, outbox, advance } = setup("measured");
    c.onFrame("S1", "DDDD0001");
    await settle();
    advance(10 * 60 * 60 * 1000); // past 17:00 site workday end
    c.onFrame("S1", "190203");
    await settle();
    expect(c.state.last).toMatchObject({ kind: "rejected" });
    expect(c.state.slots.S1.identity).toBeNull();
    expect((await outbox.view(scope)).jobs).toHaveLength(0);
  });
});
