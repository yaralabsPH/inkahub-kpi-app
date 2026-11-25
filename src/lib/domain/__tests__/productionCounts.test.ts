import { beforeEach, describe, expect, it } from "vitest";
import {
  prepareProductionEvidence,
  ProductionEvidenceError,
  summarizeProduction,
  type ProductionEvidenceEvent,
  type ProductionScope,
} from "../productionCounts";
import {
  CASE_1,
  CASE_2,
  cancel,
  complete,
  dispatch,
  ev,
  resetIds,
  shuffled,
  snapshot,
  SKU,
  UK_BOTH_DAYS,
  UK_DAY_1,
  UK_DAY_2,
  verify,
  WORKER_A,
  WORKER_B,
} from "../../../../tests/fixtures/item-counting";

const D1 = (hhmm: string) => `2026-01-15T${hhmm}:00.000Z`;
const D2 = (hhmm: string) => `2026-01-16T${hhmm}:00.000Z`;

function run(events: ProductionEvidenceEvent[], scope: Partial<ProductionScope> = {}) {
  const prepared = prepareProductionEvidence(snapshot(events));
  return summarizeProduction(prepared, { range: UK_BOTH_DAYS, ...scope });
}

beforeEach(() => resetIds());

describe("items before and after completion", () => {
  it("two UN two-piece sets: four Items, zero Orders, then one Order after completion", () => {
    const v = verify({ line_sku: SKU.unSet2, line_quantity: 2, created_at: D1("09:00") });
    const before = run([v]);
    expect(before.normal.items).toBe(4);
    expect(before.normal.orders).toBe(0);

    const after = run([v, complete({ created_at: D1("09:05") })]);
    expect(after.normal.items).toBe(4);
    expect(after.normal.orders).toBe(1);
    expect(after.normal.orderKeys).toEqual(["uk|1001"]);
    expect(after.byWorkType.unframed.normal).toEqual({ items: 4, orders: 1, orderKeys: ["uk|unframed|1001"] });
    expect(after.coverage.incomplete).toBe(false);
  });

  it("terminal quantities never contribute Items", () => {
    const s = run([complete({ line_quantity: 50, line_sku: SKU.framedSingle, created_at: D1("10:00") })]);
    expect(s.normal.items).toBe(0);
    expect(s.normal.orders).toBe(1);
  });

  it("started and clock events are not count evidence", () => {
    const s = run([
      ev({ event_type: "started", line_sku: SKU.unSet2, line_quantity: 2, created_at: D1("08:00") }),
      ev({ event_type: "clock_in", order_number: null, created_at: D1("07:00") }),
      ev({ event_type: "clock_out", order_number: null, created_at: D1("17:00") }),
    ]);
    expect(s.normal).toEqual({ items: 0, orders: 0, orderKeys: [] });
    expect(s.coverage.issues).toEqual([]);
  });
});

