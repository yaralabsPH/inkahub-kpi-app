/**
 * T15P-4a: the 0046 owner-input protocol over real SQL (PGlite, migrations
 * 0037-0046 applied by the shared harness). The batch is prepared directly
 * through the sanctioned 0038/0043 adapters the worker itself uses (begin,
 * copy, freeze, save enumeration): a deterministic frozen batch with six
 * discovered owners and a live lease, with no worker loop and no retries.
 * Offline only: no hosted database is involved.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { beginReportingRebuild, copyReportingSourcePage, freezeReportingRebuild } from "../../../api/_lib/reporting-jobs";
import { saveEnumeration } from "../../../api/_lib/reporting-worker-state";
import { newRuntimeOwnership, OWNERSHIP_SQL, ownershipParams, runtimeAuditProblems, SITE_ATTRIBUTION, stableHashes, stableHashSql } from "../../staging/reportingWorkerRuntime";
import { reportingDb } from "./harness";
import { pgRpc } from "./rpc";
import { pgDb, smallState } from "./runtimeFixtures";

const SITE = "au";
const W = "00000005-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P = 196_608;
const esc = (s: string) => Buffer.byteLength(JSON.stringify(s));

/** The one piece rule (r5 §2): maximal pieces whose escaped literal is <= P bytes, split by code point. */
function split(text: string): string[] {
  const out: string[] = [];
  // Linear: the escaped length of a JSON string literal is 2 (quotes) plus the sum of each
  // code point's escaped length, so track it incrementally instead of re-stringifying.
  let cur: string[] = [];
  let len = 2;
  for (const ch of text) {
    const w = esc(ch) - 2;
    if (cur.length && len + w > P) {
      out.push(cur.join(""));
      cur = [ch];
      len = 2 + w;
    } else {
      cur.push(ch);
      len += w;
    }
  }
  if (cur.length) out.push(cur.join(""));
  return out;
}
const KEYS = ["id", "location", "staff_id", "department", "order_number", "line_sku", "line_quantity", "event_type", "created_at", "parent_event_id", "cs_case_id"] as const;
type Ev = Record<(typeof KEYS)[number], unknown>;
const text = (e: Ev) => JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, e[k]])));
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
/** Piece entries for events starting at ordinal `from` (first piece carries metadata). */
function entries(events: Ev[], from: number, candidate: (e: Ev) => boolean = () => false): unknown[] {
  const out: unknown[] = [];
  events.forEach((e, i) => {
    const t = text(e);
    const ps = split(t);
    ps.forEach((p, n) => {
      if (n === 0) out.push([from + i, 0, p, { event_id: e.id, pieces: ps.length, text_bytes: Buffer.byteLength(t), text_sha256: sha(t), src_at: e.created_at, stream_candidate: candidate(e) }]);
      else out.push([from + i, n, p]);
    });
  });
  return out;
}
const ev = (id: string, o: Partial<Ev> = {}): Ev => ({ id, location: SITE, staff_id: W, department: "framed", order_number: "OI-1", line_sku: "INKA-KAN0566-A4-FB", line_quantity: 1, event_type: "line_verified", created_at: "2026-10-01T00:00:00.000000Z", parent_event_id: null, cs_case_id: null, ...o });
const S = {
  members: (afterOrd: number | null) => ({ v: 1, step: "members", m: { afterOrd } }),
  parents: (group: number, afterOrd: number | null) => ({ v: 1, step: "parents", p: { group, afterOrd } }),
  children: (group: number, afterOrd: number | null) => ({ v: 1, step: "children", c: { group, afterOrd } }),
  walk: (worker: number, need: string[], o: { cursorOrd?: number | null; stopAt?: string | null; line?: unknown } = {}) => ({ v: 1, step: "walk", w: { worker, cursorOrd: o.cursorOrd ?? null, stopAt: o.stopAt ?? null, need, line: o.line ?? null } }),
  done: { v: 1, step: "done" },
};

let db: PGlite;
let batch = "";
let fence = 0;
const svc = () => pgRpc(db);
async function call(fn: string, a: Record<string, unknown>, role?: string) {
  const r = await pgRpc(db, role ? { role } : {}).rpc(fn, a);
  if (r.error) throw new Error(r.error.message);
  return r.data as Array<Record<string, unknown>>;
}
const base = () => ({ p_batch: batch, p_fence: fence });
async function open(kind: string, key: string, purpose = "plan") {
  return (await call("open_reporting_owner_input", { ...base(), p_kind: kind, p_key: key, p_purpose: purpose }))[0];
}
async function cp(handle: string, seq: string, payload: unknown) {
  return (await call("checkpoint_reporting_owner_input", { ...base(), p_handle: handle, p_expected_seq: seq, p_payload: payload }))[0];
}

