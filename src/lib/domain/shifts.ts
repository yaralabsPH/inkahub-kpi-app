/**
 * shifts.ts - shared "compute a worker's billable hours from raw
 * production_events" helper. Consumers: Welcome "Currently clocked in"
 * tile, daily timesheet CSV on /reports, dashboard "Today's labour
 * hours" widget.
 *
 * Workflow it models (matches the kiosk):
 *
 *   1. Worker scans lanyard at start of shift -> clock_in event
 *   2. Worker scans an order -> started event (line_sku = null, order
 *      number set). Auto-fired on order load.
 *   3. Worker finishes the order -> completed event (or dispatched at
 *      the dispatch dept).
 *   4. Worker grabs the next order, OR takes a break, OR signs out.
 *      The interval between the last completed and the next started
 *      (or clock_out) is the only place a break can land.
 *   5. End of day -> clock_out event (or just leaves; the silence rule
 *      below infers the end time).
 *
 * Rules:
 *
 *   - "In progress" gap = time covered by an unclosed started event.
 *     Always paid. Long focused work is fine.
 *   - "Between orders" gap = time when no started event is open. If the
 *     gap exceeds gapThresholdMin (default 30), the WHOLE gap is treated
 *     as a break and deducted.
 *   - No clock_out by end of stream + last event was >= staleHours ago:
 *     shift effectively ended at that last event + staleBufferMin (so a
 *     forgotten clock_out doesn't bill the rest of the day).
 *   - Multiple clock_in events for the same staff on the same date are
 *     supported: each clock_in starts a new shift, each clock_out closes
 *     the current one.
 */

export interface ShiftEvent {
  staff_id: string;
  event_type: string;
  order_number: string | null;
  created_at: string; // ISO timestamp
}

export interface ShiftBreak {
  from: string;
  to: string;
  seconds: number;
}

export interface Shift {
  staff_id: string;
  /** YYYY-MM-DD in local browser time. */
  date: string;
  clock_in_at: string;
  /** Real clock_out timestamp, or null if the shift was inferred. */
  clock_out_at: string | null;
  /** Where the shift effectively ends for billing purposes. */
  effective_end_at: string;
  /** True if no real clock_out, end was inferred from silence rule. */
  inferred_end: boolean;
  /** Wall-clock seconds from clock_in to effective_end. */
  total_seconds: number;
  /** Sum of break (deducted) seconds. */
  break_seconds: number;
  /** total_seconds - break_seconds. */
  billable_seconds: number;
  breaks: ShiftBreak[];
}

export interface ShiftOptions {
  /** Between-orders gap above this is a break. Default 30. */
  gapThresholdMin?: number;
  /**
   * If the gap from the last meaningful event to "now" (or to a clock_out)
   * exceeds this, the shift is treated as having ended at that last event.
   * Default 2 hours.
   */
  staleHours?: number;
  /** Buffer added to the last event timestamp when inferring shift end. Default 5. */
  staleBufferMin?: number;
  /**
   * Use this as the "now" timestamp when computing inferred ends. Defaults
   * to new Date(). Override in tests or for offline reports.
   */
  now?: Date;
}

const ORDER_BRACKET_OPEN_TYPES = new Set(["started"]);
const ORDER_BRACKET_CLOSE_TYPES = new Set(["completed", "dispatched"]);
const CLOCK_IN_TYPES = new Set(["clock_in"]);
const CLOCK_OUT_TYPES = new Set(["clock_out"]);

/** Local-time YYYY-MM-DD from an ISO timestamp. */
function localDateKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function secondsBetween(aIso: string, bIso: string): number {
  return Math.max(0, Math.round((new Date(bIso).getTime() - new Date(aIso).getTime()) / 1000));
}

/**
 * Walk the events of ONE worker on ONE day and produce shift summaries.
 * Events should be sorted ascending by created_at.
 */
