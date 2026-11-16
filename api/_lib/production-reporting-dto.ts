/**
 * Task 16: strict validation of the 0044 summary response into SummaryBody.
 *
 * Every Items value is an exact safe integer or null (the contract's overflow
 * state); every Orders/count is an exact non-negative safe integer; every rate
 * and timing value is finite and non-negative; object key sets are exact.
 * Anything else is a 503 (never rounded, clipped or zeroed).
 *
 * Summary daily/people parts are SQL-bounded first pages {rows, total}: at
 * most the requested limit, an exact safe total, and a short page only when it
 * is the last one. Detail pages ({rows, last, more, total_rows}) are parsed per
 * kind with exact row keys, enums, dates, UUIDs and keyset `last` tuples.
 */
import { WORK_TYPES, type WorkType } from "../../src/lib/domain/productionCounts.js";
import { shiftProductionDate } from "../../src/lib/domain/productionPeriods.js";
import type { CountTotals, CoverageCounts, CoverageDetailDto, DailyCountTotals, DetailKind, EventDetailDto, OrderDetailDto, PublishedDetailRow, RawExportDto, ReportPersonDto, SummaryResult, TimingDetailDto, WorkTypeTotals } from "../../src/lib/domain/productionReporting.js";
import { ReportingHttpError } from "./production-reporting.js";
import { skuBoardFrom } from "./production-reporting-sku.js";
import { welcomeFrom, type WelcomeCell } from "./production-reporting-welcome.js";

