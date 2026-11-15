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
  /** Frozen events whose parent_event_id is one of `parentIds`. */
  children(parentIds: readonly string[]): Promise<Ev[]>;
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

/** An in-memory frozen view with the same bounded contract as the 0040 RPCs (`maxPage` shortens stream pages, as a byte cap can). */
export function memoryFrozenReader(o: { site: string; cutoff: string; kind: "refresh" | "rebuild"; view: readonly Ev[]; changed: readonly ChangedKey[]; maxPage?: number }): FrozenReader {
  let n = 0;
  const view = [...o.view];
  const byId = new Map(view.map((e) => [e.id, e]));
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
      const want = new Set(owners.map(ownerKey));
      const out = new Map<string, Ev[]>(owners.map((x) => [ownerKey(x), []]));
      for (const e of view) {
        const k = ownerKey(ownerOfEvent(e));
        if (want.has(k) && out.get(k)!.length <= cap) out.get(k)!.push(e);
      }
      return out;
    },
    async byIds(ids) {
      n++;
      return new Map(ids.filter((id) => byId.has(id)).map((id) => [id, byId.get(id)!]));
    },
    async children(parentIds) {
      n++;
      const p = new Set(parentIds);
      return view.filter((e) => e.parent_event_id !== null && p.has(e.parent_event_id));
    },
    async stream(staff, direction, from, limit) {
      n++;
      const rows = view.filter((e) => e.staff_id === staff && (direction === "before" ? compareStream(e, { created_at: from.createdAt, id: from.id }) < 0 : compareStream(e, { created_at: from.createdAt, id: from.id }) > 0));
      rows.sort(compareStream);
      if (direction === "before") rows.reverse();
      return rows.slice(0, Math.min(limit, o.maxPage ?? limit));
    },
    requests: () => n,
  };
}

// ---------------------------------------------------------------------------
// Stream helpers (shared rules only)
// ---------------------------------------------------------------------------

interface StreamLine { ev: Ev; us: bigint; workType: string | null }

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
 * The exact stream walk. A worker's events are CONSUMED one at a time in
 * stream order from `from` (exclusive). Each consumed stream candidate brings
 * its own cancellations and is judged site-effective; `onLine` says whether
 * the walk is now satisfied. Once satisfied, the walk finishes that line's
 * instant (ties are kept whole) and stops. What is consumed depends only on
 * the frozen view, never on page sizes (a short, byte-capped page is not the
 * end; only an empty page is).
 */
async function exactWalk(
  reader: FrozenReader,
  staff: string,
  from: StreamPosition,
  direction: "before" | "after",
  cutoffUs: bigint,
  onEvent: (e: Ev) => void,
  onLine: (l: StreamLine, effective: boolean, kids: readonly Ev[]) => boolean,
): Promise<void> {
  let stopAt: bigint | null = null;
  let cursor = from;
  for (;;) {
    const page = await reader.stream(staff, direction, cursor, STREAM_PAGE);
    if (!page.length) return;
    // Cancellations of every candidate on the page in one bounded read; only consumed candidates' join the input.
    const candidates = page.map((e) => streamLine(e, cutoffUs)).filter((l): l is StreamLine => l !== null);
    const kidsOf = new Map<string, Ev[]>();
    if (candidates.length) {
      for (const k of await reader.children(candidates.map((l) => l.ev.id))) {
        const list = kidsOf.get(k.parent_event_id!) ?? [];
        list.push(k);
        kidsOf.set(k.parent_event_id!, list);
      }
    }
    for (const e of page) {
      const us = micros(e);
      if (stopAt !== null && (direction === "before" ? us < stopAt : us > stopAt)) return;
      onEvent(e);
      const l = streamLine(e, cutoffUs);
      if (!l) continue;
      const kids = kidsOf.get(e.id) ?? [];
      if (onLine(l, siteEffective(reader, l, kids), kids) && stopAt === null) stopAt = l.us;
    }
    const last = page[page.length - 1];
    cursor = { createdAt: last.created_at, id: last.id };
  }
}

/**
 * Timing successors of a changed position: every stream line of the worker
 * after it, up to and including the first site-effective line of all types and
 * of each type in `types` (ties kept whole). Their prev pointers may change.
 */