describe("identity and duplicates", () => {
  it("repeated retrieval of the same event id counts once", () => {
    const v = verify({ line_sku: SKU.fnSet3, line_quantity: 1, created_at: D1("09:00") });
    const t = complete({ created_at: D1("09:10") });
    const s = run([v, { ...v }, t, { ...t }]);
    expect(s.normal.items).toBe(3);
    expect(s.normal.orders).toBe(1);
  });

  it("conflicting payloads for one id make the snapshot invalid", () => {
    const v = verify({ line_sku: SKU.fnSet3, line_quantity: 1, created_at: D1("09:00") });
    expect(() => prepareProductionEvidence(snapshot([v, { ...v, line_quantity: 2 }]))).toThrow(ProductionEvidenceError);
  });

  it("two genuine same-SKU verification ids both count, and are flagged as a possible repeat", () => {
    const s = run([
      verify({ line_sku: SKU.framedSingle, line_quantity: 1, department: "framed", created_at: D1("09:00") }),
      verify({ line_sku: SKU.framedSingle, line_quantity: 1, department: "framed", created_at: D1("09:01") }),
    ]);
    expect(s.normal.items).toBe(2);
    expect(s.coverage.issueCounts.ambiguous_repeat).toBe(2);
    expect(s.coverage.incomplete).toBe(true);
  });

  it("repeated completion rows do not add Orders", () => {
    const s = run([
      verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: D1("09:00") }),
      complete({ created_at: D1("09:05") }),
      complete({ created_at: D1("09:06") }),
    ]);
    expect(s.normal.orders).toBe(1);
  });

  it("invalid identities and times create no credit and are reported", () => {
    const s = run([
      verify({ line_sku: SKU.unSingle, line_quantity: 1, staff_id: null, created_at: D1("09:00") }),
      verify({ line_sku: SKU.unSingle, line_quantity: 1, department: "packing", created_at: D1("09:01") }),
      verify({ line_sku: SKU.unSingle, line_quantity: 1, order_number: "  ", created_at: D1("09:02") }),
      verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: "not-a-time" }),
      complete({ department: "dispatch", created_at: D1("09:03") }),
      dispatch({ department: "framed", created_at: D1("09:04") }),
    ]);
    expect(s.normal).toEqual({ items: 0, orders: 0, orderKeys: [] });
    expect(s.coverage.issueCounts.invalid_event).toBe(6);
  });

  it("order identity is trimmed, so surrounding spaces do not create a second order", () => {
    const s = run([
      verify({ line_sku: SKU.unSingle, line_quantity: 1, order_number: " 1001", created_at: D1("09:00") }),
      complete({ order_number: "1001 ", created_at: D1("09:05") }),
    ]);
    expect(s.normal.orderKeys).toEqual(["uk|1001"]);
  });
});

describe("cancellations", () => {
  it("another worker's next-day cancellation removes the earlier verification once, never negative", () => {
    const v = verify({ staff_id: WORKER_A, line_sku: SKU.unSet2, line_quantity: 2, created_at: D1("09:00") });
    const c = cancel(v, { staff_id: WORKER_B, created_at: D2("10:00") });
    const prepared = prepareProductionEvidence(snapshot([v, c]));
    expect(summarizeProduction(prepared, { range: UK_DAY_1 }).normal.items).toBe(0);
    expect(summarizeProduction(prepared, { range: UK_DAY_2 }).normal.items).toBe(0);
    // A person filter for A alone still applies B's correction.
    expect(summarizeProduction(prepared, { range: UK_DAY_1, staffIds: [WORKER_A] }).normal.items).toBe(0);
    // B gets no negative credit.
    expect(summarizeProduction(prepared, { range: UK_BOTH_DAYS, staffIds: [WORKER_B] }).normal.items).toBe(0);
    expect(summarizeProduction(prepared, { range: UK_DAY_1 }).coverage.notes.corrected_verification).toBe(1);
  });

  it("uses the parent's quantity, not the cancellation's", () => {
    const v = verify({ line_sku: SKU.fnSet3, line_quantity: 2, department: "framed", created_at: D1("09:00") });
    const keep = verify({ line_sku: SKU.framedSingle, line_quantity: 1, department: "framed", created_at: D1("09:01") });
    const c = cancel(v, { line_quantity: 1, line_sku: SKU.framedSingle, created_at: D1("09:02") });
    expect(run([v, keep, c]).normal.items).toBe(1);
  });

  it("duplicate cancellations subtract once", () => {
    const v = verify({ line_sku: SKU.unSet2, line_quantity: 1, created_at: D1("09:00") });
    const other = verify({ line_sku: SKU.unSingle, line_quantity: 3, created_at: D1("09:01") });
    const s = run([v, other, cancel(v, { created_at: D1("09:02") }), cancel(v, { created_at: D1("09:03") })]);
    expect(s.normal.items).toBe(3);
  });

  it("a mismatched, missing, later, self or unsupported parent is an issue with no guessed subtraction", () => {
    const v = verify({ line_sku: SKU.unSet2, line_quantity: 1, created_at: D1("09:00") });
    const started = ev({ event_type: "started", created_at: D1("08:59") });
    const s = run([
      v,
      started,
      cancel(v, { order_number: "9999", created_at: D1("09:05") }),
      cancel(v, { department: "framed", created_at: D1("09:06") }),
      cancel(v, { location: "uk", parent_event_id: "missing", created_at: D1("09:07") }),
      cancel(v, { created_at: D1("08:00") }),
      ev({ id: "self", event_type: "cancelled", parent_event_id: "self", created_at: D1("09:08") }),
      cancel(started, { created_at: D1("09:09") }),
      cancel(v, { cs_case_id: CASE_1, created_at: D1("09:10") }),
    ]);
    expect(s.normal.items).toBe(2);
    expect(s.coverage.issueCounts.unresolved_parent).toBe(7);
  });

  it("a cancellation without a case tag inherits the parent's case", () => {
    const v = verify({ line_sku: SKU.unSet2, line_quantity: 1, cs_case_id: CASE_1, created_at: D1("09:00") });
    const s = run([v, cancel(v, { cs_case_id: null, created_at: D1("09:05") })]);
    expect(s.rework.items).toBe(0);
    expect(s.coverage.issueCounts.unresolved_parent).toBe(0);
  });

  it("parentless mid-progress cancel and order scrap do not remove credit", () => {
    const s = run([
      verify({ line_sku: SKU.unSet2, line_quantity: 1, created_at: D1("09:00") }),
      ev({ event_type: "cancelled", line_sku: SKU.unSet2, line_quantity: 1, created_at: D1("09:05") }),
      ev({ event_type: "cancelled", line_sku: null, created_at: D1("09:06") }),
    ]);
    expect(s.normal.items).toBe(2);
    expect(s.coverage.issues).toEqual([]);
  });
});

