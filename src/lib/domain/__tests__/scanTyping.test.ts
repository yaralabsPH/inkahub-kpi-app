import { describe, expect, it } from "vitest";
import { FAST_KEY_GAP_MS, looksLikeScanner, nextTrace, type TypingTrace } from "../scanTyping";

function type(times: number[]): TypingTrace | null {
  let t: TypingTrace | null = null;
  for (const at of times) t = nextTrace(t, 1, at);
  return t;
}

describe("scanTyping", () => {
  it("treats eight keys a few ms apart as a scanner", () => {
    const t = type([0, 5, 10, 15, 20, 25, 30, 35]);
    expect(looksLikeScanner(t)).toBe(true);
  });

  it("does not treat a person typing as a scanner", () => {
    const t = type([0, 180, 400, 560, 800, 950, 1100, 1300]);
    expect(looksLikeScanner(t)).toBe(false);
  });

  it("one slow gap in the middle makes it not a scanner", () => {
    const t = type([0, 5, 10, 15, 400, 405, 410, 415]);
    expect(looksLikeScanner(t)).toBe(false);
  });

  it("needs a minimum of characters", () => {
    expect(looksLikeScanner(type([0, 5, 10]))).toBe(false);
    expect(looksLikeScanner(type([0, 5, 10, 15]))).toBe(true);
  });

  it("a paste or one-event burst counts as fast", () => {
    const t = nextTrace(null, 8, 100);
    expect(looksLikeScanner(t)).toBe(true);
  });

  it("the limit is inclusive", () => {
    const t = type([0, FAST_KEY_GAP_MS, FAST_KEY_GAP_MS * 2, FAST_KEY_GAP_MS * 3]);
    expect(looksLikeScanner(t)).toBe(true);
  });

  it("ignores changes that add nothing (deleting)", () => {
    const t = nextTrace(null, 1, 0);
    expect(nextTrace(t, 0, 500)).toBe(t);
  });
});
