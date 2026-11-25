import { beforeEach, describe, expect, it } from "vitest";
import { prepareProductionEvidence, summarizeProduction, type ProductionEvidenceEvent } from "@/lib/domain/productionCounts";
import { buildScannerWallTotals, WALL_WORK_TYPES, WallTotalsRangeError } from "../wallTotals";
import {
  CASE_1,
  cancel,
  complete,
  resetIds,
  snapshot,
  SKU,
  UK_DAY_1,
  UK_DAY_2,
  verify,
  WORKER_A,
  WORKER_B,
} from "../../../../tests/fixtures/item-counting";

const WORKER_C = "33333333-3333-4333-8333-333333333333";
const S2_FRAMED = "INKA-S2ABC0003-A2-FN";
const A0_FRAMED = "INKA-KAN0566-A0-FB";
const D1 = (hhmm: string) => `2026-01-15T${hhmm}:00.000Z`;

function totals(events: ProductionEvidenceEvent[], people: string[], range = UK_DAY_1, visibility?: { kind: "limited"; reason: string }) {
  const prepared = prepareProductionEvidence(snapshot(events, range, visibility));
  return { t: buildScannerWallTotals(prepared, range, people), prepared };
}

/** One framed order for one person: verified lines then completion. */
function framedOrder(order: string, staff: string, lines: Array<[string, number]>, at: string, department = "framed") {
  return [
    ...lines.map(([sku, q]) => verify({ order_number: order, staff_id: staff, department, line_sku: sku, line_quantity: q, created_at: at })),
    complete({ order_number: order, staff_id: staff, department, created_at: at }),
  ];
}

beforeEach(() => resetIds());

