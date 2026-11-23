/** F10 Task 1: evidence model and pure projection (synthetic fixtures). */
import { describe, expect, it } from "vitest";
import {
  flowMetrics,
  median,
  occurrenceKey,
  stageGaps,
  strictIso,
  TIMELINE_SEQUENCE,
  TimelineIdentityError,
  mergeEvidence,
  normalizeShop,
  orderIdentityKey,
  percentile,
  projectTimeline,
  type OrderEvidence,
} from "../src/lib/domain/orderTimeline";

const SHOP = "inka-uk.myshopify.com";
const ev = (over: Partial<OrderEvidence>): OrderEvidence => ({
  key: "k", site: "uk", shop: SHOP, shopifyOrderId: "1001", orderNumber: "#5001", stage: "ordered", source: "shopify", kind: "confirmed",
  happenedAt: "2026-11-20T09:00:00Z", receivedAt: "2026-11-20T09:00:05Z", ...over,
});

describe("identity", () => {
  it("is site + normalized shop + immutable order id; the order number is only an alias", () => {
    expect(normalizeShop(" Inka-UK.myshopify.com ")).toBe(SHOP);
    expect(normalizeShop("evil.example.com")).toBeNull();
    expect(orderIdentityKey("uk", "Inka-UK.myshopify.com", "1001")).toBe(`uk|${SHOP}|1001`);
    expect(orderIdentityKey("au", SHOP, "1001")).not.toBe(orderIdentityKey("uk", SHOP, "1001"));
    expect(orderIdentityKey("uk", null, "1001")).toBeNull(); // unmapped: never guessed
    expect(orderIdentityKey("nz", SHOP, "1001")).toBeNull();
    expect(orderIdentityKey("uk", SHOP, "")).toBeNull();
  });
});

describe("immutable occurrences", () => {
  it("same key + same content is a duplicate; same key + different content conflicts and keeps the original", () => {
    const a = ev({ key: "shopify:wh-1" });
    const first = mergeEvidence([], [a]);
    expect(first.accepted).toHaveLength(1);
    const again = mergeEvidence(first.records, [{ ...a, receivedAt: "2026-11-20T10:00:00Z" }]); // a redelivery
    expect([again.accepted.length, again.duplicates.length, again.conflicts.length]).toEqual([0, 1, 0]);
    const altered = mergeEvidence(first.records, [{ ...a, happenedAt: "2026-11-21T09:00:00Z" }]);
    expect(altered.conflicts).toHaveLength(1);
    expect(altered.records).toEqual(first.records);
  });
  it("refuses malformed times and unknown stages", () => {
    const r = mergeEvidence([], [ev({ key: "x1", happenedAt: "yesterday" }), ev({ key: "x2", stage: "teleported" as never })]);
    expect(r.rejected.map((x) => x.key)).toEqual(["x1", "x2"]);
  });
});

describe("projection", () => {
  const ordered = ev({ key: "o" });
  it("shows missing stages explicitly and works regardless of arrival order", () => {
    const evs = [
      ev({ key: "d", stage: "dispatched", source: "app", happenedAt: "2026-11-21T15:00:00Z" }),
      ordered,
      ev({ key: "f", stage: "framed", source: "app", workType: "framed", happenedAt: "2026-11-21T10:00:00Z" }),
    ];
    const t = projectTimeline(evs);
    expect(t.stages.ordered.status).toBe("confirmed");
    expect(t.stages.framed.status).toBe("partial"); // one work type is not whole-order framing
    expect(t.stages.shipped.status).toBe("missing"); // dispatch is not shipment
    expect(t.stages.delivered.status).toBe("missing");
    expect(t.stages.make_planned.status).toBe("missing"); // F11 stages exist, empty
    expect(projectTimeline([...evs].reverse())).toEqual(t);
  });
  it("partial vs complete shipment; delivered only from carrier evidence", () => {
    const part = projectTimeline([ordered, ev({ key: "s1", stage: "shipped", fulfillmentId: "F1", fulfillmentComplete: false, happenedAt: "2026-11-22T09:00:00Z" })]);
    expect(part.stages.shipped.status).toBe("partial");
    expect(part.completeShipmentAt).toBeNull();
    const full = projectTimeline([ordered, ev({ key: "s1", stage: "shipped", fulfillmentId: "F1", fulfillmentComplete: false, happenedAt: "2026-11-22T09:00:00Z" }), ev({ key: "s2", stage: "shipped", fulfillmentId: "F2", fulfillmentComplete: true, happenedAt: "2026-11-23T09:00:00Z" })]);
    expect(full.stages.shipped.status).toBe("confirmed");
    expect(full.completeShipmentAt).toBe("2026-11-23T09:00:00.000Z");
    expect(full.fulfillments).toHaveLength(2);
    const appDelivered = projectTimeline([ordered, ev({ key: "x", stage: "delivered", source: "app" })]);
    expect(appDelivered.stages.delivered.status).toBe("missing");
  });
  it("replacement (CS case) work does not complete the original order; cancellation is flagged", () => {
    const t = projectTimeline([ordered, ev({ key: "r", stage: "dispatched", source: "app", caseId: "C-1", happenedAt: "2026-11-21T09:00:00Z" })]);
    expect(t.stages.dispatched.status).toBe("missing");
    expect(t.replacementEvidence).toHaveLength(1);
    expect(projectTimeline([ordered, ev({ key: "c", stage: "cancelled", happenedAt: "2026-11-20T12:00:00Z" })]).cancelled).toBe(true);
  });
  it("several framing work types are listed separately, never collapsed into one", () => {
    const t = projectTimeline([ordered, ev({ key: "a", stage: "framed", source: "app", workType: "a0_framed" }), ev({ key: "b", stage: "framed", source: "app", workType: "framed", happenedAt: "2026-11-20T11:00:00Z" })]);
    expect(t.framedByWorkType.map((f) => f.workType)).toEqual(["a0_framed", "framed"]);
  });
});

