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

/** acknowledge_received_changes(site): ids that become globally acknowledged now (every supported side has a receipt). */
export function acknowledgeable(site: ReportingSite, journal: readonly JournalRow[], batches: readonly BatchRow[]): number[] {
  return journal
    .filter((c) => !c.acknowledged && supportedSites(c).includes(site) && supportedSites(c).every((s) => hasPublishedReceipt(c.changeId, s, batches)))
    .map((c) => c.changeId)
    .sort((a, b) => a - b);
}
