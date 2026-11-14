import { describe, expect, it } from "vitest";
import { loadOrderLookup } from "../orderLookup";
import { orderLookupCounts } from "../../../domain/productionReportView";

type Row = { id: string; location: string; order_number: string; created_at: string; [k: string]: unknown };

/** Minimal PostgREST stand-in: filters, exact count, server row cap, page overrides. */
function fakeClient(rows: Row[], opts: { maxRows?: number; page?: (from: number) => { data: unknown; error: unknown; count?: number | null } | null } = {}) {
  const calls: Array<Array<[string, unknown[]]>> = [];
  return {
    calls,
    from(table: string) {
      expect(table).toBe("production_events");
      const ops: Array<[string, unknown[]]> = [];
      calls.push(ops);
      let counted = false;
      const q: Record<string, unknown> = {};
      q.select = (_c: string, o?: { count?: string }) => { counted = o?.count === "exact"; return q; };
      for (const m of ["eq", "lte", "order"]) q[m] = (...a: unknown[]) => { ops.push([m, a]); return q; };
      q.range = (from: number, to: number) => {
        const hit = opts.page?.(from);
        if (hit) return Promise.resolve(hit);
        const matched = rows
          .filter((r) => ops.every(([m, a]) => (m === "eq" ? r[String(a[0])] === a[1] : m === "lte" ? String(r[String(a[0])]) <= String(a[1]) : true)))
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        const end = Math.min(to + 1, from + (opts.maxRows ?? 1000));
        return Promise.resolve({ data: matched.slice(from, end), error: null, count: counted ? matched.length : null });
      };
      return q;
    },
  };
}

const rows = (n: number, location = "uk"): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `e${String(i).padStart(4, "0")}`, location, order_number: "1001", staff_id: "s", department: "unframed",
    line_sku: "INKA-KAN0566-A4-UN", line_quantity: 1, event_type: "line_verified", created_at: `2026-01-15T09:${String(i % 60).padStart(2, "0")}:00.${String(i).padStart(3, "0").slice(-3)}Z`,
    parent_event_id: null, cs_case_id: null,
  }));
const REQ = { location: "uk", orderNumber: "1001", asOfUtc: "2026-01-16T00:00:00.000Z" };

describe("loadOrderLookup (review r1 M4)", () => {
  it("reads an order larger than the server row cap completely", async () => {
    const c = fakeClient(rows(700), { maxRows: 300 });
    const r = await loadOrderLookup(c, REQ);
    expect(r.complete).toBe(true);
    expect(r.events).toHaveLength(700);
    expect(c.calls).toHaveLength(3);
    expect(c.calls[0]).toContainEqual(["eq", ["location", "uk"]]);
    expect(c.calls[0]).toContainEqual(["lte", ["created_at", REQ.asOfUtc]]);
  });

  it("only reads the requested site and respects the cutoff", async () => {
    const all = [...rows(3, "uk"), ...rows(2, "au"), { ...rows(1)[0], id: "late", created_at: "2026-01-17T00:00:00.000Z" }];
    const r = await loadOrderLookup<Row>(fakeClient(all), REQ);
    expect(r.events.map((e) => e.location)).toEqual(["uk", "uk", "uk"]);
  });

  it.each([
    ["a count that changes", () => ({ data: [], error: null, count: 701 })],
    ["an empty page before the count", () => ({ data: [], error: null, count: 700 })],
    ["a body without rows", () => ({ data: null, error: null, count: 700 })],
  ])("marks the read incomplete on %s", async (_l, page) => {
    const r = await loadOrderLookup(fakeClient(rows(700), { maxRows: 300, page: (from) => (from >= 300 ? page() : null) }), REQ);
    expect(r.complete).toBe(false);
  });

  it("rejects on a read error", async () => {
    await expect(loadOrderLookup(fakeClient(rows(5), { page: () => ({ data: null, error: { message: "boom" } }) }), REQ)).rejects.toThrow("boom");
  });
});

describe("orderLookupCounts", () => {
  const ev = { id: "v1", staff_id: "s", department: "unframed", order_number: "1001", line_sku: "INKA-S2BON0064-A1-UN", line_quantity: 2, event_type: "line_verified", created_at: "2026-01-15T09:00:00.000Z", parent_event_id: null, cs_case_id: null };
  const read = { location: "uk", asOfUtc: "2026-01-16T00:00:00.000Z", complete: true, visibility: { kind: "site" as const } };
  it("counts a complete read by the shared rules", () => {
    expect(orderLookupCounts([ev], read)).toEqual({ normal: 4, rework: 0, incomplete: false });
  });
  it("never counts an incomplete read", () => {
    expect(orderLookupCounts([ev], { ...read, complete: false })).toBeNull();
  });
});
