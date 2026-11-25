import { describe, expect, it } from "vitest";
import { missingStockCodes, missingStockMessage } from "../deductResult";

describe("deduct_inventory_for_event result", () => {
  it("lists the missing codes once each", () => {
    expect(missingStockCodes({ status: "ok", missing_codes: ["A4-Natural", "A4-Natural", " A2-Black "] })).toEqual(["A4-Natural", "A2-Black"]);
  });

  it("is quiet when nothing is missing or the shape is unknown", () => {
    expect(missingStockCodes({ status: "ok", missing_codes: [] })).toEqual([]);
    expect(missingStockCodes(null)).toEqual([]);
    expect(missingStockCodes("ok")).toEqual([]);
    expect(missingStockCodes({ missing_codes: "A4-Natural" })).toEqual([]);
    expect(missingStockMessage({ status: "skipped_cs_case" })).toBeNull();
  });

  it("ignores blank and non-string entries", () => {
    expect(missingStockCodes({ missing_codes: ["", 4, null, "A3-Natural"] })).toEqual(["A3-Natural"]);
  });

  it("writes a plain message for staff", () => {
    const msg = missingStockMessage({ missing_codes: ["A4-Natural"] });
    expect(msg).toContain("stock was NOT taken off for: A4-Natural");
    expect(msg).toContain("Tell a manager");
  });
});
