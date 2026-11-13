/**
 * Complete, authorized production evidence reader (F1 / item-counting plan,
 * Task 4, one-call amendment).
 *
 * One call to the read-only RPC `public.load_production_evidence_v2`
 * (migration 0035, encoding v2) returns one site's evidence as a single
 * scalar envelope:
 * the display window's count events plus the context the shared counter needs
 * (before-window verifications that qualify a completion, referenced
 * parents, and cancellations saved after the window), all under one fixed
 * `asOfUtc` cutoff and one database snapshot.
 *
 * Rules:
 *  - Exactly one RPC per load. No paging, no batches, no automatic re-read,
 *    no fallback to table reads.
 *  - The envelope (encoding v2) is validated strictly before any snapshot is
 *    built: version, completeness flag, echoed scope, row count, the staff
 *    and SKU dictionaries (text, unique, every entry used, every index in
 *    range), every tuple's shape, cutoff and family membership. Rows carry no
 *    site; each decoded row takes the validated envelope site. Anything
 *    malformed or partial rejects; nothing success-shaped is returned.
 *  - The server sends rows in no particular order; the loader sorts once by
 *    exact instant (microseconds), then id.
 *  - Identical repeated rows are deduplicated; two different payloads for
 *    the same event reject as "changed".
 *  - The caller's client (and its RLS) is used as-is. This module never
 *    builds a client, reads env vars or touches browser state, so api/ can
 *    import it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ProductionEvidenceEvent,
  ProductionSnapshot,
  ProductionVisibility,
  UtcWindow,
} from "../../domain/productionCounts";

export type ProductionReadErrorKind = "failed" | "incomplete" | "changed" | "aborted";

export class ProductionReadError extends Error {
  constructor(
    public readonly kind: ProductionReadErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ProductionReadError";
  }
}

export interface ProductionReadRequest {
  /** One site (location key). */
  site: string;
  /** Enclosing display/comparison window. */
  range: UtcWindow;
  /** Fixed cutoff; captured once by the caller at refresh/request start. */
  asOfUtc: string;
  /** Caller-established visibility for this role/site (see productionVisibilityFor). */
  visibility: ProductionVisibility;
  signal?: AbortSignal;
  /** @deprecated Paged reader setting; validated for compatibility, no longer used. */
  pageSize?: number;
  /** @deprecated Paged reader setting; validated for compatibility, no longer used. */
  batchSize?: number;
  /** Absolute deadline (epoch ms); exceeded = incomplete. */
  deadlineMs?: number;
  /** Clock for loadedAtUtc / deadline (tests). */
  now?: () => number;
}

export const EVIDENCE_RPC = "load_production_evidence_v2";

/** Minimal structural view of supabase-js `rpc(...)` used here. */
interface EvidenceRpcCall extends PromiseLike<{ data: unknown; error: unknown }> {
  abortSignal?(signal: AbortSignal): EvidenceRpcCall;
}

export interface EvidenceRpcClient {
  rpc(fn: string, args: Record<string, unknown>): unknown;
}

/** Roles whose SELECT policy returns every production event at an accessible site. */
const SITE_WIDE_ROLES = new Set(["owner", "manager", "cs", "kiosk"]);

/**
 * Conservative visibility from the existing role contract
 * (production_events_select: own rows, or owner/manager/cs/kiosk at an accessible site).
 * Nav permission is not proof of row access; site membership must be known.
 */
export function productionVisibilityFor(role: string | null | undefined, hasSiteMembership: boolean): ProductionVisibility {
  if (!hasSiteMembership) return { kind: "limited", reason: "Site access not confirmed; visible records only." };
  if (role && SITE_WIDE_ROLES.has(role)) return { kind: "site" };
  return { kind: "limited", reason: "Visible records only: your own production events." };
}

/** PostgREST double-quoted value; escapes backslash and double quote. */
export function quotePostgrestValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// Exact instants (PostgreSQL keeps microseconds; Date.parse would drop them).

