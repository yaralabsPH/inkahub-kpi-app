import type {
  DemandChangeEvent,
  IncomingShipment,
  Product,
  WeeklyEntry,
  WeeklySales,
} from "@/lib/domain";
import { effectiveSafetyStock } from "@/lib/domain";
import {
  addDays,
  diffDays,
  isoWeekStart,
  nextMonday,
  rangesOverlap,
  todayIso,
} from "@/lib/utils/dates";
import { computeWeeklyAverage } from "./weeklyAverage";

export type StatusPill = "OK" | "Reorder" | "Critical" | "OOS";

export interface WeeklyProjectionRow {
  week: number;
  weekStart: string;
  arrivals: number;
  multiplier: number;
  demand: number;
  stockEnd: number;
}

export interface ForecastResult {
  productId: string;
  scenarioStart: string;
  weeklyAverage: number;
  startingStock: number;
  rows: WeeklyProjectionRow[];

  weeksUntilOosCurrent: number | null;
  weeksUntilOosSafety: number | null;
  /**
   * Weeks remaining before you must place an order to avoid running out —
   * `weeksUntilOosCurrent − ceil(leadTime / 7)`, clamped at 0. Null if the
   * SKU isn't projected to deplete within the horizon. This is the truly
   * actionable number; "weeks until OOS" is the cliff behind it.
   */
  weeksUntilReorderRequired: number | null;
  daysUntilOos: number | null;
  targetStock: number;
  adjustedStock: number;
  /**
   * Cumulative units of demand the SKU couldn't physically fulfil during
   * the lead-time window — i.e. lost sales while OOS. Zero for any SKU
   * that doesn't go OOS before a new order would arrive. Surfaced for the
   * Order builder's optional "Cover backorders" toggle.
   */
  unfulfilledDemand: number;
  suggestedOrderQty: number;
  reorderByDate: string;
  status: StatusPill;
}

export interface ForecastInput {
  product: Product;
  sales: readonly WeeklySales[];
  shipments: readonly IncomingShipment[];
  events: readonly DemandChangeEvent[];
  entries?: readonly WeeklyEntry[];
  options: ForecastOptions;
}

export interface ForecastOptions {
  useRestocks: boolean;
  useDemandChanges: boolean;
  blanketDemandMultiplier?: number;
  manualAdjustment?: number;
  leadTimeOverride?: number;
  targetWeeksOverride?: number;
  startingStockOverride?: number;
  scenarioStart?: string;
  today?: string;
}

export const HORIZON_WEEKS = 52;

