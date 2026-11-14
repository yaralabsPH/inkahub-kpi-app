/**
 * Reports projections over one prepared evidence snapshot (F1 Task 5).
 *
 * Every count comes from `summarizeProduction`; this module only selects
 * scopes and formats rows. Longer-period Orders are distinct unions of order
 * identities for that period, never sums of daily/department/person counts.
 * Frame timing comes from productionFrameTiming.ts and never uses Items.
 */
import {
  overallOrderKey,
  prepareProductionEvidence,
  summarizeProduction,
  type CountGroup,
  type PreparedProductionEvidence,
  type ProductionEvidenceEvent,
  type ProductionScope,
  type ProductionSummary,
  type ProductionVisibility,
  type WorkType,
} from "./productionCounts";
import { productionDatesBetween, productionRange, type ProductionRange } from "./productionPeriods";
import { frameTimingLines, frameTimingTotals, type FrameTimingTotals } from "./productionFrameTiming";
import { parseSku } from "./skuRouting";

export interface ReportScope {
  range: ProductionRange;
  /** Selected person (tiles, drill-down); null = everyone visible. */
  staffId?: string | null;
  /** Selected work type; null = all. */
  workType?: WorkType | null;
}

export interface ItemsOrders {
  items: number | null;
  orders: number;
}

export interface ReportDay {
  date: string;
  normal: ItemsOrders;
  rework: ItemsOrders;
}

export interface ReportPersonRow {
  staffId: string;
  normal: ItemsOrders;
  rework: ItemsOrders;
  /** Production dates with any credited Items or Orders. */
  daysWorked: number;
  itemsPerDay: number;
  ordersPerDay: number;
  timing: FrameTimingTotals;
}

export interface ReportOrderRow {
  key: string;
  orderNumber: string;
  caseId: string | null;
  group: "normal" | "rework";
  firstMs: number;
  lastMs: number;
  workTypes: WorkType[];
  /** Effective (not cancelled) verified lines by the selected person. */
  verifiedLines: number;
  /** The selected person's credited Items on this order. */
  items: number | null;
  /** Completed or dispatched by the selected person in this range. */
  completed: boolean;
}

export interface ReportSkuRow {
  sku: string;
  weight: number;
  durationMin: number;
  avgMin: number;
}

export interface ProductionReportView {
  /** Tiles: range + selected person + work type. */
  summary: ProductionSummary;
  /**
   * Coverage for everything on the page: the tiles AND the all-visible
   * leaderboard (a superset when a person is selected), so another person's
   * data gap is not hidden while their row is shown.
   */
  coverage: ProductionSummary["coverage"];
  dispatchedOrders: number;
  timing: FrameTimingTotals;
  /** People with credited Items or Orders in the tile scope. */
  activeStaff: number;
  /** All visible people for the work type (ignores the person filter on purpose). */
  leaderboard: ReportPersonRow[];
  /** True when a person is selected, so tiles and leaderboard cover different people. */
  leaderboardScopeDiffers: boolean;
  /** Staff-days behind the tile average: all visible people, or the selected person's days. */
  staffDays: number;
  avgOrdersPerStaffDay: number;
  staffOrders: ReportOrderRow[];
  /** Selected person's per-day series and range totals (union over the range). */
  personDaily: ReportDay[] | null;
  personTotals: { normal: ItemsOrders; rework: ItemsOrders } | null;
  skuBoard: ReportSkuRow[];
  /** Raw display rows for CSV: in range, person/work-type filtered, quantities untouched. */
  exportEvents: ProductionEvidenceEvent[];
}

const io = (g: CountGroup): ItemsOrders => ({ items: g.items, orders: g.orders });
const EMPTY: ItemsOrders = { items: 0, orders: 0 };

function baseScope(scope: ReportScope, range: { startUtc: string; endUtcExclusive: string } = scope.range): ProductionScope {
  return {
    range: { startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive },
    ...(scope.workType ? { workTypes: [scope.workType] } : {}),
  };
}

