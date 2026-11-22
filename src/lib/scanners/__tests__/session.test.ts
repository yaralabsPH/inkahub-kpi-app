import { describe, expect, it } from "vitest";
import {
  classifyPayload,
  clearAll,
  decideFrame,
  emptySlots,
  expireIdle,
  IDENTITY_IDLE_MS,
  resolveActivation,
  type ScannerSlot,
} from "../session";

let n = 0;
const ctx = (over: Partial<{ online: boolean; now: number }> = {}) => ({
  online: true,
  now: 1_000_000,
  newRequestId: () => `req-${++n}`,
  ...over,
});

function activate(slots: Record<string, ScannerSlot>, scannerId: string, badge: string, person: string, now = 1_000_000) {
  const a = decideFrame(slots, { scannerId, payload: badge }, ctx({ now }));
  if (a.decision.action !== "activate") throw new Error("expected activate");
  const r = resolveActivation(a.slots, scannerId, a.decision.epoch, a.decision.pending.requestId,
    { outcome: "activated", personId: person, displayName: person.toUpperCase() }, now);
  return r.slots;
}

describe("classifyPayload (pinned shapes)", () => {
  it("reads badges, six-digit slips and # full orders, and nothing else", () => {
    expect(classifyPayload("a1b2c3d4")).toEqual({ kind: "hex8", badge: "A1B2C3D4", orderCandidate: null });
    expect(classifyPayload("10190203")).toEqual({ kind: "hex8", badge: "10190203", orderCandidate: "10190203" });
    expect(classifyPayload("20190203")).toEqual({ kind: "hex8", badge: "20190203", orderCandidate: null });
    expect(classifyPayload("190203")).toEqual({ kind: "order", orderNumber: "10190203", shape: "six_digit" });
    expect(classifyPayload("101234")).toEqual({ kind: "order", orderNumber: "10101234", shape: "six_digit" });
    expect(classifyPayload("#10190203")).toEqual({ kind: "order", orderNumber: "10190203", shape: "hash_full" });
    // Mixed hex is a badge attempt only, never an order: it must match an active badge or it is rejected.
    expect(classifyPayload("19A10203")).toEqual({ kind: "hex8", badge: "19A10203", orderCandidate: null });
    for (const bad of ["#20190203", "#1019020", "1019020", "1019020345", "19G10203", "INKA-ABC0001-A1-FB", "#", "", "12345"]) {
      expect(classifyPayload(bad)).toEqual({ kind: "invalid" });
    }
  });
});

