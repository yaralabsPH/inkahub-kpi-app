/**
 * Task 14 (item-counting amendment): materialize affected audiences, order
 * identities and timing from a FROZEN batch view.
 *
 *   affectedOwners(reader)        the complete dependency closure of a refresh
 *                                 batch's changed keys (old/new owners, parents,
 *                                 inverse children, invalid-identity events, due
 *                                 future keys, adjacent timing successors)
 *   buildOwnerInput(reader, o)    one owner's complete authorized input: members,
 *                                 their parents and inverse children, and the
 *                                 bounded stream predecessor walk (with each
 *                                 candidate's own cancellations)
 *   materializePartition(in, a)   the shared Task 11 projector, with a self
 *                                 audience's rows filtered BEFORE projection
 *   materializeOwners/Batch       work descriptors (input hash) + the owner's five
 *                                 staged arrays for every required audience,
 *                                 including empty replacements of old owners
 *
 * All classification is the shared TypeScript code; nothing here counts,
 * classifies or selects ranges. Reads go through a FrozenReader: the 0040
 * bounded RPCs in production (rpcFrozenReader), an in-memory view in tests.
 * An owner input over MAX_PARTITION_EVENTS fails visibly (partition_too_large);
 * nothing is truncated or silently dropped.
 */
import { exactInstant, classifyEvidenceEvent, evidenceIdentityIssue, evidenceOrderKey, type ProductionEvidenceEvent } from "../../src/lib/domain/productionCounts.js";
import { isTimingStreamSku } from "../../src/lib/domain/productionFrameTiming.js";
import { productionDateAt, type ReportSite } from "../../src/lib/domain/productionPeriods.js";
import { canonicalJson, REPORTING_RULE_VERSION, sha256Hex, type FrozenPartitionInput, type PartitionResult, type ReportingAudience } from "../../src/lib/domain/productionReporting.js";
import { projectReportingPartition } from "../../src/lib/domain/productionReportingProjection.js";
import { compareUtf8, type ResultRows, type WorkDescriptor } from "./reporting-stage.js";

type Ev = ProductionEvidenceEvent;

// ---------------------------------------------------------------------------
// Owners and the production owner mapping (the five staged arrays)
// ---------------------------------------------------------------------------

export type Owner = { partitionKind: "order" | "event"; partitionKey: string };
/** The owner partition: the trimmed nonblank order, else the event id (as SQL reporting_private.owner_partition). */
export const ownerOf = (orderKey: string, id: string): Owner => (orderKey ? { partitionKind: "order", partitionKey: orderKey } : { partitionKind: "event", partitionKey: id });
export const ownerOfEvent = (e: Pick<Ev, "order_number" | "id">): Owner => ownerOf(evidenceOrderKey(e.order_number), e.id);
export const ownerKey = (o: Owner) => `${o.partitionKind}\u0000${o.partitionKey}`;
export const emptyRows = (): ResultRows => ({ event_facts: [], cancel_edges: [], order_occurrences: [], timing_facts: [], source_issue_facts: [] });

/** Exact ISO-8601 (UTC, microseconds) for epoch microseconds. */
export function isoOfMicros(us: string | bigint): string {
  const n = BigInt(us);
  const ms = n / 1000n;
  return new Date(Number(ms)).toISOString().replace("Z", `${String(((n % 1000n) + 1000n) % 1000n).padStart(3, "0")}Z`);
}

/** The five staged arrays of one partition result, grouped by owner (only rows of facts the result owns). */
export function rowsByOwner(r: PartitionResult): Map<string, { owner: Owner; rows: ResultRows }> {
  const out = new Map<string, { owner: Owner; rows: ResultRows }>();
  const at = (o: Owner) => {
    const k = ownerKey(o);
    if (!out.has(k)) out.set(k, { owner: o, rows: emptyRows() });
    return out.get(k)!.rows;
  };
  const factOwner = new Map<string, Owner>();
  for (const f of r.facts) {
    const o = ownerOf(f.orderKey, f.id);
    factOwner.set(f.id, o);
    const v = f.role === "verification";
    at(o).event_facts.push({
      event_id: f.id, event_type: f.eventType, created_at: f.createdAt, staff_id: f.staffId, department: f.department, raw_order: f.rawOrder,
      order_key: f.orderKey, case_id: f.caseId, parent_event_id: f.parentId, sku: f.sku,
      quantity: typeof f.quantity === "number" && Number.isInteger(f.quantity) ? f.quantity : null,
      role: f.role, work_type: f.workType, invalid_detail: f.invalidDetail, line_key: f.lineKey,
      item_status: f.item?.status ?? null, items: f.item?.items ?? null, product_kind: f.item?.productKind ?? null,
      item_issue_kind: f.item?.issue?.kind ?? null, item_issue_detail: f.item?.issue?.detail ?? null,
      timing_stream: v ? (f.timing?.stream ?? false) : null, timing_weight: v ? (f.timing?.weight ?? 0) : null,
      production_date: v ? productionDateAt(new Date(f.ms), r.site as ReportSite) : null,
    });
  }
  for (const f of r.facts) {
    const o = factOwner.get(f.id)!;
    // Order identity of a terminal with a work type, person and order (exact terminal identity; qualification is read-time).
    if (f.role === "terminal" && f.workType && f.staffId && f.orderKey && f.rawOrder !== null) {
      at(o).order_occurrences.push({ terminal_event_id: f.id, order_key: f.orderKey, raw_order: f.rawOrder, case_id: f.caseId, work_type: f.workType, staff_id: f.staffId, occurred_at: f.createdAt });
    }
    // Timing observation of an effective stream line, with its full-history predecessors (index hints).
    if (f.role === "verification" && !f.cancelledBy.length && f.timing?.stream && f.staffId && f.workType) {
      at(o).timing_facts.push({
        event_id: f.id, staff_id: f.staffId, work_type: f.workType, occurred_at: f.createdAt, weight: f.timing.weight,
        prev_all_event_id: f.timing.prevAll?.id ?? null, prev_same_type_event_id: f.timing.prevSameType?.id ?? null,
      });
    }
  }
  for (const e of r.edges) {
    at(factOwner.get(e.cancelId)!).cancel_edges.push({
      cancel_event_id: e.cancelId, parent_event_id: e.parentId, is_self: e.self, parent_role: e.parentRole,
      parent_created_at: e.parentUs === null ? null : isoOfMicros(e.parentUs),
      pair: e.parentRole === "verification" || e.parentRole === "terminal" ? e.pair : null,
    });
  }
  for (const x of r.sourceIssues) {
    at(ownerOf(evidenceOrderKey(x.rawOrder), x.id)).source_issue_facts.push({
      event_id: x.id, event_type: x.eventType, created_at: x.createdAt, staff_id: x.staffId, raw_order: x.rawOrder, parent_event_id: x.parentId,
      issue_kind: x.issue.kind, issue_detail: x.issue.detail ?? null,
    });
  }
  return out;
}