const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/** Microseconds since the epoch, or null if the text is not an exact ISO-8601 instant. */
export function instantMicros(text: unknown): bigint | null {
  if (typeof text !== "string") return null;
  const m = INSTANT_RE.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const check = new Date(ms);
  if (
    !Number.isFinite(ms) || +h > 23 || +mi > 59 || +s > 59 ||
    check.getUTCFullYear() !== +y || check.getUTCMonth() !== +mo - 1 || check.getUTCDate() !== +d
  ) return null;
  let offsetMin = 0;
  if (zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const oh = +digits.slice(0, 2);
    const om = digits.length > 2 ? +digits.slice(2, 4) : 0;
    if (oh > 23 || om > 59) return null;
    offsetMin = sign * (oh * 60 + om);
  }
  const micros = BigInt((frac ?? "").padEnd(6, "0"));
  return (BigInt(ms) - BigInt(offsetMin) * 60_000n) * 1000n + micros;
}

// ---------------------------------------------------------------------------
// Envelope v2 (migration 0035)

const ENVELOPE_KEYS = [
  "version", "site", "startUtc", "endUtcExclusive", "asOfUtc", "complete", "rowCount", "staffIds", "skus", "rows",
] as const;
const TUPLE_LENGTH = 10;
const COUNT_TYPES = new Set(["line_verified", "completed", "dispatched", "cancelled"]);
const EVIDENCE_TYPES = new Set(["line_verified", "completed", "dispatched"]);
const TERMINAL_TYPES = new Set(["completed", "dispatched"]);
/** Check abort/deadline every this many rows while validating. */
const CHECK_EVERY = 10_000;

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

interface Bounds {
  start: bigint;
  end: bigint;
  cutoff: bigint;
}

function validateRequest(req: ProductionReadRequest): Bounds {
  if (typeof req.site !== "string" || !req.site.trim()) throw new ProductionReadError("failed", "Production read needs a site.");
  const start = instantMicros(req.range?.startUtc);
  const end = instantMicros(req.range?.endUtcExclusive);
  const cutoff = instantMicros(req.asOfUtc);
  if (start === null || end === null || start >= end) throw new ProductionReadError("failed", "Production read has an invalid window.");
  if (cutoff === null) throw new ProductionReadError("failed", "Production read has an invalid cutoff.");
  if (req.pageSize !== undefined && (!Number.isSafeInteger(req.pageSize) || req.pageSize < 1)) throw new ProductionReadError("failed", "Invalid page size.");
  if (req.batchSize !== undefined && (!Number.isSafeInteger(req.batchSize) || req.batchSize < 1)) throw new ProductionReadError("failed", "Invalid batch size.");
  return { start, end, cutoff };
}

function bad(message: string): ProductionReadError {
  return new ProductionReadError("incomplete", `Production evidence was incomplete or malformed: ${message}`);
}

interface DecodedRow {
  event: ProductionEvidenceEvent;
  at: bigint;
  key: string;
  /** Decoded values with the time as an exact instant, for duplicate comparison. */
  identity: string;
}

/** A dictionary: a list of unique strings; tracks which entries rows use. */
class Dictionary {
  private readonly used: boolean[];
  constructor(
    private readonly name: string,
    readonly entries: readonly string[],
  ) {
    this.used = entries.map(() => false);
  }

  static parse(name: string, raw: unknown): Dictionary {
    if (!Array.isArray(raw)) throw bad(`${name} is not a list`);
    const seen = new Set<string>();
    for (const [i, v] of raw.entries()) {
      if (typeof v !== "string") throw bad(`${name}[${i}] is not text`);
      if (seen.has(v)) throw bad(`${name} lists "${v}" twice`);
      seen.add(v);
    }
    return new Dictionary(name, raw as string[]);
  }

  /** Decode a slot: null stays null; otherwise a safe in-range integer index. */
  lookup(v: unknown, row: number): string | null {
    if (v === null) return null;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v >= this.entries.length) {
      throw bad(`row ${row} has an invalid ${this.name} index`);
    }
    this.used[v] = true;
    return this.entries[v];
  }

  assertAllUsed(): void {
    const unused = this.used.indexOf(false);
    if (unused !== -1) throw bad(`${this.name}[${unused}] is not used by any row`);
  }
}

