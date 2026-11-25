import { describe, expect, it } from "vitest";
import { REPEAT_SCAN_WINDOW_MS, shouldDropRepeatScan } from "../scanDedupe";

describe("shouldDropRepeatScan", () => {
  const last = { value: "A1B2C3D4", at: 10_000 };

  it("keeps the first scan", () => {
    expect(shouldDropRepeatScan(null, "A1B2C3D4", 10_000)).toBe(false);
  });

  it("drops the same code sent again 8 ms later (8th key + Enter)", () => {
    expect(shouldDropRepeatScan(last, "A1B2C3D4", 10_008)).toBe(true);
  });

  it("drops the same code inside the window and keeps it after", () => {
    expect(shouldDropRepeatScan(last, "A1B2C3D4", 10_000 + REPEAT_SCAN_WINDOW_MS - 1)).toBe(true);
    expect(shouldDropRepeatScan(last, "A1B2C3D4", 10_000 + REPEAT_SCAN_WINDOW_MS)).toBe(false);
  });

  it("keeps a different code at once (switching worker, next order)", () => {
    expect(shouldDropRepeatScan(last, "B2C3D4E5", 10_005)).toBe(false);
  });

  it("does not drop when the clock went backwards", () => {
    expect(shouldDropRepeatScan(last, "A1B2C3D4", 9_000)).toBe(false);
  });
});
