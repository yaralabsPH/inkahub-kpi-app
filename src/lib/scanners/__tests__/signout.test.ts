import { describe, expect, it } from "vitest";
import {
  cancelGestures,
  clearAll,
  decideFrame,
  emptySlots,
  expireIdle,
  resolveActivation,
  SIGN_OUT_REPEAT_GAP_MS,
  SIGN_OUT_WINDOW_MS,
  type ActivationResult,
  type FrameDecision,
  type ScannerSlot,
} from "../session";

// scanner-stations-tuning Task 5: three extra own-badge reads sign out one scanner.

const NOW = 1_000_000; // wall clock (UTC ms); the gesture uses the elapsed clock below
let n = 0;
type Slots = Record<string, ScannerSlot>;
type Mode = "framing" | "dispatch";

function frame(slots: Slots, scannerId: string, payload: string, elapsed: number, over: { online?: boolean; now?: number; mode?: Mode } = {}) {
  return decideFrame(slots, { scannerId, payload }, {
    online: over.online ?? true, now: over.now ?? NOW, newRequestId: () => `req-${++n}`, mode: over.mode, elapsedNow: elapsed,
  });
}

const PEOPLE: Record<string, { personId: string; displayName: string }> = {
  AAAA0001: { personId: "alice", displayName: "Alice" },
  BBBB0002: { personId: "bob", displayName: "Bob" },
  10200001: { personId: "nina", displayName: "Nina" },
};

/** Resolve an "activate" decision with the badge's person (or a given result). */
function answer(slots: Slots, d: FrameDecision, elapsed: number, result?: ActivationResult) {
  if (d.action !== "activate") throw new Error(`expected activate, got ${d.action}`);
  const who = PEOPLE[d.pending.badge];
  const r: ActivationResult = result ?? (who ? { outcome: "activated", ...who } : { outcome: "unknown_badge" });
  return resolveActivation(slots, d.scannerId, d.epoch, d.pending.requestId, r, NOW, elapsed);
}

/** Scan a badge and confirm it: one full, successful check. */
function badge(slots: Slots, scannerId: string, code: string, elapsed: number): Slots {
  const f = frame(slots, scannerId, code, elapsed);
  return answer(f.slots, f.decision, elapsed).slots;
}

/** Alice on S1 and Bob on S2, both bound well before the gesture starts at elapsed 0. */
function twoBound(): Slots {
  let s = badge(emptySlots(["S1", "S2", "S3"]), "S1", "AAAA0001", -5_000);
  s = badge(s, "S2", "BBBB0002", -5_000);
  return s;
}