describe("flow metrics", () => {
  const order = (id: string, at: string, shippedAt: string | null, cancelled = false) => {
    const evs: OrderEvidence[] = [ev({ key: `o${id}`, shopifyOrderId: id, happenedAt: at })];
    if (shippedAt) evs.push(ev({ key: `s${id}`, shopifyOrderId: id, stage: "shipped", fulfillmentId: `F${id}`, fulfillmentComplete: true, happenedAt: shippedAt }));
    if (cancelled) evs.push(ev({ key: `c${id}`, shopifyOrderId: id, stage: "cancelled", happenedAt: at }));
    return projectTimeline(evs);
  };
  const P = { startUtc: "2026-11-20T00:00:00Z", endUtcExclusive: "2026-11-21T00:00:00Z" };
  it("nearest-rank median/P90 of complete-shipment hours; cohort and sample counts labelled", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([], 0.5)).toBeNull();
    const m = flowMetrics([
      order("1", "2026-11-20T00:00:00Z", "2026-11-20T10:00:00Z"),
      order("2", "2026-11-20T01:00:00Z", "2026-11-20T21:00:00Z"),
      order("3", "2026-11-20T02:00:00Z", null), // open
      order("4", "2026-11-20T03:00:00Z", null, true), // cancelled: not in cohort
      order("5", "2026-11-19T03:00:00Z", "2026-11-20T03:00:00Z"), // outside period
    ], P, "2026-11-22T00:00:00Z");
    expect([m.cohort, m.completeShipmentSamples, m.openOrders]).toEqual([3, 2, 1]);
    expect(m.orderToShipHours).toEqual({ median: 15, p90: 20 }); // median of [10, 20] averages the middle pair
  });
  it("negative gaps are excluded as anomalies, never shown as negative time", () => {
    const m = flowMetrics([order("1", "2026-11-20T05:00:00Z", "2026-11-20T04:00:00Z")], P, "2026-11-22T00:00:00Z");
    expect(m.completeShipmentSamples).toBe(0);
    expect(m.anomalies).toBe(1);
  });
});

