/**
 * Task 17: the pure routing/adapter layer between the published view
 * controller (usePublishedProduction) and the management pages.
 *
 *  - managementSource / rawRangeFor: the raw-history path (useProductionEvidence)
 *    activates ONLY after an explicit READ_MODE_LEGACY/SHADOW answer. While the
 *    published summary is pending, shown, stale or failed, the raw range is
 *    null, so management never reads raw history twice or as a fallback.
 *  - reportViewFromSummary: the Reports values are the summary's exact totals,
 *    by-work-type, timing, coverage and whole-scope scalars; loaded pages only
 *    list rows and say whether they are complete.
 *  - publishedStatusLine: the published cutoff with the 15/30/120-minute
 *    freshness rules and the generation's day coverage (days it does not cover
 *    are announced, never shown as zero).
 *  - welcomeFromSummary: summary.welcome as-is, plus whether today/yesterday
 *    are covered by the shown generation.
 */
import type { ProductionRange, ReportSite } from "./productionPeriods";
import type { CountTotals, CoverageCounts, PublishedDetailRow, PublishedWelcomeView, ReportPersonDto, ReportSkuDto, SummaryResult } from "./productionReporting";
import type { FrameTimingTotals } from "./productionFrameTiming";
import type { ReportDay, ReportOrderRow } from "./productionReportView";
import { PRODUCTION_DEPARTMENT_LABELS, type ProductionDepartment } from "./schemas";
import { publishedCoverage, publishedFreshness } from "./productionReportingFreshness";
import { detailKey, type PublishedState, type PublishedStatus } from "./productionPublishedState";

/** The load states a published status line can take (a subset of the production status line's). */
export type PublishedLoadStatus = "loading" | "current" | "stale" | "error";

export type ManagementSource = "published" | "legacy" | "pending";

/** Which read path a management page uses for this controller state. */
export function managementSource(status: PublishedStatus): ManagementSource {
  if (status === "legacy") return "legacy";
  if (status === "idle" || status === "loading") return "pending";
  return "published";
}

/** The range the raw-history hook may load: only for an explicitly legacy site. */
export function rawRangeFor<R>(status: PublishedStatus, range: R | null): R | null {
  return managementSource(status) === "legacy" ? range : null;
}

export interface PageCompleteness { shown: number; total: number; complete: boolean }
export interface PublishedReportView {
  summary: CountTotals;
  dispatchedOrders: number;
  timing: FrameTimingTotals;
  activeStaff: number;
  staffDays: number;
  avgOrdersPerStaffDay: number;
  skuBoard: ReportSkuDto[];
  coverage: CoverageCounts;
  leaderboard: ReportPersonDto[];
  people: PageCompleteness;
  /** The selected person's series (the tile's daily page), only days the generation covers. */
  personDaily: ReportDay[] | null;
  personTotals: CountTotals | null;
  daily: PageCompleteness & { unpublishedAfter: string | null };
  /** Order/event detail and raw export come from detail pages (a later slice): never fabricated. */
  staffOrders: never[];
  exportEvents: never[];
}

