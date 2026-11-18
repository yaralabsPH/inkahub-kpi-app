/**
 * Task 15: typed wrappers of the 0043 durable worker-state RPCs (service-only).
 *
 * Every call is bounded (≤1,000 rows / 1 MiB) and fenced by the batch lease.
 * The seal manifest is computed by a bounded traversal of the SAVED
 * descriptors in work_manifest order (a streaming SHA-256), never by holding
 * the batch's descriptors in memory; the count must also equal the
 * independent per-owner completeness proof from verify_reporting_plan.
 */
import { createHash } from "node:crypto";
import { ReportingJobError, type RpcClient } from "./reporting-jobs.js";
import { compareUtf8, descriptorProblem, manifestLine, type WorkDescriptor } from "./reporting-stage.js";
import { isStreamCandidate, parseKeyProgress, type KeyCheckpoint, type KeyProgress, type Owner, type OwnerJournal, type OwnerJournalSnapshot } from "./production-reporting-materialize.js";
import type { ProductionEvidenceEvent } from "../../src/lib/domain/productionCounts.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ROWS = 1000;
const MIB = 1024 * 1024;

async function rows(client: RpcClient, fn: string, args: Record<string, unknown>, exactlyOne: boolean): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new ReportingJobError(`${fn} failed: ${error.message}`, error.code ?? null);
  if (!Array.isArray(data)) throw new ReportingJobError(`${fn} returned no rows array`);
  if (exactlyOne && data.length !== 1) throw new ReportingJobError(`${fn} returned ${data.length} rows, expected 1`);
  if (data.length > MAX_ROWS) throw new ReportingJobError(`${fn} returned more than 1,000 rows`);
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > MIB) throw new ReportingJobError(`${fn} returned more than 1 MiB`);
  return data as Array<Record<string, unknown>>;
}
const int = (v: unknown, what: string): number => {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new ReportingJobError(`${what} is not a non-negative integer`);
  return n;
};
const str = (v: unknown, what: string): string => {
  if (typeof v !== "string") throw new ReportingJobError(`${what} must be text`);
  return v;
};
const bool = (v: unknown, what: string): boolean => {
  if (typeof v !== "boolean") throw new ReportingJobError(`${what} is not a boolean`);
  return v;
};
const batchArgs = (batchId: string, fence: number) => {
  if (!UUID.test(batchId)) throw new ReportingJobError("batchId must be a uuid");
  if (!Number.isSafeInteger(fence) || fence < 1) throw new ReportingJobError("fence must be a positive safe integer");
  return { p_batch: batchId, p_fence: fence };
};

