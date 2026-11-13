import { beforeEach, describe, expect, it } from "vitest";
import { prepareProductionEvidence } from "../productionCounts";
import { buildProductionWelcomeView, welcomeRange } from "../productionWelcomeView";
import { CASE_1, SKU, WORKER_A, WORKER_B, cancel, complete, dispatch, resetIds, snapshot, verify } from "../../../../tests/fixtures/item-counting";

// UK in January: local time = UTC. "Today" is production date 2026-01-15.
const AS_OF = "2026-01-15T12:00:00.000Z";
const at = (date: string, hhmm: string) => `${date}T${hhmm}:00.000Z`;
const RANGE = welcomeRange("uk", "2026-01-15");
const snap = (events: Parameters<typeof snapshot>[0]) =>
  prepareProductionEvidence({ ...snapshot(events, { startUtc: RANGE.startUtc, endUtcExclusive: RANGE.endUtcExclusive }), asOfUtc: AS_OF });

beforeEach(() => resetIds());

describe("welcomeRange", () => {
  it("covers today and the 8 production days before it at 04:00 site time", () => {
    expect(RANGE).toMatchObject({ firstDate: "2026-01-07", lastDate: "2026-01-15", startUtc: "2026-01-07T04:00:00.000Z", endUtcExclusive: "2026-01-16T04:00:00.000Z" });
    // AU in January is UTC+11: 04:00 local is 17:00Z the previous day, whatever the browser zone.
    expect(welcomeRange("au", "2026-01-15")).toMatchObject({ startUtc: "2026-01-06T17:00:00.000Z", endUtcExclusive: "2026-01-15T17:00:00.000Z" });
  });
});

describe("buildProductionWelcomeView", () => {
  it("today's department card: Items from verifications, Orders from completions, top worker", () => {
    const events = [
      verify({ department: "unframed", line_sku: SKU.unSet2, line_quantity: 2, created_at: at("2026-01-15", "09:00") }),
      complete({ department: "unframed", created_at: at("2026-01-15", "09:10") }),
      complete({ department: "unframed", created_at: at("2026-01-15", "09:20") }), // same order repeated
      verify({ department: "unframed", order_number: "2002", line_sku: SKU.unSingle, line_quantity: 1, created_at: at("2026-01-15", "10:00") }), // verification only
    ];
    const v = buildProductionWelcomeView(snap(events), "uk", AS_OF);
    expect(v.today).toBe("2026-01-15");
    expect(v.perDepartment.unframed).toMatchObject({ normal: { items: 5, orders: 1 }, topWorker: { staffId: WORKER_A, orders: 1, items: 5 }, streak: 1, vsLastWeek: null });
    expect(v.todayTotals.normal).toEqual({ items: 5, orders: 1 });
  });

  it("03:59 belongs to the previous production day", () => {
    const events = [
      verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: at("2026-01-15", "03:59") }),
      complete({ created_at: at("2026-01-15", "03:59") }),
    ];
    const v = buildProductionWelcomeView(snap(events), "uk", AS_OF);
    expect(v.todayTotals.normal).toEqual({ items: 0, orders: 0 });
    expect(v.teamTotalYesterday).toBe(1);
  });

  it("a cancellation today of yesterday's line lowers yesterday, never today", () => {
    const y = verify({ department: "framed", line_sku: SKU.framedSingle, line_quantity: 1, created_at: at("2026-01-14", "09:00") });
    const events = [y, cancel(y, { staff_id: WORKER_B, created_at: at("2026-01-15", "08:00") })];
    const v = buildProductionWelcomeView(snap(events), "uk", AS_OF);
    expect(v.perDepartment.framed.normal.items).toBe(0);
    expect(v.todayTotals.normal.items).toBe(0);
  });

  it("keeps late rework separate from normal output", () => {
    const events = [
      verify({ department: "framed", line_sku: SKU.framedSingle, line_quantity: 1, cs_case_id: CASE_1, created_at: at("2026-01-15", "11:00") }),
      complete({ department: "framed", cs_case_id: CASE_1, created_at: at("2026-01-15", "11:30") }),
    ];
    const v = buildProductionWelcomeView(snap(events), "uk", AS_OF);
    expect(v.perDepartment.framed).toMatchObject({ normal: { items: 0, orders: 0 }, rework: { items: 1, orders: 1 }, topWorker: null });
  });

  it("compares today with the same weekday last week", () => {
    const events = [
      complete({ order_number: "1", created_at: at("2026-01-15", "09:00") }),
      complete({ order_number: "2", created_at: at("2026-01-15", "09:30") }),
      complete({ order_number: "9", created_at: at("2026-01-08", "09:00") }),
      complete({ order_number: "8", created_at: at("2026-01-14", "09:00") }), // yesterday: not the comparison day
    ];
    const v = buildProductionWelcomeView(snap(events), "uk", AS_OF);
    expect(v.perDepartment.unframed.lastWeekDate).toBe("2026-01-08");
    expect(v.perDepartment.unframed.vsLastWeek).toBe(1);
  });

  it("counts a streak of consecutive days ending today with the same top worker", () => {
    const events = [
      dispatch({ order_number: "a", created_at: at("2026-01-15", "09:00") }),
      dispatch({ order_number: "b", created_at: at("2026-01-14", "09:00") }),
      dispatch({ order_number: "c", created_at: at("2026-01-13", "09:00") }),
      dispatch({ order_number: "d", staff_id: WORKER_B, created_at: at("2026-01-12", "09:00") }),
      dispatch({ order_number: "e", created_at: at("2026-01-11", "09:00") }),
    ];
    const v = buildProductionWelcomeView(snap(events), "uk", AS_OF);
    expect(v.perDepartment.dispatch).toMatchObject({ topWorker: { staffId: WORKER_A, orders: 1 }, streak: 3 });
  });

  it("most improved compares yesterday with the 7 days before it; sparkline ends yesterday", () => {
    const events = [
      complete({ order_number: "y1", created_at: at("2026-01-14", "09:00") }),
      complete({ order_number: "y2", created_at: at("2026-01-14", "09:10") }),
      complete({ order_number: "y3", created_at: at("2026-01-14", "09:20") }),
      complete({ order_number: "p1", created_at: at("2026-01-10", "09:00") }),
      complete({ order_number: "t1", created_at: at("2026-01-15", "09:00") }), // today: not in sparkline
      complete({ order_number: "b1", staff_id: WORKER_B, created_at: at("2026-01-14", "10:00") }), // no prior days
    ];
    const v = buildProductionWelcomeView(snap(events), "uk", AS_OF);
    expect(v.mostImproved).toEqual({ staffId: WORKER_A, yesterdayOrders: 3, avgBefore: 1, delta: 2 });
    expect(v.sparkline).toEqual([
      { day: "2026-01-08", orders: 0 },
      { day: "2026-01-09", orders: 0 },
      { day: "2026-01-10", orders: 1 },
      { day: "2026-01-11", orders: 0 },
      { day: "2026-01-12", orders: 0 },
      { day: "2026-01-13", orders: 0 },
      { day: "2026-01-14", orders: 4 },
    ]);
    expect(v.teamTotalYesterday).toBe(4);
  });
});
