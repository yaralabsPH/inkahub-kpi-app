import { describe, it, expect } from "vitest";
import {
  buildStationProgress,
  getStationLineView,
  nextPickCount,
  orderDoneKeys,
  resolveStationUi,
  type StationLineInput,
} from "../stationScreenModel";

// Expectations are written by hand from the v6 SKU grammar
// (INKA-<id>-<size>-<variant>), not computed from the helpers.
function line(sku: string, over: Partial<StationLineInput> = {}): StationLineInput {
  return { key: sku, sku, title: sku, quantity: 1, variantTitle: null, belongsToThisDept: true, ...over };
}

describe("getStationLineView", () => {
  it("puts framed prints in TO FRAME with a short size and frame colour", () => {
    const v = getStationLineView(line("INKA-DIV0147-A2-FN"));
    expect(v.group).toBe("frame");
    expect(v.size).toBe("A2");
    expect(v.frameLabel).toBe("Natural Timber");
    expect(v.frameColor).toBe("#9A5426");
    expect(v.needsCheck).toBe(true);
  });

  it("maps black and white frames to their swatches", () => {
    expect(getStationLineView(line("INKA-GOL0312-A1-FB")).frameColor).toBe("#1E2329");
    expect(getStationLineView(line("INKA-FER0089-A4-FW")).frameColor).toBe("#FFFFFF");
  });

  it("puts frame-only products in TO FRAME", () => {
    const v = getStationLineView(line("INKA-PF0001-A3-PB"));
    expect(v.group).toBe("frame");
    expect(v.frameLabel).toBe("Black");
  });

  it("puts unframed prints and canvas in PACK FLAT with no frame swatch", () => {
    const un = getStationLineView(line("INKA-HIG0207-A3-UN"));
    expect(un.group).toBe("flat");
    expect(un.frameLabel).toBe("No frame");
    expect(un.frameColor).toBeNull();
    const sc = getStationLineView(line("INKA-KAN0566-A2-SC"));
    expect(sc.group).toBe("flat");
    expect(sc.frameLabel).toBe("Stretched canvas");
    expect(sc.frameColor).toBeNull();
  });

  it("marks gift cards as not needing a check", () => {
    const v = getStationLineView(line("INKA-GC0001-50"));
    expect(v.needsCheck).toBe(false);
  });

  it("keeps legacy SKUs checkable with no invented size or frame", () => {
    const v = getStationLineView(line("OLD-SKU-123", { variantTitle: "A4 / Framed Print (Black)" }));
    expect(v.needsCheck).toBe(true);
    expect(v.size).toBeNull();
    expect(v.frameColor).toBeNull();
    expect(v.fallbackDescription).toBe("A4 / Framed Print (Black)");
  });

  it("sends other-department lines to their own group and never needs a check", () => {
    const v = getStationLineView(line("INKA-DIV0147-A0-FN", { belongsToThisDept: false }));
    expect(v.group).toBe("other");
    expect(v.needsCheck).toBe(false);
  });

  it("reports the set count for set prints", () => {
    const v = getStationLineView(line("INKA-S2BON0064-A1-UN"));
    expect(v.setCount).toBe(2);
  });
});

describe("buildStationProgress", () => {
  const lines = [
    line("INKA-DIV0147-A2-FN"),
    line("INKA-GOL0312-A1-FB", { quantity: 2 }),
    line("INKA-HIG0207-A3-UN"),
    line("INKA-GC0001-50"),
    line("INKA-ARC0221-A2-FN", { belongsToThisDept: false }),
  ].map(getStationLineView);

  it("counts only lines this station must check", () => {
    const p = buildStationProgress(lines, new Set());
    expect(p.required).toBe(3);
    expect(p.checked).toBe(0);
    expect(p.remaining).toBe(3);
    expect(p.allDone).toBe(false);
    expect(p.pieces).toBe(4); // 1 + 2 + 1 for this station's checkable lines
    expect(p.toFrame).toBe(2);
    expect(p.packFlat).toBe(1);
  });

  it("counts every piece of a set (two 2-piece sets and one print = 5)", () => {
    const setLines = [
      line("INKA-LOV0285-A0-UN"),
      line("INKA-S2JAP0006-A2-FN"),
      line("INKA-S2JAP0009-A2-FN"),
    ].map(getStationLineView);
    expect(buildStationProgress(setLines, new Set()).pieces).toBe(5);
  });

  it("makes the first unchecked line current, in group order", () => {
    expect(buildStationProgress(lines, new Set()).currentKey).toBe("INKA-DIV0147-A2-FN");
    expect(
      buildStationProgress(lines, new Set(["INKA-DIV0147-A2-FN", "INKA-GOL0312-A1-FB"])).currentKey,
    ).toBe("INKA-HIG0207-A3-UN");
  });

  it("is all done when every required line is checked", () => {
    const p = buildStationProgress(
      lines,
      new Set(["INKA-DIV0147-A2-FN", "INKA-GOL0312-A1-FB", "INKA-HIG0207-A3-UN"]),
    );
    expect(p.allDone).toBe(true);
    expect(p.currentKey).toBeNull();
    expect(p.remaining).toBe(0);
  });

  it("is never all done for an order with nothing to check", () => {
    const p = buildStationProgress([getStationLineView(line("INKA-GC0001-50"))], new Set());
    expect(p.required).toBe(0);
    expect(p.allDone).toBe(false);
  });
});

describe("nextPickCount", () => {
  it("verifies a single-quantity line on the first pick", () => {
    expect(nextPickCount(0, 1)).toEqual({ picked: 1, verify: true });
  });

  it("needs every piece before verifying", () => {
    expect(nextPickCount(0, 2)).toEqual({ picked: 1, verify: false });
    expect(nextPickCount(1, 2)).toEqual({ picked: 2, verify: true });
  });

  it("treats bad quantities as one piece", () => {
    expect(nextPickCount(0, 0)).toEqual({ picked: 1, verify: true });
  });
});

describe("orderDoneKeys", () => {
  it("lists newest checks first and skips keys without a time", () => {
    const times = new Map([
      ["a", "2026-11-22T01:00:00Z"],
      ["b", "2026-11-22T01:05:00Z"],
      ["c", "2026-11-22T01:02:00Z"],
    ]);
    expect(orderDoneKeys(["a", "b", "c", "d"], times)).toEqual(["b", "c", "a"]);
  });
});

describe("resolveStationUi", () => {
  it("uses the new screen by default for framing stations", () => {
    expect(resolveStationUi({ department: "framed" })).toBe("new");
    expect(resolveStationUi({ department: "a0_framed" })).toBe("new");
    expect(resolveStationUi({ department: "unframed" })).toBe("new");
  });

  it("keeps dispatch on the classic screen", () => {
    expect(resolveStationUi({ department: "dispatch" })).toBe("classic");
  });

  it("goes classic with the env switch or the tab override", () => {
    expect(resolveStationUi({ department: "framed", envValue: "classic" })).toBe("classic");
    expect(resolveStationUi({ department: "framed", tabOverride: "classic" })).toBe("classic");
  });

  it("lets the tab override force the new screen back on", () => {
    expect(resolveStationUi({ department: "framed", envValue: "classic", tabOverride: "new" })).toBe("new");
  });
});