/** The owner's rows of a result (an EMPTY replacement when it owns nothing in this audience). */
export function ownerRows(r: PartitionResult, owner: Owner): ResultRows {
  return rowsByOwner(r).get(ownerKey(owner))?.rows ?? emptyRows();
}

/** The shared projector for one audience: a self audience's rows are filtered BEFORE any preparation. */
export function materializePartition(input: FrozenPartitionInput, audience: ReportingAudience): PartitionResult {
  const events = audience.kind === "self" ? input.events.filter((e) => e.staff_id === audience.staffId) : input.events;
  return projectReportingPartition({ ...input, audience, events });
}

// ---------------------------------------------------------------------------
// The frozen view
// ---------------------------------------------------------------------------

/** A partition dependency input above this size is a visible blocker, never truncated (plan: 50,000 source events). */
export const MAX_PARTITION_EVENTS = 50_000;
/** Stream walk page size (bounded reads; ≤1,000 rows per request). */
export const STREAM_PAGE = 200;

export class PartitionTooLargeError extends Error {
  readonly code = "partition_too_large";
  constructor(readonly owner: Owner, readonly size: number) {
    super(`partition_too_large: ${owner.partitionKind} ${JSON.stringify(owner.partitionKey)} needs more than ${MAX_PARTITION_EVENTS} source events (${size} read); a reviewed bounded algorithm amendment is required`);
  }
}

export interface ChangedKey {
  id: string;
  /** Image at the base generation (source_current), or null when absent there. */
  before: Ev | null;
  /** Frozen image (batch event), or null for a tombstone (deleted or moved away). */
  after: Ev | null;
}

/** A position in a worker's stream: exact time + event id; ordering is (exact instant, bytewise id), as SQL "C". */
export interface StreamPosition { createdAt: string; id: string }

/**
 * The bounded reads over ONE frozen batch view (refresh: base mirror overlaid
 * with frozen images; rebuild: the frozen candidate). Every call is bounded.
 */
export interface FrozenReader {
  readonly site: string;
  readonly cutoff: string;
  readonly kind: "refresh" | "rebuild";
  /** Refresh only: every changed/due key with its base and frozen images. */
  changedKeys(): AsyncIterable<ChangedKey>;
  /** Rebuild only: every owner partition of the view. */
  owners(): AsyncIterable<Owner>;
  /** Members of each owner; at most `cap` per owner are returned (cap+1 proves an overflow). */
  members(owners: readonly Owner[], cap: number): Promise<Map<string, Ev[]>>;
  byIds(ids: readonly string[]): Promise<Map<string, Ev>>;
  /** Frozen events whose parent_event_id is one of `parentIds`, streamed lazily (a consumer that stops reads no more pages). */
  children(parentIds: readonly string[]): AsyncIterable<Ev>;
  /** One bounded page of ONE parent's frozen children strictly after `afterId` (bytewise id); only an empty page ends them. */
  childPage(parentId: string, afterId: string | null, limit: number): Promise<Ev[]>;
  /** One page of a worker's events strictly before/after `from` (ordered away from it). */
  stream(staff: string, direction: "before" | "after", from: StreamPosition, limit: number): Promise<Ev[]>;
  requests(): number;
}

const micros = (e: Pick<Ev, "created_at" | "id">): bigint => {
  const t = exactInstant(e.created_at);
  if (t === null) throw new RangeError(`Event ${e.id} has an unreadable time`);
  return t;
};
/** Stream order: exact instant, then bytewise id (SQL COLLATE "C"). */
export function compareStream(a: Pick<Ev, "created_at" | "id">, b: Pick<Ev, "created_at" | "id">): number {
  const x = micros(a);
  const y = micros(b);
  return x < y ? -1 : x > y ? 1 : compareUtf8(a.id, b.id);
}

/** The changed/due keys between two frozen views (tests and the in-memory reader). */
export function diffFrozenViews(before: readonly Ev[], after: readonly Ev[], prevCutoff: string, cutoff: string): ChangedKey[] {
  const b = new Map(before.map((e) => [e.id, e]));
  const a = new Map(after.map((e) => [e.id, e]));
  const prev = exactInstant(prevCutoff)!;
  const cut = exactInstant(cutoff)!;
  const out: ChangedKey[] = [];
  for (const id of new Set([...b.keys(), ...a.keys()])) {
    const x = b.get(id) ?? null;
    const y = a.get(id) ?? null;
    const changed = canonicalJson(x) !== canonicalJson(y);
    const due = y !== null && micros(y) > prev && micros(y) <= cut; // became due since the last verified cutoff
    if (changed || due) out.push({ id, before: x, after: y });
  }
  return out.sort((p, q) => compareUtf8(p.id, q.id));
}

