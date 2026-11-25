/**
 * Task 17: freshness and coverage of a PUBLISHED report generation (pure).
 *
 * Freshness is measured from verified source coverage (the generation's
 * verifiedAtUtc, which a quiet no-change cycle also advances), never from
 * render time or event time:
 *   ≤30 min   current          (refresh normally every 15 min)
 *   ≤120 min  "Update delayed"
 *   >120 min  "Report out of date"
 * A generation covers production dates up to the production date of its
 * source cutoff; after the 04:00 rollover an older generation does not yet
 * cover "today", and today's figures must say so rather than show zeroes.
 */
import { productionDateAt, type ReportSite } from "./productionPeriods.js";

export const REFRESH_INTERVAL_MIN = 15;
export const DELAYED_AFTER_MIN = 30;
export const OUTDATED_AFTER_MIN = 120;

export type FreshnessState = "current" | "delayed" | "outdated";
export interface Freshness {
  state: FreshnessState;
  /** User-facing warning; null while current. */
  label: "Update delayed" | "Report out of date" | null;
  /** Whole minutes since verified coverage (never negative). */
  ageMinutes: number;
  /** When the next 15-minute refresh is due (verified + 15 min). */
  refreshDueUtc: string;
  refreshOverdue: boolean;
}

const MIN = 60_000;

export function publishedFreshness(verifiedAtUtc: string, nowMs: number): Freshness {
  const v = Date.parse(verifiedAtUtc);
  if (!Number.isFinite(v)) throw new RangeError("verifiedAtUtc is not a valid instant");
  const age = Math.max(0, nowMs - v);
  const state: FreshnessState = age <= DELAYED_AFTER_MIN * MIN ? "current" : age <= OUTDATED_AFTER_MIN * MIN ? "delayed" : "outdated";
  return {
    state,
    label: state === "current" ? null : state === "delayed" ? "Update delayed" : "Report out of date",
    ageMinutes: Math.floor(age / MIN),
    refreshDueUtc: new Date(v + REFRESH_INTERVAL_MIN * MIN).toISOString(),
    refreshOverdue: age > REFRESH_INTERVAL_MIN * MIN,
  };
}

/** The last production date the generation covers, and whether that includes the site's current production date. */
export function publishedCoverage(site: ReportSite, sourceCutoffUtc: string, nowMs: number): { coveredThrough: string; today: string; coversToday: boolean } {
  const cutoff = new Date(sourceCutoffUtc);
  if (!Number.isFinite(cutoff.getTime())) throw new RangeError("sourceCutoffUtc is not a valid instant");
  const coveredThrough = productionDateAt(cutoff, site);
  const today = productionDateAt(new Date(nowMs), site);
  return { coveredThrough, today, coversToday: coveredThrough >= today };
}