describe("order qualification", () => {
  it("excluded-only context disqualifies; mixed qualifies; unknown and missing count with a warning", () => {
    const s = run([
      verify({ order_number: "A", line_sku: SKU.hook, line_quantity: 1, created_at: D1("09:00") }),
      verify({ order_number: "A", line_sku: SKU.freePrint, line_quantity: 1, created_at: D1("09:00") }),
      complete({ order_number: "A", created_at: D1("09:05") }),
      verify({ order_number: "B", line_sku: SKU.hook, line_quantity: 1, created_at: D1("09:00") }),
      verify({ order_number: "B", line_sku: SKU.unSingle, line_quantity: 1, created_at: D1("09:00") }),
      complete({ order_number: "B", created_at: D1("09:05") }),
      verify({ order_number: "C", line_sku: SKU.legacy, line_quantity: 1, created_at: D1("09:00") }),
      complete({ order_number: "C", created_at: D1("09:05") }),
      complete({ order_number: "D", created_at: D1("09:05") }),
    ]);
    expect(s.normal.orderKeys).toEqual(["uk|B", "uk|C", "uk|D"]);
    expect(s.normal.items).toBe(1);
    expect(s.coverage.issueCounts.missing_completion_detail).toBe(2);
    expect(s.coverage.notes.excluded_only_completion).toBe(1);
    expect(s.coverage.notes.expected_exclusion).toBe(3);
    expect(s.orders.find((o) => o.orderNumber === "D")?.missingDetail).toBe(true);
    expect(s.orders.find((o) => o.orderNumber === "B")?.missingDetail).toBe(false);
  });

  it("an eligible product with a bad quantity still qualifies the order", () => {
    const s = run([
      verify({ line_sku: SKU.unSingle, line_quantity: null, created_at: D1("09:00") }),
      complete({ created_at: D1("09:05") }),
    ]);
    expect(s.normal.orders).toBe(1);
    expect(s.normal.items).toBe(0);
    expect(s.coverage.issueCounts.invalid_quantity).toBe(1);
    expect(s.coverage.issueCounts.missing_completion_detail).toBe(0);
  });

  it("a later eligible verification cannot qualify an earlier excluded-only completion", () => {
    const s = run([
      verify({ line_sku: SKU.hook, line_quantity: 1, created_at: D1("09:00") }),
      complete({ created_at: D1("09:05") }),
      verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: D2("09:00") }),
    ]);
    expect(s.normal.orders).toBe(0);
    expect(s.normal.items).toBe(1);
  });

  it("a verification at the same instant as the completion counts as context", () => {
    const s = run([
      verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: D1("09:00") }),
      complete({ created_at: D1("09:00") }),
    ]);
    expect(s.normal.orders).toBe(1);
    expect(s.coverage.issueCounts.missing_completion_detail).toBe(0);
  });

  it("context never comes from another work type, site or case", () => {
    const s = run([
      verify({ department: "framed", line_sku: SKU.framedSingle, line_quantity: 1, created_at: D1("09:00") }),
      verify({ location: "au", line_sku: SKU.unSingle, line_quantity: 1, created_at: D1("09:00") }),
      verify({ cs_case_id: CASE_1, line_sku: SKU.unSingle, line_quantity: 1, created_at: D1("09:00") }),
      complete({ department: "unframed", created_at: D1("09:05") }),
    ]);
    expect(s.orders.find((o) => o.key === "uk|1001")?.missingDetail).toBe(true);
    expect(s.coverage.issueCounts.missing_completion_detail).toBe(1);
  });

  it("undoing the eligible line of a completed mixed order lowers Items but keeps the Order", () => {
    const eligible = verify({ line_sku: SKU.unSet2, line_quantity: 1, created_at: D1("09:00") });
    const s = run([
      eligible,
      verify({ line_sku: SKU.hook, line_quantity: 1, created_at: D1("09:01") }),
      complete({ created_at: D1("09:05") }),
      cancel(eligible, { created_at: D1("10:00") }),
    ]);
    expect(s.normal.items).toBe(0);
    expect(s.normal.orders).toBe(1);
  });

  it("an explicit terminal reversal removes that completion unless another unreversed one qualifies", () => {
    const v = verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: D1("09:00") });
    const t1 = complete({ created_at: D1("09:05") });
    const reversal = cancel(t1, { created_at: D1("09:10") });
    expect(run([v, t1, reversal]).normal.orders).toBe(0);
    expect(run([v, t1, reversal]).coverage.notes.reversed_terminal).toBe(1);
    const t2 = complete({ created_at: D1("09:20") });
    expect(run([v, t1, reversal, t2]).normal.orders).toBe(1);
  });

  it("dispatch completions use dispatch-line context", () => {
    const s = run([
      verify({ department: "dispatch", line_sku: SKU.framedSingle, line_quantity: 2, created_at: D1("09:00") }),
      dispatch({ created_at: D1("09:05") }),
    ]);
    expect(s.byWorkType.dispatch.normal).toEqual({ items: 2, orders: 1, orderKeys: ["uk|dispatch|1001"] });
  });
});