/** An in-memory frozen view with the same bounded contract as the 0040/0041 RPCs (`maxPage` shortens stream pages, as a byte cap can). Indexed, so 50,000-row tests stay fast. */
export function memoryFrozenReader(o: { site: string; cutoff: string; kind: "refresh" | "rebuild"; view: readonly Ev[]; changed: readonly ChangedKey[]; maxPage?: number }): FrozenReader {
  let n = 0;
  const view = [...o.view];
  const byId = new Map(view.map((e) => [e.id, e]));
  const byOwner = new Map<string, Ev[]>();
  const byParent = new Map<string, Ev[]>();
  const byStaff = new Map<string, Array<{ e: Ev; us: bigint }>>();
  for (const e of view) {
    const k = ownerKey(ownerOfEvent(e));
    (byOwner.get(k) ?? byOwner.set(k, []).get(k)!).push(e);
    if (e.parent_event_id !== null) (byParent.get(e.parent_event_id) ?? byParent.set(e.parent_event_id, []).get(e.parent_event_id)!).push(e);
    if (e.staff_id) (byStaff.get(e.staff_id) ?? byStaff.set(e.staff_id, []).get(e.staff_id)!).push({ e, us: micros(e) });
  }
  const cmp = (a: { us: bigint; id: string }, b: { us: bigint; id: string }) => (a.us < b.us ? -1 : a.us > b.us ? 1 : compareUtf8(a.id, b.id));
  for (const list of byStaff.values()) list.sort((x, y) => cmp({ us: x.us, id: x.e.id }, { us: y.us, id: y.e.id }));
  for (const list of byParent.values()) list.sort((x, y) => compareUtf8(x.id, y.id));
  for (const list of byOwner.values()) list.sort((x, y) => compareUtf8(x.id, y.id));
  return {
    site: o.site, cutoff: o.cutoff, kind: o.kind,
    async *changedKeys() {
      if (o.kind !== "refresh") throw new Error("changedKeys is a refresh read");
      n++;
      yield* o.changed;
    },
    async *owners() {
      if (o.kind !== "rebuild") throw new Error("owners is a rebuild read");
      n++;
      const seen = new Map<string, Owner>();
      for (const e of view) seen.set(ownerKey(ownerOfEvent(e)), ownerOfEvent(e));
      yield* [...seen.values()].sort((x, y) => compareUtf8(ownerKey(x), ownerKey(y)));
    },
    async members(owners, cap) {
      n++;
      return new Map(owners.map((x) => [ownerKey(x), (byOwner.get(ownerKey(x)) ?? []).slice(0, cap + 1)]));
    },
    async byIds(ids) {
      n++;
      return new Map(ids.filter((id) => byId.has(id)).map((id) => [id, byId.get(id)!]));
    },
    async *children(parentIds) {
      n++;
      for (const p of [...new Set(parentIds)].sort(compareUtf8)) yield* byParent.get(p) ?? [];
    },
    async childPage(parentId, afterId, limit) {
      n++;
      const size = Math.min(limit, o.maxPage ?? limit);
      return (byParent.get(parentId) ?? []).filter((e) => afterId === null || compareUtf8(e.id, afterId) > 0).slice(0, size);
    },
    async stream(staff, direction, from, limit) {
      n++;
      const list = byStaff.get(staff) ?? [];
      const at = { us: micros({ created_at: from.createdAt, id: from.id }), id: from.id };
      // first index strictly after `at`
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cmp({ us: list[mid].us, id: list[mid].e.id }, at) <= 0) lo = mid + 1;
        else hi = mid;
      }
      const size = Math.min(limit, o.maxPage ?? limit);
      if (direction === "after") return list.slice(lo, lo + size).map((x) => x.e);
      // strictly before: indexes < first index >= at
      let j = lo;
      while (j > 0 && cmp({ us: list[j - 1].us, id: list[j - 1].e.id }, at) >= 0) j--;
      return list.slice(Math.max(0, j - size), j).reverse().map((x) => x.e);
    },
    requests: () => n,
  };
}

// ---------------------------------------------------------------------------
// Stream helpers (shared rules only)
// ---------------------------------------------------------------------------

interface StreamLine { ev: Ev; us: bigint; workType: string | null }

