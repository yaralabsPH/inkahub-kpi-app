/**
 * F10 Order timeline: evidence model and pure projection (F11 stages included,
 * no receiver yet). Pure; no I/O.
 *
 * Identity is site + normalized Shopify shop + immutable Shopify order id; the
 * order number is an alias only. A projection takes exactly ONE mapped identity
 * and keeps it; mixed or unmapped evidence is refused. Evidence records are
 * immutable occurrences keyed by source + key: same content is a duplicate,
 * different content a conflict that keeps the original. Only CONFIRMED evidence
 * confirms a stage; reported/inferred stays "unconfirmed" and never enters
 * shipment metrics. Dispatch never proves shipment; complete shipment needs a
 * confirmed fulfillment covering the order; delivered needs Shopify evidence;
 * framing is complete only with explicit whole-order proof. CS/replacement
 * work never completes the original order. Missing stages stay missing.
 * Durations only: adjacent confirmed gaps, neutral median/P90 and counts; no
 * lateness, thresholds or performance labels exist here.
 */

export const ORDER_SITES = ["au", "uk", "us"] as const;
export type OrderSite = (typeof ORDER_SITES)[number];

/** F10 stages, then F11 automation stages (receiver comes with F11). */
export const ORDER_STAGES = [
  "ordered", "cancelled", "framed", "dispatched", "shipped", "delivered",
  "make_submitted", "make_files_found", "make_planned", "make_images_ready", "make_packing_ready",
] as const;
export type OrderStage = (typeof ORDER_STAGES)[number];
export type EvidenceSource = "shopify" | "app" | "make";
export type EvidenceKind = "confirmed" | "reported" | "inferred";
const SOURCES: readonly string[] = ["shopify", "app", "make"];
const KINDS: readonly string[] = ["confirmed", "reported", "inferred"];

export interface OrderEvidence {
  /** Source occurrence key (shopify webhook id, app event id, make run key); unique within its source. */
  key: string;
  site: string;
  shop: string | null;
  shopifyOrderId: string | null;
  orderNumber: string | null;
  stage: OrderStage;
  source: EvidenceSource;
  kind: EvidenceKind;
  happenedAt: string;
  receivedAt: string;
  fulfillmentId?: string | null;
  /** Shopify: this fulfillment completes the order (all required lines fulfilled). */
  fulfillmentComplete?: boolean | null;
  workType?: string | null;
  /** Explicit proof that ALL framing for the order is done (never defaulted to true). */
  framingComplete?: boolean | null;
  caseId?: string | null;
  batchId?: string | null;
}

export function normalizeShop(shop: string | null | undefined): string | null {
  if (typeof shop !== "string") return null;
  const s = shop.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : null;
}

