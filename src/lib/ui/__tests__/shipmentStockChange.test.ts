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
    expect(shipmentStatusStockChange(ship(), ship({ status: "Delivered" }), true, "supabase")).toEqual({
      kind: "credit",
      lines: [{ productId: "p1", quantity: 10 }],
    });
  });
  it("a new shipment saved straight as Delivered credits too", () => {
    expect(shipmentStatusStockChange(null, ship({ status: "Delivered" }), true, "supabase")?.kind).toBe("credit");
  });
  it("already applied: Delivered to Delivered changes nothing", () => {
    const prev = ship({ status: "Delivered", inventory_applied_at: "2026-11-20T00:00:00Z" });
    expect(shipmentStatusStockChange(prev, { ...prev, lines: [{ product_id: "p1", quantity: 99 }] }, true, "supabase")).toBeNull();
  });
  it("leaving an applied Delivered reverses the previously credited lines", () => {
    const prev = ship({ status: "Delivered", inventory_applied_at: "2026-11-20T00:00:00Z" });
    expect(shipmentStatusStockChange(prev, ship({ status: "Customs" }), true, "supabase")).toEqual({
      kind: "reverse",
      lines: [{ productId: "p1", quantity: 10 }],
    });
  });
  it("leaving a Delivered that was never applied changes nothing", () => {
    expect(shipmentStatusStockChange(ship({ status: "Delivered" }), ship({ status: "Customs" }), true, "supabase")).toBeNull();
  });
  it("auto-apply off: status changes never touch stock", () => {
    expect(shipmentStatusStockChange(ship(), ship({ status: "Delivered" }), false, "supabase")).toBeNull();
    const prev = ship({ status: "Delivered", inventory_applied_at: "x" });
    expect(shipmentStatusStockChange(prev, ship({ status: "Customs" }), false, "supabase")).toBeNull();
  });
  it("other moves change nothing", () => {
    expect(shipmentStatusStockChange(ship({ status: "Ordered" }), ship({ status: "In Transit" }), true, "supabase")).toBeNull();
  });
  it("does not mutate its inputs", () => {
    const prev = ship();
    const next = ship({ status: "Delivered" });
    const snap = JSON.stringify([prev, next]);
    shipmentStatusStockChange(prev, next, true, "supabase");
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

describe("backend differences (review r1 M2)", () => {
  // deliver with auto-apply on, turn it off, move to In Transit (marker kept), turn it on, save as Ordered
  const prev = ship({ status: "In Transit", inventory_applied_at: "2026-11-20T00:00:00Z" });
  const next = ship({ status: "Ordered" });
  it("Dexie reverses when the applied marker exists even if the previous status is not Delivered", () => {
    expect(shipmentStatusStockChange(prev, next, true, "dexie")).toEqual({ kind: "reverse", lines: [{ productId: "p1", quantity: 10 }] });
  });
  it("Supabase only reverses when leaving an applied Delivered", () => {
    expect(shipmentStatusStockChange(prev, next, true, "supabase")).toBeNull();
  });
  it("auto-apply off: neither backend changes stock", () => {
    expect(shipmentStatusStockChange(prev, next, false, "dexie")).toBeNull();
    expect(shipmentStatusStockChange(prev, next, false, "supabase")).toBeNull();
  });
  it("archive of an unapplied Delivered shipment (status unchanged) credits on both backends", () => {
    const d = ship({ status: "Delivered", inventory_applied_at: null });
    for (const b of ["dexie", "supabase"] as const) {
      expect(shipmentStatusStockChange(d, { ...d }, true, b)?.kind).toBe("credit");
    }
  });
  it("Dexie: re-saving Delivered with a marker changes nothing", () => {
    const d = ship({ status: "Delivered", inventory_applied_at: "x" });
    expect(shipmentStatusStockChange(d, d, true, "dexie")).toBeNull();
  });
});