/** The shared projector's logical order: exact instant, then the id in UTF-16 code-unit order (JS `<`). */
export function projectorOrder(a: { us: bigint; id: string }, b: { us: bigint; id: string }): number {
  return a.us < b.us ? -1 : a.us > b.us ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
const lineOrder = (l: StreamLine) => ({ us: l.us, id: l.ev.id });

/** A due, well-identified stream verification of a worker (the projector's timing-stream candidates). */
function streamLine(e: Ev, cutoffUs: bigint): StreamLine | null {
  if (!e.staff_id || evidenceIdentityIssue(e)) return null;
  const us = exactInstant(e.created_at);
  if (us === null || us > cutoffUs) return null;
  const cls = classifyEvidenceEvent(e);
  if (cls.role !== "verification" || !isTimingStreamSku(e.line_sku)) return null;
  return { ev: e, us, workType: cls.workType };
}

/** Site-effectiveness of ONE stream line, decided by the shared projector over the line and its own cancellations. */
function siteEffective(reader: FrozenReader, l: StreamLine, kids: readonly Ev[]): boolean {
  const r = projectReportingPartition({ site: reader.site, audience: { kind: "site" }, ruleVersion: REPORTING_RULE_VERSION, sourceCutoffUtc: reader.cutoff, events: [l.ev, ...kids.filter((k) => k.id !== l.ev.id)] });
  const f = r.facts.find((x) => x.id === l.ev.id);
  return !!f && f.cancelledBy.length === 0;
}

/**
 * T14R3: the dependency budget of ONE owner input or ONE successor seed: a
 * count of DISTINCT consumed source/dependency event ids. The first id beyond
 * MAX_PARTITION_EVENTS throws partition_too_large at once (nothing more is read
 * for that owner/seed; nothing is truncated).
 */
export class DependencyBudget {
  private readonly ids = new Set<string>();
  constructor(readonly owner: Owner) {}
  take(e: Pick<Ev, "id">): boolean {
    if (this.ids.has(e.id)) return false;
    this.ids.add(e.id);
    if (this.ids.size > MAX_PARTITION_EVENTS) throw new PartitionTooLargeError(this.owner, this.ids.size);
    return true;
  }
  get size(): number {
    return this.ids.size;
  }
}

/** Whether ONE page of a line's cancellations cancels it (the shared projector over [line, ...page]; each edge depends only on the cancellation and its parent). */
function pageCancels(reader: FrozenReader, l: StreamLine, page: readonly Ev[]): boolean {
  const r = projectReportingPartition({ site: reader.site, audience: { kind: "site" }, ruleVersion: REPORTING_RULE_VERSION, sourceCutoffUtc: reader.cutoff, events: [l.ev, ...page.filter((k) => k.id !== l.ev.id)] });
  const f = r.facts.find((x) => x.id === l.ev.id);
  return !!f && f.cancelledBy.length > 0;
}

/** Read the cancellations of ONE consumed line incrementally, charging each to the budget as it arrives. */
async function consumeChildren(reader: FrozenReader, id: string, budget: DependencyBudget, onKid: (k: Ev) => void): Promise<Ev[]> {
  const kids: Ev[] = [];
  for await (const k of reader.children([id])) {
    budget.take(k);
    onKid(k);
    kids.push(k);
  }
  return kids;
}

/**
 * The exact stream walk. A worker's events are CONSUMED one at a time in
 * bytewise transport order from `from` (exclusive). Each consumed event is
 * charged to the budget; each consumed stream candidate reads its OWN
 * cancellations incrementally (unconsumed candidates on a fetched page are
 * lookahead only: never charged, never read, never in the input) and is judged
 * site-effective. `onLine` says whether the walk is now satisfied; once
 * satisfied the walk finishes that line's instant (ties are kept whole) and
 * stops. Only an empty page ends the stream.
 */
async function exactWalk(
  reader: FrozenReader,
  staff: string,
  from: StreamPosition,
  direction: "before" | "after",
  cutoffUs: bigint,
  budget: DependencyBudget,
  onEvent: (e: Ev) => void,
  onLine: (l: StreamLine, effective: boolean) => boolean,
): Promise<void> {
  let stopAt: bigint | null = null;
  let cursor = from;
  for (;;) {
    const page = await reader.stream(staff, direction, cursor, STREAM_PAGE);
    if (!page.length) return;
    for (const e of page) {
      const us = micros(e);
      if (stopAt !== null && (direction === "before" ? us < stopAt : us > stopAt)) return;
      budget.take(e);
      onEvent(e);
      const l = streamLine(e, cutoffUs);
      if (!l) continue;
      const kids = await consumeChildren(reader, e.id, budget, onEvent);
      if (onLine(l, siteEffective(reader, l, kids)) && stopAt === null) stopAt = l.us;
    }
    const last = page[page.length - 1];
    cursor = { createdAt: last.created_at, id: last.id };
  }
}

/**
 * T14R1: timing successors of an ANCHOR (a changed/affected stream line, by
 * its full identity). Every consumed stream line is affected (ties at the
 * anchor's instant included), but only a site-effective line STRICTLY AFTER
 * the anchor in the projector's order can satisfy the stop — the anchor itself
 * and earlier ties never do. Stops after an effective line of all types and of
 * each type in `types`. Budgeted per seed.
 */
async function walkSuccessors(reader: FrozenReader, anchor: StreamLine, types: ReadonlySet<string>, cutoffUs: bigint, budget: DependencyBudget): Promise<StreamLine[]> {
  const need = new Set<string>(["*", ...types]);
  const lines: StreamLine[] = [];
  await exactWalk(reader, anchor.ev.staff_id!, { createdAt: isoOfMicros(anchor.us), id: "" }, "after", cutoffUs, budget, () => undefined, (l, effective) => {
    lines.push(l);
    if (effective && projectorOrder(lineOrder(l), lineOrder(anchor)) > 0) {
      need.delete("*");
      if (l.workType !== null) need.delete(l.workType);
    }
    return need.size === 0;
  });
  return lines;
}

// ---------------------------------------------------------------------------
// One owner's complete input
// ---------------------------------------------------------------------------

export interface OwnerInput {
  owner: Owner;
  members: Ev[];
  /** Members plus every dependency/context row, sorted by exact identity (bytewise id). */
  events: Ev[];
}

export async function buildOwnerInput(reader: FrozenReader, owner: Owner, membersIn?: Ev[]): Promise<OwnerInput> {
  const members = membersIn ?? (await reader.members([owner], MAX_PARTITION_EVENTS)).get(ownerKey(owner)) ?? [];
  const budget = new DependencyBudget(owner);
  const context = new Map<string, Ev>();
  const keep = (e: Ev) => {
    budget.take(e);
    context.set(e.id, e);
  };
  for (const e of members) keep(e); // a members read of cap+1 proves the overflow here
  const cutoffUs = exactInstant(reader.cutoff);
  if (cutoffUs === null) throw new RangeError("the frozen cutoff is not an exact instant");
  // Parents of members (a cancellation's edge needs its parent's role/time/sides).
  const parentIds = [...new Set(members.map((e) => e.parent_event_id).filter((p): p is string => !!p && !context.has(p)))].sort(compareUtf8);
  for (let i = 0; i < parentIds.length; i += 500) for (const e of (await reader.byIds(parentIds.slice(i, i + 500))).values()) keep(e);
  // Inverse children of members, incrementally and budgeted (they decide a member's effectiveness). Every
  // member's children are required, so ONE lazy multi-parent read serves them in the same order the per-member
  // loop charged them (members bytewise, each member's children bytewise); an overflow still stops reading at once.
  for await (const k of reader.children(members.map((m) => m.id))) keep(k);
  // Stream predecessors: per worker, from the worker's LATEST member line down past an effective predecessor
  // (all types and each member type) below its EARLIEST member line — boundaries in the PROJECTOR's order (T14R2).
  const byWorker = new Map<string, StreamLine[]>();
  for (const e of members) {
    const l = streamLine(e, cutoffUs);
    if (!l) continue;
    (byWorker.get(e.staff_id!) ?? byWorker.set(e.staff_id!, []).get(e.staff_id!)!).push(l);
  }
  for (const [staff, lines] of [...byWorker.entries()].sort((x, y) => compareUtf8(x[0], y[0]))) {
    lines.sort((x, y) => projectorOrder(lineOrder(x), lineOrder(y)));
    const earliest = lines[0];
    const latestUs = lines[lines.length - 1].us;
    const types = new Set(lines.map((l) => l.workType).filter((t): t is string => t !== null));
    const need = new Set<string>(["*", ...types]);
    // Start just after the latest member's microsecond so every tie at that instant is read too.
    await exactWalk(reader, staff, { createdAt: isoOfMicros(latestUs + 1n), id: "" }, "before", cutoffUs, budget, (e) => void context.set(e.id, e), (l, effective) => {
      if (effective && projectorOrder(lineOrder(l), lineOrder(earliest)) < 0) {
        need.delete("*");
        if (l.workType !== null) need.delete(l.workType);
      }
      return need.size === 0;
    });
  }
  const events = [...context.values()].sort((x, y) => compareUtf8(x.id, y.id));
  return { owner, members: [...members].sort((x, y) => compareUtf8(x.id, y.id)), events };
}

// ---------------------------------------------------------------------------
// The refresh dependency closure
// ---------------------------------------------------------------------------

export interface Affected {
  owners: Owner[];
  /** Staff ids of BASE images of changed keys, by their base owner: old self audiences that may need an empty replacement. */
  oldStaff: Map<string, Set<string>>;
}

export async function affectedOwners(reader: FrozenReader): Promise<Affected> {
  if (reader.kind !== "refresh") throw new Error("affectedOwners is a refresh closure; a rebuild materializes every owner");
  const cutoffUs = exactInstant(reader.cutoff);
  if (cutoffUs === null) throw new RangeError("the frozen cutoff is not an exact instant");
  const owners = new Map<string, Owner>();
  const oldStaff = new Map<string, Set<string>>();
  const add = (o: Owner) => owners.set(ownerKey(o), o);
  const changedIds: string[] = [];
  const parentIds = new Set<string>();
  const anchors: StreamLine[] = [];
  for await (const k of reader.changedKeys()) {
    changedIds.push(k.id);
    for (const img of [k.before, k.after]) {
      if (!img) continue;
      add(ownerOfEvent(img)); // old and new owners (also invalid-identity and due future keys)
      if (img.parent_event_id) parentIds.add(img.parent_event_id);
      const l = streamLine(img, cutoffUs);
      if (l) anchors.push(l); // the old position (old worker/time) and the new one
    }
    if (k.before?.staff_id) {
      const key = ownerKey(ownerOfEvent(k.before));
      (oldStaff.get(key) ?? oldStaff.set(key, new Set<string>()).get(key)!).add(k.before.staff_id);
    }
  }
  // Parents (their effectiveness/edges change) and their timing successors.
  const parents = [...parentIds].sort(compareUtf8);
  for (let i = 0; i < parents.length; i += 500) {
    for (const p of (await reader.byIds(parents.slice(i, i + 500))).values()) {
      add(ownerOfEvent(p));
      const l = streamLine(p, cutoffUs);
      if (l) anchors.push(l);
    }
  }
  // Inverse children of every changed key (their edge reads this parent): owners only, nothing retained.
  for (const id of changedIds) for await (const c of reader.children([id])) add(ownerOfEvent(c));
  // Timing successors, each seed with its own dependency budget (attributed to the seed's owner).
  for (const a of anchors) {
    const types = new Set<string>(a.workType ? [a.workType] : []);
    const lines = await walkSuccessors(reader, a, types, cutoffUs, new DependencyBudget(ownerOfEvent(a.ev)));
    for (const l of lines) add(ownerOfEvent(l.ev));
  }
  return { owners: [...owners.values()].sort((x, y) => compareUtf8(ownerKey(x), ownerKey(y))), oldStaff };
}

/**
 * Task 15: the dependency closure of ONE changed key (the bounded, resumable
 * unit of a refresh enumeration). The union over every changed key equals
 * `affectedOwners` exactly (tested): its old and new owners, the owners of its
 * parents and their timing successors, its inverse children's owners and the
 * timing successors of its old/new stream positions. Each successor seed keeps
 * its own dependency budget. `oldStaff` lists [owner key, staff] base self
 * audiences that may need an empty replacement.
 */
export async function changedKeyDependencies(reader: FrozenReader, k: ChangedKey): Promise<{ owners: Owner[]; oldStaff: Array<[string, string]> }> {
  if (reader.kind !== "refresh") throw new Error("changedKeyDependencies is a refresh closure");
  const cutoffUs = exactInstant(reader.cutoff);
  if (cutoffUs === null) throw new RangeError("the frozen cutoff is not an exact instant");
  const owners = new Map<string, Owner>();
  const add = (o: Owner) => owners.set(ownerKey(o), o);
  const parentIds = new Set<string>();
  const anchors: StreamLine[] = [];
  const oldStaff: Array<[string, string]> = [];
  for (const img of [k.before, k.after]) {
    if (!img) continue;
    add(ownerOfEvent(img));
    if (img.parent_event_id) parentIds.add(img.parent_event_id);
    const l = streamLine(img, cutoffUs);
    if (l) anchors.push(l);
  }
  if (k.before?.staff_id) oldStaff.push([ownerKey(ownerOfEvent(k.before)), k.before.staff_id]);
  const parents = [...parentIds].sort(compareUtf8);
  for (const p of (await reader.byIds(parents)).values()) {
    add(ownerOfEvent(p));
    const l = streamLine(p, cutoffUs);
    if (l) anchors.push(l);
  }
  for await (const c of reader.children([k.id])) add(ownerOfEvent(c));
  for (const a of anchors) {
    const lines = await walkSuccessors(reader, a, new Set<string>(a.workType ? [a.workType] : []), cutoffUs, new DependencyBudget(ownerOfEvent(a.ev)));
    for (const l of lines) add(ownerOfEvent(l.ev));
  }
  return { owners: [...owners.values()].sort((x, y) => compareUtf8(ownerKey(x), ownerKey(y))), oldStaff };
}

// ---------------------------------------------------------------------------
// Task 15 review repair: the RESUMABLE dependency closure of one changed key
// ---------------------------------------------------------------------------

/** A successor seed of a changed key (its old/new stream position or a parent's), compactly. */
export interface KeyAnchor { staff: string; at: string; id: string; wt: string | null; owner: [Owner["partitionKind"], string] }
/**
 * A successor walk in progress: the last CONSUMED stream event, the stop
 * instant, the unmet types, and a stream line whose own cancellations are
 * being paged. `cancelled` is monotonic: the shared projector judges each
 * cancellation only against its parent, so "some earlier page cancelled the
 * line" carries forward exactly and earlier pages are never needed again.
 */
export interface KeyWalk { at: StreamPosition | null; stop: string | null; need: string[]; line: { id: string; kidsAfter: string | null; cancelled: boolean } | null; done: boolean }
/** Saved progress inside one changed key (the outer cursor advances only when the key is complete). */
export interface KeyProgress { id: string; phase: "children" | "seeds"; kidsAfter: string | null; anchors: KeyAnchor[]; seed: number; walk: KeyWalk | null }
export interface WalkDiscovery { owner: Owner; oldStaff: string[] }
/** What one checkpoint persists besides the cursor: owners found since the last one, the seed's newly consumed ids, and (once per paged line) that line's image. */
export interface KeyCheckpoint { found: WalkDiscovery[]; seed: number | null; seen: string[]; lineImage: Ev | null }
export interface KeyWalkIo {
  /**
   * Persist one checkpoint atomically (null = the key is complete) and return
   * the seed's exact DISTINCT consumed-id count from durable storage (null
   * when `seed` is null). Also the place to beat the lease and stop at the
   * deadline (after saving).
   */
  checkpoint(next: KeyProgress | null, step: KeyCheckpoint): Promise<number | null>;
  /** The saved image of the interrupted paged line (worker state; never a source reread), or null. */
  lineImage(seed: number, line: string): Promise<Ev | null>;
}
export interface KeyWalkPages { keyChildren: number; lineKids: number; stream: number }
/** Page sizes: ≤500 inverse children per page keeps a checkpoint within 1,000 owners; ≤1,000 cancellations per line page; the stream page as elsewhere. */
export const KEY_WALK_PAGES: KeyWalkPages = { keyChildren: 500, lineKids: 1000, stream: STREAM_PAGE };
const KEY_PROGRESS_MAX_BYTES = 7000;

const isOwnerKind = (v: unknown): v is Owner["partitionKind"] => v === "order" || v === "event";
const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";
const isPos = (v: unknown): v is StreamPosition => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === "createdAt,id" && isStr((v as StreamPosition).createdAt) && exactInstant((v as StreamPosition).createdAt) !== null && typeof (v as StreamPosition).id === "string";
const keysAre = (v: object, want: string) => Object.keys(v).sort().join(",") === want;

/** Strict validation of saved key progress (a malformed cursor is a permanent error, never a guess). */
export function parseKeyProgress(v: unknown): KeyProgress {
  const bad = (what: string): never => {
    throw new RangeError(`key progress: ${what}`);
  };
  if (!v || typeof v !== "object" || Array.isArray(v) || !keysAre(v, "anchors,id,kidsAfter,phase,seed,walk")) bad("unexpected shape");
  const o = v as Record<string, unknown>;
  if (!isStr(o.id)) bad("id");
  if (o.phase !== "children" && o.phase !== "seeds") bad("phase");
  if (o.kidsAfter !== null && !isStr(o.kidsAfter)) bad("kidsAfter");
  if (!Array.isArray(o.anchors) || o.anchors.length > 4) bad("anchors");
  for (const a of o.anchors as unknown[]) {
    if (!a || typeof a !== "object" || Array.isArray(a) || !keysAre(a, "at,id,owner,staff,wt")) bad("anchor shape");
    const x = a as Record<string, unknown>;
    if (!isStr(x.staff) || !isStr(x.id) || !isStr(x.at) || exactInstant(x.at as string) === null || (x.wt !== null && !isStr(x.wt))) bad("anchor fields");
    if (!Array.isArray(x.owner) || x.owner.length !== 2 || !isOwnerKind(x.owner[0]) || !isStr(x.owner[1])) bad("anchor owner");
  }
  const anchors = o.anchors as KeyAnchor[];
  if (!Number.isSafeInteger(o.seed) || (o.seed as number) < 0 || (o.seed as number) > anchors.length) bad("seed");
  if (o.phase === "children" && (o.seed !== 0 || o.walk !== null)) bad("children phase carries no walk");
  if (o.walk !== null) {
    const w = o.walk as Record<string, unknown>;
    if (!w || typeof w !== "object" || Array.isArray(w) || !keysAre(w, "at,done,line,need,stop") || typeof w.done !== "boolean") bad("walk shape");
    if (w.done && w.line !== null) bad("a finished walk pages no line");
    if ((o.seed as number) >= anchors.length) bad("walk past the last seed");
    if (w.at !== null && !isPos(w.at)) bad("walk.at");
    if (w.stop !== null && !(typeof w.stop === "string" && /^-?\d+$/.test(w.stop))) bad("walk.stop");
    if (!Array.isArray(w.need) || !w.need.every(isStr)) bad("walk.need");
    if (w.line !== null) {
      const l = w.line as Record<string, unknown>;
      if (!l || typeof l !== "object" || Array.isArray(l) || !keysAre(l, "cancelled,id,kidsAfter") || !isStr(l.id) || (l.kidsAfter !== null && !isStr(l.kidsAfter)) || typeof l.cancelled !== "boolean") bad("walk.line");
      if (w.at === null || (w.at as StreamPosition).id !== l.id) bad("a paged line is the last consumed event");
    }
  }
  return o as unknown as KeyProgress;
}

/**
 * The dependency closure of ONE changed key as a resumable walk — the same
 * owners as `changedKeyDependencies` (tested), but with no in-memory set:
 *
 *  - the key's images and parents (one bounded read) give its first owners and
 *    its successor seeds;
 *  - its inverse children are paged (≤500 per page), each page checkpointed;
 *  - each seed's successor walk pages the worker's stream and, for every
 *    consumed stream line, pages that line's own cancellations, judging each
 *    page with the shared projector over [line, ...page] into a monotonic
 *    `cancelled` flag; a checkpoint precedes EVERY source read, so an
 *    interruption replays at most the one in-flight page (plus unconsumed
 *    lookahead of an interrupted stream page) and never rereads earlier pages
 *    or the line (its image is saved once with the first line checkpoint);
 *  - every consumed id of a seed goes to durable storage with its checkpoint;
 *    the returned exact DISTINCT count enforces the 50,001-ID bound before
 *    the next read (an id met as a cancellation and as a stream event, in any
 *    invocation, counts once).
 *
 * The caller advances the outer changed-key cursor only on the final
 * `checkpoint(null, …)`.
 */
export async function walkChangedKey(reader: FrozenReader, k: ChangedKey, resume: KeyProgress | null, io: KeyWalkIo, pages: KeyWalkPages = KEY_WALK_PAGES): Promise<void> {
  if (reader.kind !== "refresh") throw new Error("walkChangedKey is a refresh closure");
  const cutoffUs = exactInstant(reader.cutoff);
  if (cutoffUs === null) throw new RangeError("the frozen cutoff is not an exact instant");
  if (resume && resume.id !== k.id) throw new RangeError("the saved key progress is for another changed key");
  let found = new Map<string, WalkDiscovery>();
  const addOwner = (o: Owner, staff?: string) => {
    const key = ownerKey(o);
    const prev = found.get(key) ?? found.set(key, { owner: o, oldStaff: [] }).get(key)!;
    if (staff && !prev.oldStaff.includes(staff)) prev.oldStaff.push(staff);
  };
  let seen: string[] = [];
  let seenSeed: number | null = null;
  let lineImage: Ev | null = null;
  let dirty = false;
  let st: KeyProgress;
  const snapshot = (): KeyProgress => {
    const s = JSON.parse(JSON.stringify(st)) as KeyProgress;
    if (JSON.stringify(s).length > KEY_PROGRESS_MAX_BYTES) throw new RangeError("the key progress does not fit one checkpoint cursor");
    return s;
  };
  const flush = async (next: KeyProgress | null) => {
    const n = await io.checkpoint(next, { found: [...found.values()], seed: seenSeed, seen, lineImage });
    if (seenSeed !== null) {
      if (n === null) throw new RangeError("a seed checkpoint returned no consumed count");
      const a = st.anchors[seenSeed];
      if (n > MAX_PARTITION_EVENTS) throw new PartitionTooLargeError({ partitionKind: a.owner[0], partitionKey: a.owner[1] }, n);
    }
    found = new Map();
    seen = [];
    lineImage = null;
    dirty = false;
  };
  const beforeRead = async () => {
    if (dirty) await flush(snapshot());
  };

  if (resume) st = JSON.parse(JSON.stringify(resume)) as KeyProgress;
  else {
    st = { id: k.id, phase: "children", kidsAfter: null, anchors: [], seed: 0, walk: null };
    const parentIds = new Set<string>();
    const anchorOf = (l: StreamLine): KeyAnchor => {
      const o = ownerOfEvent(l.ev);
      return { staff: l.ev.staff_id!, at: isoOfMicros(l.us), id: l.ev.id, wt: l.workType, owner: [o.partitionKind, o.partitionKey] };
    };
    for (const img of [k.before, k.after]) {
      if (!img) continue;
      addOwner(ownerOfEvent(img));
      if (img.parent_event_id) parentIds.add(img.parent_event_id);
      const l = streamLine(img, cutoffUs);
      if (l) st.anchors.push(anchorOf(l));
    }
    if (k.before?.staff_id) addOwner(ownerOfEvent(k.before), k.before.staff_id);
    const parents = [...parentIds].sort(compareUtf8);
    if (parents.length) {
      for (const p of (await reader.byIds(parents)).values()) {
        addOwner(ownerOfEvent(p));
        const l = streamLine(p, cutoffUs);
        if (l) st.anchors.push(anchorOf(l));
      }
    }
    dirty = true;
  }

  // Inverse children of the key: owners only.
  while (st.phase === "children") {
    await beforeRead();
    const page = await reader.childPage(k.id, st.kidsAfter, pages.keyChildren);
    for (const c of page) addOwner(ownerOfEvent(c));
    if (page.length) st.kidsAfter = page[page.length - 1].id;
    else {
      st.phase = "seeds";
      st.kidsAfter = null;
    }
    dirty = true;
  }

  // Successor walks, one seed at a time.
  while (st.seed < st.anchors.length) {
    const a = st.anchors[st.seed];
    const aUs = exactInstant(a.at)!;
    seenSeed = st.seed;
    if (!st.walk) {
      st.walk = { at: null, stop: null, need: ["*", ...(a.wt ? [a.wt] : [])], line: null, done: false };
      dirty = true;
    }
    const w = st.walk;
    /** Page one consumed stream line's own cancellations (checkpoint before each page; each page judged once), then judge the line. */
    const finishLine = async (l: StreamLine) => {
      const line = w.line!;
      for (;;) {
        await beforeRead();
        const page = await reader.childPage(l.ev.id, line.kidsAfter, pages.lineKids);
        if (!page.length) break;
        for (const c of page) seen.push(c.id);
        if (!line.cancelled && pageCancels(reader, l, page)) line.cancelled = true;
        line.kidsAfter = page[page.length - 1].id;
        dirty = true;
      }
      addOwner(ownerOfEvent(l.ev));
      if (!line.cancelled && siteEffective(reader, l, []) && projectorOrder(lineOrder(l), { us: aUs, id: a.id }) > 0) {
        w.need = w.need.filter((t) => t !== "*" && t !== l.workType);
      }
      if (w.need.length === 0 && w.stop === null) w.stop = l.us.toString();
      w.line = null;
      dirty = true;
    };
    if (!w.done && w.line) {
      // Resume inside a line's cancellation paging: its saved image and flag, then only the remaining pages.
      const ev = await io.lineImage(st.seed, w.line.id);
      const l = ev && ev.id === w.line.id ? streamLine(ev, cutoffUs) : null;
      if (!l || l.ev.staff_id !== a.staff) throw new RangeError("the interrupted stream line has no valid saved image");
      await finishLine(l);
    }
    let done = w.done;
    while (!done) {
      await beforeRead();
      const page = await reader.stream(a.staff, "after", w.at ?? { createdAt: a.at, id: "" }, pages.stream);
      if (!page.length) break;
      for (const e of page) {
        if (w.stop !== null && micros(e) > BigInt(w.stop)) {
          done = true;
          break;
        }
        seen.push(e.id);
        w.at = { createdAt: e.created_at, id: e.id };
        dirty = true;
        const l = streamLine(e, cutoffUs);
        if (!l) continue;
        w.line = { id: e.id, kidsAfter: null, cancelled: false };
        lineImage = e; // saved with the first checkpoint that carries this line
        await finishLine(l);
      }
    }
    // The seed's last consumed ids are counted under ITS cursor now (the bound holds even without a further
    // read); the last seed's go with the key-completing checkpoint.
    if (!w.done) {
      w.done = true;
      dirty = true;
      if (st.seed + 1 < st.anchors.length) await flush(snapshot());
    }
    st.seed++;
    st.walk = null;
    dirty = true;
  }
  await flush(null);
}

// ---------------------------------------------------------------------------
// Work for every required audience
// ---------------------------------------------------------------------------

export interface MaterializedWork { desc: WorkDescriptor; rows: ResultRows; inputRows: number }
export interface MaterializeStats { owners: number; works: number; maxInput: number; totalInput: number; requests: number; peakInput: number }

function partitionInput(reader: FrozenReader, audience: ReportingAudience, events: readonly Ev[]): FrozenPartitionInput {
  const visible = audience.kind === "self" ? events.filter((e) => e.staff_id === audience.staffId) : events;
  return { site: reader.site, audience, ruleVersion: REPORTING_RULE_VERSION, sourceCutoffUtc: reader.cutoff, events: visible };
}

/** Materialize the given owners ONE AT A TIME (no multi-owner prefetch); `onWork` streams each audience's descriptor and owner rows. */
export async function materializeOwners(reader: FrozenReader, owners: readonly Owner[], oldStaff: ReadonlyMap<string, ReadonlySet<string>>, onWork: (w: MaterializedWork) => void | Promise<void>, stats: MaterializeStats): Promise<void> {
  for (const owner of owners) {
    for (const w of await materializeOwnerWorks(reader, owner, oldStaff.get(ownerKey(owner)) ?? new Set<string>(), stats)) {
      await onWork(w);
      stats.works++;
    }
  }
  stats.requests = reader.requests();
}

/**
 * Task 15: ONE owner's works for every required audience (site, each member's
 * worker, each old self audience), from one input build. The unit the durable
 * worker plans and later stages; `materializeOwners` is this per owner.
 */
export async function materializeOwnerWorks(reader: FrozenReader, owner: Owner, oldStaff: Iterable<string>, stats?: MaterializeStats): Promise<MaterializedWork[]> {
  const input = await buildOwnerInput(reader, owner);
  if (stats) {
    stats.owners++;
    stats.maxInput = Math.max(stats.maxInput, input.events.length);
    stats.peakInput = Math.max(stats.peakInput, input.events.length);
    stats.totalInput += input.events.length;
  }
  const staff = new Set<string>(input.members.map((e) => e.staff_id).filter((s): s is string => !!s));
  for (const s of oldStaff) staff.add(s);
  const audiences: ReportingAudience[] = [{ kind: "site" }, ...[...staff].sort(compareUtf8).map((staffId) => ({ kind: "self" as const, staffId }))];
  return audiences.map((audience) => {
    const pin = partitionInput(reader, audience, input.events);
    const result = projectReportingPartition(pin);
    return {
      desc: { audienceKind: audience.kind, audienceStaff: audience.kind === "self" ? audience.staffId : null, partitionKind: owner.partitionKind, partitionKey: owner.partitionKey, inputHash: sha256Hex(canonicalJson(pin)) },
      rows: ownerRows(result, owner),
      inputRows: pin.events.length,
    };
  });
}

/**
 * Task 15 scale fix: coalesce the children requests that several concurrently
 * materialized owners make (an owner's members, and each stream line only when
 * it is consumed: nothing is prefetched). Requests pending together are served
 * by ONE multi-parent read (at most one in flight; requests arriving meanwhile
 * join the next), of which at most `maxRows` rows are buffered. A parent whose
 * children are proven complete inside that window is answered from it; from
 * the first unproven parent of a request on, the existing lazy read serves the
 * rest. Each consumer therefore sees exactly the same children, in the same
 * order, as before; budget charging and overflow attribution stay with the
 * consuming owner, and memory stays at one window.
 */
export function coalescingChildren(reader: FrozenReader, opts: { maxRows?: number } = {}): FrozenReader {
  const maxRows = Math.max(1, Math.min(opts.maxRows ?? 1000, 1000));
  type Waiter = { resolve: (kids: Ev[] | null) => void; reject: (e: unknown) => void };
  let pending: Map<string, Waiter[]> | null = null;
  const flush = async (batch: Map<string, Waiter[]>) => {
    const ids = [...batch.keys()].sort(compareUtf8);
    const got = new Map<string, Ev[]>(ids.map((id) => [id, []]));
    let complete = false;
    let last: string | null = null;
    let n = 0;
    const it = reader.children(ids)[Symbol.asyncIterator]();
    try {
      while (n < maxRows) {
        const r = await it.next();
        if (r.done) {
          complete = true;
          break;
        }
        const parent = r.value.parent_event_id;
        const list = parent === null ? undefined : got.get(parent);
        if (!list) throw new Error("a coalesced children read returned a row for a parent that was not requested");
        list.push(r.value);
        last = parent;
        n++;
      }
      if (!complete) await it.return?.(undefined);
    } catch (e) {
      for (const ws of batch.values()) for (const w of ws) w.reject(e);
      return;
    }
    for (const id of ids) {
      const proven = complete || (last !== null && compareUtf8(id, last) < 0);
      for (const w of batch.get(id)!) w.resolve(proven ? got.get(id)! : null);
    }
  };
  // At most ONE coalesced read in flight: requests made while it runs join the next one (only consumed lines ever ask).
  // setImmediate (no timer clamp: setTimeout(0) waits ~15 ms per flush on some platforms) collects every request of this turn.
  const soon: (f: () => void) => void = typeof setImmediate === "function" ? (f) => void setImmediate(f) : (f) => void setTimeout(f, 0);
  let inflight = false;
  let scheduled = false;
  const kick = () => {
    if (inflight || scheduled || !pending) return;
    scheduled = true;
    soon(() => {
      scheduled = false;
      const batch = pending;
      if (!batch) return;
      pending = null;
      inflight = true;
      void flush(batch).finally(() => {
        inflight = false;
        kick();
      });
    });
  };
  const request = (id: string) =>
    new Promise<Ev[] | null>((resolve, reject) => {
      const batch = pending ?? (pending = new Map<string, Waiter[]>());
      (batch.get(id) ?? batch.set(id, []).get(id)!).push({ resolve, reject });
      kick();
    });
  return {
    ...reader,
    children(parentIds) {
      const ids = [...new Set(parentIds)].sort(compareUtf8);
      if (!ids.length) return reader.children(ids);
      return (async function* () {
        // All of this request's parents join the SAME pending window (requested synchronously); the proven ones are a
        // bytewise prefix of `ids`. From the first unproven parent on, the existing lazy read serves the rest in order.
        const lists = await Promise.all(ids.map(request));
        for (let i = 0; i < ids.length; i++) {
          const kids = lists[i];
          if (!kids) {
            yield* reader.children(ids.slice(i));
            return;
          }
          yield* kids;
        }
      })();
    },
  };
}

/**
 * Materialize a bounded group of owners concurrently (over a coalescing
 * reader); results come back in the given order, each settled on its own, so a
 * caller can apply them strictly in order and stop at the first failure
 * exactly as a sequential loop would. Memory: at most the group's inputs.
 */
export async function materializeOwnerGroup(
  reader: FrozenReader,
  items: ReadonlyArray<{ owner: Owner; oldStaff: Iterable<string> }>,
  stats?: MaterializeStats,
  /** Per-owner wrapper (the worker's bounded transient retry). */
  run: <T>(f: () => Promise<T>) => Promise<T> = (f) => f(),
): Promise<Array<PromiseSettledResult<MaterializedWork[]>>> {
  return Promise.allSettled(items.map((i) => run(() => materializeOwnerWorks(reader, i.owner, i.oldStaff, stats))));
}

/** Whole batch in memory (tests and small refreshes): every affected (refresh) or every (rebuild) owner and audience. */
export async function materializeBatch(reader: FrozenReader): Promise<{ works: MaterializedWork[]; stats: MaterializeStats }> {
  const stats: MaterializeStats = { owners: 0, works: 0, maxInput: 0, totalInput: 0, requests: 0, peakInput: 0 };
  let owners: Owner[];
  let oldStaff: Map<string, Set<string>> = new Map();
  if (reader.kind === "refresh") ({ owners, oldStaff } = await affectedOwners(reader));
  else {
    owners = [];
    for await (const o of reader.owners()) owners.push(o);
  }
  const works: MaterializedWork[] = [];
  await materializeOwners(reader, owners, oldStaff, (w) => void works.push(w), stats);
  works.sort((a, b) => compareUtf8(a.desc.audienceKind, b.desc.audienceKind) || compareUtf8(a.desc.audienceStaff ?? "", b.desc.audienceStaff ?? "") || compareUtf8(a.desc.partitionKind, b.desc.partitionKind) || compareUtf8(a.desc.partitionKey, b.desc.partitionKey));
  return { works, stats };
}
