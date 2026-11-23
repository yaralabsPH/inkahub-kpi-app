/**
 * F10 Order timeline: evidence model and pure projection (F11 stages included,
 * no receiver yet). Pure; no I/O.
 *
 * Identity is site + normalized Shopify shop + immutable Shopify order id; the
 * order number is an alias only. Evidence records are immutable occurrences:
 * the same key with the same content is a duplicate, with different content a
 * conflict that keeps the original. Dispatch never proves shipment; complete
 * shipment needs a fulfillment that covers the whole order; delivered needs
 * carrier (Shopify) evidence. CS/replacement work never completes the original
 * order. Missing stages stay missing.
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

export interface OrderEvidence {
  /** Source occurrence key (e.g. shopify webhook id, app event id, make run key): unique. */
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

const iso = (t: string): string | null => {
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
/** Content compared for conflicts (receivedAt is delivery metadata, not the fact). */
function content(e: OrderEvidence): string {
  return JSON.stringify([e.site, normalizeShop(e.shop), e.shopifyOrderId, e.orderNumber, e.stage, e.source, e.kind, iso(e.happenedAt),
    e.fulfillmentId ?? null, e.fulfillmentComplete ?? null, e.workType ?? null, e.caseId ?? null, e.batchId ?? null]);
}

export interface MergeResult {
  records: OrderEvidence[];
  accepted: OrderEvidence[];
  duplicates: OrderEvidence[];
  conflicts: OrderEvidence[];
  rejected: OrderEvidence[];
}

/** Append incoming occurrences to existing ones without ever rewriting a recorded fact. */
export function mergeEvidence(existing: readonly OrderEvidence[], incoming: readonly OrderEvidence[]): MergeResult {
  const byKey = new Map(existing.map((e) => [e.key, e]));
  const out: MergeResult = { records: [...existing], accepted: [], duplicates: [], conflicts: [], rejected: [] };
  for (const e of incoming) {
    if (!e.key || !(ORDER_STAGES as readonly string[]).includes(e.stage) || !iso(e.happenedAt) || !iso(e.receivedAt)) {
      out.rejected.push(e);
      continue;
    }
    const prev = byKey.get(e.key);
    if (prev) {
      (content(prev) === content(e) ? out.duplicates : out.conflicts).push(e);
      continue;
    }
    byKey.set(e.key, e);
    out.records.push(e);
    out.accepted.push(e);
  }
  return out;
}

export type StageStatus = "confirmed" | "partial" | "missing";
export interface StageView { status: StageStatus; at: string | null; source: EvidenceSource | null; kind: EvidenceKind | null }

export interface TimelineView {
  stages: Record<OrderStage, StageView>;
  framedByWorkType: Array<{ workType: string; at: string }>;
  fulfillments: Array<{ fulfillmentId: string; at: string; complete: boolean }>;
  /** First fulfillment that completed the order; null while partial or unknown. */
  completeShipmentAt: string | null;
  cancelled: boolean;
  /** CS/replacement evidence: shown, never counted as completing the original order. */
  replacementEvidence: OrderEvidence[];
  orderedAt: string | null;
}

const cmp = (a: OrderEvidence, b: OrderEvidence) => Date.parse(a.happenedAt) - Date.parse(b.happenedAt) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Project one order's evidence (any arrival order) into its stages. */
export function projectTimeline(evidence: readonly OrderEvidence[]): TimelineView {
  const sorted = [...evidence].filter((e) => iso(e.happenedAt)).sort(cmp);
  const original = sorted.filter((e) => !e.caseId);
  const missing: StageView = { status: "missing", at: null, source: null, kind: null };
  const stages = Object.fromEntries(ORDER_STAGES.map((s) => [s, missing])) as Record<OrderStage, StageView>;
  const first = (pred: (e: OrderEvidence) => boolean): StageView => {
    const e = original.find(pred);
    return e ? { status: "confirmed", at: iso(e.happenedAt), source: e.source, kind: e.kind } : missing;
  };
  for (const s of ORDER_STAGES) {
    if (s === "shipped" || s === "delivered") continue;
    stages[s] = first((e) => e.stage === s);
  }
  // delivered needs carrier evidence from Shopify
  stages.delivered = first((e) => e.stage === "delivered" && e.source === "shopify");
  const fulfillments = original
    .filter((e) => e.stage === "shipped" && e.source === "shopify" && e.fulfillmentId)
    .map((e) => ({ fulfillmentId: e.fulfillmentId as string, at: iso(e.happenedAt) as string, complete: e.fulfillmentComplete === true }));
  const complete = fulfillments.find((f) => f.complete) ?? null;
  stages.shipped = complete
    ? { status: "confirmed", at: complete.at, source: "shopify", kind: "confirmed" }
    : fulfillments.length
      ? { status: "partial", at: fulfillments[0].at, source: "shopify", kind: "confirmed" }
      : missing;
  const framedByWorkType: TimelineView["framedByWorkType"] = [];
  for (const e of original) {
    if (e.stage === "framed" && e.workType && !framedByWorkType.some((f) => f.workType === e.workType)) framedByWorkType.push({ workType: e.workType, at: iso(e.happenedAt) as string });
  }
  framedByWorkType.sort((a, b) => (a.workType < b.workType ? -1 : 1));
  return {
    stages,
    framedByWorkType,
    fulfillments,
    completeShipmentAt: complete?.at ?? null,
    cancelled: stages.cancelled.status === "confirmed",
    replacementEvidence: sorted.filter((e) => !!e.caseId),
    orderedAt: stages.ordered.at,
  };
}

/** Nearest-rank percentile (q in (0,1]); null for no samples. */
export function percentile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(q * s.length) - 1)];
}