export function buildProductionReportView(evidence: PreparedProductionEvidence, scope: ReportScope): ProductionReportView {
  const staffId = scope.staffId ?? null;
  const base = baseScope(scope);
  const tileScope: ProductionScope = staffId ? { ...base, staffIds: [staffId] } : base;
  const summary = summarizeProduction(evidence, tileScope);
  const everyone = staffId ? summarizeProduction(evidence, base) : summary;

  // Per production date, everyone (person credit is the same with or without a person filter).
  const dates = productionDatesBetween(scope.range.firstDate, scope.range.lastDate);
  const days = dates.map((date) => {
    const r = productionRange(scope.range.site, date, date);
    return { date, s: summarizeProduction(evidence, baseScope(scope, r)) };
  });

  // Timing: the whole visible stream for the work type, then split per person.
  const allTiming = frameTimingLines(evidence, base);
  const timingFor = (id: string | null) => frameTimingTotals(id ? allTiming.filter((l) => l.staffId === id) : allTiming);

  const leaderboard: ReportPersonRow[] = Object.entries(everyone.byPerson).map(([id, g]) => {
    const daysWorked = days.filter(({ s }) => {
      const p = s.byPerson[id];
      return !!p && ((p.normal.items ?? 0) > 0 || p.normal.orders > 0 || (p.rework.items ?? 0) > 0 || p.rework.orders > 0);
    }).length;
    const items = g.normal.items ?? 0;
    return {
      staffId: id,
      normal: io(g.normal),
      rework: io(g.rework),
      daysWorked,
      itemsPerDay: daysWorked > 0 ? items / daysWorked : 0,
      ordersPerDay: daysWorked > 0 ? g.normal.orders / daysWorked : 0,
      timing: timingFor(id),
    };
  });
  leaderboard.sort((a, b) => b.normal.orders - a.normal.orders || (b.normal.items ?? 0) - (a.normal.items ?? 0) || (a.staffId < b.staffId ? -1 : 1));
  // Tile denominator matches the tile's scope: everyone's staff-days, or only
  // the selected person's days (adding another worker never lowers A's rate).
  const staffDays = staffId
    ? leaderboard.find((r) => r.staffId === staffId)?.daysWorked ?? 0
    : leaderboard.reduce((n, r) => n + r.daysWorked, 0);

  // Selected person's orders, with touch times from their own effective evidence.
  let staffOrders: ReportOrderRow[] = [];
  if (staffId) {
    const startMs = Date.parse(scope.range.startUtc);
    const endMs = Date.parse(scope.range.endUtcExclusive);
    const types = scope.workType ? new Set<string>([scope.workType]) : null;
    const touch = new Map<string, { first: number; last: number; workTypes: Set<WorkType>; lines: number }>();
    const mark = (location: string, order: string, caseId: string | null, ms: number, wt: WorkType, line: boolean) => {
      const key = overallOrderKey(location, order, caseId);
      const t = touch.get(key) ?? { first: ms, last: ms, workTypes: new Set<WorkType>(), lines: 0 };
      t.first = Math.min(t.first, ms);
      t.last = Math.max(t.last, ms);
      t.workTypes.add(wt);
      if (line) t.lines++;
      touch.set(key, t);
    };
    const inScope = (ms: number, wt: WorkType, who: string | null) => who === staffId && ms >= startMs && ms < endMs && (!types || types.has(wt));
    for (const v of evidence.verifications) {
      if (v.effective && inScope(v.ev.ms, v.workType, v.ev.staff_id)) mark(v.ev.location, v.ev.orderKey, v.caseId, v.ev.ms, v.workType, true);
    }
    for (const t of evidence.terminals) {
      if (!t.reversed && inScope(t.ev.ms, t.workType, t.ev.staff_id)) mark(t.ev.location, t.ev.orderKey, t.caseId, t.ev.ms, t.workType, false);
    }
    staffOrders = summary.orders
      .filter((o) => touch.has(o.key))
      .map((o) => {
        const t = touch.get(o.key)!;
        return {
          key: o.key,
          orderNumber: o.orderNumber,
          caseId: o.caseId,
          group: o.group,
          firstMs: t.first,
          lastMs: t.last,
          workTypes: [...t.workTypes].sort(),
          verifiedLines: t.lines,
          items: o.items,
          completed: o.completedBy.includes(staffId),
        };
      })
      .sort((a, b) => b.lastMs - a.lastMs || (a.key < b.key ? -1 : 1));
  }

  const personDaily = staffId
    ? days.map(({ date, s }) => {
        const p = s.byPerson[staffId];
        return { date, normal: p ? io(p.normal) : EMPTY, rework: p ? io(p.rework) : EMPTY };
      })
    : null;
  const personTotals = staffId ? { normal: io(summary.normal), rework: io(summary.rework) } : null;

  // Slowest variants: frame timing only, grouped by size + variant.
  const sku = new Map<string, ReportSkuRow>();
  for (const l of staffId ? allTiming.filter((x) => x.staffId === staffId) : allTiming) {
    if (!l.sku || l.weight <= 0) continue;
    const p = parseSku(l.sku);
    if (!p || !p.size || !p.variant) continue;
    const key = p.type === "picture_frame" ? `PF ${p.size}-${p.variant}` : `${p.size}-${p.variant}`;
    const row = sku.get(key) ?? { sku: key, weight: 0, durationMin: 0, avgMin: 0 };
    row.durationMin += l.durationMin;
    if (l.durationMin > 0) row.weight += l.weight;
    sku.set(key, row);
  }
  const skuBoard = [...sku.values()]
    .map((r) => ({ ...r, avgMin: r.weight > 0 ? r.durationMin / r.weight : 0 }))
    .sort((a, b) => b.avgMin - a.avgMin || (a.sku < b.sku ? -1 : 1))
    .slice(0, 20);

  const startMs = Date.parse(scope.range.startUtc);
  const endMs = Date.parse(scope.range.endUtcExclusive);
  const exportEvents = evidence.snapshot.events
    .filter((e) => {
      const ms = Date.parse(e.created_at);
      return ms >= startMs && ms < endMs && (!staffId || e.staff_id === staffId) && (!scope.workType || e.department === scope.workType);
    })
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    summary,
    coverage: everyone.coverage,
    dispatchedOrders: summary.byWorkType.dispatch.normal.orders,
    timing: timingFor(staffId),
    activeStaff: Object.keys(summary.byPerson).length,
    leaderboard,
    leaderboardScopeDiffers: staffId !== null,
    staffDays,
    avgOrdersPerStaffDay: staffDays > 0 ? summary.normal.orders / staffDays : 0,
    staffOrders,
    personDaily,
    personTotals,
    skuBoard,
    exportEvents,
  };
}

