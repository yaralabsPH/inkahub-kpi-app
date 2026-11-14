/**
 * Effective production events → Items and distinct completed Orders
 * (F1 / item-counting spec, section B).
 *
 * Two steps, so every consumer shares one interpretation:
 *   prepareProductionEvidence(snapshot)  dedupe, validate, resolve parent
 *                                         cancellations and terminal
 *                                         qualification ONCE, before any
 *                                         person/work-type/date filter.
 *   summarizeProduction(evidence, scope) project a display scope.
 *
 * Read-only: nothing here writes, deducts stock or repairs history.
 * Browser/server safe: no env, browser state or Supabase imports.
 */

import { countProductionItems, type ItemCount } from "./productionItems.js";
import { instantMicros } from "./productionInstant.js";

export const WORK_TYPES = ["a0_framed", "framed", "unframed", "dispatch"] as const;
export type WorkType = (typeof WORK_TYPES)[number];

/** Raw saved event fields F1 reads. Quantity stays raw: it is validated, never coerced. */
export interface ProductionEvidenceEvent {
  id: string;
  location: string;
  staff_id: string | null;
  department: string | null;
  order_number: string | null;
  line_sku: string | null;
  line_quantity: unknown;
  event_type: string;
  created_at: string;
  parent_event_id: string | null;
  cs_case_id: string | null;
}

export const PRODUCTION_EVIDENCE_COLUMNS =
  "id, location, staff_id, department, order_number, line_sku, line_quantity, event_type, created_at, parent_event_id, cs_case_id";

export interface UtcWindow {
  startUtc: string;
  endUtcExclusive: string;
}

export type ProductionVisibility =
  | { kind: "site" }
  | { kind: "limited"; reason: string };

export interface ProductionSnapshot {
  events: readonly ProductionEvidenceEvent[];
  /** Enclosing display window the snapshot was loaded for. */
  range: UtcWindow;
  /** Fixed read cutoff: only events created at or before this were requested. */
  asOfUtc: string;
  /** When the read finished. */
  loadedAtUtc: string;
  visibility: ProductionVisibility;
}

/**
 * True when a snapshot was loaded for exactly this window. Pages project a
 * snapshot only onto the period it was read for, so a snapshot of the
 * previous production day is never shown as the new day after 04:00.
 */
export function snapshotCovers(snapshot: Pick<ProductionSnapshot, "range"> | null | undefined, span: UtcWindow | null | undefined): boolean {
  if (!snapshot || !span) return false;
  const same = (a: string, b: string) => exactInstant(a) !== null && exactInstant(a) === exactInstant(b);
  return same(snapshot.range.startUtc, span.startUtc) && same(snapshot.range.endUtcExclusive, span.endUtcExclusive);
}

export class ProductionEvidenceError extends Error {
  constructor(
    public readonly code: "conflicting_event",
    message: string,
  ) {
    super(message);
    this.name = "ProductionEvidenceError";
  }
}

export type CoverageIssueKind =
  | "invalid_event"
  | "unclassified_sku"
  | "invalid_quantity"
  | "unresolved_parent"
  | "missing_completion_detail"
  | "ambiguous_repeat";

export type CoverageNoteKind =
  | "expected_exclusion"
  | "corrected_verification"
  | "reversed_terminal"
  | "excluded_only_completion";

export interface CoverageIssue {
  kind: CoverageIssueKind;
  eventId: string;
  location: string;
  detail?: string;
}

export interface ProductionCoverage {
  /** Data problems: totals may be incomplete. Deduplicated by kind + event. */
  issues: CoverageIssue[];
  issueCounts: Record<CoverageIssueKind, number>;
  /** Expected, non-problem facts shown for reconciliation. */
  notes: Record<CoverageNoteKind, number>;
  visibility: ProductionVisibility;
  /** True when any issue exists or visibility is limited. */
  incomplete: boolean;
}

interface ValidEvent extends ProductionEvidenceEvent {
  /** Milliseconds: display and durations only. */
  ms: number;
  /** Exact instant (epoch microseconds): every ordering and comparison. */
  us: bigint;
  orderKey: string; // trimmed order number ("" when blank)
}

