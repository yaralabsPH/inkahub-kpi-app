/**
 * Task 14: the production FrozenReader over the 0040 bounded read RPCs
 * (service-only, frozen batch view, ≤1,000 rows and ≤1 MiB per call).
 *
 * Every read pages with an exact keyset until the RPC returns an EMPTY page:
 * a short page may only mean the 1 MiB byte cap was reached, never the end.
 * Images are reduced to the exact evidence fields the shared projector reads
 * (the input hash covers exactly these), after checking site/id binding.
 */
import type { ProductionEvidenceEvent } from "../../src/lib/domain/productionCounts.js";
import { ReportingJobError, type RpcClient } from "./reporting-jobs.js";
import { compareUtf8 } from "./reporting-stage.js";
import { compareStream, ownerKey, predecessorPageOf, type ChangedKey, type FrozenReader, type Owner, type PredecessorRow, type StreamPosition } from "./production-reporting-materialize.js";

type Ev = ProductionEvidenceEvent;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const str = (v: unknown, what: string): string => {
  if (typeof v !== "string") throw new ReportingJobError(`${what} must be text`);
  return v;
};
const nstr = (v: unknown, what: string): string | null => (v === null || v === undefined ? null : str(v, what));

/** A frozen source image as the projector's evidence event (exact fields; nothing else enters the input hash). */
export function imageToEvent(image: unknown, site: string, expectedId?: string): Ev {
  if (!image || typeof image !== "object" || Array.isArray(image)) throw new ReportingJobError("a frozen image must be an object");
  const i = image as Record<string, unknown>;
  const id = str(i.id, "image.id");
  if (expectedId !== undefined && id !== expectedId) throw new ReportingJobError(`image id ${JSON.stringify(id)} does not match ${JSON.stringify(expectedId)}`);
  if (i.location !== site) throw new ReportingJobError(`image ${JSON.stringify(id)} belongs to ${String(i.location)}, not ${site}`);
  const q = i.line_quantity;
  return {
    id,
    location: site,
    staff_id: nstr(i.staff_id, "image.staff_id"),
    department: nstr(i.department, "image.department"),
    order_number: nstr(i.order_number, "image.order_number"),
    line_sku: nstr(i.line_sku, "image.line_sku"),
    line_quantity: q === undefined ? null : q,
    event_type: str(i.event_type, "image.event_type"),
    created_at: str(i.created_at, "image.created_at"),
    parent_event_id: nstr(i.parent_event_id, "image.parent_event_id"),
    cs_case_id: nstr(i.cs_case_id, "image.cs_case_id"),
  };
}

/** The complete response bound of every 0040/0041 read (1 MiB of serialized JSON). */
export const MAX_RESPONSE_BYTES = 1024 * 1024;
/** UTF-8 size of the compact JSON a response is carried as (the conservative SQL accounting is never below this). */
export const responseBytes = (data: unknown): number => new TextEncoder().encode(JSON.stringify(data)).length;

export interface FrozenBatchRef { batchId: string; fence: number; site: string; cutoff: string; kind: "refresh" | "rebuild" }

export interface FrozenReaderOptions {
  /**
   * T15P-1: awaited before EVERY actual frozen-read RPC (each internal member /
   * by-id / children page, coalesced flushes, fallbacks and 0045 pages). The
   * worker passes its deadline check + single-flight heartbeat here; a throw
   * stops the read before another page is requested. Lease renewals go
   * through the worker's own client, never through this reader, so the guard
   * cannot recurse.
   */
  beforeRead?: () => Promise<void>;
}

/** Keyset of a member page: the last row's owner index and id; `id: null` skips the rest of that owner (index, NULL). */
export interface MembersAfter { index: number; id: string | null }
export interface MembersPage { rows: Array<{ ownerIndex: number; ev: Ev }>; next: MembersAfter | null; empty: boolean }
export interface ByIdsPage { rows: Ev[]; /** The requested ids after the last returned one (what a byte-capped response left). */ pending: string[]; /** Nothing returned: the remaining requested ids are absent. */ empty: boolean }
export interface ChildrenAfter { parent: string; id: string }
export interface ChildrenPage { rows: Ev[]; next: ChildrenAfter | null; empty: boolean }

/**
 * T15P-4b: one-call page methods. Each makes EXACTLY one frozen-read RPC (through the same guarded `call`,
 * so `beforeRead` and the request counter see it), validates the whole page, and returns its keyset. Only an
 * EMPTY page means the end; a short page may be byte-capped. The durable owner route uses these directly.
 */