beforeAll(async () => {
  db = await reportingDb();
  await db.query("insert into auth.users (id, email) values ($1, 'oi@x')", [W]);
  const ins = `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, parent_event_id)
    values ('au', $1, $2, 'framed', $3, 'INKA-KAN0566-A4-FB', 1, 'line_verified', 's', '', $4, null)`;
  for (let i = 0; i < 6; i++) await db.query(ins, [`oi-${i}`, W, `OI-${i}`, new Date(Date.parse("2026-10-01T00:00:00Z") + i * 60_000).toISOString()]);
  const c = svc();
  expect((await c.rpc("set_reporting_capture", { p_enabled: true })).error).toBeNull();
  expect((await c.rpc("set_reporting_site_mode", { p_site: SITE, p_read_mode: null, p_processor_enabled: true })).error).toBeNull();
  // Deterministic frozen batch through the SAME sanctioned adapters the worker uses (no worker loop, no retries):
  // begin a rebuild, copy every source page, freeze, then save the enumeration exactly as the worker's rebuild path does.
  const r = await beginReportingRebuild(c, SITE);
  batch = r.batchId;
  fence = r.leaseFence;
  let after: string | null = null;
  for (let i = 0; i < 100; i++) {
    const p = await copyReportingSourcePage(c, batch, fence, after);
    if (p.complete) break;
    after = p.nextAfterEventId;
  }
  await freezeReportingRebuild(c, batch, fence);
  const owners = Array.from({ length: 6 }, (_, i) => ({ owner: { partitionKind: "order" as const, partitionKey: `OI-${i}` }, oldStaff: [] as string[] }));
  const last: ["order", string] = ["order", "OI-5"];
  await saveEnumeration(c, batch, fence, null, { kind: "rebuild", after: last }, owners, false);
  await saveEnumeration(c, batch, fence, { kind: "rebuild", after: last }, { kind: "rebuild", after: last, end: true }, [], true);
  const st = (await db.query<{ state: string; n: number }>("select b.state, (select count(*)::int from reporting_private.worker_owners o where o.batch_id = b.batch_id) as n from reporting_private.batches b where b.batch_id = $1", [batch])).rows[0];
  expect(st).toEqual({ state: "frozen", n: 6 });
  await db.query("update reporting_private.batches set lease_expires_at = now() + interval '1 hour' where batch_id = $1", [batch]);
}, 300_000);
afterAll(async () => db?.close());

describe("migration and access", () => {
  it("leaves 0037-0045 byte-identical (pinned SHA-256)", () => {
    const pins: Record<string, string> = {
      "0037_reporting_storage": "531bb2c5706b9ac4d73a7ca3dc74dead7e34a53160e57fe2971aaf061c6a6a4f",
      "0038_reporting_jobs": "002d6e58034aef1c83f94863bb89ce83dadeb225106cd804d2a46798193dd68f",
      "0039_reporting_rebuild_insert": "05d7eff179993a6eeeba3fadaddd345b83bd20c68676cb6bda709937984c3bd5",
      "0040_reporting_dependency_reads": "4e39243e2ee6526f656eb1b462156d6bc9eabf17cac78fcb2d873cd4498968b2",
      "0041_reporting_dependency_read_bounds": "dfa49d597cc37cef92314a4d2dcaf79d195949741fc0534fc57345c12f419646",
      "0042_reporting_access_paths": "e38aba760a19a70fa3afdddd5155244fb94acb73a53362855d1f63b1a3536a1c",
      "0043_reporting_worker_state": "156ee4d525433c8999c52d83ac4175c44629ce6a8f848796a5638ed944c7f633",
      "0044_reporting_reads": "84a07d1bd61d2e69df66bf6efa437f541a184512cb1820cc75217db20e5c9b07",
      "0045_reporting_predecessor_page": "5f42f300ba391aa36845329e53d39581a56d4e60c94ab342bb95f91fe8ccefb8",
    };
    for (const [f, h] of Object.entries(pins)) {
      const lf = readFileSync(`supabase/migrations/${f}.sql`, "utf8").replace(/\r\n/g, "\n");
      expect(createHash("sha256").update(lf).digest("hex"), f).toBe(h);
    }
  });

  it("tables have RLS and no PUBLIC/anon/authenticated access; every function is invoker, empty search_path, service-only", async () => {
    const t = await db.query<{ relname: string; rls: boolean; anon: boolean; auth: boolean; svc: boolean }>(
      `select c.relname, c.relrowsecurity as rls, has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as anon,
              has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as auth, has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as svc
         from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'reporting_private' and c.relkind = 'r' and c.relname like 'owner_input%'`);
    expect(t.rows.map((r) => r.relname).sort()).toEqual(["owner_input_events", "owner_input_pieces", "owner_inputs"]);
    for (const r of t.rows) expect(r).toMatchObject({ rls: true, anon: false, auth: false, svc: true });
    const f = await db.query<{ name: string; definer: boolean; config: string; anon: boolean; auth: boolean; svc: boolean; pub: boolean }>(
      `select n.nspname || '.' || p.proname as name, p.prosecdef as definer, coalesce(array_to_string(p.proconfig, ','), '') as config,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as svc,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as pub
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where (n.nspname = 'reporting_private' and p.proname like 'oi\\_%') or (n.nspname = 'public' and (p.proname like '%owner_input%' or p.proname in ('read_reporting_staged_chunks')))`);
    expect(f.rows.length).toBeGreaterThanOrEqual(25);
    for (const r of f.rows) expect(r, r.name).toMatchObject({ definer: false, config: 'search_path=""', anon: false, auth: false, svc: true, pub: false });
  });

  it("anon and authenticated sessions (owner/manager/staff/kiosk/CS claims) cannot call the protocol", async () => {
    for (const role of ["anon", "authenticated"]) {
      await expect(call("reporting_owner_input_version", {}, role)).rejects.toThrow(/permission denied/);
      await expect(call("open_reporting_owner_input", { ...base(), p_kind: "order", p_key: "OI-0", p_purpose: "plan" }, role)).rejects.toThrow(/permission denied/);
    }
  });

  it("version is 1", async () => {
    expect(await call("reporting_owner_input_version", {})).toEqual([{ version: 1 }]);
  });
});

