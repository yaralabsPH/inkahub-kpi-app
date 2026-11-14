/**
 * Reporting-history fixtures (item-counting amendment, Task 11). Plain data
 * plus an in-memory mirror of the v2 loader's FOUR evidence families
 * (supabase/migrations/0035_load_production_evidence_v2.sql), so the current
 * reducer can be run on exactly the snapshot the database would return for
 * any window. No database, no function under test.
 */
import type { ProductionEvidenceEvent, ProductionSnapshot, ProductionVisibility, UtcWindow } from "../../src/lib/domain/productionCounts";
import { instantMicros } from "../../src/lib/domain/productionInstant";

export const SITE = "uk";
export const OTHER_SITE = "au";
export const ANNA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const BEN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const CARL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const CASE_R = "case-r1";
export const CUTOFF = "2026-02-10T00:00:00.000Z";

export const SKU = {
  unSet2: "INKA-S2BON0064-A1-UN", // 2 pieces, UN (zero timing weight)
  fnSet3: "INKA-S3WIL0049-A2-FN", // 3 pieces, framed
  fb: "INKA-KAN0566-A4-FB",
  un: "INKA-KAN0566-A4-UN",
  hook: "INKA-AUX-HOOK", // excluded
  legacy: "A4 21x30 cm / Framed Print (Black)", // unclassified
} as const;

/** UK production day d (2026-01-dd), 04:00Z start. */
export const day = (dd: number): UtcWindow => ({
  startUtc: `2026-01-${String(dd).padStart(2, "0")}T04:00:00.000Z`,
  endUtcExclusive: `2026-01-${String(dd + 1).padStart(2, "0")}T04:00:00.000Z`,
});
export const days = (first: number, last: number): UtcWindow => ({ startUtc: day(first).startUtc, endUtcExclusive: day(last).endUtcExclusive });
export const at = (dd: number, hhmm: string, micros = "000000") => `2026-01-${String(dd).padStart(2, "0")}T${hhmm}:00.${micros}Z`;

let seq = 0;
export function resetIds(): void {
  seq = 0;
}

type E = Partial<ProductionEvidenceEvent> & Pick<ProductionEvidenceEvent, "event_type" | "created_at">;
export function ev(p: E): ProductionEvidenceEvent {
  seq += 1;
  return {
    id: p.id ?? `h-${String(seq).padStart(4, "0")}`,
    location: p.location ?? SITE,
    staff_id: p.staff_id === undefined ? ANNA : p.staff_id,
    department: p.department === undefined ? "framed" : p.department,
    order_number: p.order_number === undefined ? "5001" : p.order_number,
    line_sku: p.line_sku === undefined ? null : p.line_sku,
    line_quantity: "line_quantity" in p ? p.line_quantity : null,
    event_type: p.event_type,
    created_at: p.created_at,
    parent_event_id: p.parent_event_id ?? null,
    cs_case_id: p.cs_case_id ?? null,
  };
}
export const verify = (p: Omit<E, "event_type">) => ev({ line_sku: SKU.fb, line_quantity: 1, ...p, event_type: "line_verified" });
export const complete = (p: Omit<E, "event_type">) => ev({ line_quantity: 99, ...p, event_type: "completed" });
export const dispatch = (p: Omit<E, "event_type">) => ev({ department: "dispatch", line_quantity: 99, ...p, event_type: "dispatched" });
export const cancel = (parent: ProductionEvidenceEvent, p: Omit<E, "event_type">) =>
  ev({
    location: parent.location,
    staff_id: parent.staff_id,
    department: parent.department,
    order_number: parent.order_number,
    line_sku: parent.line_sku,
    line_quantity: parent.line_quantity,
    parent_event_id: parent.id,
    ...p,
    event_type: "cancelled",
  });

