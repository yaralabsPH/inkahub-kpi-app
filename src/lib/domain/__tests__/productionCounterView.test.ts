import { beforeEach, describe, expect, it } from "vitest";
import { prepareProductionEvidence } from "../productionCounts";
import { buildProductionCounterView, type CounterScope } from "../productionCounterView";
import { CASE_1, CASE_2, SKU, WORKER_A, WORKER_B, cancel, complete, dispatch, resetIds, snapshot, verify } from "../../../../tests/fixtures/item-counting";

// UK January: local = UTC; production day 2026-01-16 is [04:00Z, next 04:00Z).
const SCOPE: CounterScope = { site: "uk", date: "2026-01-16", staffId: WORKER_A, workType: "unframed" };
const at = (date: string, hhmm: string) => `${date}T${hhmm}:00.000Z`;
const view = (events: Parameters<typeof snapshot>[0], scope: CounterScope = SCOPE) =>
  buildProductionCounterView(prepareProductionEvidence(snapshot(events)), scope);

beforeEach(() => resetIds());

describe("buildProductionCounterView", () => {
  it("two UN S2 sets: 4 Items, then one Order after the saved completion", () => {
    const v = verify({ line_sku: SKU.unSet2, line_quantity: 2, created_at: at("2026-01-16", "09:00") });
    expect(view([v]).normal).toEqual({ items: 4, orders: 0 });
    const c = complete({ created_at: at("2026-01-16", "09:10") });
    expect(view([v, c]).normal).toEqual({ items: 4, orders: 1 });
  });

  it("refresh and reload give the same values; a repeated completion stays one Order", () => {
    const events = [
      verify({ line_sku: SKU.unSet2, line_quantity: 2, created_at: at("2026-01-16", "09:00") }),
      complete({ created_at: at("2026-01-16", "09:10") }),
      complete({ created_at: at("2026-01-16", "09:11") }),
    ];
    const first = view(events);
    const again = view([...events, ...events]); // duplicate retrieval
    expect(first.normal).toEqual({ items: 4, orders: 1 });
    expect(again.normal).toEqual(first.normal);
  });

  it("unverify removes the saved value; re-verify adds it back", () => {
    const v1 = verify({ line_sku: SKU.unSet2, line_quantity: 2, created_at: at("2026-01-16", "09:00") });
    const undo = cancel(v1, { created_at: at("2026-01-16", "09:01") });
    expect(view([v1, undo]).normal.items).toBe(0);
    const v2 = verify({ line_sku: SKU.unSet2, line_quantity: 2, created_at: at("2026-01-16", "09:02") });
    expect(view([v1, undo, v2]).normal.items).toBe(4);
  });

  it("undoing yesterday's line lowers yesterday and never makes today negative", () => {
    const y = verify({ line_sku: SKU.unSet2, line_quantity: 2, created_at: at("2026-01-15", "17:00") });
    const undo = cancel(y, { created_at: at("2026-01-16", "08:00") });
    expect(view([y, undo]).normal.items).toBe(0);
    expect(view([y, undo], { ...SCOPE, date: "2026-01-15" }).normal.items).toBe(0);
    expect(view([y], { ...SCOPE, date: "2026-01-15" }).normal.items).toBe(4);
  });

  it("only the active worker at this work type, never another worker's or station's credit", () => {
    const events = [
      verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: at("2026-01-16", "09:00") }),
      verify({ staff_id: WORKER_B, line_sku: SKU.unSingle, line_quantity: 5, created_at: at("2026-01-16", "09:00") }),
      verify({ department: "framed", line_sku: SKU.framedSingle, line_quantity: 3, created_at: at("2026-01-16", "09:00") }),
      dispatch({ created_at: at("2026-01-16", "10:00") }),
    ];
    expect(view(events).normal).toEqual({ items: 1, orders: 0 });
    expect(view(events, { ...SCOPE, staffId: WORKER_B }).normal.items).toBe(5);
    expect(view(events, { ...SCOPE, workType: "dispatch" }).normal.orders).toBe(1);
  });

  it("excluded lines add no Items; missing context keeps the Order with a coverage warning", () => {
    const events = [
      verify({ order_number: "x", line_sku: SKU.hook, line_quantity: 1, created_at: at("2026-01-16", "09:00") }),
      complete({ order_number: "x", created_at: at("2026-01-16", "09:05") }), // excluded only: no Order
      complete({ order_number: "y", created_at: at("2026-01-16", "09:06") }), // no line detail
    ];
    const v = view(events);
    expect(v.normal).toEqual({ items: 0, orders: 1 });
    expect(v.coverage.issueCounts.missing_completion_detail).toBe(1);
    expect(v.coverage.notes.excluded_only_completion).toBe(1);
  });

  it("keeps two CS cases separate from each other and from normal work", () => {
    const events = [
      verify({ line_sku: SKU.unSingle, line_quantity: 1, cs_case_id: CASE_1, created_at: at("2026-01-16", "09:00") }),
      complete({ cs_case_id: CASE_1, created_at: at("2026-01-16", "09:05") }),
      verify({ line_sku: SKU.unSingle, line_quantity: 1, cs_case_id: CASE_2, created_at: at("2026-01-16", "09:10") }),
      complete({ cs_case_id: CASE_2, created_at: at("2026-01-16", "09:15") }),
    ];
    const v = view(events);
    expect(v.normal).toEqual({ items: 0, orders: 0 });
    expect(v.rework).toEqual({ items: 2, orders: 2 });
  });

  it("03:59:59 is still the previous production day", () => {
    const events = [verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-16T03:59:59.000Z" })];
    expect(view(events).normal.items).toBe(0);
    expect(view(events, { ...SCOPE, date: "2026-01-15" }).normal.items).toBe(1);
  });
});
