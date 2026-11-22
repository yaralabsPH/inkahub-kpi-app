/**
 * F8 Reports v2: the period overview contract shared by the browser, the
 * /api/reports/overview handler and the summary CSV. Pure: no I/O.
 *
 * Counts come only from the published F1 generation (0057
 * read_reports_overview over sel_eval). Whole-period Orders are distinct
 * (order, case) identities computed by the database for each group; nothing
 * here adds daily or group Orders together.
 */
import { isProductionDate, isReportSite, productionDatesBetween, type ReportSite } from "./productionPeriods";
import type { PublishedMeta } from "./productionReporting";

export const OVERVIEW_MAX_DATES = 731;
export const OVERVIEW_GROUP_LIMIT = 1000;
export const OVERVIEW_WORK_TYPES = ["a0_framed", "framed", "unframed", "dispatch"] as const;
export type OverviewWorkType = (typeof OVERVIEW_WORK_TYPES)[number];
/** "unknown" selects events without a recorded assigned department. */
export const UNKNOWN_DEPARTMENT = "unknown";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface OverviewRequest {
  site: ReportSite;
  firstDate: string;
  lastDate: string;
  staffId?: string;
  workType?: OverviewWorkType;
  /** A recorded business department id, or "unknown". */
  departmentId?: string;
}

export interface CountPair {
  /** null = the exact total exceeds the safe-integer range (overflow), never a rounded number. */
  items: number | null;
  orders: number;
}
export interface Split { normal: CountPair; rework: CountPair }
export interface OverviewDay extends Split { productionDate: string }
export interface OverviewPerson extends Split { staffId: string }
export interface OverviewDepartment extends Split {
  /** null = Unknown (no recorded assigned department). */
  departmentId: string | null;
  /** Every name recorded on this department's events in the period, most recent first. */
  names: string[];
}
export interface OverviewBody {
  totals: Split;
  daily: OverviewDay[];
  people: OverviewPerson[];
  departments: OverviewDepartment[];
}
export interface OverviewResult extends OverviewBody {
  meta: PublishedMeta;
  request: OverviewRequest;
}

/** Inclusive number of calendar dates, without iterating (bounded before any list is built). */
export function dateSpan(firstDate: string, lastDate: string): number {
  return Math.round((Date.parse(`${lastDate}T00:00:00Z`) - Date.parse(`${firstDate}T00:00:00Z`)) / 86_400_000) + 1;
}

export class OverviewRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverviewRequestError";
  }
}

export function validateOverviewRequest(r: Record<string, unknown>): OverviewRequest {
  if (!isReportSite(r.site)) throw new OverviewRequestError("unsupported site");
  if (!isProductionDate(r.firstDate) || !isProductionDate(r.lastDate)) throw new OverviewRequestError("firstDate and lastDate must be calendar dates (YYYY-MM-DD)");
  if (r.firstDate > r.lastDate) throw new OverviewRequestError("firstDate is after lastDate");
  if (dateSpan(r.firstDate, r.lastDate) > OVERVIEW_MAX_DATES) throw new OverviewRequestError(`at most ${OVERVIEW_MAX_DATES} production dates`);
  const out: OverviewRequest = { site: r.site, firstDate: r.firstDate, lastDate: r.lastDate };
  if (r.staffId !== undefined) {
    if (typeof r.staffId !== "string" || !UUID.test(r.staffId)) throw new OverviewRequestError("invalid staffId");
    out.staffId = r.staffId;
  }
  if (r.workType !== undefined) {
    if (!(OVERVIEW_WORK_TYPES as readonly unknown[]).includes(r.workType)) throw new OverviewRequestError("unsupported work type");
    out.workType = r.workType as OverviewWorkType;
  }
  if (r.departmentId !== undefined) {
    if (typeof r.departmentId !== "string" || (r.departmentId !== UNKNOWN_DEPARTMENT && !UUID.test(r.departmentId))) throw new OverviewRequestError("invalid departmentId");
    out.departmentId = r.departmentId;
  }
  return out;
}

/** The query string for GET /api/reports/overview (fixed key order; absent filters omitted). */
export function overviewQuery(r: OverviewRequest): string {
  const q = new URLSearchParams({ site: r.site, firstDate: r.firstDate, lastDate: r.lastDate });
  if (r.staffId) q.set("staffId", r.staffId);
  if (r.workType) q.set("workType", r.workType);
  if (r.departmentId) q.set("departmentId", r.departmentId);
  return q.toString();
}

/** Identity of a request: a response for any other key is never shown. */
export function overviewKey(userId: string | null, r: OverviewRequest | null): string {
  return r ? `${userId ?? "anon"}|${overviewQuery(r)}` : "";
}

// ---------------------------------------------------------------------------
// Strict parsing of the database / API body
// ---------------------------------------------------------------------------