/** A saved enumeration position: refresh = last changed-key id; rebuild = last owner keyset; `end` once complete. */
/** Refresh: `key` is the saved progress INSIDE the next changed key (the outer `after` advances only when that key is complete). */
export type EnumCursor = { kind: "refresh"; after: string | null; end?: true; key?: KeyProgress } | { kind: "rebuild"; after: [Owner["partitionKind"], string] | null; end?: true };
export function parseEnumCursor(v: unknown): EnumCursor | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new ReportingJobError("enum_cursor is not an object");
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys === "after,key,kind") {
    if (o.kind !== "refresh" || !(o.after === null || (typeof o.after === "string" && o.after !== ""))) throw new ReportingJobError("enum_cursor is malformed");
    let key: KeyProgress;
    try {
      key = parseKeyProgress(o.key);
    } catch (e) {
      throw new ReportingJobError(`enum_cursor: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (o.after !== null && compareUtf8(key.id, o.after as string) <= 0) throw new ReportingJobError("enum_cursor: the in-progress key must follow the completed ones");
    return { kind: "refresh", after: o.after as string | null, key };
  }
  if (keys !== "after,kind" && keys !== "after,end,kind") throw new ReportingJobError("enum_cursor has unexpected keys");
  if (o.end !== undefined && o.end !== true) throw new ReportingJobError("enum_cursor.end must be true");
  const end = o.end === true ? ({ end: true } as const) : {};
  if (o.kind === "refresh" && (o.after === null || (typeof o.after === "string" && o.after !== ""))) return { kind: "refresh", after: o.after as string | null, ...end };
  if (o.kind === "rebuild" && (o.after === null || (Array.isArray(o.after) && o.after.length === 2 && (o.after[0] === "order" || o.after[0] === "event") && typeof o.after[1] === "string" && o.after[1] !== ""))) {
    return { kind: "rebuild", after: o.after as [Owner["partitionKind"], string] | null, ...end };
  }
  throw new ReportingJobError("enum_cursor is malformed");
}

export interface OwnerDiscovery { owner: Owner; oldStaff: string[] }
export interface EnumerationCheckpoint { ownersDiscovered: number; cursor: EnumCursor | null; complete: boolean; replay: boolean }

/** Owners as [kind, key, sorted distinct staff], merged by owner (≤1,000 entries per checkpoint). */
export function checkpointOwners(found: readonly OwnerDiscovery[]): Array<[string, string, string[]]> {
  const m = new Map<string, { owner: Owner; staff: Set<string> }>();
  for (const f of found) {
    const k = `${f.owner.partitionKind}\u0000${f.owner.partitionKey}`;
    const e = m.get(k) ?? m.set(k, { owner: f.owner, staff: new Set() }).get(k)!;
    for (const s of f.oldStaff) {
      if (!UUID.test(s)) throw new ReportingJobError("old self staff must be a uuid");
      e.staff.add(s);
    }
  }
  return [...m.values()]
    .sort((a, b) => compareUtf8(a.owner.partitionKind, b.owner.partitionKind) || compareUtf8(a.owner.partitionKey, b.owner.partitionKey))
    .map((e) => [e.owner.partitionKind, e.owner.partitionKey, [...e.staff].sort()]);
}

export async function saveEnumeration(client: RpcClient, batchId: string, fence: number, expected: EnumCursor | null, next: EnumCursor, found: readonly OwnerDiscovery[], complete: boolean): Promise<EnumerationCheckpoint> {
  const owners = checkpointOwners(found);
  if (owners.length > MAX_ROWS) throw new ReportingJobError("an enumeration checkpoint holds at most 1,000 owners");
  const [r] = await rows(client, "save_reporting_enumeration", { ...batchArgs(batchId, fence), p_expected_cursor: expected, p_next_cursor: next, p_owners: owners, p_complete: complete }, true);
  return { ownersDiscovered: int(r.owners_discovered, "owners_discovered"), cursor: parseEnumCursor(r.enum_cursor), complete: bool(r.enum_complete, "enum_complete"), replay: bool(r.replay, "replay") };
}

export interface WorkerProgress { cursor: EnumCursor | null; complete: boolean; ownersDiscovered: number; ownersPlanned: number; descriptorsPlanned: number; sealed: boolean }
export async function readWorkerProgress(client: RpcClient, batchId: string, fence: number): Promise<WorkerProgress> {
  const [r] = await rows(client, "read_reporting_worker_progress", batchArgs(batchId, fence), true);
  return {
    cursor: parseEnumCursor(r.enum_cursor),
    complete: bool(r.enum_complete, "enum_complete"),
    ownersDiscovered: int(r.owners_discovered, "owners_discovered"),
    ownersPlanned: int(r.owners_planned, "owners_planned"),
    descriptorsPlanned: int(r.descriptors_planned, "descriptors_planned"),
    sealed: bool(r.sealed, "sealed"),
  };
}

export interface SavedOwner extends OwnerDiscovery { descriptorCount: number | null }
export async function listWorkerOwners(client: RpcClient, batchId: string, fence: number, unplannedOnly: boolean, after: Owner | null, limit = MAX_ROWS): Promise<SavedOwner[]> {
  const out = await rows(client, "list_reporting_worker_owners", { ...batchArgs(batchId, fence), p_unplanned_only: unplannedOnly, p_after_kind: after?.partitionKind ?? null, p_after_key: after?.partitionKey ?? null, p_limit: limit }, false);
  let prev = after;
  return out.map((r) => {
    if (r.partition_kind !== "order" && r.partition_kind !== "event") throw new ReportingJobError("list_reporting_worker_owners returned an unknown kind");
    if (typeof r.partition_key !== "string" || !r.partition_key) throw new ReportingJobError("list_reporting_worker_owners returned a bad key");
    if (!Array.isArray(r.old_staff) || !r.old_staff.every((s) => typeof s === "string" && UUID.test(s))) throw new ReportingJobError("list_reporting_worker_owners returned bad staff");
    const owner: Owner = { partitionKind: r.partition_kind, partitionKey: r.partition_key };
    if (prev && (compareUtf8(prev.partitionKind, owner.partitionKind) || compareUtf8(prev.partitionKey, owner.partitionKey)) >= 0) throw new ReportingJobError("list_reporting_worker_owners is not in keyset order");
    prev = owner;
    return { owner, oldStaff: r.old_staff as string[], descriptorCount: r.descriptor_count === null ? null : int(r.descriptor_count, "descriptor_count") };
  });
}

export async function planOwner(client: RpcClient, batchId: string, fence: number, owner: Owner, descriptors: readonly WorkDescriptor[]): Promise<{ descriptorCount: number; replay: boolean }> {
  if (descriptors.length < 1 || descriptors.length > MAX_ROWS) throw new ReportingJobError("an owner plans 1..1,000 descriptors");
  for (const d of descriptors) {
    const p = descriptorProblem(d);
    if (p) throw new ReportingJobError(`descriptor: ${p}`);
    if (d.partitionKind !== owner.partitionKind || d.partitionKey !== owner.partitionKey) throw new ReportingJobError("a descriptor belongs to another owner");
  }
  const [r] = await rows(client, "plan_reporting_owner", { ...batchArgs(batchId, fence), p_kind: owner.partitionKind, p_key: owner.partitionKey, p_items: descriptors }, true);
  const n = int(r.descriptor_count, "descriptor_count");
  if (n !== descriptors.length) throw new ReportingJobError("plan_reporting_owner saved a different count");
  return { descriptorCount: n, replay: bool(r.replay, "replay") };
}

export async function verifyPlan(client: RpcClient, batchId: string, fence: number): Promise<{ owners: number; descriptors: number }> {
  const [r] = await rows(client, "verify_reporting_plan", batchArgs(batchId, fence), true);
  return { owners: int(r.owners, "owners"), descriptors: int(r.descriptors, "descriptors") };
}

/**
 * The seal's count and hash from a bounded traversal of the SAVED descriptors
 * (work_manifest order and line format; streaming SHA-256). Order is checked;
 * only an empty page ends the traversal.
 */
export async function manifestFromSaved(client: RpcClient, batchId: string, fence: number, maxPages = 1_000_000): Promise<{ count: number; hash: string; pages: number }> {
  const h = createHash("sha256");
  let after: [string, string, string, string] | null = null;
  let count = 0;
  for (let pages = 0; pages < maxPages; pages++) {
    const page = await rows(client, "list_reporting_work_descriptors", { ...batchArgs(batchId, fence), p_after: after, p_limit: MAX_ROWS }, false);
    if (!page.length) return { count, hash: h.digest("hex"), pages };
    for (const r of page) {
      const d: WorkDescriptor = { audienceKind: r.audience_kind as WorkDescriptor["audienceKind"], audienceStaff: (r.audience_staff ?? null) as string | null, partitionKind: r.partition_kind as WorkDescriptor["partitionKind"], partitionKey: r.partition_key as string, inputHash: r.input_hash as string };
      const p = descriptorProblem(d);
      if (p) throw new ReportingJobError(`saved descriptor: ${p}`);
      const key: [string, string, string, string] = [d.audienceKind, d.audienceStaff ?? "", d.partitionKind, d.partitionKey];
      if (after && compareTuple(key, after) <= 0) throw new ReportingJobError("list_reporting_work_descriptors is not in manifest order");
      h.update(count === 0 ? manifestLine(d) : `\n${manifestLine(d)}`);
      count++;
      after = key;
    }
  }
  throw new ReportingJobError("the descriptor traversal did not finish");
}
const compareTuple = (a: readonly string[], b: readonly string[]) => {
  for (let i = 0; i < a.length; i++) {
    const c = compareUtf8(a[i], b[i]);
    if (c) return c;
  }
  return 0;
};

export async function sealWithManifest(client: RpcClient, batchId: string, fence: number, count: number, hash: string): Promise<{ workCount: number; replay: boolean }> {
  const [r] = await rows(client, "seal_reporting_work", { ...batchArgs(batchId, fence), p_expected_count: count, p_manifest_hash: hash }, true);
  const n = int(r.work_count, "work_count");
  if (n !== count || r.manifest_hash !== hash) throw new ReportingJobError("seal_reporting_work sealed a different manifest");
  return { workCount: n, replay: bool(r.replay, "replay") };
}

export async function setSiteMode(client: RpcClient, site: string, readMode: "legacy" | "shadow" | "summary" | null, processorEnabled: boolean | null): Promise<{ site: string; readMode: string; processorEnabled: boolean; activeGenerationId: string | null }> {
  const [r] = await rows(client, "set_reporting_site_mode", { p_site: site, p_read_mode: readMode, p_processor_enabled: processorEnabled }, true);
  return { site: String(r.site), readMode: String(r.read_mode), processorEnabled: bool(r.processor_enabled, "processor_enabled"), activeGenerationId: (r.active_generation_id as string | null) ?? null };
}

export interface RunRecord { site: string | null; mode: "refresh" | "rebuild" | "cleanup" | "operator"; action: string; outcome: "published" | "pending" | "busy" | "idle" | "failed" | "done"; batchId: string | null; generationId: string | null; startedAtUtc: string; durationMs: number; counts: Record<string, number | boolean | null>; failureKind: string | null }
export async function recordRun(client: RpcClient, r: RunRecord): Promise<void> {
  await rows(client, "record_reporting_run", {
    p_site: r.site, p_mode: r.mode, p_action: r.action, p_outcome: r.outcome, p_batch: r.batchId, p_generation: r.generationId, p_started_at: r.startedAtUtc,
    p_duration_ms: Math.max(0, Math.round(r.durationMs)), p_counts: r.counts, p_failure_kind: r.failureKind === null ? null : r.failureKind.replace(/[\r\n]+/g, " ").slice(0, 200),
  }, true);
}

export interface CleanupPass { expiredGenerations: number; deletedVersions: number; deletedRuns: number; deletedWorkerRows: number; more: boolean }
export async function cleanupHistory(client: RpcClient, site: string, limit = 5000): Promise<CleanupPass> {
  const [r] = await rows(client, "cleanup_reporting_history", { p_site: site, p_limit: limit }, true);
  return { expiredGenerations: int(r.expired_generations, "expired_generations"), deletedVersions: int(r.deleted_versions, "deleted_versions"), deletedRuns: int(r.deleted_runs, "deleted_runs"), deletedWorkerRows: int(r.deleted_worker_rows, "deleted_worker_rows"), more: bool(r.more, "more") };
}

export interface WalkCheckpoint extends EnumerationCheckpoint { seenCount: number | null }
/**
 * One resumable-walk checkpoint (0043 save_reporting_walk), atomically: the
 * cursor advance, owners, the seed's newly consumed ids (deduplicated and
 * counted by the database; >50,000 distinct raises partition_too_large and
 * rolls the whole checkpoint back) and, once per paged line, its image.
 * `keyComplete` advances the outer cursor past the key and drops its scratch rows.
 */
export async function saveWalk(client: RpcClient, batchId: string, fence: number, expected: EnumCursor | null, next: EnumCursor, keyId: string, step: KeyCheckpoint, keyComplete: boolean): Promise<WalkCheckpoint> {
  const owners = checkpointOwners(step.found);
  if (owners.length > MAX_ROWS) throw new ReportingJobError("a walk checkpoint holds at most 1,000 owners");
  if (step.seen.length > 2 * MAX_ROWS) throw new ReportingJobError("a walk checkpoint holds at most one stream and one child page of ids");
  const [r] = await rows(client, "save_reporting_walk", {
    ...batchArgs(batchId, fence), p_expected_cursor: expected, p_next_cursor: next, p_owners: owners,
    p_key: keyId, p_seed: step.seed, p_seen: step.seen, p_line_image: step.lineImage, p_key_complete: keyComplete,
  }, true);
  return {
    ownersDiscovered: int(r.owners_discovered, "owners_discovered"), cursor: parseEnumCursor(r.enum_cursor), complete: bool(r.enum_complete, "enum_complete"), replay: bool(r.replay, "replay"),
    seenCount: r.seen_count === null ? null : int(r.seen_count, "seen_count"),
  };
}

/** The saved image of an interrupted paged stream line (worker state, not a source read); null when none is saved. */
export async function readWalkLine(client: RpcClient, batchId: string, fence: number, keyId: string, seed: number, line: string): Promise<unknown | null> {
  const out = await rows(client, "read_reporting_walk_line", { ...batchArgs(batchId, fence), p_key: keyId, p_seed: seed, p_line: line }, false);
  if (out.length > 1) throw new ReportingJobError("read_reporting_walk_line returned more than one line");
  return out.length ? out[0].image : null;
}

// ---------------------------------------------------------------------------
// T15P-4c: the 0046 owner-input journal (service-only; offline draft)
// ---------------------------------------------------------------------------

/** The journal protocol version this code speaks (`reporting_owner_input_version`). */
export const OWNER_INPUT_VERSION = 1;
/** The one piece rule (r5 §2): a piece's own JSON string literal (quotes and escapes included) is at most this many bytes. */
export const PIECE_LITERAL_BYTES = 196_608;
/** Request bodies are packed to at most this many UTF-8 bytes of JSON (r6 R6 "the request fit"). */
export const REQUEST_BODY_BYTES = 1_048_576 - 512;
/** The reduced event's text: exactly these keys, in this order (r5 §2). */
export const EVENT_TEXT_KEYS = ["id", "location", "staff_id", "department", "order_number", "line_sku", "line_quantity", "event_type", "created_at", "parent_event_id", "cs_case_id"] as const;

const MAX_BIGINT = 9223372036854775807n;
/** Decimal text in lo..2^63-1, never converted to a Number (seq: lo 0; handles: lo 1). */
function decimalText(v: unknown, lo: 0 | 1, what: string): string {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(v)) throw new ReportingJobError(`${what} must be decimal text`);
  const n = BigInt(v);
  if (n < BigInt(lo) || n > MAX_BIGINT) throw new ReportingJobError(`${what} is out of range`);
  return v;
}
export const parseSeq = (v: unknown, what = "seq"): string => decimalText(v, 0, what);
export const parseHandle = (v: unknown, what = "handle"): string => decimalText(v, 1, what);
const nextSeq = (seq: string): string => (BigInt(seq) + 1n).toString();

const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const literalBytes = (s: string): number => utf8(JSON.stringify(s));

/** The canonical reduced-event text the journal stores (and the server reassembles and parses). */
export function eventText(e: ProductionEvidenceEvent): string {
  return JSON.stringify(Object.fromEntries(EVENT_TEXT_KEYS.map((k) => [k, e[k]])));
}

/** Split by code points into MAXIMAL pieces whose escaped literal is <= PIECE_LITERAL_BYTES (linear). */
export function splitPieces(text: string): string[] {
  if (!text) throw new ReportingJobError("an event text cannot be empty");
  const out: string[] = [];
  let cur: string[] = [];
  let len = 2;
  for (const ch of text) {
    const w = literalBytes(ch) - 2;
    if (cur.length && len + w > PIECE_LITERAL_BYTES) {
      out.push(cur.join(""));
      cur = [ch];
      len = 2 + w;
    } else {
      cur.push(ch);
      len += w;
    }
  }
  out.push(cur.join(""));
  return out;
}

export interface PieceMeta { event_id: string; pieces: number; text_bytes: number; text_sha256: string; src_at: string; stream_candidate: boolean }
/** `[ord, piece_no, piece]` for a continuation, `[ord, 0, piece, meta]` for an event's first piece. */
export type PieceEntry = [number, number, string] | [number, 0, string, PieceMeta];

/** Entries for `events` taking ordinals from `fromOrd`; `candidate` is the adapter-authoritative stream flag. */
export function eventEntries(events: readonly ProductionEvidenceEvent[], fromOrd: number, candidate: (e: ProductionEvidenceEvent) => boolean): PieceEntry[] {
  if (!Number.isInteger(fromOrd) || fromOrd < 1) throw new ReportingJobError("ordinals start at 1");
  const out: PieceEntry[] = [];
  events.forEach((e, i) => {
    const t = eventText(e);
    const ps = splitPieces(t);
    const flag = candidate(e);
    if (typeof flag !== "boolean") throw new ReportingJobError("stream_candidate must be a boolean");
    ps.forEach((p, n) => {
      if (n === 0) out.push([fromOrd + i, 0, p, { event_id: e.id, pieces: ps.length, text_bytes: utf8(t), text_sha256: sha256(t), src_at: e.created_at, stream_candidate: flag }]);
      else out.push([fromOrd + i, n, p]);
    });
  });
  return out;
}

/**
 * Greedy packing of entries into request bodies: each group, inside `{"kind":…,"pieces":[…]…}` with `fixedBytes`
 * of other fields, stays within REQUEST_BODY_BYTES. Order is preserved; every entry fits an empty body (r6 R6).
 */
export function packEntries(entries: readonly PieceEntry[], fixedBytes: number): PieceEntry[][] {
  const groups: PieceEntry[][] = [];
  let cur: PieceEntry[] = [];
  let size = fixedBytes;
  for (const e of entries) {
    const b = utf8(JSON.stringify(e));
    if (fixedBytes + b > REQUEST_BODY_BYTES) throw new ReportingJobError("a piece entry does not fit one request");
    if (cur.length && size + 1 + b > REQUEST_BODY_BYTES) {
      groups.push(cur);
      cur = [];
      size = fixedBytes;
    }
    size += (cur.length ? 1 : 0) + b;
    cur.push(e);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

const owners2 = (o: Owner): [string, string] => [o.partitionKind, o.partitionKey];
const nint = (v: unknown, what: string): number | null => (v === null || v === undefined ? null : int(v, what));
const purposeOf = (v: unknown): "plan" | "stage" => {
  if (v !== "plan" && v !== "stage") throw new ReportingJobError("owner input purpose must be plan or stage");
  return v;
};
const phaseOf = (v: unknown): "reading" | "hashing" | "complete" => {
  if (v !== "reading" && v !== "hashing" && v !== "complete") throw new ReportingJobError("owner input phase is unknown");
  return v;
};

export async function ownerInputVersion(client: RpcClient): Promise<number> {
  const [r] = await rows(client, "reporting_owner_input_version", {}, true);
  return int(r.version, "version");
}

export interface OwnerInputHandle { handle: string; created: boolean; phase: "reading" | "hashing" | "complete"; seq: string; reloadCalls: number; provisionalReloadCalls: number; heavyProven: boolean; pendingEvents: number }
export async function openOwnerInput(client: RpcClient, batchId: string, fence: number, owner: Owner, purpose: "plan" | "stage"): Promise<OwnerInputHandle> {
  const [r] = await rows(client, "open_reporting_owner_input", { ...batchArgs(batchId, fence), p_kind: owner.partitionKind, p_key: owner.partitionKey, p_purpose: purposeOf(purpose) }, true);
  return {
    handle: parseHandle(r.handle), created: bool(r.created, "created"), phase: phaseOf(r.phase), seq: parseSeq(r.seq), reloadCalls: int(r.reload_calls, "reload_calls"),
    provisionalReloadCalls: int(r.provisional_reload_calls, "provisional_reload_calls"), heavyProven: bool(r.heavy_proven, "heavy_proven"), pendingEvents: int(r.pending_events, "pending_events"),
  };
}

export interface OwnerInputLookup { handle: string; phase: "reading" | "hashing" | "complete"; seq: string; purpose: "plan" | "stage"; reloadCalls: number; provisionalReloadCalls: number; heavyProven: boolean; pendingEvents: number }
/** One row per requested owner (1..100), in request order; `journal` is null when none exists. */
export async function lookupOwnerInputs(client: RpcClient, batchId: string, fence: number, owners: readonly Owner[]): Promise<Array<{ journal: OwnerInputLookup | null; oldStaffCount: number }>> {
  if (owners.length < 1 || owners.length > 100) throw new ReportingJobError("a lookup needs 1..100 owners");
  const out = await rows(client, "lookup_reporting_owner_inputs", { ...batchArgs(batchId, fence), p_owners: owners.map(owners2) }, false);
  if (out.length !== owners.length) throw new ReportingJobError(`lookup_reporting_owner_inputs returned ${out.length} rows for ${owners.length} owners`);
  return out.map((r, i) => {
    if (r.idx !== i) throw new ReportingJobError("lookup_reporting_owner_inputs is not in request order");
    const journal: OwnerInputLookup | null = r.handle === null ? null : {
      handle: parseHandle(r.handle), phase: phaseOf(r.phase), seq: parseSeq(r.seq), purpose: purposeOf(r.purpose), reloadCalls: int(r.reload_calls, "reload_calls"),
      provisionalReloadCalls: int(r.provisional_reload_calls, "provisional_reload_calls"), heavyProven: bool(r.heavy_proven, "heavy_proven"), pendingEvents: int(r.pending_events, "pending_events"),
    };
    return { journal, oldStaffCount: int(r.old_staff_count, "old_staff_count") };
  });
}

/** One page (<= `limit`) of an owner's saved old staff, ascending; an empty page is the end. */
export async function readOwnerOldStaff(client: RpcClient, batchId: string, fence: number, owner: Owner, after: string | null, limit = MAX_ROWS): Promise<string[]> {
  if (after !== null && !UUID.test(after)) throw new ReportingJobError("old-staff cursor must be a uuid");
  const out = await rows(client, "read_reporting_owner_old_staff", { ...batchArgs(batchId, fence), p_kind: owner.partitionKind, p_key: owner.partitionKey, p_after: after, p_limit: limit }, false);
  let prev = after;
  return out.map((r) => {
    const s = str(r.staff, "staff");
    if (!UUID.test(s)) throw new ReportingJobError("old staff must be a uuid");
    if (prev !== null && s <= prev) throw new ReportingJobError("read_reporting_owner_old_staff is not ascending");
    prev = s;
    return s;
  });
}

export interface OwnerInputHeader {
  phase: "reading" | "hashing" | "complete"; purpose: "plan" | "stage"; seq: string; state: unknown; membersCount: number | null; eventCount: number;
  pendingEvents: number; pendingPieces: number; audiences: unknown; hashesDone: number; inputHashes: unknown; reloadCalls: number; provisionalReloadCalls: number; heavyProven: boolean;
}
export async function loadOwnerInputHeader(client: RpcClient, batchId: string, fence: number, handle: string): Promise<OwnerInputHeader> {
  const [r] = await rows(client, "load_reporting_owner_input_header", { ...batchArgs(batchId, fence), p_handle: parseHandle(handle) }, true);
  return {
    phase: phaseOf(r.phase), purpose: purposeOf(r.purpose), seq: parseSeq(r.seq), state: r.state, membersCount: nint(r.members_count, "members_count"), eventCount: int(r.event_count, "event_count"),
    pendingEvents: int(r.pending_events, "pending_events"), pendingPieces: int(r.pending_pieces, "pending_pieces"), audiences: r.audiences ?? null, hashesDone: int(r.hashes_done, "hashes_done"),
    inputHashes: r.input_hashes, reloadCalls: int(r.reload_calls, "reload_calls"), provisionalReloadCalls: int(r.provisional_reload_calls, "provisional_reload_calls"), heavyProven: bool(r.heavy_proven, "heavy_proven"),
  };
}

export interface CheckpointResult { seq: string; eventCount: number; pendingEvents: number; pendingPieces: number; reloadCalls: number; provisionalReloadCalls: number; heavy: boolean; replay: boolean }
export type OwnerInputPayload =
  | { kind: "pieces"; pieces: PieceEntry[] }
  | { kind: "page"; pieces: PieceEntry[]; steps: unknown[]; members_count?: number }
  | { kind: "discard_pending" }
  | { kind: "hash"; audiences?: unknown[]; hashes: unknown[] };
/** One fenced checkpoint; an identical retry of a lost response returns `replay: true` with the same result. */
export async function checkpointOwnerInput(client: RpcClient, batchId: string, fence: number, handle: string, expectedSeq: string, payload: OwnerInputPayload): Promise<CheckpointResult> {
  const [r] = await rows(client, "checkpoint_reporting_owner_input", { ...batchArgs(batchId, fence), p_handle: parseHandle(handle), p_expected_seq: parseSeq(expectedSeq, "expected seq"), p_payload: payload }, true);
  const out: CheckpointResult = {
    seq: parseSeq(r.seq), eventCount: int(r.event_count, "event_count"), pendingEvents: int(r.pending_events, "pending_events"), pendingPieces: int(r.pending_pieces, "pending_pieces"),
    reloadCalls: int(r.reload_calls, "reload_calls"), provisionalReloadCalls: int(r.provisional_reload_calls, "provisional_reload_calls"), heavy: bool(r.heavy, "heavy"), replay: bool(r.replay, "replay"),
  };
  if (out.seq !== nextSeq(expectedSeq)) throw new ReportingJobError(`checkpoint_reporting_owner_input moved seq ${expectedSeq} to ${out.seq}, expected ${nextSeq(expectedSeq)}`);
  return out;
}

/**
 * One durable page: the consumed events' entries plus the step states. Sent inline in ONE `page` call when the body
 * fits; otherwise as `pieces` calls (pending) and then one `page` call with no pieces. Each call moves seq by one.
 * `heavy` stops the page at the call that proved it (its pieces stay as evidence; r5 §3).
 */
export async function writeOwnerPage(
  client: RpcClient, batchId: string, fence: number, handle: string, seq: string,
  entries: readonly PieceEntry[], steps: readonly unknown[], membersCount?: number,
): Promise<{ result: CheckpointResult; calls: number }> {
  if (!steps.length) throw new ReportingJobError("a page needs at least one step");
  const tail: Record<string, unknown> = { kind: "page", pieces: [], steps, ...(membersCount === undefined ? {} : { members_count: membersCount }) };
  const fixed = utf8(JSON.stringify(tail));
  const page = (pieces: PieceEntry[]): OwnerInputPayload => ({ kind: "page", pieces, steps: [...steps], ...(membersCount === undefined ? {} : { members_count: membersCount }) });
  const inline = packEntries(entries, fixed);
  if (inline.length <= 1) return { result: await checkpointOwnerInput(client, batchId, fence, handle, seq, page(inline[0] ?? [])), calls: 1 };
  let s = seq;
  let calls = 0;
  for (const g of packEntries(entries, utf8(JSON.stringify({ kind: "pieces", pieces: [] })))) {
    const r = await checkpointOwnerInput(client, batchId, fence, handle, s, { kind: "pieces", pieces: g });
    calls++;
    s = r.seq;
    if (r.heavy) return { result: r, calls };
  }
  return { result: await checkpointOwnerInput(client, batchId, fence, handle, s, page([])), calls: calls + 1 };
}

export interface JournalEvent { ord: number; ev: ProductionEvidenceEvent }
/** The loader's row shape (r5 §3): metadata only on piece 0; a lone eof row with every other field null. */
const LOAD_FIELDS = ["ord", "piece_no", "pieces", "event_id", "text_bytes", "text_sha256", "piece", "eof"] as const;
const PIECE_ZERO_ONLY = ["pieces", "event_id", "text_bytes", "text_sha256"] as const;
/** Parse ONE reassembled journal text back to the exact evidence event (11 keys, id/location binding). */
export function parseEventText(text: string, site: string, eventId: string): ProductionEvidenceEvent {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new ReportingJobError(`journal event ${JSON.stringify(eventId)} is not JSON`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ReportingJobError("a journal event must be an object");
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== EVENT_TEXT_KEYS.length || EVENT_TEXT_KEYS.some((k, i) => keys[i] !== k)) throw new ReportingJobError(`journal event ${JSON.stringify(eventId)} does not have exactly the 11 keys in order`);
  if (o.id !== eventId || o.location !== site) throw new ReportingJobError(`journal event ${JSON.stringify(eventId)} is not bound to its id and site`);
  const ev = Object.fromEntries(EVENT_TEXT_KEYS.map((k) => [k, o[k]])) as unknown as ProductionEvidenceEvent;
  if (eventText(ev) !== text) throw new ReportingJobError(`journal event ${JSON.stringify(eventId)} is not canonical`);
  return ev;
}

/**
 * Snapshot-pinned reconstruction (r5 §3): the header's `seq` is pinned on every page; pieces must be contiguous
 * `(ord, piece_no)`, piece 0 carries the metadata, the read ends with a lone `eof` row, the event count equals the
 * header's, and the number of calls (header + pages + eof) equals `reload_calls`. Each event is reassembled and
 * verified (bytes, sha-256, canonical 11-key text) before it is returned, in ordinal order.
 */
export async function reloadOwnerInput(client: RpcClient, batchId: string, fence: number, handle: string, site: string): Promise<{ header: OwnerInputHeader; events: JournalEvent[]; calls: number }> {
  const header = await loadOwnerInputHeader(client, batchId, fence, handle);
  let calls = 1;
  const events: JournalEvent[] = [];
  let after: [number, number] = [0, -1];
  let cur: { ord: number; meta: { pieces: number; eventId: string; textBytes: number; sha: string }; parts: string[] } | null = null;
  const finish = () => {
    if (!cur) return;
    if (cur.parts.length !== cur.meta.pieces) throw new ReportingJobError(`journal event ${cur.ord} is missing pieces`);
    const text = cur.parts.join("");
    if (utf8(text) !== cur.meta.textBytes || sha256(text) !== cur.meta.sha) throw new ReportingJobError(`journal event ${cur.ord} does not match its length/digest`);
    events.push({ ord: cur.ord, ev: parseEventText(text, site, cur.meta.eventId) });
    cur = null;
  };
  for (;;) {
    if (calls > 200) throw new ReportingJobError("an owner-input reload exceeded 200 calls");
    const page = await rows(client, "load_reporting_owner_input_events", { ...batchArgs(batchId, fence), p_handle: parseHandle(handle), p_seq: header.seq, p_after_ord: after[0], p_after_piece: after[1] }, false);
    calls++;
    if (page.length === 1 && page[0].eof === true) {
      if (!LOAD_FIELDS.every((k) => k === "eof" || (k in page[0] && page[0][k] === null))) throw new ReportingJobError("the eof row carries data (every other field must be an explicit null)");
      break;
    }
    if (!page.length) throw new ReportingJobError("load_reporting_owner_input_events returned no rows (not even eof)");
    for (const r of page) {
      if (r.eof !== false) throw new ReportingJobError("a misplaced eof row");
      if (!LOAD_FIELDS.every((k) => k in r)) throw new ReportingJobError("a journal row is missing a field");
      const ord = int(r.ord, "ord");
      const no = int(r.piece_no, "piece_no");
      const piece = str(r.piece, "piece");
      if (no === 0) {
        if (ord !== after[0] + 1 || (cur && cur.parts.length !== cur.meta.pieces)) throw new ReportingJobError(`journal pieces are not contiguous at ${ord}/0`);
        finish();
        cur = { ord, meta: { pieces: int(r.pieces, "pieces"), eventId: str(r.event_id, "event_id"), textBytes: int(r.text_bytes, "text_bytes"), sha: str(r.text_sha256, "text_sha256") }, parts: [piece] };
      } else {
        if (!cur || ord !== cur.ord || no !== cur.parts.length) throw new ReportingJobError(`journal pieces are not contiguous at ${ord}/${no}`);
        if (!PIECE_ZERO_ONLY.every((k) => k in r && r[k] === null)) throw new ReportingJobError(`journal piece ${ord}/${no} carries piece-zero metadata (it must be an explicit null)`);
        cur.parts.push(piece);
      }
      after = [ord, no];
    }
  }
  finish();
  if (events.length !== header.eventCount) throw new ReportingJobError(`the journal has ${events.length} committed events, its header says ${header.eventCount}`);
  if (calls !== header.reloadCalls) throw new ReportingJobError(`the reload took ${calls} calls, the header accounted ${header.reloadCalls}`);
  return { header, events, calls };
}

/** Published-journal cleanup for one site (bounded); `more` means call again. */
export async function releaseOwnerInputs(client: RpcClient, site: string, limit = 5000): Promise<{ deleted: number; more: boolean }> {
  const [r] = await rows(client, "release_reporting_owner_inputs", { p_site: site, p_limit: limit }, true);
  return { deleted: int(r.deleted, "deleted"), more: bool(r.more, "more") };
}

/** One page of staged chunk hashes for sealed work ids (decimal text), in (work, chunk) order. */
export async function readStagedChunks(client: RpcClient, batchId: string, fence: number, workIds: readonly string[], after: { work: string; chunk: number } | null, limit = MAX_ROWS): Promise<Array<{ workId: string; chunkNo: number; chunkHash: string }>> {
  if (!workIds.length) throw new ReportingJobError("staged chunks need work ids");
  const out = await rows(client, "read_reporting_staged_chunks", {
    ...batchArgs(batchId, fence), p_work_ids: workIds.map((w) => parseHandle(w, "work id")), p_after_work: after ? parseHandle(after.work, "work id") : null, p_after_chunk: after?.chunk ?? null, p_limit: limit,
  }, false);
  return out.map((r) => ({ workId: parseHandle(r.work_id, "work id"), chunkNo: int(r.chunk_no, "chunk_no"), chunkHash: str(r.chunk_hash, "chunk_hash") }));
}

/** The persisted step state of one owner's durable read (r6 R5); exactly the shapes `oi_check_shape` accepts. */
export type WalkNeed = "*" | "a0_framed" | "framed" | "unframed" | "dispatch";
export interface WalkLineState { ord: number; afterKidOrd: number | null; phase: "kids" | "done"; effective: boolean | null }
export type OwnerStepState =
  | { v: 1; step: "members"; m: { afterOrd: number | null } }
  | { v: 1; step: "parents"; p: { group: number; afterOrd: number | null } }
  | { v: 1; step: "children"; c: { group: number; afterOrd: number | null } }
  | { v: 1; step: "walk"; w: { worker: number; cursorOrd: number | null; stopAt: string | null; need: WalkNeed[]; line: WalkLineState | null } }
  | { v: 1; step: "done" };
const NEEDS: readonly string[] = ["*", "a0_framed", "framed", "unframed", "dispatch"];
const stateInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 999_999_999;
const keysAre = (o: unknown, keys: readonly string[]): o is Record<string, unknown> =>
  !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).sort().join(",") === [...keys].sort().join(",");
const optInt = (v: unknown) => v === null || stateInt(v);

/** Parse a stored state exactly as the server validates it (reject, never repair). */
export function parseOwnerState(v: unknown): OwnerStepState {
  const bad = (what: string): never => {
    throw new ReportingJobError(`owner input state: ${what}`);
  };
  if (!v || typeof v !== "object" || Array.isArray(v) || (v as Record<string, unknown>).v !== 1) return bad("must be an object with v 1");
  const s = v as Record<string, unknown>;
  switch (s.step) {
    case "members":
      if (!keysAre(s, ["v", "step", "m"]) || !keysAre(s.m, ["afterOrd"]) || !optInt(s.m.afterOrd)) return bad("bad members state");
      return { v: 1, step: "members", m: { afterOrd: s.m.afterOrd as number | null } };
    case "parents":
    case "children": {
      const k = s.step === "parents" ? "p" : "c";
      const o = s[k];
      if (!keysAre(s, ["v", "step", k]) || !keysAre(o, ["group", "afterOrd"]) || !stateInt(o.group) || !optInt(o.afterOrd)) return bad(`bad ${s.step} state`);
      const body = { group: o.group as number, afterOrd: o.afterOrd as number | null };
      return s.step === "parents" ? { v: 1, step: "parents", p: body } : { v: 1, step: "children", c: body };
    }
    case "walk": {
      const w = s.w;
      if (!keysAre(s, ["v", "step", "w"]) || !keysAre(w, ["worker", "cursorOrd", "stopAt", "need", "line"]) || !stateInt(w.worker) || !optInt(w.cursorOrd)) return bad("bad walk state");
      if (!(w.stopAt === null || (typeof w.stopAt === "string" && /^-?[0-9]{1,20}$/.test(w.stopAt)))) return bad("bad walk stopAt");
      if (!Array.isArray(w.need) || w.need.some((x) => typeof x !== "string" || !NEEDS.includes(x))) return bad("bad walk need");
      let line: WalkLineState | null = null;
      if (w.line !== null) {
        const l = w.line;
        if (!keysAre(l, ["ord", "afterKidOrd", "phase", "effective"]) || !stateInt(l.ord) || !optInt(l.afterKidOrd)) return bad("bad pending line");
        if (!((l.phase === "kids" && l.effective === null) || (l.phase === "done" && typeof l.effective === "boolean"))) return bad("bad pending line phase");
        line = { ord: l.ord as number, afterKidOrd: l.afterKidOrd as number | null, phase: l.phase, effective: l.effective as boolean | null };
      }
      return { v: 1, step: "walk", w: { worker: w.worker as number, cursorOrd: w.cursorOrd as number | null, stopAt: w.stopAt as string | null, need: [...(w.need as WalkNeed[])], line } };
    }
    case "done":
      if (!keysAre(s, ["v", "step"])) return bad("bad done state");
      return { v: 1, step: "done" };
    default:
      return bad(`unknown step ${JSON.stringify(String(s.step)).slice(0, 30)}`);
  }
}

/**
 * T15P-4d part 1: the 0046 journal behind a durable owner read. Each commit is one durable page
 * (`writeOwnerPage`), with the adapter-authoritative stream flag against the batch's frozen cutoff.
 * A `heavy` result stops the owner visibly (`owner_input_too_heavy`, its evidence retained).
 */
export function ownerJournal(client: RpcClient, batchId: string, fence: number, handle: string, seq: string, cutoffUs: bigint): OwnerJournal & { seq: string; calls: number } {
  const j = {
    seq: parseSeq(seq),
    calls: 0,
    async commit(p: { events: ProductionEvidenceEvent[]; firstOrd: number; steps: OwnerStepState[]; membersCount?: number }) {
      const entries = eventEntries(p.events, p.firstOrd, (e) => isStreamCandidate(e, cutoffUs));
      const w = await writeOwnerPage(client, batchId, fence, handle, j.seq, entries, p.steps, p.membersCount);
      j.calls += w.calls;
      j.seq = w.result.seq;
      if (w.result.heavy) throw new ReportingJobError(`owner input ${handle} is too heavy to reload (${w.result.provisionalReloadCalls} calls)`, "owner_input_too_heavy");
    },
  };
  return j;
}
/** The resumable snapshot of a reloaded journal (the stored state parsed exactly as the server validates it). */
export function ownerJournalSnapshot(r: { header: OwnerInputHeader; events: JournalEvent[] }): OwnerJournalSnapshot {
  if (r.header.phase !== "reading") throw new ReportingJobError(`owner input is ${r.header.phase}, not reading`);
  if (r.header.pendingEvents !== 0) throw new ReportingJobError("owner input has pending events: discard them before resuming");
  r.events.forEach((e, i) => {
    if (e.ord !== i + 1) throw new ReportingJobError("journal ordinals are not contiguous");
  });
  return { state: parseOwnerState(r.header.state), events: r.events.map((e) => e.ev), membersCount: r.header.membersCount };
}

/** One audience's input hash as the journal's `hash` checkpoint carries it (r5 hashing; site first, then self bytewise). */
export interface OwnerHashEntry { audienceKind: "site" | "self"; audienceStaff: string | null; inputHash: string }
/**
 * Finish a read journal: the first call carries the exact audience list (the server recomputes and requires it),
 * then the hashes go in order, at most 100 per call, each call moving seq by one. Returns the final result
 * (phase `complete` once every audience is hashed). A complete journal accepts only an identical replay.
 */
export async function hashOwnerInput(client: RpcClient, batchId: string, fence: number, handle: string, seq: string, hashes: readonly OwnerHashEntry[]): Promise<{ result: CheckpointResult; calls: number }> {
  if (!hashes.length || hashes[0].audienceKind !== "site" || hashes[0].audienceStaff !== null) throw new ReportingJobError("the first audience is the site");
  for (const h of hashes) if (!/^[0-9a-f]{64}$/.test(h.inputHash)) throw new ReportingJobError("an input hash must be 64 lowercase hex");
  const audiences = hashes.map((h) => ({ audienceKind: h.audienceKind, audienceStaff: h.audienceStaff }));
  let s = parseSeq(seq);
  let result: CheckpointResult | null = null;
  let calls = 0;
  for (let i = 0; i < hashes.length; i += 100) {
    const part = hashes.slice(i, i + 100).map((h) => ({ audienceKind: h.audienceKind, audienceStaff: h.audienceStaff, inputHash: h.inputHash }));
    result = await checkpointOwnerInput(client, batchId, fence, handle, s, i === 0 ? { kind: "hash", audiences, hashes: part } : { kind: "hash", hashes: part });
    calls++;
    s = result.seq;
  }
  return { result: result!, calls };
}