/** null when any part is missing or invalid: never guessed. */
export function orderIdentityKey(site: string, shop: string | null, shopifyOrderId: string | null): string | null {
  const s = normalizeShop(shop);
  if (!(ORDER_SITES as readonly string[]).includes(site) || !s || !shopifyOrderId || !/^\d{1,20}$/.test(shopifyOrderId)) return null;
  return `${site}|${s}|${shopifyOrderId}`;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
/** Explicit UTC/offset ISO instants on real calendar dates only; anything else is null. */
export function strictIso(t: unknown): string | null {
  if (typeof t !== "string") return null;
  const m = ISO.exec(t);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || h > 23 || mi > 59 || se > 59) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Occurrence keys are namespaced by source: app "1" and Shopify "1" are different facts. */
export const occurrenceKey = (e: Pick<OrderEvidence, "source" | "key">) => `${e.source}|${e.key}`;

function content(e: OrderEvidence): string {
  return JSON.stringify([e.site, normalizeShop(e.shop), e.shopifyOrderId, e.orderNumber, e.stage, e.source, e.kind, strictIso(e.happenedAt),
    e.fulfillmentId ?? null, e.fulfillmentComplete ?? null, e.workType ?? null, e.framingComplete ?? null, e.caseId ?? null, e.batchId ?? null]);
}

export interface MergeResult {
  records: OrderEvidence[];
  accepted: OrderEvidence[];
  duplicates: OrderEvidence[];
  conflicts: OrderEvidence[];
  rejected: OrderEvidence[];
}

/** Append incoming occurrences without ever rewriting a recorded fact. */
export function mergeEvidence(existing: readonly OrderEvidence[], incoming: readonly OrderEvidence[]): MergeResult {
  const byKey = new Map(existing.map((e) => [occurrenceKey(e), e]));
  const out: MergeResult = { records: [...existing], accepted: [], duplicates: [], conflicts: [], rejected: [] };
  for (const e of incoming) {
    if (!e.key || !(ORDER_STAGES as readonly string[]).includes(e.stage) || !SOURCES.includes(e.source) || !KINDS.includes(e.kind)
        || !(ORDER_SITES as readonly string[]).includes(e.site) || !strictIso(e.happenedAt) || !strictIso(e.receivedAt)) {
      out.rejected.push(e);
      continue;
    }
    const k = occurrenceKey(e);
    const prev = byKey.get(k);
    if (prev) {
      (content(prev) === content(e) ? out.duplicates : out.conflicts).push(e);
      continue;
    }
    byKey.set(k, e);
    out.records.push(e);
    out.accepted.push(e);
  }
  return out;
}

/** "unconfirmed" = only reported/inferred evidence (never promoted); "partial" = some but not all. */
export type StageStatus = "confirmed" | "partial" | "unconfirmed" | "missing";
export interface StageView { status: StageStatus; at: string | null; source: EvidenceSource | null; kind: EvidenceKind | null }

export interface TimelineView {
  /** Canonical site|shop|order identity shared by every input record. */
  identity: string;
  site: OrderSite;
  stages: Record<OrderStage, StageView>;
  framedByWorkType: Array<{ workType: string; at: string; kind: EvidenceKind }>;
  fulfillments: Array<{ fulfillmentId: string; at: string; complete: boolean; kind: EvidenceKind }>;
  /** First CONFIRMED fulfillment that completed the order; null while partial, unconfirmed or unknown. */
  completeShipmentAt: string | null;
  cancelled: boolean;
  /** CS/replacement evidence: shown, never counted as completing the original order. */
  replacementEvidence: OrderEvidence[];
  orderedAt: string | null;
}

export class TimelineIdentityError extends Error {}

const cmp = (a: OrderEvidence, b: OrderEvidence) => Date.parse(a.happenedAt) - Date.parse(b.happenedAt) || (occurrenceKey(a) < occurrenceKey(b) ? -1 : occurrenceKey(a) > occurrenceKey(b) ? 1 : 0);

/** Project ONE order's evidence (any arrival order). Mixed or unmapped identities are refused. */
export function projectTimeline(evidence: readonly OrderEvidence[]): TimelineView {
  const ids = new Set(evidence.map((e) => orderIdentityKey(e.site, e.shop, e.shopifyOrderId)));
  if (evidence.length === 0 || ids.size !== 1 || ids.has(null)) throw new TimelineIdentityError("evidence must belong to exactly one mapped site/shop/order identity");
  const identity = [...ids][0] as string;
  const sorted = [...evidence].filter((e) => strictIso(e.happenedAt)).sort(cmp);
  const original = sorted.filter((e) => !e.caseId);
  const missing: StageView = { status: "missing", at: null, source: null, kind: null };
  const view = (e: OrderEvidence, status: StageStatus): StageView => ({ status, at: strictIso(e.happenedAt), source: e.source, kind: e.kind });
  const byKind = (pred: (e: OrderEvidence) => boolean): StageView => {
    const c = original.find((e) => pred(e) && e.kind === "confirmed");
    if (c) return view(c, "confirmed");
    const u = original.find(pred);
    return u ? view(u, "unconfirmed") : missing;
  };
  const stages = Object.fromEntries(ORDER_STAGES.map((s) => [s, missing])) as Record<OrderStage, StageView>;
  for (const s of ORDER_STAGES) if (s !== "shipped" && s !== "delivered" && s !== "framed") stages[s] = byKind((e) => e.stage === s);
  stages.delivered = byKind((e) => e.stage === "delivered" && e.source === "shopify");
  const framedAll = byKind((e) => e.stage === "framed" && e.framingComplete === true);
  // partial means CONFIRMED partial work; inferred/reported-only framing is "unconfirmed"
  const framedConfirmed = original.find((e) => e.stage === "framed" && e.kind === "confirmed");
  const anyFramed = original.find((e) => e.stage === "framed");
  stages.framed = framedAll.status === "confirmed" ? framedAll
    : framedConfirmed ? view(framedConfirmed, "partial")
      : framedAll.status !== "missing" ? framedAll
        : anyFramed ? view(anyFramed, "unconfirmed") : missing;
  const fulfillments = original
    .filter((e) => e.stage === "shipped" && e.source === "shopify" && e.fulfillmentId)
    .map((e) => ({ fulfillmentId: e.fulfillmentId as string, at: strictIso(e.happenedAt) as string, complete: e.fulfillmentComplete === true, kind: e.kind }));
  const complete = fulfillments.find((f) => f.complete && f.kind === "confirmed") ?? null;
  const unconfirmedComplete = fulfillments.find((f) => f.complete && f.kind !== "confirmed");
  // precedence: confirmed complete > confirmed partial > unconfirmed (an inferred "complete" never outranks
  // confirmed partial evidence; it stays listed in `fulfillments` with its kind)
  const confirmedPartial = fulfillments.find((f) => f.kind === "confirmed");
  const unconfirmed = unconfirmedComplete ?? fulfillments[0];
  stages.shipped = complete
    ? { status: "confirmed", at: complete.at, source: "shopify", kind: "confirmed" }
    : confirmedPartial
      ? { status: "partial", at: confirmedPartial.at, source: "shopify", kind: "confirmed" }
      : unconfirmed
        ? { status: "unconfirmed", at: unconfirmed.at, source: "shopify", kind: unconfirmed.kind }
        : missing;
  // per work type: the confirmed record wins over an earlier inferred/reported one; kind is kept
  const framedByWorkType: TimelineView["framedByWorkType"] = [];
  for (const e of original) {
    if (e.stage !== "framed" || !e.workType) continue;
    const i = framedByWorkType.findIndex((f) => f.workType === e.workType);
    const rec = { workType: e.workType, at: strictIso(e.happenedAt) as string, kind: e.kind };
    if (i < 0) framedByWorkType.push(rec);
    else if (framedByWorkType[i].kind !== "confirmed" && e.kind === "confirmed") framedByWorkType[i] = rec;
  }
  framedByWorkType.sort((a, b) => (a.workType < b.workType ? -1 : 1));
  return {
    identity,
    site: identity.split("|")[0] as OrderSite,
    stages,
    framedByWorkType,
    fulfillments,
    completeShipmentAt: complete?.at ?? null,
    cancelled: stages.cancelled.status === "confirmed",
    replacementEvidence: sorted.filter((e) => !!e.caseId),
    orderedAt: stages.ordered.status === "confirmed" ? stages.ordered.at : null,
  };
}

/** Nearest-rank percentile (q in (0,1]); null for no samples. Used for P90. */
export function percentile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(q * s.length) - 1)];
}
/** Median: the middle value, or the average of the middle pair. */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Display/measurement order of the stages: F10 ordered, the five F11 automation
 * steps, then framing, dispatch, shipment and delivery. Cancellation is a flag,
 * not a step.
 */