describe("sign-out gesture", () => {
  it("three extra successful own-badge reads sign out one slot", () => {
    let s = twoBound();
    const bob = s.S2;

    let f = frame(s, "S1", "AAAA0001", 0);
    expect(f.decision.action).toBe("activate");
    expect(f.slots.S1.signOut).toBeNull(); // nothing counts until the server confirms
    s = answer(f.slots, f.decision, 50).slots;
    expect(s.S1.signOut).toMatchObject({ count: 1, firstRepeatAt: 0, personId: "alice" });
    expect(s.S1.identity?.displayName).toBe("Alice");

    f = frame(s, "S1", "AAAA0001", 2_000);
    s = answer(f.slots, f.decision, 2_050).slots;
    expect(s.S1.signOut).toMatchObject({ count: 2, firstRepeatAt: 0 });

    const epoch = s.S1.epoch;
    f = frame(s, "S1", "AAAA0001", 4_000);
    expect(f.decision).toEqual({ action: "sign_out", scannerId: "S1", person: { personId: "alice", displayName: "Alice", badge: "AAAA0001" } });
    expect(f.slots.S1.identity).toBeNull();
    expect(f.slots.S1.pending).toBeNull();
    expect(f.slots.S1.signOut).toBeNull();
    expect(f.slots.S1.epoch).toBe(epoch + 1);
    expect(f.slots.S2).toEqual(bob); // the other scanner is untouched
  });

  it("repeat gap is rolling and window is inclusive", () => {
    let s = twoBound();
    // 999 ms after the last read of the badge: suppressed, and the gap restarts.
    let f = frame(s, "S1", "AAAA0001", 0);
    s = answer(f.slots, f.decision, 10).slots;
    const idle = s.S1.identity!.lastFramingAt;
    f = frame(s, "S1", "AAAA0001", 999);
    expect(f.decision.action).toBe("suppressed");
    expect(f.slots.S1.signOut).toEqual(s.S1.signOut); // count and firstRepeatAt unchanged
    expect(f.slots.S1.identity!.lastFramingAt).toBe(idle); // no idle refresh
    expect(f.slots.S1.lastRead).toEqual({ badge: "AAAA0001", at: 999 });
    s = f.slots;
    f = frame(s, "S1", "AAAA0001", 1_998); // 999 after the suppressed read: still suppressed
    expect(f.decision.action).toBe("suppressed");
    s = f.slots;
    f = frame(s, "S1", "AAAA0001", 2_998); // exactly 1,000 after the last read: counts
    expect(f.decision.action).toBe("activate");
    s = answer(f.slots, f.decision, 3_000).slots;
    expect(s.S1.signOut).toMatchObject({ count: 2, firstRepeatAt: 0 });
    // Third repeat exactly at the end of the window (inclusive).
    expect(frame(s, "S1", "AAAA0001", SIGN_OUT_WINDOW_MS).decision.action).toBe("sign_out");
    // One millisecond later the old progress has run out: this read starts again at 1/3.
    f = frame(s, "S1", "AAAA0001", SIGN_OUT_WINDOW_MS + 1);
    expect(f.decision.action).toBe("activate");
    if (f.decision.action !== "activate") return;
    expect(f.decision.pending.repeat?.progress).toMatchObject({ count: 1, firstRepeatAt: SIGN_OUT_WINDOW_MS + 1 });
  });

  it("scan-arrival times count even when replies are slow", () => {
    let s = twoBound();
    let f = frame(s, "S1", "AAAA0001", 0);
    s = answer(f.slots, f.decision, 4_000).slots; // slow reply
    f = frame(s, "S1", "AAAA0001", 5_000);
    s = answer(f.slots, f.decision, 9_900).slots;
    expect(s.S1.signOut).toMatchObject({ count: 2, firstRepeatAt: 0 });
    expect(frame(s, "S1", "AAAA0001", 9_950).decision.action).toBe("sign_out");
  });

  it("a reply after the window completes the sign-in but cannot revive progress", () => {
    let s = twoBound();
    let f = frame(s, "S1", "AAAA0001", 0);
    s = answer(f.slots, f.decision, 10).slots;
    f = frame(s, "S1", "AAAA0001", 2_000);
    s = answer(f.slots, f.decision, SIGN_OUT_WINDOW_MS + 500).slots; // reply arrives after the window
    expect(s.S1.identity?.displayName).toBe("Alice");
    expect(s.S1.signOut).toBeNull();
    // Timed-out progress is also swept on tick.
    let t = twoBound();
    f = frame(t, "S1", "AAAA0001", 0);
    t = answer(f.slots, f.decision, 10).slots;
    const swept = expireIdle(t, NOW, SIGN_OUT_WINDOW_MS + 1);
    expect(swept.slots.S1.signOut).toBeNull();
    expect(swept.slots.S1.identity?.displayName).toBe("Alice");
    expect(swept.expired).toEqual([]);
  });

  it("the guard holds while a check is pending and right after sign-out", () => {
    // Initial sign-in still pending: a rapid re-read sends nothing.
    let s: Slots = emptySlots(["S1"]);
    let f = frame(s, "S1", "AAAA0001", 0);
    expect(f.decision.action).toBe("activate");
    const pending = f;
    f = frame(pending.slots, "S1", "AAAA0001", 400);
    expect(f.decision.action).toBe("suppressed");
    expect(f.slots.S1.pending).toEqual(pending.slots.S1.pending);
    s = answer(f.slots, pending.decision, 500).slots;
    expect(s.S1.identity?.displayName).toBe("Alice");
    expect(s.S1.signOut).toBeNull(); // the first sign-in is not a counted repeat

    // Sign out, then the badge is still under the scanner: no immediate sign-in.
    s = badge(twoBound(), "S1", "AAAA0001", 0);
    s = badge(s, "S1", "AAAA0001", 2_000);
    f = frame(s, "S1", "AAAA0001", 4_000);
    expect(f.decision.action).toBe("sign_out");
    const held = frame(f.slots, "S1", "AAAA0001", 4_500);
    expect(held.decision.action).toBe("suppressed");
    expect(held.slots.S1.identity).toBeNull();
    // Lifted and scanned again later: a normal sign-in.
    expect(frame(held.slots, "S1", "AAAA0001", 6_000).decision.action).toBe("activate");
  });

  it("gesture cancellation never revives from a late reply", () => {
    type Case = [string, (s: Slots, d: FrameDecision) => Slots];
    const cancel: Case[] = [
      ["a different badge (refused while the check runs)", (s) => frame(s, "S1", "BBBB0002", 3_000).slots],
      ["an order", (s) => frame(s, "S1", "190203", 3_000).slots],
      ["an invalid scan", (s) => frame(s, "S1", "NOT-A-CODE", 3_000).slots],
      ["a parser error from this scanner", (s) => cancelGestures(s, "S1")],
      ["a parser error of unknown source", (s) => cancelGestures(s, null)],
      ["identity expiry", (s) => expireIdle(s, NOW + 2 * 15 * 60_000, 3_000).slots],
    ];
    for (const [name, act] of cancel) {
      // First repeat confirmed, second repeat's check in flight.
      let s = twoBound();
      let f = frame(s, "S1", "AAAA0001", 0);
      s = answer(f.slots, f.decision, 10).slots;
      f = frame(s, "S1", "AAAA0001", 2_000);
      const inFlight = f;
      s = act(f.slots, f.decision);
      expect(s.S1.signOut, name).toBeNull();
      // The late reply for the cancelled repeat must not restore progress.
      const late = answer(s, inFlight.decision, 2_100).slots;
      expect(late.S1.signOut, name).toBeNull();
      // Another scanner keeps its person (expiry moves the whole clock, so Bob expires there too).
      if (name !== "identity expiry") expect(late.S2.identity?.displayName, name).toBe("Bob");
    }
  });

  it("a failed or refused repeat check cancels progress", () => {
    const results: ActivationResult[] = [
      { outcome: "failed", message: "offline" },
      { outcome: "unusable_badge" },
      { outcome: "unknown_badge" },
    ];
    for (const result of results) {
      let s = twoBound();
      let f = frame(s, "S1", "AAAA0001", 0);
      s = answer(f.slots, f.decision, 10).slots;
      f = frame(s, "S1", "AAAA0001", 2_000);
      s = answer(f.slots, f.decision, 2_010, result).slots;
      expect(s.S1.signOut, result.outcome).toBeNull();
      // and the next qualifying repeat starts again at 1/3
      f = frame(badge(s, "S1", "AAAA0001", 3_500), "S1", "AAAA0001", 5_000);
      if (f.decision.action !== "activate") throw new Error("expected activate");
      expect(f.decision.pending.repeat?.progress.count, result.outcome).toBe(1);
    }
  });

  it("a scan while a repeat check is pending cancels progress and is refused", () => {
    let s = twoBound();
    let f = frame(s, "S1", "AAAA0001", 0);
    s = answer(f.slots, f.decision, 10).slots;
    f = frame(s, "S1", "AAAA0001", 2_000);
    const inFlight = f;
    const order = frame(f.slots, "S1", "190203", 2_100);
    expect(order.decision).toMatchObject({ action: "reject", code: "badge_pending" });
    const late = answer(order.slots, inFlight.decision, 2_200).slots;
    expect(late.S1.signOut).toBeNull();
    expect(late.S1.identity?.displayName).toBe("Alice");
  });

  it("other scanners' traffic does not cancel it", () => {
    let s = twoBound();
    let f = frame(s, "S1", "AAAA0001", 0);
    s = answer(f.slots, f.decision, 10).slots;
    s = frame(s, "S2", "190203", 1_000).slots;
    s = frame(s, "S3", "NOT-A-CODE", 1_100).slots;
    s = badge(s, "S3", "BBBB0002", 1_200);
    expect(s.S1.signOut).toMatchObject({ count: 1 });
  });

  it("numeric own badge counts; a different numeric order and a failed repeat never invent an order", () => {
    let s = badge(emptySlots(["S1"]), "S1", "10200001", -5_000); // Nina's badge is order-shaped
    expect(s.S1.identity?.displayName).toBe("Nina");
    let f = frame(s, "S1", "10200001", 0);
    if (f.decision.action !== "activate") throw new Error("expected activate");
    expect(f.decision.pending.repeat?.progress.count).toBe(1);
    expect(f.decision.pending.orderFallback).toBeNull();
    // A failed own-badge repeat: no fallback order for Nina.
    const failed = answer(f.slots, f.decision, 10, { outcome: "unknown_badge" });
    expect(failed.order).toBeNull();
    // A different 8-digit number is the old badge-first path with Nina as the order fallback.
    s = badge(emptySlots(["S1"]), "S1", "10200001", -5_000);
    f = frame(s, "S1", "10190203", 0);
    if (f.decision.action !== "activate") throw new Error("expected activate");
    expect(f.decision.pending.repeat ?? null).toBeNull();
    const asOrder = answer(f.slots, f.decision, 10, { outcome: "unknown_badge" });
    expect(asOrder.order).toMatchObject({ orderNumber: "10190203", person: { personId: "nina" } });
  });

  it("offline badge reads keep the old refusal, before any gesture", () => {
    let s = twoBound();
    const f = frame(s, "S1", "AAAA0001", 0);
    s = answer(f.slots, f.decision, 10).slots;
    const off = frame(s, "S1", "AAAA0001", 100, { online: false }); // even a rapid read
    expect(off.decision).toMatchObject({ action: "reject", code: "badge_offline", clearedIdentity: true });
    expect(off.slots.S1.identity).toBeNull();
    expect(off.slots.S1.signOut).toBeNull();
  });

  it("dispatch has no gesture and no repeat guard", () => {
    let s = emptySlots(["S1"]);
    const first = decideFrame(s, { scannerId: "S1", payload: "AAAA0001" }, { online: true, now: NOW, newRequestId: () => "d1", mode: "dispatch", elapsedNow: 0 });
    s = answer(first.slots, first.decision, 10).slots;
    for (const at of [100, 200, 300, 400]) {
      const f = decideFrame(s, { scannerId: "S1", payload: "AAAA0001" }, { online: true, now: NOW, newRequestId: () => `d${at}`, mode: "dispatch", elapsedNow: at });
      expect(f.decision.action, String(at)).toBe("activate");
      if (f.decision.action === "activate") expect(f.decision.pending.repeat ?? null).toBeNull();
      s = answer(f.slots, f.decision, at + 10).slots;
      expect(s.S1.signOut).toBeNull();
      expect(s.S1.identity?.displayName).toBe("Alice");
    }
  });

  it("resets clear all gesture and read state", () => {
    let s = twoBound();
    const f = frame(s, "S1", "AAAA0001", 0);
    s = answer(f.slots, f.decision, 10).slots;
    const r = clearAll(s);
    for (const id of ["S1", "S2", "S3"]) {
      expect(r[id].signOut).toBeNull();
      expect(r[id].lastRead).toBeNull();
      expect(r[id].identity).toBeNull();
    }
    expect(SIGN_OUT_REPEAT_GAP_MS).toBe(1_000);
  });
});
