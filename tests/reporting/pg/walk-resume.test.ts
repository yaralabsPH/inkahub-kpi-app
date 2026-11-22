/**
 * Task 15 review repair, over the REAL 0037–0043 SQL (PGlite, offline):
 *
 *  1. A refresh walk interrupted after saving page N of a stream line's
 *     cancellation paging resumes in a new invocation with ZERO byIds calls and
 *     zero child-page requests at/before the saved cursor (no prior source page
 *     is fetched again), and publishes exactly the whole-batch reference.
 *  2. An id met both as a line's cancellation and as a stream event is ONE row
 *     of the durable per-seed budget.
 *  3. save_reporting_walk is atomic at the 50,001st distinct id: the raise rolls
 *     back enum_cursor, owners, worker_seen and worker_walk_line together; ids
 *     are bound to the cursor's seed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runReportingCycle, type WorkerEnv } from "../../../api/_lib/production-reporting-worker";
import { materializeBatch, memoryFrozenReader, type FrozenReader } from "../../../api/_lib/production-reporting-materialize";
import { imageToEvent, rpcEnumerationPages, rpcFrozenReader } from "../../../api/_lib/production-reporting-reader";
import type { RpcClient } from "../../../api/_lib/reporting-jobs";
import { reportingDb } from "./harness";
import { pgRpc } from "./rpc";

const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
let db: PGlite;

async function insert(rows: Array<Record<string, unknown>>) {
  for (const r of rows) {
    await db.query(
      "insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id) values ('uk',$1,$2,'framed',$3,$4,$5,$6,'s','',$7,null,$8)",
      [r.id, r.staff ?? W1, r.order, r.type === "cancelled" ? null : "INKA-KAN0566-A4-FB", r.type === "cancelled" ? null : 1, r.type ?? "line_verified", r.at, r.parent ?? null],
    );
  }
}
const at = (m: number, s = 0) => `2026-03-02T09:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}+00:00`;
const fixture = () => [
  { id: "a0", order: "O-A", at: at(0) },
  // the changed key's inverse children (another worker): three key-children pages of 2
  ...["x1", "x2", "x3", "x4", "x5"].map((id, i) => ({ id, staff: W2, order: "O-A", type: "cancelled", parent: "a0", at: at(0, 10 + i) })),
  { id: "s1", order: "O-S1", at: at(1) },
  { id: "k-s1", order: "O-S1", type: "cancelled", parent: "s1", at: at(1, 10) }, // W1: also in W1's stream (cross-path duplicate)
  { id: "s2", order: "O-S2", at: at(2) },
  ...["k-s2a", "k-s2b", "k-s2c", "k-s2d", "k-s2e"].map((id, i) => ({ id, staff: W2, order: "O-S2", type: "cancelled", parent: "s2", at: at(2, 10 + i) })),
  { id: "k-s2w", order: "O-S2", type: "cancelled", parent: "s2", at: at(2, 30) }, // W1 (duplicate path)
  { id: "s3", order: "O-S3", at: at(3) },
  { id: "k-s3", order: "O-S3", type: "cancelled", parent: "s3", at: at(3, 10) },
  { id: "fin", order: "O-F", at: at(4) },
  { id: "z1", order: "O-Z", at: at(5) },
];

async function referenceFacts() {
  const cutoff = (await db.query<{ c: string }>("select to_char(source_cutoff at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as c from reporting_private.generations where site = 'uk' and state = 'published'")).rows[0].c;
  const imgs = (await db.query<{ img: unknown }>("select to_jsonb(pe) as img from public.production_events pe where pe.location = 'uk'")).rows;
  const { works } = await materializeBatch(memoryFrozenReader({ site: "uk", cutoff, kind: "rebuild", view: imgs.map((r) => imageToEvent(r.img, "uk")), changed: [] }));
  return works.flatMap((w) => w.rows.event_facts.map((f) => `${w.desc.audienceKind}|${w.desc.audienceStaff ?? ""}|${String(f.event_id)}|${String(f.role)}|${String(f.items ?? "")}`)).sort();
}
async function publishedFacts() {
  const r = await db.query<{ k: string }>("select audience_kind || '|' || coalesce(audience_staff::text, '') || '|' || event_id || '|' || role || '|' || coalesce(items::text, '') as k from reporting_private.event_facts where site = 'uk' and valid_to_seq is null order by 1");
  return r.rows.map((x) => x.k).sort();
}

interface Call { fn: "byIds" | "childPage" | "stream"; arg: string; out: string[] }
/** The real RPC reader, instrumented; recording stops at the key-completing checkpoint (planning reads are not enumeration). */
function instrumented(clock: { t: number; stopAfter?: (args: Record<string, unknown>) => boolean }) {
  const calls: Call[] = [];
  let recording = true;
  const base = pgRpc(db);
  const client: RpcClient = {
    rpc: async (fn, args) => {
      const r = await base.rpc(fn, args);
      if (fn === "save_reporting_walk" && !r.error) {
        if (args.p_key_complete) recording = false;
        if (clock.stopAfter?.(args)) clock.t += 10_000_000; // the deadline passes right after this checkpoint commits
      }
      return r;
    },
  };
  const env: WorkerEnv = {
    client,
    now: () => clock.t,
    sleep: async () => undefined,
    walkPages: { keyChildren: 2, lineKids: 2, stream: 2 },
    source: (ref) => {
      const inner = rpcFrozenReader(client, ref);
      const rec = <T extends { id: string }[]>(fn: Call["fn"], arg: string, out: T) => (recording && calls.push({ fn, arg, out: out.map((e) => e.id) }), out);
      const reader: FrozenReader = {
        ...inner,
        byIds: async (ids) => {
          const m = await inner.byIds(ids);
          if (recording) calls.push({ fn: "byIds", arg: ids.join(","), out: [...m.keys()] });
          return m;
        },
        childPage: async (p, after, limit) => rec("childPage", `${p}>${after ?? ""}`, await inner.childPage(p, after, limit)),
        stream: async (s, d, from, limit) => rec("stream", `${from.createdAt}|${from.id}`, await inner.stream(s, d, from, limit)),
      };
      return { reader, pages: rpcEnumerationPages(client, ref) };
    },
  };
  return { env, calls };
}
const expireLease = () => db.query("update reporting_private.batches set lease_expires_at = now() - interval '1 second' where site = 'uk' and state = 'frozen'");