export interface OrderLookupCounts {
  normal: number | null;
  rework: number | null;
  /** Data issues or limited visibility in this order's evidence. */
  incomplete: boolean;
}

/**
 * Items on one looked-up order over its whole saved history, by the shared
 * rules. Returns null when the read was not confirmed complete (a partial
 * read must never look authoritative) or the evidence is contradictory.
 * Each event's site is the site it was READ from, never the current one.
 */
export function orderLookupCounts(
  events: ReadonlyArray<Omit<ProductionEvidenceEvent, "location">>,
  read: { location: string; asOfUtc: string; complete: boolean; visibility: ProductionVisibility },
): OrderLookupCounts | null {
  if (!read.complete || events.length === 0) return null;
  const range = { startUtc: "1970-01-01T00:00:00.000Z", endUtcExclusive: "9999-12-31T00:00:00.000Z" };
  try {
    const prepared = prepareProductionEvidence({
      events: events.map((e) => ({ ...e, location: read.location })),
      range,
      asOfUtc: read.asOfUtc,
      loadedAtUtc: read.asOfUtc,
      visibility: read.visibility,
    });
    const s = summarizeProduction(prepared, { range });
    return { normal: s.normal.items, rework: s.rework.items, incomplete: s.coverage.incomplete };
  } catch {
    return null;
  }
}