function computeShiftsForStaffDay(
  staffId: string,
  date: string,
  events: ShiftEvent[],
  opts: Required<Omit<ShiftOptions, "now">> & { now: Date },
): Shift[] {
  const shifts: Shift[] = [];
  const gapThresholdSec = opts.gapThresholdMin * 60;
  const staleSec = opts.staleHours * 3600;
  const staleBufferSec = opts.staleBufferMin * 60;

  let i = 0;
  while (i < events.length) {
    const e = events[i];
    if (!CLOCK_IN_TYPES.has(e.event_type)) { i++; continue; }

    const clockInAt = e.created_at;
    let cursor = clockInAt;
    let clockOutAt: string | null = null;
    let lastMeaningfulAt = clockInAt;
    const openOrders = new Set<string>();
    const breaks: ShiftBreak[] = [];

    // Walk forward through the day until we see this shift's clock_out,
    // a NEW clock_in (=> previous shift implicitly ended), or run out.
    let j = i + 1;
    for (; j < events.length; j++) {
      const ev = events[j];
      const gap = secondsBetween(cursor, ev.created_at);

      // If we're not in an open order and the gap exceeds threshold,
      // that's a break. Even if this event is a clock_out itself, the
      // gap before it counts.
      if (openOrders.size === 0 && gap >= gapThresholdSec) {
        breaks.push({ from: cursor, to: ev.created_at, seconds: gap });
      }

      if (CLOCK_OUT_TYPES.has(ev.event_type)) {
        clockOutAt = ev.created_at;
        cursor = ev.created_at;
        lastMeaningfulAt = ev.created_at;
        j++; // consume the clock_out event
        break;
      }
      if (CLOCK_IN_TYPES.has(ev.event_type)) {
        // A new clock_in implicitly closes this shift right before it.
        // The previous "lastMeaningfulAt" becomes the inferred end.
        break;
      }
      if (ORDER_BRACKET_OPEN_TYPES.has(ev.event_type) && ev.order_number) {
        openOrders.add(ev.order_number);
      }
      if (ORDER_BRACKET_CLOSE_TYPES.has(ev.event_type) && ev.order_number) {
        openOrders.delete(ev.order_number);
      }
      cursor = ev.created_at;
      lastMeaningfulAt = ev.created_at;
    }

    // Determine effective_end:
    let effectiveEndAt: string;
    let inferredEnd = false;
    if (clockOutAt) {
      effectiveEndAt = clockOutAt;
    } else {
      const sinceLast = secondsBetween(lastMeaningfulAt, opts.now.toISOString());
      if (sinceLast >= staleSec) {
        // Forgotten clock_out / shift has been silent for >= staleHours.
        // Cap the shift at last event + small buffer.
        const buffered = new Date(new Date(lastMeaningfulAt).getTime() + staleBufferSec * 1000);
        effectiveEndAt = buffered.toISOString();
        inferredEnd = true;
      } else {
        // Still active or only recently silent - bill up to now.
        effectiveEndAt = opts.now.toISOString();
        inferredEnd = true;
      }
    }

    const totalSec = secondsBetween(clockInAt, effectiveEndAt);
    // Any break "to" timestamp that landed past effectiveEnd should clip.
    const clippedBreaks = breaks
      .map((b) => {
        const to = (new Date(b.to).getTime() > new Date(effectiveEndAt).getTime())
          ? effectiveEndAt : b.to;
        return { from: b.from, to, seconds: secondsBetween(b.from, to) };
      })
      .filter((b) => b.seconds >= gapThresholdSec);
    const breakSec = clippedBreaks.reduce((s, b) => s + b.seconds, 0);

    shifts.push({
      staff_id: staffId,
      date,
      clock_in_at: clockInAt,
      clock_out_at: clockOutAt,
      effective_end_at: effectiveEndAt,
      inferred_end: inferredEnd,
      total_seconds: totalSec,
      break_seconds: breakSec,
      billable_seconds: Math.max(0, totalSec - breakSec),
      breaks: clippedBreaks,
    });

    i = j;
  }
  return shifts;
}

/**
 * Compute one Shift object per (staff_id, clock_in) pair. Caller filters
 * events to the relevant location + date range BEFORE calling - the helper
 * doesn't know about locations or RLS, just the event stream.
 */
export function computeShifts(events: ShiftEvent[], opts: ShiftOptions = {}): Shift[] {
  const o: Required<Omit<ShiftOptions, "now">> & { now: Date } = {
    gapThresholdMin: opts.gapThresholdMin ?? 30,
    staleHours: opts.staleHours ?? 2,
    staleBufferMin: opts.staleBufferMin ?? 5,
    now: opts.now ?? new Date(),
  };
  // Sort ascending.
  const sorted = [...events].sort((a, b) => a.created_at.localeCompare(b.created_at));
  // Group by staff + local date.
  const groups = new Map<string, ShiftEvent[]>();
  for (const e of sorted) {
    const key = `${e.staff_id}::${localDateKey(e.created_at)}`;
    const arr = groups.get(key) ?? [];
    arr.push(e);
    groups.set(key, arr);
  }
  const out: Shift[] = [];
  for (const [key, evs] of groups) {
    const [staffId, date] = key.split("::");
    out.push(...computeShiftsForStaffDay(staffId, date, evs, o));
  }
  // Sort output: oldest shifts first, then by staff for stable order.
  out.sort((a, b) => a.clock_in_at.localeCompare(b.clock_in_at) || a.staff_id.localeCompare(b.staff_id));
  return out;
}

/** Format helper for UI - returns "Hh Mm" given seconds. */
export function formatShiftDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Whether someone is currently signed in (most recent clock event is clock_in). */
export function isCurrentlySignedIn(events: ShiftEvent[], staffId: string): boolean {
  const clockEvents = events
    .filter((e) => e.staff_id === staffId && (CLOCK_IN_TYPES.has(e.event_type) || CLOCK_OUT_TYPES.has(e.event_type)))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (clockEvents.length === 0) return false;
  return CLOCK_IN_TYPES.has(clockEvents[clockEvents.length - 1].event_type);
}

/**
 * Hourly rate fallback for staff without their own staff_rates row.
 *
 * In the current setup: Steph, Ean, Max each have their own auth account
 * AND can have a custom rate via /team. The 14 barcode-only staff have no
 * auth account and don't need their own rate maintained - they all bill
 * at this default. Edit here to change the floor rate.
 */
export const DEFAULT_HOURLY_RATE = 30;

/**
 * Resolve the effective hourly rate for a staff member. Pass the value
 * from staff_rates (or null/undefined if no row exists); returns the
 * explicit rate if set, otherwise the default.
 */
export function effectiveHourlyRate(rate: number | null | undefined): number {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return DEFAULT_HOURLY_RATE;
  return rate;
}