/** The Reports view of one published summary (no value is derived from loaded pages). */
export function reportViewFromSummary(s: SummaryResult, o: { staffId: string | null; details: PublishedState["details"]; coveredThrough: string }): PublishedReportView {
  const more = o.details[detailKey("people")];
  const leaderboard = [...s.peoplePage.rows, ...(more?.rows ?? []).flatMap((r) => (r.kind === "people" ? [r.row] : []))];
  const peopleCursor = more ? more.nextCursor : s.peoplePage.nextCursor;
  const dispatch = s.byWorkType.find((w) => w.workType === "dispatch");
  // The daily series: the summary's first page, then any loaded day pages, in order (one generation).
  const moreDays = o.details[detailKey("days")];
  const days = [...s.dailyPage.rows, ...(moreDays?.rows ?? []).flatMap((r) => (r.kind === "days" ? [r.row] : []))];
  const dayCursor = moreDays ? moreDays.nextCursor : s.dailyPage.nextCursor;
  const lastShown = days.length ? days[days.length - 1].productionDate : null;
  const unpublishedAfter = lastShown !== null && lastShown > o.coveredThrough ? o.coveredThrough : null;
  return {
    summary: s.totals,
    dispatchedOrders: dispatch ? dispatch.totals.normal.orders : 0,
    timing: s.timing,
    activeStaff: s.activeStaff,
    staffDays: s.staffDays,
    avgOrdersPerStaffDay: s.avgOrdersPerStaffDay,
    skuBoard: s.skuBoard,
    coverage: s.coverage,
    leaderboard,
    people: { shown: leaderboard.length, total: s.peoplePage.totalRows, complete: peopleCursor === null },
    personDaily: o.staffId
      ? days.filter((d) => d.productionDate <= o.coveredThrough).map((d) => ({ date: d.productionDate, normal: d.totals.normal, rework: d.totals.rework }))
      : null,
    personTotals: o.staffId ? s.totals : null,
    daily: { shown: days.length, total: s.dailyPage.totalRows, complete: dayCursor === null, unpublishedAfter },
    staffOrders: [],
    exportEvents: [],
  };
}

export interface PublishedStatusLine {
  status: PublishedLoadStatus;
  updating: boolean;
  error: string | null;
  unavailableReason: string | null;
  /** asOf = the generation's SOURCE CUTOFF; loadedAt = its verified coverage instant. */
  snapshot: { asOfUtc: string; loadedAtUtc: string } | null;
  coveredThrough: string | null;
  /** Freshness and day-coverage warnings (shown even in compact mode). */
  warnings: string[];
  /** warnings plus informational lines. */
  notes: string[];
}

/** The status line for a published view: load state, cutoff, freshness and the generation's day coverage. */
export function publishedStatusLine(st: PublishedState, o: { site: ReportSite; range: Pick<ProductionRange, "firstDate" | "lastDate"> | null; nowMs: number }): PublishedStatusLine {
  const s = st.summary;
  const base = { updating: st.status === "loading" && !!s, unavailableReason: null };
  if (!s) {
    const status: PublishedLoadStatus = st.status === "error" ? "error" : "loading";
    return { ...base, status, error: st.error, snapshot: null, coveredThrough: null, warnings: [], notes: [] };
  }
  const warnings: string[] = [];
  const f = publishedFreshness(s.meta.verifiedAtUtc, o.nowMs);
  if (f.label) warnings.push(`${f.label}: the source was last verified ${f.ageMinutes} minutes ago.`);
  else if (f.refreshOverdue) warnings.push(`A refresh is due (every 15 minutes); the source was last verified ${f.ageMinutes} minutes ago.`);
  const c = publishedCoverage(o.site, s.meta.sourceCutoffUtc, o.nowMs);
  if (o.range && o.range.lastDate > c.coveredThrough) warnings.push(`Production days after ${c.coveredThrough} are not in this published report yet; they are not zero.`);
  const notes = [...warnings, `Published report: rule ${s.meta.ruleVersion}.`];
  return {
    ...base,
    // A failed refresh keeps the shown generation, marked stale with the error; delay is a labelled note, not a failure.
    status: st.error ? "stale" : "current",
    error: st.error,
    snapshot: { asOfUtc: s.meta.sourceCutoffUtc, loadedAtUtc: s.meta.verifiedAtUtc },
    coveredThrough: c.coveredThrough,
    warnings,
    notes,
  };
}

/** Welcome's view from the same summary, and which of its days the generation covers. */
export function welcomeFromSummary(s: SummaryResult, o: { site: ReportSite; nowMs: number }): { view: PublishedWelcomeView; todayPublished: boolean; yesterdayPublished: boolean; coveredThrough: string } | null {
  if (!s.welcome) return null;
  const c = publishedCoverage(o.site, s.meta.sourceCutoffUtc, o.nowMs);
  return { view: s.welcome, todayPublished: c.coveredThrough >= s.welcome.today, yesterdayPublished: c.coveredThrough >= s.welcome.yesterday, coveredThrough: c.coveredThrough };
}

