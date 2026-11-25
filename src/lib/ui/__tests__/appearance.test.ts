import { describe, expect, it } from "vitest";
import { environmentLabel, resolveTheme } from "../appearance";

describe("resolveTheme", () => {
  it("explicit light ignores the OS preference", () => {
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });
  it("explicit dark ignores the OS preference", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
  });
  it("system follows the OS preference", () => {
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
  });
});

describe("environmentLabel", () => {
  it("labels an explicit preview build Preview, in build and dev mode", () => {
    expect(environmentLabel("preview", false)).toBe("Preview");
    expect(environmentLabel("preview", true)).toBe("Preview");
    expect(environmentLabel("  Preview ", false)).toBe("Preview");
  });
  it("never labels production", () => {
    expect(environmentLabel("production", false)).toBeNull();
    expect(environmentLabel("production", true)).toBeNull();
  });
  it("labels explicit development Development", () => {
    expect(environmentLabel("development", false)).toBe("Development");
    expect(environmentLabel("development", true)).toBe("Development");
  });
  it("falls back to Development only on the dev server", () => {
    expect(environmentLabel(undefined, true)).toBe("Development");
    expect(environmentLabel(undefined, false)).toBeNull();
    expect(environmentLabel("", false)).toBeNull();
  });
  it("does not claim an environment for unknown values in a build", () => {
    expect(environmentLabel("staging", false)).toBeNull();
    expect(environmentLabel("qa", false)).toBeNull();
    expect(environmentLabel("staging", true)).toBe("Development");
  });
});
