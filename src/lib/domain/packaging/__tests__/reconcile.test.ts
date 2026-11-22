import { describe, expect, it } from "vitest";
import { applyDeltas, isOverride, packagingDeltas, sameQuantities, toQuantities, type Quantities } from "../reconcile";

describe("packagingDeltas", () => {
  it("first apply consumes the whole target", () => {
    expect(packagingDeltas({ boxA: 1, tube: 2 }, {})).toEqual({ boxA: 1, tube: 2 });
  });

  it("swapping a box returns one and takes one", () => {
    expect(packagingDeltas({ boxB: 1 }, { boxA: 1 })).toEqual({ boxA: -1, boxB: 1 });
  });

  it("raising or lowering a quantity moves only the difference", () => {
    expect(packagingDeltas({ boxA: 3 }, { boxA: 1 })).toEqual({ boxA: 2 });
    expect(packagingDeltas({ boxA: 1 }, { boxA: 3 })).toEqual({ boxA: -2 });
  });

  it("removing everything returns everything", () => {
    expect(packagingDeltas({}, { boxA: 2, boxB: 1 })).toEqual({ boxA: -2, boxB: -1 });
  });

  it("no change produces no deltas", () => {
    expect(packagingDeltas({ boxA: 1 }, { boxA: 1 })).toEqual({});
    expect(packagingDeltas({}, {})).toEqual({});
  });

  it("ignores zero, negative and non-numeric entries", () => {
    expect(packagingDeltas({ boxA: 0, boxB: -2, boxC: Number.NaN, boxD: 1 }, { boxE: 0 })).toEqual({ boxD: 1 });
  });

  it("returns keys in sorted order (the database lock order)", () => {
    expect(Object.keys(packagingDeltas({ z: 1, a: 1, m: 1 }, {}))).toEqual(["a", "m", "z"]);
  });

  it("converges: applying the deltas leaves nothing more to post, however often it is repeated", () => {
    const target = { boxA: 2, tube: 1 };
    let posted: Quantities = { boxA: 1, boxB: 4 };
    for (let i = 0; i < 3; i++) {
      posted = applyDeltas(posted, packagingDeltas(target, posted));
      expect(posted).toEqual(target);
      expect(packagingDeltas(target, posted)).toEqual({});
    }
  });

  it("a partly posted pick (short stock) keeps the remainder for the next attempt", () => {
    const target = { boxA: 1, boxB: 1 };
    const posted = applyDeltas({}, { boxA: 1 }); // boxB could not be posted
    expect(packagingDeltas(target, posted)).toEqual({ boxB: 1 });
  });
});

describe("toQuantities / isOverride", () => {
  it("sums package keys that share a product", () => {
    expect(toQuantities([
      { product_id: "p1", qty: 1 }, { product_id: "p1", qty: 2 }, { product_id: "p2", qty: 1 }, { product_id: "p3", qty: 0 },
    ])).toEqual({ p1: 3, p2: 1 });
  });

  it("detects an override", () => {
    expect(isOverride({ boxA: 1 }, { boxA: 1 })).toBe(false);
    expect(isOverride({ boxA: 1 }, { boxB: 1 })).toBe(true);
    expect(isOverride({}, { boxB: 1 })).toBe(true);
    expect(sameQuantities({ a: 1, b: 0 }, { a: 1 })).toBe(true);
  });
});
