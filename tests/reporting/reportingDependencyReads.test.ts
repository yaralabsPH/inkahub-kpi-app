/**
 * Task 14: the 0040 bounded dependency reads (SQL draft text) and the
 * production rpcFrozenReader that pages them. Offline: a fake RPC client
 * emulates the 0040 functions over an in-memory frozen view with tiny page
 * caps (as the 1 MiB byte cap can shorten pages), and the RPC-backed
 * materialization must equal the in-memory one exactly.
 */
import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareStream, diffFrozenViews, materializeBatch, memoryFrozenReader, MAX_PARTITION_EVENTS, ownerKey, ownerOfEvent, type ChangedKey, type Owner } from "../../api/_lib/production-reporting-materialize";
import { imageToEvent, rpcFrozenReader } from "../../api/_lib/production-reporting-reader";
import { compareUtf8 } from "../../api/_lib/reporting-stage";
import type { RpcClient } from "../../api/_lib/reporting-jobs";
import { canonicalJson } from "../../src/lib/domain/productionReporting";
import type { ProductionEvidenceEvent } from "../../src/lib/domain/productionCounts";
import { migrationBody } from "../staging/reportingPublication";

type Ev = ProductionEvidenceEvent;
const SITE = "uk";
const CUT = "2026-11-15T12:00:00.000000Z";
const BATCH = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FB = "INKA-KAN0566-A4-FB";
const M0040 = "supabase/migrations/0040_reporting_dependency_reads.sql";

function ev(id: string, type: string, order: string | null, staff: string, at: string, o: Partial<Ev> = {}): Ev {
  return { id, location: SITE, staff_id: staff, department: "framed", order_number: order, line_sku: type === "line_verified" ? FB : null, line_quantity: type === "line_verified" ? 1 : null, event_type: type, created_at: at, parent_event_id: null, cs_case_id: null, ...o };
}
/** The image as to_jsonb(production_events): the evidence fields plus raw-export fields the projector never reads. */
const image = (e: Ev) => ({ ...e, note: "raw export only", station_id: "st-1" });

/** A fake of the 0040 RPCs over one frozen view; `cap` rows per page, keyset exactly as the SQL. */
function fakeRpc(o: { view: Ev[]; changed: ChangedKey[]; kind: "refresh" | "rebuild"; cap: number }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const view = [...o.view];
  const client: RpcClient = {
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      if (args.p_batch !== BATCH || args.p_fence !== 7) return { data: null, error: { message: "fence is obsolete" } };
      const cap = Math.min(o.cap, (args.p_limit as number | undefined) ?? 1000);
      const ok = (data: unknown[]) => ({ data, error: null });
      switch (fn) {
        case "read_reporting_changed_keys": {
          const after = args.p_after_event_id as string | null;
          return ok(o.changed.filter((k) => after === null || compareUtf8(k.id, after) > 0).sort((x, y) => compareUtf8(x.id, y.id)).slice(0, cap)
            .map((k) => ({ event_id: k.id, before_image: k.before && image(k.before), after_image: k.after && image(k.after) })));
        }
        case "list_reporting_owners": {
          const all = new Map<string, Owner>();
          for (const e of view) all.set(ownerKey(ownerOfEvent(e)), ownerOfEvent(e));
          const sorted = [...all.values()].sort((x, y) => compareUtf8(ownerKey(x), ownerKey(y)));
          const ak = args.p_after_kind as string | null;
          const after = ak === null ? null : ownerKey({ partitionKind: ak as Owner["partitionKind"], partitionKey: args.p_after_key as string });
          return ok(sorted.filter((x) => after === null || compareUtf8(ownerKey(x), after) > 0).slice(0, cap).map((x) => ({ partition_kind: x.partitionKind, partition_key: x.partitionKey })));
        }
        case "read_reporting_owner_members": {
          const owners = args.p_owners as Array<[string, string]>;
          const ai = args.p_after_index as number | null;
          const aid = args.p_after_event_id as string | null;
          const rows: Array<{ owner_index: number; event_id: string; image: unknown }> = [];
          owners.forEach(([k, key], idx) => {
            for (const e of view.filter((x) => ownerKey(ownerOfEvent(x)) === ownerKey({ partitionKind: k as Owner["partitionKind"], partitionKey: key })).sort((x, y) => compareUtf8(x.id, y.id))) {
              if (ai === null || idx > ai || (idx === ai && aid !== null && compareUtf8(e.id, aid) > 0)) rows.push({ owner_index: idx, event_id: e.id, image: image(e) });
            }
          });
          return ok(rows.slice(0, cap));
        }
        case "read_reporting_events_by_id": {
          const ids = new Set(args.p_ids as string[]);
          return ok(view.filter((e) => ids.has(e.id)).sort((x, y) => compareUtf8(x.id, y.id)).slice(0, cap).map((e) => ({ event_id: e.id, image: image(e) })));
        }
        case "read_reporting_children": {
          const ids = new Set(args.p_parent_ids as string[]);
          const ap = args.p_after_parent_id as string | null;
          const aid = args.p_after_event_id as string | null;
          return ok(view.filter((e) => e.parent_event_id !== null && ids.has(e.parent_event_id))
            .sort((x, y) => compareUtf8(x.parent_event_id!, y.parent_event_id!) || compareUtf8(x.id, y.id))
            .filter((e) => ap === null || compareUtf8(e.parent_event_id!, ap) > 0 || (e.parent_event_id === ap && compareUtf8(e.id, aid!) > 0))
            .slice(0, cap).map((e) => ({ parent_event_id: e.parent_event_id, event_id: e.id, image: image(e) })));
        }
        case "read_reporting_staff_stream": {
          const at = { created_at: args.p_at as string, id: args.p_at_event_id as string };
          const dir = args.p_direction as string;
          const rows = view.filter((e) => e.staff_id === args.p_staff && (dir === "before" ? compareStream(e, at) < 0 : compareStream(e, at) > 0)).sort(compareStream);
          if (dir === "before") rows.reverse();
          return ok(rows.slice(0, cap).map((e) => ({ event_id: e.id, image: image(e) })));
        }
      }
      return { data: null, error: { message: `unknown function ${fn}` } };
    },
  };
  return { client, calls };
}
const ref = (kind: "refresh" | "rebuild") => ({ batchId: BATCH, fence: 7, site: SITE, cutoff: CUT, kind });