describe("review r1 corrections", () => {
  const o = ev({ key: "o" });
  it("P1: mixed or unmapped identities are refused; the identity is kept on the view", () => {
    expect(() => projectTimeline([o, ev({ key: "s", stage: "shipped", shopifyOrderId: "2002", fulfillmentId: "F", fulfillmentComplete: true })])).toThrow(TimelineIdentityError);
    expect(() => projectTimeline([o, ev({ key: "x", site: "au" })])).toThrow(TimelineIdentityError);
    expect(() => projectTimeline([ev({ key: "u", shop: null })])).toThrow(TimelineIdentityError);
    expect(() => projectTimeline([])).toThrow(TimelineIdentityError);
    expect(projectTimeline([o])).toMatchObject({ identity: `uk|${SHOP}|1001`, site: "uk" });
    const P = { startUtc: "2026-11-20T00:00:00Z", endUtcExclusive: "2026-11-21T00:00:00Z" };
    expect(() => flowMetrics([projectTimeline([o]), projectTimeline([o])], P, "2026-11-22T00:00:00Z")).toThrow(/once/);
    expect(() => flowMetrics([projectTimeline([o]), projectTimeline([ev({ key: "a", site: "au" })])], P, "2026-11-22T00:00:00Z")).toThrow(/one site/);
  });
  it("P1: framing is complete only with explicit whole-order proof", () => {
    const one = projectTimeline([o, ev({ key: "f", stage: "framed", source: "app", workType: "framed" })]);
    expect(one.stages.framed.status).toBe("partial");
    expect(one.framedByWorkType).toHaveLength(1);
    const all = projectTimeline([o, ev({ key: "f", stage: "framed", source: "app", workType: "framed", framingComplete: true })]);
    expect(all.stages.framed.status).toBe("confirmed");
  });
  it("P1: reported/inferred shipment or delivery is never promoted to confirmed or counted", () => {
    const t = projectTimeline([o, ev({ key: "s", stage: "shipped", kind: "inferred", fulfillmentId: "F", fulfillmentComplete: true }), ev({ key: "d", stage: "delivered", kind: "reported" })]);
    expect(t.stages.shipped).toMatchObject({ status: "unconfirmed", kind: "inferred" });
    expect(t.stages.delivered).toMatchObject({ status: "unconfirmed", kind: "reported" });
    expect(t.completeShipmentAt).toBeNull();
    const m = flowMetrics([t], { startUtc: "2026-11-20T00:00:00Z", endUtcExclusive: "2026-11-21T00:00:00Z" }, "2026-11-22T00:00:00Z");
    expect([m.completeShipmentSamples, m.openOrders]).toEqual([0, 1]);
  });
  it("P2: occurrence keys are source-qualified; same-source changed identity still conflicts; source/kind/site validated", () => {
    const r = mergeEvidence([], [ev({ key: "1" }), ev({ key: "1", source: "app", stage: "framed" })]);
    expect(r.accepted).toHaveLength(2);
    expect(occurrenceKey(r.accepted[0])).not.toBe(occurrenceKey(r.accepted[1]));
    expect(mergeEvidence(r.records, [ev({ key: "1", shopifyOrderId: "9999" })]).conflicts).toHaveLength(1);
    const bad = mergeEvidence([], [ev({ key: "b1", source: "fax" as never }), ev({ key: "b2", kind: "guessed" as never }), ev({ key: "b3", site: "nz" })]);
    expect(bad.rejected).toHaveLength(3);
  });
  it("P2: median averages the middle pair; P90 stays nearest-rank", () => {
    expect(median([10, 20])).toBe(15);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
    expect(percentile([10, 20], 0.9)).toBe(20);
  });
  it("P2: only explicit UTC/offset ISO on real dates; period/now validated; future evidence excluded", () => {
    expect(strictIso("2026-11-20T09:00:00Z")).toBe("2026-11-20T09:00:00.000Z");
    expect(strictIso("2026-11-20T17:00:00+08:00")).toBe("2026-11-20T09:00:00.000Z");
    for (const bad of ["2026-11-20T09:00:00", "2026-02-30T00:00:00Z", "2026-11-20", "20 Nov 2026", "2026-11-20T25:00:00Z"]) expect(strictIso(bad)).toBeNull();
    expect(mergeEvidence([], [ev({ key: "l", happenedAt: "2026-11-20T09:00:00" })]).rejected).toHaveLength(1);
    const P = { startUtc: "2026-11-20T00:00:00Z", endUtcExclusive: "2026-11-21T00:00:00Z" };
    expect(() => flowMetrics([], { startUtc: P.endUtcExclusive, endUtcExclusive: P.startUtc }, "2026-11-22T00:00:00Z")).toThrow();
    expect(() => flowMetrics([], P, "2026-11-22T00:00:00")).toThrow();
    const shippedLater = projectTimeline([o, ev({ key: "s", stage: "shipped", fulfillmentId: "F", fulfillmentComplete: true, happenedAt: "2026-11-23T09:00:00Z" })]);
    const m = flowMetrics([shippedLater], P, "2026-11-21T12:00:00Z"); // now is before the shipment
    expect([m.completeShipmentSamples, m.openOrders]).toEqual([0, 1]);
    const futureOrder = projectTimeline([ev({ key: "fo", happenedAt: "2026-11-20T20:00:00Z" })]);
    expect(flowMetrics([futureOrder], P, "2026-11-20T12:00:00Z").cohort).toBe(0);
  });
});

