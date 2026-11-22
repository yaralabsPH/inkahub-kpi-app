import { describe, expect, it } from "vitest";
import {
  applyChoices,
  choicesFor,
  dispatchShiftEnd,
  DISPATCH_SHIFT_MAX_MS,
  missingSkus,
  prepareDispatchOrder,
  unresolvedSkus,
  withEvidence,
  type FramerEvidence,
  type PreparedDispatch,
} from "../dispatch";
import type { OrderLookup, PackagingSetup } from "../order";
import type { RuleSetBody } from "@/lib/domain/packaging/ruleSet";
import { decideFrame, emptySlots, expireIdle, msUntilExpiry, resolveActivation, type ScannerSlot } from "../session";

// Synthetic catalogue and rules; not real stock codes or box rules.
const products = [
  { id: "p-a2b", code: "A2-Black" },
  { id: "p-a3n", code: "A3-Natural" },
  { id: "p-a0b", code: "A0-Black" },
  { id: "p-hook", code: "INKA-AUX-HOOK" },
  { id: "p-box", code: "BOX-M" },
];
const body: RuleSetBody = {
  schema_version: 1,
  catalogue: [{ key: "BOXM", product_id: "p-box", label: "Medium box", packing_points: ["dispatch"] }],
  rules: [
    { id: "d", packing_point: "dispatch", kinds: ["framed", "unframed", "accessory", "free_print"], output: { mode: "per_capacity", capacity: 4, package: "BOXM" } },
  ],
  examples: [],
};
const auto: PackagingSetup = { mode: "auto", ruleSet: { id: "rs-d", version: 2, body } };

function order(lines: OrderLookup["line_items"], over: Partial<OrderLookup> = {}): OrderLookup {
  return { found: true, complete: true, truncated: false, order_name: "#10190203", cancelled_at: null, tags: [], line_items: lines, ...over };
}
const ctx = (over: Partial<Parameters<typeof prepareDispatchOrder>[1]> = {}) => ({
  orderNumber: "10190203", openCase: false, products, packaging: auto, ...over,
});

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

function prep(lines: OrderLookup["line_items"], over: Partial<Parameters<typeof prepareDispatchOrder>[1]> = {}): PreparedDispatch {
  const r = prepareDispatchOrder(order(lines), ctx(over));
  if (!r.ok) throw new Error(r.message);
  return r.prepared;
}

const measured = (sku: string, person = P1): FramerEvidence => ({
  sku, status: "measured", personId: person, displayName: "Alice", verifiedEventId: `scn-x-v01-${sku}`, completedEventId: "scn-x-c-framed",
});
const missing = (sku: string, status: "missing" | "conflict" = "missing"): FramerEvidence => ({
  sku, status, personId: null, displayName: null, verifiedEventId: null, completedEventId: null,
});

