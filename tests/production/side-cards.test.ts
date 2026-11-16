/**
 * Task 17 side-card acceptance: no eager historical raw download on
 * Reports/Welcome mount or refresh, operational reads explicitly bounded and
 * complete, and no card silently presenting a truncated result.
 *
 *  - fetchAllRows (pageThrough) pages to a short page, rejects a page error,
 *    and THROWS at its safety cap instead of returning a partial array.
 *  - Source contracts (no DOM dependency): the two package history cards read
 *    only from an explicit Load handler; the three operational reads page
 *    completely with a stable order or label an incomplete snapshot.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchAllRows, PageThroughIncompleteError } from "../../src/lib/repository/supabase/pageThrough";

type Q = { data: number[] | null; error: unknown };
const source = (rows: number, failAt?: number) => {
  const calls: Array<[number, number]> = [];
  const build = (from: number, to: number): PromiseLike<Q> => {
    calls.push([from, to]);
    if (failAt !== undefined && from >= failAt) return Promise.resolve({ data: null, error: { message: "statement timeout" } });
    const out: number[] = [];
    for (let i = from; i <= to && i < rows; i++) out.push(i);
    return Promise.resolve({ data: out, error: null });
  };
  return { calls, build };
};

describe("fetchAllRows: complete or an explicit error, never a partial array", () => {
  it("pages until a short page and returns every row in order", async () => {
    const s = source(5);
    expect(await fetchAllRows(s.build, { pageSize: 2, maxPages: 10 })).toEqual([0, 1, 2, 3, 4]);
    expect(s.calls).toEqual([[0, 1], [2, 3], [4, 5]]);
  });
  it("an exact multiple of the page size ends at the following empty page", async () => {
    const s = source(4);
    expect(await fetchAllRows(s.build, { pageSize: 2, maxPages: 10 })).toEqual([0, 1, 2, 3]);
    expect(s.calls).toEqual([[0, 1], [2, 3], [4, 5]]);
  });
  it("a page error rejects (no partial rows) with the error's message", async () => {
    const s = source(10, 4);
    await expect(fetchAllRows(s.build, { pageSize: 2, maxPages: 10 })).rejects.toThrow("statement timeout");
  });
  it("a full final page at maxPages throws the explicit safety-cap error instead of returning a partial array", async () => {
    const s = source(1000);
    const r = fetchAllRows(s.build, { pageSize: 2, maxPages: 3 });
    await expect(r).rejects.toBeInstanceOf(PageThroughIncompleteError);
    await expect(fetchAllRows(source(1000).build, { pageSize: 2, maxPages: 3 })).rejects.toThrow(/safety cap of 3 pages/);
    expect(s.calls).toHaveLength(3); // bounded: never more than maxPages requests
    // exactly maxPages full pages is still ambiguous (more may exist): refused, not returned
    await expect(fetchAllRows(source(6).build, { pageSize: 2, maxPages: 3 })).rejects.toBeInstanceOf(PageThroughIncompleteError);
    // one row fewer: the last page is short, so the result is complete
    expect(await fetchAllRows(source(5).build, { pageSize: 2, maxPages: 3 })).toEqual([0, 1, 2, 3, 4]);
  });
  it("pageSize and maxPages must be positive integers", async () => {
    for (const opts of [{ pageSize: 0 }, { pageSize: -1 }, { pageSize: 1.5 }, { maxPages: 0 }, { maxPages: Number.NaN }, { pageSize: Number.POSITIVE_INFINITY }]) {
      await expect(fetchAllRows(source(1).build, opts)).rejects.toThrow(RangeError);
    }
  });
});

const read = (p: string) => readFileSync(p, "utf8");
/** Every `useEffect(...)` callback body in a source file. */
function effects(src: string): string[] {
  const out: string[] = [];
  let i = src.indexOf("useEffect(");
  while (i >= 0) {
    let depth = 0;
    let j = i + "useEffect".length;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) break;
    }
    out.push(src.slice(i, j + 1));
    i = src.indexOf("useEffect(", j);
  }
  return out;
}
const HISTORY_READ = /\.from\("(ledger|production_events)"\)|fetchAllRows/;

