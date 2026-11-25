import { describe, expect, it } from "vitest";
import { IncomingShipmentSchema, ProductSchema, type IncomingShipment, type Product } from "@/lib/domain";
import { addDays } from "@/lib/utils/dates";
import { forecast, type ForecastOptions } from "../engine";

function product(over: Partial<Product>): Product {
  return ProductSchema.parse({
    id: "sku-test",
    code: "TEST",
    pallet_capacity_units: 100,
    bay_capacity_pallets: 1,
    supplier: "CHINA",
    lead_time_days: 90,
    current_on_hand: 40,
    weekly_avg_method: "manual",
    weekly_avg_manual: 16,
    target_weeks_of_cover_override: 15,
    ...over,
  });
}

/** Same shape the Shopping list's "Create purchase orders" button saves. */
function orderPlacedToday(p: Product, qty: number, today: string, id = "ship-1"): IncomingShipment {
  return IncomingShipmentSchema.parse({
    id,
    po_number: `PO-${id}`,
    supplier: p.supplier,
    order_placed_date: today,
    transit_started_date: null,
    expected_arrival_date: addDays(today, p.lead_time_days),
    actual_arrival_date: null,
    lines: [{ product_id: p.id, quantity: qty }],
    status: "Ordered",
    notes: "",
  });
}

const opts = (today: string): ForecastOptions => ({ useRestocks: true, useDemandChanges: false, today });

function run(p: Product, shipments: IncomingShipment[], today: string) {
  return forecast({ product: p, sales: [], shipments, events: [], options: opts(today) });
}

// One date per weekday, so the arrival can land on any day of its week.
const TODAYS = [
  "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26",
  "2026-11-27", "2026-11-28", "2026-11-29",
];

describe("forecast suggestedOrderQty", () => {
  it.each(TODAYS)("drops to 0 after the suggested order is placed (SKU out of stock before arrival, today %s)", (today) => {
    // 40 on hand, 16/week, 13-week lead: out of stock long before arrival.
    const p = product({});
    const first = run(p, [], today).suggestedOrderQty;
    expect(first).toBeGreaterThan(0);
    const after = run(p, [orderPlacedToday(p, first, today)], today).suggestedOrderQty;
    expect(after).toBe(0);
  });

  it.each(TODAYS)("drops to 0 after the suggested order when MOQ and increments apply (today %s)", (today) => {
    const p = product({
      supplier: "PACKING FOAMS",
      lead_time_days: 65,
      current_on_hand: 2220,
      weekly_avg_manual: 300,
      target_weeks_of_cover_override: 9,
      min_order_qty: 1000,
      order_increment: 75,
    });
    const first = run(p, [], today).suggestedOrderQty;
    expect(first).toBeGreaterThan(0);
    expect(run(p, [orderPlacedToday(p, first, today)], today).suggestedOrderQty).toBe(0);
  });

  it("covers the target plus the arrival week's demand when the SKU is out of stock at arrival", () => {
    const p = product({ current_on_hand: 0 });
    const r = run(p, [], "2026-11-25");
    // target 15 × 16 = 240, plus the arrival week's 16.
    expect(r.suggestedOrderQty).toBe(256);
    expect(r.adjustedStock).toBe(-16);
  });

  it("is unchanged for a SKU that still has stock when the order arrives", () => {
    // 1000 on hand, 13 weeks × 16 = 208 drawn → 792 at arrival; target 240.
    const p = product({ current_on_hand: 1000 });
    const r = run(p, [], "2026-11-25");
    expect(r.adjustedStock).toBe(1000 - 13 * 16);
    expect(r.suggestedOrderQty).toBe(0);
  });

  it("does not count the arrival week twice when backorders are covered", () => {
    // Out of stock from day one: weeks 1..12 are lost before arrival.
    const p = product({ current_on_hand: 0 });
    const r = run(p, [], "2026-11-25");
    expect(r.unfulfilledDemand).toBe(12 * 16);
    // Order builder with "Cover backorders": gap + lost = 256 + 192 = 448,
    // the same 13 weeks of lost demand + target the old engine produced.
    expect(r.targetStock - r.adjustedStock + r.unfulfilledDemand).toBe(240 + 13 * 16);
  });
});