describe("open, lookup, header", () => {
  it("open is idempotent, starts at seq 0, and lookup returns one row per requested owner", async () => {
    const a = await open("order", "OI-1");
    expect(a).toMatchObject({ created: true, phase: "reading", seq: "0", reload_calls: 2, heavy_proven: false, pending_events: 0 });
    const b = await open("order", "OI-1");
    expect(b).toMatchObject({ handle: a.handle, created: false });
    const l = await call("lookup_reporting_owner_inputs", { ...base(), p_owners: [["order", "OI-1"], ["order", "OI-2"]] });
    expect(l).toHaveLength(2);
    expect(l[0]).toMatchObject({ idx: 0, handle: a.handle, seq: "0" });
    expect(l[1]).toMatchObject({ idx: 1, handle: null });
    const h = (await call("load_reporting_owner_input_header", { ...base(), p_handle: a.handle }))[0];
    expect(h).toMatchObject({ phase: "reading", purpose: "plan", seq: "0", state: S.members(null), event_count: 0 });
  });

  it("refuses an undiscovered owner, a bad purpose, a wrong fence and a foreign handle", async () => {
    await expect(open("order", "NOPE")).rejects.toThrow(/owner_input_args/);
    await expect(open("order", "OI-2", "nonsense")).rejects.toThrow(/owner_input_args/);
    await expect(open("order", "OI-2", "stage")).rejects.toThrow(/owner_input_transition: stage writes need a sealed batch/);
    await expect(call("open_reporting_owner_input", { p_batch: batch, p_fence: fence + 1, p_kind: "order", p_key: "OI-2", p_purpose: "plan" })).rejects.toThrow(/obsolete/);
    await expect(call("load_reporting_owner_input_header", { ...base(), p_handle: "999999999" })).rejects.toThrow(/owner_input_args/);
    await expect(call("load_reporting_owner_input_header", { ...base(), p_handle: "9223372036854775808" })).rejects.toThrow(/owner_input_args/);
  });
});

