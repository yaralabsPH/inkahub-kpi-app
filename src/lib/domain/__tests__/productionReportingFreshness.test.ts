import { describe, expect, it } from "vitest";
import { publishedCoverage, publishedFreshness } from "../productionReportingFreshness";

const V = "2026-11-16T10:00:00.000Z";
const at = (iso: string) => Date.parse(iso);

describe("Task 17: published freshness boundaries (from verified coverage)", () => {
  it("15 minutes: refresh due but still current", () => {
    expect(publishedFreshness(V, at("2026-11-16T10:15:00.000Z"))).toMatchObject({ state: "current", label: null, refreshOverdue: false, ageMinutes: 15, refreshDueUtc: "2026-11-16T10:15:00.000Z" });
    expect(publishedFreshness(V, at("2026-11-16T10:15:00.001Z"))).toMatchObject({ state: "current", refreshOverdue: true });
  });
  it("30 minutes: current at exactly 30, delayed just after", () => {
    expect(publishedFreshness(V, at("2026-11-16T10:30:00.000Z")).state).toBe("current");
    expect(publishedFreshness(V, at("2026-11-16T10:30:00.001Z"))).toMatchObject({ state: "delayed", label: "Update delayed" });
  });
  it("120 minutes: delayed at exactly 120, out of date just after", () => {
    expect(publishedFreshness(V, at("2026-11-16T12:00:00.000Z")).state).toBe("delayed");
    expect(publishedFreshness(V, at("2026-11-16T12:00:00.001Z"))).toMatchObject({ state: "outdated", label: "Report out of date" });
  });
  it("a quiet no-change verification resets the age (freshness follows verifiedAt, not the last event)", () => {
    expect(publishedFreshness("2026-11-16T11:55:00.000Z", at("2026-11-16T12:00:00.000Z")).state).toBe("current");
  });
  it("clock skew never yields a negative age; a bad instant is refused", () => {
    expect(publishedFreshness(V, at("2026-11-16T09:59:00.000Z")).ageMinutes).toBe(0);
    expect(() => publishedFreshness("nope", 0)).toThrow();
  });
});

describe("Task 17: current-day rollover with an older generation", () => {
  it("UK: a cutoff before 04:00 local covers the previous production date; after the rollover today is not covered", () => {
    // 2026-11-16 03:50 UTC is 03:50 London (GMT): production date 2026-11-15.
    const c = publishedCoverage("uk", "2026-11-16T03:50:00.000Z", at("2026-11-16T04:10:00.000Z"));
    expect(c).toEqual({ coveredThrough: "2026-11-15", today: "2026-11-16", coversToday: false });
  });
  it("a cutoff after the rollover covers today", () => {
    expect(publishedCoverage("uk", "2026-11-16T04:05:00.000Z", at("2026-11-16T04:10:00.000Z")).coversToday).toBe(true);
  });
  it("AU uses its own zone", () => {
    // 2026-11-15 17:30 UTC = 04:30 Sydney (AEDT, UTC+11) on 2026-11-16.
    expect(publishedCoverage("au", "2026-11-15T17:30:00.000Z", at("2026-11-15T17:40:00.000Z"))).toEqual({ coveredThrough: "2026-11-16", today: "2026-11-16", coversToday: true });
  });
});
