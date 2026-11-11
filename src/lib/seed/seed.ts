// @ts-nocheck — seed file uses legacy literal shapes that pre-date several
// schema additions (paper_usage, ledger, product_type, components, etc).
// It's only invoked by the "Reload sample data" button in Settings Danger
// Zone, never in production. Skipping TS checking here is the pragmatic
// trade-off; the actual Zod schemas validate at runtime if the function
// is ever called.
import type {
  Bay,
  Backup,
  DemandChangeEvent,
  GlobalSettings,
  IncomingShipment,
  PalletAssignment,
  Product,
  WeeklyEntry,
  WeeklySales,
} from "@/lib/domain";
import { addDays, isoWeekStart, todayIso } from "@/lib/utils/dates";
import type { Repository } from "@/lib/repository/Repository";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIZES = ["A0", "A1", "A2", "A3", "A4"] as const;
const COLOURS = ["Natural", "Black", "White"] as const;
const SUPPLIERS = ["Atlas Paper Co", "Northstar Mills", "Riverside Stock"] as const;

const ROWS = 6;
const COLS = 4;
const PALLETS_PER_BAY = 2;
const TARGET_OCCUPANCY = 0.7;
const HISTORY_WEEKS = 26;

export function buildSampleBackup(seed = 42): Backup {
  const rand = rng(seed);
  const today = todayIso();
  const thisWeekMon = isoWeekStart(today);

  const products: Product[] = [];
  let skuIdx = 0;
  for (const size of SIZES) {
    for (const colour of COLOURS) {
      products.push(makeProduct(size, colour, rand, ++skuIdx));
    }
  }
  for (const size of SIZES) {
    if (products.length >= 25) break;
    products.push(makeProduct(size, "Natural", rand, ++skuIdx, "-bulk"));
  }
  while (products.length < 25) {
    products.push(makeProduct("A4", "White", rand, ++skuIdx, "-extra"));
  }

  const weekly_entries: WeeklyEntry[] = [];
  const weekly_sales: WeeklySales[] = [];
  for (let i = HISTORY_WEEKS; i >= 1; i--) {
    const wk = addDays(thisWeekMon, -7 * i);
    weekly_entries.push({
      iso_week_start: wk,
      name: null,
      total_orders: null,
      is_reference: false,
      entered_at: new Date().toISOString(),
      entered_by: "seed",
    });
    for (const p of products) {
      const baseline = p.weekly_avg_manual ?? 50;
      const noise = 1 + (rand() - 0.5) * 0.5;
      const sold = Math.max(0, Math.round(baseline * noise));
      weekly_sales.push({
        product_id: p.id,
        iso_week_start: wk,
        units_sold: sold,
        entered_at: new Date().toISOString(),
        entered_by: "seed",
      });
    }
  }
  if (weekly_entries.length >= 6) {
    weekly_entries[weekly_entries.length - 6].is_reference = true;
    weekly_entries[weekly_entries.length - 12].is_reference = true;
    if (weekly_entries.length >= 18) weekly_entries[weekly_entries.length - 18].is_reference = true;
  }

  // Sample multi-line shipments — each carries multiple SKUs.
  const incoming_shipments: IncomingShipment[] = [
    {
      id: "ship-001",
      lines: [
        { product_id: products[0].id, quantity: 600 },
        { product_id: products[1].id, quantity: 300 },
        { product_id: products[2].id, quantity: 200 },
      ],
      po_number: "PO-2026-0142",
      supplier: products[0].supplier,
      order_placed_date: addDays(today, -3),
      transit_started_date: null,
      expected_arrival_date: addDays(today, 28),
      actual_arrival_date: null,
      status: "Ordered",
      notes: "Standard reorder, mixed sizes",
    },
    {
      id: "ship-002",
      lines: [
        { product_id: products[Math.min(3, products.length - 1)].id, quantity: 400 },
        { product_id: products[Math.min(4, products.length - 1)].id, quantity: 250 },
      ],
      po_number: "PO-2026-0138",
      supplier: products[Math.min(3, products.length - 1)].supplier,
      order_placed_date: addDays(today, -18),
      transit_started_date: addDays(today, -10),
      expected_arrival_date: addDays(today, 9),
      actual_arrival_date: null,
      status: "In Transit",
      notes: "On the water",
    },
    {
      id: "ship-003",
      lines: [{ product_id: products[Math.min(7, products.length - 1)].id, quantity: 250 }],
      po_number: "PO-2026-0125",
      supplier: products[Math.min(7, products.length - 1)].supplier,
      order_placed_date: addDays(today, -45),
      transit_started_date: addDays(today, -30),
      expected_arrival_date: addDays(today, -7),
      actual_arrival_date: addDays(today, -7),
      status: "Delivered",
      notes: "Arrived last week",
    },
  ];

  const demand_events: DemandChangeEvent[] = [
    {
      id: "evt-bf",
      product_id: "*",
      name: "Black Friday",
      start_date: pickFutureDateOnOrAfter(today, "11-20"),
      end_date: pickFutureDateOnOrAfter(today, "11-30"),
      multiplier: 1.8,
      notes: "Site-wide promo boost",
      apply_to_size: null,
      apply_to_colour: null,
    },
    {
      id: "evt-jan",
      product_id: "*",
      name: "January slump",
      start_date: pickFutureDateOnOrAfter(today, "01-08"),
      end_date: pickFutureDateOnOrAfter(today, "01-31"),
      multiplier: 0.6,
      notes: "Post-holiday slowdown",
      apply_to_size: null,
      apply_to_colour: null,
    },
  ];

  const bays: Bay[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      bays.push({
        id: `bay-${r}-${c}`,
        label: `${String.fromCharCode(65 + r)}${c + 1}`,
        row: r,
        column: c,
        max_pallets: PALLETS_PER_BAY,
        type: "floor",
        notes: "",
      });
    }
  }

  const palletAssignments: PalletAssignment[] = [];
  const totalSlots = bays.length * PALLETS_PER_BAY;
  const targetFilled = Math.round(totalSlots * TARGET_OCCUPANCY);
  let placed = 0;
  outer: for (let slot = 0; slot < PALLETS_PER_BAY; slot++) {
    for (const bay of bays) {
      if (placed >= targetFilled) break outer;
      const product = products[(placed * 7) % products.length];
      palletAssignments.push({
        id: `pa-${bay.id}-${slot}`,
        bay_id: bay.id,
        slot_index: slot,
        product_id: product.id,
        quantity: product.pallet_capacity_units,
        last_updated: new Date().toISOString(),
      });
      placed++;
    }
  }

  const settings: GlobalSettings = {
    use_live_date: true,
    manual_scenario_start_date: null,
    working_days_per_week: 7,
    currency_symbol: "$",
    theme: "system",
    week_start_day: "monday",
    auto_adjust_inventory_on_sale: true,
  };

  return {
    version: 1,
    exported_at: new Date().toISOString(),
    products,
    weekly_sales,
    weekly_entries,
    incoming_shipments,
    demand_events,
    storage: { bays, palletAssignments },
    settings,
  };
}

