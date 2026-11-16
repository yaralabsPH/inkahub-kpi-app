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
import { parseKeyProgress, type KeyCheckpoint, type KeyProgress, type Owner } from "./production-reporting-materialize.js";

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