const us = (t: string): bigint => {
  const v = instantMicros(t);
  if (v === null) throw new Error(`fixture time ${t} is not exact`);
  return v;
};
/** PostgreSQL btrim() with no characters argument trims spaces only. */
const btrim = (s: string) => s.replace(/^ +| +$/g, "");
const RELEVANT = new Set(["line_verified", "completed", "dispatched", "cancelled"]);

/**
 * The exact v2 selection for one site: window rows, qualification
 * verifications, cancelled parents and later cancellations, deduplicated.
 * `source` must already be what the caller's RLS can see.
 */
export function selectFourFamilies(source: readonly ProductionEvidenceEvent[], site: string, range: UtcWindow, asOfUtc: string): ProductionEvidenceEvent[] {
  const S = us(range.startUtc);
  const E = us(range.endUtcExclusive);
  const A = us(asOfUtc);
  const rows = source.filter((r) => r.location === site && us(r.created_at) <= A);
  const win = rows.filter((r) => RELEVANT.has(r.event_type) && us(r.created_at) >= S && us(r.created_at) < E);
  const terminalOrders = new Set(
    win.filter((w) => (w.event_type === "completed" || w.event_type === "dispatched") && w.order_number !== null && btrim(w.order_number) !== "").map((w) => w.order_number as string),
  );
  const qualification = rows.filter((r) => r.event_type === "line_verified" && us(r.created_at) < S && r.order_number !== null && terminalOrders.has(r.order_number));
  const parentIds = new Set(win.filter((w) => w.event_type === "cancelled" && w.parent_event_id !== null && w.parent_event_id !== "").map((w) => w.parent_event_id as string));
  const parents = rows.filter((r) => us(r.created_at) < S && parentIds.has(r.id));
  const winTargets = new Set(win.filter((w) => w.event_type === "line_verified" || w.event_type === "completed" || w.event_type === "dispatched").map((w) => w.id));
  const later = rows.filter((r) => r.event_type === "cancelled" && r.parent_event_id !== null && us(r.created_at) >= E && winTargets.has(r.parent_event_id));
  const seen = new Set<string>();
  const out: ProductionEvidenceEvent[] = [];
  for (const r of [...win, ...later, ...qualification, ...parents]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

export function fourFamilySnapshot(
  source: readonly ProductionEvidenceEvent[],
  range: UtcWindow,
  visibility: ProductionVisibility = { kind: "site" },
  site = SITE,
  asOfUtc = CUTOFF,
): ProductionSnapshot {
  return { events: selectFourFamilies(source, site, range, asOfUtc), range, asOfUtc, loadedAtUtc: asOfUtc, visibility };
}

/**
 * A two-week history with every Task 11 counterexample:
 *  - order 5001: four Items (two UN two-piece sets) then completed (one Order);
 *  - order 5002: verified/completed by Anna on day 12 AND by Ben on day 13 (one range Order, two daily);
 *  - order 5003: framed + unframed work types, both completed;
 *  - order 5004 rework case CASE_R alongside the normal order;
 *  - order 5005 at another site with the same number (never mixed in);
 *  - order 5006: verification cancelled on day 16 (after a day-15 window);
 *  - order 5007: cancellation whose parent arrives later in time (inside / after the window);
 *  - order 5008: Ben's verification qualifies Anna's completion (hidden from Anna's self view);
 *              Ben cancels Anna's line (hidden from Anna's self view);
 *  - order 5009: a repeat line verified on day 5 (outside any later window's four families) and day 14;
 *  - order 5010: whitespace-variant order number before the window;
 *  - invalid identities: null staff, blank order, unknown department, bad terminal pair;
 *  - microsecond ties: same millisecond, different microseconds; same instant, different ids;
 *  - timing: Anna's first line in a window has its predecessor on the previous day.
 */
export function history(): ProductionEvidenceEvent[] {
  resetIds();
  const out: ProductionEvidenceEvent[] = [];
  const push = <T extends ProductionEvidenceEvent>(e: T): T => (out.push(e), e);

  // 5001: four Items, one Order.
  push(verify({ order_number: "5001", department: "unframed", line_sku: SKU.unSet2, line_quantity: 2, created_at: at(12, "09:00") }));
  push(complete({ order_number: "5001", department: "unframed", created_at: at(12, "09:30") }));

  // 5002: same order, two days, two workers.
  push(verify({ order_number: "5002", created_at: at(12, "10:00") }));
  push(complete({ order_number: "5002", created_at: at(12, "10:05") }));
  push(verify({ order_number: "5002", staff_id: BEN, line_sku: SKU.fnSet3, created_at: at(13, "10:00") }));
  push(complete({ order_number: "5002", staff_id: BEN, created_at: at(13, "10:10") }));

  // 5003: two work types.
  push(verify({ order_number: "5003", department: "framed", created_at: at(13, "11:00") }));
  push(complete({ order_number: "5003", department: "framed", created_at: at(13, "11:20") }));
  push(verify({ order_number: "5003", department: "unframed", line_sku: SKU.un, created_at: at(13, "11:25") }));
  push(complete({ order_number: "5003", department: "unframed", created_at: at(13, "11:40") }));
  push(dispatch({ order_number: "5003", staff_id: CARL, created_at: at(13, "15:00") }));

  // 5004: rework case next to the normal order.
  push(verify({ order_number: "5004", created_at: at(14, "09:00") }));
  push(complete({ order_number: "5004", created_at: at(14, "09:10") }));
  push(verify({ order_number: "5004", cs_case_id: CASE_R, created_at: at(14, "09:20") }));
  push(complete({ order_number: "5004", cs_case_id: CASE_R, created_at: at(14, "09:25") }));

  // 5005: same number at another site.
  push(verify({ location: OTHER_SITE, order_number: "5004", created_at: at(14, "09:00") }));
  push(complete({ location: OTHER_SITE, order_number: "5004", created_at: at(14, "09:10") }));

  // 5006: cancelled after the selected day.
  const v6 = push(verify({ order_number: "5006", created_at: at(15, "09:00") }));
  push(complete({ order_number: "5006", created_at: at(15, "09:05") }));
  push(cancel(v6, { created_at: at(16, "08:00") }));

  // 5007: orphan parent arriving later (inside day 15, and after it).
  const late = verify({ order_number: "5007", created_at: at(15, "12:00") });
  const lateAfter = verify({ order_number: "5007", created_at: at(16, "12:00") });
  push(cancel(late, { created_at: at(15, "11:00") }));
  push(cancel(lateAfter, { created_at: at(15, "11:30") }));
  push(late);
  push(lateAfter);

  // 5008: hidden other-worker context.
  push(verify({ order_number: "5008", staff_id: BEN, created_at: at(14, "13:00") }));
  const a8 = push(verify({ order_number: "5008", created_at: at(14, "13:10") }));
  push(complete({ order_number: "5008", created_at: at(14, "13:20") }));
  push(cancel(a8, { staff_id: BEN, created_at: at(14, "14:00") }));

  // 5009: repeat line — day 5 is outside a day-14 window's four families.
  push(verify({ order_number: "5009", created_at: at(5, "09:00") }));
  push(verify({ order_number: "5009", created_at: at(14, "16:00") }));
  push(verify({ order_number: "5009", created_at: at(14, "16:05") }));

  // 5010: whitespace-variant order number before the window, completion inside.
  push(verify({ order_number: " 5010", created_at: at(11, "09:00") }));
  push(verify({ order_number: "5010", line_sku: SKU.hook, created_at: at(11, "09:30") }));
  push(complete({ order_number: "5010", created_at: at(12, "11:00") }));

  // Invalid identities.
  push(verify({ order_number: "5011", staff_id: null, created_at: at(12, "12:00") }));
  push(verify({ order_number: "  ", created_at: at(12, "12:05") }));
  push(verify({ order_number: "5011", department: "paint", created_at: at(12, "12:10") }));
  push(complete({ order_number: "5011", department: "dispatch", created_at: at(12, "12:15") }));
  push(verify({ order_number: "5011", line_sku: SKU.legacy, created_at: at(12, "12:20") }));
  push(complete({ order_number: "5011", created_at: at(12, "12:25") }));

  // Microsecond ties (same millisecond; same instant different ids).
  push(verify({ id: "tie-b", order_number: "5012", created_at: "2026-01-14T10:00:00.000400Z" }));
  push(verify({ id: "tie-a", order_number: "5012", line_sku: SKU.fnSet3, created_at: "2026-01-14T10:00:00.000400Z" }));
  push(complete({ order_number: "5012", created_at: "2026-01-14T10:00:00.000400Z" }));
  push(verify({ order_number: "5012", line_sku: SKU.un, created_at: "2026-01-14T10:00:00.000900Z" }));

  // Timing predecessor on the previous day.
  push(verify({ order_number: "5013", created_at: at(15, "03:50") }));
  push(verify({ order_number: "5013", created_at: at(15, "04:10") }));
  push(complete({ order_number: "5013", created_at: at(15, "04:12") }));

  // Not count evidence; and an event after the cutoff.
  push(ev({ event_type: "clock_in", order_number: null, created_at: at(12, "08:00") }));
  push(verify({ order_number: "5014", created_at: "2026-02-11T09:00:00.000000Z" }));
  return out;
}

/** Deterministic pseudo-random history across three sites, for randomized-window parity. */
export function randomHistory(seed: number, n = 400): ProductionEvidenceEvent[] {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 0x100000000);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const staff = [ANNA, BEN, CARL, null];
  const deps = ["a0_framed", "framed", "unframed", "dispatch", "paint", null];
  const skus = [SKU.unSet2, SKU.fnSet3, SKU.fb, SKU.un, SKU.hook, SKU.legacy, null];
  const orders = ["7001", "7002", " 7002", "7003", "7004", "", null];
  const cases = [null, null, null, CASE_R];
  const out: ProductionEvidenceEvent[] = [];
  for (let i = 0; i < n; i++) {
    const t = `2026-01-${String(10 + Math.floor(rnd() * 8)).padStart(2, "0")}T${String(Math.floor(rnd() * 24)).padStart(2, "0")}:${String(Math.floor(rnd() * 60)).padStart(2, "0")}:00.${String(Math.floor(rnd() * 3) * 250).padStart(6, "0")}Z`;
    const r = rnd();
    const type = r < 0.5 ? "line_verified" : r < 0.65 ? "completed" : r < 0.72 ? "dispatched" : r < 0.9 ? "cancelled" : "started";
    const parent = type === "cancelled" && out.length ? pick(out) : null;
    // T11-4: a few whitespace-only ids (accepted by the transport, permitted by 0012), unique per row,
    // and cancellations pointing at one: they select evidence and warn only when selected.
    const blankId = rnd() < 0.04;
    const blankParent = type === "cancelled" && rnd() < 0.05;
    out.push({
      id: blankId ? " ".repeat(1 + i) : `r${seed}-${i}`,
      location: rnd() < 0.85 ? SITE : OTHER_SITE,
      staff_id: pick(staff),
      department: type === "dispatched" && rnd() < 0.8 ? "dispatch" : parent && rnd() < 0.8 ? parent.department : pick(deps),
      order_number: parent && rnd() < 0.7 ? parent.order_number : pick(orders),
      line_sku: pick(skus),
      line_quantity: rnd() < 0.9 ? 1 + Math.floor(rnd() * 3) : rnd() < 0.5 ? "two" : -1,
      event_type: type,
      created_at: t,
      parent_event_id: blankParent ? " ".repeat(1 + Math.floor(rnd() * i + 1)) : parent ? (rnd() < 0.9 ? parent.id : "missing-id") : null,
      cs_case_id: parent && rnd() < 0.7 ? parent.cs_case_id : pick(cases),
    });
  }
  return out;
}
