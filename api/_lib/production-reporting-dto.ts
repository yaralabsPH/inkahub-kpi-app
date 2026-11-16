/**
 * Task 16: strict validation of the 0044 summary response into SummaryBody.
 *
 * Every Items value is an exact safe integer or null (the contract's overflow
 * state); every Orders/count is an exact non-negative safe integer; every rate
 * and timing value is finite and non-negative; object key sets are exact.
 * Anything else is a 503 (never rounded, clipped or zeroed).
 */
import { WORK_TYPES, type WorkType } from "../../src/lib/domain/productionCounts.js";
import type { CountTotals, CoverageCounts, DailyCountTotals, ReportPersonDto, SummaryResult, WorkTypeTotals } from "../../src/lib/domain/productionReporting.js";
import { ReportingHttpError } from "./production-reporting.js";
import { skuBoardFrom } from "./production-reporting-sku.js";
import { welcomeFrom, type WelcomeCell } from "./production-reporting-welcome.js";

const bad = (what: string): never => {
  throw new ReportingHttpError(503, "UNAVAILABLE", `read_reporting_summary: ${what}`);
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const ISSUE_KINDS = ["invalid_event", "unclassified_sku", "invalid_quantity", "unresolved_parent", "missing_completion_detail", "ambiguous_repeat"] as const;
export const NOTE_KINDS = ["expected_exclusion", "corrected_verification", "reversed_terminal", "excluded_only_completion"] as const;

const obj = (v: unknown, what: string, keys?: readonly string[]): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) bad(`${what} is not an object`);
  const o = v as Record<string, unknown>;
  if (keys && Object.keys(o).sort().join(",") !== [...keys].sort().join(",")) bad(`${what} has unexpected keys`);
  return o;
};
const arr = (v: unknown, what: string): unknown[] => (Array.isArray(v) ? v : bad(`${what} is not an array`));
export function safeCount(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) bad(`${what} is not an exact non-negative safe integer`);
  return v as number;
}
export function itemsOrNull(v: unknown, what: string): number | null {
  return v === null ? null : safeCount(v, what);
}
export function finiteRate(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) bad(`${what} is not a finite non-negative number`);
  return v as number;
}
export function countTotals(v: unknown, what: string): CountTotals {
  const o = obj(v, what, ["normal", "rework"]);
  const g = (x: unknown, w: string) => {
    const r = obj(x, w, ["items", "orders"]);
    return { items: itemsOrNull(r.items, `${w}.items`), orders: safeCount(r.orders, `${w}.orders`) };
  };
  return { normal: g(o.normal, `${what}.normal`), rework: g(o.rework, `${what}.rework`) };
}
function coverage(v: unknown, what: string): CoverageCounts & { overflow: boolean } {
  const o = obj(v, what, ["issueCounts", "notes", "issueRows", "overflow"]);
  const ic = obj(o.issueCounts, `${what}.issueCounts`, ISSUE_KINDS);
  const nt = obj(o.notes, `${what}.notes`, NOTE_KINDS);
  if (typeof o.overflow !== "boolean") bad(`${what}.overflow is not a boolean`);
  const issueRows = safeCount(o.issueRows, `${what}.issueRows`);
  return {
    issueCounts: Object.fromEntries(ISSUE_KINDS.map((k) => [k, safeCount(ic[k], `${what}.issueCounts.${k}`)])) as CoverageCounts["issueCounts"],
    notes: Object.fromEntries(NOTE_KINDS.map((k) => [k, safeCount(nt[k], `${what}.notes.${k}`)])) as CoverageCounts["notes"],
    visibility: { kind: "site" },
    incomplete: issueRows > 0 || (o.overflow as boolean),
    issueRows,
    overflow: o.overflow as boolean,
  };
}
const timing = (v: unknown, what: string) => {
  const o = obj(v, what, ["durationMin", "timedWeight", "avgMinPerUnit"]);
  return { durationMin: finiteRate(o.durationMin, `${what}.durationMin`), timedWeight: finiteRate(o.timedWeight, `${what}.timedWeight`), avgMinPerUnit: finiteRate(o.avgMinPerUnit, `${what}.avgMinPerUnit`) };
};
const strip = ({ overflow: _o, ...c }: CoverageCounts & { overflow: boolean }): CoverageCounts => (void _o, c);

export type SummaryBodyOut = Omit<SummaryResult, "meta">;