describe("pages, graph and replay (one owner, one member, no parents, no children)", () => {
  let h = "";
  let seq = "0";
  const line = ev("oi-1", { order_number: "OI-1", created_at: "2026-10-01T00:01:00.000000Z" });
  it("members page with inline pieces commits atomically and advances the cursor", async () => {
    h = String((await open("order", "OI-1")).handle);
    const r = await cp(h, seq, { kind: "page", pieces: entries([line], 1, () => true), steps: [S.members(1)] });
    expect(r).toMatchObject({ seq: "1", event_count: 1, pending_events: 0, replay: false, heavy: false });
    seq = "1";
  });
  it("an identical replay returns the same result without a write; a different payload at the old seq conflicts", async () => {
    const again = await cp(h, "0", { kind: "page", pieces: entries([line], 1, () => true), steps: [S.members(1)] });
    expect(again).toMatchObject({ seq: "1", replay: true });
    await expect(cp(h, "0", { kind: "page", steps: [S.members(null)] })).rejects.toThrow(/owner_input_conflict/);
  });
  it("the empty members page moves through zero parent groups and zero-row children into the walk, in one call", async () => {
    // one member line of worker W (a stream candidate): parents none -> children group 0 (1 member) -> after its empty page -> walk
    const r = await cp(h, seq, { kind: "page", steps: [S.parents(0, null), S.children(0, null)], members_count: 1 });
    expect(r).toMatchObject({ seq: "2", event_count: 1 });
    seq = "2";
    const r2 = await cp(h, seq, { kind: "page", steps: [S.walk(0, ["*", "framed"])] });
    expect(r2.seq).toBe("3");
    seq = "3";
  });
  it("rejects a skipped phase, a premature done, a wrongly initialised worker and a forged pending line", async () => {
    // SQL owns structure: `done` with a pending line (or before the last worker) is premature. Whether the
    // worker's stream has truly ended is source order, which the plan (R5 table) assigns to the adapter.
    const pending = S.walk(0, ["*", "framed"], { line: { ord: 1, afterKidOrd: null, phase: "kids", effective: null } });
    await expect(cp(h, seq, { kind: "page", steps: [pending, S.done] })).rejects.toThrow(/owner_input_transition: the walk is not finished/);
    await expect(cp(h, seq, { kind: "page", steps: [S.walk(1, ["*"])] })).rejects.toThrow(/owner_input_transition: next worker/);
    await expect(cp(h, seq, { kind: "page", steps: [S.walk(0, ["*", "framed"], { line: { ord: 9, afterKidOrd: null, phase: "kids", effective: null } })] })).rejects.toThrow(/owner_input_invalid: the pending line is not a stream candidate/);
  });
  it("walks the line: pending kids -> done -> cursor -> worker end -> done, as one page's steps", async () => {
    const need = ["*", "framed"];
    const steps = [
      S.walk(0, need, { line: { ord: 1, afterKidOrd: null, phase: "kids", effective: null } }),
      S.walk(0, need, { line: { ord: 1, afterKidOrd: null, phase: "done", effective: true } }),
      S.walk(0, need, { cursorOrd: 1 }),
      S.done,
    ];
    // a done line must not change afterKidOrd without a kid page; here there are no kids, so done keeps null
    const r = await cp(h, seq, { kind: "page", steps });
    expect(r.seq).toBe("4");
    seq = "4";
  });
  it("hashing requires the exact audience set, then the next hashes in order, then the journal is immutable", async () => {
    const aud = [{ audienceKind: "site", audienceStaff: null }, { audienceKind: "self", audienceStaff: W }];
    await expect(cp(h, seq, { kind: "hash", audiences: [aud[0]], hashes: [{ ...aud[0], inputHash: "a".repeat(64) }] })).rejects.toThrow(/required set/);
    const r = await cp(h, seq, { kind: "hash", audiences: aud, hashes: [{ ...aud[0], inputHash: "a".repeat(64) }] });
    expect(r.seq).toBe("5");
    await expect(cp(h, "5", { kind: "hash", hashes: [{ ...aud[0], inputHash: "b".repeat(64) }] })).rejects.toThrow(/not the next audience/);
    const done = { kind: "hash", hashes: [{ ...aud[1], inputHash: "b".repeat(64) }] };
    expect((await cp(h, "5", done)).seq).toBe("6");
    expect((await call("load_reporting_owner_input_header", { ...base(), p_handle: h }))[0]).toMatchObject({ phase: "complete", hashes_done: 2 });
    expect(await cp(h, "5", done)).toMatchObject({ replay: true, seq: "6" }); // lost final response: identical replay
    await expect(cp(h, "6", { kind: "discard_pending" })).rejects.toThrow(/immutable/);
  });
});

