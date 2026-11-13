import { beforeEach, describe, expect, it } from "vitest";
import { prepareProductionEvidence } from "../productionCounts";
import { productionRange } from "../productionPeriods";
import { frameTimingLines, frameTimingTotals, frameTimingWeight, isFrameTimingSku, isTimingStreamSku } from "../productionFrameTiming";
import { buildProductionReportView } from "../productionReportView";
import { CASE_1, SKU, WORKER_A, WORKER_B, cancel, complete, dispatch, resetIds, snapshot, verify } from "../../../../tests/fixtures/item-counting";

const BOTH = productionRange("uk", "2026-01-15", "2026-01-16");
const DAY1 = productionRange("uk", "2026-01-15", "2026-01-15");
const at = (hhmm: string, day = "15") => `2026-01-${day}T${hhmm}:00.000Z`;

beforeEach(() => resetIds());

describe("frame timing (characterizes the pre-F1 Reports stream)", () => {
  it("keeps the frame/UN/legacy predicates and weighting", () => {
    expect(isFrameTimingSku(SKU.framedSingle)).toBe(true);
    expect(isFrameTimingSku(SKU.frameOnly)).toBe(true);
    expect(isFrameTimingSku(SKU.unSet2)).toBe(false);
    expect(isTimingStreamSku(SKU.unSet2)).toBe(true);
    expect(isTimingStreamSku(SKU.legacy)).toBe(true);
    expect(isTimingStreamSku(SKU.hook)).toBe(false);
    // Pre-F1 behaviour: parseSku does not read INKA-AUXESP, so it fails open as a legacy title (zero weight).
    expect(isTimingStreamSku(SKU.freePrint)).toBe(true);
    expect(frameTimingWeight(SKU.freePrint, 1)).toBe(0);
    expect(isTimingStreamSku(SKU.giftCard)).toBe(false);
    expect(frameTimingWeight(SKU.fnSet3, 2)).toBe(6);
    expect(frameTimingWeight(SKU.framedSingle, null)).toBe(1);
    expect(frameTimingWeight(SKU.unSet2, 2)).toBe(0);
  });

  it("times positive gaps up to 30 minutes by the same worker, weighted by frame units", () => {
    const events = [
      verify({ department: "framed", line_sku: SKU.framedSingle, line_quantity: 1, created_at: at("09:00") }),
      verify({ department: "framed", line_sku: SKU.fnSet3, line_quantity: 1, created_at: at("09:12") }), // 12 min, weight 3
      verify({ department: "framed", line_sku: SKU.framedSingle, line_quantity: 1, created_at: at("09:50") }), // 38 min: not timed
      verify({ department: "framed", staff_id: WORKER_B, line_sku: SKU.framedSingle, line_quantity: 1, created_at: at("09:55") }), // B's first
    ];
    const lines = frameTimingLines(prepareProductionEvidence(snapshot(events)), { range: BOTH });
    expect(lines.map((l) => l.durationMin)).toEqual([0, 12, 0, 0]);
    expect(frameTimingTotals(lines)).toEqual({ durationMin: 12, timedWeight: 3, avgMinPerUnit: 4 });
  });

  it("an intervening UN line is a zero-weight predecessor, as before F1, and never enters the denominator", () => {
    const events = [
      verify({ department: "framed", line_sku: SKU.framedSingle, line_quantity: 1, created_at: at("09:00") }),
      verify({ department: "framed", line_sku: SKU.unSet2, line_quantity: 2, created_at: at("09:05") }),
      verify({ department: "framed", line_sku: SKU.framedSingle, line_quantity: 1, created_at: at("09:15") }),
    ];
    const lines = frameTimingLines(prepareProductionEvidence(snapshot(events)), { range: BOTH });
    expect(lines.map((l) => [l.weight, l.durationMin])).toEqual([[1, 0], [0, 0], [1, 10]]);
    expect(frameTimingTotals(lines)).toEqual({ durationMin: 10, timedWeight: 1, avgMinPerUnit: 10 });
  });

  it("drops lines cancelled through the shared parent resolution", () => {
    const first = verify({ department: "framed", line_sku: SKU.framedSingle, line_quantity: 1, created_at: at("09:00") });
    const second = verify({ department: "framed", line_sku: SKU.framedSingle, line_quantity: 1, created_at: at("09:10") });
    const events = [first, second, cancel(second, { staff_id: WORKER_B, created_at: at("09:11") })];
    const lines = frameTimingLines(prepareProductionEvidence(snapshot(events)), { range: BOTH });
    expect(lines.map((l) => l.eventId)).toEqual([first.id]);
  });
});