export function forecast(input: ForecastInput): ForecastResult {
  const { product, sales, shipments, events, entries = [], options } = input;

  const today = options.today ?? todayIso();
  const scenarioStart = options.scenarioStart ?? nextMonday(today);

  const weeklyAverage = computeWeeklyAverage(product, sales, entries);

  const blanket = options.blanketDemandMultiplier ?? 1;
  const manualAdj = options.manualAdjustment ?? 0;
  const leadTime = options.leadTimeOverride ?? product.lead_time_days;
  // Per-SKU thresholds:
  //   - Critical fires when weeks_left < lead_time_weeks (can't physically
  //     resupply in time even with an immediate order).
  //   - Reorder fires when weeks_left < safety_stock_pct / 100 (stock below
  //     the desired buffer).
  // target_weeks_of_cover_override no longer drives status — it only sizes
  // the Order builder's suggested qty (targetStock = avg × targetWeeks).
  const leadTimeWeeks = Math.max(1, Math.ceil(leadTime / 7));
  const targetWeeks =
    options.targetWeeksOverride ?? product.target_weeks_of_cover_override;
  const safetyWeeks = (product.safety_stock_pct ?? 0) / 100;

  const startingStock = Math.max(
    (options.startingStockOverride ?? product.current_on_hand) - manualAdj,
    0,
  );

  // Sum arrivals per week, scanning every line of every shipment that
  // includes this product.
  const arrivalsByWeek = new Array<number>(HORIZON_WEEKS + 1).fill(0);
  if (options.useRestocks) {
    for (const s of shipments) {
      // "Cancelled" + "On hold" both opt out of the projection. Treat them
      // as if the order doesn't exist for forecasting / Suggested-qty math.
      // The user can drag an order into "On hold" to see the stockout
      // heatmap without that PO without losing its data.
      // "Delivered" excluded too: at delivery the stock is added to
      // current_on_hand, so treating it as a future arrival on the same
      // date would count the same units twice (warehouse heat-map + all
      // stock-end projections would inflate). Cancelled / On hold /
      // Back-Ordered stay out for pipeline hygiene as before.
      if (
        s.status === "Cancelled" ||
        s.status === "On hold" ||
        s.status === "Back-Ordered" ||
        s.status === "Delivered"
      ) continue;
      const active = s.actual_arrival_date ?? s.expected_arrival_date;
      const week = weekIndexOf(active, scenarioStart);
      if (week < 1 || week > HORIZON_WEEKS) continue;
      // Multi-line shipments: pick out the line(s) for this product.
      // Defensively coerce in case an older record was written without `lines`.
      const lines = Array.isArray(s.lines) ? s.lines : [];
      for (const line of lines) {
        if (line.product_id === product.id) {
          arrivalsByWeek[week] += line.quantity;
        }
      }
      // Legacy single-line fallback (in case migration didn't run).
      if (lines.length === 0 && s.product_id === product.id && s.quantity) {
        arrivalsByWeek[week] += s.quantity;
      }
    }
  }

  const applicableEvents = options.useDemandChanges
    ? events.filter((e) => eventAppliesToProduct(e, product))
    : [];

  // Effective safety floor in units, derived from the SKU's safety_stock_pct
  // applied to its current weekly average demand. (Falls back to legacy
  // safety_stock_units for SKUs that haven't been migrated.)
  const safetyFloor = effectiveSafetyStock(product, weeklyAverage);

  const rows: WeeklyProjectionRow[] = [];
  let stock = startingStock;
  // Parallel unclamped track — same arithmetic but allowed to go negative.
  // The negative portion is the cumulative "lost demand" the SKU couldn't
  // physically fulfil. We compare clamped vs unclamped at lead-time arrival
  // to surface `unfulfilledDemand` on the forecast result, which the order
  // builder uses for the optional backorder-coverage toggle.
  let stockUnclamped = startingStock;
  const stockUnclampedByWeek = new Array<number>(HORIZON_WEEKS + 1).fill(startingStock);
  let weeksUntilOosCurrent: number | null = stock <= 0 ? 0 : null;
  let weeksUntilOosSafety: number | null =
    stock <= safetyFloor ? 0 : null;

  for (let w = 1; w <= HORIZON_WEEKS; w++) {
    const weekStart = addDays(scenarioStart, (w - 1) * 7);
    const weekEnd = addDays(weekStart, 6);

    const multiplier = compoundMultiplier(applicableEvents, weekStart, weekEnd);
    const arrivals = arrivalsByWeek[w];
    const demand = weeklyAverage * multiplier * blanket;

    stock = Math.max(stock + arrivals - demand, 0);
    stockUnclamped += arrivals - demand;
    stockUnclampedByWeek[w] = stockUnclamped;

    if (weeksUntilOosCurrent === null && stock <= 0) weeksUntilOosCurrent = w;
    if (weeksUntilOosSafety === null && stock <= safetyFloor)
      weeksUntilOosSafety = w;

    rows.push({ week: w, weekStart, arrivals, multiplier, demand, stockEnd: stock });
  }

  const targetStock = weeklyAverage * targetWeeks;
  // "Adjusted stock" for the suggested-qty calc is the projected stock at
  // the moment a *new* order placed today would arrive — i.e. after the
  // SKU's lead time, accounting for incoming pipeline shipments and the
  // demand drawn during that period. Sources from the engine's already-
  // computed projection rows so it benefits from the same arrivals,
  // demand events, and zero-clamp logic. Implication:
  //   - Pipeline shipping in next week with lead=8w → counted, gap shrinks.
  //   - Pipeline shipping in week 30 with lead=8w → ignored this cycle.
  //   - SKU that goes OOS during lead time → projected = 0 (clamped), so
  //     Suggested ≈ target_stock (we're not asked to recover lost sales).
  const arrivalIdx = Math.min(leadTimeWeeks, rows.length) - 1;
  const adjustedStock = arrivalIdx >= 0 ? rows[arrivalIdx].stockEnd : startingStock;
  // Cumulative lost demand during lead time = clamped (>= 0) minus unclamped
  // (can be negative). When a SKU runs OOS for some weeks before the new
  // order arrives, this is the units of demand that physically couldn't be
  // sold. The order builder's "Cover backorders" toggle adds this to the
  // suggested qty so the next order recovers those lost sales.
  const unclampedAtArrival = arrivalIdx >= 0 ? stockUnclampedByWeek[arrivalIdx + 1] : startingStock;
  const unfulfilledDemand = Math.max(0, adjustedStock - unclampedAtArrival);
  const suggestedOrderQty = computeSuggestedOrderQty(targetStock, adjustedStock, product);
  const reorderByDate = computeReorderByDate(today, weeksUntilOosCurrent, leadTime);
  const daysUntilOos = weeksUntilOosCurrent === null ? null : weeksUntilOosCurrent * 7;
  const leadWeeks = Math.ceil(leadTime / 7);
  const weeksUntilReorderRequired =
    weeksUntilOosCurrent === null ? null : Math.max(weeksUntilOosCurrent - leadWeeks, 0);
  const status = computeStatus(weeksUntilOosCurrent, leadTimeWeeks, safetyWeeks);

  return {
    productId: product.id,
    scenarioStart,
    weeklyAverage,
    startingStock,
    rows,
    weeksUntilOosCurrent,
    weeksUntilOosSafety,
    weeksUntilReorderRequired,
    daysUntilOos,
    targetStock,
    adjustedStock,
    unfulfilledDemand,
    suggestedOrderQty,
    reorderByDate,
    status,
  };
}