describe("review r2 corrections", () => {
  const o = ev({ key: "o" });
  const P = { startUtc: "2026-11-20T00:00:00Z", endUtcExclusive: "2026-11-21T00:00:00Z" };
  it("A: a cancellation after now does not remove the order; one at or before now does", () => {
    const t = projectTimeline([o, ev({ key: "c", stage: "cancelled", happenedAt: "2026-11-22T09:00:00Z" })]);
    const before = flowMetrics([t], P, "2026-11-21T12:00:00Z");
    expect([before.cohort, before.openOrders]).toEqual([1, 1]);
    expect(flowMetrics([t], P, "2026-11-22T10:00:00Z").cohort).toBe(0);
  });
  it("B: inferred-only framing/fulfillment is unconfirmed, not partial; confirmed partial wins; work-type kind kept", () => {
    const inf = projectTimeline([o, ev({ key: "f", stage: "framed", source: "app", workType: "framed", kind: "inferred" })]);
    expect(inf.stages.framed).toMatchObject({ status: "unconfirmed", kind: "inferred" });
    expect(inf.framedByWorkType).toEqual([{ workType: "framed", at: "2026-11-20T09:00:00.000Z", kind: "inferred" }]);
    const mixed = projectTimeline([o,
      ev({ key: "f1", stage: "framed", source: "app", workType: "framed", kind: "inferred", happenedAt: "2026-11-20T10:00:00Z" }),
      ev({ key: "f2", stage: "framed", source: "app", workType: "framed", kind: "confirmed", happenedAt: "2026-11-20T11:00:00Z" })]);
    expect(mixed.stages.framed).toMatchObject({ status: "partial", kind: "confirmed", at: "2026-11-20T11:00:00.000Z" });
    expect(mixed.framedByWorkType[0]).toMatchObject({ kind: "confirmed", at: "2026-11-20T11:00:00.000Z" });
    const ship = projectTimeline([o, ev({ key: "s", stage: "shipped", kind: "inferred", fulfillmentId: "F1", fulfillmentComplete: false })]);
    expect(ship.stages.shipped).toMatchObject({ status: "unconfirmed", kind: "inferred" });
    const both = projectTimeline([o,
      ev({ key: "s1", stage: "shipped", kind: "inferred", fulfillmentId: "F1", fulfillmentComplete: false, happenedAt: "2026-11-21T09:00:00Z" }),
      ev({ key: "s2", stage: "shipped", kind: "confirmed", fulfillmentId: "F2", fulfillmentComplete: false, happenedAt: "2026-11-21T10:00:00Z" })]);
    expect(both.stages.shipped).toMatchObject({ status: "partial", kind: "confirmed", at: "2026-11-21T10:00:00.000Z" });
  });
});

describe("review checkpoint P2: inferred complete never outranks confirmed partial", () => {
  const o = ev({ key: "o" });
  it("confirmed partial wins; the inferred complete record is retained separately and never completes the order", () => {
    const evs = [o,
      ev({ key: "s1", stage: "shipped", kind: "confirmed", fulfillmentId: "F1", fulfillmentComplete: false, happenedAt: "2026-11-21T10:00:00Z" }),
      ev({ key: "s2", stage: "shipped", kind: "inferred", fulfillmentId: "F2", fulfillmentComplete: true, happenedAt: "2026-11-21T09:00:00Z" })];
    const t = projectTimeline(evs);
    expect(t.stages.shipped).toMatchObject({ status: "partial", kind: "confirmed", at: "2026-11-21T10:00:00.000Z" });
    expect(t.completeShipmentAt).toBeNull();
    expect(t.fulfillments.find((f) => f.fulfillmentId === "F2")).toMatchObject({ complete: true, kind: "inferred" });
    expect(projectTimeline([...evs].reverse())).toEqual(t);
  });
});

