import { describe, expect, it } from "vitest";
import { productionRange } from "../../src/lib/domain/productionPeriods";
import { assertStagingSupabaseUrl, MEASURE_CASES, median, rebuildResponse, STAGING_CUTOFF, withJsonParseTimer } from "./measure-item-counting";

describe("withJsonParseTimer", () => {
  it("delegates exactly once per call, returns the same values and restores JSON.parse", async () => {
    const original = JSON.parse;
    const text = JSON.stringify({ rows: [[1, "a", null]], ok: true });
    const { value, parseCalls, parseMs } = await withJsonParseTimer(async () => {
      const a = JSON.parse(text);
      const b = JSON.parse("[1,2]", (_k, v) => (typeof v === "number" ? v * 10 : v));
      return [a, b];
    });
    expect(value).toEqual([{ rows: [[1, "a", null]], ok: true }, [10, 20]]);
    expect(parseCalls).toBe(2);
    expect(parseMs).toBeGreaterThanOrEqual(0);
    expect(JSON.parse).toBe(original);
  });

  it("restores JSON.parse even when the work throws, and rethrows parse errors unchanged", async () => {
    const original = JSON.parse;
    await expect(withJsonParseTimer(async () => JSON.parse("{bad"))).rejects.toBeInstanceOf(SyntaxError);
    expect(JSON.parse).toBe(original);
  });
});

describe("measurement setup", () => {
  it("median of paired totals uses the middle value (or the mean of the two middle values)", () => {
    expect(median([900, 300, 600])).toBe(600);
    expect(median([1, 4, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("the six cases keep the plan's workload, targets and scope names", () => {
    expect(MEASURE_CASES.map((c) => [c.scope, c.site, c.first, c.last, c.targetMs])).toEqual([
      ["au-busy-day", "au", "2026-09-15", "2026-09-15", 2000],
      ["au-3-months", "au", "2026-08-01", "2026-10-31", 10000],
      ["uk-day", "uk", "2026-03-29", "2026-03-29", 2000],
      ["uk-3-months", "uk", "2026-08-01", "2026-10-31", 10000],
      ["us-day", "us", "2026-03-08", "2026-03-08", 2000],
      ["us-3-months", "us", "2026-08-01", "2026-10-31", 10000],
    ]);
    expect(productionRange("au", "2026-08-01", "2026-10-31")).toMatchObject({
      startUtc: "2026-07-31T18:00:00.000Z", endUtcExclusive: "2026-10-31T17:00:00.000Z",
    });
    expect(Date.parse(STAGING_CUTOFF)).toBeGreaterThan(Date.parse("2026-10-31T17:00:00.000Z"));
  });

  it("refuses any Supabase URL that is not the staging project", () => {
    expect(() => assertStagingSupabaseUrl("https://ybrzhrgfrnvtcwymjdrq.supabase.co")).not.toThrow();
    expect(() => assertStagingSupabaseUrl("https://lkboboagiikvozvbcpvg.supabase.co")).toThrow(/Refusing/);
    expect(() => assertStagingSupabaseUrl("https://evil.example/ybrzhrgfrnvtcwymjdrq.")).toThrow(/Refusing/);
  });
});

describe("rebuildResponse", () => {
  it("rebuilds a 204 (sign-out) response without a body", async () => {
    const copy = rebuildResponse(new Response(null, { status: 204 }), new ArrayBuffer(0));
    expect(copy.status).toBe(204);
    expect(copy.body).toBeNull();
  });

  it("keeps the decoded body and drops wire encoding and length", async () => {
    const res = new Response("{}", { status: 200, headers: { "content-encoding": "gzip", "content-length": "99", "x-a": "1" } });
    const copy = rebuildResponse(res, new TextEncoder().encode('{"ok":1}').buffer);
    expect(await copy.json()).toEqual({ ok: 1 });
    expect(copy.headers.get("content-encoding")).toBeNull();
    expect(copy.headers.get("content-length")).not.toBe("99");
    expect(copy.headers.get("x-a")).toBe("1");
  });
});