/**
 * The selected person's published orders, shown only after an explicit Load orders (lazy). Rows map
 * onto the existing order table; whole-range totals always stay the summary's, never these rows.
 */
export function publishedOrders(details: PublishedState["details"]): { started: boolean; rows: ReportOrderRow[]; shown: number; total: number; complete: boolean } {
  const page = details[detailKey("orders")];
  if (!page) return { started: false, rows: [], shown: 0, total: 0, complete: false };
  const rows = page.rows.flatMap((r) =>
    r.kind === "orders"
      ? [{ key: r.row.key, orderNumber: r.row.orderNumber, caseId: r.row.caseId, group: r.row.group, firstMs: Date.parse(r.row.firstAtUtc), lastMs: Date.parse(r.row.lastAtUtc), workTypes: r.row.workTypes, verifiedLines: r.row.verifiedLines, items: r.row.items, completed: r.row.completed }]
      : [],
  );
  return { started: true, rows, shown: rows.length, total: page.totalRows, complete: page.nextCursor === null };
}

const CSV_HEADERS = ["timestamp", "staff_name", "department", "order_number", "sku", "quantity", "event_type", "station_id", "note"];
const csvCell = (cell: string) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);
const rawText = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v));

/**
 * The published CSV (the legacy export's columns) from COMPLETE raw-export rows of one generation:
 * raw saved quantity/note/station values (no production_events read), staff names from the caller's
 * own lookup. Any row of another kind is refused (never a silently different file).
 */
export function publishedCsv(rows: readonly PublishedDetailRow[], nameOf: (staffId: string) => string): string {
  return [publishedCsvHeader(), ...publishedCsvLines(rows, nameOf)].join("\r\n");
}

/** The published CSV's header line (the legacy export's columns). */
export function publishedCsvHeader(): string {
  return CSV_HEADERS.map(csvCell).join(",");
}

/** CSV lines for ONE page of raw-export rows (the export is built page by page; joined with CRLF). */
export function publishedCsvLines(rows: readonly PublishedDetailRow[], nameOf: (staffId: string) => string): string[] {
  return rows.map((r) => {
    if (r.kind !== "raw-export") throw new RangeError(`A published CSV holds raw-export rows only, not ${r.kind}`);
    const e = r.row;
    return [
      e.createdAtUtc,
      e.staffId ? nameOf(e.staffId) : "",
      PRODUCTION_DEPARTMENT_LABELS[e.department as ProductionDepartment] ?? e.department ?? "",
      e.orderNumber ?? "",
      e.sku ?? "",
      rawText(e.quantity),
      e.eventType,
      e.stationId ?? "",
      (e.note ?? "").replace(/[\r\n]+/g, " "),
    ].map((c) => csvCell(String(c))).join(",");
  });
}

type DetailRowOf<K extends PublishedDetailRow["kind"]> = Extract<PublishedDetailRow, { kind: K }>["row"];
/**
 * A lazy published drill-down (coverage issues, timing observations): nothing until the user loads it,
 * then the existing DTO rows of exactly that kind, complete only when the last cursor is null. Totals and
 * tiles always stay the summary's.
 */
export function publishedDetailList<K extends "coverage" | "timing">(details: PublishedState["details"], kind: K): { started: boolean; rows: DetailRowOf<K>[]; shown: number; total: number; complete: boolean } {
  const page = details[detailKey(kind)];
  if (!page) return { started: false, rows: [], shown: 0, total: 0, complete: false };
  const rows = page.rows.flatMap((r) => (r.kind === kind ? [r.row as DetailRowOf<K>] : []));
  return { started: true, rows, shown: rows.length, total: page.totalRows, complete: page.nextCursor === null };
}
