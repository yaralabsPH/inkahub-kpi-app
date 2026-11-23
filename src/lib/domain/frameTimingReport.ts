/**
 * F9 Frame timing: measured scan gaps and Max-method estimates per frame
 * size/type, from the stream rows of ONE pinned published generation.
 * Pure; runs on the server (api/reports/timing.ts) and in tests.
 *
 * Measured (scan gap): per worker and production day, every effective framing
 * capture is timed by the positive gap (<= 30 min) since the previous FRAMING
 * capture. A shared-scanner request (ids scn-<32 hex>-vNN) is ONE capture
 * even with several lines; classic events are one capture each. A clock-in/out
 * or any other effective verification (UN, accessories, dispatch...) between
 * them breaks the chain. The gap is split across the capture's lines by pieces.
 *
 * Estimated (Max method): per verified shift (one clock-in..clock-out pair
 * inside one production day, not after the cutoff), productive minutes =
 * min(attendance, 450) * 405/450, minus the shift's measured minutes (all
 * work, before any filter), clamped at 0, split across the shift's UNMEASURED
 * frame pieces by pieces * size weight. A missing weight or missing/malformed
 * attendance makes those estimates unavailable; nothing is guessed.
 *
 * The whole stream and every shift are computed BEFORE person/work-type/
 * department filters, so filtering never changes a gap or an allocation.
 */
import { parseSku } from "./skuRouting";

export const GAP_CAP_MIN = 30;
export const ATTENDANCE_CAP_MIN = 450;
export const PRODUCTIVE_RATIO = 405 / 450;
export const WEIGHT_SIZES = ["A0", "A1", "A2", "A3", "A4", "GW"] as const;
export type WeightSize = (typeof WEIGHT_SIZES)[number];
export const MAX_WEIGHT = 1000;
const FRAMING = new Set(["framed", "a0_framed"]);
const SCN = /^scn-([0-9a-f]{32})-v[0-9]{2}$/;

export interface TimingStreamRow {
  id: string;
  staffId: string;
  /** UTC instant. */
  at: string;
  productionDate: string;
  kind: "verify" | "clock_in" | "clock_out";
  workType: string | null;
  sku: string | null;
  /** F1 frame pieces (timing_weight): 0 for UN and non-frame lines. */
  pieces: number;
  /** F1 effective verification (not cancelled through a valid edge). */
  effective: boolean;
  rework: boolean;
  departmentId: string | null;
}

export interface WeightSet { version: number; weights: Partial<Record<WeightSize, number>> }
export interface TimingFilters { staffId?: string; workType?: string; departmentId?: string }

export interface TimingGroup {
  key: string;
  size: string | null;
  variant: string | null;
  rework: boolean;
  pieces: number;
  timedPieces: number;
  measuredMinutes: number;
  /** Measured minutes per timed piece; null without timed pieces. */
  measuredAvg: number | null;
  untimedPieces: number;
  estimatedPieces: number;
  estimatedMinutes: number;
  /** Estimated minutes per estimated piece; null without estimates. Never blended with measured. */
  estimatedAvg: number | null;
  unavailablePieces: number;
}
export interface TimingCoverage {
  framePieces: number;
  timedPieces: number;
  untimedPieces: number;
  estimatedPieces: number;
  unavailablePieces: number;
  /** Untimed pieces with no verified shift around them. */
  noAttendancePieces: number;
  /** Untimed pieces whose shift lacked a required size weight. */
  missingWeightPieces: number;
  missingWeightSizes: string[];
  shifts: number;
  malformedAttendanceDays: number;
}
export interface FrameTimingBody {
  groups: TimingGroup[];
  coverage: TimingCoverage;
  weights: WeightSet | null;
}

/** Capture identity: one shared-scanner request, or one classic event. */
export function captureKey(id: string): string {
  const m = SCN.exec(id);
  return m ? `scn-${m[1]}` : `evt:${id}`;
}

export function sizeOf(sku: string | null): { size: string | null; variant: string | null } {
  const p = sku ? parseSku(sku) : null;
  return p ? { size: p.size ?? null, variant: p.variant ?? null } : { size: null, variant: null };
}

export function validateWeights(w: unknown): Partial<Record<WeightSize, number>> {
  if (!w || typeof w !== "object" || Array.isArray(w)) throw new RangeError("weights must be an object");
  const out: Partial<Record<WeightSize, number>> = {};
  const entries = Object.entries(w as Record<string, unknown>);
  if (entries.length === 0) throw new RangeError("enter at least one size weight");
  for (const [k, v] of entries) {
    if (!(WEIGHT_SIZES as readonly string[]).includes(k)) throw new RangeError(`unknown size ${k.slice(0, 10)}`);
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > MAX_WEIGHT) throw new RangeError(`weight for ${k} must be a positive number up to ${MAX_WEIGHT}`);
    out[k as WeightSize] = v;
  }
  return out;
}

