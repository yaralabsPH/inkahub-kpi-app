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
import { ownerKey, type ChangedKey, type FrozenReader, type Owner, type StreamPosition } from "./production-reporting-materialize.js";

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

export function rpcFrozenReader(client: RpcClient, ref: FrozenBatchRef): FrozenReader {
  if (!UUID.test(ref.batchId)) throw new ReportingJobError("batchId must be a uuid");
  if (!Number.isSafeInteger(ref.fence) || ref.fence < 1) throw new ReportingJobError("fence must be a positive integer");
  let n = 0;
  const call = async (fn: string, args: Record<string, unknown>): Promise<Array<Record<string, unknown>>> => {
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
  return {
    site: ref.site, cutoff: ref.cutoff, kind: ref.kind,
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
      const out = new Map<string, Ev[]>(owners.map((o) => [ownerKey(o), []]));
      for (let g = 0; g < owners.length; g += 100) {
        const group = owners.slice(g, g + 100);
        const pairs = group.map((o) => [o.partitionKind, o.partitionKey]);
        let afterIndex: number | null = null;
        let afterId: string | null = null;
        for (;;) {
          const rows = await call("read_reporting_owner_members", { p_owners: pairs, p_after_index: afterIndex, p_after_event_id: afterId, p_limit: 1000 });
          if (!rows.length) break;
          for (const r of rows) {
            const idx = r.owner_index;
            if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= group.length) throw new ReportingJobError("read_reporting_owner_members returned a bad owner_index");
            const id = str(r.event_id, "event_id");
            const list = out.get(ownerKey(group[idx]))!;
            list.push(imageToEvent(r.image, ref.site, id));
            afterIndex = idx;
            afterId = id;
            if (list.length > cap) {
              afterId = null; // cap+1 proves the overflow: skip the rest of THIS owner (keyset (idx, NULL) = next owner)
              break;
            }
          }
        }
      }
      return out;
    },
    async byIds(ids) {
      const out = new Map<string, Ev>();
      const want = [...new Set(ids)].sort(compareUtf8);
      for (let g = 0; g < want.length; g += 500) {
        let pending = want.slice(g, g + 500);
        while (pending.length) {
          const rows = await call("read_reporting_events_by_id", { p_ids: pending });
          if (!rows.length) break; // the remaining ids are absent
          let last = "";
          for (const r of rows) {
            const id = str(r.event_id, "event_id");
            if (!pending.includes(id)) throw new ReportingJobError(`read_reporting_events_by_id returned an id that was not requested`);
            out.set(id, imageToEvent(r.image, ref.site, id));
            last = id;
          }
          // A byte-capped response stops early: request again only the ids after the last returned one.
          pending = pending.filter((id) => compareUtf8(id, last) > 0);
        }
      }
      return out;
    },
    async *children(parentIds) {
      // Lazy: the next page is requested only when the consumer asks for more (a budget overflow stops reading at once).
      const ids = [...new Set(parentIds)].sort(compareUtf8);
      for (let g = 0; g < ids.length; g += 1000) {
        const group = ids.slice(g, g + 1000);
        let afterParent: string | null = null;
        let afterId: string | null = null;
        for (;;) {
          const rows = await call("read_reporting_children", { p_parent_ids: group, p_after_parent_id: afterParent, p_after_event_id: afterId, p_limit: 1000 });
          if (!rows.length) break;
          for (const r of rows) {
            const parent = str(r.parent_event_id, "parent_event_id");
            const id = str(r.event_id, "event_id");
            const e = imageToEvent(r.image, ref.site, id);
            if (e.parent_event_id !== parent || !group.includes(parent)) throw new ReportingJobError("read_reporting_children returned a row for another parent");
            if (afterParent !== null && (compareUtf8(parent, afterParent) < 0 || (parent === afterParent && compareUtf8(id, afterId!) <= 0))) throw new ReportingJobError("read_reporting_children is not in keyset order");
            afterParent = parent;
            afterId = id;
            yield e;
          }
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
      return rows.map((r) => {
        const e = imageToEvent(r.image, ref.site, str(r.event_id, "event_id"));
        if (e.staff_id !== staff) throw new ReportingJobError("read_reporting_staff_stream returned another worker's event");
        return e;
      });
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
