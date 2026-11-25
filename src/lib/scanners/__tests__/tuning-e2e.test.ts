import { describe, expect, it } from "vitest";
import { createFrameParser, type ProtocolEvent } from "../protocol";
import { SharedScannerController, type SoundKind } from "../station";
import { createScannerOutbox, memoryJobStore, type JobScope } from "../outbox";
import { processNext, type ActivateOutcome } from "../client";
import type { OrderLookup } from "../order";

// scanner-stations-tuning Task 6: real parser events into the real controller.

const scope: JobScope = { backend: "supabase", callerId: "kiosk-1", location: "au", receiverId: "wall-1" };
const PEOPLE: Record<string, { id: string; name: string }> = {
  AAAA0001: { id: "11111111-1111-4111-8111-111111111111", name: "Alice" },
  BBBB0002: { id: "22222222-2222-4222-8222-222222222222", name: "Bob" },
};
const order = (n: string): OrderLookup => ({
  found: true, complete: true, truncated: false, order_name: `#${n}`, cancelled_at: null, tags: [],
  line_items: [{ sku: "INKA-ABC0001-A2-FB", quantity: 1 }, { sku: "INKA-AUXMFL", quantity: 1 }],
});

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function rig(mode: "framing" | "dispatch", hold?: { next: (() => Promise<void>) | null }) {
  let clock = 0; // the parser's key time and the gesture's elapsed clock
  const outbox = createScannerOutbox(memoryJobStore());
  const sounds: SoundKind[] = [];
  const committed: string[] = [];
  const activations: string[] = [];
  const c: SharedScannerController = new SharedScannerController({
    scannerIds: ["S1", "S2", "S3"],
    scope,
    mode,
    outbox,
    activate: async ({ badge, scannerId }): Promise<ActivateOutcome> => {
      activations.push(`${scannerId}:${badge}`);
      const wait = hold?.next;
      if (wait) { hold.next = null; await wait(); }
      const p = PEOPLE[badge];
      return p ? { outcome: "activated", personId: p.id, displayName: p.name, clockedIn: false } : { outcome: "unknown_badge" };
    },
    deliver: () => processNext({
      outbox, scope, owner: "tab",
      lookupOrder: async (n) => ({ kind: "ok", lookup: order(n) }),
      openCase: async () => false,
      products: () => [],
      packaging: async () => ({ mode: "scan", ruleSet: null }),
      commit: async (job, prepared) => {
        committed.push(`${job.orderNumber}:${job.displayName}:${JSON.stringify(prepared.lines.map((l) => l.sku))}`);
        return { outcome: "saved", result: { pieces: 1, eventIds: [], negativeCodes: [], replayed: false } };
      },
    }),
    isOnline: () => true,
    now: () => 1_000_000 + clock,
    elapsedNow: () => clock,
    newRequestId: uuid,
    sound: (k) => sounds.push(k),
  });
  const parser = createFrameParser();
  const route = (events: ProtocolEvent[]) => {
    for (const e of events) {
      if (e.kind === "frame") c.onFrame(e.scannerId, e.payload);
      else c.onProtocolError(e.reason, e.scannerId);
    }
  };
  /** Type text as a scanner would (5 ms per key), then leave a quiet gap. */
  const scan = (text: string, gap = 600) => {
    for (const ch of text + "\n") {
      route(parser.key(ch === "\n" ? "Enter" : ch, clock));
      clock += 5;
    }
    clock += gap;
  };
  /** Keys at explicit offsets from now (for interleavings), then a quiet gap. */
  const keys = (list: Array<[string, number]>, gap = 600) => {
    const t0 = clock;
    for (const [k, dt] of list) route(parser.key(k, t0 + dt));
    clock = t0 + Math.max(...list.map(([, dt]) => dt)) + gap;
    route(parser.tick(clock));
  };
  const at = (t: number) => { clock = t; };
  return { c, outbox, sounds, committed, activations, scan, keys, at, get clock() { return clock; } };
}