export interface FrozenReaderPages {
  /** One page of `read_reporting_owner_members` for 1..100 owners (owner_index is into `owners`). */
  membersPage(owners: readonly Owner[], after: MembersAfter | null, limit?: number): Promise<MembersPage>;
  /** One `read_reporting_events_by_id` call for 1..500 ids, already unique and bytewise sorted. */
  byIdsPage(ids: readonly string[]): Promise<ByIdsPage>;
  /** One page of `read_reporting_children` for 1..1,000 parent ids, already unique and bytewise sorted. */
  childrenPage(parentIds: readonly string[], after: ChildrenAfter | null, limit?: number): Promise<ChildrenPage>;
}

const pageLimit = (limit: number | undefined): number => {
  const l = limit ?? 1000;
  if (!Number.isInteger(l) || l < 1 || l > 1000) throw new ReportingJobError("a page limit must be an integer in 1..1000");
  return l;
};
const sortedUnique = (ids: readonly string[], max: number, what: string): void => {
  if (ids.length < 1 || ids.length > max) throw new ReportingJobError(`${what} must have 1..${max} ids`);
  for (let i = 1; i < ids.length; i++) if (compareUtf8(ids[i - 1], ids[i]) >= 0) throw new ReportingJobError(`${what} must be unique and bytewise sorted`);
};