/** A shape failure inside a parse; only the top-level parser names the RPC (no shared mutable state). */
class ParseFailure extends Error {}
const bad = (what: string): never => {
  throw new ParseFailure(what);
};
/** Run one top-level parse, mapping a shape failure to a 503 that names exactly this RPC. */
function within<T>(rpc: string, parse: () => T): T {
  try {
    return parse();
  } catch (e) {
    if (e instanceof ParseFailure) throw new ReportingHttpError(503, "UNAVAILABLE", `${rpc}: ${e.message}`);
    throw e;
  }
}
/** Exact UTC instant text as the SQL emits it (microseconds, Z). */
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
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
function safeCount(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) bad(`${what} is not an exact non-negative safe integer`);
  return v as number;
}
function itemsOrNull(v: unknown, what: string): number | null {
  return v === null ? null : safeCount(v, what);
}
function finiteRate(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) bad(`${what} is not a finite non-negative number`);
  return v as number;
}
function countTotals(v: unknown, what: string): CountTotals {
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
/** The number of production dates first..last inclusive. */
function rangeDays(first: string, last: string): number {
  return Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1;
}
/** A SQL-bounded page {rows, total}: at most `limit` rows, an exact total, short only when last. */
function boundedPage(v: unknown, what: string, limit: number): { rows: unknown[]; total: number } {
  const o = obj(v, what, ["rows", "total"]);
  const rows = arr(o.rows, `${what}.rows`);
  const total = safeCount(o.total, `${what}.total`);
  if (rows.length > limit) bad(`${what} holds ${rows.length} rows; the page limit is ${limit}`);
  if (total < rows.length) bad(`${what}.total is below its rows`);
  if (total > rows.length && rows.length !== limit) bad(`${what} is a short page but not the last one`);
  return { rows, total };
}
const str = (v: unknown, what: string): string => (typeof v === "string" && v !== "" ? v : bad(`${what} is not a non-empty string`));
const nstr = (v: unknown, what: string): string | null => (v === null ? null : str(v, what));
const uuid = (v: unknown, what: string): string => (typeof v === "string" && UUID.test(v) ? v : bad(`${what} is not a uuid`));
const utc = (v: unknown, what: string): string => (typeof v === "string" && UTC.test(v) && Number.isFinite(Date.parse(v)) ? v : bad(`${what} is not an exact UTC instant`));
const work = (v: unknown, what: string): WorkType => ((WORK_TYPES as readonly unknown[]).includes(v) ? (v as WorkType) : bad(`${what} is not a work type`));

function dailyRow(x: unknown, what: string, expectDate?: string): DailyCountTotals {
  const o = obj(x, what, ["productionDate", "totals"]);
  if (typeof o.productionDate !== "string" || !DATE.test(o.productionDate)) bad(`${what}.productionDate`);
  if (expectDate !== undefined && o.productionDate !== expectDate) bad(`${what} is ${String(o.productionDate)}, expected ${expectDate} (no gap or repeat)`);
  return { productionDate: o.productionDate as string, totals: countTotals(o.totals, `${what}.totals`) };
}
function personRow(x: unknown, what: string): ReportPersonDto {
  const o = obj(x, what, ["staffId", "normal", "rework", "daysWorked", "itemsPerDay", "ordersPerDay", "timing"]);
  const t = countTotals({ normal: o.normal, rework: o.rework }, what);
  return { staffId: uuid(o.staffId, `${what}.staffId`), normal: t.normal, rework: t.rework, daysWorked: safeCount(o.daysWorked, `${what}.daysWorked`), itemsPerDay: finiteRate(o.itemsPerDay, `${what}.itemsPerDay`), ordersPerDay: finiteRate(o.ordersPerDay, `${what}.ordersPerDay`), timing: timing(o.timing, `${what}.timing`) };
}
function orderRow(x: unknown, what: string, site: string): OrderDetailDto {
  const o = obj(x, what, ["key", "orderNumber", "caseId", "group", "firstAtUtc", "lastAtUtc", "workTypes", "verifiedLines", "items", "completed"]);
  const orderNumber = str(o.orderNumber, `${what}.orderNumber`);
  const caseId = nstr(o.caseId, `${what}.caseId`);
  if (o.group !== (caseId === null ? "normal" : "rework")) bad(`${what}.group does not match its case`);
  const key = `${site}|${orderNumber}${caseId === null ? "" : `|case:${caseId}`}`;
  if (o.key !== key) bad(`${what}.key is not the overall order key`);
  const firstAtUtc = utc(o.firstAtUtc, `${what}.firstAtUtc`);
  const lastAtUtc = utc(o.lastAtUtc, `${what}.lastAtUtc`);
  if (firstAtUtc > lastAtUtc) bad(`${what} ends before it starts`);
  const types = arr(o.workTypes, `${what}.workTypes`).map((w, i) => work(w, `${what}.workTypes[${i}]`));
  if (types.some((w, i) => i > 0 && WORK_TYPES.indexOf(w) <= WORK_TYPES.indexOf(types[i - 1]))) bad(`${what}.workTypes is not distinct in work-type order`);
  if (typeof o.completed !== "boolean") bad(`${what}.completed is not a boolean`);
  return { key, orderNumber, caseId, group: o.group as OrderDetailDto["group"], firstAtUtc, lastAtUtc, workTypes: types, verifiedLines: safeCount(o.verifiedLines, `${what}.verifiedLines`), items: itemsOrNull(o.items, `${what}.items`), completed: o.completed as boolean };
}
const EVENT_KEYS = ["id", "staffId", "department", "orderNumber", "sku", "quantity", "eventType", "createdAtUtc", "parentEventId", "caseId"] as const;
/** Raw saved text: any string (blank included) or null, never coerced. */
const rawText = (v: unknown, what: string): string | null => (v === null || typeof v === "string" ? v : bad(`${what} is not text or null`));
function eventFields(o: Record<string, unknown>, what: string): EventDetailDto {
  // quantity is the raw saved value (unknown by contract) and eventType any saved string: only presence/type are checked.
  if (!("quantity" in o)) bad(`${what}.quantity is missing`);
  if (typeof o.eventType !== "string") bad(`${what}.eventType is not a string`);
  return {
    id: str(o.id, `${what}.id`), staffId: o.staffId === null ? null : uuid(o.staffId, `${what}.staffId`), department: rawText(o.department, `${what}.department`),
    orderNumber: rawText(o.orderNumber, `${what}.orderNumber`), sku: rawText(o.sku, `${what}.sku`), quantity: o.quantity, eventType: o.eventType as string,
    createdAtUtc: utc(o.createdAtUtc, `${what}.createdAtUtc`), parentEventId: rawText(o.parentEventId, `${what}.parentEventId`), caseId: rawText(o.caseId, `${what}.caseId`),
  };
}
function eventRow(x: unknown, what: string): EventDetailDto {
  return eventFields(obj(x, what, EVENT_KEYS), what);
}
function rawRow(x: unknown, what: string): RawExportDto {
  const o = obj(x, what, [...EVENT_KEYS, "note", "stationId"]);
  return { ...eventFields(o, what), note: rawText(o.note, `${what}.note`), stationId: rawText(o.stationId, `${what}.stationId`) };
}
function coverageRow(x: unknown, what: string, site: string): CoverageDetailDto {
  const o = obj(x, what, ["kind", "eventId", "location", "detail"]);
  if (!(ISSUE_KINDS as readonly unknown[]).includes(o.kind)) bad(`${what}.kind is not a coverage issue kind`);
  if (o.location !== site) bad(`${what}.location is not ${site}`);
  return { kind: o.kind as CoverageDetailDto["kind"], eventId: str(o.eventId, `${what}.eventId`), location: site, detail: o.detail === null ? null : typeof o.detail === "string" ? o.detail : bad(`${what}.detail`) };
}
function timingRow(x: unknown, what: string): TimingDetailDto {
  const o = obj(x, what, ["eventId", "staffId", "workType", "orderNumber", "sku", "weight", "startedAtUtc", "completedAtUtc", "durationMin"]);
  const startedAtUtc = utc(o.startedAtUtc, `${what}.startedAtUtc`);
  const completedAtUtc = utc(o.completedAtUtc, `${what}.completedAtUtc`);
  if (startedAtUtc > completedAtUtc) bad(`${what} completes before it starts`);
  return {
    eventId: str(o.eventId, `${what}.eventId`), staffId: uuid(o.staffId, `${what}.staffId`), workType: work(o.workType, `${what}.workType`), orderNumber: str(o.orderNumber, `${what}.orderNumber`),
    sku: nstr(o.sku, `${what}.sku`), weight: finiteRate(o.weight, `${what}.weight`), startedAtUtc, completedAtUtc, durationMin: finiteRate(o.durationMin, `${what}.durationMin`),
  };
}

/** The keyset `last` each kind's cursor carries (a malformed tuple is never signed). */
export function detailLast(kind: DetailKind, row: PublishedDetailRow["row"], offset: number): unknown {
  switch (kind) {
    case "days":
    case "people":
      return offset;
    case "orders":
      return (row as OrderDetailDto).key;
    case "events":
    case "raw-export":
      return [(row as EventDetailDto).createdAtUtc, (row as EventDetailDto).id];
    case "coverage":
      return [(row as CoverageDetailDto).kind, (row as CoverageDetailDto).eventId];
    case "timing":
      return [(row as TimingDetailDto).completedAtUtc, (row as TimingDetailDto).eventId];
  }
}

export interface DetailContext { site: string; firstDate: string; lastDate: string; limit: number; /** days/people: rows before this page. */ offset: number }
/** One strict detail page: rows of exactly `kind`, at most `limit`, `last` equal to the last row's keyset, an exact total. */
export function parseDetailResponse(v: unknown, kind: DetailKind, ctx: DetailContext): { rows: PublishedDetailRow[]; last: unknown; more: boolean; totalRows: number } {
  return within("read_reporting_detail", () => detailPage(v, kind, ctx));
}
function detailPage(v: unknown, kind: DetailKind, ctx: DetailContext): { rows: PublishedDetailRow[]; last: unknown; more: boolean; totalRows: number } {
  const o = obj(v, "response", ["rows", "last", "more", "total_rows"]);
  const list = arr(o.rows, "rows");
  if (list.length > ctx.limit) bad(`returned ${list.length} rows; the limit is ${ctx.limit}`);
  if (typeof o.more !== "boolean") bad("more is not a boolean");
  const totalRows = safeCount(o.total_rows, "total_rows");
  const before = kind === "days" || kind === "people" ? ctx.offset : 0;
  if (kind === "days" || kind === "people") {
    if (totalRows < before + list.length) bad("total_rows is below the rows shown so far");
    if (o.more !== totalRows > before + list.length) bad("more disagrees with total_rows");
  } else if (totalRows < list.length) bad("total_rows is below its rows");
  if (o.more && list.length !== ctx.limit) bad("a page with more rows after it must be full");
  if (kind === "days" && totalRows !== rangeDays(ctx.firstDate, ctx.lastDate)) bad("total_rows is not the range's production dates");
  const rows: PublishedDetailRow[] = list.map((x, i) => {
    const w = `rows[${i}]`;
    switch (kind) {
      case "days":
        return { kind, row: dailyRow(x, w, shiftProductionDate(ctx.firstDate, before + i)) };
      case "people":
        return { kind, row: personRow(x, w) };
      case "orders":
        return { kind, row: orderRow(x, w, ctx.site) };
      case "events":
        return { kind, row: eventRow(x, w) };
      case "raw-export":
        return { kind, row: rawRow(x, w) };
      case "coverage":
        return { kind, row: coverageRow(x, w, ctx.site) };
      case "timing":
        return { kind, row: timingRow(x, w) };
    }
  });
  const want = rows.length ? detailLast(kind, rows[rows.length - 1].row, before + rows.length) : null;
  if (JSON.stringify(o.last ?? null) !== JSON.stringify(want)) bad("last is not the keyset of the last row");
  return { rows, last: want, more: o.more as boolean, totalRows };
}

const strip = ({ overflow: _o, ...c }: CoverageCounts & { overflow: boolean }): CoverageCounts => (void _o, c);

export type SummaryBodyOut = Omit<SummaryResult, "meta">;

/** The validated summary body for one request; pages hold at most the given limits (totalRows says how many exist). */
export function parseSummaryResponse(v: unknown, view: "reports" | "welcome", range: { firstDate: string; lastDate: string }, pages: { dailyLimit: number; peopleLimit: number }): SummaryBodyOut {
  return within("read_reporting_summary", () => summaryBody(v, view, range, pages));
}
function summaryBody(v: unknown, view: "reports" | "welcome", range: { firstDate: string; lastDate: string }, pages: { dailyLimit: number; peopleLimit: number }): SummaryBodyOut {
  const lastDate = range.lastDate;
  const top = obj(v, "response", ["report", "welcome"]);
  const r = obj(top.report, "report", ["totals", "byWorkType", "coverage", "tileCoverage", "activeStaff", "staffDays", "avgOrdersPerStaffDay", "timing", "people", "skuTiming", "daily"]);
  const byWorkType: WorkTypeTotals[] = arr(r.byWorkType, "byWorkType").map((x, i) => {
    const o = obj(x, `byWorkType[${i}]`, ["workType", "totals"]);
    if (o.workType !== WORK_TYPES[i]) bad(`byWorkType[${i}] is not ${WORK_TYPES[i]}`);
    return { workType: o.workType as WorkType, totals: countTotals(o.totals, `byWorkType.${String(o.workType)}`) };
  });
  if (byWorkType.length !== WORK_TYPES.length) bad("byWorkType must hold every work type");
  const dayCount = rangeDays(range.firstDate, range.lastDate);
  const dp = boundedPage(r.daily, "daily", pages.dailyLimit);
  if (dp.total !== dayCount) bad(`daily.total ${dp.total} is not the range's ${dayCount} production dates`);
  const daily = dp.rows.map((x, i) => dailyRow(x, `daily[${i}]`, shiftProductionDate(range.firstDate, i)));
  const pp = boundedPage(r.people, "people", pages.peopleLimit);
  const people = pp.rows.map((x, i) => personRow(x, `people[${i}]`));
  if (new Set(people.map((x) => x.staffId)).size !== people.length) bad("people repeats a person");
  const sku = arr(r.skuTiming, "skuTiming").map((x, i) => {
    const o = obj(x, `skuTiming[${i}]`, ["sku", "durationMin", "weight"]);
    if (typeof o.sku !== "string" || !o.sku) bad(`skuTiming[${i}].sku`);
    return { sku: o.sku as string, durationMin: finiteRate(o.durationMin, `skuTiming[${i}].durationMin`), weight: finiteRate(o.weight, `skuTiming[${i}].weight`) };
  });
  const pageCoverage = coverage(r.coverage, "coverage");
  const body: SummaryBodyOut = {
    totals: countTotals(r.totals, "totals"),
    byWorkType,
    dailyPage: { rows: daily, nextCursor: null, pageComplete: true, totalRows: dp.total },
    coverage: strip(pageCoverage),
    timing: timing(r.timing, "timing"),
    peoplePage: { rows: people, nextCursor: null, pageComplete: true, totalRows: pp.total },
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
