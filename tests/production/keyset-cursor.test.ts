/**
 * Task 17 review: the live order-completions log continues by a stable
 * DESCENDING (created_at, id) keyset inside one frozen since/cutoff window,
 * never by offset, so rows inserted or deleted earlier in the window cannot
 * cause duplicates or skips across "Load older" pages.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { olderThanFilter, quotePostgrestValue } from "../../src/lib/repository/supabase/keysetFilter";

describe("olderThanFilter: the PostgREST OR condition for the next older keyset page", () => {
  it("created_at < t OR (created_at = t AND id < i), with both values quoted", () => {
    expect(olderThanFilter({ createdAt: "2026-11-16T09:00:00.123456+00:00", id: "ev-1" }))
      .toBe('created_at.lt."2026-11-16T09:00:00.123456+00:00",and(created_at.eq."2026-11-16T09:00:00.123456+00:00",id.lt."ev-1")');
  });
  it("PostgREST-reserved characters in an id cannot change the filter (quoted, with \" and \\ escaped)", () => {
    expect(quotePostgrestValue('a,b)"c\\d')).toBe('"a,b)\\"c\\\\d"');
    const f = olderThanFilter({ createdAt: "2026-11-16T09:00:00+00:00", id: 'x),or(id.gt.0' });
    expect(f).toBe('created_at.lt."2026-11-16T09:00:00+00:00",and(created_at.eq."2026-11-16T09:00:00+00:00",id.lt."x),or(id.gt.0")');
  });
  it("refuses a missing cursor part (an empty value would filter nothing)", () => {
    expect(() => olderThanFilter({ createdAt: "", id: "a" })).toThrow(RangeError);
    expect(() => olderThanFilter({ createdAt: "2026-11-16T09:00:00Z", id: "" })).toThrow(RangeError);
  });
});

describe("LiveOrderCompletionsCard continues by keyset inside the frozen window, not by offset", () => {
  const src = readFileSync("src/components/LiveOrderCompletionsCard.tsx", "utf8");
  it("no offset continuation; every page is the first PAGE rows strictly older than the cursor", () => {
    expect(src).not.toMatch(/\.range\(offset/);
    expect(src).not.toMatch(/rows\.length\)/); // the next page is never addressed by the count of shown rows
    expect(src).toMatch(/\.or\(olderThanFilter\(cursor\)\)/);
    expect(src).toMatch(/\.range\(0, PAGE - 1\)/);
    expect(src).toMatch(/const PAGE = 500;/);
    expect(src).not.toMatch(/\.limit\(/);
  });
  it("the frozen window and total descending order are kept; the cursor is the last shown row", () => {
    expect(src).toMatch(/\.gte\("created_at", snap\.sinceIso\)/);
    expect(src).toMatch(/\.lte\("created_at", snap\.cutoffIso\)/);
    expect(src).toMatch(/\.order\("created_at", \{ ascending: false \}\)\s*\.order\("id", \{ ascending: false \}\)/);
    expect(src).toMatch(/cursor: last \? \{ createdAt: last\.created_at, id: last\.id \} : null/);
    expect(src).toMatch(/Load older/);
  });
});
