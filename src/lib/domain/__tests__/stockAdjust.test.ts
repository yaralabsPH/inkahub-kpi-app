import { describe, expect, it } from "vitest";
import { onHandAfterAdjust } from "../stockAdjust";

describe("onHandAfterAdjust (adjustOnHand convention: positive delta removes)", () => {
  it("adds exactly onto negative stock (live case: −12 + 1 = −11)", () => {
    expect(onHandAfterAdjust(-12, -1)).toBe(-11);
  });
  it("removes exactly, including below zero", () => {
    expect(onHandAfterAdjust(5, 3)).toBe(2);
    expect(onHandAfterAdjust(1, 3)).toBe(-2);
    expect(onHandAfterAdjust(-4, 2)).toBe(-6);
  });
  it("a change and its undo always cancel", () => {
    for (const before of [-12, -1, 0, 1, 7]) {
      for (const d of [-5, -1, 1, 5]) {
        expect(onHandAfterAdjust(onHandAfterAdjust(before, d), -d)).toBe(before);
      }
    }
  });
  it("zero delta changes nothing", () => {
    expect(onHandAfterAdjust(-3, 0)).toBe(-3);
  });
});
