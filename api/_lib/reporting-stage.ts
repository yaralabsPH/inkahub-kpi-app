/**
 * Reporting work planning, sealing, claims and result staging (item-counting
 * amendment, Task 13 Part B2a). SERVER ONLY; service-role client from api/.
 *
 * Byte-exact agreement with 0038:
 *   - Manifest: one JSON array line per descriptor
 *     [audienceKind, audienceStaff|null, partitionKind, partitionKey, inputHash],
 *     sorted by kind, staff (null first), partition kind, partition key, each
 *     compared by UTF-8 BYTES (= COLLATE "C"), joined by "\n" (no trailing
 *     newline), SHA-256 hex. JSON.stringify and PostgreSQL to_json escape a
 *     string identically for valid text (\" \\ \b \f \n \r \t, other controls
 *     as lowercase \u00xx, everything else raw).
 *   - Chunk: canonicalRows is the shared canonicalJson text of the five
 *     arrays (event_facts, cancel_edges, order_occurrences, timing_facts,
 *     source_issue_facts); chunkHash is SHA-256 of its UTF-8 bytes (SQL hashes the same
 *     bytes with convert_to(…, 'UTF8')); resultDigest is SHA-256 of the chunk
 *     hashes joined by "\n" in chunk order.
 */
import { canonicalJson, sha256Hex } from "../../src/lib/domain/productionReporting.js";
import { evidenceOrderKey } from "../../src/lib/domain/productionCounts.js";
import { ReportingJobError, type RpcClient } from "./reporting-jobs.js";

export const MAX_PLAN_ITEMS = 1000;
export const MAX_CLAIM = 1000;
export const MAX_ROWS_PER_CHUNK = 1000;
export const MAX_BULK_ENTRIES = 100;
export const MAX_REQUEST_BYTES = 1024 * 1024;
/** jsonb::text adds a space after every ':' and ','; leave room for it. */
const JSONB_TEXT_MARGIN = 64 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const utf8 = (s: string) => new TextEncoder().encode(s).length;
/** A partition key whose escaped JSON exceeds this cannot fit one claim response row (0038 plan/claim). */
export const MAX_CLAIM_KEY_JSON_BYTES = MAX_REQUEST_BYTES - 512;

export interface WorkDescriptor {
  audienceKind: "site" | "self";
  audienceStaff: string | null;
  partitionKind: "order" | "event";
  partitionKey: string;
  /** SHA-256 of the canonical FrozenPartitionInput (Task 14). */
  inputHash: string;
}

/** Same rules as plan_reporting_work, so a bad descriptor never reaches the database. */
export function descriptorProblem(d: unknown): string | null {
  if (typeof d !== "object" || d === null || Array.isArray(d)) return "not an object";
  const o = d as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "audienceKind,audienceStaff,inputHash,partitionKey,partitionKind") return "unexpected keys";
  if (o.audienceKind !== "site" && o.audienceKind !== "self") return "bad audienceKind";
  if (o.audienceStaff !== null && typeof o.audienceStaff !== "string") return "bad audienceStaff";
  if ((o.audienceKind === "site") !== (o.audienceStaff === null)) return "audienceStaff must be null exactly for the site audience";
  if (typeof o.audienceStaff === "string" && !UUID.test(o.audienceStaff)) return "bad audienceStaff";
  if (o.partitionKind !== "order" && o.partitionKind !== "event") return "bad partitionKind";
  if (typeof o.partitionKey !== "string" || o.partitionKey === "") return "bad partitionKey";
  if (o.partitionKind === "order" && evidenceOrderKey(o.partitionKey) !== o.partitionKey) return "order partition key is not a trimmed order key";
  if (utf8(JSON.stringify(o.partitionKey)) > MAX_CLAIM_KEY_JSON_BYTES) return "partitionKey too large for one claim response";
  if (typeof o.inputHash !== "string" || !HEX64.test(o.inputHash)) return "bad inputHash";
  return null;
}

