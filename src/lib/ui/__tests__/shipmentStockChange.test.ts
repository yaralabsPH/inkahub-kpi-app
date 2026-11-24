import { describe, expect, it } from "vitest";
import { shipmentDeleteStockChange, shipmentStatusStockChange, type ShipmentLike } from "../shipmentStockChange";

const ship = (o: Partial<ShipmentLike> = {}): ShipmentLike => ({
  status: "In Transit",
  inventory_applied_at: null,
  lines: [{ product_id: "p1", quantity: 10 }, { product_id: "p2", quantity: 0 }],
  ...o,
});

describe("shipmentStatusStockChange", () => {
  it("moving to Delivered with auto-apply credits the new lines (zero-quantity lines left out)", () => {
    expect(shipmentStatusStockChange(ship(), ship({ status: "Delivered" }), true)).toEqual({
      kind: "credit",
      lines: [{ productId: "p1", quantity: 10 }],
    });
  });
  it("a new shipment saved straight as Delivered credits too", () => {
    expect(shipmentStatusStockChange(null, ship({ status: "Delivered" }), true)?.kind).toBe("credit");
  });
  it("already applied: Delivered to Delivered changes nothing", () => {
    const prev = ship({ status: "Delivered", inventory_applied_at: "2026-11-20T00:00:00Z" });
    expect(shipmentStatusStockChange(prev, { ...prev, lines: [{ product_id: "p1", quantity: 99 }] }, true)).toBeNull();
  });
  it("leaving an applied Delivered reverses the previously credited lines", () => {
    const prev = ship({ status: "Delivered", inventory_applied_at: "2026-11-20T00:00:00Z" });
    expect(shipmentStatusStockChange(prev, ship({ status: "Customs" }), true)).toEqual({
      kind: "reverse",
      lines: [{ productId: "p1", quantity: 10 }],
    });
  });
  it("leaving a Delivered that was never applied changes nothing", () => {
    expect(shipmentStatusStockChange(ship({ status: "Delivered" }), ship({ status: "Customs" }), true)).toBeNull();
  });
  it("auto-apply off: status changes never touch stock", () => {
    expect(shipmentStatusStockChange(ship(), ship({ status: "Delivered" }), false)).toBeNull();
    const prev = ship({ status: "Delivered", inventory_applied_at: "x" });
    expect(shipmentStatusStockChange(prev, ship({ status: "Customs" }), false)).toBeNull();
  });
  it("other moves change nothing", () => {
    expect(shipmentStatusStockChange(ship({ status: "Ordered" }), ship({ status: "In Transit" }), true)).toBeNull();
  });
  it("does not mutate its inputs", () => {
    const prev = ship();
    const next = ship({ status: "Delivered" });
    const snap = JSON.stringify([prev, next]);
    shipmentStatusStockChange(prev, next, true);
    expect(JSON.stringify([prev, next])).toBe(snap);
  });
});

describe("shipmentDeleteStockChange", () => {
  it("deleting an applied shipment reverses its lines, whatever the auto-apply setting", () => {
    expect(shipmentDeleteStockChange(ship({ status: "Delivered", inventory_applied_at: "x" }))).toEqual({
      kind: "reverse",
      lines: [{ productId: "p1", quantity: 10 }],
    });
  });
  it("deleting an unapplied shipment changes nothing", () => {
    expect(shipmentDeleteStockChange(ship())).toBeNull();
  });
});