const ms = (iso: string) => Date.parse(iso);
const isFrame = (r: TimingStreamRow) => r.kind === "verify" && r.effective && r.pieces > 0 && r.workType !== null && FRAMING.has(r.workType);
const isBreak = (r: TimingStreamRow) => r.kind !== "verify" || (r.effective && !isFrame(r));

interface RowOut { row: TimingStreamRow; measured: number | null; estimate: number | null; unavailable: "attendance" | "weight" | null }

/** Measured and estimated minutes for every framing row (before filters). */
export function timeStream(rows: readonly TimingStreamRow[], weights: WeightSet | null, cutoffUtc: string): { rows: RowOut[]; shifts: number; malformedAttendanceDays: number; missingWeightSizes: Set<string> } {
  const out: RowOut[] = [];
  let shifts = 0;
  let malformed = 0;
  const missing = new Set<string>();
  const byDay = new Map<string, TimingStreamRow[]>();
  for (const r of rows) {
    const k = `${r.staffId}|${r.productionDate}`;
    const list = byDay.get(k) ?? [];
    list.push(r);
    byDay.set(k, list);
  }
  const cutoff = ms(cutoffUtc);
  for (const list of byDay.values()) {
    // 1. captures and breaks, in time order (a break at the same instant comes first)
    type El = { t: number; brk: boolean; key: string; lines: TimingStreamRow[] };
    const caps = new Map<string, El>();
    const els: El[] = [];
    for (const r of list) {
      if (isFrame(r)) {
        const key = captureKey(r.id);
        const c = caps.get(key);
        if (c) {
          c.lines.push(r);
          c.t = Math.min(c.t, ms(r.at));
        } else {
          const el = { t: ms(r.at), brk: false, key, lines: [r] };
          caps.set(key, el);
          els.push(el);
        }
      } else if (isBreak(r)) els.push({ t: ms(r.at), brk: true, key: r.id, lines: [] });
    }
    els.sort((a, b) => a.t - b.t || Number(b.brk) - Number(a.brk) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const measuredOf = new Map<TimingStreamRow, number | null>();
    for (let i = 0; i < els.length; i++) {
      const e = els[i];
      if (e.brk) continue;
      const prev = els[i - 1];
      const gap = prev && !prev.brk ? (e.t - prev.t) / 60_000 : null;
      const timed = gap !== null && gap > 0 && gap <= GAP_CAP_MIN;
      const total = e.lines.reduce((s, l) => s + l.pieces, 0);
      for (const l of e.lines) measuredOf.set(l, timed ? (gap as number) * (l.pieces / total) : null);
    }
    // 2. attendance: well-formed alternating pairs, not after the cutoff
    const clocks = list.filter((r) => r.kind !== "verify").sort((a, b) => ms(a.at) - ms(b.at) || (a.id < b.id ? -1 : 1));
    let pairs: Array<[number, number]> | null = [];
    if (clocks.length % 2 !== 0) pairs = null;
    else
      for (let i = 0; i < clocks.length; i += 2) {
        const a = clocks[i];
        const b = clocks[i + 1];
        if (a.kind !== "clock_in" || b.kind !== "clock_out" || !(ms(b.at) > ms(a.at)) || ms(b.at) > cutoff || !Number.isFinite(ms(a.at))) {
          pairs = null;
          break;
        }
        pairs.push([ms(a.at), ms(b.at)]);
      }
    if (pairs === null) malformed++;
    const shiftOf = (t: number) => (pairs ? pairs.findIndex(([a, b]) => t >= a && t <= b) : -1);
    // 3. Max method per shift
    const frames = [...measuredOf.keys()];
    const estimateOf = new Map<TimingStreamRow, { estimate: number | null; unavailable: RowOut["unavailable"] }>();
    for (const f of frames) if (measuredOf.get(f) === null) estimateOf.set(f, { estimate: null, unavailable: "attendance" });
    for (const [si, [a, b]] of (pairs ?? []).entries()) {
      shifts++;
      const inShift = frames.filter((f) => shiftOf(ms(f.at)) === si);
      const measured = inShift.reduce((s, f) => s + (measuredOf.get(f) ?? 0), 0);
      const remaining = Math.max(0, Math.min((b - a) / 60_000, ATTENDANCE_CAP_MIN) * PRODUCTIVE_RATIO - measured);
      const unmeasured = inShift.filter((f) => measuredOf.get(f) === null);
      if (unmeasured.length === 0) continue;
      const w = (f: TimingStreamRow) => {
        const s = sizeOf(f.sku).size;
        return s && weights ? weights.weights[s as WeightSize] ?? null : null;
      };
      const lacking = unmeasured.filter((f) => w(f) === null);
      if (lacking.length) {
        for (const f of lacking) missing.add(sizeOf(f.sku).size ?? "unknown");
        for (const f of unmeasured) estimateOf.set(f, { estimate: null, unavailable: "weight" });
        continue;
      }
      const denom = unmeasured.reduce((s, f) => s + f.pieces * (w(f) as number), 0);
      for (const f of unmeasured) estimateOf.set(f, { estimate: denom > 0 ? (remaining * f.pieces * (w(f) as number)) / denom : 0, unavailable: null });
    }
    for (const f of frames) {
      const e = estimateOf.get(f);
      out.push({ row: f, measured: measuredOf.get(f) ?? null, estimate: e?.estimate ?? null, unavailable: e?.unavailable ?? null });
    }
  }
  return { rows: out, shifts, malformedAttendanceDays: malformed, missingWeightSizes: missing };
}

/** Aggregate per size-variant and normal/rework AFTER the whole stream was timed. */
export function computeFrameTiming(rows: readonly TimingStreamRow[], weights: WeightSet | null, cutoffUtc: string, filters: TimingFilters = {}): FrameTimingBody {
  const t = timeStream(rows, weights, cutoffUtc);
  const keep = (r: TimingStreamRow) =>
    (!filters.staffId || r.staffId === filters.staffId) &&
    (!filters.workType || r.workType === filters.workType) &&
    (!filters.departmentId || (filters.departmentId === "unknown" ? r.departmentId === null : r.departmentId === filters.departmentId));
  const groups = new Map<string, TimingGroup>();
  const cov: TimingCoverage = { framePieces: 0, timedPieces: 0, untimedPieces: 0, estimatedPieces: 0, unavailablePieces: 0, noAttendancePieces: 0, missingWeightPieces: 0, missingWeightSizes: [...t.missingWeightSizes].sort(), shifts: t.shifts, malformedAttendanceDays: t.malformedAttendanceDays };
  for (const o of t.rows) {
    if (!keep(o.row)) continue;
    const { size, variant } = sizeOf(o.row.sku);
    const base = size && variant ? `${size}-${variant}` : "other";
    const key = `${base}|${o.row.rework ? "rework" : "normal"}`;
    const g = groups.get(key) ?? { key: base, size, variant, rework: o.row.rework, pieces: 0, timedPieces: 0, measuredMinutes: 0, measuredAvg: null, untimedPieces: 0, estimatedPieces: 0, estimatedMinutes: 0, estimatedAvg: null, unavailablePieces: 0 };
    const p = o.row.pieces;
    g.pieces += p;
    cov.framePieces += p;
    if (o.measured !== null) {
      g.timedPieces += p;
      g.measuredMinutes += o.measured;
      cov.timedPieces += p;
    } else {
      g.untimedPieces += p;
      cov.untimedPieces += p;
      if (o.estimate !== null) {
        g.estimatedPieces += p;
        g.estimatedMinutes += o.estimate;
        cov.estimatedPieces += p;
      } else {
        g.unavailablePieces += p;
        cov.unavailablePieces += p;
        if (o.unavailable === "weight") cov.missingWeightPieces += p;
        else cov.noAttendancePieces += p;
      }
    }
    groups.set(key, g);
  }
  const list = [...groups.values()].map((g) => ({
    ...g,
    measuredAvg: g.timedPieces > 0 ? g.measuredMinutes / g.timedPieces : null,
    estimatedAvg: g.estimatedPieces > 0 ? g.estimatedMinutes / g.estimatedPieces : null,
  }));
  list.sort((a, b) => Number(a.rework) - Number(b.rework) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { groups: list, coverage: cov, weights };
}

// ---------------------------------------------------------------------------
// CSV (method labels are explicit; formula prefixes neutralised by the shared cell)
// ---------------------------------------------------------------------------

const r2 = (n: number | null) => (n === null ? "" : (Math.round(n * 100) / 100).toString());

export function frameTimingCsv(body: FrameTimingBody, ctx: { site: string; firstDate: string; lastDate: string; generationId: string; sourceCutoffUtc: string; filters: string }, cell: (v: string) => string): string {
  const lines: string[][] = [
    ["report", "frame timing"],
    ["site", ctx.site],
    ["first_date", ctx.firstDate],
    ["last_date", ctx.lastDate],
    ["filters", ctx.filters],
    ["generation", ctx.generationId],
    ["source_cutoff_utc", ctx.sourceCutoffUtc],
    ["measured_method", "scan gap: minutes since the same worker's previous framing scan, gaps over 30 min or across a clock/other scan/day not timed; not stopwatch timing"],
    ["estimated_method", body.weights ? `Max method: 405/450 of verified shift attendance (max 450 min) minus measured minutes, split by size weights version ${body.weights.version} (an assumption applied to this report)` : "Max method: unavailable (no size weights saved for this site)"],
    [],
    ["frame", "work", "pieces", "timed_pieces", "measured_minutes", "measured_min_per_piece", "untimed_pieces", "estimated_pieces", "estimated_minutes", "estimated_min_per_piece", "unavailable_pieces"],
  ];
  for (const g of body.groups)
    lines.push([g.key, g.rework ? "CS/rework" : "normal", String(g.pieces), String(g.timedPieces), r2(g.measuredMinutes), r2(g.measuredAvg), String(g.untimedPieces), String(g.estimatedPieces), r2(g.estimatedMinutes), r2(g.estimatedAvg), String(g.unavailablePieces)]);
  return lines.map((l) => l.map(cell).join(",")).join("\r\n");
}