export function rpcFrozenReader(client: RpcClient, ref: FrozenBatchRef, opts: FrozenReaderOptions = {}): FrozenReader & { pages: FrozenReaderPages } {
  if (!UUID.test(ref.batchId)) throw new ReportingJobError("batchId must be a uuid");
  if (!Number.isSafeInteger(ref.fence) || ref.fence < 1) throw new ReportingJobError("fence must be a positive integer");
  let n = 0;
  const call = async (fn: string, args: Record<string, unknown>): Promise<Array<Record<string, unknown>>> => {
    if (opts.beforeRead) await opts.beforeRead();
    n++;
    const { data, error } = await client.rpc(fn, { p_batch: ref.batchId, p_fence: ref.fence, ...args });
    if (error) throw new ReportingJobError(`${fn}: ${error.message}`, error.code ?? null);
    if (!Array.isArray(data)) throw new ReportingJobError(`${fn} returned no rows array`);
    if (data.length > 1000) throw new ReportingJobError(`${fn} returned more than 1,000 rows`);
    // T14R4: the WHOLE response (array, rows, field names, ids and images) must fit 1 MiB; an oversized one is rejected, never sliced.
    const bytes = responseBytes(data);
    if (bytes > MAX_RESPONSE_BYTES) throw new ReportingJobError(`${fn} returned ${bytes} bytes; a response must be at most ${MAX_RESPONSE_BYTES}`);
    return data as Array<Record<string, unknown>>;
  };
  const pages: FrozenReaderPages = {
    async membersPage(owners, after, limit) {
      if (owners.length < 1 || owners.length > 100) throw new ReportingJobError("a member page needs 1..100 owners");
      const rows = await call("read_reporting_owner_members", {
        p_owners: owners.map((o) => [o.partitionKind, o.partitionKey]), p_after_index: after?.index ?? null, p_after_event_id: after?.id ?? null, p_limit: pageLimit(limit),
      });
      // r6 R5 (adapter-owned source order): strictly ascending (owner_index, bytewise id), strictly after the cursor;
      // a cursor (index, NULL) means "the owners after index".
      let prev: MembersAfter | null = after;
      const out: MembersPage["rows"] = rows.map((r) => {
        const idx = r.owner_index;
        if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= owners.length) throw new ReportingJobError("read_reporting_owner_members returned a bad owner_index");
        const id = str(r.event_id, "event_id");
        if (prev !== null && (idx < prev.index || (idx === prev.index && (prev.id === null || compareUtf8(id, prev.id) <= 0)))) throw new ReportingJobError("read_reporting_owner_members is not in keyset order");
        prev = { index: idx, id };
        return { ownerIndex: idx, ev: imageToEvent(r.image, ref.site, id) };
      });
      const last = out.at(-1);
      return { rows: out, next: last ? { index: last.ownerIndex, id: last.ev.id } : null, empty: out.length === 0 };
    },
    async byIdsPage(ids) {
      sortedUnique(ids, 500, "a by-id page");
      const rows = await call("read_reporting_events_by_id", { p_ids: [...ids] });
      const out: Ev[] = [];
      let last = "";
      for (const r of rows) {
        const id = str(r.event_id, "event_id");
        if (!ids.includes(id)) throw new ReportingJobError(`read_reporting_events_by_id returned an id that was not requested`);
        if (out.length && compareUtf8(id, last) <= 0) throw new ReportingJobError("read_reporting_events_by_id is not in ascending id order");
        out.push(imageToEvent(r.image, ref.site, id));
        last = id;
      }
      // A byte-capped response stops early: what remains is only the ids after the last returned one.
      return { rows: out, pending: out.length ? ids.filter((id) => compareUtf8(id, last) > 0) : [...ids], empty: out.length === 0 };
    },
    async childrenPage(parentIds, after, limit) {
      sortedUnique(parentIds, 1000, "a children page");
      const rows = await call("read_reporting_children", { p_parent_ids: [...parentIds], p_after_parent_id: after?.parent ?? null, p_after_event_id: after?.id ?? null, p_limit: pageLimit(limit) });
      let prev: ChildrenAfter | null = after;
      const out = rows.map((r) => {
        const parent = str(r.parent_event_id, "parent_event_id");
        const id = str(r.event_id, "event_id");
        const e = imageToEvent(r.image, ref.site, id);
        if (e.parent_event_id !== parent || !parentIds.includes(parent)) throw new ReportingJobError("read_reporting_children returned a row for another parent");
        if (prev !== null && (compareUtf8(parent, prev.parent) < 0 || (parent === prev.parent && compareUtf8(id, prev.id) <= 0))) throw new ReportingJobError("read_reporting_children is not in keyset order");
        prev = { parent, id };
        return e;
      });
      return { rows: out, next: out.length ? prev : null, empty: out.length === 0 };
    },
  };
  return {
    site: ref.site, cutoff: ref.cutoff, kind: ref.kind, pages,
    async *changedKeys() {
      if (ref.kind !== "refresh") throw new ReportingJobError("changedKeys is a refresh read");
      let after: string | null = null;
      for (;;) {
        const rows = await call("read_reporting_changed_keys", { p_after_event_id: after, p_limit: 1000 });
        if (!rows.length) return;
        for (const r of rows) {
          const id = str(r.event_id, "event_id");
          if (after !== null && compareUtf8(id, after) <= 0) throw new ReportingJobError("read_reporting_changed_keys is not in keyset order");
          after = id;
          const k: ChangedKey = { id, before: r.before_image == null ? null : imageToEvent(r.before_image, ref.site, id), after: r.after_image == null ? null : imageToEvent(r.after_image, ref.site, id) };
          yield k;
        }
      }
    },
    async *owners() {
      if (ref.kind !== "rebuild") throw new ReportingJobError("owners is a rebuild read");
      let afterKind: string | null = null;
      let afterKey: string | null = null;
      for (;;) {
        const rows = await call("list_reporting_owners", { p_after_kind: afterKind, p_after_key: afterKey, p_limit: 1000 });
        if (!rows.length) return;
        for (const r of rows) {
          const kind = r.partition_kind;
          if (kind !== "order" && kind !== "event") throw new ReportingJobError("list_reporting_owners returned an unknown kind");
          const key = str(r.partition_key, "partition_key");
          const o: Owner = { partitionKind: kind, partitionKey: key };
          if (afterKind !== null && compareUtf8(ownerKey(o), ownerKey({ partitionKind: afterKind as Owner["partitionKind"], partitionKey: afterKey! })) <= 0) throw new ReportingJobError("list_reporting_owners is not in keyset order");
          afterKind = kind;
          afterKey = key;
          yield o;
        }
      }
    },
    async members(owners, cap) {
      // T15P-4b: a loop over membersPage (same groups of 100, same keysets, same cap+1 overflow skip).
      const out = new Map<string, Ev[]>(owners.map((o) => [ownerKey(o), []]));
      for (let g = 0; g < owners.length; g += 100) {
        const group = owners.slice(g, g + 100);
        let after: MembersAfter | null = null;
        for (;;) {
          const page = await pages.membersPage(group, after);
          if (page.empty) break;
          for (const r of page.rows) {
            const list = out.get(ownerKey(group[r.ownerIndex]))!;
            list.push(r.ev);
            after = { index: r.ownerIndex, id: r.ev.id };
            if (list.length > cap) {
              after = { index: r.ownerIndex, id: null }; // cap+1 proves the overflow: skip the rest of THIS owner (keyset (idx, NULL) = next owner)
              break;
            }
          }
        }
      }
      return out;
    },
    async byIds(ids) {
      // T15P-4b: a loop over byIdsPage (same groups of 500, same byte-cap continuation).
      const out = new Map<string, Ev>();
      const want = [...new Set(ids)].sort(compareUtf8);
      for (let g = 0; g < want.length; g += 500) {
        let pending = want.slice(g, g + 500);
        while (pending.length) {
          const page = await pages.byIdsPage(pending);
          if (page.empty) break; // the remaining ids are absent
          for (const e of page.rows) out.set(e.id, e);
          pending = page.pending;
        }
      }
      return out;
    },
    async *children(parentIds) {
      // Lazy: the next page is requested only when the consumer asks for more (a budget overflow stops reading at once).
      // T15P-4b: a loop over childrenPage (same groups of 1,000 parents, same keyset). The whole page is validated
      // before its first row is yielded.
      const ids = [...new Set(parentIds)].sort(compareUtf8);
      for (let g = 0; g < ids.length; g += 1000) {
        const group = ids.slice(g, g + 1000);
        let after: ChildrenAfter | null = null;
        for (;;) {
          const page = await pages.childrenPage(group, after);
          if (page.empty) break;
          after = page.next;
          for (const e of page.rows) yield e;
        }
      }
    },
    async childPage(parentId, afterId, limit) {
      if (!parentId) throw new ReportingJobError("a child page needs its parent");
      const rows = await call("read_reporting_children", { p_parent_ids: [parentId], p_after_parent_id: afterId === null ? null : parentId, p_after_event_id: afterId, p_limit: Math.min(Math.max(1, limit), 1000) });
      let prev = afterId;
      return rows.map((r) => {
        const id = str(r.event_id, "event_id");
        const e = imageToEvent(r.image, ref.site, id);
        if (str(r.parent_event_id, "parent_event_id") !== parentId || e.parent_event_id !== parentId) throw new ReportingJobError("read_reporting_children returned a row for another parent");
        if (prev !== null && compareUtf8(id, prev) <= 0) throw new ReportingJobError("read_reporting_children is not in keyset order");
        prev = id;
        return e;
      });
    },
    async stream(staff, direction, from: StreamPosition, limit) {
      if (!UUID.test(staff)) throw new ReportingJobError("staff must be a uuid");
      const rows = await call("read_reporting_staff_stream", { p_staff: staff, p_direction: direction, p_at: from.createdAt, p_at_event_id: from.id, p_limit: Math.min(limit, 1000) });
      // r6 R5: strictly away from the exclusive boundary in the requested direction, in (exact instant, bytewise id) order
      let prev: Pick<Ev, "created_at" | "id"> = { created_at: from.createdAt, id: from.id };
      const sign = direction === "before" ? -1 : 1;
      return rows.map((r) => {
        const e = imageToEvent(r.image, ref.site, str(r.event_id, "event_id"));
        if (e.staff_id !== staff) throw new ReportingJobError("read_reporting_staff_stream returned another worker's event");
        if (Math.sign(compareStream(e, prev)) !== sign) throw new ReportingJobError(`read_reporting_staff_stream is not in ${direction} keyset order`);
        prev = e;
        return e;
      });
    },
    async predecessorPage(staff, from, certain, limit) {
      if (!UUID.test(staff)) throw new ReportingJobError("staff must be a uuid");
      const fn = "read_reporting_predecessor_page";
      const rows = await call(fn, { p_staff: staff, p_at: from.createdAt, p_at_event_id: from.id, p_certain_at: certain?.createdAt ?? null, p_certain_event_id: certain?.id ?? null, p_limit: Math.min(limit, 1000) });
      // 0045 never returns zero rows (an empty page carries its end row; a cut keeps at least one): an empty response proves nothing.
      if (!rows.length) throw new ReportingJobError(`${fn} returned no rows (not even an end row)`);
      // The row grammar: lines in descending stream order strictly before `from`, each 'line_kids' followed by its own
      // children (ascending bytewise id), and an optional 'end' row last. Anything else is rejected, never repaired.
      const out: PredecessorRow[] = [];
      let line: Ev | null = null;
      let kidsOf: string | null = null;
      let lastKid: string | null = null;
      const fromEv = { created_at: from.createdAt, id: from.id };
      rows.forEach((r, i) => {
        const kind = r.row_kind;
        if (kind === "end") {
          if (i !== rows.length - 1 || r.event_id != null || r.image != null) throw new ReportingJobError(`${fn} returned a misplaced end row`);
          out.push({ kind: "end" });
          return;
        }
        const id = str(r.event_id, "event_id");
        const e = imageToEvent(r.image, ref.site, id);
        if (kind === "line" || kind === "line_kids") {
          if (e.staff_id !== staff) throw new ReportingJobError(`${fn} returned another worker's event`);
          if (compareStream(e, line ?? fromEv) >= 0) throw new ReportingJobError(`${fn} is not in descending keyset order`);
          line = e;
          kidsOf = kind === "line_kids" ? id : null;
          lastKid = null;
          out.push({ kind, ev: e });
          return;
        }
        if (kind !== "child") throw new ReportingJobError(`${fn} returned an unknown row kind`);
        if (kidsOf === null || e.parent_event_id !== kidsOf) throw new ReportingJobError(`${fn} returned a child of another line`);
        if (lastKid !== null && compareUtf8(id, lastKid) <= 0) throw new ReportingJobError(`${fn} children are not in keyset order`);
        lastKid = id;
        out.push({ kind: "child", ev: e });
      });
      return predecessorPageOf(out);
    },
    requests: () => n,
  };
}

