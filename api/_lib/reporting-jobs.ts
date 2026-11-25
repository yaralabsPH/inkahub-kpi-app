/**
 * Reporting jobs: trusted-server access to the service-only job RPCs
 * (item-counting amendment, Task 13, Part A) and the pure per-site receipt
 * rules they implement.
 *
 * SERVER ONLY. Callers pass a Supabase client created with the service-role
 * key inside api/ (never a browser client, never a user JWT). Nothing here
 * returns or logs credentials or source payloads.
 */

export const REPORTING_SITES = ["au", "uk", "us"] as const;
export type ReportingSite = (typeof REPORTING_SITES)[number];

export function isReportingSite(v: unknown): v is ReportingSite {
  return typeof v === "string" && (REPORTING_SITES as readonly string[]).includes(v);
}

/** The minimal RPC surface used here (supabase-js compatible). */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
}

export class ReportingJobError extends Error {
  constructor(
    message: string,
    public readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ReportingJobError";
  }
}

async function callRows(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new ReportingJobError(`${fn} failed: ${error.message}`, error.code ?? null);
  if (!Array.isArray(data) || data.length !== 1 || typeof data[0] !== "object" || data[0] === null) {
    throw new ReportingJobError(`${fn} returned an unexpected shape`);
  }
  return data as Array<Record<string, unknown>>;
}

const num = (v: unknown, what: string): number => {
  const n = typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new ReportingJobError(`${what} is not an exact integer`);
  return n;
};
const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v) throw new ReportingJobError(`${what} is missing`);
  return v;
};
const strOrNull = (v: unknown, what: string): string | null => (v === null || v === undefined ? null : str(v, what));
const bool = (v: unknown, what: string): boolean => {
  if (typeof v !== "boolean") throw new ReportingJobError(`${what} is not a boolean`);
  return v;
};

// ---------------------------------------------------------------------------
// RPC wrappers
// ---------------------------------------------------------------------------

export interface CaptureState {
  captureEpoch: number;
  captureEnabled: boolean;
}

/** Global (all-site) capture transition; any change advances the epoch. */
export async function setReportingCapture(client: RpcClient, enabled: boolean): Promise<CaptureState> {
  if (typeof enabled !== "boolean") throw new ReportingJobError("enabled must be a boolean");
  const [r] = await callRows(client, "set_reporting_capture", { p_enabled: enabled });
  return { captureEpoch: num(r.capture_epoch, "capture_epoch"), captureEnabled: bool(r.capture_enabled, "capture_enabled") };
}

export interface FrozenBatch {
  batchId: string;
  leaseFence: number;
  baseGenerationId: string | null;
  captureEpoch: number;
  ruleVersion: string;
  sourceCutoffUtc: string | null;
  state: string;
  changeCount: number;
  eventCount: number;
  /** True when an already-active batch was returned (no new fence, no new freeze). */
  reused: boolean;
}

export async function beginReportingBatch(client: RpcClient, site: ReportingSite): Promise<FrozenBatch> {
  if (!isReportingSite(site)) throw new ReportingJobError(`unsupported site ${String(site)}`);
  const [r] = await callRows(client, "begin_reporting_batch", { p_site: site });
  return {
    batchId: str(r.batch_id, "batch_id"),
    leaseFence: num(r.lease_fence, "lease_fence"),
    baseGenerationId: strOrNull(r.base_generation_id, "base_generation_id"),
    captureEpoch: num(r.capture_epoch, "capture_epoch"),
    ruleVersion: str(r.rule_version, "rule_version"),
    sourceCutoffUtc: strOrNull(r.source_cutoff, "source_cutoff"),
    state: str(r.state, "state"),
    changeCount: num(r.change_count, "change_count"),
    eventCount: num(r.event_count, "event_count"),
    reused: bool(r.reused, "reused"),
  };
}

