import { describe, expect, it } from "vitest";
import { classifyFramingLine, FRAMING_LABEL_MAX, prepareFramingOrder, type OrderLookup, type PackagingSetup } from "../order";
import type { RuleSetBody } from "@/lib/domain/packaging/ruleSet";

// Synthetic catalogue and rules; not real stock codes or box rules.
const products = [
  { id: "p-a0b", code: "A0-Black" },
  { id: "p-a0n", code: "A0-Natural" },
  { id: "p-hook", code: "INKA-AUX-HOOK" },
  { id: "p-box", code: "BOX-A0" },
];
const body: RuleSetBody = {
  schema_version: 1,
  catalogue: [{ key: "A0BOX", product_id: "p-box", label: "A0 box", packing_points: ["a0_framed"] }],
  rules: [
    { id: "a0", packing_point: "a0_framed", kinds: ["framed", "accessory"], output: { mode: "per_capacity", capacity: 2, package: "A0BOX" } },
  ],
  examples: [],
};
const auto: PackagingSetup = { mode: "auto", ruleSet: { id: "rs-1", version: 3, body } };
/** One A0 single + one A0 set of 2 = 3 framed pieces at capacity 2. */
const A0_BOXES = 2;

function order(lines: OrderLookup["line_items"], over: Partial<OrderLookup> = {}): OrderLookup {
  return { found: true, complete: true, truncated: false, order_name: "#10190203", cancelled_at: null, tags: [], line_items: lines, ...over };
}
const ctx = (over: Partial<Parameters<typeof prepareFramingOrder>[1]> = {}) => ({
  orderNumber: "10190203",
  openCase: false,
  products,
  packaging: auto,
  ...over,
});

describe("classifyFramingLine", () => {
  it("classifies current framed singles sets and GW forms", () => {
    const framed: Array<[string, string]> = [
      ["INKA-ABC0001-A0-FB", "a0_framed"],
      ["INKA-ABC0001-A1-FW", "framed"],
      ["INKA-ABC0001-A2-FN", "framed"],
      ["INKA-NO0338-A3-FB", "framed"],
      [" inka-abc0001-a4-fb ", "framed"], // case and whitespace normalised
      ["INKA-S3WIL0049-A3-FN", "framed"],
      ["INKA-S2ABC0003-A0-FN", "a0_framed"],
      ["INKA-S5ABC0004-GW-FB", "framed"], // gallery wall sets are supported
    ];
    for (const [sku, workType] of framed) {
      expect(classifyFramingLine({ sku }), sku).toEqual({ kind: "framed", sku: sku.trim().toUpperCase(), workType });
    }
  });

  it("explicit exclusions outrank framing words", () => {
    const ignored: Array<{ sku: string | null; title?: string; variant_title?: string }> = [
      { sku: "INKA-ABC0001-A2-SC" }, // stretched canvas
      { sku: "INKA-AUXMFL", title: "Framed print hanging kit" },
      { sku: "INKA-AUX-HOOK", title: "Hook for framed prints" },
      { sku: "INKA-AUX-FP-ESP-A2", title: "Free print" },
      { sku: "INKA-GC0001-100", title: "Gift card" },
      { sku: "INKA-PF0004-A0-PW", title: "Picture frame" },
      { sku: "INKA-ABC0002-A1-UN", title: "Unframed print" },
      { sku: null, title: "Gift bag" },
      { sku: "", title: "Gift certificate", variant_title: "Framed" },
      { sku: "FREE-SAMPLE-01", title: "Free sample" },
      { sku: "A2 Black Frame", title: "A2 Black Frame" }, // legacy frame-only: no framing evidence
      { sku: null, title: "Mystery extra" },
      { sku: "SOMETHING-ELSE" },
      { sku: null, title: "Unframed poster" }, // "unframed" is not the word "framed"
    ];
    for (const l of ignored) expect(classifyFramingLine(l), JSON.stringify(l)).toEqual({ kind: "ignored" });
  });

  it("rejects suspicious framing intent without guessing", () => {
    const suspicious: Array<[{ sku: string | null; title?: string; variant_title?: string }, string]> = [
      [{ sku: "INKA-ABC0001-FB" }, "INKA-ABC0001-FB"], // missing size
      [{ sku: "INKA-ABC0001-A9-FB" }, "INKA-ABC0001-A9-FB"], // bad size
      [{ sku: "INKA-ABC0001-A2-FX" }, "INKA-ABC0001-A2-FX"], // bad variant on an artwork stem
      [{ sku: "INKA-S9ABC0001-A2" }, "INKA-S9ABC0001-A2"], // invalid set tail
      [{ sku: "OLD-PRINT-123-FN" }, "OLD-PRINT-123-FN"], // unknown SKU ending in a framed variant
      [{ sku: "A2-OLD", title: "Framed print, black" }, "A2-OLD"], // legacy SKU, framed title
      [{ sku: null, title: "Framed print" }, "Framed print"],
      [{ sku: "  ", title: "Print", variant_title: "A2 / Framed black" }, "Print"],
      [{ sku: "INKA-ABC0001-GW-FB" }, "INKA-ABC0001-GW-FB"], // single gallery wall is not supported
    ];
    for (const [l, label] of suspicious) {
      expect(classifyFramingLine(l), JSON.stringify(l)).toEqual({ kind: "suspicious", label });
    }
  });
});

