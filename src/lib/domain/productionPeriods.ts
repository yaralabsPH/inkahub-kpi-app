/**
 * Site-local production days (F1 / item-counting spec, section C).
 *
 * A production date D at a site means [04:00 on D, 04:00 on D+1) in that
 * site's IANA zone. Every local boundary is converted to UTC on its own, so
 * DST days are 23 or 25 hours long; never add a fixed 24 UTC hours.
 *
 * Uses only Date.UTC arithmetic and Intl with an explicit timeZone, so the
 * result does not depend on the browser/server host timezone. No date library.
 * Browser/server safe: no env, browser state or Supabase imports.
 */

export type ReportSite = "au" | "uk" | "us";

export const SITE_TIME_ZONES: Readonly<Record<ReportSite, string>> = Object.freeze({
  au: "Australia/Sydney",
  uk: "Europe/London",
  us: "America/Chicago",
});

/** Local hour at which a production day starts and ends. */
export const PRODUCTION_DAY_START_HOUR = 4;

export interface ProductionRange {
  site: ReportSite;
  timeZone: string;
  /** First included production date, YYYY-MM-DD. */
  firstDate: string;
  /** Last included production date, YYYY-MM-DD. */
  lastDate: string;
  /** ISO instant of 04:00 local on firstDate (inclusive). */
  startUtc: string;
  /** ISO instant of 04:00 local on the day after lastDate (exclusive). */
  endUtcExclusive: string;
}

export class ProductionPeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionPeriodError";
  }
}

export function isReportSite(value: unknown): value is ReportSite {
  return value === "au" || value === "uk" || value === "us";
}

function siteZone(site: unknown): string {
  if (!isReportSite(site)) {
    throw new ProductionPeriodError(`Unsupported production site: ${String(site)}`);
  }
  return SITE_TIME_ZONES[site];
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface CalendarDate {
  y: number;
  m: number; // 1-12
  d: number;
}

function parseDate(date: unknown): CalendarDate {
  if (typeof date !== "string") throw new ProductionPeriodError("Production date must be YYYY-MM-DD");
  const match = DATE_RE.exec(date);
  if (!match) throw new ProductionPeriodError(`Invalid production date: ${date}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    throw new ProductionPeriodError(`Invalid production date: ${date}`);
  }
  return { y, m, d };
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function formatDate(c: CalendarDate): string {
  return `${pad(c.y, 4)}-${pad(c.m)}-${pad(c.d)}`;
}

function addDays(c: CalendarDate, days: number): CalendarDate {
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** True when the string is a real YYYY-MM-DD calendar date. */
export function isProductionDate(value: unknown): value is string {
  try {
    parseDate(value);
    return true;
  } catch {
    return false;
  }
}

interface WallTime {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  s: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23", // avoid "24" at midnight (Node 20 behavior with hour12:false)
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

function wallTimeAt(epochMs: number, timeZone: string): WallTime {
  const parts = formatter(timeZone).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes) => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new ProductionPeriodError(`Timezone formatting failed for ${timeZone}`);
    return Number(p.value);
  };
  const h = get("hour");
  return { y: get("year"), m: get("month"), d: get("day"), h: h === 24 ? 0 : h, min: get("minute"), s: get("second") };
}

/** UTC instant of a local wall-clock time; throws if it does not exist exactly. */
function localToUtcMs(c: CalendarDate, hour: number, timeZone: string): number {
  const wallAsUtc = Date.UTC(c.y, c.m - 1, c.d, hour, 0, 0);
  let t = wallAsUtc;
  // Two passes converge for any real offset change; a third confirms.
  for (let i = 0; i < 3; i++) {
    const w = wallTimeAt(t, timeZone);
    const offset = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - t;
    t = wallAsUtc - offset;
  }
  const check = wallTimeAt(t, timeZone);
  if (check.y !== c.y || check.m !== c.m || check.d !== c.d || check.h !== hour || check.min !== 0 || check.s !== 0) {
    throw new ProductionPeriodError(`Local time ${formatDate(c)} ${pad(hour)}:00 does not exist in ${timeZone}`);
  }
  return t;
}

/** Production date (YYYY-MM-DD) that contains this instant at the site. */
export function productionDateAt(instant: Date, site: ReportSite): string {
  const zone = siteZone(site);
  const ms = instant.getTime();
  if (!Number.isFinite(ms)) throw new ProductionPeriodError("Invalid instant");
  const w = wallTimeAt(ms, zone);
  const local: CalendarDate = { y: w.y, m: w.m, d: w.d };
  return formatDate(w.h < PRODUCTION_DAY_START_HOUR ? addDays(local, -1) : local);
}

/** UTC window covering firstDate..lastDate inclusive at the site. */
export function productionRange(site: ReportSite, firstDate: string, lastDate: string): ProductionRange {
  const zone = siteZone(site);
  const first = parseDate(firstDate);
  const last = parseDate(lastDate);
  if (formatDate(first) > formatDate(last)) {
    throw new ProductionPeriodError(`Production range ends before it starts: ${firstDate} > ${lastDate}`);
  }
  const startMs = localToUtcMs(first, PRODUCTION_DAY_START_HOUR, zone);
  const endMs = localToUtcMs(addDays(last, 1), PRODUCTION_DAY_START_HOUR, zone);
  return {
    site,
    timeZone: zone,
    firstDate: formatDate(first),
    lastDate: formatDate(last),
    startUtc: new Date(startMs).toISOString(),
    endUtcExclusive: new Date(endMs).toISOString(),
  };
}

/** Calendar step of a production date (no timezone involved). */
export function shiftProductionDate(date: string, days: number): string {
  if (!Number.isSafeInteger(days)) throw new ProductionPeriodError("Day shift must be an integer");
  return formatDate(addDays(parseDate(date), days));
}

/** Monday that starts the production week containing this date. */
export function productionWeekStart(date: string): string {
  const c = parseDate(date);
  const weekday = new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay(); // 0 = Sunday
  const sinceMonday = (weekday + 6) % 7;
  return formatDate(addDays(c, -sinceMonday));
}

/** Inclusive list of production dates from firstDate to lastDate. */
export function productionDatesBetween(firstDate: string, lastDate: string): string[] {
  const first = parseDate(firstDate);
  const last = formatDate(parseDate(lastDate));
  if (formatDate(first) > last) {
    throw new ProductionPeriodError(`Production range ends before it starts: ${firstDate} > ${lastDate}`);
  }
  const out: string[] = [];
  for (let c = first; formatDate(c) <= last; c = addDays(c, 1)) out.push(formatDate(c));
  return out;
}

/** True when an ISO/Date instant falls inside the range's half-open window. */
export function isInProductionRange(instant: Date | string, range: ProductionRange): boolean {
  const ms = typeof instant === "string" ? Date.parse(instant) : instant.getTime();
  if (!Number.isFinite(ms)) return false;
  return ms >= Date.parse(range.startUtc) && ms < Date.parse(range.endUtcExclusive);
}