describe("history side cards are click-only (no mount/refresh download)", () => {
  for (const file of ["src/components/PackageUsageCard.tsx", "src/components/PackageHistoryCard.tsx"]) {
    it(`${file}: no effect reads history; an explicit Load handler pages it completely with a stable order`, () => {
      const src = read(file);
      for (const e of effects(src)) expect([file, HISTORY_READ.test(e)]).toEqual([file, false]);
      expect(src).toMatch(/onClick=\{\(\) => void load\(\)\}/);
      expect(src).toMatch(/Load/);
      expect(src).toMatch(/fetchAllRows/);
      // every paged history read has a total order (ts/created_at, then id)
      for (const m of src.matchAll(/\.from\("(ledger|production_events)"\)[\s\S]*?\.range\(from, to\)/g)) {
        expect([file, m[1], /\.order\("(ts|created_at)"[^)]*\)\s*\.order\("id"/.test(m[0])]).toEqual([file, m[1], true]);
      }
      // a change of site/range/filter/period clears old rows back to the unloaded state
      expect(src).toMatch(/setRows\(null\)/);
    });
  }
});

describe("operational reads cannot silently truncate", () => {
  it("DailyTimesheetCard pages production_events completely (created_at, id) before computing the file", () => {
    const src = read("src/components/DailyTimesheetCard.tsx");
    const m = src.match(/fetchAllRows<[^>]*>\(\(from, to\) =>[\s\S]*?\.from\("production_events"\)[\s\S]*?\.range\(from, to\)/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/\.order\("created_at", \{ ascending: true \}\)\s*\.order\("id", \{ ascending: true \}\)/);
    expect(src.match(/\.from\("production_events"\)/g)).toHaveLength(1); // no other, unpaged read
  });
  it("CurrentlyClockedInCard keeps the 16-hour window and 30-second refresh, paging clock events completely (created_at, id)", () => {
    const src = read("src/components/CurrentlyClockedInCard.tsx");
    expect(src).toMatch(/16 \* 3600 \* 1000/);
    expect(src).toMatch(/30_000/);
    const m = src.match(/fetchAllRows<[^>]*>\(\(from, to\) =>[\s\S]*?\.from\("production_events"\)[\s\S]*?\.range\(from, to\)/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/\.order\("created_at", \{ ascending: true \}\)\s*\.order\("id", \{ ascending: true \}\)/);
    expect(src.match(/\.from\("production_events"\)/g)).toHaveLength(1);
  });
  it("LiveOrderCompletionsCard has no silent .limit: bounded pages under a frozen cutoff, Load older, never labelled complete while more may exist", () => {
    const src = read("src/components/LiveOrderCompletionsCard.tsx");
    expect(src).not.toMatch(/\.limit\(/);
    expect(src).toMatch(/7 \* 24 \* 3600 \* 1000/); // the 7-day meaning
    expect(src).toMatch(/\.lte\("created_at", snap\.cutoffIso\)/); // one frozen snapshot
    expect(src).toMatch(/\.order\("created_at", \{ ascending: false \}\)\s*\.order\("id", \{ ascending: false \}\)/);
    expect(src).toMatch(/\.range\(0, PAGE - 1\)/); // each page: the first PAGE rows older than the keyset cursor
    expect(src).not.toMatch(/\.range\(offset/);
    expect(src).toMatch(/Load older/);
    expect(src).toMatch(/more: page\.length === PAGE/); // a full page may have more: never "complete"
  });
});

describe("Reports/Welcome published mount and refresh start no raw historical side-card read", () => {
  it("no effect in Reports or Welcome reads production_events or the ledger", () => {
    for (const file of ["src/pages/Reports.tsx", "src/pages/Welcome.tsx"]) {
      for (const e of effects(read(file))) expect([file, HISTORY_READ.test(e)]).toEqual([file, false]);
    }
  });
});
