/**
 * Complete, authorized production evidence reader (F1 / item-counting plan, Task 4).
 *
 * Reads one site's production events for an enclosing display window plus the
 * context the shared counter needs (before-window verifications that qualify a
 * completion, referenced parents, and corrections saved after the window), all
 * under one fixed `asOfUtc` cutoff.
 *
 * Rules:
 *  - Every request filters by site and `created_at <= asOfUtc`.
 *  - Keyset pages ordered by (created_at, id); continue until an EMPTY page, so a
 *    server row cap can never silently truncate. No 1,000-row or 100-page ceiling.
 *  - Any failed page, non-advancing cursor, abort or deadline rejects. A partial
 *    read is never returned as a success-shaped snapshot.
 *  - A second pass re-reads the same bounded queries; a difference retries once,
 *    then rejects as "changed".
 *  - The caller's client (and its RLS) is used as-is. This module never builds a
 *    client, reads env vars or touches browser state, so api/ can import it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PRODUCTION_EVIDENCE_COLUMNS,
  type ProductionEvidenceEvent,
  type ProductionSnapshot,
  type ProductionVisibility,
  type UtcWindow,
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
  /** Rows requested per page (default 500). The server may return fewer. */
  pageSize?: number;
  /** Order numbers / ids per context request (default 100). */
  batchSize?: number;
  /** Absolute deadline (epoch ms); exceeded = incomplete. */
  deadlineMs?: number;
  /** Clock for loadedAtUtc / deadline (tests). */
  now?: () => number;
}

/** Minimal structural view of the supabase-js builder used here. */
interface EvidenceQuery extends PromiseLike<{ data: unknown[] | null; error: unknown }> {
  eq(column: string, value: string): EvidenceQuery;
  in(column: string, values: readonly string[]): EvidenceQuery;
  gte(column: string, value: string): EvidenceQuery;
  lt(column: string, value: string): EvidenceQuery;
  lte(column: string, value: string): EvidenceQuery;
  filter(column: string, operator: string, value: string): EvidenceQuery;
  or(filters: string): EvidenceQuery;
  order(column: string, options: { ascending: boolean }): EvidenceQuery;
  limit(count: number): EvidenceQuery;
  abortSignal?(signal: AbortSignal): EvidenceQuery;
}

interface EvidenceClient {
  from(table: string): { select(columns: string): unknown };
}

const COUNT_EVENT_TYPES = ["line_verified", "cancelled", "completed", "dispatched"] as const;
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_BATCH_SIZE = 100;

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

