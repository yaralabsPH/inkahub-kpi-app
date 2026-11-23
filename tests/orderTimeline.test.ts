/** F10 Task 1: evidence model and pure projection (synthetic fixtures). */
import { describe, expect, it } from "vitest";
import {
  flowMetrics,
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
    expect(t.stages.framed.status).toBe("confirmed");
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
    ], P, "2026-11-22T00:00:00Z", null);
    expect([m.cohort, m.completeShipmentSamples, m.openOrders]).toEqual([3, 2, 1]);
    expect(m.orderToShipHours).toEqual({ median: 10, p90: 20 });
    expect(m.late).toEqual({ configured: false, reason: "Late-order rule not configured" });
  });
  it("negative gaps are excluded as anomalies, never shown as negative time", () => {
    const m = flowMetrics([order("1", "2026-11-20T05:00:00Z", "2026-11-20T04:00:00Z")], P, "2026-11-22T00:00:00Z", null);
    expect(m.completeShipmentSamples).toBe(0);
    expect(m.anomalies).toBe(1);
  });
  it("late orders need a configured positive threshold and exclude shipped/cancelled", () => {
    const list = [order("1", "2026-11-20T00:00:00Z", null), order("2", "2026-11-20T20:00:00Z", null), order("3", "2026-11-20T00:00:00Z", "2026-11-20T10:00:00Z")];
    const m = flowMetrics(list, P, "2026-11-21T12:00:00Z", 24);
    expect(m.late).toMatchObject({ configured: true, thresholdHours: 24, count: 1 });
    expect(() => flowMetrics(list, P, "2026-11-21T12:00:00Z", 0)).toThrow();
  });
});