export interface ReportingJobStatus {
  site: ReportingSite;
  processorEnabled: boolean;
  readMode: "legacy" | "shadow" | "summary";
  captureEnabled: boolean;
  captureEpoch: number;
  sourceEpoch: number | null;
  activeGenerationId: string | null;
  activeBatchId: string | null;
  activeBatchState: string | null;
  /** Lets orchestration route recovery (refresh vs rebuild) explicitly. */
  activeBatchKind: "refresh" | "rebuild" | null;
  leaseFence: number;
  leaseExpiresAtUtc: string | null;
  heartbeatAtUtc: string | null;
  lastVerifiedCutoffUtc: string | null;
  pendingChanges: number;
  oldestPendingCapturedAtUtc: string | null;
}

export async function getReportingJobStatus(client: RpcClient, site: ReportingSite): Promise<ReportingJobStatus> {
  if (!isReportingSite(site)) throw new ReportingJobError(`unsupported site ${String(site)}`);
  const [r] = await callRows(client, "get_reporting_job_status", { p_site: site });
  const mode = str(r.read_mode, "read_mode");
  if (mode !== "legacy" && mode !== "shadow" && mode !== "summary") throw new ReportingJobError(`unknown read mode ${mode}`);
  if (r.site !== site) throw new ReportingJobError("status returned for another site");
  return {
    site,
    processorEnabled: bool(r.processor_enabled, "processor_enabled"),
    readMode: mode,
    captureEnabled: bool(r.capture_enabled, "capture_enabled"),
    captureEpoch: num(r.capture_epoch, "capture_epoch"),
    sourceEpoch: r.source_epoch === null ? null : num(r.source_epoch, "source_epoch"),
    activeGenerationId: strOrNull(r.active_generation_id, "active_generation_id"),
    activeBatchId: strOrNull(r.active_batch_id, "active_batch_id"),
    activeBatchState: strOrNull(r.active_batch_state, "active_batch_state"),
    activeBatchKind: (() => {
      const k = strOrNull(r.active_batch_kind, "active_batch_kind");
      if (k !== null && k !== "refresh" && k !== "rebuild") throw new ReportingJobError(`unknown batch kind ${k}`);
      if ((k === null) !== (r.active_batch_id === null)) throw new ReportingJobError("active batch kind and id disagree");
      return k as BatchKind | null;
    })(),
    leaseFence: num(r.lease_fence, "lease_fence"),
    leaseExpiresAtUtc: strOrNull(r.lease_expires_at, "lease_expires_at"),
    heartbeatAtUtc: strOrNull(r.heartbeat_at, "heartbeat_at"),
    lastVerifiedCutoffUtc: strOrNull(r.last_verified_cutoff, "last_verified_cutoff"),
    pendingChanges: num(r.pending_changes, "pending_changes"),
    oldestPendingCapturedAtUtc: strOrNull(r.oldest_pending_captured_at, "oldest_pending_captured_at"),
  };
}

// ---------------------------------------------------------------------------
// Per-site receipts (pure reference of the SQL rules in 0038)
// ---------------------------------------------------------------------------

export interface JournalRow {
  changeId: number;
  oldSite: string | null;
  newSite: string | null;
  acknowledged: boolean;
}
export interface BatchRow {
  batchId: string;
  site: string;
  state: "active" | "frozen" | "publishing" | "published" | "failed" | "abandoned";
  /** Exact membership (batch_changes). */
  changeIds: readonly number[];
}

/** Distinct supported sites a change touches. */
export function supportedSites(c: Pick<JournalRow, "oldSite" | "newSite">): ReportingSite[] {
  return [...new Set([c.oldSite, c.newSite])].filter(isReportingSite).sort() as ReportingSite[];
}

function hasPublishedReceipt(changeId: number, site: string, batches: readonly BatchRow[]): boolean {
  return batches.some((b) => b.site === site && b.state === "published" && b.changeIds.includes(changeId));
}