describe("decideFrame", () => {
  it("a badge clears the old person at once and asks to activate", () => {
    let slots = activate(emptySlots(["S1", "S2"]), "S1", "AAAA0001", "alice");
    const d = decideFrame(slots, { scannerId: "S1", payload: "BBBB0002" }, ctx());
    expect(d.decision.action).toBe("activate");
    expect(d.slots.S1.identity).toBeNull();
    expect(d.slots.S1.pending?.badge).toBe("BBBB0002");
    slots = d.slots;
    // An order before the activation answers is rejected loudly, never credited to Alice.
    const o = decideFrame(slots, { scannerId: "S1", payload: "190203" }, ctx());
    expect(o.decision).toMatchObject({ action: "reject", code: "badge_pending" });
  });

  it("captures the person synchronously: a later badge scan cannot re-credit an accepted order", () => {
    let slots = activate(emptySlots(["S1"]), "S1", "AAAA0001", "alice");
    const o = decideFrame(slots, { scannerId: "S1", payload: "190203" }, ctx());
    if (o.decision.action !== "enqueue") throw new Error("expected enqueue");
    const captured = o.decision.order;
    slots = activate(o.slots, "S1", "BBBB0002", "bob");
    expect(captured.person.personId).toBe("alice");
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.person)).toBe(true);
    expect(slots.S1.identity?.personId).toBe("bob");
  });

  it("keeps each scanner's identity independent", () => {
    let slots = activate(emptySlots(["S1", "S2", "S3"]), "S1", "AAAA0001", "alice");
    slots = activate(slots, "S2", "BBBB0002", "bob");
    const a = decideFrame(slots, { scannerId: "S1", payload: "190203" }, ctx());
    const b = decideFrame(a.slots, { scannerId: "S2", payload: "190204" }, ctx());
    const c = decideFrame(b.slots, { scannerId: "S3", payload: "190205" }, ctx());
    expect(a.decision).toMatchObject({ action: "enqueue", order: { person: { personId: "alice" } } });
    expect(b.decision).toMatchObject({ action: "enqueue", order: { person: { personId: "bob" } } });
    expect(c.decision).toMatchObject({ action: "reject", code: "no_person" });
  });

  it("offline: an 8-digit order-or-badge scan is rejected and clears the scanner", () => {
    const slots = activate(emptySlots(["S1"]), "S1", "AAAA0001", "alice");
    const d = decideFrame(slots, { scannerId: "S1", payload: "10190203" }, ctx({ online: false }));
    expect(d.decision).toMatchObject({ action: "reject", code: "ambiguous_offline", clearedIdentity: true });
    expect(d.slots.S1.identity).toBeNull();
  });

  it("offline: a badge attempt never falls back to the old person", () => {
    const slots = activate(emptySlots(["S1"]), "S1", "AAAA0001", "alice");
    const d = decideFrame(slots, { scannerId: "S1", payload: "BBBB0002" }, ctx({ online: false }));
    expect(d.decision).toMatchObject({ action: "reject", code: "badge_offline", clearedIdentity: true });
    const after = decideFrame(d.slots, { scannerId: "S1", payload: "190203" }, ctx({ online: false }));
    expect(after.decision).toMatchObject({ action: "reject", code: "no_person" });
  });

  it("offline: an unambiguous order queues for the bound person", () => {
    const slots = activate(emptySlots(["S1"]), "S1", "AAAA0001", "alice");
    const six = decideFrame(slots, { scannerId: "S1", payload: "190203" }, ctx({ online: false }));
    const hash = decideFrame(six.slots, { scannerId: "S1", payload: "#10190204" }, ctx({ online: false }));
    expect(six.decision).toMatchObject({ action: "enqueue", order: { orderNumber: "10190203", person: { personId: "alice" } } });
    expect(hash.decision).toMatchObject({ action: "enqueue", order: { orderNumber: "10190204" } });
  });

  it("expires an identity after ten minutes without a framing scan", () => {
    const t0 = 1_000_000;
    let slots = activate(emptySlots(["S1"]), "S1", "AAAA0001", "alice", t0);
    const ok = decideFrame(slots, { scannerId: "S1", payload: "190203" }, ctx({ now: t0 + IDENTITY_IDLE_MS - 1 }));
    expect(ok.decision.action).toBe("enqueue");
    slots = ok.slots; // the scan refreshed the timer
    const still = decideFrame(slots, { scannerId: "S1", payload: "190204" }, ctx({ now: t0 + IDENTITY_IDLE_MS + 5 }));
    expect(still.decision.action).toBe("enqueue");
    const late = decideFrame(still.slots, { scannerId: "S1", payload: "190205" }, ctx({ now: t0 + 3 * IDENTITY_IDLE_MS }));
    expect(late.decision).toMatchObject({ action: "reject", code: "identity_expired", clearedIdentity: true });
    const swept = expireIdle(slots, t0 + 3 * IDENTITY_IDLE_MS);
    expect(swept.expired).toEqual(["S1"]);
    expect(swept.slots.S1.identity).toBeNull();
  });

  it("rejects payloads that are neither badge nor supported order, keeping the person", () => {
    const slots = activate(emptySlots(["S1"]), "S1", "AAAA0001", "alice");
    const d = decideFrame(slots, { scannerId: "S1", payload: "INKA-ABC" }, ctx());
    expect(d.decision).toMatchObject({ action: "reject", code: "invalid_payload", clearedIdentity: false });
    expect(d.slots.S1.identity?.personId).toBe("alice");
  });
});

