/**
 * Task 16: the Reports "slowest variants" board from the database's bounded
 * per-SKU timing aggregates, grouped by size + variant with the SAME shared
 * SKU parser and ordering as buildProductionReportView (top 20).
 */
import { parseSku } from "../../src/lib/domain/skuRouting.js";
import { SKU_BOARD_MAX, type ReportSkuDto } from "../../src/lib/domain/productionReporting.js";

export interface SkuTiming { sku: string; durationMin: number; weight: number }

export function skuBoardFrom(rows: readonly SkuTiming[]): ReportSkuDto[] {
  const by = new Map<string, ReportSkuDto>();
  for (const r of rows) {
    const p = parseSku(r.sku);
    if (!p || !p.size || !p.variant) continue;
    const key = p.type === "picture_frame" ? `PF ${p.size}-${p.variant}` : `${p.size}-${p.variant}`;
    const row = by.get(key) ?? { sku: key, weight: 0, durationMin: 0, avgMin: 0 };
    row.durationMin += Number(r.durationMin);
    row.weight += Number(r.weight);
    by.set(key, row);
  }
  return [...by.values()]
    .map((r) => ({ ...r, avgMin: r.weight > 0 ? r.durationMin / r.weight : 0 }))
    .sort((a, b) => b.avgMin - a.avgMin || (a.sku < b.sku ? -1 : 1))
    .slice(0, SKU_BOARD_MAX);
}