/** site_pending_changes(site): unacknowledged, touches the site, no published receipt of THIS site. */
export function pendingForSite(site: ReportingSite, journal: readonly JournalRow[], batches: readonly BatchRow[]): number[] {
  return journal
    .filter((c) => !c.acknowledged && supportedSites(c).includes(site) && !hasPublishedReceipt(c.changeId, site, batches))
    .map((c) => c.changeId)
    .sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Part B1: candidate rebuild, lease renewal/takeover/abandon
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function batchArg(batchId: unknown): string {
  if (typeof batchId !== "string" || !UUID.test(batchId)) throw new ReportingJobError("batchId must be a uuid");
  return batchId;
}
function fenceArg(fence: unknown): number {
  if (typeof fence !== "number" || !Number.isSafeInteger(fence) || fence < 1) throw new ReportingJobError("fence must be a positive safe integer");
  return fence;
}

export interface RebuildBatch {
  batchId: string;
  leaseFence: number;
  baseGenerationId: string | null;
  captureEpoch: number;
  ruleVersion: string;
  state: string;
  leaseExpiresAtUtc: string;
}

export async function beginReportingRebuild(client: RpcClient, site: ReportingSite): Promise<RebuildBatch> {
  if (!isReportingSite(site)) throw new ReportingJobError(`unsupported site ${String(site)}`);
  const [r] = await callRows(client, "begin_reporting_rebuild", { p_site: site });
  return {
    batchId: str(r.batch_id, "batch_id"),
    leaseFence: num(r.lease_fence, "lease_fence"),
    baseGenerationId: strOrNull(r.base_generation_id, "base_generation_id"),
    captureEpoch: num(r.capture_epoch, "capture_epoch"),
    ruleVersion: str(r.rule_version, "rule_version"),
    state: str(r.state, "state"),
    leaseExpiresAtUtc: str(r.lease_expires_at, "lease_expires_at"),
  };
}

export interface CopiedPage {
  rowsCopied: number;
  bytesCopied: number;
  afterEventId: string | null;
  /** Pass this as the next request's cursor. */
  nextAfterEventId: string | null;
  pageChecksum: string;
  complete: boolean;
  pages: number;
  totalRows: number;
  /** True when this was an identical replay of the last saved request (nothing copied). */
  replay: boolean;
}

/** The database reads and writes the page itself; callers pass only the cursor. */
export async function copyReportingSourcePage(client: RpcClient, batchId: string, fence: number, afterEventId: string | null): Promise<CopiedPage> {
  if (afterEventId !== null && (typeof afterEventId !== "string" || afterEventId === "")) throw new ReportingJobError("afterEventId must be null or a non-empty string");
  const [r] = await callRows(client, "copy_reporting_source_page", { p_batch: batchArg(batchId), p_fence: fenceArg(fence), p_after_event_id: afterEventId });
  const checksum = str(r.page_checksum, "page_checksum");
  if (!/^[0-9a-f]{64}$/.test(checksum)) throw new ReportingJobError("page_checksum is not a SHA-256 hex digest");
  return {
    rowsCopied: num(r.rows_copied, "rows_copied"),
    bytesCopied: num(r.bytes_copied, "bytes_copied"),
    afterEventId: strOrNull(r.after_event_id, "after_event_id"),
    nextAfterEventId: strOrNull(r.next_after_event_id, "next_after_event_id"),
    pageChecksum: checksum,
    complete: bool(r.complete, "complete"),
    pages: num(r.pages, "pages"),
    totalRows: num(r.total_rows, "total_rows"),
    replay: bool(r.replay, "replay"),
  };
}

export interface FrozenRebuild {
  batchId: string;
  sourceCutoffUtc: string;
  changeCount: number;
  eventCount: number;
  upserted: number;
  deleted: number;
  candidateRows: number;
}

export async function freezeReportingRebuild(client: RpcClient, batchId: string, fence: number): Promise<FrozenRebuild> {
  const [r] = await callRows(client, "freeze_reporting_rebuild", { p_batch: batchArg(batchId), p_fence: fenceArg(fence) });
  return {
    batchId: str(r.batch_id, "batch_id"),
    sourceCutoffUtc: str(r.source_cutoff, "source_cutoff"),
    changeCount: num(r.change_count, "change_count"),
    eventCount: num(r.event_count, "event_count"),
    upserted: num(r.upserted, "upserted"),
    deleted: num(r.deleted, "deleted"),
    candidateRows: num(r.candidate_rows, "candidate_rows"),
  };
}

export interface LeaseState {
  batchId: string;
  leaseFence: number;
  leaseExpiresAtUtc: string;
}

/** 30-second heartbeat: extends the current lease; the fence never changes here. */
export async function renewReportingLease(client: RpcClient, batchId: string, fence: number): Promise<LeaseState> {
  const [r] = await callRows(client, "renew_reporting_lease", { p_batch: batchArg(batchId), p_fence: fenceArg(fence) });
  const out = { batchId: str(r.batch_id, "batch_id"), leaseFence: num(r.lease_fence, "lease_fence"), leaseExpiresAtUtc: str(r.lease_expires_at, "lease_expires_at") };
  if (out.leaseFence !== fence) throw new ReportingJobError("lease renewal changed the fence");
  return out;
}

/** Saved candidate-copy progress of a rebuild (bounded metadata; never source rows). */
export interface RebuildProgress {
  /** The next copy request's cursor (null = from the start). */
  afterEventId: string | null;
  complete: boolean;
  pages: number;
  rows: number;
  bytes: number;
}

export type BatchKind = "refresh" | "rebuild";
const BATCH_STATES = ["active", "frozen", "publishing"] as const;

export interface ResumedBatch extends LeaseState {
  state: (typeof BATCH_STATES)[number];
  returnedWork: number;
  kind: BatchKind;
  baseGenerationId: string | null;
  ruleVersion: string;
  captureEpoch: number;
  sourceCutoffUtc: string | null;
  /** Rebuilds only (null for a refresh). */
  rebuildProgress: RebuildProgress | null;
}

const PROGRESS_KEYS = ["afterEventId", "bytes", "complete", "pages", "rows"];

/** Strict: exact keys, exact types, internally consistent; anything else is refused. */
export function parseRebuildProgress(v: unknown): RebuildProgress {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ReportingJobError("rebuild_progress is not an object");
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== PROGRESS_KEYS.join(",")) throw new ReportingJobError("rebuild_progress has unexpected keys");
  const after = o.afterEventId;
  if (after !== null && (typeof after !== "string" || after === "")) throw new ReportingJobError("rebuild_progress.afterEventId must be null or a non-empty string");
  const p: RebuildProgress = {
    afterEventId: after as string | null,
    complete: bool(o.complete, "rebuild_progress.complete"),
    pages: num(o.pages, "rebuild_progress.pages"),
    rows: num(o.rows, "rebuild_progress.rows"),
    bytes: num(o.bytes, "rebuild_progress.bytes"),
  };
  if (p.pages < 0 || p.rows < 0 || p.bytes < 0) throw new ReportingJobError("rebuild_progress counts must be non-negative");
  if (p.pages === 0 && (p.afterEventId !== null || p.rows !== 0 || p.bytes !== 0 || p.complete)) throw new ReportingJobError("rebuild_progress is inconsistent: no pages copied");
  if (p.rows > 0 && p.afterEventId === null) throw new ReportingJobError("rebuild_progress is inconsistent: rows copied without a cursor");
  return p;
}

