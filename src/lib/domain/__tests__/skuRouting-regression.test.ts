/**
 * Characterizes inventory/routing behavior so F1's KPI piece multiplier can
 * never leak into stock deduction or packaging. These are the values before
 * F1; they must not change when the reporting code moves to productionItems.
 */
import { describe, expect, it } from "vitest";
import {
  autoMailTubeForUnframedOrder,
  isLineMyDept,
  MAIL_TUBE_LARGE_PRODUCT_ID,
  MAIL_TUBE_SMALL_PRODUCT_ID,
  packageFromBarcode,
  routeShopifyLineToCatalogueLines,
  routeSkuToDepartment,
  shouldDeductAtDept,
} from "../skuRouting";
import { countProductionItems } from "../productionItems";

describe("stock decomposition is independent of KPI items", () => {
  it("kpi_multiplier_does_not_rededuct_components", () => {
    // Two units of a two-piece unframed set: four KPI items…
    expect(countProductionItems("INKA-S2BON0064-A1-UN", 2).items).toBe(4);
    // …and the catalogue still needs exactly four A1 unframed sheets, not eight.
    expect(routeShopifyLineToCatalogueLines("INKA-S2BON0064-A1-UN", 2)).toEqual({
      lines: [{ code: "A1-Unframed", qty: 4 }],
    });
  });

  it("keeps existing catalogue routes", () => {
    expect(routeShopifyLineToCatalogueLines("INKA-S3WIL0049-A2-FN", 2).lines).toEqual([{ code: "A2-Natural", qty: 6 }]);
    expect(routeShopifyLineToCatalogueLines("INKA-KAN0566-A4-FB", 3).lines).toEqual([{ code: "A4-Black", qty: 3 }]);
    expect(routeShopifyLineToCatalogueLines("INKA-PF0004-A0-PW", 2).lines).toEqual([{ code: "A0-White", qty: 2 }]);
    expect(routeShopifyLineToCatalogueLines("INKA-S6GAL0001-GW-FB", 1).lines).toEqual([
      { code: "A2-Black", qty: 4 },
      { code: "A3-Black", qty: 2 },
    ]);
    expect(routeShopifyLineToCatalogueLines("INKA-AUX-FP-ESP-A2", 1).lines).toEqual([{ code: "A2-Unframed", qty: 1 }]);
    expect(routeShopifyLineToCatalogueLines("INKA-AUX-HOOK", 2).lines).toEqual([{ code: "INKA-AUX-HOOK", qty: 2 }]);
    expect(routeShopifyLineToCatalogueLines("INKA-GC0001-100", 1).lines).toEqual([]);
    expect(routeShopifyLineToCatalogueLines("INKA-KAN0566-A2-SC", 1).lines).toEqual([]);
  });
});

describe("deduction stations are unchanged", () => {
  const cases: Array<[string, "a0_framed" | "framed" | "unframed" | "dispatch", "completed" | "dispatched", boolean]> = [
    ["INKA-S2BON0064-A1-UN", "unframed", "completed", true],
    ["INKA-S2BON0064-A1-UN", "dispatch", "dispatched", false],
    ["INKA-KAN0566-A0-FB", "a0_framed", "completed", true],
    ["INKA-KAN0566-A4-FB", "dispatch", "dispatched", true],
    ["INKA-KAN0566-A4-FB", "framed", "completed", false],
    ["INKA-PF0004-A0-PW", "dispatch", "dispatched", true],
    ["INKA-AUX-FP-ESP-A2", "unframed", "completed", true],
    ["INKA-AUX-HOOK", "a0_framed", "completed", true],
    ["INKA-AUX-HOOK", "dispatch", "dispatched", true],
    ["INKA-GC0001-100", "dispatch", "dispatched", false],
    ["INKA-KAN0566-A2-SC", "dispatch", "dispatched", false],
  ];
  it.each(cases)("%s at %s/%s → %s", (sku, dept, ev, expected) => {
    expect(shouldDeductAtDept(sku, dept, ev)).toBe(expected);
  });

  it("keeps department routing", () => {
    expect(routeSkuToDepartment("INKA-S2BON0064-A1-UN")).toBe("unframed");
    expect(routeSkuToDepartment("INKA-KAN0566-A0-FN")).toBe("a0_framed");
    expect(routeSkuToDepartment("INKA-KAN0566-A3-FW")).toBe("framed");
    expect(routeSkuToDepartment("INKA-PF0004-A0-PW")).toBeNull();
    expect(isLineMyDept("INKA-S2BON0064-A1-UN", "unframed")).toBe(true);
    expect(isLineMyDept("INKA-KAN0566-A0-FB", "framed")).toBe(false);
  });
});

describe("packaging selection is unchanged", () => {
  it("auto mail tube and package barcodes", () => {
    expect(autoMailTubeForUnframedOrder(["INKA-S2BON0064-A1-UN"])).toBe(MAIL_TUBE_SMALL_PRODUCT_ID);
    expect(autoMailTubeForUnframedOrder(["INKA-KAN0566-A0-UN"])).toBe(MAIL_TUBE_LARGE_PRODUCT_ID);
    expect(autoMailTubeForUnframedOrder(["INKA-KAN0566-A4-FB"])).toBeNull();
    expect(packageFromBarcode("+48=", "a0_framed")?.key).toBe("A0-Double");
    expect(packageFromBarcode("+48=", "dispatch")).toBeNull();
    expect(packageFromBarcode("+55=", "dispatch")?.key).toBe("A3-A4");
  });
});
