import { describe, expect, it } from "vitest";
import { describeArtwork } from "../artworkIdentity";
import { artworkCodeFromSku, dropboxFilenamesForSku } from "../skuRouting";

describe("describeArtwork — artwork SKUs", () => {
  it.each([
    ["INKA-KAN0566-A4-FB", "KAN0566", ["INKA-KAN0566"]],
    ["INKA-NO0338-A1-UN", "NO0338", ["INKA-NO0338"]],
    ["INKA-AUX-FP-ESP-A2", "ESP", ["INKA-AUX-FP-ESP"]],
    ["INKA-S3WIL0049-A2-FN", "S3WIL0049", ["INKA-S3-WIL0049-01", "INKA-S3-WIL0049-02", "INKA-S3-WIL0049-03"]],
  ])("%s → %s with ordered components", (sku, code, stems) => {
    const d = describeArtwork(sku);
    expect(d).toMatchObject({ kind: "artwork", code });
    if (d.kind !== "artwork") throw new Error("unreachable");
    expect(d.components.map((c) => c.ordinal)).toEqual(stems.map((_, i) => i + 1));
    expect(d.components.map((c) => c.stem)).toEqual(stems);
  });

  it("agrees with the existing routing helpers (one parser, no second regex)", () => {
    for (const sku of ["INKA-KAN0566-A4-FB", "INKA-S6MON0012-GW-FB", "INKA-AUX-FP-MCO-A3", "INKA-S2ABC0001-A3-UN"]) {
      const d = describeArtwork(sku);
      if (d.kind !== "artwork") throw new Error(`${sku} should be artwork`);
      expect(d.code).toBe(artworkCodeFromSku(sku));
      expect(d.components.map((c) => `${c.stem}.jpg`)).toEqual(dropboxFilenamesForSku(sku));
    }
  });

  it("never lets size, frame, case or whitespace into the key", () => {
    const variants = ["INKA-KAN0566-A4-FB", "INKA-KAN0566-A0-FN", "INKA-KAN0566-A2-UN", "INKA-KAN0566-A3-SC", " inka-kan0566-a1-fw "];
    const codes = new Set(variants.map((s) => {
      const d = describeArtwork(s);
      return d.kind === "artwork" ? d.code : d.kind;
    }));
    expect([...codes]).toEqual(["KAN0566"]);

    const sets = ["INKA-S3WIL0049-A2-FN", "INKA-S3WIL0049-A4-UN", "INKA-S3WIL0049-A1-FB"];
    expect(new Set(sets.map((s) => (describeArtwork(s) as { code: string }).code))).toEqual(new Set(["S3WIL0049"]));
  });

  it("covers S2, S3, GW and the largest supported set", () => {
    const counts: Array<[string, number]> = [
      ["INKA-S2ABC0001-A3-FW", 2],
      ["INKA-S3WIL0049-A2-FN", 3],
      ["INKA-S6MON0012-GW-FB", 6],
      ["INKA-S9XYZ0002-A4-UN", 9],
    ];
    for (const [sku, n] of counts) {
      const d = describeArtwork(sku);
      if (d.kind !== "artwork") throw new Error(`${sku} should be artwork`);
      expect(d.components).toHaveLength(n);
      expect(d.components[n - 1].stem).toMatch(new RegExp(`-${String(n).padStart(2, "0")}$`));
    }
  });

  it("accepts set component names with and without the S{N}- separator", () => {
    const d = describeArtwork("INKA-S2ABC0001-A3-FW");
    if (d.kind !== "artwork") throw new Error("unreachable");
    expect(d.components[1].stems).toEqual(["INKA-S2-ABC0001-02", "INKA-S2ABC0001-02"]);
    const single = describeArtwork("INKA-KAN0566-A4-FB");
    if (single.kind !== "artwork") throw new Error("unreachable");
    expect(single.components[0].stems).toEqual(["INKA-KAN0566"]);
  });

  it("treats free prints as artwork even though KPI excludes them", () => {
    expect(describeArtwork("INKA-AUX-FP-ESP-A2")).toMatchObject({ kind: "artwork", code: "ESP", skuType: "aux_free_print" });
  });
});

describe("describeArtwork — non-artwork and unknown", () => {
  it.each([
    ["INKA-GC0001-100", "gift_card"],
    ["INKA-PF0004-A0-PW", "frame_only"],
    ["INKA-AUX-HOOK", "accessory"],
    ["INKA-AUX-IMH", "accessory"],
  ])("%s is explicitly non-artwork (%s)", (sku, nonArtwork) => {
    expect(describeArtwork(sku)).toEqual({ kind: "non_artwork", nonArtwork });
  });

  it.each([
    [null, "blank"],
    [undefined, "blank"],
    ["", "blank"],
    ["   ", "blank"],
    ["Framed Print (Black) / A4", "legacy_unknown"],
    ["KAN0566", "legacy_unknown"],
    ["INKA-KAN0566", "malformed"],
    ["INKA-KAN0566-A5-FB", "malformed"],
    ["INKA-KAN056-A4-FB", "malformed"],
    ["INKA-KANS0566-A4-FB", "malformed"],
    ["INKA-S3WIL0049-A2", "malformed"],
  ])("%j is unknown (%s), never a guess", (sku, reason) => {
    expect(describeArtwork(sku)).toEqual({ kind: "unknown", reason });
  });

  it("rejects a zero-component set without changing parseSku/KPI behaviour", () => {
    expect(describeArtwork("INKA-S0WIL0049-A2-FN")).toEqual({ kind: "unknown", reason: "invalid_set" });
    // The existing helpers are untouched: they still parse it as a set with no files.
    expect(artworkCodeFromSku("INKA-S0WIL0049-A2-FN")).toBe("S0WIL0049");
    expect(dropboxFilenamesForSku("INKA-S0WIL0049-A2-FN")).toEqual([]);
  });
});