export const TIMELINE_SEQUENCE = [
  "ordered", "make_submitted", "make_files_found", "make_planned", "make_images_ready", "make_packing_ready",
  "framed", "dispatched", "shipped", "delivered",
] as const satisfies readonly OrderStage[];
export type SequenceStage = (typeof TIMELINE_SEQUENCE)[number];

/** Elapsed time between two ADJACENT sequence stages. Durations only: no classification. */
export interface StageGap {
  from: SequenceStage;
  to: SequenceStage;
  /** measured: both endpoints confirmed and to >= from; unknown: an endpoint is missing/unconfirmed/partial; anomaly: negative. */
  status: "measured" | "unknown" | "anomaly";
  hours: number | null;
}

/** The confirmed instant of a stage (complete shipment / whole-order framing only), or null. */
function confirmedAt(t: TimelineView, s: SequenceStage, nowMs: number | null): number | null {
  const v = t.stages[s];
  if (v.status !== "confirmed" || !v.at) return null;
  const ms = Date.parse(v.at);
  return nowMs !== null && ms > nowMs ? null : ms;
}

/**
 * One gap per adjacent pair, never across a missing stage: if a middle stage
 * has no confirmed time BOTH neighbouring gaps are unknown. Negative gaps are
 * anomalies with no hours. `nowUtc` (optional) ignores evidence after it.
 */