/** The validated summary body for one request; pages hold at most the given limits (totalRows says how many exist). */
export function parseSummaryResponse(v: unknown, view: "reports" | "welcome", lastDate: string, pages: { dailyLimit: number; peopleLimit: number }): SummaryBodyOut {
  const top = obj(v, "response", ["report", "welcome"]);
  const r = obj(top.report, "report", ["totals", "byWorkType", "coverage", "tileCoverage", "activeStaff", "staffDays", "avgOrdersPerStaffDay", "timing", "people", "skuTiming", "daily"]);
  const byWorkType: WorkTypeTotals[] = arr(r.byWorkType, "byWorkType").map((x, i) => {
    const o = obj(x, `byWorkType[${i}]`, ["workType", "totals"]);
    if (o.workType !== WORK_TYPES[i]) bad(`byWorkType[${i}] is not ${WORK_TYPES[i]}`);
    return { workType: o.workType as WorkType, totals: countTotals(o.totals, `byWorkType.${String(o.workType)}`) };
  });
  if (byWorkType.length !== WORK_TYPES.length) bad("byWorkType must hold every work type");
  const daily: DailyCountTotals[] = arr(r.daily, "daily").map((x, i) => {
    const o = obj(x, `daily[${i}]`, ["productionDate", "totals"]);
    if (typeof o.productionDate !== "string" || !DATE.test(o.productionDate)) bad(`daily[${i}].productionDate`);
    return { productionDate: o.productionDate as string, totals: countTotals(o.totals, `daily.${String(o.productionDate)}`) };
  });
  const people: ReportPersonDto[] = arr(r.people, "people").map((x, i) => {
    const o = obj(x, `people[${i}]`, ["staffId", "normal", "rework", "daysWorked", "itemsPerDay", "ordersPerDay", "timing"]);
    if (typeof o.staffId !== "string" || !UUID.test(o.staffId)) bad(`people[${i}].staffId`);
    const t = countTotals({ normal: o.normal, rework: o.rework }, `people[${i}]`);
    return { staffId: o.staffId as string, normal: t.normal, rework: t.rework, daysWorked: safeCount(o.daysWorked, `people[${i}].daysWorked`), itemsPerDay: finiteRate(o.itemsPerDay, `people[${i}].itemsPerDay`), ordersPerDay: finiteRate(o.ordersPerDay, `people[${i}].ordersPerDay`), timing: timing(o.timing, `people[${i}].timing`) };
  });
  const sku = arr(r.skuTiming, "skuTiming").map((x, i) => {
    const o = obj(x, `skuTiming[${i}]`, ["sku", "durationMin", "weight"]);
    if (typeof o.sku !== "string" || !o.sku) bad(`skuTiming[${i}].sku`);
    return { sku: o.sku as string, durationMin: finiteRate(o.durationMin, `skuTiming[${i}].durationMin`), weight: finiteRate(o.weight, `skuTiming[${i}].weight`) };
  });
  const pageCoverage = coverage(r.coverage, "coverage");
  const body: SummaryBodyOut = {
    totals: countTotals(r.totals, "totals"),
    byWorkType,
    dailyPage: { rows: daily.slice(0, pages.dailyLimit), nextCursor: null, pageComplete: true, totalRows: daily.length },
    coverage: strip(pageCoverage),
    timing: timing(r.timing, "timing"),
    peoplePage: { rows: people.slice(0, pages.peopleLimit), nextCursor: null, pageComplete: true, totalRows: people.length },
    activeStaff: safeCount(r.activeStaff, "activeStaff"),
    staffDays: safeCount(r.staffDays, "staffDays"),
    avgOrdersPerStaffDay: finiteRate(r.avgOrdersPerStaffDay, "avgOrdersPerStaffDay"),
    skuBoard: skuBoardFrom(sku),
  };
  coverage(r.tileCoverage, "tileCoverage");
  if (view === "welcome") {
    const w = obj(top.welcome, "welcome", ["cells", "coverage", "todayCoverage"]);
    const cells: WelcomeCell[] = arr(w.cells, "welcome.cells").map((x, i) => {
      const o = obj(x, `welcome.cells[${i}]`, ["date", "workType", "staffId", "normal", "rework"]);
      if (typeof o.date !== "string" || !DATE.test(o.date)) bad(`welcome.cells[${i}].date`);
      if (o.workType !== null && !(WORK_TYPES as readonly unknown[]).includes(o.workType)) bad(`welcome.cells[${i}].workType`);
      if (o.staffId !== null && (typeof o.staffId !== "string" || !UUID.test(o.staffId))) bad(`welcome.cells[${i}].staffId`);
      const t = countTotals({ normal: o.normal, rework: o.rework }, `welcome.cells[${i}]`);
      return { date: o.date as string, workType: o.workType as WorkType | null, staffId: o.staffId as string | null, normal: t.normal, rework: t.rework };
    });
    body.welcome = welcomeFrom(cells, lastDate, strip(coverage(w.todayCoverage, "welcome.todayCoverage")), strip(coverage(w.coverage, "welcome.coverage")));
  } else if (top.welcome !== null) bad("a Reports summary carries no Welcome view");
  return body;
}