/** Expired-lease takeover of the SAME batch under a new, larger fence, with everything needed to continue. */
export async function resumeReportingBatch(client: RpcClient, batchId: string, expectedFence: number): Promise<ResumedBatch> {
  const id = batchArg(batchId);
  const [r] = await callRows(client, "resume_reporting_batch", { p_batch: id, p_expected_fence: fenceArg(expectedFence) });
  const state = str(r.state, "state");
  if (!(BATCH_STATES as readonly string[]).includes(state)) throw new ReportingJobError(`resumed batch is ${state}`);
  const kind = str(r.kind, "kind");
  if (kind !== "refresh" && kind !== "rebuild") throw new ReportingJobError(`unknown batch kind ${kind}`);
  const out: ResumedBatch = {
    batchId: str(r.batch_id, "batch_id"),
    leaseFence: num(r.lease_fence, "lease_fence"),
    leaseExpiresAtUtc: str(r.lease_expires_at, "lease_expires_at"),
    state: state as ResumedBatch["state"],
    returnedWork: num(r.returned_work, "returned_work"),
    kind,
    baseGenerationId: strOrNull(r.base_generation_id, "base_generation_id"),
    ruleVersion: str(r.rule_version, "rule_version"),
    captureEpoch: num(r.capture_epoch, "capture_epoch"),
    sourceCutoffUtc: strOrNull(r.source_cutoff, "source_cutoff"),
    rebuildProgress: kind === "rebuild" ? parseRebuildProgress(r.rebuild_progress) : null,
  };
  if (out.batchId !== id) throw new ReportingJobError("takeover returned another batch");
  if (out.leaseFence <= expectedFence) throw new ReportingJobError("takeover did not advance the fence");
  if (kind === "refresh" && r.rebuild_progress !== null && r.rebuild_progress !== undefined) throw new ReportingJobError("a refresh has no rebuild progress");
  if (kind === "rebuild" && out.state === "active" && out.sourceCutoffUtc !== null) throw new ReportingJobError("an active rebuild has no cutoff yet");
  return out;
}

