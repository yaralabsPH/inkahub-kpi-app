import { describe, it, expect } from "vitest";
import {
  completeBlockReason,
  diffCheckedKeys,
  nextPickCount,
  packagingBlocksComplete,
  readTabOverride,
  resolveStationUi,
  scrollBehaviorFor,
  scrollTargetFor,
} from "../stationScreenModel";

// Review r1 regressions: the Complete contract, packaging blocks, toast
// timing, auto-scroll and the rollback switch. These are the decisions the
// Production page and the station screen both call into.

describe("completeBlockReason", () => {
  const lines = [
    { key: "a", sku: "INKA-DIV0147-A2-FN", belongsToThisDept: true },
    { key: "b", sku: "INKA-HIG0207-A3-UN", belongsToThisDept: true },
    { key: "c", sku: "INKA-DIV0147-A0-FN", belongsToThisDept: false }, // other station
    { key: "d", sku: "INKA-GC0001-50", belongsToThisDept: true }, // gift: not verifiable
  ];
  const only = (...keys: string[]) => (k: string) => keys.includes(k);

  it("new screen rejects a partly verified order", () => {
    expect(
      completeBlockReason({ department: "framed", stationUi: "new", verifiedCount: 1, lines, isVerified: only("a") }),
    ).toBe("Check every item before completing the order (1 left).");
  });

  it("new screen accepts once every required line is verified; other-station and gift lines don't block", () => {
    expect(
      completeBlockReason({ department: "framed", stationUi: "new", verifiedCount: 2, lines, isVerified: only("a", "b") }),
    ).toBeNull();
  });

  it("classic keeps the old at-least-one rule", () => {
    expect(
      completeBlockReason({ department: "framed", stationUi: "classic", verifiedCount: 1, lines, isVerified: only("a") }),
    ).toBeNull();
    expect(
      completeBlockReason({ department: "framed", stationUi: "classic", verifiedCount: 0, lines, isVerified: only() }),
    ).toBe("Verify at least one item before completing the order.");
  });

  it("new screen still refuses with nothing verified", () => {
    expect(
      completeBlockReason({ department: "unframed", stationUi: "new", verifiedCount: 0, lines, isVerified: only() }),
    ).toBe("Verify at least one item before completing the order.");
  });

  it("dispatch stays exempt, and can't be switched to the new screen", () => {
    expect(
      completeBlockReason({ department: "dispatch", stationUi: "new", verifiedCount: 0, lines, isVerified: only() }),
    ).toBeNull();
    expect(resolveStationUi({ department: "dispatch", tabOverride: "new" })).toBe("classic");
  });
});

describe("packagingBlocksComplete (same predicate as the classic action bar)", () => {
  it("blocks A0 Framed (box scan), Unframed (auto tube) and Dispatch until packaging is set", () => {
    for (const d of ["a0_framed", "unframed", "dispatch"] as const) {
      expect(packagingBlocksComplete(d, 0)).toBe(true);
      expect(packagingBlocksComplete(d, 1)).toBe(false);
    }
  });

  it("never blocks Framed", () => {
    expect(packagingBlocksComplete("framed", 0)).toBe(false);
  });
});

describe("diffCheckedKeys (toasts only after the saved state changes)", () => {
  const keys = ["a", "b", "c"];

  it("is silent on first render, even for lines already verified", () => {
    expect(diffCheckedKeys(null, new Set(["a"]), keys)).toEqual([]);
  });

  it("is silent while a verify is pending or after it failed (nothing saved)", () => {
    expect(diffCheckedKeys(new Set(["a"]), new Set(["a"]), keys)).toEqual([]);
  });

  it("reports a saved verify as done and a saved removal as undo", () => {
    expect(diffCheckedKeys(new Set(["a"]), new Set(["a", "b"]), keys)).toEqual([{ kind: "done", key: "b" }]);
    expect(diffCheckedKeys(new Set(["a", "b"]), new Set(["b"]), keys)).toEqual([{ kind: "undo", key: "a" }]);
  });

  it("a two-piece line verifies once, on the last piece", () => {
    const first = nextPickCount(0, 2);
    expect(first.verify).toBe(false); // screen-only, no write
    const second = nextPickCount(first.picked, 2);
    expect(second.verify).toBe(true); // calls the real verify handler
    expect(diffCheckedKeys(new Set(), new Set(["c"]), keys)).toEqual([{ kind: "done", key: "c" }]);
  });
});

describe("auto-scroll", () => {
  it("scrolls only when the current line changes", () => {
    expect(scrollTargetFor(null, "a")).toBe("a");
    expect(scrollTargetFor("a", "a")).toBeNull();
    expect(scrollTargetFor("a", "b")).toBe("b");
    expect(scrollTargetFor("b", null)).toBeNull();
  });

  it("does not smooth-scroll when reduced motion is requested", () => {
    expect(scrollBehaviorFor(true)).toBe("auto");
    expect(scrollBehaviorFor(false)).toBe("smooth");
  });
});

describe("readTabOverride", () => {
  function memStorage() {
    const m = new Map<string, string>();
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  }

  it("reads and remembers ?ui=classic for the tab", () => {
    const s = memStorage();
    expect(readTabOverride("?ui=classic", s)).toBe("classic");
    expect(s.m.get("inka-station-ui")).toBe("classic");
    expect(readTabOverride("", s)).toBe("classic");
  });

  it("honours the URL even when storage throws or is missing", () => {
    const broken = {
      getItem: (): string | null => { throw new Error("blocked"); },
      setItem: (): void => { throw new Error("blocked"); },
    };
    expect(readTabOverride("?ui=classic", broken)).toBe("classic");
    expect(readTabOverride("", broken)).toBeNull();
    expect(readTabOverride("?ui=classic", null)).toBe("classic");
  });

  it("ignores unknown values", () => {
    expect(readTabOverride("?ui=fancy", memStorage())).toBeNull();
  });
});
