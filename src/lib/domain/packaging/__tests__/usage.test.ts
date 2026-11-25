import { describe, expect, it } from "vitest";
import { catalogueProducts, completionsWithoutPick, netUsageByProduct, usageOf, type CompletionEvent } from "../usage";

describe("netUsageByProduct", () => {
  it("with no corrections, equals the sum of deductions (old behaviour)", () => {
    const rows = [{ product_id: "a", delta: -1 }, { product_id: "a", delta: -2 }, { product_id: "b", delta: -1 }];
    expect(Object.fromEntries(netUsageByProduct(rows))).toEqual({ a: 3, b: 1 });
  });

  it("a swapped box counts once: the returned one drops out", () => {
    // apply box a; override a -> b
    const rows = [{ product_id: "a", delta: -1 }, { product_id: "a", delta: 1 }, { product_id: "b", delta: -1 }];
    expect(Object.fromEntries(netUsageByProduct(rows))).toEqual({ b: 1 });
  });

  it("a quantity change nets to the final quantity", () => {
    const up = [{ product_id: "a", delta: -1 }, { product_id: "a", delta: -2 }];
    expect(netUsageByProduct(up).get("a")).toBe(3);
    const down = [{ product_id: "a", delta: -3 }, { product_id: "a", delta: 2 }];
    expect(netUsageByProduct(down).get("a")).toBe(1);
  });

  it("never reports negative usage (a return whose deduction is outside the range)", () => {
    expect(netUsageByProduct([{ product_id: "a", delta: 1 }]).size).toBe(0);
    expect(usageOf({ delta: 1 })).toBe(-1);
    expect(usageOf({ delta: -2 })).toBe(2);
  });
});

describe("catalogueProducts", () => {
  it("collects every packaging product, newest rule set's label first, ignoring junk", () => {
    const m = catalogueProducts([
      { catalogue: [{ product_id: "p1", label: "New name" }, { product_id: "p2", label: "" }] },
      { catalogue: [{ product_id: "p1", label: "Old name" }, { product_id: "p3", label: "Three" }, { nope: 1 }] },
      null,
      { catalogue: "x" },
    ]);
    expect(Object.fromEntries(m)).toEqual({ p1: "New name", p2: "p2", p3: "Three" });
  });
});

describe("completionsWithoutPick", () => {
  const ev = (over: Partial<CompletionEvent>): CompletionEvent => ({
    id: "e", order_number: "F4T-1", department: "dispatch", event_type: "dispatched", created_at: "2026-11-22T10:00:00Z", cs_case_id: null, ...over,
  });
  const since = "2026-11-22T00:00:00Z";

  it("returns nothing while the site is on scanning", () => {
    expect(completionsWithoutPick([ev({})], [], null)).toEqual([]);
    expect(completionsWithoutPick([ev({})], [], "not a date")).toEqual([]);
  });

  it("flags a packing-station completion with no pick", () => {
    expect(completionsWithoutPick([ev({ id: "e1" })], [], since)).toEqual([
      { order_number: "F4T-1", packing_point: "dispatch", shipment_key: "orig", completed_at: "2026-11-22T10:00:00Z", event_id: "e1" },
    ]);
  });

  it("is satisfied by the matching pick only", () => {
    const events = [ev({})];
    expect(completionsWithoutPick(events, [{ order_number: "F4T-1", packing_point: "dispatch", shipment_key: "orig" }], since)).toEqual([]);
    expect(completionsWithoutPick(events, [{ order_number: "F4T-1", packing_point: "a0_framed", shipment_key: "orig" }], since)).toHaveLength(1);
    expect(completionsWithoutPick(events, [{ order_number: "F4T-1", packing_point: "dispatch", shipment_key: "cs:c1" }], since)).toHaveLength(1);
  });

  it("treats a replacement as its own shipment", () => {
    const out = completionsWithoutPick(
      [ev({ id: "e1" }), ev({ id: "e2", cs_case_id: "c1" })],
      [{ order_number: "F4T-1", packing_point: "dispatch", shipment_key: "orig" }],
      since,
    );
    expect(out.map((m) => m.shipment_key)).toEqual(["cs:c1"]);
  });

  it("ignores Framed, non-terminal events and anything before auto mode started", () => {
    const out = completionsWithoutPick([
      ev({ id: "framed", department: "framed", event_type: "completed" }),
      ev({ id: "verify", event_type: "line_verified" }),
      ev({ id: "old", created_at: "2026-11-21T23:59:59Z" }),
      ev({ id: "a0", department: "a0_framed", event_type: "completed", order_number: "F4T-2" }),
    ], [], since);
    expect(out.map((m) => m.event_id)).toEqual(["a0"]);
  });

  it("reports a shipment once (its first completion), newest shipments first", () => {
    const out = completionsWithoutPick([
      ev({ id: "late", created_at: "2026-11-22T12:00:00Z" }),
      ev({ id: "early", created_at: "2026-11-22T09:00:00Z" }),
      ev({ id: "other", order_number: "F4T-9", created_at: "2026-11-22T13:00:00Z" }),
    ], [], since);
    expect(out.map((m) => m.event_id)).toEqual(["other", "early"]);
  });
});