describe("classifyFramingLine review r1", () => {
  it("M1: a promotional word never hides an unidentified framed print", () => {
    for (const title of ["Framed print with free shipping", "Framed print, gift wrapped", "Framed print (bag included)"]) {
      expect(classifyFramingLine({ sku: null, title }), title).toEqual({ kind: "suspicious", label: title });
    }
    const r = prepareFramingOrder(order([
      { sku: "INKA-ABC0001-A2-FB", quantity: 1 },
      { sku: null, title: "Framed print with free shipping", quantity: 1 },
    ]), ctx({ packaging: null }));
    expect(r).toMatchObject({ ok: false, code: "suspicious_framing" });
    expect(r).not.toHaveProperty("prepared");
  });

  it("M2: explicit categories are ignored for unknown non-blank SKUs too", () => {
    const lines = [
      { sku: "HOOK-01", title: "Hook for framed prints" },
      { sku: "GIFT-BAG-01", title: "Gift bag for framed prints" },
      { sku: "KIT-9", title: "Hanging kit", variant_title: "Framed" },
      { sku: "SAMPLE-1", title: "Free sample (framed)" },
      { sku: "PF-OLD", title: "Picture frame only" },
    ];
    for (const l of lines) expect(classifyFramingLine(l), l.sku).toEqual({ kind: "ignored" });
    // ...but a SKU shaped like a framed print stays suspicious whatever its title says.
    expect(classifyFramingLine({ sku: "INKA-ABC0001-A9-FB", title: "Hook" })).toEqual({ kind: "suspicious", label: "INKA-ABC0001-A9-FB" });
    expect(classifyFramingLine({ sku: "OLD-1-FN", title: "Gift bag" })).toEqual({ kind: "suspicious", label: "OLD-1-FN" });
  });

  it("M2: regular and A0 orders with arbitrary accessory SKUs save framing lines only", () => {
    const extras = [
      { sku: "HOOK-01", title: "Hook for framed prints", quantity: 2 },
      { sku: "GIFT-BAG-01", title: "Gift bag for framed prints", quantity: 1 },
    ];
    const regular = order([{ sku: "INKA-ABC0001-A2-FB", quantity: 1 }, ...extras]);
    const before = JSON.stringify(regular);
    const r = prepareFramingOrder(regular, ctx({ packaging: null }));
    expect(JSON.stringify(regular)).toBe(before);
    if (!r.ok) throw new Error(r.message);
    expect(r.prepared.lines.map((l) => l.sku)).toEqual(["INKA-ABC0001-A2-FB"]);
    expect(r.prepared.components).toEqual([]);

    const a0 = prepareFramingOrder(order([{ sku: "INKA-ABC0001-A0-FB", quantity: 1 }, ...extras]), ctx());
    const plain = prepareFramingOrder(order([{ sku: "INKA-ABC0001-A0-FB", quantity: 1 }]), ctx());
    if (!a0.ok || !plain.ok) throw new Error("expected both to prepare");
    expect(a0.prepared.components).toEqual([{ code: "A0-Black", qty: 1 }]);
    expect(a0.prepared.packaging).toEqual(plain.prepared.packaging);
    expect(JSON.stringify(a0.prepared)).not.toMatch(/HOOK|GIFT/);
  });

  it("S1: the refusal label is bounded and falls back to the variant", () => {
    const long = `Framed ${"x".repeat(10_000)}`;
    const c = classifyFramingLine({ sku: null, title: long });
    if (c.kind !== "suspicious") throw new Error("expected suspicious");
    expect(c.label).toHaveLength(FRAMING_LABEL_MAX);
    expect(c.label.endsWith("…")).toBe(true);
    expect(classifyFramingLine({ sku: null, title: "", variant_title: "A2 / Framed black" }))
      .toEqual({ kind: "suspicious", label: "A2 / Framed black" });
  });
});