beforeAll(async () => {
  db = await reportingDb();
  await db.query("insert into auth.users (id) values ($1), ($2)", [W1, W2]);
  const c = pgRpc(db);
  await c.rpc("set_reporting_capture", { p_enabled: true });
  await c.rpc("set_reporting_site_mode", { p_site: "uk", p_read_mode: null, p_processor_enabled: true });
  await insert(fixture());
  const r = await runReportingCycle({ client: c, now: () => Date.now(), sleep: async () => undefined }, { site: "uk", mode: "rebuild" });
  if (r.state !== "published") throw new Error(r.problems.join("; "));
}, 180_000);
afterAll(async () => db?.close());

describe("Task 15: the resumable changed-key walk over the real SQL", () => {
  let saved: { kidsAfter: string; at: string } | null = null;
  it("interrupted after saving page 2 of a line's cancellation paging: the checkpoint holds kidsAfter, the line image and the deduplicated budget", async () => {
    await db.query("delete from public.production_events where location = 'uk' and id = 'a0'"); // one changed key, one seed
    let linePages = 0;
    const clock = {
      t: 1_800_000_000_000,
      stopAfter: (a: Record<string, unknown>) => {
        const line = ((a.p_next_cursor as { key?: { walk?: { line?: { id: string; kidsAfter: string | null } | null } | null } }).key?.walk?.line) ?? null;
        if (line?.id === "s2" && line.kidsAfter !== null) linePages++;
        return linePages === 2;
      },
    };
    const { env, calls } = instrumented(clock);
    const r = await runReportingCycle(env, { site: "uk", mode: "refresh" });
    expect(r.state).toBe("pending");
    const cur = (await db.query<{ c: { after: string | null; key: { phase: string; seed: number; walk: { at: { createdAt: string; id: string }; line: { id: string; kidsAfter: string; cancelled: boolean } } } } }>("select w.enum_cursor as c from reporting_private.worker_progress w join reporting_private.batches b on b.batch_id = w.batch_id where b.state = 'frozen'")).rows[0].c;
    expect(cur.after).toBeNull(); // the outer cursor waits for the whole key
    expect(cur.key).toMatchObject({ phase: "seeds", seed: 0, walk: { at: { id: "s2" }, line: { id: "s2", kidsAfter: "k-s2d", cancelled: true } } });
    saved = { kidsAfter: cur.key.walk.line.kidsAfter, at: cur.key.walk.at.createdAt };
    // the line image is saved worker state, so the resume needs no source reread of s2
    expect((await db.query("select line_id from reporting_private.worker_walk_line")).rows).toEqual([{ line_id: "s2" }]);
    // k-s1 was met through BOTH paths in this invocation, and is ONE row of the seed's budget
    expect(calls.some((c) => c.fn === "childPage" && c.arg === "s1>" && c.out.includes("k-s1"))).toBe(true);
    expect(calls.some((c) => c.fn === "stream" && c.out.includes("k-s1"))).toBe(true);
    const seen = (await db.query<{ event_id: string; n: number }>("select event_id, count(*)::int as n from reporting_private.worker_seen where seed = 0 group by event_id")).rows;
    expect(seen.find((s) => s.event_id === "k-s1")?.n).toBe(1);
    const consumed = calls.filter((c) => c.fn !== "byIds" && !c.arg.startsWith("a0>")).flatMap((c) => c.out);
    expect(consumed.filter((id) => id === "k-s1")).toHaveLength(2); // two encounters…
    expect(seen.map((s) => s.event_id).sort()).toEqual(["k-s1", "k-s2a", "k-s2b", "k-s2c", "k-s2d", "s1", "s2"]); // …one budget row each
  }, 180_000);
  it("a new invocation resumes with zero byIds and zero child pages at/before the saved cursor, then publishes exactly the reference", async () => {
    expect(saved).not.toBeNull();
    await expireLease();
    const { env, calls } = instrumented({ t: 1_900_000_000_000 });
    const r = await runReportingCycle(env, { site: "uk", mode: "refresh" });
    expect(r.problems).toEqual([]);
    expect(r.state).toBe("published");
    expect(calls.filter((c) => c.fn === "byIds")).toEqual([]);
    const kids = calls.filter((c) => c.fn === "childPage");
    expect(kids.filter((c) => c.arg.startsWith("a0>") || c.arg.startsWith("s1>"))).toEqual([]); // finished phases/lines
    const s2 = kids.filter((c) => c.arg.startsWith("s2>")).map((c) => c.arg.slice(3));
    expect(s2[0]).toBe(saved!.kidsAfter); // the first s2 page is the one after the saved cursor…
    expect(s2.every((after) => after !== "" && after >= saved!.kidsAfter)).toBe(true); // …never an earlier one
    const streams = calls.filter((c) => c.fn === "stream");
    expect(streams[0].arg.endsWith("|s2")).toBe(true); // the stream continues after the last consumed event
    expect(streams.some((c) => c.out.includes("s1") || c.out.includes("s2"))).toBe(false); // no consumed stream row again
    expect(await publishedFacts()).toEqual(await referenceFacts());
    // the completed key left no scratch state
    expect((await db.query("select 1 from reporting_private.worker_seen")).rows).toEqual([]);
    expect((await db.query("select 1 from reporting_private.worker_walk_line")).rows).toEqual([]);
  }, 180_000);
});