describe("buildProductionReportView", () => {
  it("two UN S2 sets: 4 Items, raw quantity 2 kept for export, no timing denominator", () => {
    const v = verify({ line_sku: SKU.unSet2, line_quantity: 2, created_at: at("09:00") });
    const c = complete({ created_at: at("09:30") });
    const view = buildProductionReportView(prepareProductionEvidence(snapshot([v, c])), { range: BOTH });
    expect(view.summary.normal).toMatchObject({ items: 4, orders: 1 });
    expect(view.exportEvents.map((e) => [e.id, e.line_quantity])).toEqual([[v.id, 2], [c.id, 99]]);
    expect(view.timing).toEqual({ durationMin: 0, timedWeight: 0, avgMinPerUnit: 0 });
    expect(view.skuBoard).toEqual([]);
  });

  it("a cancellation by B removes A's Items, also when only A is selected", () => {
    const v = verify({ department: "framed", line_sku: SKU.fnSet3, line_quantity: 1, created_at: at("09:00") });
    const keep = verify({ department: "framed", line_sku: SKU.framedSingle, line_quantity: 1, created_at: at("09:05") });
    const events = [v, keep, cancel(v, { staff_id: WORKER_B, created_at: at("10:00") })];
    const view = buildProductionReportView(prepareProductionEvidence(snapshot(events)), { range: BOTH, staffId: WORKER_A });
    expect(view.summary.normal.items).toBe(1);
    expect(view.personTotals?.normal.items).toBe(1);
    expect(view.staffOrders.map((o) => [o.orderNumber, o.verifiedLines, o.items])).toEqual([["1001", 1, 1]]);
  });

  it("keeps rework separate from normal output", () => {
    const events = [
      verify({ department: "framed", line_sku: SKU.framedSingle, line_quantity: 1, created_at: at("09:00") }),
      complete({ department: "framed", created_at: at("09:10") }),
      verify({ department: "framed", line_sku: SKU.framedSingle, line_quantity: 2, cs_case_id: CASE_1, created_at: at("11:00") }),
      complete({ department: "framed", cs_case_id: CASE_1, created_at: at("11:10") }),
    ];
    const view = buildProductionReportView(prepareProductionEvidence(snapshot(events)), { range: BOTH });
    expect(view.summary.normal).toMatchObject({ items: 1, orders: 1 });
    expect(view.summary.rework).toMatchObject({ items: 2, orders: 1 });
    expect(view.leaderboard[0]).toMatchObject({ normal: { items: 1, orders: 1 }, rework: { items: 2, orders: 1 } });
  });

  it("the range union counts an order completed on both days once; days still show one each", () => {
    const events = [
      verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: at("09:00") }),
      complete({ created_at: at("09:10") }),
      complete({ created_at: at("09:10", "16") }),
    ];
    const view = buildProductionReportView(prepareProductionEvidence(snapshot(events)), { range: BOTH, staffId: WORKER_A });
    expect(view.summary.normal.orders).toBe(1);
    expect(view.personDaily?.map((d) => d.normal.orders)).toEqual([1, 1]);
    expect(view.personTotals?.normal.orders).toBe(1);
    expect(view.leaderboard[0].daysWorked).toBe(2);
  });

  it("the leaderboard keeps every visible person, including completion-only and verification-only people", () => {
    const events = [
      verify({ department: "dispatch", line_sku: SKU.framedSingle, line_quantity: 1, created_at: at("09:00") }),
      dispatch({ staff_id: WORKER_B, created_at: at("09:30") }),
    ];
    const view = buildProductionReportView(prepareProductionEvidence(snapshot(events)), { range: BOTH, staffId: WORKER_A });
    expect(view.leaderboardScopeDiffers).toBe(true);
    expect(view.leaderboard.map((r) => [r.staffId, r.normal.items, r.normal.orders])).toEqual([
      [WORKER_B, 0, 1],
      [WORKER_A, 1, 0],
    ]);
    expect(view.summary.normal).toMatchObject({ items: 1, orders: 0 });
    expect(view.activeStaff).toBe(1);
    expect(view.dispatchedOrders).toBe(0);
  });

  it("filters by work type and excludes context outside the selected days from export", () => {
    const early = verify({ department: "framed", line_sku: SKU.framedSingle, line_quantity: 1, created_at: "2026-01-15T03:59:59.000Z" });
    const inDay = verify({ department: "framed", line_sku: SKU.framedSingle, line_quantity: 1, created_at: at("05:00") });
    const other = verify({ department: "unframed", line_sku: SKU.unSingle, line_quantity: 1, created_at: at("06:00") });
    const view = buildProductionReportView(prepareProductionEvidence(snapshot([early, inDay, other])), { range: DAY1, workType: "framed" });
    expect(view.exportEvents.map((e) => e.id)).toEqual([inDay.id]);
    expect(view.summary.normal.items).toBe(1);
  });
});