describe("prepareFramingOrder", () => {
  it("saves every framed line by SKU with raw quantity; unframed/frames/gift/accessories get no credit", () => {
    const r = prepareFramingOrder(order([
      { sku: "INKA-ABC0001-A2-FB", quantity: 1 },
      { sku: "inka-abc0001-a2-fb ", quantity: 2 }, // same SKU again: aggregated
      { sku: "INKA-S3WIL0049-A3-FN", quantity: 1 }, // set of 3
      { sku: "INKA-ABC0002-A1-UN", quantity: 1 },
      { sku: "INKA-PF0001-A2-PB", quantity: 1 },
      { sku: "INKA-GC0001-50", quantity: 1 },
      { sku: "INKA-AUX-HOOK", quantity: 1 },
    ]), ctx({ packaging: null }));
    expect(r).toEqual({
      ok: true,
      prepared: {
        orderNumber: "10190203",
        displayName: "#10190203",
        lines: [
          { sku: "INKA-ABC0001-A2-FB", quantity: 3, workType: "framed", pieces: 3 },
          { sku: "INKA-S3WIL0049-A3-FN", quantity: 1, workType: "framed", pieces: 3 },
        ],
        workTypes: ["framed"],
        pieces: 6,
        components: [], // regular framed deducts at dispatch, as before
        packaging: null, // Framed packs nothing
      },
    });
  });

  it("mixed A0 + regular: both work types, A0 components from framing lines only, and F4 packaging", () => {
    const r = prepareFramingOrder(order([
      { sku: "INKA-ABC0001-A0-FB", quantity: 1 },
      { sku: "INKA-S2ABC0003-A0-FN", quantity: 1 },
      { sku: "INKA-ABC0002-A2-FW", quantity: 1 },
      { sku: "INKA-AUX-HOOK", quantity: 2 },
    ]), ctx());
    if (!r.ok) throw new Error(r.message);
    expect(r.prepared.workTypes).toEqual(["a0_framed", "framed"]);
    expect(r.prepared.lines.map((l) => [l.sku, l.workType, l.quantity, l.pieces])).toEqual([
      ["INKA-ABC0001-A0-FB", "a0_framed", 1, 1],
      ["INKA-ABC0002-A2-FW", "framed", 1, 1],
      ["INKA-S2ABC0003-A0-FN", "a0_framed", 1, 2],
    ]);
    expect(r.prepared.components).toEqual([
      { code: "A0-Black", qty: 1 },
      { code: "A0-Natural", qty: 2 },
    ]);
    expect(r.prepared.packaging).toMatchObject({
      ruleSetId: "rs-1",
      ruleSetVersion: 3,
      resolved: true,
      predicted: { "p-box": A0_BOXES },
      target: { "p-box": A0_BOXES },
      snapshot: { rule_set_version: 3, packing_point: "a0_framed" },
    });
  });

  it("returns a deep copy that shares nothing with the input", () => {
    const lookup = order([{ sku: "INKA-ABC0001-A0-FB", quantity: 1 }]);
    const r = prepareFramingOrder(lookup, ctx());
    if (!r.ok) throw new Error(r.message);
    (body.catalogue[0] as { label: string }).label = "changed";
    expect(JSON.stringify(r.prepared)).not.toContain("changed");
    (body.catalogue[0] as { label: string }).label = "A0 box";
  });

  const reject: Array<[string, OrderLookup, Partial<Parameters<typeof prepareFramingOrder>[1]>, string]> = [
    ["not found", { found: false }, {}, "not_found"],
    ["incomplete (truncated)", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 1 }], { truncated: true }), {}, "incomplete_order"],
    ["incomplete (old server, no flag)", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 1 }], { complete: undefined }), {}, "incomplete_order"],
    ["another order returned", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 1 }], { order_name: "#10190999" }), {}, "name_mismatch"],
    ["cancelled", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 1 }], { cancelled_at: "2026-11-01T00:00:00Z" }), {}, "cancelled"],
    ["edit tag", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 1 }], { tags: ["oe-staff-edit"] }), {}, "edit_warning"],
    ["open case", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 1 }]), { openCase: true }, "open_case"],
    ["framed print it cannot identify", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 1 }, { sku: "INKA-ABC0001-A9-FB", quantity: 1 }]), {}, "suspicious_framing"],
    ["zero quantity", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 0 }]), {}, "invalid_quantity"],
    ["fractional quantity", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 1.5 }]), {}, "invalid_quantity"],
    ["huge quantity", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 101 }]), {}, "invalid_quantity"],
    ["single gallery wall", order([{ sku: "INKA-ABC0001-GW-FB", quantity: 1 }]), {}, "suspicious_framing"],
    ["no framing lines", order([{ sku: "INKA-ABC0001-A2-UN", quantity: 1 }, { sku: "INKA-AUX-HOOK", quantity: 1 }]), {}, "no_framing_lines"],
    ["A0 stock code missing", order([{ sku: "INKA-ABC0001-A0-FW", quantity: 1 }]), {}, "missing_stock_code"],
    ["A0 without auto packaging", order([{ sku: "INKA-ABC0001-A0-FB", quantity: 1 }]), { packaging: { mode: "scan", ruleSet: null } }, "packaging_not_auto"],
    ["A0 packaging unresolved", order([{ sku: "INKA-ABC0001-A0-FB", quantity: 1 }]),
      { packaging: { mode: "auto", ruleSet: { id: "rs-2", version: 1, body: { ...body, rules: [] } } } }, "packaging_unresolved"],
  ];
  for (const [name, lookup, over, code] of reject) {
    it(`sends the whole order to classic: ${name}`, () => {
      const r = prepareFramingOrder(lookup, ctx(over));
      expect(r).toMatchObject({ ok: false, code });
      if (!r.ok && code !== "no_framing_lines") expect(r.message).toMatch(/classic station/);
    });
  }

  it("mixed order saves only framing lines and leaves lookup untouched", () => {
    const lookup = order([
      { sku: "INKA-ABC0001-A2-FB", quantity: 2 },
      { sku: "INKA-ABC0001-A2-SC", quantity: 1 }, // canvas
      { sku: "INKA-AUXMFL", quantity: 1, title: "Framed hanging kit" },
      { sku: "INKA-AUX-HOOK", quantity: 3 },
      { sku: null, quantity: 1, title: "Gift bag" },
      { sku: "A2 Black Frame", quantity: 1 }, // legacy frame only
      { sku: "INKA-GC0001-50", quantity: 1 },
    ]);
    const before = JSON.stringify(lookup);
    Object.freeze(lookup.line_items);
    const r = prepareFramingOrder(lookup, ctx({ packaging: null }));
    expect(JSON.stringify(lookup)).toBe(before);
    expect(r).toEqual({
      ok: true,
      prepared: {
        orderNumber: "10190203",
        displayName: "#10190203",
        lines: [{ sku: "INKA-ABC0001-A2-FB", quantity: 2, workType: "framed", pieces: 2 }],
        workTypes: ["framed"],
        pieces: 2,
        components: [],
        packaging: null,
      },
    });
  });

  it("suspicious framing refuses the whole mixed order", () => {
    const r = prepareFramingOrder(order([
      { sku: "INKA-ABC0001-A2-FB", quantity: 1 },
      { sku: "INKA-ABC0002-A2-FX", quantity: 1 },
      { sku: "INKA-AUX-HOOK", quantity: 1 },
    ]), ctx({ packaging: null }));
    expect(r).toEqual({
      ok: false,
      code: "suspicious_framing",
      message: "This order has a framed print we couldn't identify: INKA-ABC0002-A2-FX. Nothing was saved. Ask a manager to check it on the classic station.",
    });
  });

  it("validates only selected quantities and their aggregate", () => {
    for (const q of [1, 100]) {
      expect(prepareFramingOrder(order([{ sku: "INKA-ABC0001-A2-FB", quantity: q }]), ctx({ packaging: null })).ok).toBe(true);
    }
    for (const q of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 101]) {
      expect(prepareFramingOrder(order([{ sku: "INKA-ABC0001-A2-FB", quantity: q }]), ctx({ packaging: null })), String(q))
        .toMatchObject({ ok: false, code: "invalid_quantity" });
      // the same bad quantity on an ignored line never blocks framing
      expect(prepareFramingOrder(order([
        { sku: "INKA-ABC0001-A2-FB", quantity: 1 },
        { sku: "INKA-AUX-HOOK", quantity: q },
        { sku: "INKA-ABC0001-A2-SC", quantity: q },
      ]), ctx({ packaging: null })).ok, String(q)).toBe(true);
    }
    expect(prepareFramingOrder(order([
      { sku: "INKA-ABC0001-A2-FB", quantity: 60 },
      { sku: "INKA-ABC0001-A2-FB", quantity: 41 },
    ]), ctx({ packaging: null }))).toMatchObject({ ok: false, code: "invalid_quantity" });
  });

  it("empty selection uses the approved message", () => {
    const r = prepareFramingOrder(order([
      { sku: "INKA-ABC0001-A2-UN", quantity: 1 },
      { sku: "INKA-ABC0001-A2-SC", quantity: 1 },
      { sku: "INKA-AUX-HOOK", quantity: 1 },
    ]), ctx());
    expect(r).toEqual({ ok: false, code: "no_framing_lines", message: "Nothing to frame on this order. Nothing was saved." });
  });

  it("A0-only with canvas and AUXMFL uses only framed stock and box contents", () => {
    const withExtras = prepareFramingOrder(order([
      { sku: "INKA-ABC0001-A0-FB", quantity: 1 },
      { sku: "INKA-S2ABC0003-A0-FN", quantity: 1 },
      { sku: "INKA-ABC0005-A0-SC", quantity: 1 },
      { sku: "INKA-AUXMFL", quantity: 2 },
      { sku: "INKA-AUX-HOOK", quantity: 4 },
    ]), ctx());
    const plain = prepareFramingOrder(order([
      { sku: "INKA-ABC0001-A0-FB", quantity: 1 },
      { sku: "INKA-S2ABC0003-A0-FN", quantity: 1 },
    ]), ctx());
    if (!withExtras.ok || !plain.ok) throw new Error("expected both to prepare");
    expect(withExtras.prepared.components).toEqual([
      { code: "A0-Black", qty: 1 },
      { code: "A0-Natural", qty: 2 },
    ]);
    expect(withExtras.prepared.pieces).toBe(3);
    // identical box prediction and snapshot to the same order without extras
    expect(withExtras.prepared.packaging).toEqual(plain.prepared.packaging);
    expect(JSON.stringify(withExtras.prepared.packaging)).not.toMatch(/AUX|-SC/);
  });

  it("mixed A0 and regular sets keep set pieces and only A0 components", () => {
    const r = prepareFramingOrder(order([
      { sku: "INKA-S3WIL0049-A0-FB", quantity: 1 },
      { sku: "INKA-S2ABC0003-A2-FN", quantity: 2 },
      { sku: "INKA-AUX-HOOK", quantity: 1 },
    ]), ctx());
    if (!r.ok) throw new Error(r.message);
    expect(r.prepared.workTypes).toEqual(["a0_framed", "framed"]);
    expect(r.prepared.pieces).toBe(3 + 4);
    expect(r.prepared.components).toEqual([{ code: "A0-Black", qty: 3 }]);
  });
});