/** Compare by UTF-8 bytes (PostgreSQL COLLATE "C"), not UTF-16 code units. */
export function compareUtf8(a: string, b: string): number {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

export function manifestLine(d: WorkDescriptor): string {
  return JSON.stringify([d.audienceKind, d.audienceStaff, d.partitionKind, d.partitionKey, d.inputHash]);
}

export function sortDescriptors(ds: readonly WorkDescriptor[]): WorkDescriptor[] {
  return [...ds].sort(
    (a, b) =>
      compareUtf8(a.audienceKind, b.audienceKind) ||
      (a.audienceStaff === null ? (b.audienceStaff === null ? 0 : -1) : b.audienceStaff === null ? 1 : compareUtf8(a.audienceStaff, b.audienceStaff)) ||
      compareUtf8(a.partitionKind, b.partitionKind) ||
      compareUtf8(a.partitionKey, b.partitionKey),
  );
}

/** work_manifest(batch).manifest_hash for exactly these descriptors. */
export function reportingManifestHash(ds: readonly WorkDescriptor[]): string {
  return sha256Hex(sortDescriptors(ds).map(manifestLine).join("\n"));
}

// ---------------------------------------------------------------------------
// Staged result chunks
// ---------------------------------------------------------------------------

export const RESULT_TABLES = ["event_facts", "cancel_edges", "order_occurrences", "timing_facts", "source_issue_facts"] as const;
export type ResultTable = (typeof RESULT_TABLES)[number];
export type ResultRows = Record<ResultTable, Array<Record<string, unknown>>>;

// --- generated from the same spec as reporting_private.staged_row_problem (0038) ---
type ColumnKind = "id" | "str" | "uuid" | "ts" | "date" | "int4" | "int53" | "num" | "bool" | "enum";
type ColumnSpec = readonly [column: string, kind: ColumnKind, nullable: boolean, values?: readonly string[]];
const WT = ["a0_framed", "framed", "unframed", "dispatch"] as const;
const ROLE = ["verification", "terminal", "cancellation", "invalid"] as const;
/** Exact columns (and their order of checking) of each staged array. Site, audience, partition, rule and validity are set by the server. */
export const RESULT_COLUMNS: Readonly<Record<ResultTable, readonly ColumnSpec[]>> = {
  event_facts: [
    ["event_id", "id", false],
    ["event_type", "enum", false, ["line_verified", "completed", "dispatched", "cancelled"]],
    ["created_at", "ts", false],
    ["staff_id", "uuid", true],
    ["department", "str", true],
    ["raw_order", "str", true],
    ["order_key", "str", false],
    ["case_id", "str", true],
    ["parent_event_id", "str", true],
    ["sku", "str", true],
    ["quantity", "int4", true],
    ["role", "enum", false, ROLE],
    ["work_type", "enum", true, WT],
    ["invalid_detail", "str", true],
    ["line_key", "str", true],
    ["item_status", "enum", true, ["counted", "excluded", "unclassified"]],
    ["items", "int53", true],
    ["product_kind", "enum", true, ["eligible", "excluded", "unclassified"]],
    ["item_issue_kind", "enum", true, ["unclassified_sku", "invalid_quantity"]],
    ["item_issue_detail", "str", true],
    ["timing_stream", "bool", true],
    ["timing_weight", "num", true],
    ["production_date", "date", true],
  ],
  cancel_edges: [
    ["cancel_event_id", "id", false],
    ["parent_event_id", "id", false],
    ["is_self", "bool", false],
    ["parent_role", "enum", true, ROLE],
    ["parent_created_at", "ts", true],
    ["pair", "enum", true, ["valid", "mismatch", "case_differs"]],
  ],
  order_occurrences: [
    ["terminal_event_id", "id", false],
    ["order_key", "id", false],
    ["raw_order", "str", false],
    ["case_id", "str", true],
    ["work_type", "enum", false, WT],
    ["staff_id", "uuid", false],
    ["occurred_at", "ts", false],
  ],
  timing_facts: [
    ["event_id", "id", false],
    ["staff_id", "uuid", false],
    ["work_type", "enum", false, WT],
    ["occurred_at", "ts", false],
    ["weight", "num", false],
    ["prev_all_event_id", "id", true],
    ["prev_same_type_event_id", "id", true],
  ],
  source_issue_facts: [
    ["event_id", "id", false],
    ["event_type", "id", false],
    ["created_at", "ts", false],
    ["staff_id", "uuid", true],
    ["raw_order", "str", true],
    ["parent_event_id", "str", true],
    ["issue_kind", "enum", false, ["invalid_event", "unclassified_sku", "invalid_quantity", "unresolved_parent", "missing_completion_detail", "ambiguous_repeat"]],
    ["issue_detail", "str", true],
  ],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TS_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$/;
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const KIND_TEXT: Record<Exclude<ColumnKind, "enum">, string> = {
  id: "a non-empty string", str: "a string", uuid: "a lowercase uuid", ts: "an ISO-8601 timestamp", date: "a YYYY-MM-DD date",
  int4: "a 32-bit integer", int53: "a non-negative safe integer", num: "a non-negative number", bool: "a boolean",
};
function valueOk(v: unknown, kind: ColumnKind, values?: readonly string[]): boolean {
  switch (kind) {
    case "id": return typeof v === "string" && v !== "";
    case "str": return typeof v === "string";
    case "uuid": return typeof v === "string" && UUID_RE.test(v);
    case "ts": return typeof v === "string" && TS_RE.test(v);
    case "date": return typeof v === "string" && DATE_RE.test(v);
    case "enum": return typeof v === "string" && (values ?? []).includes(v);
    case "bool": return typeof v === "boolean";
    case "int4": return typeof v === "number" && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
    case "int53": return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
    case "num": return typeof v === "number" && Number.isFinite(v) && v >= 0;
  }
}

/**
 * Structural validity of one staged row — the same required/type/enum/range/
 * relational rules, in the same order and with the same messages, as
 * reporting_private.staged_row_problem (0038). Keys must already be exact.
 * Returns null or the first problem.
 */
export function resultRowProblem(table: ResultTable, row: Record<string, unknown>): string | null {
  for (const [c, kind, nullable, values] of RESULT_COLUMNS[table]) {
    const v = row[c];
    if (nullable && v === null) continue;
    if (!valueOk(v, kind, values)) {
      const what = kind === "enum" ? `one of ${(values ?? []).join(", ")}` : KIND_TEXT[kind];
      return `${table}.${c} must be ${what}${nullable ? " or null" : ""}`;
    }
  }
  const set = (c: string) => row[c] !== null;
  if (table === "event_facts") {
    const verificationFields = ["item_status", "items", "product_kind", "line_key", "timing_stream", "timing_weight"].every(set);
    if ((row.role === "verification") !== verificationFields) return "event_facts: role verification needs exactly item_status, items, product_kind, line_key, timing_stream and timing_weight";
    if ((row.role === "invalid") !== set("invalid_detail")) return "event_facts: invalid_detail is required exactly for role invalid";
  }
  if (table === "cancel_edges") {
    if (set("parent_role") !== set("parent_created_at")) return "cancel_edges: parent_role and parent_created_at are both set or both null";
    if (set("pair") !== (row.parent_role === "verification" || row.parent_role === "terminal")) return "cancel_edges: pair is required exactly for a verification or terminal parent";
  }
  return null;
}

export interface ChunkEnvelope {
  chunkNo: number;
  chunkCount: number;
  chunkHash: string;
  resultDigest: string;
  canonicalRows: string;
}

const emptyRows = (): ResultRows => ({ event_facts: [], cancel_edges: [], order_occurrences: [], timing_facts: [], source_issue_facts: [] });
const envelopeBytes = (canonicalRows: string) => utf8(JSON.stringify({ chunkNo: 0, chunkCount: 1, chunkHash: "0".repeat(64), resultDigest: "0".repeat(64), canonicalRows })) + 32;

/**
 * Split one work's replacement rows into contiguous chunks of at most 1,000
 * rows and 1 MiB (with jsonb formatting margin). An empty replacement is one
 * chunk of five empty arrays. A single row too large for a chunk fails.
 */
export function buildChunks(rows: ResultRows, maxRows = MAX_ROWS_PER_CHUNK, maxBytes = MAX_REQUEST_BYTES - JSONB_TEXT_MARGIN): ChunkEnvelope[] {
  for (const k of Object.keys(rows)) if (!(RESULT_TABLES as readonly string[]).includes(k)) throw new ReportingJobError(`unknown result table ${k}`);
  const chunks: ResultRows[] = [];
  let cur = emptyRows();
  let count = 0;
  const bytesOf = (r: ResultRows) => envelopeBytes(canonicalJson(r));
  for (const t of RESULT_TABLES) {
    for (const row of rows[t] ?? []) {
      const next = { ...cur, [t]: [...cur[t], row] };
      if (count >= maxRows || (count > 0 && bytesOf(next) > maxBytes)) {
        chunks.push(cur);
        cur = { ...emptyRows(), [t]: [row] };
        count = 1;
      } else {
        cur = next;
        count++;
      }
      if (bytesOf(cur) > maxBytes) throw new ReportingJobError(`a single ${t} row exceeds the chunk size limit`);
    }
  }
  chunks.push(cur);
  const texts = chunks.map((c) => canonicalJson(c));
  const hashes = texts.map((t) => sha256Hex(t));
  const resultDigest = sha256Hex(hashes.join("\n"));
  return texts.map((canonicalRows, i) => ({ chunkNo: i, chunkCount: texts.length, chunkHash: hashes[i], resultDigest, canonicalRows }));
}

export interface StageEntry {
  /** Positive decimal work id (string: never a lossy JavaScript number). */
  partition: string;
  chunk: ChunkEnvelope;
}

/** Pack entries into bulk requests of at most 100 entries and 1 MiB each (jsonb margin included). */
export function packStageRequests(entries: readonly StageEntry[], maxEntries = MAX_BULK_ENTRIES, maxBytes = MAX_REQUEST_BYTES - JSONB_TEXT_MARGIN): StageEntry[][] {
  const out: StageEntry[][] = [];
  let cur: StageEntry[] = [];
  let bytes = 2;
  for (const e of entries) {
    const b = utf8(JSON.stringify(e)) + 1;
    if (b + 2 > maxBytes) throw new ReportingJobError(`stage entry for work ${e.partition} chunk ${e.chunk.chunkNo} exceeds the request limit`);
    if (cur.length >= maxEntries || bytes + b > maxBytes) {
      out.push(cur);
      cur = [];
      bytes = 2;
    }
    cur.push(e);
    bytes += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// RPC wrappers
// ---------------------------------------------------------------------------

const UUIDI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORK_ID = /^[1-9][0-9]{0,18}$/;
function batchArg(v: unknown): string {
  if (typeof v !== "string" || !UUIDI.test(v)) throw new ReportingJobError("batchId must be a uuid");
  return v;
}
function fenceArg(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new ReportingJobError("fence must be a positive safe integer");
  return v;
}
async function rows(client: RpcClient, fn: string, args: Record<string, unknown>, exactlyOne: boolean): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new ReportingJobError(`${fn} failed: ${error.message}`, error.code ?? null);
  if (!Array.isArray(data) || (exactlyOne && data.length !== 1) || data.some((r) => typeof r !== "object" || r === null)) throw new ReportingJobError(`${fn} returned an unexpected shape`);
  return data as Array<Record<string, unknown>>;
}
const int = (v: unknown, what: string) => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new ReportingJobError(`${what} is not a non-negative integer`);
  return v;
};

export async function planReportingWork(client: RpcClient, batchId: string, fence: number, items: readonly WorkDescriptor[]): Promise<{ inserted: number; replayed: number; plannedTotal: number }> {
  if (items.length > MAX_PLAN_ITEMS) throw new ReportingJobError(`at most ${MAX_PLAN_ITEMS} descriptors per call`);
  items.forEach((d, i) => {
    const p = descriptorProblem(d);
    if (p) throw new ReportingJobError(`descriptor ${i + 1}: ${p}`);
  });
  if (utf8(JSON.stringify(items)) > MAX_REQUEST_BYTES - JSONB_TEXT_MARGIN) throw new ReportingJobError("plan request over 1 MiB");
  const [r] = await rows(client, "plan_reporting_work", { p_batch: batchArg(batchId), p_fence: fenceArg(fence), p_items: items }, true);
  return { inserted: int(r.inserted, "inserted"), replayed: int(r.replayed, "replayed"), plannedTotal: int(r.planned_total, "planned_total") };
}

/** Seal with the count and manifest computed from EXACTLY the descriptors this worker planned. */
export async function sealReportingWork(client: RpcClient, batchId: string, fence: number, planned: readonly WorkDescriptor[]): Promise<{ workCount: number; manifestHash: string; replay: boolean }> {
  const hash = reportingManifestHash(planned);
  const [r] = await rows(client, "seal_reporting_work", { p_batch: batchArg(batchId), p_fence: fenceArg(fence), p_expected_count: planned.length, p_manifest_hash: hash }, true);
  if (r.manifest_hash !== hash || r.work_count !== planned.length) throw new ReportingJobError("seal returned a different manifest");
  return { workCount: planned.length, manifestHash: hash, replay: r.replay === true };
}

/**
 * The bytes claim_reporting_work charges for one returned row: the text of
 * PostgreSQL json_build_object(...) over the returned columns (JSON-escaped
 * values — JSON.stringify escapes valid text exactly like to_json — quoted
 * keys, " : " and ", " separators) plus 4 bytes of list separator. The
 * response is charged 2 more for its brackets and must stay within 1 MiB.
 */
export function claimRowBytes(w: { workId: string; expectedChunkCount: number | null; stagedChunks: number } & WorkDescriptor): number {
  const pairs: Array<[string, unknown]> = [
    ["work_id", w.workId], ["audience_kind", w.audienceKind], ["audience_staff", w.audienceStaff], ["partition_kind", w.partitionKind],
    ["partition_key", w.partitionKey], ["input_hash", w.inputHash], ["expected_chunk_count", w.expectedChunkCount], ["staged_chunks", w.stagedChunks],
  ];
  return 4 + utf8(`{${pairs.map(([k, v]) => `${JSON.stringify(k)} : ${JSON.stringify(v)}`).join(", ")}}`);
}

/** Exactly what claim_reporting_work leases from `pending` (in work-id order): the longest prefix within 1 MiB. */
export function claimPrefix<T extends Parameters<typeof claimRowBytes>[0]>(pending: readonly T[]): T[] {
  let run = 2;
  const out: T[] = [];
  for (const w of pending) {
    run += claimRowBytes(w);
    if (run > MAX_REQUEST_BYTES) break;
    out.push(w);
  }
  if (pending.length > 0 && out.length === 0) throw new ReportingJobError(`work ${pending[0].workId} does not fit one 1 MiB claim response`);
  return out;
}

export interface ClaimedWork extends WorkDescriptor {
  workId: string;
  expectedChunkCount: number | null;
  stagedChunks: number;
}

export async function claimReportingWork(client: RpcClient, batchId: string, fence: number, limit = 100): Promise<ClaimedWork[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CLAIM) throw new ReportingJobError(`limit must be 1..${MAX_CLAIM}`);
  const out = await rows(client, "claim_reporting_work", { p_batch: batchArg(batchId), p_fence: fenceArg(fence), p_limit: limit }, false);
  if (out.length > limit) throw new ReportingJobError("claim returned more work than requested");
  if (utf8(JSON.stringify(out)) > MAX_REQUEST_BYTES) throw new ReportingJobError("claim response over 1 MiB");
  return out.map((r) => {
    if (typeof r.work_id !== "string" || !WORK_ID.test(r.work_id)) throw new ReportingJobError("work_id must be a positive decimal string");
    const d = { audienceKind: r.audience_kind, audienceStaff: r.audience_staff, partitionKind: r.partition_kind, partitionKey: r.partition_key, inputHash: r.input_hash };
    const p = descriptorProblem(d);
    if (p) throw new ReportingJobError(`claimed work ${r.work_id}: ${p}`);
    return {
      ...(d as WorkDescriptor),
      workId: r.work_id,
      expectedChunkCount: r.expected_chunk_count === null ? null : int(r.expected_chunk_count, "expected_chunk_count"),
      stagedChunks: int(r.staged_chunks, "staged_chunks"),
    };
  });
}

export interface StagedChunk {
  workId: string;
  chunkNo: number;
  stored: boolean;
  done: boolean;
}
function staged(r: Record<string, unknown>): StagedChunk {
  if (typeof r.work_id !== "string" || !WORK_ID.test(r.work_id)) throw new ReportingJobError("work_id must be a positive decimal string");
  if (typeof r.stored !== "boolean" || typeof r.done !== "boolean") throw new ReportingJobError("stored/done must be booleans");
  return { workId: r.work_id, chunkNo: int(r.chunk_no, "chunk_no"), stored: r.stored, done: r.done };
}
function entryArg(e: StageEntry): StageEntry {
  if (typeof e.partition !== "string" || !WORK_ID.test(e.partition)) throw new ReportingJobError("partition must be a positive decimal work id");
  return e;
}

export async function stageReportingResult(client: RpcClient, batchId: string, fence: number, entry: StageEntry): Promise<StagedChunk> {
  const e = entryArg(entry);
  const [r] = await rows(client, "stage_reporting_result", { p_batch: batchArg(batchId), p_fence: fenceArg(fence), p_partition: e.partition, p_chunk: e.chunk }, true);
  return staged(r);
}

/** One bounded bulk request: all entries succeed or none do. */
export async function stageReportingResults(client: RpcClient, batchId: string, fence: number, entries: readonly StageEntry[]): Promise<StagedChunk[]> {
  if (entries.length === 0 || entries.length > MAX_BULK_ENTRIES) throw new ReportingJobError(`a bulk request holds 1..${MAX_BULK_ENTRIES} entries`);
  entries.forEach(entryArg);
  if (utf8(JSON.stringify(entries)) > MAX_REQUEST_BYTES - JSONB_TEXT_MARGIN) throw new ReportingJobError("bulk stage request over 1 MiB");
  const out = await rows(client, "stage_reporting_results", { p_batch: batchArg(batchId), p_fence: fenceArg(fence), p_results: entries }, false);
  if (out.length !== entries.length) throw new ReportingJobError("bulk stage returned a different number of results");
  return out.map(staged);
}
