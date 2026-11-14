import { describe, expect, it } from "vitest";
import { classifyProductionSku, countProductionItems } from "../productionItems";

describe("countProductionItems — spec A table", () => {
  const table: Array<[string, unknown, number, string]> = [
    ["INKA-S2BON0064-A1-UN", 2, 4, "counted"],
    ["INKA-S3WIL0049-A2-FN", 2, 6, "counted"],
    ["INKA-KAN0566-A4-FB", 3, 3, "counted"],
    ["INKA-KAN0566-A4-UN", 3, 3, "counted"],
    ["INKA-PF0004-A0-PW", 2, 2, "counted"],
    ["INKA-S6GAL0001-GW-FB", 1, 6, "counted"],
    ["INKA-S6GAL0001-GW-UN", 1, 6, "counted"],
  ];
  it.each(table)("%s × %s = %s items", (sku, qty, items, status) => {
    const r = countProductionItems(sku, qty);
    expect(r.status).toBe(status);
    expect(r.items).toBe(items);
  });

  it("unframed_two_sets_are_four", () => {
    const r = countProductionItems("INKA-S2BON0064-A1-UN", 2);
    expect(r).toMatchObject({ status: "counted", items: 4 });
  });

  it("frame_is_one_item", () => {
    for (const v of ["FB", "FW", "FN"]) {
      expect(countProductionItems(`INKA-KAN0566-A3-${v}`, 1).items).toBe(1);
    }
    for (const v of ["PB", "PW", "PN"]) {
      expect(countProductionItems(`INKA-PF0004-A3-${v}`, 1)).toMatchObject({ status: "counted", items: 1 });
    }
  });

  it("counts every supported set size 2–9", () => {
    for (let n = 2; n <= 9; n++) {
      expect(countProductionItems(`INKA-S${n}WIL0049-A2-FW`, 3).items).toBe(3 * n);
    }
  });

  it("s0_s1_s10_are_unclassified", () => {
    for (const sku of ["INKA-S0WIL0049-A2-FN", "INKA-S1WIL0049-A2-FN", "INKA-S10WIL0049-A2-FN"]) {
      const r = countProductionItems(sku, 1);
      expect(r.status).toBe("unclassified");
      expect(r.items).toBe(0);
      expect(r.issues).toContain("invalid_set_count");
    }
  });
});

describe("exclusions", () => {
  const excluded: Array<[string, string]> = [
    ["INKA-GC0001-100", "gift_card"],
    ["INKA-AUXESP", "free_print"],
    ["INKA-AUX-FP-ESP-A2", "free_print"],
    ["INKA-AUX-HOOK", "accessory"],
    ["A0-Double", "packaging"],
    ["A3-A4", "packaging"],
    ["sku-xniriygn", "packaging"],
    ["INKA-KAN0566-A2-SC", "canvas"],
    ["INKA-S3WIL0049-A2-SC", "canvas"],
  ];
  it.each(excluded)("%s is excluded as %s", (sku, reason) => {
    const r = countProductionItems(sku, 4);
    expect(r).toMatchObject({ status: "excluded", items: 0 });
    expect(classifyProductionSku(sku)).toMatchObject({ kind: "excluded", reason });
  });

  it("unknown packaging-like strings stay unclassified, not excluded", () => {
    expect(classifyProductionSku("A9-Triple").kind).toBe("unclassified");
    expect(classifyProductionSku("BOX-LARGE").kind).toBe("unclassified");
  });
});

describe("unclassified SKUs", () => {
  const cases: Array<[unknown, string]> = [
    [null, "missing_sku"],
    [undefined, "missing_sku"],
    ["", "missing_sku"],
    ["   ", "missing_sku"],
    [42, "missing_sku"],
    ["A4 21x30 cm / Framed Print (Black)", "unrecognized_sku"],
    ["INKA-KAN0566-A5-FB", "unrecognized_sku"],
    ["INKA-KAN0566-A4-ZZ", "unrecognized_sku"],
    ["INKA-KAN0566-GW-FB", "unsupported_size"],
    ["INKA-PF0004-GW-PB", "unsupported_size"],
  ];
  it.each(cases)("%s → %s", (sku, reason) => {
    const r = countProductionItems(sku, 1);
    expect(r.status).toBe("unclassified");
    expect(r.items).toBe(0);
    expect(r.issues).toContain(reason);
  });
});

describe("normalization", () => {
  it("normalizes case and surrounding whitespace", () => {
    expect(countProductionItems("  inka-s2bon0064-a1-un \n", 2)).toMatchObject({ status: "counted", items: 4 });
    expect(classifyProductionSku(" inka-auxesp ")).toMatchObject({ kind: "excluded", reason: "free_print" });
    expect(classifyProductionSku(" a0-double ")).toMatchObject({ kind: "excluded", reason: "packaging" });
  });
});

describe("quantities", () => {
  it("zero is valid and contributes zero", () => {
    expect(countProductionItems("INKA-S3WIL0049-A2-FN", 0)).toMatchObject({ status: "counted", items: 0 });
  });

  it("invalid_quantity_is_not_defaulted", () => {
    const bad: Array<[unknown, string]> = [
      [null, "missing_quantity"],
      [undefined, "missing_quantity"],
      [-1, "negative_quantity"],
      [1.5, "non_integer_quantity"],
      [Number.NaN, "non_integer_quantity"],
      [Number.POSITIVE_INFINITY, "unsafe_quantity"],
      [Number.NEGATIVE_INFINITY, "unsafe_quantity"],
      [Number.MAX_SAFE_INTEGER + 1, "unsafe_quantity"],
      ["2", "non_integer_quantity"],
      [true, "non_integer_quantity"],
    ];
    for (const [q, issue] of bad) {
      const r = countProductionItems("INKA-KAN0566-A4-FB", q);
      expect(r.status, String(q)).toBe("unclassified");
      expect(r.items).toBe(0);
      expect(r.issues).toEqual([issue]);
      // Product classification survives so the line can still qualify an order.
      expect(r.product).toMatchObject({ kind: "eligible", pieces: 1 });
    }
  });

  it("invalid quantity on an excluded product is flagged, product stays excluded", () => {
    const r = countProductionItems("INKA-AUX-HOOK", null);
    expect(r.status).toBe("unclassified");
    expect(r.issues).toEqual(["missing_quantity"]);
    expect(r.product.kind).toBe("excluded");
  });

  it("detects multiplication overflow", () => {
    const q = Math.floor(Number.MAX_SAFE_INTEGER / 2);
    const r = countProductionItems("INKA-S3WIL0049-A2-FN", q);
    expect(r.status).toBe("unclassified");
    expect(r.issues).toEqual(["item_overflow"]);
    expect(countProductionItems("INKA-KAN0566-A4-FB", Number.MAX_SAFE_INTEGER).items).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("reports both SKU and quantity issues together", () => {
    expect(countProductionItems(null, null).issues).toEqual(["missing_sku", "missing_quantity"]);
  });
});
