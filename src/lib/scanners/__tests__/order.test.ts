import { describe, expect, it } from "vitest";
import { prepareFramingOrder, type OrderLookup, type PackagingSetup } from "../order";
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

  it("mixed A0 + regular: both work types, A0 components incl. accessories, and F4 packaging", () => {
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
      { code: "INKA-AUX-HOOK", qty: 2 },
    ]);
    expect(r.prepared.packaging).toMatchObject({
      ruleSetId: "rs-1",
      ruleSetVersion: 3,
      resolved: true,
      predicted: { "p-box": 2 },
      target: { "p-box": 2 },
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
    ["blank SKU", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 1 }, { sku: null, quantity: 1 }]), {}, "blank_sku"],
    ["legacy SKU", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 1 }, { sku: "A2 Black Frame", quantity: 1 }]), {}, "unknown_sku"],
    ["canvas", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 1 }, { sku: "INKA-ABC0001-A2-SC", quantity: 1 }]), {}, "canvas"],
    ["zero quantity", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 0 }]), {}, "invalid_quantity"],
    ["fractional quantity", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 1.5 }]), {}, "invalid_quantity"],
    ["huge quantity", order([{ sku: "INKA-ABC0001-A2-FB", quantity: 101 }]), {}, "invalid_quantity"],
    ["single gallery wall", order([{ sku: "INKA-ABC0001-GW-FB", quantity: 1 }]), {}, "unsupported_sku"],
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
      if (!r.ok) expect(r.message).toMatch(/classic station/);
    });
  }
});