describe("prepareDispatchOrder", () => {
  it("framed + unframed + accessory + gift card: framed SKUs for attribution, dispatch-terminal stock, Dispatch parcel", () => {
    const p = prep([
      { sku: "INKA-ABC0001-A2-FB", quantity: 1 },
      { sku: "inka-abc0001-a2-fb", quantity: 1 }, // same SKU twice: one line, quantity 2
      { sku: "INKA-S2WIL0049-A3-FN", quantity: 1 },
      { sku: "INKA-ABC0002-A1-UN", quantity: 1 },
      { sku: "INKA-AUX-HOOK", quantity: 2 },
      { sku: "INKA-GC0001-50", quantity: 1 },
    ]);
    expect(p.mode).toBe("dispatch");
    expect(p.items).toBe(7); // classic dispatched.line_quantity: every ordered item
    expect(p.framed).toEqual([
      { sku: "INKA-ABC0001-A2-FB", quantity: 2, workType: "framed", pieces: 2 },
      { sku: "INKA-S2WIL0049-A3-FN", quantity: 1, workType: "framed", pieces: 2 },
    ]);
    // Exactly the classic dispatch deduction: framed A1-A4 + accessory; never the unframed print or the gift card.
    expect(p.components).toEqual([
      { code: "A2-Black", qty: 2 },
      { code: "A3-Natural", qty: 2 },
      { code: "INKA-AUX-HOOK", qty: 2 },
    ]);
    expect(p.packaging).toMatchObject({ ruleSetId: "rs-d", ruleSetVersion: 2, resolved: true, target: p.packaging?.predicted });
    expect(p.evidence).toEqual([]);
    expect(p.choices).toEqual([]);
  });

  it("an unframed-only order needs no framer and packs nothing at Dispatch (no box rules needed)", () => {
    const p = prep([{ sku: "INKA-ABC0002-A1-UN", quantity: 3 }], { packaging: null });
    expect(p.framed).toEqual([]);
    expect(p.components).toEqual([]);
    expect(p.packaging).toBeNull();
  });

  it("A0 lines are attributed but never charged again at Dispatch (A0 stock and box belong to the A0 bench)", () => {
    const p = prep([{ sku: "INKA-ABC0001-A0-FB", quantity: 1 }, { sku: "INKA-ABC0001-A2-FB", quantity: 1 }]);
    expect(p.framed.map((l) => [l.sku, l.workType])).toEqual([["INKA-ABC0001-A0-FB", "a0_framed"], ["INKA-ABC0001-A2-FB", "framed"]]);
    expect(p.components).toEqual([{ code: "A2-Black", qty: 1 }]);
    // The Dispatch parcel holds only the A2; the A0 parcel left from the A0 bench.
    expect(JSON.stringify(p.packaging?.snapshot)).not.toContain("\"A0\"");
  });

  it("an A0-only order packs and charges nothing here", () => {
    const p = prep([{ sku: "INKA-ABC0001-A0-FB", quantity: 1 }], { packaging: null });
    expect(p.components).toEqual([]);
    expect(p.packaging).toBeNull();
  });

  it.each([
    ["picture frame", [{ sku: "INKA-PF0001-A2-PB", quantity: 1 }], "unsupported_sku"],
    ["canvas", [{ sku: "INKA-ABC0001-A2-SC", quantity: 1 }], "canvas"],
    ["legacy SKU", [{ sku: "OLD-123", quantity: 1 }], "unknown_sku"],
    ["blank SKU", [{ sku: "", quantity: 1 }], "blank_sku"],
    ["GW single", [{ sku: "INKA-ABC0001-GW-FB", quantity: 1 }], "unsupported_sku"],
    ["zero quantity", [{ sku: "INKA-ABC0001-A2-FB", quantity: 0 }], "invalid_quantity"],
  ] as const)("%s goes to the classic dispatch station", (_n, lines, code) => {
    const r = prepareDispatchOrder(order([...lines]), ctx());
    expect(r).toMatchObject({ ok: false, code });
    if (!r.ok) expect(r.message).toMatch(/classic dispatch station/);
  });

  it.each([
    ["open case", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 1 }]), { openCase: true }, "open_case"],
    ["cancelled", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 1 }], { cancelled_at: "2026-11-20T00:00:00Z" }), {}, "cancelled"],
    ["edited", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 1 }], { tags: ["Edit Order"] }), {}, "edit_warning"],
    ["truncated", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 1 }], { truncated: true }), {}, "incomplete_order"],
    ["no box rules", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 1 }]), { packaging: { mode: "scan", ruleSet: null } as PackagingSetup }, "packaging_not_auto"],
    ["unknown stock code", order([{ sku: "INKA-ABC0001-A4-FW", quantity: 1 }]), {}, "missing_stock_code"],
  ] as const)("%s is refused before anything is sent", (_n, o, over, code) => {
    expect(prepareDispatchOrder(o, ctx(over as Partial<Parameters<typeof prepareDispatchOrder>[1]>))).toMatchObject({ ok: false, code });
  });
});