describe("durations only: adjacent stage gaps", () => {
  const at = (h: number) => new Date(Date.parse("2026-11-20T09:00:00Z") + h * 3_600_000).toISOString();
  const o = ev({ key: "o", happenedAt: at(0) });
  const make = (stage: OrderEvidence["stage"], h: number, over: Partial<OrderEvidence> = {}) => ev({ key: `${stage}-${h}`, stage, source: "make", happenedAt: at(h), ...over });
  it("measures only adjacent stages with confirmed endpoints, in the fixed F10+F11 order", () => {
    expect(TIMELINE_SEQUENCE).toEqual(["ordered", "make_submitted", "make_files_found", "make_planned", "make_images_ready", "make_packing_ready", "framed", "dispatched", "shipped", "delivered"]);
    const g = stageGaps(projectTimeline([o, make("make_submitted", 1), make("make_files_found", 3)]));
    expect(g).toHaveLength(TIMELINE_SEQUENCE.length - 1);
    expect(g[0]).toEqual({ from: "ordered", to: "make_submitted", status: "measured", hours: 1 });
    expect(g[1]).toEqual({ from: "make_submitted", to: "make_files_found", status: "measured", hours: 2 });
    expect(g[2]).toMatchObject({ from: "make_files_found", to: "make_planned", status: "unknown", hours: null });
  });
  it("a missing middle stage leaves BOTH neighbouring gaps unknown; it is never skipped over", () => {
    const g = stageGaps(projectTimeline([o, make("make_submitted", 1), make("make_planned", 5)]));
    expect(g.find((x) => x.from === "make_submitted")).toMatchObject({ to: "make_files_found", status: "unknown", hours: null });
    expect(g.find((x) => x.to === "make_planned")).toMatchObject({ from: "make_files_found", status: "unknown", hours: null });
    expect(g.some((x) => x.from === "make_submitted" && x.to === "make_planned")).toBe(false);
  });
  it("unconfirmed/partial endpoints are unknown; negative gaps are anomalies, never negative time", () => {
    const t = projectTimeline([o,
      make("make_submitted", 1, { kind: "inferred" }),
      ev({ key: "f", stage: "framed", source: "app", workType: "framed", happenedAt: at(10) }), // partial framing
      ev({ key: "d", stage: "dispatched", source: "app", happenedAt: at(12) }),
      ev({ key: "s", stage: "shipped", fulfillmentId: "F1", fulfillmentComplete: true, happenedAt: at(11) })]);
    const g = stageGaps(t);
    expect(g[0]).toMatchObject({ status: "unknown", hours: null });
    expect(g.find((x) => x.to === "dispatched")).toMatchObject({ status: "unknown" });
    expect(g.find((x) => x.from === "dispatched")).toEqual({ from: "dispatched", to: "shipped", status: "anomaly", hours: null });
  });
  it("partial shipment never ends the shipped gap; evidence after now is not used", () => {
    const part = projectTimeline([o, ev({ key: "d", stage: "dispatched", source: "app", happenedAt: at(2) }), ev({ key: "s", stage: "shipped", fulfillmentId: "F1", fulfillmentComplete: false, happenedAt: at(3) })]);
    expect(stageGaps(part).find((x) => x.to === "shipped")).toMatchObject({ status: "unknown" });
    const full = projectTimeline([o, ev({ key: "d", stage: "dispatched", source: "app", happenedAt: at(2) }), ev({ key: "s", stage: "shipped", fulfillmentId: "F1", fulfillmentComplete: true, happenedAt: at(3) })]);
    expect(stageGaps(full).find((x) => x.to === "shipped")).toMatchObject({ status: "measured", hours: 1 });
    expect(stageGaps(full, at(2.5)).find((x) => x.to === "shipped")).toMatchObject({ status: "unknown" });
  });
  it("flow metrics aggregate neutral per-gap samples/unknown/anomalies and contain no lateness output", () => {
    const P = { startUtc: "2026-11-20T00:00:00Z", endUtcExclusive: "2026-11-21T00:00:00Z" };
    const t1 = projectTimeline([o, make("make_submitted", 2)]);
    const t2 = projectTimeline([ev({ key: "o2", shopifyOrderId: "2002", happenedAt: at(0) }), make("make_submitted", 4, { shopifyOrderId: "2002" })]);
    const t3 = projectTimeline([ev({ key: "o3", shopifyOrderId: "3003", happenedAt: at(0) })]);
    const m = flowMetrics([t1, t2, t3], P, "2026-11-22T00:00:00Z");
    expect(m.stageGaps[0]).toEqual({ from: "ordered", to: "make_submitted", samples: 2, unknown: 1, anomalies: 0, median: 3, p90: 4 });
    expect(m).not.toHaveProperty("late");
    expect(JSON.stringify(m)).not.toMatch(/late|threshold|sla/i);
  });
});