describe("buildScannerWallTotals", () => {
  it("sets use shared pieces (2 × S2 = 4 pieces, 1 order) and match summarizeProduction", () => {
    const { t, prepared } = totals(framedOrder("1001", WORKER_A, [[S2_FRAMED, 2]], D1("09:00")), [WORKER_A]);
    expect(t.byPerson[WORKER_A]).toMatchObject({ orders: 1, pieces: 4 });
    const s = summarizeProduction(prepared, { range: UK_DAY_1, staffIds: [WORKER_A], workTypes: WALL_WORK_TYPES });
    expect(t.team).toEqual({ orders: s.normal.orders, pieces: s.normal.items });
  });

  it("mixed A0 and regular count one order", () => {
    const events = [
      ...framedOrder("1002", WORKER_A, [[A0_FRAMED, 1]], D1("09:00"), "a0_framed"),
      ...framedOrder("1002", WORKER_A, [[SKU.framedSingle, 2]], D1("09:10")),
    ];
    const { t } = totals(events, [WORKER_A]);
    expect(t.byPerson[WORKER_A]).toMatchObject({ orders: 1, pieces: 3 });
    expect(t.team).toEqual({ orders: 1, pieces: 3 });
  });

  it("only framing work counts: unframed work is not on the framing wall", () => {
    const events = [
      ...framedOrder("1003", WORKER_A, [[SKU.framedSingle, 1]], D1("09:00")),
      ...framedOrder("1004", WORKER_A, [[SKU.unSingle, 5]], D1("09:30"), "unframed"),
    ];
    expect(totals(events, [WORKER_A]).t.byPerson[WORKER_A]).toMatchObject({ orders: 1, pieces: 1 });
  });

  it("cancelled rows and pre-window qualification match F1", () => {
    const v = verify({ order_number: "1005", staff_id: WORKER_A, department: "framed", line_sku: SKU.framedSingle, line_quantity: 1, created_at: D1("09:00") });
    const c = complete({ order_number: "1005", staff_id: WORKER_A, department: "framed", created_at: D1("09:05") });
    const x = cancel(c, { created_at: D1("09:10") });
    const { t, prepared } = totals([v, c, x], [WORKER_A]);
    const s = summarizeProduction(prepared, { range: UK_DAY_1, staffIds: [WORKER_A], workTypes: WALL_WORK_TYPES });
    expect(t.byPerson[WORKER_A].orders).toBe(s.byPerson[WORKER_A]?.normal.orders ?? 0);
    expect(t.byPerson[WORKER_A].orders).toBe(0); // the completion was reversed
  });

  it("normal excludes rework", () => {
    const events = [
      ...framedOrder("1006", WORKER_A, [[SKU.framedSingle, 1]], D1("09:00")),
      verify({ order_number: "1007", staff_id: WORKER_A, department: "framed", line_sku: SKU.framedSingle, line_quantity: 1, cs_case_id: CASE_1, created_at: D1("10:00") }),
      complete({ order_number: "1007", staff_id: WORKER_A, department: "framed", cs_case_id: CASE_1, created_at: D1("10:05") }),
    ];
    const { t } = totals(events, [WORKER_A]);
    expect(t.byPerson[WORKER_A]).toMatchObject({ orders: 1, pieces: 1 });
    expect(t.hasRework).toBe(true);
  });

  it("duplicate active people contribute once", () => {
    const events = framedOrder("1008", WORKER_A, [[SKU.framedSingle, 1]], D1("09:00"));
    const { t } = totals(events, [WORKER_A, WORKER_A, WORKER_B]);
    expect(Object.keys(t.byPerson).sort()).toEqual([WORKER_A, WORKER_B].sort());
    expect(t.team).toEqual({ orders: 1, pieces: 1 });
    expect(t.byPerson[WORKER_A].share).toBe(1);
  });

  it("two people same order use union team and credit-share denominator", () => {
    const events = [
      verify({ order_number: "1009", staff_id: WORKER_A, department: "framed", line_sku: SKU.framedSingle, line_quantity: 1, created_at: D1("09:00") }),
      verify({ order_number: "1009", staff_id: WORKER_B, department: "framed", line_sku: "INKA-KAN0567-A3-FW", line_quantity: 1, created_at: D1("09:01") }),
      complete({ order_number: "1009", staff_id: WORKER_A, department: "framed", created_at: D1("09:02") }),
      complete({ order_number: "1009", staff_id: WORKER_B, department: "framed", created_at: D1("09:03") }),
    ];
    const { t } = totals(events, [WORKER_A, WORKER_B]);
    expect(t.team.orders).toBe(1); // one distinct order for the team
    expect(t.byPerson[WORKER_A].orders).toBe(1);
    expect(t.byPerson[WORKER_B].orders).toBe(1);
    expect(t.byPerson[WORKER_A].share).toBe(0.5); // share of the people's order credits (1 + 1)
    expect(t.byPerson[WORKER_A]).toMatchObject({ leading: true, jointLead: true, rank: 1 });
  });

  it("ties rank 1 1 3", () => {
    const events = [
      ...framedOrder("1010", WORKER_A, [[SKU.framedSingle, 1]], D1("09:00")),
      ...framedOrder("1011", WORKER_B, [[SKU.framedSingle, 1]], D1("09:10")),
    ];
    const { t } = totals(events, [WORKER_A, WORKER_B, WORKER_C]);
    expect([t.byPerson[WORKER_A].rank, t.byPerson[WORKER_B].rank, t.byPerson[WORKER_C].rank]).toEqual([1, 1, 3]);
    expect(t.byPerson[WORKER_C]).toMatchObject({ orders: 0, pieces: 0, leading: false, share: 0 });
  });

  it("all zero has no leader", () => {
    const { t } = totals([], [WORKER_A, WORKER_B]);
    expect(Object.values(t.byPerson).some((p) => p.leading)).toBe(false);
    expect(t.byPerson[WORKER_A]).toMatchObject({ orders: 0, pieces: 0, rank: 1, share: 0 });
  });

  it("missing person in complete snapshot is zero", () => {
    const { t } = totals(framedOrder("1012", WORKER_A, [[SKU.framedSingle, 1]], D1("09:00")), [WORKER_A, WORKER_C]);
    expect(t.byPerson[WORKER_C]).toMatchObject({ orders: 0, pieces: 0 });
    expect(t.incomplete).toBe(false);
  });

  it("overflow or limited/incomplete evidence disables ranking", () => {
    const limited = totals(framedOrder("1013", WORKER_A, [[SKU.framedSingle, 1]], D1("09:00")), [WORKER_A], UK_DAY_1, { kind: "limited", reason: "test" }).t;
    expect(limited.incomplete).toBe(true);
    expect(limited.byPerson[WORKER_A]).toMatchObject({ rank: null, share: null, leading: false });
    const bad = totals([
      ...framedOrder("1014", WORKER_A, [[SKU.framedSingle, 1]], D1("09:00")),
      verify({ order_number: "1015", staff_id: WORKER_A, department: "framed", line_sku: SKU.legacy, line_quantity: 1, created_at: D1("09:30") }),
      complete({ order_number: "1015", staff_id: WORKER_A, department: "framed", created_at: D1("09:31") }),
    ], [WORKER_A]).t;
    expect(bad.incomplete).toBe(true);
    expect(bad.byPerson[WORKER_A].rank).toBeNull();
  });

  it("wrong day rejected", () => {
    const prepared = prepareProductionEvidence(snapshot([], UK_DAY_1));
    expect(() => buildScannerWallTotals(prepared, UK_DAY_2, [WORKER_A])).toThrow(WallTotalsRangeError);
  });

  it("no people: empty totals", () => {
    expect(totals([], []).t).toEqual({ byPerson: {}, team: { orders: 0, pieces: 0 }, hasRework: false, incomplete: false });
  });
});