async function walkSuccessors(reader: FrozenReader, staff: string, from: StreamPosition, types: ReadonlySet<string>, cutoffUs: bigint): Promise<StreamLine[]> {
  const need = new Set<string>(["*", ...types]);
  const lines: StreamLine[] = [];
  await exactWalk(reader, staff, from, "after", cutoffUs, () => undefined, (l, effective) => {
    lines.push(l);
    if (effective) {
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
  if (members.length > MAX_PARTITION_EVENTS) throw new PartitionTooLargeError(owner, members.length);
  const cutoffUs = exactInstant(reader.cutoff);
  if (cutoffUs === null) throw new RangeError("the frozen cutoff is not an exact instant");
  const context = new Map<string, Ev>(members.map((e) => [e.id, e]));
  const budget = () => {
    if (context.size > MAX_PARTITION_EVENTS) throw new PartitionTooLargeError(owner, context.size);
  };
  // Parents of members (a cancellation's edge needs its parent's role/time/sides).
  const parentIds = [...new Set(members.map((e) => e.parent_event_id).filter((p): p is string => !!p && !context.has(p)))];
  for (let i = 0; i < parentIds.length; i += 500) for (const [id, e] of await reader.byIds(parentIds.slice(i, i + 500))) context.set(id, e);
  budget();
  // Inverse children of members (they decide a member's effectiveness).
  const ids = members.map((e) => e.id);
  for (let i = 0; i < ids.length; i += 500) for (const k of await reader.children(ids.slice(i, i + 500))) context.set(k.id, k);
  budget();
  // Stream predecessors: per worker, from the worker's LATEST member line down past an effective
  // predecessor (all types and each member type) below its EARLIEST member line.
  const byWorker = new Map<string, StreamLine[]>();
  for (const e of members) {
    const l = streamLine(e, cutoffUs);
    if (!l) continue;
    const list = byWorker.get(e.staff_id!) ?? [];
    list.push(l);
    byWorker.set(e.staff_id!, list);
  }
  for (const [staff, lines] of [...byWorker.entries()].sort((x, y) => compareUtf8(x[0], y[0]))) {
    lines.sort((x, y) => compareStream(x.ev, y.ev));
    const latest = lines[lines.length - 1];
    const types = new Set(lines.map((l) => l.workType).filter((t): t is string => t !== null));
    // Start just after the latest member's microsecond so every tie at that instant is read too.
    await walkBelow(reader, staff, latest.us + 1n, lines[0], types, context, budget, cutoffUs);
  }
  const events = [...context.values()].sort((x, y) => compareUtf8(x.id, y.id));
  return { owner, members: [...members].sort((x, y) => compareUtf8(x.id, y.id)), events };
}

/**
 * Stream predecessors: walk a worker's events down from (startUs, "") — every
 * consumed event and every consumed candidate's cancellations join the input —
 * until a site-effective line of all types and of each member type has been
 * found BELOW the earliest member line (ties kept whole).
 */
async function walkBelow(reader: FrozenReader, staff: string, startUs: bigint, earliest: StreamLine, types: ReadonlySet<string>, context: Map<string, Ev>, budget: () => void, cutoffUs: bigint): Promise<void> {
  const need = new Set<string>(["*", ...types]);
  const below = (l: StreamLine) => l.us < earliest.us || (l.us === earliest.us && l.ev.id < earliest.ev.id);
  await exactWalk(reader, staff, { createdAt: isoOfMicros(startUs), id: "" }, "before", cutoffUs, (e) => {
    context.set(e.id, e);
    budget();
  }, (l, effective, kids) => {
    for (const k of kids) context.set(k.id, k);
    budget();
    if (effective && below(l)) {
      need.delete("*");
      if (l.workType !== null) need.delete(l.workType);
    }
    return need.size === 0;
  });
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
  const walks: StreamLine[] = [];
  for await (const k of reader.changedKeys()) {
    changedIds.push(k.id);
    for (const img of [k.before, k.after]) {
      if (!img) continue;
      add(ownerOfEvent(img)); // old and new owners (also invalid-identity and due future keys)
      if (img.parent_event_id) parentIds.add(img.parent_event_id);
      const l = streamLine(img, cutoffUs);
      if (l) walks.push(l);
    }
    if (k.before?.staff_id) {
      const key = ownerKey(ownerOfEvent(k.before));
      const set = oldStaff.get(key) ?? new Set<string>();
      set.add(k.before.staff_id);
      oldStaff.set(key, set);
    }
  }
  // Parents (their effectiveness/edges change) and their timing successors.
  const parents = [...parentIds];
  for (let i = 0; i < parents.length; i += 500) {
    for (const p of (await reader.byIds(parents.slice(i, i + 500))).values()) {
      add(ownerOfEvent(p));
      const l = streamLine(p, cutoffUs);
      if (l) walks.push(l);
    }
  }
  // Inverse children of every changed key (their edge reads this parent).
  for (let i = 0; i < changedIds.length; i += 500) for (const c of await reader.children(changedIds.slice(i, i + 500))) add(ownerOfEvent(c));
  // Timing successors: from each changed/affected stream position forward, every stream line up to the first
  // effective one of all types and of the line's type (ties kept whole).
  for (const w of walks) {
    const types = new Set<string>(w.workType ? [w.workType] : []);
    const lines = await walkSuccessors(reader, w.ev.staff_id!, { createdAt: isoOfMicros(w.us), id: "" }, types, cutoffUs);
    for (const l of lines) add(ownerOfEvent(l.ev));
  }
  return { owners: [...owners.values()].sort((x, y) => compareUtf8(ownerKey(x), ownerKey(y))), oldStaff };
}

// ---------------------------------------------------------------------------
// Work for every required audience
// ---------------------------------------------------------------------------

export interface MaterializedWork { desc: WorkDescriptor; rows: ResultRows; inputRows: number }
export interface MaterializeStats { owners: number; works: number; maxInput: number; totalInput: number; requests: number }

function partitionInput(reader: FrozenReader, audience: ReportingAudience, events: readonly Ev[]): FrozenPartitionInput {
  const visible = audience.kind === "self" ? events.filter((e) => e.staff_id === audience.staffId) : events;
  return { site: reader.site, audience, ruleVersion: REPORTING_RULE_VERSION, sourceCutoffUtc: reader.cutoff, events: visible };
}

/** Materialize the given owners; `onWork` receives each audience's descriptor and owner rows (streaming, bounded memory). */
export async function materializeOwners(reader: FrozenReader, owners: readonly Owner[], oldStaff: ReadonlyMap<string, ReadonlySet<string>>, onWork: (w: MaterializedWork) => void | Promise<void>, stats: MaterializeStats): Promise<void> {
  for (let i = 0; i < owners.length; i += 100) {
    const group = owners.slice(i, i + 100);
    const members = await reader.members(group, MAX_PARTITION_EVENTS);
    for (const owner of group) {
      const own = members.get(ownerKey(owner)) ?? [];
      if (own.length > MAX_PARTITION_EVENTS) throw new PartitionTooLargeError(owner, own.length);
      const input = await buildOwnerInput(reader, owner, own);
      stats.owners++;
      stats.maxInput = Math.max(stats.maxInput, input.events.length);
      stats.totalInput += input.events.length;
      const staff = new Set<string>(input.members.map((e) => e.staff_id).filter((s): s is string => !!s));
      for (const s of oldStaff.get(ownerKey(owner)) ?? []) staff.add(s);
      const audiences: ReportingAudience[] = [{ kind: "site" }, ...[...staff].sort(compareUtf8).map((staffId) => ({ kind: "self" as const, staffId }))];
      for (const audience of audiences) {
        const pin = partitionInput(reader, audience, input.events);
        const result = projectReportingPartition(pin);
        await onWork({
          desc: { audienceKind: audience.kind, audienceStaff: audience.kind === "self" ? audience.staffId : null, partitionKind: owner.partitionKind, partitionKey: owner.partitionKey, inputHash: sha256Hex(canonicalJson(pin)) },
          rows: ownerRows(result, owner),
          inputRows: pin.events.length,
        });
        stats.works++;
      }
    }
  }
  stats.requests = reader.requests();
}

/** Whole batch in memory (tests and small refreshes): every affected (refresh) or every (rebuild) owner and audience. */
export async function materializeBatch(reader: FrozenReader): Promise<{ works: MaterializedWork[]; stats: MaterializeStats }> {
  const stats: MaterializeStats = { owners: 0, works: 0, maxInput: 0, totalInput: 0, requests: 0 };
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
