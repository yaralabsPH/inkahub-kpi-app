/**
 * Tiny ISO-date utilities. All dates are YYYY-MM-DD strings interpreted as
 * **local-time** dates (the day a human in this timezone calls it). Every
 * helper below uses local-time getters/setters so we never drift across
 * midnight at the BST/UTC boundary.
 */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayIso(): string {
  return formatIso(new Date());
}

export function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export function addDays(iso: string, days: number): string {
  const d = parseIsoDate(iso);
  d.setDate(d.getDate() + days);
  return formatIso(d);
}

/** The Monday of the ISO week containing this date. */
export function isoWeekStart(iso: string): string {
  const d = parseIsoDate(iso);
  const day = d.getDay(); // Sun = 0 … Sat = 6
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(iso, diff);
}

/** The next Monday strictly after `iso` (returns next Mon if `iso` is already Monday). */
export function nextMonday(iso: string): string {
  const d = parseIsoDate(iso);
  const day = d.getDay();
  const offset = ((1 - day + 7) % 7) || 7;
  return addDays(iso, offset);
}

/** Inclusive overlap test on two YYYY-MM-DD ranges. */
export function rangesOverlap(a1: string, a2: string, b1: string, b2: string): boolean {
  return a1 <= b2 && b1 <= a2;
}

/**
 * Whole-day difference between two ISO dates. Positive if `b` is after `a`,
 * negative if before. Uses local-day arithmetic so results are stable across
 * DST transitions (we round to the nearest day to swallow the hour-shift).
 */
export function diffDays(a: string, b: string): number {
  const ms = parseIsoDate(b).getTime() - parseIsoDate(a).getTime();
  return Math.round(ms / 86_400_000);
}