describe("distinct orders across scopes", () => {
  it("two work types on one order: one Order each, one overall", () => {
    const s = run([
      verify({ department: "framed", line_sku: SKU.framedSingle, line_quantity: 1, created_at: D1("09:00") }),
      complete({ department: "framed", created_at: D1("09:05") }),
      verify({ department: "dispatch", line_sku: SKU.framedSingle, line_quantity: 1, created_at: D1("11:00") }),
      dispatch({ created_at: D1("11:05") }),
    ]);
    expect(s.byWorkType.framed.normal.orders).toBe(1);
    expect(s.byWorkType.dispatch.normal.orders).toBe(1);
    expect(s.normal.orders).toBe(1);
    // Items are work processed across work types: the same piece at two stages counts twice.
    expect(s.normal.items).toBe(2);
  });

  it("the same order number at two sites stays distinct", () => {
    const s = run([
      verify({ location: "uk", line_sku: SKU.unSingle, line_quantity: 1, created_at: D1("09:00") }),
      complete({ location: "uk", created_at: D1("09:05") }),
      verify({ location: "au", line_sku: SKU.unSingle, line_quantity: 1, created_at: D1("09:00") }),
      complete({ location: "au", created_at: D1("09:05") }),
    ]);
    expect(s.normal.orderKeys).toEqual(["au|1001", "uk|1001"]);
  });

  it("the same order on two days is one Order over the full range, not the sum of days", () => {
    const events = [
      verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: D1("09:00") }),
      complete({ created_at: D1("09:05") }),
      verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: D2("09:00") }),
      complete({ created_at: D2("09:05") }),
    ];
    const prepared = prepareProductionEvidence(snapshot(events));
    expect(summarizeProduction(prepared, { range: UK_DAY_1 }).normal.orders).toBe(1);
    expect(summarizeProduction(prepared, { range: UK_DAY_2 }).normal.orders).toBe(1);
    expect(summarizeProduction(prepared, { range: UK_BOTH_DAYS }).normal.orders).toBe(1);
  });

  it("person Orders follow the terminal's person, Items follow the verifier", () => {
    const s = run([
      verify({ staff_id: WORKER_A, line_sku: SKU.unSet2, line_quantity: 1, created_at: D1("09:00") }),
      complete({ staff_id: WORKER_B, created_at: D1("09:05") }),
    ]);
    expect(s.byPerson[WORKER_A].normal).toEqual({ items: 2, orders: 0, orderKeys: [] });
    expect(s.byPerson[WORKER_B].normal).toEqual({ items: 0, orders: 1, orderKeys: ["uk|1001"] });
    const onlyB = run(
      [
        verify({ staff_id: WORKER_A, line_sku: SKU.unSet2, line_quantity: 1, created_at: D1("09:00") }),
        complete({ staff_id: WORKER_B, created_at: D1("09:05") }),
      ],
      { staffIds: [WORKER_B] },
    );
    // Qualification used A's line even though the display shows only B.
    expect(onlyB.normal).toEqual({ items: 0, orders: 1, orderKeys: ["uk|1001"] });
    expect(onlyB.coverage.issueCounts.missing_completion_detail).toBe(0);
  });

  it("CS/rework is separate and keyed by case", () => {
    const s = run([
      verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: D1("08:00") }),
      complete({ created_at: D1("08:05") }),
      verify({ cs_case_id: CASE_1, line_sku: SKU.unSet2, line_quantity: 1, created_at: D1("09:00") }),
      complete({ cs_case_id: CASE_1, created_at: D1("09:05") }),
      verify({ cs_case_id: CASE_2, line_sku: SKU.unSingle, line_quantity: 1, created_at: D1("10:00") }),
      complete({ cs_case_id: CASE_2, created_at: D1("10:05") }),
    ]);
    expect(s.normal).toEqual({ items: 1, orders: 1, orderKeys: ["uk|1001"] });
    expect(s.rework).toEqual({ items: 3, orders: 2, orderKeys: ["uk|1001|case:case-0001", "uk|1001|case:case-0002"] });
    expect(s.orders.filter((o) => o.group === "rework").map((o) => o.caseId)).toEqual([CASE_1, CASE_2]);
  });

  it("work-type filter limits both Items and Orders", () => {
    const s = run(
      [
        verify({ department: "framed", line_sku: SKU.framedSingle, line_quantity: 1, created_at: D1("09:00") }),
        complete({ department: "framed", created_at: D1("09:05") }),
        verify({ department: "unframed", order_number: "2002", line_sku: SKU.unSingle, line_quantity: 4, created_at: D1("09:00") }),
        complete({ department: "unframed", order_number: "2002", created_at: D1("09:05") }),
      ],
      { workTypes: ["unframed"] },
    );
    expect(s.normal).toEqual({ items: 4, orders: 1, orderKeys: ["uk|2002"] });
  });
});