describe("pieces, pending pages, discard, snapshot loads", () => {
  it("splits a backslash-heavy event into maximal pieces, commits over several calls, reloads byte-exactly", async () => {
    const big = ev("oi-big", { order_number: "OI-2", line_sku: "\\".repeat(200_000), created_at: "2026-10-01T00:02:00.000000Z" });
    const t = text(big);
    const ps = split(t);
    expect(ps.length).toBeGreaterThan(1);
    for (const p of ps) expect(esc(p)).toBeLessThanOrEqual(P);
    const h = String((await open("order", "OI-2")).handle);
    const all = entries([big], 1);
    const r1 = await cp(h, "0", { kind: "pieces", pieces: [all[0]] });
    expect(r1).toMatchObject({ seq: "1", event_count: 0, pending_events: 1, pending_pieces: 1 });
    const r2 = await cp(h, "1", { kind: "page", pieces: all.slice(1), steps: [S.members(1)] });
    expect(r2).toMatchObject({ seq: "2", event_count: 1, pending_events: 0 });
    const head = (await call("load_reporting_owner_input_header", { ...base(), p_handle: h }))[0];
    let rows: Array<Record<string, unknown>> = [];
    let after = [0, -1];
    let calls = 1;
    for (;;) {
      const page = await call("load_reporting_owner_input_events", { ...base(), p_handle: h, p_seq: String(head.seq), p_after_ord: after[0], p_after_piece: after[1] });
      calls++;
      if (page.length === 1 && page[0].eof === true) break;
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1_048_576);
      rows = rows.concat(page);
      after = [Number(page.at(-1)!.ord), Number(page.at(-1)!.piece_no)];
    }
    expect(calls).toBe(Number(head.reload_calls));
    const back = rows.map((r) => r.piece).join("");
    expect(back).toBe(t);
    expect(sha(back)).toBe(rows[0].text_sha256);
    await expect(call("load_reporting_owner_input_events", { ...base(), p_handle: h, p_seq: "1", p_after_ord: 0, p_after_piece: -1 })).rejects.toThrow(/owner_input_snapshot/);
  });

  it("rejects a non-maximal piece, a gap, a duplicate id, malformed metadata and a forged stream candidate", async () => {
    const h = String((await open("order", "OI-3")).handle);
    const e = ev("oi-3x", { order_number: "OI-3", line_sku: "x".repeat(250_000) });
    const t = text(e);
    const tiny = [[1, 0, t.slice(0, 10), { event_id: e.id, pieces: 2, text_bytes: Buffer.byteLength(t), text_sha256: sha(t), src_at: e.created_at, stream_candidate: false }], [1, 1, t.slice(10)]];
    await expect(cp(h, "0", { kind: "pieces", pieces: tiny })).rejects.toThrow(/owner_input_invalid/); // second piece too long, or first not maximal
    await expect(cp(h, "0", { kind: "pieces", pieces: entries([ev("g1")], 2) })).rejects.toThrow(/not contiguous/);
    await expect(cp(h, "0", { kind: "pieces", pieces: [[1, 0, "x", { event_id: "y" }]] })).rejects.toThrow(/bad event metadata/);
    const forged = entries([ev("oi-f", { order_number: "   " })], 1, () => true);
    await expect(cp(h, "0", { kind: "page", pieces: forged, steps: [S.members(1)] })).rejects.toThrow(/cannot be a stream candidate/);
    const nbsp = entries([ev("oi-f2", { staff_id: "  " })], 1, () => true);
    await expect(cp(h, "0", { kind: "page", pieces: nbsp, steps: [S.members(1)] })).rejects.toThrow(/cannot be a stream candidate/);
    const after = await cp(h, "0", { kind: "page", pieces: entries([ev("oi-ok", { order_number: "OI-3" })], 1, () => true), steps: [S.members(1)] });
    expect(after.seq).toBe("1");
    await expect(cp(h, "1", { kind: "page", pieces: entries([ev("oi-ok")], 2), steps: [S.members(2)] })).rejects.toThrow(/already in the journal/);
  });

  it("discard_pending removes an unfinished page; a fresh process then redoes it", async () => {
    const h = String((await open("order", "OI-4")).handle);
    const big = ev("oi-4b", { order_number: "OI-4", line_sku: "y".repeat(300_000) });
    const all = entries([big], 1);
    await cp(h, "0", { kind: "pieces", pieces: [all[0]] });
    const d = await cp(h, "1", { kind: "discard_pending" });
    expect(d).toMatchObject({ seq: "2", pending_events: 0, pending_pieces: 0, event_count: 0 });
    const n = (await db.query<{ n: number }>("select count(*)::int as n from reporting_private.owner_input_events where handle = $1", [h])).rows[0].n;
    expect(n).toBe(0);
    const r = await cp(h, "2", { kind: "page", pieces: all, steps: [S.members(1)] });
    expect(r).toMatchObject({ seq: "3", event_count: 1 });
  });
});

