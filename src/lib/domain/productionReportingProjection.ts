/**
 * Reporting facts: projection and the pure reference query (item-counting
 * amendment, Task 11).
 *
 *   projectReportingPartition(input)  classify every saved count-evidence
 *       event of one authorized partition ONCE with the shared rules
 *       (productionCounts / productionItems / productionFrameTiming) and
 *       record identity-level facts: classifications, item results, parent
 *       edges, timing stream predecessors. No range answer is stored.
 *
 *   referenceSummary(result, {selection, scope, visibility})  answer one
 *       range from facts only. It selects the SAME four evidence families as
 *       load_production_evidence_v2 for `selection`, applies context presence
 *       to parent edges, and groups exact identities. It never calls
 *       prepareProductionEvidence/summarizeProduction: tests compare it with
 *       them. Range-dependent answers (repeat warnings, qualification context,
 *       unresolved-parent details, the first timing predecessor) are decided
 *       here, per selection, never persisted as one all-history flag.
 *
 * Browser/server safe: no env, Node built-ins or Supabase imports.
 */
import { countProductionItems } from "./productionItems.js";
import {
  cancellationPairOutcome,
  classifyEvidenceEvent,
  evidenceIdentityIssue,
  evidenceOrderKey,
  exactInstant,
  isCountEvidenceType,
  isWorkType,
  nonBlank,
  overallOrderKey,
  ProductionEvidenceError,
  qualificationFrom,
  repeatLineKey,
  samePayload,
  UNRESOLVED_PARENT_DETAIL,
  WORK_TYPES,
  workTypeOrderKey,
  type CountGroup,
  type CoverageIssue,
  type CoverageIssueKind,
  type CoverageNoteKind,
  type OrderDetail,
  type OutputGroups,
  type ProductionEvidenceEvent,
  type ProductionScope,
  type ProductionSummary,
  type ProductionVisibility,
  type Qualification,
  type UnresolvedParentReason,
  type UtcWindow,
  type WorkType,
} from "./productionCounts";
import { FRAME_GAP_CAP_MIN, frameTimingWeight, isTimingStreamSku, type FrameTimingLine } from "./productionFrameTiming";
import {
  canonicalJson,
  partitionHash,
  REPORTING_RULE_VERSION,
  type CancelEdgeFact,
  type EventFact,
  type FrozenPartitionInput,
  type ItemFact,
  type PartitionResult,
  type SourceIssueFact,
} from "./productionReporting";

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const us = (f: Pick<EventFact, "us">): bigint => BigInt(f.us);
const cmpFact = (a: EventFact, b: EventFact) => {
  const x = us(a);
  const y = us(b);
  return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

function itemFact(sku: unknown, quantity: unknown): ItemFact {
  const c = countProductionItems(sku as string | null, quantity);
  const issue =
    c.status === "unclassified"
      ? c.product.kind === "unclassified"
        ? { kind: "unclassified_sku" as const, detail: c.product.reason }
        : { kind: "invalid_quantity" as const, detail: c.issues.join(",") }
      : null;
  return { status: c.status, items: c.status === "counted" ? c.items : 0, productKind: c.product.kind, issue };
}

/** Classify one authorized partition once. Throws on another site's rows, a conflicting duplicate or an inexact cutoff. */
export function projectReportingPartition(input: FrozenPartitionInput): PartitionResult {
  if (input.ruleVersion !== REPORTING_RULE_VERSION) throw new RangeError(`Unsupported reporting rule version ${input.ruleVersion}`);
  const cutoffUs = exactInstant(input.sourceCutoffUtc);
  if (cutoffUs === null) throw new RangeError("sourceCutoffUtc is not an exact instant");
  const audience = input.audience;
  if (audience.kind === "self" && !nonBlank(audience.staffId)) throw new RangeError("self audience needs a staff id");

  const sourceIssues: SourceIssueFact[] = [];
  const futureEventIds: string[] = [];
  // Self audience: only that worker's saved rows, BEFORE any correction/qualification preparation
  // (and before any source-issue selection: another worker's malformed row is never visible to it).
  const rows = audience.kind === "self" ? input.events.filter((e) => e.staff_id === audience.staffId) : input.events;

  const unique = new Map<string, ProductionEvidenceEvent>();
  for (const raw of rows) {
    // As the evidence transport: an empty id or an unreadable time fails the whole read.
    if (typeof raw.id !== "string" || raw.id === "") throw new RangeError(`A source row at ${String(raw.location)} has no id`);
    if (raw.location !== input.site) throw new RangeError(`Event ${raw.id} belongs to ${raw.location}, not partition site ${input.site}`);
    const t = exactInstant(raw.created_at);
    if (t === null || !Number.isFinite(typeof raw.created_at === "string" ? Date.parse(raw.created_at) : Number.NaN)) {
      throw new RangeError(`Event ${raw.id} at ${raw.location} has an unreadable time`);
    }
    const identity = evidenceIdentityIssue(raw);
    if (t > cutoffUs) {
      if (identity || isCountEvidenceType(raw.event_type)) futureEventIds.push(raw.id);
      continue; // not due yet: neither a fact nor a warning
    }
    if (identity) {
      // Kept with its RAW selectors: it still selects evidence, then warns only when selected.
      sourceIssues.push({
        site: raw.location, id: raw.id, eventType: raw.event_type, us: t.toString(), createdAt: raw.created_at,
        staffId: raw.staff_id, rawOrder: raw.order_number, parentId: raw.parent_event_id, issue: identity,
      });
      continue;
    }
    const prior = unique.get(raw.id);
    if (prior) {
      if (!samePayload(prior, raw)) throw new ProductionEvidenceError("conflicting_event", `Event ${raw.id} at ${raw.location} was read with two different payloads`);
      continue;
    }
    unique.set(raw.id, raw);
  }

  const facts: EventFact[] = [];
  for (const raw of unique.values()) {
    if (!isCountEvidenceType(raw.event_type)) continue;
    const t = exactInstant(raw.created_at) as bigint;
    const ms = Date.parse(raw.created_at);
    const cls = classifyEvidenceEvent(raw);
    const isVerification = cls.role === "verification";
    facts.push({
      site: raw.location,
      id: raw.id,
      eventType: raw.event_type,
      us: t.toString(),
      ms,
      createdAt: raw.created_at,
      staffId: raw.staff_id,
      department: raw.department,
      rawOrder: raw.order_number,
      orderKey: evidenceOrderKey(raw.order_number),
      caseId: raw.cs_case_id ?? null,
      parentId: raw.parent_event_id,
      sku: raw.line_sku,
      quantity: raw.line_quantity === undefined ? null : raw.line_quantity,
      role: cls.role,
      workType: cls.workType,
      invalidDetail: cls.role === "invalid" ? cls.detail : null,
      lineKey: isVerification ? repeatLineKey(raw.line_sku) : null,
      item: isVerification ? itemFact(raw.line_sku, raw.line_quantity) : null,
      timing: isVerification ? { stream: isTimingStreamSku(raw.line_sku), weight: frameTimingWeight(raw.line_sku, raw.line_quantity), prevAll: null, prevSameType: null } : null,
      cancelledBy: [],
      fullQualification: null,
    });
  }
  facts.sort(cmpFact);
  const byId = new Map(facts.map((f) => [f.id, f]));

  // Parent edges by identity; full-history effectiveness at the cutoff.
  const edges: CancelEdgeFact[] = [];
  for (const c of facts) {
    if (c.role !== "cancellation" || !nonBlank(c.parentId)) continue;
    const parent = byId.get(c.parentId);
    const vt = parent && (parent.role === "verification" || parent.role === "terminal");
    const edge: CancelEdgeFact = {
      site: c.site,
      cancelId: c.id,
      parentId: c.parentId,
      self: c.parentId === c.id,
      parentRole: parent ? parent.role : null,
      parentUs: parent ? parent.us : null,
      pair: parent && vt ? cancellationPairOutcome(cancelSide(c), cancelSide(parent)) : null,
    };
    edges.push(edge);
    if (!edge.self && parent && vt && us(parent) <= us(c) && edge.pair === "valid") parent.cancelledBy.push(c.id);
  }
  for (const f of facts) f.cancelledBy.sort();
  edges.sort((a, b) => (a.cancelId < b.cancelId ? -1 : a.cancelId > b.cancelId ? 1 : 0));

  // Full-history qualification (informational; range answers are decided by the query).
  for (const t of facts) {
    if (t.role !== "terminal") continue;
    const k = { eligible: 0, unclassified: 0, excluded: 0 };
    for (const v of facts) {
      if (v.role !== "verification" || !sameGroup(v, t) || us(v) > us(t)) continue;
      const kind = v.item!.productKind;
      if (kind === "eligible") k.eligible++;
      else if (kind === "excluded") k.excluded++;
      else k.unclassified++;
    }
    t.fullQualification = qualificationFrom(k.eligible, k.unclassified, k.excluded);
  }

  // Timing stream predecessors per worker (all work types) and per worker + work type, effective lines only.
  const lastAll = new Map<string, { id: string; ms: number }>();
  const lastType = new Map<string, { id: string; ms: number }>();
  for (const v of facts) {
    if (v.role !== "verification" || v.cancelledBy.length || !v.timing!.stream) continue;
    const worker = v.staffId as string;
    const typeKey = canonicalJson([worker, v.workType]);
    v.timing!.prevAll = lastAll.get(worker) ?? null;
    v.timing!.prevSameType = lastType.get(typeKey) ?? null;
    lastAll.set(worker, { id: v.id, ms: v.ms });
    lastType.set(typeKey, { id: v.id, ms: v.ms });
  }

  futureEventIds.sort();
  sourceIssues.sort((a, b) => {
    const x = BigInt(a.us);
    const y = BigInt(b.us);
    return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : canonicalJson(a) < canonicalJson(b) ? -1 : 1;
  });
  const body: Omit<PartitionResult, "hash"> = { site: input.site, audience, ruleVersion: input.ruleVersion, sourceCutoffUtc: input.sourceCutoffUtc, facts, edges, sourceIssues, futureEventIds };
  return { ...body, hash: partitionHash(body) };
}

function cancelSide(f: EventFact): Pick<ProductionEvidenceEvent, "department" | "order_number" | "cs_case_id"> {
  return { department: f.department, order_number: f.rawOrder, cs_case_id: f.caseId };
}

function sameGroup(a: EventFact, b: EventFact): boolean {
  return a.site === b.site && a.orderKey === b.orderKey && a.workType === b.workType && a.caseId === b.caseId;
}

// ---------------------------------------------------------------------------
// Four-family selection over facts (mirror of load_production_evidence_v2)
// ---------------------------------------------------------------------------

/** PostgreSQL btrim() without a character list trims spaces only. */
const btrim = (s: string) => s.replace(/^ +| +$/g, "");

function instant(text: string, what: string): bigint {
  const t = exactInstant(text);
  if (t === null) throw new RangeError(`${what} is not an exact instant`);
  return t;
}

/**
 * Window rows, qualification verifications, cancelled parents and later
 * cancellations — over the UNION of ordinary facts and source-issue rows, as
 * v2 selects by raw selectors before the reducer rejects an identity. A
 * malformed window terminal can select prior context, a malformed cancellation
 * can seed its parent, and a malformed row of any type can be selected as a
 * parent. Source issues are returned separately: they warn, nothing more.
 */
export function selectFactFamilies(result: PartitionResult, selection: UtcWindow): { facts: EventFact[]; sourceIssues: SourceIssueFact[] } {
  const S = instant(selection.startUtc, "selection start");
  const E = instant(selection.endUtcExclusive, "selection end");
  if (S >= E) throw new RangeError("selection is empty");
  type Row = { id: string; eventType: string; t: bigint; rawOrder: string | null; parentId: string | null };
  const rowOf = (x: EventFact | SourceIssueFact): Row => ({ id: x.id, eventType: x.eventType, t: BigInt(x.us), rawOrder: x.rawOrder, parentId: x.parentId });
  const all: Row[] = [...result.facts.map(rowOf), ...result.sourceIssues.map(rowOf)];
  const RELEVANT = new Set(["line_verified", "completed", "dispatched", "cancelled"]);
  const win = all.filter((r) => RELEVANT.has(r.eventType) && r.t >= S && r.t < E);
  const terminalOrders = new Set(win.filter((w) => (w.eventType === "completed" || w.eventType === "dispatched") && w.rawOrder !== null && btrim(w.rawOrder) !== "").map((w) => w.rawOrder as string));
  const parentIds = new Set(win.filter((w) => w.eventType === "cancelled" && w.parentId !== null && w.parentId !== "").map((w) => w.parentId as string));
  const winTargets = new Set(win.filter((w) => w.eventType === "line_verified" || w.eventType === "completed" || w.eventType === "dispatched").map((w) => w.id));
  const picked = (r: Row) =>
    (RELEVANT.has(r.eventType) && r.t >= S && r.t < E) ||
    (r.t < S && ((r.eventType === "line_verified" && r.rawOrder !== null && terminalOrders.has(r.rawOrder)) || parentIds.has(r.id))) ||
    (r.t >= E && r.eventType === "cancelled" && r.parentId !== null && winTargets.has(r.parentId));
  return {
    facts: result.facts.filter((f) => picked(rowOf(f))).sort(cmpFact),
    sourceIssues: result.sourceIssues.filter((x) => picked(rowOf(x))),
  };
}

// ---------------------------------------------------------------------------
// Evidence for one selection
// ---------------------------------------------------------------------------

interface Anchored<T> {
  f: EventFact;
  workType: WorkType | null;
  value: T;
}

interface SelectionEvidence {
  verifications: EventFact[];
  terminals: EventFact[];
  effective: Set<string>;
  reversed: Set<string>;
  qualification: Map<string, Qualification>;
  anchoredIssues: Anchored<CoverageIssue>[];
  anchoredNotes: Anchored<CoverageNoteKind>[];
  /** Selected source-identity warnings: reported for the whole selection, whatever the display filter. */
  selectedSourceIssues: CoverageIssue[];
}

function evaluateSelection(result: PartitionResult, selection: UtcWindow): SelectionEvidence {
  const picked = selectFactFamilies(result, selection);
  const selected = picked.facts;
  // Source issues never provide parent presence (the reducer skips them before indexing).
  const present = new Map(selected.map((f) => [f.id, f]));
  const edges = new Map(result.edges.map((e) => [e.cancelId, e]));
  const anchoredIssues: Anchored<CoverageIssue>[] = [];
  const anchoredNotes: Anchored<CoverageNoteKind>[] = [];
  const issue = (f: EventFact, workType: WorkType | null, kind: CoverageIssueKind, detail?: string) =>
    anchoredIssues.push({ f, workType, value: { kind, eventId: f.id, location: f.site, ...(detail ? { detail } : {}) } });
  const note = (f: EventFact, workType: WorkType | null, kind: CoverageNoteKind) => anchoredNotes.push({ f, workType, value: kind });

  const verifications = selected.filter((f) => f.role === "verification");
  const terminals = selected.filter((f) => f.role === "terminal");
  for (const f of selected) if (f.role === "invalid") issue(f, f.workType, "invalid_event", f.invalidDetail ?? undefined);

  // Parent edges with context presence decided by THIS selection.
  const cancelledV = new Set<string>();
  const reversedT = new Set<string>();
  for (const c of selected) {
    if (c.role !== "cancellation" || !nonBlank(c.parentId)) continue;
    const edge = edges.get(c.id);
    if (!edge) throw new Error(`missing edge for cancellation ${c.id}`);
    const parent = present.get(edge.parentId);
    let reason: UnresolvedParentReason | "valid";
    if (edge.self) reason = "self";
    else if (!parent) reason = "missing";
    else if (parent.role !== "verification" && parent.role !== "terminal") reason = "unsupported";
    else if (us(parent) > us(c)) reason = "later";
    else reason = edge.pair ?? "unsupported";
    if (reason !== "valid") {
      issue(c, isWorkType(c.department) ? c.department : null, "unresolved_parent", UNRESOLVED_PARENT_DETAIL[reason]);
      continue;
    }
    (parent!.role === "verification" ? cancelledV : reversedT).add(parent!.id);
  }
  for (const v of verifications) if (cancelledV.has(v.id)) note(v, v.workType, "corrected_verification");
  for (const t of terminals) if (reversedT.has(t.id)) note(t, t.workType, "reversed_terminal");

  for (const v of verifications) {
    if (v.item!.status === "excluded") note(v, v.workType, "expected_exclusion");
    if (v.item!.issue) issue(v, v.workType, v.item!.issue.kind, v.item!.issue.detail);
  }

  // Qualification from ORIGINAL selected verifications at or before each terminal.
  const qualification = new Map<string, Qualification>();
  for (const t of terminals) {
    const k = { eligible: 0, unclassified: 0, excluded: 0 };
    for (const v of verifications) {
      if (!sameGroup(v, t) || us(v) > us(t)) continue;
      const kind = v.item!.productKind;
      if (kind === "eligible") k.eligible++;
      else if (kind === "excluded") k.excluded++;
      else k.unclassified++;
    }
    const q = qualificationFrom(k.eligible, k.unclassified, k.excluded);
    qualification.set(t.id, q);
    if (reversedT.has(t.id)) continue;
    if (q === "missing" || q === "uncertain") issue(t, t.workType, "missing_completion_detail", q === "missing" ? "no line detail" : "only unclassified lines");
    if (q === "excluded_only") note(t, t.workType, "excluded_only_completion");
  }

  // Possible legacy repeats among the SELECTED effective verifications.
  const effective = new Set(verifications.filter((v) => !cancelledV.has(v.id)).map((v) => v.id));
  const repeats = new Map<string, EventFact[]>();
  for (const v of verifications) {
    if (!effective.has(v.id)) continue;
    const k = canonicalJson([v.site, v.orderKey, v.workType, v.caseId, v.lineKey]);
    const list = repeats.get(k);
    if (list) list.push(v);
    else repeats.set(k, [v]);
  }
  for (const list of repeats.values()) {
    if (list.length < 2) continue;
    for (const v of list) issue(v, v.workType, "ambiguous_repeat", `${list.length} verifications of the same line`);
  }

  return { verifications, terminals, effective, reversed: reversedT, qualification, anchoredIssues, anchoredNotes, selectedSourceIssues: picked.sourceIssues.map((x) => x.issue) };
}

// ---------------------------------------------------------------------------
// Reference summary (exact identity grouping)
// ---------------------------------------------------------------------------

export type ComparableSummary = Omit<ProductionSummary, "scope" | "asOfUtc" | "loadedAtUtc">;

export interface ReferenceQuery {
  /** The loaded window (the v2 call's start/end); answers depend on it. */
  selection: UtcWindow;
  /** The display scope inside it. */
  scope: ProductionScope;
  visibility: ProductionVisibility;
}

class Group {
  items = 0;
  overflow = false;
  keys = new Set<string>();
  add(n: number) {
    const next = this.items + n;
    if (!Number.isSafeInteger(next)) this.overflow = true;
    else this.items = next;
  }
  done(): CountGroup {
    const orderKeys = [...this.keys].sort();
    return { items: this.overflow ? null : this.items, orders: orderKeys.length, orderKeys };
  }
}
class Output {
  normal = new Group();
  rework = new Group();
  pick(caseId: string | null) {
    return caseId == null ? this.normal : this.rework;
  }
  done(): OutputGroups {
    return { normal: this.normal.done(), rework: this.rework.done() };
  }
}

const ISSUE_KINDS: CoverageIssueKind[] = ["invalid_event", "unclassified_sku", "invalid_quantity", "unresolved_parent", "missing_completion_detail", "ambiguous_repeat"];
const NOTE_KINDS: CoverageNoteKind[] = ["expected_exclusion", "corrected_verification", "reversed_terminal", "excluded_only_completion"];

export function referenceSummary(result: PartitionResult, q: ReferenceQuery): ComparableSummary {
  const ev = evaluateSelection(result, q.selection);
  const startUs = instant(q.scope.range.startUtc, "scope start");
  const endUs = instant(q.scope.range.endUtcExclusive, "scope end");
  const staff = q.scope.staffIds ? new Set(q.scope.staffIds) : null;
  const types = q.scope.workTypes ? new Set<string>(q.scope.workTypes) : null;
  const inScope = (f: EventFact, workType: WorkType | null) =>
    us(f) >= startUs && us(f) < endUs && (!staff || (f.staffId != null && staff.has(f.staffId))) && (!types || (workType != null && types.has(workType)));

  const total = new Output();
  const byWorkType = Object.fromEntries(WORK_TYPES.map((w) => [w, new Output()])) as Record<WorkType, Output>;
  const byPerson = new Map<string, Output>();
  const person = (id: string) => byPerson.get(id) ?? byPerson.set(id, new Output()).get(id)!;
  interface OrderAcc {
    location: string;
    orderNumber: string;
    caseId: string | null;
    items: Group;
    completed: Set<WorkType>;
    verifiedBy: Set<string>;
    completedBy: Set<string>;
    missingDetail: boolean;
  }
  const orders = new Map<string, OrderAcc>();
  const order = (f: EventFact) => {
    const key = overallOrderKey(f.site, f.orderKey, f.caseId);
    let acc = orders.get(key);
    if (!acc) orders.set(key, (acc = { location: f.site, orderNumber: f.orderKey, caseId: f.caseId, items: new Group(), completed: new Set(), verifiedBy: new Set(), completedBy: new Set(), missingDetail: false }));
    return acc;
  };

  for (const v of ev.verifications) {
    if (!ev.effective.has(v.id) || !inScope(v, v.workType)) continue;
    const items = v.item!.status === "counted" ? v.item!.items : 0;
    const wt = v.workType as WorkType;
    total.pick(v.caseId).add(items);
    byWorkType[wt].pick(v.caseId).add(items);
    person(v.staffId as string).pick(v.caseId).add(items);
    const acc = order(v);
    acc.items.add(items);
    acc.verifiedBy.add(v.staffId as string);
  }
  for (const t of ev.terminals) {
    const qual = ev.qualification.get(t.id)!;
    if (ev.reversed.has(t.id) || qual === "excluded_only" || !inScope(t, t.workType)) continue;
    const wt = t.workType as WorkType;
    const overall = overallOrderKey(t.site, t.orderKey, t.caseId);
    total.pick(t.caseId).keys.add(overall);
    byWorkType[wt].pick(t.caseId).keys.add(workTypeOrderKey(t.site, wt, t.orderKey, t.caseId));
    person(t.staffId as string).pick(t.caseId).keys.add(overall);
    const acc = order(t);
    acc.completed.add(wt);
    acc.completedBy.add(t.staffId as string);
    if (qual !== "eligible") acc.missingDetail = true;
  }

  const seen = new Set<string>();
  const issues: CoverageIssue[] = [];
  const addIssue = (i: CoverageIssue) => {
    const k = canonicalJson([i.kind, i.location, i.eventId]);
    if (seen.has(k)) return;
    seen.add(k);
    issues.push(i);
  };
  for (const i of ev.selectedSourceIssues) addIssue(i);
  for (const a of ev.anchoredIssues) if (inScope(a.f, a.workType)) addIssue(a.value);
  issues.sort((a, b) => {
    const ka = `${a.kind}\u0000${a.location}\u0000${a.eventId}\u0000${a.detail ?? ""}`;
    const kb = `${b.kind}\u0000${b.location}\u0000${b.eventId}\u0000${b.detail ?? ""}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const issueCounts = Object.fromEntries(ISSUE_KINDS.map((k) => [k, 0])) as Record<CoverageIssueKind, number>;
  for (const i of issues) issueCounts[i.kind]++;
  const notes = Object.fromEntries(NOTE_KINDS.map((k) => [k, 0])) as Record<CoverageNoteKind, number>;
  for (const n of ev.anchoredNotes) if (inScope(n.f, n.workType)) notes[n.value]++;
  const totals = total.done();
  const overflow = totals.normal.items === null || totals.rework.items === null;

  return {
    normal: totals.normal,
    rework: totals.rework,
    byWorkType: Object.fromEntries(WORK_TYPES.map((w) => [w, byWorkType[w].done()])) as Record<WorkType, OutputGroups>,
    byPerson: Object.fromEntries([...byPerson.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, acc]) => [id, acc.done()])),
    orders: [...orders.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, o]): OrderDetail => ({
        key,
        location: o.location,
        orderNumber: o.orderNumber,
        caseId: o.caseId,
        group: o.caseId == null ? "normal" : "rework",
        items: o.items.done().items,
        completed: o.completed.size > 0,
        completedWorkTypes: WORK_TYPES.filter((w) => o.completed.has(w)),
        verifiedBy: [...o.verifiedBy].sort(),
        completedBy: [...o.completedBy].sort(),
        missingDetail: o.missingDetail,
      })),
    coverage: { issues, issueCounts, notes, visibility: q.visibility, incomplete: issues.length > 0 || q.visibility.kind === "limited" || overflow },
  };
}

// ---------------------------------------------------------------------------
// Reference frame timing (stored predecessors + range boundary rule)
// ---------------------------------------------------------------------------

/**
 * Timing lines for one range and a SUPPORTED work-type selection (one work
 * type, or all). Other combinations are rejected, never approximated.
 *
 * The predecessor is the previous line of the same worker in THIS selection's
 * effective timing stream (selected evidence, range by millisecond, work type,
 * stream SKU), as the existing timing does. A stored full-history predecessor
 * is not enough: one saved microseconds before the selection start shares its
 * millisecond but is not selected evidence (review T11-1), and a selected
 * context line may be effective here but not in full history. The first
 * included observation therefore has zero gap when its predecessor is outside.
 */
export function referenceTimingLines(result: PartitionResult, q: { selection: UtcWindow; scope: ProductionScope }): FrameTimingLine[] {
  const types = q.scope.workTypes;
  const allTypes = !types || WORK_TYPES.every((w) => types.includes(w));
  if (!allTypes && types!.length !== 1) throw new RangeError("Unsupported work-type combination for timing");
  const ev = evaluateSelection(result, q.selection);
  const startMs = Date.parse(q.scope.range.startUtc);
  const endMs = Date.parse(q.scope.range.endUtcExclusive);
  const staff = q.scope.staffIds ? new Set(q.scope.staffIds) : null;
  const out: FrameTimingLine[] = [];
  const prevByWorker = new Map<string, number>();
  for (const v of ev.verifications) {
    if (!ev.effective.has(v.id)) continue;
    if (v.ms < startMs || v.ms >= endMs) continue;
    if (!allTypes && v.workType !== types![0]) continue;
    const t = v.timing!;
    if (!t.stream) continue;
    const worker = v.staffId as string;
    const prevMs = prevByWorker.get(worker);
    const gapMin = prevMs === undefined ? 0 : (v.ms - prevMs) / 60_000;
    const timed = prevMs !== undefined && gapMin > 0 && gapMin <= FRAME_GAP_CAP_MIN && t.weight > 0;
    prevByWorker.set(worker, v.ms);
    if (staff && !staff.has(worker)) continue;
    out.push({
      eventId: v.id,
      staffId: v.staffId as string,
      workType: v.workType as WorkType,
      orderNumber: v.orderKey,
      sku: v.sku,
      weight: t.weight,
      startedAtMs: prevMs ?? v.ms,
      completedAtMs: v.ms,
      durationMin: timed ? gapMin : 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parity comparison
// ---------------------------------------------------------------------------

export interface ParityDifference {
  path: string;
  expected: string;
  actual: string;
}

function diff(path: string, a: unknown, b: unknown, out: ParityDifference[], cap: number): void {
  if (out.length >= cap) return;
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = Array.isArray(a) ? Array.from({ length: Math.max(a.length, (b as unknown[]).length) }, (_, i) => String(i)) : [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])].sort();
    if (Array.isArray(a) && a.length !== (b as unknown[]).length) out.push({ path: `${path}.length`, expected: String(a.length), actual: String((b as unknown[]).length) });
    for (const k of keys) diff(path ? `${path}.${k}` : k, (a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], out, cap);
    return;
  }
  const x = a === undefined ? "undefined" : canonicalJson(a);
  const y = b === undefined ? "undefined" : canonicalJson(b);
  if (x !== y) out.push({ path, expected: x, actual: y });
}

/** Every field-level difference between the reducer's summary and a reference/published one (empty = exact parity). */
export function compareReportingProjection(expected: ProductionSummary, actual: ComparableSummary, cap = 50): ParityDifference[] {
  const out: ParityDifference[] = [];
  const want: ComparableSummary = { normal: expected.normal, rework: expected.rework, byWorkType: expected.byWorkType, byPerson: expected.byPerson, orders: expected.orders, coverage: expected.coverage };
  for (const k of ["normal", "rework", "byWorkType", "byPerson", "orders", "coverage"] as const) diff(k, want[k], actual[k], out, cap);
  return out;
}