function history(seed: number, n: number): Ev[] {
  let s = seed >>> 0;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out: Ev[] = [];
  let t = Date.parse("2026-11-14T06:00:00Z");
  for (let i = 0; i < n; i++) {
    t += Math.floor(r() * 7) * 60_000;
    const at = new Date(t).toISOString().replace("Z", "000Z");
    const who = [A, B, C][Math.floor(r() * 3)];
    const roll = r();
    if (roll < 0.55) out.push(ev(`e${i}`, "line_verified", r() < 0.1 ? "  " : `RP-${Math.floor(r() * 5)}`, who, at, { department: r() < 0.8 ? "framed" : "unframed" }));
    else if (roll < 0.8 && out.length) {
      const p = out[Math.floor(r() * out.length)];
      out.push(ev(`e${i}`, "cancelled", r() < 0.5 ? null : p.order_number, who, at, { parent_event_id: p.id, department: p.department }));
    } else out.push(ev(`e${i}`, "completed", `RP-${Math.floor(r() * 5)}`, who, at));
  }
  return out;
}
const sig = (o: Awaited<ReturnType<typeof materializeBatch>>) => canonicalJson(o.works.map((w) => [w.desc, w.rows]));

describe("Task 14: rpcFrozenReader pages the 0040 reads exactly", () => {
  for (const cap of [1, 2, 5]) {
    it(`refresh and rebuild through the RPC reader (page cap ${cap}) equal the in-memory reader exactly`, async () => {
      for (const seed of [3, 11, 77]) {
        const before = history(seed, 40);
        const after = before.filter((_, i) => i % 7 !== 3).map((e, i) => (i % 9 === 4 ? { ...e, order_number: "RP-9" } : e));
        const changed = diffFrozenViews(before, after, CUT, CUT);
        const mem = await materializeBatch(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "refresh", view: after, changed }));
        const f = fakeRpc({ view: after, changed, kind: "refresh", cap });
        const viaRpc = await materializeBatch(rpcFrozenReader(f.client, ref("refresh")));
        const firstDiff = (x: typeof mem, y: typeof mem) => {
          for (let i = 0; i < Math.max(x.works.length, y.works.length); i++) {
            const a = canonicalJson(x.works[i] ? [x.works[i].desc, x.works[i].rows] : null);
            const b = canonicalJson(y.works[i] ? [y.works[i].desc, y.works[i].rows] : null);
            if (a !== b) return `#${i}\nrpc: ${a.slice(0, 600)}\nmem: ${b.slice(0, 600)}`;
          }
          return "";
        };
        expect(firstDiff(viaRpc, mem), `seed ${seed}`).toBe("");
        const memB = await materializeBatch(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view: after, changed: [] }));
        const fb = fakeRpc({ view: after, changed: [], kind: "rebuild", cap });
        expect(sig(await materializeBatch(rpcFrozenReader(fb.client, ref("rebuild")))), `rebuild seed ${seed}`).toBe(sig(memB));
        // Every call carries the batch and fence; none asks for more than 1,000 rows.
        for (const c of [...f.calls, ...fb.calls]) {
          expect(c.args.p_batch).toBe(BATCH);
          expect(c.args.p_fence).toBe(7);
          if (c.args.p_limit !== undefined) expect(c.args.p_limit as number).toBeLessThanOrEqual(1000);
          for (const k of ["p_ids", "p_parent_ids"]) if (c.args[k]) expect((c.args[k] as unknown[]).length).toBeLessThanOrEqual(1000);
          if (c.args.p_owners) expect((c.args.p_owners as unknown[]).length).toBeLessThanOrEqual(100);
        }
      }
    });
  }

  it("a member overflow (cap+1) is proven with a bounded read and the rest of that owner is skipped", async () => {
    const big: Ev[] = [];
    for (let i = 0; i < 12; i++) big.push(ev(`n${String(i).padStart(2, "0")}`, "note_added", "RP-BIG", A, "2026-11-15T08:00:00Z"));
    big.push(ev("z1", "note_added", "RP-Z", A, "2026-11-15T08:00:00Z"));
    const f = fakeRpc({ view: big, changed: [], kind: "rebuild", cap: 2 });
    const reader = rpcFrozenReader(f.client, ref("rebuild"));
    const m = await reader.members([{ partitionKind: "order", partitionKey: "RP-BIG" }, { partitionKind: "order", partitionKey: "RP-Z" }], 3);
    expect(m.get(ownerKey({ partitionKind: "order", partitionKey: "RP-BIG" }))!.map((e) => e.id)).toEqual(["n00", "n01", "n02", "n03"]); // cap+1
    expect(m.get(ownerKey({ partitionKind: "order", partitionKey: "RP-Z" }))!.map((e) => e.id)).toEqual(["z1"]);
    const calls = f.calls.filter((c) => c.fn === "read_reporting_owner_members");
    expect(calls.length).toBeLessThanOrEqual(5); // never pages through the whole oversized owner
    expect(calls.some((c) => c.args.p_after_index === 0 && c.args.p_after_event_id === null)).toBe(true); // skipped to the next owner
    expect(MAX_PARTITION_EVENTS).toBe(50_000);
  });

  it("byIds re-requests only the ids after a byte-capped response; absent ids end the loop", async () => {
    const view = ["a", "b", "c", "d", "e"].map((id) => ev(id, "completed", "RP-1", A, "2026-11-15T08:00:00Z"));
    const f = fakeRpc({ view, changed: [], kind: "rebuild", cap: 2 });
    const got = await rpcFrozenReader(f.client, ref("rebuild")).byIds(["e", "a", "x", "c", "zz"]);
    expect([...got.keys()].sort()).toEqual(["a", "c", "e"]);
    const reqs = f.calls.filter((c) => c.fn === "read_reporting_events_by_id").map((c) => c.args.p_ids);
    expect(reqs).toEqual([["a", "c", "e", "x", "zz"], ["e", "x", "zz"], ["x", "zz"]]);
  });

  it("images are reduced to the exact evidence fields and bound to the site and id", () => {
    const e = ev("v1", "line_verified", "RP-1", A, "2026-11-15T08:00:00Z");
    expect(imageToEvent(image(e), SITE, "v1")).toEqual(e); // note/station_id dropped
    expect(() => imageToEvent(image(e), "au", "v1")).toThrow(/belongs to uk, not au/);
    expect(() => imageToEvent(image(e), SITE, "v2")).toThrow(/does not match/);
    expect(() => imageToEvent({ ...image(e), created_at: 5 }, SITE)).toThrow(/created_at must be text/);
  });

  it("RPC errors and malformed responses fail visibly", async () => {
    const bad: RpcClient = { rpc: async () => ({ data: null, error: { message: "reporting batch x fence 6 is obsolete (current 7)", code: "P0001" } }) };
    await expect(rpcFrozenReader(bad, ref("rebuild")).byIds(["a"])).rejects.toThrow(/read_reporting_events_by_id: reporting batch x fence 6 is obsolete/);
    const unordered: RpcClient = { rpc: async () => ({ data: [{ event_id: "b", before_image: null, after_image: null }, { event_id: "a", before_image: null, after_image: null }], error: null }) };
    const it1 = rpcFrozenReader(unordered, ref("refresh")).changedKeys()[Symbol.asyncIterator]();
    await it1.next();
    await expect(it1.next()).rejects.toThrow(/keyset order/);
    const other: RpcClient = { rpc: async () => ({ data: [{ event_id: "s", image: image(ev("s", "completed", "RP", B, "2026-11-15T08:00:00Z")) }], error: null }) };
    await expect(rpcFrozenReader(other, ref("rebuild")).stream(A, "before", { createdAt: CUT, id: "" }, 10)).rejects.toThrow(/another worker/);
    expect(() => rpcFrozenReader(bad, { ...ref("rebuild"), batchId: "nope" })).toThrow(/uuid/);
  });
});

