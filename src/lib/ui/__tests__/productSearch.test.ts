import { describe, expect, it } from "vitest";
import { ProductSchema, shortCode, type Product } from "@/lib/domain";
import { filterProductsForPicker } from "../productSearch";

const p = (id: string, code: string, extra: Partial<Product> = {}): Product =>
  ProductSchema.parse({ id, code, supplier: "S", size: "A2", colour: "Natural", pallet_capacity_units: 0, bay_capacity_pallets: 0, lead_time_days: 28, current_on_hand: 0, ...extra });

const list = [p("1", "A2-Natural"), p("2", "A2-Black"), p("3", "A4-White"), p("4", "A2-Natural", { size: "A2", colour: "Natural" })];

describe("filterProductsForPicker", () => {
  it("an empty or blank query returns every product in the input order", () => {
    expect(filterProductsForPicker(list, "").map((x) => x.id)).toEqual(["1", "2", "3", "4"]);
    expect(filterProductsForPicker(list, "   ").map((x) => x.id)).toEqual(["1", "2", "3", "4"]);
  });
  it("matches the code case-insensitively, trimmed, keeping order", () => {
    expect(filterProductsForPicker(list, "  a2-n ").map((x) => x.id)).toEqual(["1", "4"]);
    expect(filterProductsForPicker(list, "BLACK").map((x) => x.id)).toEqual(["2"]);
  });
  it("matches the short code", () => {
    const sc = shortCode(list[2]);
    expect(filterProductsForPicker(list, sc.toLowerCase()).map((x) => x.id)).toContain("3");
  });
  it("returns nothing for no match", () => {
    expect(filterProductsForPicker(list, "zzz")).toEqual([]);
  });
  it("keeps products with duplicate labels as separate entries", () => {
    expect(filterProductsForPicker(list, "a2-natural").map((x) => x.id)).toEqual(["1", "4"]);
  });
  it("never mutates its input and returns a new array", () => {
    const before = JSON.stringify(list);
    const out = filterProductsForPicker(list, "");
    expect(out).not.toBe(list);
    expect(JSON.stringify(list)).toBe(before);
  });
});
