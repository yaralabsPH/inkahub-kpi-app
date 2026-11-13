/**
 * Production bench counter (F1 Task 7): the active worker's credit at this
 * station's work type for the current production day, from saved evidence
 * only. There is no local +1: every successful save triggers a fresh read,
 * and reload, staff switch and return to the page use the same projection.
 */
import { summarizeProduction, type PreparedProductionEvidence, type ProductionCoverage, type WorkType } from "./productionCounts";
import { productionRange, type ProductionRange, type ReportSite } from "./productionPeriods";

export interface CounterScope {
  site: ReportSite;
  /** Production date (YYYY-MM-DD), normally productionDateAt(now, site). */
  date: string;
  staffId: string;
  workType: WorkType;
}

export interface CounterCounts {
  items: number | null;
  orders: number;
}

export interface ProductionCounterView {
  range: ProductionRange;
  normal: CounterCounts;
  rework: CounterCounts;
  coverage: ProductionCoverage;
}

export function buildProductionCounterView(evidence: PreparedProductionEvidence, scope: CounterScope): ProductionCounterView {
  const range = productionRange(scope.site, scope.date, scope.date);
  const s = summarizeProduction(evidence, {
    range: { startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive },
    staffIds: [scope.staffId],
    workTypes: [scope.workType],
  });
  return {
    range,
    normal: { items: s.normal.items, orders: s.normal.orders },
    rework: { items: s.rework.items, orders: s.rework.orders },
    coverage: s.coverage,
  };
}