interface Verification {
  ev: ValidEvent;
  workType: WorkType;
  caseId: string | null;
  item: ItemCount;
  effective: boolean;
}

type Qualification = "eligible" | "uncertain" | "missing" | "excluded_only";

interface Terminal {
  ev: ValidEvent;
  workType: WorkType;
  caseId: string | null;
  qualification: Qualification;
  reversed: boolean;
}

interface Anchored<T> {
  ev: ValidEvent;
  workType: WorkType | null;
  value: T;
}

export interface PreparedProductionEvidence {
  readonly snapshot: ProductionSnapshot;
  readonly verifications: readonly Verification[];
  readonly terminals: readonly Terminal[];
  /** Issues tied to a valid event (filtered by scope like that event). */
  readonly anchoredIssues: readonly Anchored<CoverageIssue>[];
  /** Issues with no usable time/attribution: always reported. */
  readonly globalIssues: readonly CoverageIssue[];
  readonly anchoredNotes: readonly Anchored<CoverageNoteKind>[];
}

const PRODUCTION_LINE_WORK_TYPES = new Set<string>(["a0_framed", "framed", "unframed"]);
const RELEVANT_TYPES = new Set(["line_verified", "cancelled", "completed", "dispatched"]);

function isWorkType(v: unknown): v is WorkType {
  return typeof v === "string" && (WORK_TYPES as readonly string[]).includes(v);
}

