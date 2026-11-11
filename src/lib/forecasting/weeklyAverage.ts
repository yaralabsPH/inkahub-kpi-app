import type { Product, WeeklyEntry, WeeklySales } from "@/lib/domain";

/**
 * Weights for the "weighted" trailing-8 method, oldest → newest.
 * Sum to 1.00 by construction. Most recent week has the heaviest weight.
 */
export const WEIGHTED_TRAILING_8: readonly number[] = [
  0.05, 0.05, 0.1, 0.1, 0.1, 0.15, 0.2, 0.25,
] as const;

function lastN(
  sales: readonly WeeklySales[],
  productId: string,
  n: number,
): WeeklySales[] {
  return sales
    .filter((s) => s.product_id === productId)
    .slice()
    .sort((a, b) => a.iso_week_start.localeCompare(b.iso_week_start))
    .slice(-n);
}

/**
 * Compute the SKU's weekly average orders `D` per its `weekly_avg_method`.
 *
 * Methods:
 *  - trailing_8 / trailing_12: arithmetic mean of last N weeks of units_sold.
 *  - weighted: weighted mean over last 8 with WEIGHTED_TRAILING_8 (renormalised
 *    if fewer rows are available).
 *  - manual: returns `weekly_avg_manual` (defaults to 0).
 *  - selected_weeks: arithmetic mean of WeeklySales rows whose iso_week_start
 *    matches a WeeklyEntry with `is_reference=true`.
 *
 * Fallback: when the chosen method yields 0 (no sales, no starred reference
 * weeks, etc.) but `weekly_avg_manual` is set, the manual value is used.
 * This means a SKU with a known typical demand still drives forecasts /
 * order math even before any historical sales rows have been entered.
 * The method selection still wins whenever it produces a non-zero number.
 */
export function computeWeeklyAverage(
  product: Product,
  sales: readonly WeeklySales[],
  entries: readonly WeeklyEntry[] = [],
): number {
  const fallback = product.weekly_avg_manual && product.weekly_avg_manual > 0
    ? product.weekly_avg_manual
    : 0;
  const orFallback = (v: number) => (v > 0 ? v : fallback);

  if (product.weekly_avg_method === "manual") {
    return product.weekly_avg_manual ?? 0;
  }

  if (product.weekly_avg_method === "trailing_8") {
    const window = lastN(sales, product.id, 8);
    return orFallback(arithmeticMean(window.map((s) => s.units_sold)));
  }

  if (product.weekly_avg_method === "trailing_12") {
    const window = lastN(sales, product.id, 12);
    return orFallback(arithmeticMean(window.map((s) => s.units_sold)));
  }

  if (product.weekly_avg_method === "selected_weeks") {
    const refWeeks = new Set(
      entries.filter((e) => e.is_reference).map((e) => e.iso_week_start),
    );
    if (refWeeks.size === 0) return fallback;
    const rows = sales.filter(
      (s) => s.product_id === product.id && refWeeks.has(s.iso_week_start),
    );
    return orFallback(arithmeticMean(rows.map((s) => s.units_sold)));
  }

  // weighted
  const window = lastN(sales, product.id, 8);
  if (window.length === 0) return fallback;
  const weights = WEIGHTED_TRAILING_8.slice(-window.length);
  const wSum = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < window.length; i++) {
    acc += window[i].units_sold * weights[i];
  }
  const weighted = wSum === 0 ? 0 : acc / wSum;
  return orFallback(weighted);
}

function arithmeticMean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}