/**
 * Recover a rebuild after losing all process state: take over the expired
 * lease, then continue copying from the RETURNED cursor (never from the
 * start), or report that the copy was already complete and freeze is next.
 * Needs only the batch id and fence from get_reporting_job_status; no
 * private-table access.
 */
export async function recoverRebuildCopy(
  client: RpcClient,
  batchId: string,
  expectedFence: number,
  maxPages: number,
): Promise<{ resumed: ResumedBatch; pagesCopied: number; progress: RebuildProgress; next: "copy" | "freeze" }> {
  if (!Number.isSafeInteger(maxPages) || maxPages < 0) throw new ReportingJobError("maxPages must be a non-negative integer");
  const resumed = await resumeReportingBatch(client, batchId, expectedFence);
  if (resumed.kind !== "rebuild" || !resumed.rebuildProgress) throw new ReportingJobError(`batch ${batchId} is a ${resumed.kind}, not a rebuild`);
  if (resumed.state !== "active") throw new ReportingJobError(`rebuild ${batchId} is already ${resumed.state}`);
  let progress = resumed.rebuildProgress;
  let pagesCopied = 0;
  while (!progress.complete && pagesCopied < maxPages) {
    const page = await copyReportingSourcePage(client, batchId, resumed.leaseFence, progress.afterEventId);
    pagesCopied++;
    progress = { afterEventId: page.nextAfterEventId, complete: page.complete, pages: page.pages, rows: page.totalRows, bytes: progress.bytes + page.bytesCopied };
  }
  return { resumed, pagesCopied, progress, next: progress.complete ? "freeze" : "copy" };
}

/** Explicit recovery only (Task 15's protected action): evidence and pending journal are kept. */
export async function abandonReportingBatch(client: RpcClient, batchId: string, fence: number, reason: string): Promise<{ batchId: string; state: string; failureKind: string }> {
  if (typeof reason !== "string" || !reason.trim() || reason.length > 180) throw new ReportingJobError("reason must be 1..180 characters");
  const [r] = await callRows(client, "abandon_reporting_batch", { p_batch: batchArg(batchId), p_fence: fenceArg(fence), p_reason: reason });
  return { batchId: str(r.batch_id, "batch_id"), state: str(r.state, "state"), failureKind: str(r.failure_kind, "failure_kind") };
}