function nonBlank(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function eventKey(location: string, id: string): string {
  return `${location}\u0000${id}`;
}

function samePayload(a: ProductionEvidenceEvent, b: ProductionEvidenceEvent): boolean {
  return (
    a.staff_id === b.staff_id &&
    a.department === b.department &&
    a.order_number === b.order_number &&
    a.line_sku === b.line_sku &&
    Object.is(a.line_quantity, b.line_quantity) &&
    a.event_type === b.event_type &&
    exactInstant(a.created_at) === exactInstant(b.created_at) &&
    a.parent_event_id === b.parent_event_id &&
    a.cs_case_id === b.cs_case_id
  );
}

function cmpUs(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byTime(a: { us: bigint; id: string }, b: { us: bigint; id: string }): number {
  return cmpUs(a.us, b.us) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Exact instant of saved text; falls back to whole milliseconds for other parseable forms. */
function exactInstant(text: unknown): bigint | null {
  const us = instantMicros(text);
  if (us !== null) return us;
  const ms = typeof text === "string" ? Date.parse(text) : Number.NaN;
  return Number.isFinite(ms) ? BigInt(ms) * 1000n : null;
}

function isTerminalPair(eventType: string, department: unknown): department is WorkType {
  if (eventType === "completed") return typeof department === "string" && PRODUCTION_LINE_WORK_TYPES.has(department);
  if (eventType === "dispatched") return department === "dispatch";
  return false;
}

/**
 * Resolve identity, cancellations and completion qualification once.
 * Throws ProductionEvidenceError when one event ID carries two payloads.
 */
export function prepareProductionEvidence(snapshot: ProductionSnapshot): PreparedProductionEvidence {
  const globalIssues: CoverageIssue[] = [];
  const anchoredIssues: Anchored<CoverageIssue>[] = [];
  const anchoredNotes: Anchored<CoverageNoteKind>[] = [];

  // 1. Deduplicate repeated retrieval of the same (location, id).
  const unique = new Map<string, ProductionEvidenceEvent>();
  for (const raw of snapshot.events) {
    if (!nonBlank(raw.id) || !nonBlank(raw.location)) {
      globalIssues.push({ kind: "invalid_event", eventId: String(raw.id ?? ""), location: String(raw.location ?? ""), detail: "missing id or site" });
      continue;
    }
    const key = eventKey(raw.location, raw.id);
    const prior = unique.get(key);
    if (prior) {
      if (!samePayload(prior, raw)) {
        throw new ProductionEvidenceError("conflicting_event", `Event ${raw.id} at ${raw.location} was read with two different payloads`);
      }
      continue;
    }
    unique.set(key, raw);
  }

  // 2. Validate time; index everything relevant by key.
  const byKey = new Map<string, ValidEvent>();
  for (const [key, raw] of unique) {
    if (!RELEVANT_TYPES.has(raw.event_type)) continue; // clock/started rows are not count evidence
    const us = exactInstant(raw.created_at);
    const ms = typeof raw.created_at === "string" ? Date.parse(raw.created_at) : Number.NaN;
    if (us === null || !Number.isFinite(ms)) {
      globalIssues.push({ kind: "invalid_event", eventId: raw.id, location: raw.location, detail: "invalid time" });
      continue;
    }
    byKey.set(key, { ...raw, ms, us, orderKey: typeof raw.order_number === "string" ? raw.order_number.trim() : "" });
  }

  const issue = (ev: ValidEvent, workType: WorkType | null, kind: CoverageIssueKind, detail?: string) =>
    anchoredIssues.push({ ev, workType, value: { kind, eventId: ev.id, location: ev.location, ...(detail ? { detail } : {}) } });
  const note = (ev: ValidEvent, workType: WorkType | null, kind: CoverageNoteKind) =>
    anchoredNotes.push({ ev, workType, value: kind });

  // 3. Classify verifications and terminals; collect cancellations.
  const verifications = new Map<string, Verification>();
  const terminals = new Map<string, Terminal>();
  const cancellations: ValidEvent[] = [];
  for (const [key, ev] of byKey) {
    const workType = isWorkType(ev.department) ? ev.department : null;
    if (ev.event_type === "cancelled") {
      cancellations.push(ev);
      continue;
    }
    if (ev.event_type === "line_verified") {
      if (!workType || !nonBlank(ev.staff_id) || !ev.orderKey) {
        issue(ev, workType, "invalid_event", "verification without work type, person or order");
        continue;
      }
      const item = countProductionItems(ev.line_sku, ev.line_quantity);
      verifications.set(key, { ev, workType, caseId: ev.cs_case_id ?? null, item, effective: true });
      continue;
    }
    // completed / dispatched
    if (!isTerminalPair(ev.event_type, ev.department) || !nonBlank(ev.staff_id) || !ev.orderKey) {
      issue(ev, workType, "invalid_event", "terminal without valid work type, person or order");
      continue;
    }
    terminals.set(key, { ev, workType: ev.department as WorkType, caseId: ev.cs_case_id ?? null, qualification: "missing", reversed: false });
  }

  // 4. Resolve parent cancellations once, before any display filter.
  const cancelledVerifications = new Set<string>();
  const reversedTerminals = new Set<string>();
  for (const c of cancellations) {
    if (!nonBlank(c.parent_event_id)) continue; // mid-progress cancel / scrap: no credit effect
    const workType = isWorkType(c.department) ? c.department : null;
    const parentKey = eventKey(c.location, c.parent_event_id);
    if (c.parent_event_id === c.id) {
      issue(c, workType, "unresolved_parent", "self-referencing cancellation");
      continue;
    }
    const v = verifications.get(parentKey);
    const t = terminals.get(parentKey);
    const parent = v?.ev ?? t?.ev;
    if (!parent) {
      issue(c, workType, "unresolved_parent", byKey.has(parentKey) ? "unsupported parent type" : "parent not found");
      continue;
    }
    if (parent.us > c.us) {
      issue(c, workType, "unresolved_parent", "parent is later than cancellation");
      continue;
    }
    if (c.department !== parent.department || (c.orderKey && c.orderKey !== parent.orderKey)) {
      issue(c, workType, "unresolved_parent", "cancellation does not match parent order/work type");
      continue;
    }
    // Current unverify writes omit the case tag; inherit the parent's. A conflicting tag is not guessed.
    if (c.cs_case_id != null && c.cs_case_id !== parent.cs_case_id) {
      issue(c, workType, "unresolved_parent", "cancellation case differs from parent");
      continue;
    }
    if (v) cancelledVerifications.add(parentKey);
    else reversedTerminals.add(parentKey);
  }
  for (const key of cancelledVerifications) {
    const v = verifications.get(key)!;
    v.effective = false;
    note(v.ev, v.workType, "corrected_verification");
  }
  for (const key of reversedTerminals) {
    const t = terminals.get(key)!;
    t.reversed = true;
    note(t.ev, t.workType, "reversed_terminal");
  }

  // 5. Item coverage for every verification (original evidence).
  for (const v of verifications.values()) {
    if (v.item.status === "excluded") note(v.ev, v.workType, "expected_exclusion");
    if (v.item.status === "unclassified") {
      if (v.item.product.kind === "unclassified") issue(v.ev, v.workType, "unclassified_sku", v.item.product.reason);
      else issue(v.ev, v.workType, "invalid_quantity", v.item.issues.join(","));
    }
  }

  // 6. Terminal qualification: chronological sweep per site/order/work type/case,
  //    using ORIGINAL verifications at or before the terminal, from every worker.
  const groups = new Map<string, Array<{ us: bigint; id: string; v?: Verification; t?: Terminal }>>();
  const groupKey = (ev: ValidEvent, workType: WorkType, caseId: string | null) =>
    `${ev.location}\u0000${ev.orderKey}\u0000${workType}\u0000${caseId ?? ""}`;
  const push = (k: string, entry: { us: bigint; id: string; v?: Verification; t?: Terminal }) => {
    const list = groups.get(k);
    if (list) list.push(entry);
    else groups.set(k, [entry]);
  };
  for (const v of verifications.values()) push(groupKey(v.ev, v.workType, v.caseId), { us: v.ev.us, id: v.ev.id, v });
  for (const t of terminals.values()) push(groupKey(t.ev, t.workType, t.caseId), { us: t.ev.us, id: t.ev.id, t });
  for (const list of groups.values()) {
    // Verifications at the same instant as a terminal count as "at or before" it.
    list.sort((a, b) => cmpUs(a.us, b.us) || (a.v ? 0 : 1) - (b.v ? 0 : 1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let eligible = 0;
    let unclassified = 0;
    let excluded = 0;
    for (const entry of list) {
      if (entry.v) {
        const kind = entry.v.item.product.kind;
        if (kind === "eligible") eligible++;
        else if (kind === "excluded") excluded++;
        else unclassified++;
        continue;
      }
      const t = entry.t!;
      t.qualification =
        eligible > 0 ? "eligible" : unclassified > 0 ? "uncertain" : excluded > 0 ? "excluded_only" : "missing";
      if (t.reversed) continue;
      if (t.qualification === "missing" || t.qualification === "uncertain") {
        issue(t.ev, t.workType, "missing_completion_detail", t.qualification === "missing" ? "no line detail" : "only unclassified lines");
      }
      if (t.qualification === "excluded_only") note(t.ev, t.workType, "excluded_only_completion");
    }
  }

  // 7. Possible legacy repeats: several effective verifications of the same line identity.
  //    Credit is kept; the ambiguity is reported.
  const repeats = new Map<string, Verification[]>();
  for (const v of verifications.values()) {
    if (!v.effective) continue;
    const sku = typeof v.ev.line_sku === "string" ? v.ev.line_sku.trim().toUpperCase() : "";
    const k = `${groupKey(v.ev, v.workType, v.caseId)}\u0000${sku}`;
    const list = repeats.get(k);
    if (list) list.push(v);
    else repeats.set(k, [v]);
  }
  for (const list of repeats.values()) {
    if (list.length < 2) continue;
    for (const v of list) issue(v.ev, v.workType, "ambiguous_repeat", `${list.length} verifications of the same line`);
  }

  return {
    snapshot,
    verifications: [...verifications.values()].sort((a, b) => byTime(a.ev, b.ev)),
    terminals: [...terminals.values()].sort((a, b) => byTime(a.ev, b.ev)),
    anchoredIssues,
    globalIssues,
    anchoredNotes,
  };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export interface ProductionScope {
  range: UtcWindow;
  /** Only these people's credit; omitted = everyone visible. */
  staffIds?: readonly string[];
  /** Only these work types; omitted = all. */
  workTypes?: readonly WorkType[];
}

export interface CountGroup {
  /** Credited pieces; null when the exact total would exceed safe-integer precision. */
  items: number | null;
  /** Distinct completed orders. */
  orders: number;
  /** Sorted distinct order keys behind `orders` (for unions and drill-downs). */
  orderKeys: string[];
}

export interface OutputGroups {
  normal: CountGroup;
  rework: CountGroup;
}

export interface OrderDetail {
  /** Overall distinct key: site + order (+ case for rework). */
  key: string;
  location: string;
  orderNumber: string;
  caseId: string | null;
  group: "normal" | "rework";
  items: number | null;
  completed: boolean;
  completedWorkTypes: WorkType[];
  verifiedBy: string[];
  completedBy: string[];
  missingDetail: boolean;
}

export interface ProductionSummary {
  scope: ProductionScope;
  asOfUtc: string;
  loadedAtUtc: string;
  normal: CountGroup;
  rework: CountGroup;
  byWorkType: Record<WorkType, OutputGroups>;
  byPerson: Record<string, OutputGroups>;
  orders: OrderDetail[];
  coverage: ProductionCoverage;
}

/** Distinct key for an order at one work type. */
export function workTypeOrderKey(location: string, workType: WorkType, orderNumber: string, caseId: string | null): string {
  return caseId == null
    ? `${location}|${workType}|${orderNumber}`
    : `${location}|${workType}|${orderNumber}|case:${caseId}`;
}

/** Distinct key for an order across work types (overall Orders). */
export function overallOrderKey(location: string, orderNumber: string, caseId: string | null): string {
  return caseId == null ? `${location}|${orderNumber}` : `${location}|${orderNumber}|case:${caseId}`;
}

class GroupAcc {
  items = 0;
  overflow = false;
  keys = new Set<string>();
  addItems(n: number) {
    const next = this.items + n;
    if (!Number.isSafeInteger(next)) this.overflow = true;
    else this.items = next;
  }
  done(): CountGroup {
    const orderKeys = [...this.keys].sort();
    return { items: this.overflow ? null : this.items, orders: orderKeys.length, orderKeys };
  }
}

class OutputAcc {
  normal = new GroupAcc();
  rework = new GroupAcc();
  pick(caseId: string | null) {
    return caseId == null ? this.normal : this.rework;
  }
  done(): OutputGroups {
    return { normal: this.normal.done(), rework: this.rework.done() };
  }
}

const ISSUE_KINDS: CoverageIssueKind[] = [
  "invalid_event",
  "unclassified_sku",
  "invalid_quantity",
  "unresolved_parent",
  "missing_completion_detail",
  "ambiguous_repeat",
];
const NOTE_KINDS: CoverageNoteKind[] = [
  "expected_exclusion",
  "corrected_verification",
  "reversed_terminal",
  "excluded_only_completion",
];

/** Project prepared evidence into one display scope. */
export function summarizeProduction(evidence: PreparedProductionEvidence, scope: ProductionScope): ProductionSummary {
  const startUs = exactInstant(scope.range.startUtc);
  const endUs = exactInstant(scope.range.endUtcExclusive);
  if (startUs === null || endUs === null) throw new RangeError("Invalid production scope range");
  const staff = scope.staffIds ? new Set(scope.staffIds) : null;
  const types = scope.workTypes ? new Set<string>(scope.workTypes) : null;
  const inTime = (ev: ValidEvent) => ev.us >= startUs && ev.us < endUs;
  const inScope = (ev: ValidEvent, workType: WorkType | null) =>
    inTime(ev) &&
    (!staff || (ev.staff_id != null && staff.has(ev.staff_id))) &&
    (!types || (workType != null && types.has(workType)));

  const total = new OutputAcc();
  const byWorkType = Object.fromEntries(WORK_TYPES.map((w) => [w, new OutputAcc()])) as Record<WorkType, OutputAcc>;
  const byPerson = new Map<string, OutputAcc>();
  const person = (id: string) => {
    let acc = byPerson.get(id);
    if (!acc) byPerson.set(id, (acc = new OutputAcc()));
    return acc;
  };

  interface OrderAcc {
    location: string;
    orderNumber: string;
    caseId: string | null;
    items: GroupAcc;
    completed: Set<WorkType>;
    verifiedBy: Set<string>;
    completedBy: Set<string>;
    missingDetail: boolean;
  }
  const orders = new Map<string, OrderAcc>();
  const orderAcc = (ev: ValidEvent, caseId: string | null) => {
    const key = overallOrderKey(ev.location, ev.orderKey, caseId);
    let acc = orders.get(key);
    if (!acc) {
      acc = {
        location: ev.location,
        orderNumber: ev.orderKey,
        caseId,
        items: new GroupAcc(),
        completed: new Set(),
        verifiedBy: new Set(),
        completedBy: new Set(),
        missingDetail: false,
      };
      orders.set(key, acc);
    }
    return { key, acc };
  };

  for (const v of evidence.verifications) {
    if (!v.effective || !inScope(v.ev, v.workType)) continue;
    const items = v.item.status === "counted" ? v.item.items : 0;
    total.pick(v.caseId).addItems(items);
    byWorkType[v.workType].pick(v.caseId).addItems(items);
    person(v.ev.staff_id!).pick(v.caseId).addItems(items);
    const { acc } = orderAcc(v.ev, v.caseId);
    acc.items.addItems(items);
    acc.verifiedBy.add(v.ev.staff_id!);
  }

  for (const t of evidence.terminals) {
    if (t.reversed || t.qualification === "excluded_only" || !inScope(t.ev, t.workType)) continue;
    const overall = overallOrderKey(t.ev.location, t.ev.orderKey, t.caseId);
    total.pick(t.caseId).keys.add(overall);
    byWorkType[t.workType].pick(t.caseId).keys.add(workTypeOrderKey(t.ev.location, t.workType, t.ev.orderKey, t.caseId));
    person(t.ev.staff_id!).pick(t.caseId).keys.add(overall);
    const { acc } = orderAcc(t.ev, t.caseId);
    acc.completed.add(t.workType);
    acc.completedBy.add(t.ev.staff_id!);
    if (t.qualification !== "eligible") acc.missingDetail = true;
  }

  // Coverage for the same scope.
  const seen = new Set<string>();
  const issues: CoverageIssue[] = [];
  const addIssue = (i: CoverageIssue) => {
    const k = `${i.kind}\u0000${i.location}\u0000${i.eventId}`;
    if (seen.has(k)) return;
    seen.add(k);
    issues.push(i);
  };
  for (const i of evidence.globalIssues) addIssue(i);
  for (const a of evidence.anchoredIssues) if (inScope(a.ev, a.workType)) addIssue(a.value);
  issues.sort((a, b) => {
    const ka = `${a.kind}\u0000${a.location}\u0000${a.eventId}\u0000${a.detail ?? ""}`;
    const kb = `${b.kind}\u0000${b.location}\u0000${b.eventId}\u0000${b.detail ?? ""}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const issueCounts = Object.fromEntries(ISSUE_KINDS.map((k) => [k, 0])) as Record<CoverageIssueKind, number>;
  for (const i of issues) issueCounts[i.kind]++;
  const notes = Object.fromEntries(NOTE_KINDS.map((k) => [k, 0])) as Record<CoverageNoteKind, number>;
  for (const n of evidence.anchoredNotes) if (inScope(n.ev, n.workType)) notes[n.value]++;
  const visibility = evidence.snapshot.visibility;
  const totals = total.done();
  const overflow = totals.normal.items === null || totals.rework.items === null;

  return {
    scope,
    asOfUtc: evidence.snapshot.asOfUtc,
    loadedAtUtc: evidence.snapshot.loadedAtUtc,
    normal: totals.normal,
    rework: totals.rework,
    byWorkType: Object.fromEntries(WORK_TYPES.map((w) => [w, byWorkType[w].done()])) as Record<WorkType, OutputGroups>,
    byPerson: Object.fromEntries([...byPerson.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, acc]) => [id, acc.done()])),
    orders: [...orders.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, o]) => ({
        key,
        location: o.location,
        orderNumber: o.orderNumber,
        caseId: o.caseId,
        group: o.caseId == null ? ("normal" as const) : ("rework" as const),
        items: o.items.done().items,
        completed: o.completed.size > 0,
        completedWorkTypes: WORK_TYPES.filter((w) => o.completed.has(w)),
        verifiedBy: [...o.verifiedBy].sort(),
        completedBy: [...o.completedBy].sort(),
        missingDetail: o.missingDetail,
      })),
    coverage: {
      issues,
      issueCounts,
      notes,
      visibility,
      incomplete: issues.length > 0 || visibility.kind === "limited" || overflow,
    },
  };
}