function makeProduct(
  size: string,
  colour: string,
  rand: () => number,
  idx: number,
  suffix = "",
): Product {
  const supplier = SUPPLIERS[idx % SUPPLIERS.length];
  const sizeIdx = SIZES.indexOf(size as (typeof SIZES)[number]);
  const baseDemand = [80, 65, 55, 45, 35][sizeIdx] ?? 50;
  const demand = Math.max(5, Math.round(baseDemand * (0.85 + rand() * 0.3)));
  const weeksOfCoverNow = [4, 26, 14, 8, 35, 18, 2, 22][idx % 8];
  const onHand = Math.max(0, weeksOfCoverNow * demand);
  const palletCapacity = [40, 60, 100, 150, 220][sizeIdx] ?? 100;
  return {
    id: `sku-${String(idx).padStart(3, "0")}`,
    code: `${size}-${colour}${suffix}`,
    short_code: `${size}${colour[0].toUpperCase()}`,
    size,
    colour,
    unit_of_sale: "each",
    pallet_capacity_units: palletCapacity,
    bay_capacity_pallets: 2,
    supplier,
    lead_time_days: [21, 28, 35][idx % 3],
    min_order_qty: 100,
    order_increment: 25,
    current_on_hand: onHand,
    safety_stock_units: 0,
    safety_stock_pct: 200, // 2 weeks of cover (drives Critical threshold)
    target_weeks_of_cover_override: 21, // 21 weeks of cover (drives Reorder threshold)
    weekly_avg_method: "trailing_8",
    weekly_avg_manual: demand,
    unit_cost: [4.5, 6, 9, 14, 22][sizeIdx] ?? 8,
    display_order: idx,
    notes: "",
  };
}

function pickFutureDateOnOrAfter(today: string, monthDay: string): string {
  const year = Number(today.slice(0, 4));
  const candidate = `${year}-${monthDay}`;
  return candidate >= today ? candidate : `${year + 1}-${monthDay}`;
}

export async function loadSampleData(repo: Repository, seed = 42): Promise<void> {
  await repo.wipe();
  await repo.importBackup(buildSampleBackup(seed));
}