function decodeTuple(raw: unknown, index: number, site: string, staff: Dictionary, skus: Dictionary): DecodedRow {
  if (!Array.isArray(raw) || raw.length !== TUPLE_LENGTH) throw bad(`row ${index} is not a ${TUPLE_LENGTH}-slot tuple`);
  const [id, staffIx, department, orderNumber, skuIx, lineQuantity, eventType, createdAt, parentEventId, csCaseId] = raw;
  if (typeof id !== "string" || !id) throw bad(`row ${index} has no id`);
  if (typeof eventType !== "string") throw bad(`row ${index} has no event type`);
  for (const [name, v] of [
    ["department", department], ["order_number", orderNumber], ["parent_event_id", parentEventId], ["cs_case_id", csCaseId],
  ] as const) {
    if (!isNullableString(v)) throw bad(`row ${index} has a non-text ${name}`);
  }
  if (lineQuantity !== null && (typeof lineQuantity !== "number" || !Number.isFinite(lineQuantity))) {
    throw bad(`row ${index} has a non-numeric quantity`);
  }
  const at = instantMicros(createdAt);
  if (at === null) throw bad(`row ${index} has an unreadable time`);
  const event: ProductionEvidenceEvent = {
    id,
    location: site,
    staff_id: staff.lookup(staffIx, index),
    department: department as string | null,
    order_number: orderNumber as string | null,
    line_sku: skus.lookup(skuIx, index),
    line_quantity: lineQuantity,
    event_type: eventType,
    created_at: createdAt as string,
    parent_event_id: parentEventId as string | null,
    cs_case_id: csCaseId as string | null,
  };
  const identity = JSON.stringify([
    event.id, event.staff_id, event.department, event.order_number, event.line_sku, event.line_quantity,
    event.event_type, at.toString(), event.parent_event_id, event.cs_case_id,
  ]);
  return { event, at, key: `${site}\u0000${id}`, identity };
}

/** Validate an envelope against its request and return the events in exact (created_at, id) order. */
export function decodeEvidenceEnvelope(
  data: unknown,
  req: ProductionReadRequest,
  bounds: Bounds,
  checkLive: () => void = () => {},
): ProductionEvidenceEvent[] {
  if (data === null || data === undefined) throw bad("the server returned no evidence");
  if (typeof data !== "object" || Array.isArray(data)) throw bad("the response is not an evidence envelope");
  const env = data as Record<string, unknown>;
  const keys = Object.keys(env);
  for (const k of ENVELOPE_KEYS) if (!(k in env)) throw bad(`missing ${k}`);
  if (keys.length !== ENVELOPE_KEYS.length) throw bad("unexpected envelope fields");
  if (env.version !== 2) throw bad(`unsupported encoding version ${String(env.version)}`);
  if (env.complete !== true) throw bad("the server did not mark the evidence complete");
  if (env.site !== req.site) throw bad("the evidence is for another site");
  if (instantMicros(env.startUtc) !== bounds.start || instantMicros(env.endUtcExclusive) !== bounds.end) {
    throw bad("the evidence is for another window");
  }
  if (instantMicros(env.asOfUtc) !== bounds.cutoff) throw bad("the evidence has another cutoff");
  const rows = env.rows;
  if (!Array.isArray(rows)) throw bad("rows is not a list");
  const rowCount = env.rowCount;
  if (typeof rowCount !== "number" || !Number.isSafeInteger(rowCount) || rowCount < 0) throw bad("rowCount is not a count");
  if (rowCount !== rows.length) throw bad(`the server counted ${rowCount} rows but sent ${rows.length}`);
  const staff = Dictionary.parse("staffIds", env.staffIds);
  const skus = Dictionary.parse("skus", env.skus);
  checkLive();

  // Pass 1: decode, check cutoff, deduplicate.
  const unique = new Map<string, DecodedRow>();
  for (let i = 0; i < rows.length; i++) {
    if (i % CHECK_EVERY === 0) checkLive();
    const row = decodeTuple(rows[i], i, req.site, staff, skus);
    if (row.at > bounds.cutoff) throw bad(`row ${i} is after the cutoff`);
    const prior = unique.get(row.key);
    if (prior) {
      if (prior.identity !== row.identity) {
        throw new ProductionReadError("changed", `Production event ${row.event.id} was returned with two different payloads.`);
      }
      continue;
    }
    unique.set(row.key, row);
  }
  staff.assertAllUsed();
  skus.assertAllUsed();
  checkLive();

  // Pass 2: index the window rows.
  const inWindow = (r: DecodedRow) => r.at >= bounds.start && r.at < bounds.end;
  const terminalOrders = new Set<string>();
  const cancelParents = new Set<string>();
  const evidenceIds = new Set<string>();
  for (const r of unique.values()) {
    if (!inWindow(r)) continue;
    const e = r.event;
    if (!COUNT_TYPES.has(e.event_type)) throw bad(`window row ${e.id} has event type ${e.event_type}`);
    if (TERMINAL_TYPES.has(e.event_type) && e.order_number !== null && e.order_number.trim()) terminalOrders.add(e.order_number);
    if (EVIDENCE_TYPES.has(e.event_type)) evidenceIds.add(e.id);
    if (e.event_type === "cancelled" && e.parent_event_id) cancelParents.add(e.parent_event_id);
  }

  // Pass 3: every context row must belong to one of the three context families.
  for (const r of unique.values()) {
    if (inWindow(r)) continue;
    const e = r.event;
    if (r.at < bounds.start) {
      const qualifies = e.event_type === "line_verified" && e.order_number !== null && terminalOrders.has(e.order_number);
      if (!qualifies && !cancelParents.has(e.id)) throw bad(`context row ${e.id} before the window is unrelated to it`);
    } else if (!(e.event_type === "cancelled" && e.parent_event_id !== null && evidenceIds.has(e.parent_event_id))) {
      throw bad(`context row ${e.id} after the window is not a correction of window evidence`);
    }
  }
  checkLive();

  return [...unique.values()]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0))
    .map((r) => r.event);
}