describe("packer", () => {
  it("starts a new page at 1,000 rows or when the next row would exceed 1 MiB (brackets and separators included)", async () => {
    const q = async (pages: number, rows: number, bytes: number, row: number) =>
      (await db.query<{ pages: number; rows: number; bytes: number }>("select * from reporting_private.oi_pack($1, $2, $3, $4)", [pages, rows, bytes, row])).rows[0];
    expect(await q(0, 0, 0, 100)).toEqual({ pages: 1, rows: 1, bytes: 102 });
    expect(await q(1, 1, 102, 100)).toEqual({ pages: 1, rows: 2, bytes: 203 });
    expect(await q(1, 1000, 5000, 1)).toEqual({ pages: 2, rows: 1, bytes: 3 });
    expect(await q(1, 3, 1_048_500, 100)).toEqual({ pages: 2, rows: 1, bytes: 102 });
    expect(await q(1, 3, 1_048_475, 100)).toEqual({ pages: 1, rows: 4, bytes: 1_048_576 });
  });
});

describe("staged chunks and release arguments", () => {
  it("staged-chunk reads need a sealed batch and validate ids and cursors", async () => {
    await expect(call("read_reporting_staged_chunks", { ...base(), p_work_ids: ["1"] })).rejects.toThrow(/sealed batch/);
    await expect(call("read_reporting_staged_chunks", { ...base(), p_work_ids: ["1"], p_after_work: "1", p_after_chunk: null })).rejects.toThrow(/paired/);
    await expect(call("read_reporting_staged_chunks", { ...base(), p_work_ids: ["1", "1"] })).rejects.toThrow(/owner_input_args/);
    await expect(call("read_reporting_staged_chunks", { ...base(), p_work_ids: ["99999999999999999999"] })).rejects.toThrow(/owner_input_args/);
  });
  it("release validates site and limit and deletes nothing for unpublished batches", async () => {
    await expect(call("release_reporting_owner_inputs", { p_site: "zz", p_limit: 10 })).rejects.toThrow(/unsupported site/);
    await expect(call("release_reporting_owner_inputs", { p_site: SITE, p_limit: 0 })).rejects.toThrow(/p_limit/);
    const before = (await db.query<{ n: number }>("select count(*)::int as n from reporting_private.owner_inputs")).rows[0].n;
    expect(await call("release_reporting_owner_inputs", { p_site: SITE, p_limit: 100 })).toEqual([{ deleted: 0, more: false }]);
    expect((await db.query<{ n: number }>("select count(*)::int as n from reporting_private.owner_inputs")).rows[0].n).toBe(before);
  });
});