describe("Task 15: save_reporting_walk is one transaction at the 50,001st distinct id", () => {
  it("the raise rolls back enum_cursor, owners, worker_seen and worker_walk_line together; ids are bound to the cursor's seed", async () => {
    // a live frozen refresh batch: stopped right after its first checkpoint
    await insert([{ id: "q1", order: "O-Q", at: at(10) }]);
    const { env } = instrumented({ t: 2_000_000_000_000, stopAfter: () => true });
    expect((await runReportingCycle(env, { site: "uk", mode: "refresh" })).state).toBe("pending");
    const b = (await db.query<{ id: string; fence: number }>("select batch_id::text as id, lease_fence::int as fence from reporting_private.batches where site = 'uk' and state = 'frozen'")).rows[0];
    const c = pgRpc(db);
    const state = async () => ({
      cursor: (await db.query<{ c: unknown }>("select enum_cursor as c from reporting_private.worker_progress where batch_id = $1", [b.id])).rows[0].c,
      owners: (await db.query<{ n: number }>("select count(*)::int as n from reporting_private.worker_owners where batch_id = $1", [b.id])).rows[0].n,
      seen: (await db.query<{ n: number }>("select count(*)::int as n from reporting_private.worker_seen where batch_id = $1", [b.id])).rows[0].n,
      line: (await db.query("select line_id from reporting_private.worker_walk_line where batch_id = $1", [b.id])).rows,
    });
    let expected = (await state()).cursor as { after: string | null; key: { id: string } };
    const keyId = expected.key.id; // the key the live cursor is actually inside
    expect(keyId).toBe("q1");
    const key = (i: number, line: string | null = null) => ({
      kind: "refresh", after: expected.after,
      key: { id: keyId, phase: "seeds", kidsAfter: null, seed: 0, anchors: [{ staff: W1, at: "2026-03-02T09:00:00.000000Z", id: "a", wt: null, owner: ["order", "O-ZZ"] }], walk: { at: { createdAt: "2026-03-02T09:00:00.000000Z", id: `p${i}` }, stop: null, need: ["*"], line: line && { id: line, kidsAfter: null, cancelled: false }, done: false } },
    });
    const save = (next: unknown, seen: string[], extra: Record<string, unknown> = {}) =>
      c.rpc("save_reporting_walk", { p_batch: b.id, p_fence: b.fence, p_expected_cursor: expected, p_next_cursor: next, p_owners: [], p_key: keyId, p_seed: 0, p_seen: seen, p_line_image: null, p_key_complete: false, ...extra });
    // a checkpoint may not switch to another changed key while the saved cursor is inside this one
    const other = { ...key(0), key: { ...key(0).key, id: "zz-other" } };
    expect((await save(other, [], { p_key: "zz-other" })).error?.message).toMatch(/inside another changed key/);
    // 25 checkpoints of 2,000 new ids: exactly 50,000 distinct
    for (let i = 0; i < 25; i++) {
      const next = key(i);
      const r = await save(next, Array.from({ length: 2000 }, (_, j) => `id-${i * 2000 + j}`));
      expect(r.error).toBeNull();
      expected = next as typeof expected;
    }
    const top = await save(key(100), ["id-0", "id-1"]); // only already-counted ids: the dedupe proof (still 50,000)
    expect(top.error).toBeNull();
    expect((top.data as Array<{ seen_count: number }>)[0].seen_count).toBe(50_000);
    expected = key(100) as typeof expected;
    const before = await state();
    expect(before.seen).toBe(50_000);
    // seed binding: ids for another seed than the cursor's are refused
    expect((await save(key(101), ["id-new"], { p_seed: 1 })).error?.message).toMatch(/p_seed must be the cursor's seed/);
    // the 50,001st distinct id, together with an owner and a line image: all of it rolls back
    const r = await save(key(101, "L1"), ["id-0", "id-new"], { p_owners: [["order", "O-ROLLBACK", []]], p_line_image: { id: "L1" } });
    expect(r.error?.message).toMatch(/partition_too_large: successor seed 0 .* 50001 distinct dependency ids/);
    expect(await state()).toEqual(before);
    expect((await db.query("select 1 from reporting_private.worker_owners where partition_key = 'O-ROLLBACK'")).rows).toEqual([]);
  }, 300_000);
});