function inList(values: readonly string[]): string {
  return `(${values.map(quotePostgrestValue).join(",")})`;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

function isRow(v: unknown): v is ProductionEvidenceEvent {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.location === "string" && typeof r.created_at === "string" && typeof r.event_type === "string";
}

function rowKey(r: ProductionEvidenceEvent): string {
  return `${r.location}\u0000${r.id}`;
}

function fingerprint(rows: Map<string, ProductionEvidenceEvent>): string {
  return [...rows.keys()]
    .sort()
    .map((k) => {
      const r = rows.get(k)!;
      return JSON.stringify([
        r.location, r.id, r.staff_id, r.department, r.order_number, r.line_sku,
        r.line_quantity ?? null, r.event_type, r.created_at, r.parent_event_id, r.cs_case_id,
      ]);
    })
    .join("\n");
}

type Narrow = (q: EvidenceQuery) => EvidenceQuery;

class Reader {
  private readonly pageSize: number;
  private readonly batchSize: number;
  private readonly now: () => number;

  constructor(
    private readonly client: EvidenceClient,
    private readonly req: ProductionReadRequest,
  ) {
    this.pageSize = req.pageSize ?? DEFAULT_PAGE_SIZE;
    this.batchSize = req.batchSize ?? DEFAULT_BATCH_SIZE;
    this.now = req.now ?? Date.now;
  }

  private checkLive(): void {
    if (this.req.signal?.aborted) throw new ProductionReadError("aborted", "Production read was cancelled.");
    if (this.req.deadlineMs !== undefined && this.now() > this.req.deadlineMs) {
      throw new ProductionReadError("incomplete", "Production read exceeded its time limit.");
    }
  }

  private base(): EvidenceQuery {
    let q = this.client.from("production_events").select(PRODUCTION_EVIDENCE_COLUMNS) as EvidenceQuery;
    q = q.eq("location", this.req.site).lte("created_at", this.req.asOfUtc);
    if (this.req.signal && typeof q.abortSignal === "function") q = q.abortSignal(this.req.signal);
    return q;
  }

  /** Keyset-page one bounded query to exhaustion. */
  private async pageAll(narrow: Narrow, into: Map<string, ProductionEvidenceEvent>): Promise<void> {
    let cursor: { createdAt: string; ms: number; id: string } | null = null;
    for (;;) {
      this.checkLive();
      let q = narrow(this.base());
      if (cursor) {
        const t = quotePostgrestValue(cursor.createdAt);
        q = q.or(`created_at.gt.${t},and(created_at.eq.${t},id.gt.${quotePostgrestValue(cursor.id)})`);
      }
      q = q.order("created_at", { ascending: true }).order("id", { ascending: true }).limit(this.pageSize);
      let res: { data: unknown[] | null; error: unknown };
      try {
        res = await q;
      } catch (e) {
        if (this.req.signal?.aborted) throw new ProductionReadError("aborted", "Production read was cancelled.");
        throw new ProductionReadError("failed", `Production read failed: ${errorMessage(e)}`);
      }
      this.checkLive();
      if (res.error) throw new ProductionReadError("failed", `Production read failed: ${errorMessage(res.error)}`);
      const page = res.data ?? [];
      if (page.length === 0) return;
      for (const raw of page) {
        if (!isRow(raw)) throw new ProductionReadError("incomplete", "Production read returned a malformed row.");
        if (raw.location !== this.req.site) throw new ProductionReadError("incomplete", "Production read returned another site's row.");
        const ms = Date.parse(raw.created_at);
        if (!Number.isFinite(ms)) throw new ProductionReadError("incomplete", `Production row ${raw.id} has an unreadable time.`);
        // Rows must strictly advance past the cursor in (created_at, id) order.
        if (cursor && (ms < cursor.ms || (ms === cursor.ms && raw.id <= cursor.id))) {
          throw new ProductionReadError("incomplete", "Production read cursor did not advance.");
        }
        const k = rowKey(raw);
        const prior = into.get(k);
        if (prior && fingerprint(new Map([[k, prior]])) !== fingerprint(new Map([[k, raw]]))) {
          throw new ProductionReadError("incomplete", `Production event ${raw.id} was read with two different payloads.`);
        }
        into.set(k, raw);
        cursor = { createdAt: raw.created_at, ms, id: raw.id };
      }
    }
  }

  /**
   * One full bounded read:
   *  1. every count event inside the window;
   *  2. original verifications BEFORE the window for orders completed inside it
   *     (qualification context, all workers; exact match happens in the reducer);
   *  3. parents of in-window cancellations that fall before the window;
   *  4. corrections saved AFTER the window (up to the cutoff) that point at
   *     in-window evidence. One time-bounded paged read, not one request per id.
   */
  async readOnce(): Promise<Map<string, ProductionEvidenceEvent>> {
    const { range, site } = this.req;
    const rows = new Map<string, ProductionEvidenceEvent>();

    await this.pageAll(
      (q) => q.in("event_type", COUNT_EVENT_TYPES).gte("created_at", range.startUtc).lt("created_at", range.endUtcExclusive),
      rows,
    );

    const orders = new Set<string>();
    const evidenceIds = new Set<string>();
    const parents = new Set<string>();
    for (const r of rows.values()) {
      const terminal = r.event_type === "completed" || r.event_type === "dispatched";
      if (terminal && typeof r.order_number === "string" && r.order_number.trim()) orders.add(r.order_number);
      if (terminal || r.event_type === "line_verified") evidenceIds.add(r.id);
    }
    for (const r of rows.values()) {
      if (r.event_type !== "cancelled" || typeof r.parent_event_id !== "string" || !r.parent_event_id) continue;
      if (!rows.has(`${site}\u0000${r.parent_event_id}`)) parents.add(r.parent_event_id);
    }

    for (const batch of chunks([...orders].sort(), this.batchSize)) {
      await this.pageAll(
        (q) => q.eq("event_type", "line_verified").filter("order_number", "in", inList(batch)).lt("created_at", range.startUtc),
        rows,
      );
    }
    for (const batch of chunks([...parents].sort(), this.batchSize)) {
      await this.pageAll((q) => q.filter("id", "in", inList(batch)).lt("created_at", range.startUtc), rows);
    }
    const later = new Map<string, ProductionEvidenceEvent>();
    await this.pageAll(
      (q) => q.eq("event_type", "cancelled").filter("parent_event_id", "not.is", "null").gte("created_at", range.endUtcExclusive),
      later,
    );
    for (const [k, r] of later) {
      if (typeof r.parent_event_id === "string" && evidenceIds.has(r.parent_event_id)) rows.set(k, r);
    }
    return rows;
  }
}

function validateRequest(req: ProductionReadRequest): void {
  const start = Date.parse(req.range.startUtc);
  const end = Date.parse(req.range.endUtcExclusive);
  const asOf = Date.parse(req.asOfUtc);
  if (typeof req.site !== "string" || !req.site.trim()) throw new ProductionReadError("failed", "Production read needs a site.");
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new ProductionReadError("failed", "Production read has an invalid window.");
  if (!Number.isFinite(asOf)) throw new ProductionReadError("failed", "Production read has an invalid cutoff.");
  if (req.pageSize !== undefined && (!Number.isSafeInteger(req.pageSize) || req.pageSize < 1)) throw new ProductionReadError("failed", "Invalid page size.");
  if (req.batchSize !== undefined && (!Number.isSafeInteger(req.batchSize) || req.batchSize < 1)) throw new ProductionReadError("failed", "Invalid batch size.");
}

/**
 * Load a complete snapshot or reject with ProductionReadError.
 * Accepts the caller's Supabase client (browser: signed-in client; digest: its server client).
 */
export async function loadProductionEvidence(
  client: Pick<SupabaseClient, "from"> | EvidenceClient,
  request: ProductionReadRequest,
): Promise<ProductionSnapshot> {
  validateRequest(request);
  const reader = new Reader(client as EvidenceClient, request);
  for (let attempt = 0; attempt < 2; attempt++) {
    const first = await reader.readOnce();
    const second = await reader.readOnce();
    if (fingerprint(first) === fingerprint(second)) {
      const events = [...first.values()].sort((a, b) => {
        const d = Date.parse(a.created_at) - Date.parse(b.created_at);
        return d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
      return {
        events,
        range: { startUtc: request.range.startUtc, endUtcExclusive: request.range.endUtcExclusive },
        asOfUtc: request.asOfUtc,
        loadedAtUtc: new Date((request.now ?? Date.now)()).toISOString(),
        visibility: request.visibility,
      };
    }
  }
  throw new ProductionReadError("changed", "Production data changed while loading; retry.");
}
