/**
 * Repeat-scan guard for the classic /production station.
 *
 * A lanyard is 8 characters, so the page submits it as soon as the 8th key
 * arrives. The scanner then sends Enter, which submits the same text a
 * second time before React has cleared the buffer. Two submits of one
 * lanyard wrote two clock_in rows (staging test, 2026-11-24).
 *
 * Pure: the caller passes the clock.
 */

export interface LastScan {
  value: string;
  at: number;
}

/** A real second scan of the same code is never this fast. */
export const REPEAT_SCAN_WINDOW_MS = 1500;

export function shouldDropRepeatScan(
  last: LastScan | null,
  value: string,
  now: number,
  windowMs: number = REPEAT_SCAN_WINDOW_MS,
): boolean {
  if (!last) return false;
  return last.value === value && now - last.at >= 0 && now - last.at < windowMs;
}