// ---------------------------------------------------------------------------
// The 0040 draft (text contract; it is NOT applied by the coder)
// ---------------------------------------------------------------------------

describe("Task 14: 0040 draft migration contract", () => {
  const sql = readFileSync(M0040, "utf8").replace(/\r\n/g, "\n");
  const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  const fns = ["read_reporting_changed_keys", "list_reporting_owners", "read_reporting_owner_members", "read_reporting_events_by_id", "read_reporting_children", "read_reporting_staff_stream"];
  const fnBody = (name: string) => {
    const i = code.indexOf(`CREATE FUNCTION public.${name}(`);
    return code.slice(i, code.indexOf("$fn$;", i));
  };

  it("is the allocated next number, one transaction, with every statement parseable", () => {
    expect(existsSync(M0040)).toBe(true);
    expect(existsSync("supabase/migrations/0041_reporting_reads.sql")).toBe(false);
    expect(code.trim().startsWith("BEGIN;")).toBe(true);
    expect(code.trim().endsWith("COMMIT;")).toBe(true);
    const body = migrationBody(sql);
    expect(body.length).toBe(4 + 7 + 14); // indexes, functions, revoke/grant pairs
  });

  it("every read is service-only SECURITY INVOKER with an empty search_path, validates a FROZEN batch under the batch locks first", () => {
    expect(code).toContain("b := reporting_private.lock_batch(p_batch, p_fence, true);");
    expect(code).toMatch(/IF b\.state <> 'frozen' OR b\.source_cutoff IS NULL THEN/);
    for (const f of fns) {
      const body = fnBody(f);
      expect(body, f).toMatch(/SECURITY INVOKER\nSET search_path = ''/);
      expect(body, f).toMatch(/BEGIN\n  b := reporting_private\.frozen_read_batch\(p_batch, p_fence\);/);
      expect(code, f).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`));
      expect(code, f).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${f}\\([^)]*\\) TO service_role;`));
    }
    expect(code.match(/SECURITY DEFINER/g)).toBeNull();
  });

  it("reads only: no data writes, no DDL beyond the four reporting indexes, no timeout or planner settings, no OFFSET", () => {
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/);
    expect(code).not.toMatch(/\b(DROP|ALTER)\b/);
    expect(code).not.toMatch(/statement_timeout|lock_timeout|set_config|SET LOCAL|enable_\w+|\bOFFSET\b/i);
    expect(code.match(/CREATE INDEX/g)).toHaveLength(4);
    for (const m of code.matchAll(/CREATE INDEX \w+ ON (\S+)/g)) expect(m[1]).toMatch(/^reporting_private\./);
    expect(code).not.toMatch(/public\.production_events/); // the frozen view only, never the live source
  });

  it("every page is bounded: ≤1,000 rows, ≤1 MiB of images, an oversized single image fails visibly, keyset in bytewise order", () => {
    for (const f of fns.filter((x) => x !== "list_reporting_owners")) {
      const body = fnBody(f);
      expect(body, f).toContain("IF v_size > 1048576 THEN RAISE EXCEPTION");
      expect(body, f).toContain("EXIT WHEN v_bytes > 1048576;");
      expect(body, f).toMatch(/COLLATE "C"/);
    }
    for (const f of fns.filter((x) => x !== "read_reporting_events_by_id")) expect(fnBody(f), f).toContain("IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION");
    expect(fnBody("read_reporting_events_by_id")).toContain("pg_catalog.cardinality(p_ids) > 1000");
    expect(fnBody("read_reporting_children")).toContain("pg_catalog.cardinality(p_parent_ids) > 1000");
    expect(fnBody("read_reporting_owner_members")).toContain("pg_catalog.jsonb_array_length(p_owners) > 100");
  });

  it("refresh reads overlay the base mirror with the batch's frozen images; rebuild reads the frozen candidate", () => {
    for (const f of ["read_reporting_owner_members", "read_reporting_events_by_id", "read_reporting_children", "read_reporting_staff_stream"]) {
      const body = fnBody(f);
      expect(body, f).toContain("reporting_private.batch_events be");
      expect(body, f).toContain("NOT EXISTS (SELECT 1 FROM reporting_private.batch_events be WHERE be.batch_id = b.batch_id AND be.site = b.site AND be.event_id = s.event_id)");
      expect(body, f).toContain("reporting_private.source_candidate sc");
      expect(body, f).toContain("b.kind = 'rebuild'");
    }
    expect(fnBody("read_reporting_changed_keys")).toContain("LEFT JOIN reporting_private.source_current sc ON sc.site = b.site AND sc.event_id = be.event_id");
    expect(fnBody("read_reporting_owner_members")).toContain("reporting_private.owner_partition(be.image)");
  });
});
