/**
 * Frame-time observations for Reports (average minutes per unit, hours, cost).
 *
 * This is deliberately NOT the F1 Items count. It preserves the existing
 * Reports timing stream (`deriveCompletedLines` before F1):
 *   - per worker, the predecessor is the previous accepted verified line
 *     (framed, picture-frame, UN or unparseable legacy SKUs);
 *   - a gap counts only when it is positive and at most 30 minutes, and only
 *     for frame lines (FN/FB/FW prints and picture frames);
 *   - the duration is weighted by the line's frame units (quantity, legacy
 *     default 1, times set pieces).
 * UN lines stay zero-weight observations, so counting UN Items in F1 never
 * changes average-minute, cost or effort denominators. Cancellations use the
 * shared resolved parents from `prepareProductionEvidence`.
 *
 * The frame predicates live here (moved from skuRouting.ts) because only frame
 * timing uses them; counting uses productionItems.ts.
 */
import { parseSku } from "./skuRouting";
import type { PreparedProductionEvidence, ProductionScope, WorkType } from "./productionCounts";

export const FRAME_GAP_CAP_MIN = 30;

/** Frame lines: FN/FB/FW single and set prints, picture frames. */
export function isFrameTimingSku(sku: string | null | undefined): boolean {
  if (!sku) return false;
  const p = parseSku(sku);
  if (!p) return false;
  if (p.type === "gift_card" || p.type === "aux_other" || p.type === "aux_free_print") return false;
  if (p.type === "picture_frame") return true;
  return p.variant === "FN" || p.variant === "FB" || p.variant === "FW";
}

/** Lines that take part in the timing stream (frame lines, UN, unparseable legacy titles). */
export function isTimingStreamSku(sku: string | null | undefined): boolean {
  if (!sku) return false;
  const p = parseSku(sku);
  if (!p) return true;
  if (p.type === "gift_card" || p.type === "aux_other" || p.type === "aux_free_print") return false;
  if (p.type === "picture_frame") return true;
  return p.variant === "FN" || p.variant === "FB" || p.variant === "FW" || p.variant === "UN";
}

/** Frame units used to weight a timing gap (legacy weighting; not an Items count). */
export function frameTimingWeight(sku: string | null | undefined, quantity: unknown): number {
  if (!isFrameTimingSku(sku)) return 0;
  const qty = typeof quantity === "number" && Number.isFinite(quantity) ? quantity : 1;
  const p = parseSku(sku as string);
  const pieces = p && p.type === "set_print" && typeof p.setCount === "number" && p.setCount > 0 ? p.setCount : 1;
  return qty * pieces;
}

export interface FrameTimingLine {
  eventId: string;
  staffId: string;
  workType: WorkType;
  orderNumber: string;
  sku: string | null;
  /** Frame units (0 for UN/legacy lines). */
  weight: number;
  startedAtMs: number;
  completedAtMs: number;
  /** Minutes credited to this line (0 when the gap is not a valid frame observation). */
  durationMin: number;
}

export interface FrameTimingTotals {
  durationMin: number;
  /** Units behind timed lines only (the average-minute denominator). */
  timedWeight: number;
  avgMinPerUnit: number;
}

/** Timing lines for a scope (range and work types; staff narrows the result, not the predecessor stream). */
export function frameTimingLines(evidence: PreparedProductionEvidence, scope: ProductionScope): FrameTimingLine[] {
  const startMs = Date.parse(scope.range.startUtc);
  const endMs = Date.parse(scope.range.endUtcExclusive);
  const types = scope.workTypes ? new Set<string>(scope.workTypes) : null;
  const staff = scope.staffIds ? new Set(scope.staffIds) : null;
  const prevByWorker = new Map<string, number>();
  const out: FrameTimingLine[] = [];
  for (const v of evidence.verifications) {
    if (!v.effective) continue;
    if (v.ev.ms < startMs || v.ev.ms >= endMs) continue;
    if (types && !types.has(v.workType)) continue;
    if (!isTimingStreamSku(v.ev.line_sku)) continue;
    const worker = v.ev.staff_id as string;
    const weight = frameTimingWeight(v.ev.line_sku, v.ev.line_quantity);
    const prevMs = prevByWorker.get(worker);
    const gapMin = prevMs === undefined ? 0 : (v.ev.ms - prevMs) / 60_000;
    const timed = prevMs !== undefined && gapMin > 0 && gapMin <= FRAME_GAP_CAP_MIN && weight > 0;
    prevByWorker.set(worker, v.ev.ms);
    if (staff && !staff.has(worker)) continue;
    out.push({
      eventId: v.ev.id,
      staffId: worker,
      workType: v.workType,
      orderNumber: v.ev.orderKey,
      sku: v.ev.line_sku,
      weight,
      startedAtMs: prevMs ?? v.ev.ms,
      completedAtMs: v.ev.ms,
      durationMin: timed ? gapMin : 0,
    });
  }
  return out;
}

export function frameTimingTotals(lines: readonly FrameTimingLine[]): FrameTimingTotals {
  let durationMin = 0;
  let timedWeight = 0;
  for (const l of lines) {
    durationMin += l.durationMin;
    if (l.durationMin > 0) timedWeight += l.weight;
  }
  return { durationMin, timedWeight, avgMinPerUnit: timedWeight > 0 ? durationMin / timedWeight : 0 };
}
