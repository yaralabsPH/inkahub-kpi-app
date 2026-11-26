/**
 * Double-tap guard for the classic /production Complete / Dispatch button.
 *
 * The button saves one `completed` / `dispatched` event for the whole order.
 * Nothing locked it while the save was running, and the order stays on the
 * screen for a moment after it saves, so a double tap wrote two events
 * (live AU order 10252935 on 2026-11-26 was dispatched twice, 0.45 s apart;
 * 196 orders in the 30 days before had the same pattern).
 *
 * Kept in a ref (synchronous), not React state: two taps in one tick both
 * see the same state. Pure: the caller passes the clock.
 */

/** A deliberate second completion of the same order is never this fast. */
export const REPEAT_COMPLETE_WINDOW_MS = 10_000;

export interface CompletionGuard {
  /** Order being saved right now (one at a time per station). */
  inFlight: string | null;
  /** Last order saved, and when. */
  last: { key: string; at: number } | null;
}

export function createCompletionGuard(): CompletionGuard {
  return { inFlight: null, last: null };
}

export function completionKey(location: string, department: string, orderNumber: string): string {
  return `${location}\u0000${department}\u0000${orderNumber.trim()}`;
}

/** True when this tap may save; it then holds the guard until endCompletion. */
export function beginCompletion(g: CompletionGuard, key: string, now: number): boolean {
  if (g.inFlight !== null) return false;
  if (g.last && g.last.key === key) {
    const age = now - g.last.at;
    if (age >= 0 && age < REPEAT_COMPLETE_WINDOW_MS) return false;
  }
  g.inFlight = key;
  return true;
}

/** Release the guard. A failed save is not remembered, so the worker can retry at once. */
export function endCompletion(g: CompletionGuard, key: string, saved: boolean, now: number): void {
  if (g.inFlight !== key) return;
  g.inFlight = null;
  if (saved) g.last = { key, at: now };
}