// Pure references of the B1 SQL rules (they state the staging expectations).

export const COPY_PAGE_ROWS = 1000;
export const COPY_PAGE_BYTES = 1024 * 1024;

/**
 * copy_reporting_source_page's selection over rows already ordered by event id
 * and filtered to id > after: at most 1,000 rows, a running byte total of at
 * most 1 MiB (a byte-capped page ends at its actual last row), complete only
 * after a true end-of-source read, and a single oversized first row fails.
 */
export function selectSourcePage(rows: ReadonlyArray<{ id: string; bytes: number }>, maxRows = COPY_PAGE_ROWS, maxBytes = COPY_PAGE_BYTES): { kept: string[]; bytes: number; complete: boolean } {
  const fetched = rows.slice(0, maxRows);
  const kept: string[] = [];
  let run = 0;
  for (const r of fetched) {
    if (run + r.bytes > maxBytes) break;
    run += r.bytes;
    kept.push(r.id);
  }
  if (fetched.length > 0 && kept.length === 0) throw new ReportingJobError(`source row ${fetched[0].id} is ${fetched[0].bytes} bytes, over the page limit`);
  return { kept, bytes: run, complete: fetched.length < maxRows && kept.length === fetched.length };
}

export interface CopyCursor {
  after: string | null;
  complete: boolean;
  last?: { after: string | null };
}

/**
 * next = copy the next page; replay = return the saved response; otherwise
 * refuse. A final EMPTY page leaves the cursor unchanged, so its retry is a
 * replay because the copy is complete.
 */
export function copyCursorDecision(cursor: CopyCursor, requestedAfter: string | null): "next" | "replay" | "complete" | "mismatch" {
  if (cursor.last && cursor.last.after === requestedAfter && (cursor.after !== requestedAfter || cursor.complete)) return "replay";
  if (cursor.complete) return "complete";
  return cursor.after === requestedAfter ? "next" : "mismatch";
}

export interface DriftInput {
  batch: { kind: "refresh" | "rebuild"; captureEpoch: number; ruleVersion: string; baseGenerationId: string | null; site: string; batchId: string };
  control: { captureEpoch: number; ruleVersion: string; captureEnabled: boolean };
  site: { activeBatchId: string | null; activeGenerationId: string | null };
  base: { site: string; state: string; complete: boolean; ruleVersion: string; captureEpoch: number } | null;
}

/** batch_drift(): why a batch may no longer be used (null = valid). */
export function batchDrift(i: DriftInput): string | null {
  const { batch: b, control: c, site: s, base: g } = i;
  if (!c.captureEnabled) return "capture is disabled";
  if (b.captureEpoch !== c.captureEpoch) return "capture epoch changed";
  if (b.ruleVersion !== c.ruleVersion) return "rule version changed";
  if (s.activeBatchId !== b.batchId) return "not the site's active batch";
  if (b.baseGenerationId !== s.activeGenerationId) return "published base changed";
  if (b.baseGenerationId !== null) {
    if (!g || g.site !== b.site || g.state !== "published" || !g.complete) return "base is not a complete published generation of this site";
    if (b.kind === "refresh" && (g.ruleVersion !== c.ruleVersion || g.captureEpoch !== c.captureEpoch)) return "refresh base is not at the current rule and capture epoch";
  } else if (b.kind === "refresh") {
    return "refresh has no published base";
  }
  return null;
}

/** acknowledge_received_changes(site): ids that become globally acknowledged now (every supported side has a receipt). */
export function acknowledgeable(site: ReportingSite, journal: readonly JournalRow[], batches: readonly BatchRow[]): number[] {
  return journal
    .filter((c) => !c.acknowledged && supportedSites(c).includes(site) && supportedSites(c).every((s) => hasPublishedReceipt(c.changeId, s, batches)))
    .map((c) => c.changeId)
    .sort((a, b) => a - b);
}