// ---------------------------------------------------------------------------
// Task 15: cursor-resumable enumeration pages (one bounded call each)
// ---------------------------------------------------------------------------

/** One page of a resumable enumeration; an EMPTY page (only) means the end. */
export interface EnumerationPages {
  /** Refresh: changed keys strictly after `after` (bytewise id). */
  changedKeyPage(after: string | null): Promise<ChangedKey[]>;
  /** Rebuild: owners strictly after `after` ((kind, key) bytewise). */
  ownerPage(after: Owner | null): Promise<Owner[]>;
}

export function rpcEnumerationPages(client: RpcClient, ref: FrozenBatchRef): EnumerationPages {
  if (!UUID.test(ref.batchId)) throw new ReportingJobError("batchId must be a uuid");
  const call = async (fn: string, args: Record<string, unknown>): Promise<Array<Record<string, unknown>>> => {
    const { data, error } = await client.rpc(fn, { p_batch: ref.batchId, p_fence: ref.fence, ...args });
    if (error) throw new ReportingJobError(`${fn}: ${error.message}`, error.code ?? null);
    if (!Array.isArray(data)) throw new ReportingJobError(`${fn} returned no rows array`);
    if (data.length > 1000) throw new ReportingJobError(`${fn} returned more than 1,000 rows`);
    const bytes = responseBytes(data);
    if (bytes > MAX_RESPONSE_BYTES) throw new ReportingJobError(`${fn} returned ${bytes} bytes; a response must be at most ${MAX_RESPONSE_BYTES}`);
    return data as Array<Record<string, unknown>>;
  };
  return {
    async changedKeyPage(after) {
      if (ref.kind !== "refresh") throw new ReportingJobError("changed keys are a refresh read");
      const rows = await call("read_reporting_changed_keys", { p_after_event_id: after, p_limit: 1000 });
      let prev = after;
      return rows.map((r) => {
        const id = str(r.event_id, "event_id");
        if (prev !== null && compareUtf8(id, prev) <= 0) throw new ReportingJobError("read_reporting_changed_keys is not in keyset order");
        prev = id;
        return { id, before: r.before_image == null ? null : imageToEvent(r.before_image, ref.site, id), after: r.after_image == null ? null : imageToEvent(r.after_image, ref.site, id) };
      });
    },
    async ownerPage(after) {
      if (ref.kind !== "rebuild") throw new ReportingJobError("owners are a rebuild read");
      const rows = await call("list_reporting_owners", { p_after_kind: after?.partitionKind ?? null, p_after_key: after?.partitionKey ?? null, p_limit: 1000 });
      let prev = after;
      return rows.map((r) => {
        const kind = r.partition_kind;
        if (kind !== "order" && kind !== "event") throw new ReportingJobError("list_reporting_owners returned an unknown kind");
        const o: Owner = { partitionKind: kind, partitionKey: str(r.partition_key, "partition_key") };
        if (prev && compareUtf8(ownerKey(o), ownerKey(prev)) <= 0) throw new ReportingJobError("list_reporting_owners is not in keyset order");
        prev = o;
        return o;
      });
    },
  };
}