export interface FlowMetrics {
  /** Recorded original, non-cancelled orders ordered in the period. */
  cohort: number;
  completeShipmentSamples: number;
  openOrders: number;
  /** Samples with a shipment before the order time: excluded, never negative time. */
  anomalies: number;
  orderToShipHours: { median: number | null; p90: number | null };
  late: { configured: false; reason: string } | { configured: true; thresholdHours: number; count: number };
}

/** Elapsed hours only (no invented business calendar). `lateThresholdHours` null = rule not configured. */
export function flowMetrics(timelines: readonly TimelineView[], period: { startUtc: string; endUtcExclusive: string }, nowUtc: string, lateThresholdHours: number | null): FlowMetrics {
  if (lateThresholdHours !== null && !(Number.isFinite(lateThresholdHours) && lateThresholdHours > 0)) throw new RangeError("late threshold must be a positive number of hours");
  const a = Date.parse(period.startUtc);
  const b = Date.parse(period.endUtcExclusive);
  const now = Date.parse(nowUtc);
  const cohort = timelines.filter((t) => t.orderedAt && !t.cancelled && Date.parse(t.orderedAt) >= a && Date.parse(t.orderedAt) < b);
  const hours: number[] = [];
  let anomalies = 0;
  let open = 0;
  let late = 0;
  for (const t of cohort) {
    const o = Date.parse(t.orderedAt as string);
    if (t.completeShipmentAt) {
      const h = (Date.parse(t.completeShipmentAt) - o) / 3_600_000;
      if (h < 0) anomalies++;
      else hours.push(h);
    } else {
      open++;
      if (lateThresholdHours !== null && (now - o) / 3_600_000 > lateThresholdHours) late++;
    }
  }
  return {
    cohort: cohort.length,
    completeShipmentSamples: hours.length,
    openOrders: open,
    anomalies,
    orderToShipHours: { median: percentile(hours, 0.5), p90: percentile(hours, 0.9) },
    late: lateThresholdHours === null ? { configured: false, reason: "Late-order rule not configured" } : { configured: true, thresholdHours: lateThresholdHours, count: late },
  };
}
