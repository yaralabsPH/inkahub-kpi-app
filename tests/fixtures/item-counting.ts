/**
 * Shared F1 item-counting fixtures. Plain data only, no database.
 * Expected values in tests are written out explicitly, never computed by the
 * function under test.
 */
import type {
  ProductionEvidenceEvent,
  ProductionSnapshot,
  ProductionVisibility,
  UtcWindow,
} from "../../src/lib/domain/productionCounts";

export const WORKER_A = "11111111-1111-4111-8111-111111111111";
export const WORKER_B = "22222222-2222-4222-8222-222222222222";
export const CASE_1 = "case-0001";
export const CASE_2 = "case-0002";

/** UK winter day 2026-01-15: [04:00Z, next 04:00Z). */
export const UK_DAY_1: UtcWindow = { startUtc: "2026-01-15T04:00:00.000Z", endUtcExclusive: "2026-01-16T04:00:00.000Z" };
export const UK_DAY_2: UtcWindow = { startUtc: "2026-01-16T04:00:00.000Z", endUtcExclusive: "2026-01-17T04:00:00.000Z" };
export const UK_BOTH_DAYS: UtcWindow = { startUtc: UK_DAY_1.startUtc, endUtcExclusive: UK_DAY_2.endUtcExclusive };

export const SKU = {
  unSet2: "INKA-S2BON0064-A1-UN",
  fnSet3: "INKA-S3WIL0049-A2-FN",
  framedSingle: "INKA-KAN0566-A4-FB",
  unSingle: "INKA-KAN0566-A4-UN",
  frameOnly: "INKA-PF0004-A0-PW",
  gwSet6: "INKA-S6GAL0001-GW-FB",
  hook: "INKA-AUX-HOOK",
  freePrint: "INKA-AUXESP",
  giftCard: "INKA-GC0001-100",
  canvas: "INKA-KAN0566-A2-SC",
  legacy: "A4 21x30 cm / Framed Print (Black)",
} as const;

let seq = 0;
export function resetIds(): void {
  seq = 0;
}

type Partial2 = Partial<ProductionEvidenceEvent> & Pick<ProductionEvidenceEvent, "event_type" | "created_at">;

export function ev(p: Partial2): ProductionEvidenceEvent {
  seq += 1;
  return {
    id: p.id ?? `ev-${String(seq).padStart(4, "0")}`,
    location: p.location ?? "uk",
    staff_id: p.staff_id === undefined ? WORKER_A : p.staff_id,
    department: p.department === undefined ? "unframed" : p.department,
    order_number: p.order_number === undefined ? "1001" : p.order_number,
    line_sku: p.line_sku === undefined ? null : p.line_sku,
    line_quantity: "line_quantity" in p ? p.line_quantity : null,
    event_type: p.event_type,
    created_at: p.created_at,
    parent_event_id: p.parent_event_id ?? null,
    cs_case_id: p.cs_case_id ?? null,
  };
}

export const verify = (p: Omit<Partial2, "event_type">) => ev({ ...p, event_type: "line_verified" });
export const complete = (p: Omit<Partial2, "event_type">) => ev({ line_quantity: 99, ...p, event_type: "completed" });
export const dispatch = (p: Omit<Partial2, "event_type">) => ev({ department: "dispatch", line_quantity: 99, ...p, event_type: "dispatched" });
export const cancel = (parent: ProductionEvidenceEvent, p: Omit<Partial2, "event_type" | "created_at"> & { created_at: string }) =>
  ev({
    location: parent.location,
    department: parent.department,
    order_number: parent.order_number,
    line_sku: parent.line_sku,
    line_quantity: parent.line_quantity,
    parent_event_id: parent.id,
    ...p,
    event_type: "cancelled",
  });

export function snapshot(
  events: ProductionEvidenceEvent[],
  range: UtcWindow = UK_BOTH_DAYS,
  visibility: ProductionVisibility = { kind: "site" },
): ProductionSnapshot {
  return {
    events,
    range,
    asOfUtc: "2026-01-17T04:00:00.000Z",
    loadedAtUtc: "2026-01-17T04:00:01.000Z",
    visibility,
  };
}

/** Deterministic shuffle for order-independence tests. */
export function shuffled<T>(items: readonly T[], seed = 7): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