describe("runtime audit attribution of the 0046 journal (two sites, real stable hashes)", () => {
  const T3 = ["owner_inputs", "owner_input_events", "owner_input_pieces"] as const;
  const RUN = "au";
  const OTHER = "uk";
  let ukBatch = "";
  const own = newRuntimeOwnership(RUN, "0ab1c2d3");
  /** FK-ordered mutations confined to one site ($1). Each runs inside a rolled-back transaction. */
  const byHandle = "handle in (select o.handle from reporting_private.owner_inputs o where o.site = $1)";
  const MUTATIONS: Array<{ table: (typeof T3)[number]; what: string; sql: string[] }> = [
    {
      table: "owner_inputs",
      what: "insert",
      sql: [
        `insert into reporting_private.owner_inputs (batch_id, partition_kind, partition_key, site, source_cutoff, rule_version, purpose, state, last_writer_fence)
           select batch_id, 'event', 'MUT-' || handle, site, source_cutoff, rule_version, purpose, state, last_writer_fence
             from reporting_private.owner_inputs where site = $1 order by handle limit 1`,
      ],
    },
    { table: "owner_inputs", what: "update", sql: ["update reporting_private.owner_inputs set updated_at = updated_at + interval '1 second' where site = $1"] },
    {
      table: "owner_inputs",
      what: "delete",
      sql: [`delete from reporting_private.owner_input_pieces where ${byHandle}`, `delete from reporting_private.owner_input_events where ${byHandle}`, "delete from reporting_private.owner_inputs where site = $1"],
    },
    {
      table: "owner_input_events",
      what: "insert",
      sql: [
        `insert into reporting_private.owner_input_events (handle, ord, event_id, pieces, text_bytes, text_sha256, src_at, stream_candidate)
           select handle, 51000, 'mut', 1, 1, repeat('0', 64), 'x', false from reporting_private.owner_inputs where site = $1 order by handle limit 1`,
      ],
    },
    { table: "owner_input_events", what: "update", sql: [`update reporting_private.owner_input_events set department = coalesce(department, '') || 'x' where ${byHandle}`] },
    { table: "owner_input_events", what: "delete", sql: [`delete from reporting_private.owner_input_pieces where ${byHandle}`, `delete from reporting_private.owner_input_events where ${byHandle}`] },
    {
      table: "owner_input_pieces",
      what: "insert",
      sql: [
        `insert into reporting_private.owner_input_pieces (handle, ord, piece_no, piece, row_bytes, committed)
           select e.handle, e.ord, 32, 'z', 1, false from reporting_private.owner_input_events e where e.${byHandle} order by e.handle, e.ord limit 1`,
      ],
    },
    { table: "owner_input_pieces", what: "update", sql: [`update reporting_private.owner_input_pieces set committed = not committed where ${byHandle}`] },
    { table: "owner_input_pieces", what: "delete", sql: [`delete from reporting_private.owner_input_pieces where ${byHandle}`] },
  ];
  async function rolledBack<T>(sqls: string[], site: string, read: () => Promise<T>): Promise<T> {
    await db.exec("begin");
    try {
      for (const s of sqls) await db.query(s, [site]);
      return await read();
    } finally {
      await db.exec("rollback");
    }
  }

  beforeAll(async () => {
    // A second, isolated synthetic site (uk) with its own frozen batch, built through the same sanctioned adapters as above.
    const ins = `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, parent_event_id)
      values ('uk', $1, $2, 'framed', 'OU-0', 'INKA-KAN0566-A4-FB', 1, 'line_verified', 's', '', $3, null)`;
    await db.query(ins, ["oiu-0", W, "2026-10-01T00:00:00.000Z"]);
    await db.query(ins, ["oiu-1", W, "2026-10-01T00:01:00.000Z"]);
    const c = svc();
    expect((await c.rpc("set_reporting_site_mode", { p_site: OTHER, p_read_mode: null, p_processor_enabled: true })).error).toBeNull();
    const r = await beginReportingRebuild(c, OTHER);
    ukBatch = r.batchId;
    const ukFence = r.leaseFence;
    let after: string | null = null;
    for (let i = 0; i < 100; i++) {
      const p = await copyReportingSourcePage(c, ukBatch, ukFence, after);
      if (p.complete) break;
      after = p.nextAfterEventId;
    }
    await freezeReportingRebuild(c, ukBatch, ukFence);
    const last: ["order", string] = ["order", "OU-0"];
    await saveEnumeration(c, ukBatch, ukFence, null, { kind: "rebuild", after: last }, [{ owner: { partitionKind: "order", partitionKey: "OU-0" }, oldStaff: [] }], false);
    await saveEnumeration(c, ukBatch, ukFence, { kind: "rebuild", after: last }, { kind: "rebuild", after: last, end: true }, [], true);
    await db.query("update reporting_private.batches set lease_expires_at = now() + interval '1 hour' where batch_id = $1", [ukBatch]);
    const uk = { p_batch: ukBatch, p_fence: ukFence };
    const hu = String((await call("open_reporting_owner_input", { ...uk, p_kind: "order", p_key: "OU-0", p_purpose: "plan" }))[0].handle);
    const e0 = ev("oiu-0", { location: OTHER, order_number: "OU-0", created_at: "2026-10-01T00:00:00.000000Z" });
    const e1 = ev("oiu-1", { location: OTHER, order_number: "OU-0", created_at: "2026-10-01T00:01:00.000000Z" });
    // committed member page, then a pending piece batch
    await call("checkpoint_reporting_owner_input", { ...uk, p_handle: hu, p_expected_seq: "0", p_payload: { kind: "page", pieces: entries([e0], 1, () => true), steps: [S.members(1)] } });
    await call("checkpoint_reporting_owner_input", { ...uk, p_handle: hu, p_expected_seq: "1", p_payload: { kind: "pieces", pieces: entries([e1], 2, () => true) } });
    // The run site gets its own committed journal (OI-5) and pending journal (OI-0), independent of the tests above.
    const ha = String((await open("order", "OI-5")).handle);
    await cp(ha, "0", { kind: "page", pieces: entries([ev("oi-5", { order_number: "OI-5", created_at: "2026-10-01T00:05:00.000000Z" })], 1, () => true), steps: [S.members(1)] });
    const hp = String((await open("order", "OI-0")).handle);
    await cp(hp, "0", { kind: "pieces", pieces: entries([ev("oi-0", { order_number: "OI-0", created_at: "2026-10-01T00:00:00.000000Z" })], 1, () => true) });
    own.startedAt = String((await db.query<{ t: string }>("select now()::text as t")).rows[0].t);
    own.baselineMaxChangeId = String((await db.query<{ m: string }>("select coalesce(max(change_id), 0)::text as m from reporting_private.changes")).rows[0].m);
  });

  it("the fixture has committed and pending headers, events and pieces at both sites, each bound to its own site's batch", async () => {
    const q = await db.query<{ site: string; batch_site: string; ev_c: number; ev_p: number; pc_c: number; pc_p: number }>(
      `select o.site, b.site as batch_site,
              count(*) filter (where e.committed)::int as ev_c, count(*) filter (where not e.committed)::int as ev_p,
              (select count(*)::int from reporting_private.owner_input_pieces p join reporting_private.owner_inputs x on x.handle = p.handle where x.site = o.site and p.committed) as pc_c,
              (select count(*)::int from reporting_private.owner_input_pieces p join reporting_private.owner_inputs x on x.handle = p.handle where x.site = o.site and not p.committed) as pc_p
         from reporting_private.owner_inputs o join reporting_private.batches b on b.batch_id = o.batch_id
         join reporting_private.owner_input_events e on e.handle = o.handle group by o.site, b.site order by o.site`,
    );
    expect(q.rows.map((r) => r.site)).toEqual([RUN, OTHER]);
    for (const r of q.rows) {
      expect(r.batch_site).toBe(r.site);
      for (const n of [r.ev_c, r.ev_p, r.pc_c, r.pc_p]) expect(n, `${r.site}: ${JSON.stringify(r)}`).toBeGreaterThan(0);
    }
  });

  it("run-site inserts, updates and FK-ordered deletes leave every stable hash unchanged", async () => {
    const before = await stableHashes(pgDb(db), own);
    for (const t of T3) expect(before[t], t).toMatch(/^\d+:[0-9a-f]{32}$/);
    for (const m of MUTATIONS) {
      const after = await rolledBack(m.sql, RUN, () => stableHashes(pgDb(db), own));
      expect(after, `${m.table} ${m.what} at ${RUN}`).toEqual(before);
    }
    expect(await stableHashes(pgDb(db), own)).toEqual(before); // every case rolled back
  });

  it("the same mutations at the other site change that table's stable hash and the audit names the table", async () => {
    const before = await stableHashes(pgDb(db), own);
    const fs = await smallState(pgDb(db));
    for (const m of MUTATIONS) {
      const after = await rolledBack(m.sql, OTHER, () => stableHashes(pgDb(db), own));
      expect(after[m.table], `${m.table} ${m.what} at ${OTHER}`).not.toBe(before[m.table]);
      const problems = runtimeAuditProblems(own, { before: fs, after: fs, stableBefore: before, stableAfter: after, ownership: {} });
      expect(problems.some((p) => p.startsWith(`reporting_private.${m.table}: rows the run may not change differ`)), `${m.table} ${m.what}: ${problems.join("; ")}`).toBe(true);
    }
    expect(await stableHashes(pgDb(db), own)).toEqual(before);
  });

  it("site attribution is not ownership: a run-site journal on an undeclared batch still fails the batch ownership check", async () => {
    const journalBatches = (await db.query<{ b: string }>("select distinct batch_id::text as b from reporting_private.owner_inputs where site = $1", [RUN])).rows.map((r) => r.b);
    expect(journalBatches).toEqual([batch]);
    const ownership = async (batches: string[]) => (await db.query<{ j: Record<string, unknown> }>(OWNERSHIP_SQL, ownershipParams({ ...own, batches }, []))).rows[0].j;
    const undeclared = await ownership([]);
    expect(Number(undeclared.batches)).toBe(1);
    const fs = await smallState(pgDb(db));
    const h = await stableHashes(pgDb(db), own);
    const problems = runtimeAuditProblems({ ...own, batches: [] }, { before: fs, after: fs, stableBefore: h, stableAfter: h, ownership: undeclared });
    expect(problems).toContain(`1 batches row(s) at ${RUN} do not belong to this run`);
    const declared = await ownership([batch]);
    expect(Number(declared.batches)).toBe(0); // the other site's batch (and its journal) is never counted as the run site's
    expect(ukBatch).not.toBe(batch);
  });

  it("an unattributed table is still compared in full, run-site rows included", async () => {
    expect(Object.keys(SITE_ATTRIBUTION)).toEqual(expect.arrayContaining([...T3]));
    const hash = async () => String((await db.query<{ h: string }>(stableHashSql("oi_unattributed_probe"), [RUN, own.baselineMaxChangeId, own.startedAt])).rows[0].h);
    await db.exec("begin");
    try {
      await db.exec("create table reporting_private.oi_unattributed_probe (site text, v int); insert into reporting_private.oi_unattributed_probe values ('au', 1)");
      const a = await hash();
      expect(a.startsWith("1:")).toBe(true);
      await db.exec("insert into reporting_private.oi_unattributed_probe values ('au', 2)");
      expect(await hash()).not.toBe(a);
    } finally {
      await db.exec("rollback");
    }
  });
});