describe("resolveActivation", () => {
  it("ignores a stale answer after the scanner was cleared", () => {
    const d = decideFrame(emptySlots(["S1"]), { scannerId: "S1", payload: "AAAA0001" }, ctx());
    if (d.decision.action !== "activate") throw new Error("x");
    const cleared = clearAll(d.slots);
    const r = resolveActivation(cleared, "S1", d.decision.epoch, d.decision.pending.requestId,
      { outcome: "activated", personId: "alice", displayName: "Alice" }, 2);
    expect(r.stale).toBe(true);
    expect(r.slots.S1.identity).toBeNull();
  });

  it("ignores the first answer when the scanner scanned a second badge", () => {
    const first = decideFrame(emptySlots(["S1"]), { scannerId: "S1", payload: "AAAA0001" }, ctx());
    const second = decideFrame(first.slots, { scannerId: "S1", payload: "BBBB0002" }, ctx());
    if (first.decision.action !== "activate" || second.decision.action !== "activate") throw new Error("x");
    const r1 = resolveActivation(second.slots, "S1", first.decision.epoch, first.decision.pending.requestId,
      { outcome: "activated", personId: "alice", displayName: "Alice" }, 2);
    expect(r1.stale).toBe(true);
    const r2 = resolveActivation(r1.slots, "S1", second.decision.epoch, second.decision.pending.requestId,
      { outcome: "activated", personId: "bob", displayName: "Bob" }, 3);
    expect(r2.slots.S1.identity?.personId).toBe("bob");
  });

  it("an 8-digit scan that is not a badge becomes an order for the person captured at scan time", () => {
    const slots = activate(emptySlots(["S1"]), "S1", "AAAA0001", "alice", 100);
    const d = decideFrame(slots, { scannerId: "S1", payload: "10190203" }, ctx({ now: 200 }));
    if (d.decision.action !== "activate") throw new Error("x");
    expect(d.slots.S1.identity).toBeNull(); // nobody may use the scanner meanwhile
    const r = resolveActivation(d.slots, "S1", d.decision.epoch, d.decision.pending.requestId, { outcome: "unknown_badge" }, 300);
    expect(r.order).toMatchObject({ orderNumber: "10190203", person: { personId: "alice" }, scannedAt: 200 });
    expect(r.slots.S1.identity?.personId).toBe("alice");
  });

  it("badge precedence: a known badge with an order shape signs in, no order", () => {
    const slots = activate(emptySlots(["S1"]), "S1", "AAAA0001", "alice");
    const d = decideFrame(slots, { scannerId: "S1", payload: "10190203" }, ctx());
    if (d.decision.action !== "activate") throw new Error("x");
    const r = resolveActivation(d.slots, "S1", d.decision.epoch, d.decision.pending.requestId,
      { outcome: "activated", personId: "carol", displayName: "Carol" }, 2);
    expect(r.order).toBeNull();
    expect(r.slots.S1.identity?.personId).toBe("carol");
  });

  it("a failed lookup never falls through to order handling", () => {
    const slots = activate(emptySlots(["S1"]), "S1", "AAAA0001", "alice");
    const d = decideFrame(slots, { scannerId: "S1", payload: "10190203" }, ctx());
    if (d.decision.action !== "activate") throw new Error("x");
    const r = resolveActivation(d.slots, "S1", d.decision.epoch, d.decision.pending.requestId, { outcome: "failed", message: "offline" }, 2);
    expect(r.order).toBeNull();
    expect(r.slots.S1.identity).toBeNull();
  });

  it("an order-shaped non-badge with nobody signed in is rejected", () => {
    const d = decideFrame(emptySlots(["S1"]), { scannerId: "S1", payload: "10190203" }, ctx());
    if (d.decision.action !== "activate") throw new Error("x");
    const r = resolveActivation(d.slots, "S1", d.decision.epoch, d.decision.pending.requestId, { outcome: "unknown_badge" }, 2);
    expect(r.order).toBeNull();
    expect(r.rejected).toBe("no_person");
  });
});