export function weekIndexOf(iso: string, scenarioStart: string): number {
  const wkStart = isoWeekStart(iso);
  // Days from scenarioStart → the Monday containing iso. Local-time arithmetic
  // keeps this stable across DST without relying on Date.parse.
  const days = diffDays(scenarioStart, wkStart);
  return Math.floor(days / 7) + 1;
}

function compoundMultiplier(
  events: readonly DemandChangeEvent[],
  weekStart: string,
  weekEnd: string,
): number {
  let m = 1;
  for (const e of events) {
    if (rangesOverlap(weekStart, weekEnd, e.start_date, e.end_date)) m *= e.multiplier;
  }
  return m;
}

function eventAppliesToProduct(e: DemandChangeEvent, p: Product): boolean {
  if (e.product_id === p.id) return true;
  if (e.product_id === "*") {
    if (e.apply_to_size && e.apply_to_size !== p.size) return false;
    if (e.apply_to_colour && e.apply_to_colour !== p.colour) return false;
    return true;
  }
  return false;
}

function computeSuggestedOrderQty(target: number, onHand: number, product: Product): number {
  const gap = Math.max(target - onHand, 0);
  if (gap === 0) return 0;
  const inc = Math.max(product.order_increment, 1);
  const rounded = Math.ceil(gap / inc) * inc;
  return Math.max(rounded, product.min_order_qty);
}

function computeReorderByDate(today: string, weeksUntilOos: number | null, leadTimeDays: number): string {
  if (weeksUntilOos === null) return addDays(today, HORIZON_WEEKS * 7);
  const leadWeeks = Math.ceil(leadTimeDays / 7);
  const slackWeeks = Math.max(weeksUntilOos - leadWeeks, 0);
  return addDays(today, slackWeeks * 7);
}

function computeStatus(weeksUntilOos: number | null, leadTimeWeeks: number, safetyWeeks: number): StatusPill {
  if (weeksUntilOos !== null && weeksUntilOos <= 0) return "OOS";
  if (weeksUntilOos !== null && weeksUntilOos < leadTimeWeeks) return "Critical";
  if (weeksUntilOos !== null && weeksUntilOos < safetyWeeks) return "Reorder";
  return "OK";
}
