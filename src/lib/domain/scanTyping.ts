/**
 * Tells a barcode scanner from a person typing, inside one text box.
 *
 * The idle station focuses its Order number box so a person can type at once.
 * A focused input swallows the keys the page-wide scan listener would read,
 * so a scanner that sends no Enter would never submit. This trace lets the
 * box submit by itself, but only when every key arrived at scanner speed
 * (a person typing does not).
 *
 * Pure: the caller passes the clock.
 */

export interface TypingTrace {
  /** Characters seen since the box was last empty. */
  chars: number;
  lastAt: number;
  /** True while every gap between keys stayed under the limit. */
  allFast: boolean;
}

/** Scanners send keys a few ms apart; people take 80 ms or more. */
export const FAST_KEY_GAP_MS = 60;

/** Update the trace for a change that added `added` characters at `now`. */
export function nextTrace(prev: TypingTrace | null, added: number, now: number, gapMs: number = FAST_KEY_GAP_MS): TypingTrace | null {
  if (added <= 0) return prev;
  if (!prev) return { chars: added, lastAt: now, allFast: true };
  const fast = now - prev.lastAt <= gapMs;
  return { chars: prev.chars + added, lastAt: now, allFast: prev.allFast && fast };
}

/** True when the text in the box came in at scanner speed. */
export function looksLikeScanner(trace: TypingTrace | null, minChars = 4): boolean {
  return !!trace && trace.allFast && trace.chars >= minChars;
}
