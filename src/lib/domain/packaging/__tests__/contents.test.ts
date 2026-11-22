import { describe, expect, it } from "vitest";
import { packagingContents, packingPointsForOrder, totalPieces } from "../contents";

// Synthetic SKUs in the v6 format; no real order data.
const A1_FRAMED = "INKA-ABC0001-A1-FB";
const A0_FRAMED = "INKA-ABC0002-A0-FN";
const A3_UNFRAMED = "INKA-ABC0003-A3-UN";
const A0_UNFRAMED = "INKA-ABC0004-A0-UN";
const SET2_A1_UNFRAMED = "INKA-S2ABC0005-A1-UN";
const SET3_A2_FRAMED = "INKA-S3ABC0006-A2-FW";
const PICTURE_FRAME_A2 = "INKA-PF0001-A2-PB";
const PICTURE_FRAME_A0 = "INKA-PF0002-A0-PN";
const FREE_PRINT_A3 = "INKA-AUX-FP-ABC-A3";
const HOOKS = "INKA-AUX-HOOKS";
const GIFT_CARD = "INKA-GC0001-50";
const CANVAS = "INKA-ABC0007-A1-SC";

describe("packingPointsForOrder", () => {
  it("packs a single framed print at dispatch", () => {
    const m = packingPointsForOrder([{ sku: A1_FRAMED, quantity: 1 }]);
    expect([...m.keys()]).toEqual(["dispatch"]);
    expect(m.get("dispatch")).toEqual({ pieces: [{ kind: "framed", size: "A1", pieces: 1 }], unclassified: [] });
  });

  it("multiplies sets by their piece count", () => {
    const c = packagingContents([{ sku: SET2_A1_UNFRAMED, quantity: 2 }], "unframed");
    expect(c.pieces).toEqual([{ kind: "unframed", size: "A1", pieces: 4 }]);
    const d = packagingContents([{ sku: SET3_A2_FRAMED, quantity: 1 }], "dispatch");
    expect(d.pieces).toEqual([{ kind: "framed", size: "A2", pieces: 3 }]);
  });

  it("merges lines of the same kind and size", () => {
    const c = packagingContents(
      [{ sku: A1_FRAMED, quantity: 1 }, { sku: "INKA-XYZ0009-A1-FN", quantity: 2 }],
      "dispatch",
    );
    expect(c.pieces).toEqual([{ kind: "framed", size: "A1", pieces: 3 }]);
  });

  it("gives a mixed A0 + A1 framed order two packing points", () => {
    const m = packingPointsForOrder([{ sku: A0_FRAMED, quantity: 1 }, { sku: A1_FRAMED, quantity: 2 }]);
    expect(new Set(m.keys())).toEqual(new Set(["a0_framed", "dispatch"]));
    expect(m.get("a0_framed")!.pieces).toEqual([{ kind: "framed", size: "A0", pieces: 1 }]);
    expect(m.get("dispatch")!.pieces).toEqual([{ kind: "framed", size: "A1", pieces: 2 }]);
  });

  it("routes picture frames by size", () => {
    const m = packingPointsForOrder([{ sku: PICTURE_FRAME_A2, quantity: 1 }, { sku: PICTURE_FRAME_A0, quantity: 1 }]);
    expect(m.get("dispatch")!.pieces).toEqual([{ kind: "picture_frame", size: "A2", pieces: 1 }]);
    expect(m.get("a0_framed")!.pieces).toEqual([{ kind: "picture_frame", size: "A0", pieces: 1 }]);
  });

  it("puts unframed prints in the box when the order has a framed parcel (CJ decision Q4)", () => {
    const m = packingPointsForOrder([{ sku: A1_FRAMED, quantity: 1 }, { sku: A3_UNFRAMED, quantity: 2 }]);
    expect([...m.keys()]).toEqual(["dispatch"]);
    expect(m.get("dispatch")!.pieces).toEqual([
      { kind: "framed", size: "A1", pieces: 1 },
      { kind: "unframed", size: "A3", pieces: 2 },
    ]);
    expect(packagingContents([{ sku: A1_FRAMED, quantity: 1 }, { sku: A3_UNFRAMED, quantity: 2 }], "unframed"))
      .toEqual({ pieces: [], unclassified: [] });
  });

  it("sends travellers to the A0 parcel when that is the only framed parcel", () => {
    const m = packingPointsForOrder([{ sku: A0_FRAMED, quantity: 1 }, { sku: A3_UNFRAMED, quantity: 1 }, { sku: HOOKS, quantity: 1 }]);
    expect([...m.keys()]).toEqual(["a0_framed"]);
    expect(totalPieces(m.get("a0_framed")!)).toBe(3);
  });

  it("prefers the dispatch parcel when both framed parcels exist", () => {
    const m = packingPointsForOrder([
      { sku: A0_FRAMED, quantity: 1 }, { sku: A1_FRAMED, quantity: 1 }, { sku: FREE_PRINT_A3, quantity: 1 },
    ]);
    expect(m.get("dispatch")!.pieces).toContainEqual({ kind: "free_print", size: "A3", pieces: 1 });
    expect(m.get("a0_framed")!.pieces).toEqual([{ kind: "framed", size: "A0", pieces: 1 }]);
  });

  it("packs unframed-only orders at unframed, with their accessories", () => {
    const m = packingPointsForOrder([
      { sku: A3_UNFRAMED, quantity: 1 }, { sku: A0_UNFRAMED, quantity: 1 }, { sku: FREE_PRINT_A3, quantity: 1 }, { sku: HOOKS, quantity: 2 },
    ]);
    expect([...m.keys()]).toEqual(["unframed"]);
    expect(m.get("unframed")!.pieces).toEqual([
      { kind: "unframed", size: "A3", pieces: 1 },
      { kind: "unframed", size: "A0", pieces: 1 },
      { kind: "free_print", size: "A3", pieces: 1 },
      { kind: "accessory", size: null, pieces: 2 },
    ]);
  });

  it("packs accessories-only orders at dispatch", () => {
    const m = packingPointsForOrder([{ sku: HOOKS, quantity: 1 }]);
    expect([...m.keys()]).toEqual(["dispatch"]);
  });

  it("never packs gift cards", () => {
    expect(packingPointsForOrder([{ sku: GIFT_CARD, quantity: 1 }]).size).toBe(0);
    const m = packingPointsForOrder([{ sku: GIFT_CARD, quantity: 1 }, { sku: A1_FRAMED, quantity: 1 }]);
    expect(totalPieces(m.get("dispatch")!)).toBe(1);
  });

  it("reports unparseable and canvas SKUs as unclassified on the carrier parcel", () => {
    const m = packingPointsForOrder([
      { sku: A1_FRAMED, quantity: 1 }, { sku: "LEGACY-123", quantity: 1 }, { sku: CANVAS, quantity: 1 }, { sku: null, quantity: 1 },
    ]);
    expect(m.get("dispatch")!.unclassified).toEqual(["LEGACY-123", CANVAS, "(no SKU)"]);
    const only = packingPointsForOrder([{ sku: "LEGACY-123", quantity: 1 }]);
    expect(only.get("dispatch")!.unclassified).toEqual(["LEGACY-123"]);
  });

  it("treats missing or bad quantities as one", () => {
    const c = packagingContents([{ sku: A1_FRAMED, quantity: null }, { sku: A1_FRAMED, quantity: 0 }], "dispatch");
    expect(c.pieces).toEqual([{ kind: "framed", size: "A1", pieces: 2 }]);
  });

  it("returns empty contents for an empty order", () => {
    expect(packingPointsForOrder([]).size).toBe(0);
    expect(packagingContents([], "dispatch")).toEqual({ pieces: [], unclassified: [] });
  });
});