export function stageGaps(t: TimelineView, nowUtc?: string): StageGap[] {
  const n = nowUtc === undefined ? null : strictIso(nowUtc);
  if (nowUtc !== undefined && !n) throw new RangeError("now must be an explicit UTC/offset instant");
  const nowMs = n ? Date.parse(n) : null;
  const out: StageGap[] = [];
  for (let i = 1; i < TIMELINE_SEQUENCE.length; i++) {
    const from = TIMELINE_SEQUENCE[i - 1];
    const to = TIMELINE_SEQUENCE[i];
    const a = confirmedAt(t, from, nowMs);
    const b = confirmedAt(t, to, nowMs);
    if (a === null || b === null) out.push({ from, to, status: "unknown", hours: null });
    else if (b < a) out.push({ from, to, status: "anomaly", hours: null });
    else out.push({ from, to, status: "measured", hours: (b - a) / 3_600_000 });
  }
  return out;
}

export interface GapSummary { from: SequenceStage; to: SequenceStage; samples: number; unknown: number; anomalies: number; median: number | null; p90: number | null }

export interface FlowMetrics {
  /** Recorded original, non-cancelled orders confirmed as ordered in the period (and not after now). */
  cohort: number;
  completeShipmentSamples: number;
  openOrders: number;
  /** Samples with a shipment before the order time: excluded, never negative time. */
  anomalies: number;
  orderToShipHours: { median: number | null; p90: number | null };
  /** Per adjacent stage pair over the same cohort: measured samples, unknown and anomalies. */
  stageGaps: GapSummary[];
}

/** One site, each identity once. Elapsed hours only; neutral numbers, no classification. */
export function flowMetrics(timelines: readonly TimelineView[], period: { startUtc: string; endUtcExclusive: string }, nowUtc: string): FlowMetrics {
  const sa = strictIso(period.startUtc);
  const sb = strictIso(period.endUtcExclusive);
  const sn = strictIso(nowUtc);
  if (!sa || !sb || !sn || Date.parse(sa) >= Date.parse(sb)) throw new RangeError("period and now must be explicit UTC/offset instants with start < end");
  if (new Set(timelines.map((t) => t.site)).size > 1) throw new TimelineIdentityError("flow metrics cover one site");
  if (new Set(timelines.map((t) => t.identity)).size !== timelines.length) throw new TimelineIdentityError("each order identity may appear once");
  const a = Date.parse(sa);
  const b = Date.parse(sb);
  const now = Date.parse(sn);
  // only a confirmed cancellation at or before now removes an order
  const cancelledByNow = (t: TimelineView) => t.cancelled && t.stages.cancelled.at !== null && Date.parse(t.stages.cancelled.at) <= now;
  const cohort = timelines.filter((t) => t.orderedAt && !cancelledByNow(t) && Date.parse(t.orderedAt) >= a && Date.parse(t.orderedAt) < b && Date.parse(t.orderedAt) <= now);
  const hours: number[] = [];
  let anomalies = 0;
  let open = 0;
  const gapHours = TIMELINE_SEQUENCE.slice(1).map(() => [] as number[]);
  const gapUnknown = gapHours.map(() => 0);
  const gapAnomalies = gapHours.map(() => 0);
  for (const t of cohort) {
    const o = Date.parse(t.orderedAt as string);
    // a shipment recorded after `now` is not part of the current picture
    if (t.completeShipmentAt && Date.parse(t.completeShipmentAt) <= now) {
      const h = (Date.parse(t.completeShipmentAt) - o) / 3_600_000;
      if (h < 0) anomalies++;
      else hours.push(h);
    } else {
      open++;
    }
    stageGaps(t, sn).forEach((g, i) => {
      if (g.status === "measured") gapHours[i].push(g.hours as number);
      else if (g.status === "anomaly") gapAnomalies[i]++;
      else gapUnknown[i]++;
    });
  }
  return {
    cohort: cohort.length,
    completeShipmentSamples: hours.length,
    openOrders: open,
    anomalies,
    orderToShipHours: { median: median(hours), p90: percentile(hours, 0.9) },
    stageGaps: gapHours.map((hs, i) => ({
      from: TIMELINE_SEQUENCE[i], to: TIMELINE_SEQUENCE[i + 1], samples: hs.length, unknown: gapUnknown[i], anomalies: gapAnomalies[i], median: median(hs), p90: percentile(hs, 0.9),
    })),
  };
}