describe("framer evidence and choices", () => {
  const base = () => prep([{ sku: "INKA-ABC0001-A2-FB", quantity: 1 }, { sku: "INKA-S2WIL0049-A3-FN", quantity: 1 }]);

  it("takes exactly one evidence row per framed SKU, and a measured row must name its events", () => {
    const p = base();
    expect(withEvidence(p, [measured("INKA-ABC0001-A2-FB")])).toBeNull(); // a SKU missing from the answer
    expect(withEvidence(p, [measured("INKA-ABC0001-A2-FB"), measured("INKA-ABC0001-A2-FB")])).toBeNull();
    expect(withEvidence(p, [measured("INKA-ABC0001-A2-FB"), { ...measured("INKA-S2WIL0049-A3-FN"), completedEventId: null }])).toBeNull();
    const ok = withEvidence(p, [missing("INKA-S2WIL0049-A3-FN"), measured("INKA-ABC0001-A2-FB")]);
    expect(ok?.evidence.map((e) => e.sku)).toEqual(["INKA-ABC0001-A2-FB", "INKA-S2WIL0049-A3-FN"]);
  });

  it("conflicting or missing evidence both need a person; measured never does", () => {
    const p = withEvidence(base(), [missing("INKA-ABC0001-A2-FB", "conflict"), measured("INKA-S2WIL0049-A3-FN")])!;
    expect(missingSkus(p)).toEqual(["INKA-ABC0001-A2-FB"]);
    expect(unresolvedSkus(p)).toEqual(["INKA-ABC0001-A2-FB"]);
    expect(applyChoices(p, [{ sku: "INKA-S2WIL0049-A3-FN", personId: P2, displayName: "Bob" }])).toEqual({ ok: false, error: "not_missing" });
    expect(applyChoices(p, [])).toEqual({ ok: false, error: "incomplete" });
    const done = applyChoices(p, [{ sku: "INKA-ABC0001-A2-FB", personId: P2, displayName: "Bob" }]);
    expect(done.ok && done.prepared.choices).toEqual([{ sku: "INKA-ABC0001-A2-FB", personId: P2, displayName: "Bob" }]);
    expect(done.ok && unresolvedSkus(done.prepared)).toEqual([]);
  });

  it("one choice fills every missing line, with per-line overrides", () => {
    const p = withEvidence(base(), [missing("INKA-ABC0001-A2-FB"), missing("INKA-S2WIL0049-A3-FN")])!;
    const all = { personId: P1, displayName: "Alice" };
    expect(choicesFor(p, all).map((c) => [c.sku, c.personId])).toEqual([["INKA-ABC0001-A2-FB", P1], ["INKA-S2WIL0049-A3-FN", P1]]);
    const mixed = choicesFor(p, all, { "INKA-S2WIL0049-A3-FN": { personId: P2, displayName: "Bob" } });
    expect(mixed.map((c) => c.personId)).toEqual([P1, P2]);
    expect(applyChoices(p, mixed).ok).toBe(true);
    expect(choicesFor(p, null)).toEqual([]); // nothing chosen yet
    expect(applyChoices(p, [...mixed, mixed[0]])).toEqual({ ok: false, error: "duplicate" });
  });
});

describe("dispatch shift identity", () => {
  const T0 = Date.UTC(2026, 10, 22, 8, 0, 0);
  const end = dispatchShiftEnd(T0, Date.UTC(2026, 10, 22, 17, 0, 0));
  const signedIn = (): Record<string, ScannerSlot> => {
    const s = emptySlots(["S1"]);
    const d = decideFrame(s, { scannerId: "S1", payload: "AAAA0001" }, { online: true, now: T0, newRequestId: () => "r1" });
    if (d.decision.action !== "activate") throw new Error("expected activation");
    return resolveActivation(d.slots, "S1", d.decision.epoch, "r1", { outcome: "activated", personId: P1, displayName: "Alice", expiresAt: end }, T0).slots;
  };

  it("ends at the earlier of the site workday end and twelve hours", () => {
    expect(end).toBe(Date.UTC(2026, 10, 22, 17, 0, 0));
    expect(dispatchShiftEnd(T0, Date.UTC(2026, 10, 23, 17, 0, 0))).toBe(T0 + DISPATCH_SHIFT_MAX_MS);
    expect(dispatchShiftEnd(T0, null)).toBe(T0 + DISPATCH_SHIFT_MAX_MS);
  });

  it("has no ten-minute idle timeout", () => {
    const slots = signedIn();
    const later = T0 + 3 * 60 * 60 * 1000; // three quiet hours
    expect(expireIdle(slots, later).expired).toEqual([]);
    const d = decideFrame(slots, { scannerId: "S1", payload: "190203" }, { online: true, now: later, newRequestId: () => "x" });
    expect(d.decision).toMatchObject({ action: "enqueue", order: { orderNumber: "10190203", person: { personId: P1 } } });
    expect(msUntilExpiry(slots.S1.identity, later)).toBe(end - later);
  });

  it("an order after the shift end is refused and the scanner cleared; never queued for the old person", () => {
    const slots = signedIn();
    const d = decideFrame(slots, { scannerId: "S1", payload: "190203" }, { online: true, now: end, newRequestId: () => "x" });
    expect(d.decision).toMatchObject({ action: "reject", code: "shift_ended", clearedIdentity: true });
    expect(d.slots.S1.identity).toBeNull();
    expect(expireIdle(slots, end).expired).toEqual(["S1"]);
  });

  it("an offline 8-digit scan clears the dispatcher instead of reusing them", () => {
    const d = decideFrame(signedIn(), { scannerId: "S1", payload: "10190203" }, { online: false, now: T0 + 1000, newRequestId: () => "x" });
    expect(d.decision).toMatchObject({ action: "reject", code: "ambiguous_offline" });
    expect(d.slots.S1.identity).toBeNull();
  });
});
