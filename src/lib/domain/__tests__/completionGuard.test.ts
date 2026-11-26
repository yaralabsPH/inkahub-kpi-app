import { describe, expect, it } from "vitest";
import {
  REPEAT_COMPLETE_WINDOW_MS,
  beginCompletion,
  completionKey,
  createCompletionGuard,
  endCompletion,
} from "../completionGuard";

const A = completionKey("au", "dispatch", "10252935");
const B = completionKey("au", "dispatch", "10252936");

describe("completion guard (double-tap Dispatch / Complete)", () => {
  it("lets the first tap through", () => {
    const g = createCompletionGuard();
    expect(beginCompletion(g, A, 1_000)).toBe(true);
  });

  it("drops a second tap while the first is still saving (live order 10252935, 2026-11-26)", () => {
    const g = createCompletionGuard();
    expect(beginCompletion(g, A, 1_000)).toBe(true);
    expect(beginCompletion(g, A, 1_450)).toBe(false);
    // any order: one save at a time per station
    expect(beginCompletion(g, B, 1_450)).toBe(false);
  });

  it("drops a repeat of the same order just after it saved (order still on screen)", () => {
    const g = createCompletionGuard();
    beginCompletion(g, A, 1_000);
    endCompletion(g, A, true, 1_300);
    expect(beginCompletion(g, A, 1_700)).toBe(false);
    expect(beginCompletion(g, A, 1_300 + REPEAT_COMPLETE_WINDOW_MS - 1)).toBe(false);
  });

  it("allows the same order again after the window (a deliberate redo)", () => {
    const g = createCompletionGuard();
    beginCompletion(g, A, 1_000);
    endCompletion(g, A, true, 1_300);
    expect(beginCompletion(g, A, 1_300 + REPEAT_COMPLETE_WINDOW_MS)).toBe(true);
  });

  it("allows the next order straight after a save", () => {
    const g = createCompletionGuard();
    beginCompletion(g, A, 1_000);
    endCompletion(g, A, true, 1_300);
    expect(beginCompletion(g, B, 1_400)).toBe(true);
  });

  it("allows a retry right away when the save failed", () => {
    const g = createCompletionGuard();
    beginCompletion(g, A, 1_000);
    endCompletion(g, A, false, 1_300);
    expect(beginCompletion(g, A, 1_400)).toBe(true);
  });

  it("does not block the same order number at another site or department", () => {
    const g = createCompletionGuard();
    beginCompletion(g, A, 1_000);
    endCompletion(g, A, true, 1_300);
    expect(beginCompletion(g, completionKey("au", "framing", "10252935"), 1_400)).toBe(true);
  });

  it("treats a clock that went backwards as outside the window", () => {
    const g = createCompletionGuard();
    beginCompletion(g, A, 5_000);
    endCompletion(g, A, true, 5_000);
    expect(beginCompletion(g, A, 4_000)).toBe(true);
  });

  it("ignores an end call for an order that is not the one in flight", () => {
    const g = createCompletionGuard();
    beginCompletion(g, A, 1_000);
    endCompletion(g, B, true, 1_100);
    expect(beginCompletion(g, A, 1_200)).toBe(false);
  });
});