/**
 * Load a complete snapshot or reject with ProductionReadError.
 * Accepts the caller's Supabase client (browser: signed-in client; digest: its server client).
 */
export async function loadProductionEvidence(
  client: Pick<SupabaseClient, "rpc"> | EvidenceRpcClient,
  request: ProductionReadRequest,
): Promise<ProductionSnapshot> {
  const bounds = validateRequest(request);
  const now = request.now ?? Date.now;
  const deadlinePassed = () => request.deadlineMs !== undefined && now() > request.deadlineMs;
  const checkLive = () => {
    if (request.signal?.aborted) throw new ProductionReadError("aborted", "Production read was cancelled.");
    if (deadlinePassed()) throw new ProductionReadError("incomplete", "Production read exceeded its time limit.");
  };
  checkLive();

  // One controller aborts the request for either a caller cancel or the deadline.
  const controller = new AbortController();
  let stop: ((e: ProductionReadError) => void) | null = null;
  const stopped = new Promise<never>((_, reject) => {
    stop = reject;
  });
  stopped.catch(() => {});
  const onCallerAbort = () => {
    controller.abort();
    stop?.(new ProductionReadError("aborted", "Production read was cancelled."));
  };
  request.signal?.addEventListener("abort", onCallerAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (request.deadlineMs !== undefined) {
    timer = setTimeout(() => {
      controller.abort();
      stop?.(new ProductionReadError("incomplete", "Production read exceeded its time limit."));
    }, Math.max(0, request.deadlineMs - now()));
  }

  try {
    let call = (client as EvidenceRpcClient).rpc(EVIDENCE_RPC, {
      p_site: request.site,
      p_start_utc: request.range.startUtc,
      p_end_utc_exclusive: request.range.endUtcExclusive,
      p_as_of_utc: request.asOfUtc,
    }) as EvidenceRpcCall;
    if (typeof call.abortSignal === "function") call = call.abortSignal(controller.signal);

    let res: { data: unknown; error: unknown };
    try {
      res = await Promise.race([Promise.resolve(call), stopped]);
    } catch (e) {
      if (e instanceof ProductionReadError) throw e;
      checkLive();
      throw new ProductionReadError("failed", `Production read failed: ${errorMessage(e)}`);
    }
    checkLive();
    if (res.error) throw new ProductionReadError("failed", `Production read failed: ${errorMessage(res.error)}`);

    const events = decodeEvidenceEnvelope(res.data, request, bounds, checkLive);
    checkLive();
    return {
      events: Object.freeze(events),
      range: { startUtc: request.range.startUtc, endUtcExclusive: request.range.endUtcExclusive },
      asOfUtc: request.asOfUtc,
      loadedAtUtc: new Date(now()).toISOString(),
      visibility: request.visibility,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    request.signal?.removeEventListener("abort", onCallerAbort);
  }
}