describe("determinism, totals and visibility", () => {
  it("shuffled input gives an identical summary", () => {
    const v1 = verify({ staff_id: WORKER_A, line_sku: SKU.unSet2, line_quantity: 2, created_at: D1("09:00") });
    const events = [
      v1,
      verify({ staff_id: WORKER_B, department: "framed", line_sku: SKU.gwSet6, line_quantity: 1, created_at: D1("09:30") }),
      complete({ department: "framed", staff_id: WORKER_B, created_at: D1("09:35") }),
      cancel(v1, { staff_id: WORKER_B, created_at: D2("08:00") }),
      verify({ cs_case_id: CASE_1, line_sku: SKU.unSingle, line_quantity: 1, created_at: D2("09:00") }),
      complete({ cs_case_id: CASE_1, created_at: D2("09:05") }),
      complete({ order_number: "9", created_at: D2("10:00") }),
    ];
    const base = run(events);
    for (const seed of [1, 2, 3, 99]) expect(run(shuffled(events, seed))).toEqual(base);
  });

  it("an aggregate that exceeds safe-integer precision is null and marked incomplete", () => {
    const big = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;
    const s = run([
      verify({ line_sku: SKU.unSingle, line_quantity: big, created_at: D1("09:00") }),
      verify({ line_sku: SKU.framedSingle, department: "framed", line_quantity: big, created_at: D1("09:01") }),
    ]);
    expect(s.normal.items).toBeNull();
    expect(s.coverage.incomplete).toBe(true);
  });

  it("limited visibility marks coverage incomplete even when there are no issues", () => {
    const prepared = prepareProductionEvidence(
      snapshot([verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: D1("09:00") })], UK_BOTH_DAYS, {
        kind: "limited",
        reason: "visible records only",
      }),
    );
    const s = summarizeProduction(prepared, { range: UK_BOTH_DAYS });
    expect(s.coverage.issues).toEqual([]);
    expect(s.coverage.incomplete).toBe(true);
    expect(s.coverage.visibility).toEqual({ kind: "limited", reason: "visible records only" });
  });

  it("coverage follows the display scope", () => {
    const events = [
      verify({ line_sku: SKU.legacy, line_quantity: 1, created_at: D1("09:00") }),
      verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: D2("09:00") }),
    ];
    const prepared = prepareProductionEvidence(snapshot(events));
    expect(summarizeProduction(prepared, { range: UK_DAY_1 }).coverage.issueCounts.unclassified_sku).toBe(1);
    expect(summarizeProduction(prepared, { range: UK_DAY_2 }).coverage.issueCounts.unclassified_sku).toBe(0);
  });
});