export class OverviewShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverviewShapeError";
  }
}
const bad = (m: string): never => { throw new OverviewShapeError(m); };
const obj = (v: unknown, at: string): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : bad(`${at} is not an object`));
const arr = (v: unknown, at: string): unknown[] => (Array.isArray(v) ? v : bad(`${at} is not a list`));
const count = (v: unknown, at: string): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : bad(`${at} is not an exact count`));
const items = (v: unknown, at: string): number | null => (v === null ? null : count(v, at));
const pair = (v: unknown, at: string): CountPair => {
  const o = obj(v, at);
  return { items: items(o.items, `${at}.items`), orders: count(o.orders, `${at}.orders`) };
};
const split = (o: Record<string, unknown>, at: string): Split => ({ normal: pair(o.normal, `${at}.normal`), rework: pair(o.rework, `${at}.rework`) });

export function parseOverviewBody(v: unknown, scope: { firstDate: string; lastDate: string; groupLimit?: number }): OverviewBody {
  const o = obj(v, "overview");
  const limit = scope.groupLimit ?? OVERVIEW_GROUP_LIMIT;
  const dates = productionDatesBetween(scope.firstDate, scope.lastDate);
  const daily = arr(o.daily, "daily").map((d, i) => {
    const x = obj(d, `daily[${i}]`);
    if (x.productionDate !== dates[i]) bad(`daily[${i}] is not ${dates[i]}`);
    return { productionDate: dates[i], ...split(x, `daily[${i}]`) };
  });
  if (daily.length !== dates.length) bad("daily does not cover every production date");
  const people = arr(o.people, "people").map((p, i) => {
    const x = obj(p, `people[${i}]`);
    if (typeof x.staffId !== "string" || !UUID.test(x.staffId)) bad(`people[${i}].staffId`);
    return { staffId: x.staffId as string, ...split(x, `people[${i}]`) };
  });
  const departments = arr(o.departments, "departments").map((d, i) => {
    const x = obj(d, `departments[${i}]`);
    if (x.departmentId !== null && (typeof x.departmentId !== "string" || !UUID.test(x.departmentId))) bad(`departments[${i}].departmentId`);
    const names = arr(x.names, `departments[${i}].names`).map((n) => (typeof n === "string" ? n : bad(`departments[${i}].names`)));
    return { departmentId: x.departmentId as string | null, names, ...split(x, `departments[${i}]`) };
  });
  if (people.length > limit || departments.length > limit) bad("more groups than the limit");
  return { totals: split(obj(o.totals, "totals"), "totals"), daily, people, departments };
}

// ---------------------------------------------------------------------------
// Labels and the summary CSV
// ---------------------------------------------------------------------------

export function departmentLabel(d: Pick<OverviewDepartment, "departmentId" | "names">): string {
  if (d.departmentId === null) return "Unknown";
  const [latest, ...older] = d.names;
  if (!latest) return "Unnamed department";
  return older.length ? `${latest} (also recorded as ${older.join(", ")})` : latest;
}

/** Neutralise spreadsheet formula prefixes, then quote when needed. */
export function csvCell(value: string | number | null): string {
  let s = value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const n = (v: number | null) => (v === null ? "overflow" : v);

/**
 * The summary CSV of exactly what is shown: a key/value preface (site, period, filters, generation,
 * cutoff) then one table. Rows are the totals, each day, each person and each department.
 */
export function overviewCsv(r: OverviewResult, labels: { person: (staffId: string) => string; department?: string | null }): string {
  const lines: string[][] = [
    ["report", "production summary"],
    ["site", r.request.site],
    ["first_date", r.request.firstDate],
    ["last_date", r.request.lastDate],
    ["person", r.request.staffId ? labels.person(r.request.staffId) : "all"],
    ["work_type", r.request.workType ?? "all"],
    ["department", r.request.departmentId ? (labels.department ?? r.request.departmentId) : "all"],
    ["generation", r.meta.generationId],
    ["source_cutoff_utc", r.meta.sourceCutoffUtc],
    ["freshness", r.meta.state],
    [],
    ["section", "key", "label", "normal_items", "normal_orders", "rework_items", "rework_orders"],
  ];
  const row = (section: string, key: string, label: string, s: Split) =>
    lines.push([section, key, label, String(n(s.normal.items)), String(s.normal.orders), String(n(s.rework.items)), String(s.rework.orders)]);
  row("total", "", "Whole period", r.totals);
  for (const d of r.daily) row("day", d.productionDate, d.productionDate, d);
  for (const p of r.people) row("person", p.staffId, labels.person(p.staffId), p);
  for (const d of r.departments) row("department", d.departmentId ?? UNKNOWN_DEPARTMENT, departmentLabel(d), d);
  return lines.map((l) => l.map((c) => csvCell(c)).join(",")).join("\r\n");
}