describe("tuning end to end", () => {
  for (const mode of ["framing", "dispatch"] as const) {
    it(`strict parser corruption followed by recovery keeps queued attribution (${mode})`, async () => {
      const r = rig(mode);
      r.scan("<S1>AAAA0001</S1>");
      r.scan("<S2>BBBB0002</S2>");
      await settle();
      expect(r.c.state.slots.S1.identity?.displayName).toBe("Alice");
      expect(r.c.state.slots.S2.identity?.displayName).toBe("Bob");
      if (mode === "framing") {
        r.scan("<S1>190203</S1>"); // a good order whose delivery finishes after the errors below
      }
      const corrupt: Array<() => void> = [
        () => r.scan("<S1>190204</S2>"), // mismatched markers
        () => r.scan("<S9>190204</S9>"), // unknown scanner id
        () => r.scan("<S1>19 0204</S1>"), // invalid payload character
        () => r.scan("stray"), // text with no prefix
        // two scanners typing at once
        () => r.keys([["<", 0], ["<", 1], ["S", 2], ["S", 3], ["1", 4], ["2", 5], [">", 6], [">", 7], ["1", 8], ["9", 9], ["Enter", 10]]),
        // a frame that stops half way
        () => { r.keys([["<", 0], ["S", 5], ["1", 10], [">", 15], ["1", 20]], 2_000); },
      ];
      for (const bad of corrupt) {
        const jobsBefore = (await r.outbox.view(scope)).jobs.length;
        const errorsBefore = r.sounds.filter((s) => s === "error").length;
        bad();
        await settle();
        expect((await r.outbox.view(scope)).jobs.length).toBe(jobsBefore); // nothing from the rejected burst
        expect(r.sounds.filter((s) => s === "error").length).toBeGreaterThan(errorsBefore);
        expect(r.c.state.slots.S1.identity?.displayName).toBe("Alice");
        expect(r.c.state.slots.S2.identity?.displayName).toBe("Bob");
        expect(r.c.state.recovery?.title).toBe("That scan didn't come through.");
      }
      if (mode === "framing") {
        // The earlier order was saved for Alice, framing lines only, and did not dismiss recovery.
        expect(r.committed).toEqual(['10190203:Alice:["INKA-ABC0001-A2-FB"]']);
        expect(r.c.state.recovery).not.toBeNull();
        // A good scan after the quiet gap is accepted and clears recovery.
        r.scan("<S2>190205</S2>");
        await settle();
        expect(r.c.state.recovery).toBeNull();
        expect(r.committed).toContain('10190205:Bob:["INKA-ABC0001-A2-FB"]');
      } else {
        r.scan("<S2>BBBB0002</S2>");
        await settle();
        expect(r.c.state.recovery).toBeNull();
      }
    });
  }

  it("a good frame typed straight after an error waits for the quiet gap", async () => {
    const r = rig("framing");
    r.scan("<S1>AAAA0001</S1>");
    await settle();
    r.scan("<S1>190204</S2>", 100); // error, then only 100 ms quiet
    r.scan("<S1>190205</S1>"); // too soon: swallowed while the parser resyncs
    await settle();
    expect(r.committed).toEqual([]);
    expect(r.c.state.recovery).not.toBeNull();
    r.scan("<S1>190206</S1>");
    await settle();
    expect(r.committed).toEqual(['10190206:Alice:["INKA-ABC0001-A2-FB"]']);
  });

  it("cancelled sign-out progress stays cancelled through corruption and a late reply", async () => {
    const hold: { next: (() => Promise<void>) | null } = { next: null };
    const r = rig("framing", hold);
    r.scan("<S1>AAAA0001</S1>", 2_000);
    await settle();
    r.scan("<S1>AAAA0001</S1>", 1_500); // repeat 1, answered at once
    await settle();
    expect(r.c.state.slots.S1.signOut?.count).toBe(1);
    // Repeat 2: its activation reply is held back while a real parser error arrives.
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    hold.next = () => gate;
    r.scan("<S1>AAAA0001</S1>", 1_500);
    await settle();
    expect(r.c.state.slots.S1.pending?.repeat?.progress.count).toBe(2);
    r.scan("<S1>190204</S2>", 1_500); // unknown-source corruption while the reply is pending
    expect(r.c.state.recovery).not.toBeNull();
    release(); // the late reply now arrives
    await settle();
    expect(r.c.state.slots.S1.identity?.displayName).toBe("Alice"); // the person survives
    expect(r.c.state.slots.S1.signOut).toBeNull(); // the cancelled progress does not revive
    expect(r.c.state.recovery).not.toBeNull(); // a reply to a scan from before the error cannot clear it
    // The next qualifying repeat starts again at 1/3; three in a row sign out.
    r.scan("<S1>AAAA0001</S1>", 1_500);
    await settle();
    expect(r.c.state.slots.S1.signOut?.count).toBe(1);
    expect(r.c.state.recovery).toBeNull();
    r.scan("<S1>AAAA0001</S1>", 1_500);
    await settle();
    r.scan("<S1>AAAA0001</S1>", 1_500);
    expect(r.c.state.last).toMatchObject({ kind: "signed_out", title: "S1 signed out" });
    expect(r.c.state.slots.S1.identity).toBeNull();
    // sign-in + repeat 1 + held repeat 2 + two repeats of the new run; the final third made no call
    expect(r.activations.filter((a) => a.startsWith("S1:"))).toHaveLength(5);
  });

});