describe("exact microsecond chronology (review r1 M1)", () => {
  const all: ProductionScope = { range: UK_BOTH_DAYS };
  const run = (events: ProductionEvidenceEvent[]) => summarizeProduction(prepareProductionEvidence(snapshot(events)), all);

  it("an eligible line 800 µs after a completion in the same millisecond cannot qualify that earlier excluded-only completion", () => {
    const events = [
      verify({ line_sku: SKU.hook, line_quantity: 1, created_at: "2026-01-15T09:00:00.000000Z" }),
      complete({ created_at: "2026-01-15T10:00:00.000100Z" }),
      verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-15T10:00:00.000900Z" }),
    ];
    const s = run(events);
    expect(s.normal.orders).toBe(0);
    expect(s.normal.items).toBe(1);
    expect(s.coverage.notes.excluded_only_completion).toBe(1);
    expect(run(shuffled(events)).normal.orders).toBe(0);
  });

  it("a cancellation earlier than its parent by microseconds is rejected, not applied", () => {
    const parent = verify({ line_sku: SKU.unSet2, line_quantity: 1, created_at: "2026-01-15T10:00:00.000900Z" });
    const early = cancel(parent, { created_at: "2026-01-15T10:00:00.000100Z" });
    const s = run([parent, early]);
    expect(s.normal.items).toBe(2);
    expect(s.coverage.issueCounts.unresolved_parent).toBe(1);
  });

  it("genuinely equal instants: the line counts as at-or-before the completion, and the cancellation applies", () => {
    const line = verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-15T10:00:00.000500Z" });
    const done = complete({ created_at: "2026-01-15T10:00:00.000500Z" });
    expect(run([done, line]).normal).toMatchObject({ items: 1, orders: 1 });
    const undo = cancel(line, { created_at: "2026-01-15T10:00:00.000500Z" });
    expect(run([line, undo]).normal.items).toBe(0);
  });

  it("equivalent offset spellings are the same instant; different microseconds are different payloads", () => {
    const a = verify({ id: "same", line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-15T10:00:00.000500Z" });
    const b = { ...a, created_at: "2026-01-15T10:00:00.0005+00:00" };
    expect(run([a, b]).normal.items).toBe(1);
    const c = { ...a, created_at: "2026-01-15T10:00:00.000600Z" };
    expect(() => prepareProductionEvidence(snapshot([a, c]))).toThrow(ProductionEvidenceError);
  });
});
