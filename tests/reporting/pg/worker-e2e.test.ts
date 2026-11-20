/**
 * The REAL Task 15 worker over the REAL 0037–0043 SQL (PGlite, offline):
 * capture → rebuild (copy, freeze, durable enumeration, plan, exact seal,
 * claim, stage, publish) → source edits → refresh → publish. Published current
 * facts must equal the whole-batch in-memory reference over the same source.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runReportingCycle } from "../../../api/_lib/production-reporting-worker";
import { materializeBatch, memoryFrozenReader } from "../../../api/_lib/production-reporting-materialize";
import { imageToEvent } from "../../../api/_lib/production-reporting-reader";
import { reportingDb } from "./harness";
import { pgRpc } from "./rpc";

const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
let db: PGlite;

async function insert(rows: Array<Record<string, unknown>>) {
  for (const r of rows) {
    await db.query(
      "insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id) values ($1,$2,$3,$4,$5,$6,$7,$8,'s','',$9,$10,$11)",
      ["uk", r.id, r.staff ?? W1, r.department ?? "framed", r.order ?? "O-1", r.sku ?? "INKA-KAN0566-A4-FB", r.qty ?? 1, r.type ?? "line_verified", r.at, r.case ?? null, r.parent ?? null],
    );
  }
}
const base = () => {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 40; i++) out.push({ id: `e${String(i).padStart(3, "0")}`, order: `O-${i % 9}`, staff: i % 3 ? W1 : W2, at: `2026-02-1${i % 5}T0${(i % 9) + 1}:${String(i % 60).padStart(2, "0")}:00+00:00` });
  out.push({ id: "t-1", order: "O-1", type: "completed", sku: null, qty: null, at: "2026-02-15T10:00:00+00:00" });
  out.push({ id: "c-1", order: "O-2", type: "cancelled", parent: "e002", sku: null, qty: null, at: "2026-02-15T10:05:00+00:00" });
  return out;
};

/** The whole-batch reference over the current source (what the published generation must hold). */
async function referenceFacts(cutoff: string) {
  const imgs = (await db.query<{ img: unknown }>("select to_jsonb(pe) as img from public.production_events pe where pe.location = 'uk'")).rows;
  const view = imgs.map((r) => imageToEvent(r.img, "uk"));
  const { works } = await materializeBatch(memoryFrozenReader({ site: "uk", cutoff, kind: "rebuild", view, changed: [] }));
  return works.flatMap((w) => w.rows.event_facts.map((f) => `${w.desc.audienceKind}|${w.desc.audienceStaff ?? ""}|${String(f.event_id)}|${String(f.role)}|${String(f.items ?? "")}`)).sort();
}
async function publishedFacts() {
  const r = await db.query<{ k: string }>("select audience_kind || '|' || coalesce(audience_staff::text, '') || '|' || event_id || '|' || role || '|' || coalesce(items::text, '') as k from reporting_private.event_facts where site = 'uk' and valid_to_seq is null order by 1");
  return r.rows.map((x) => x.k).sort();
}
const cutoffOf = async () => (await db.query<{ c: string }>("select to_char(source_cutoff at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as c from reporting_private.generations where site = 'uk' and state = 'published'")).rows[0].c;
const env = () => ({ client: pgRpc(db), now: () => Date.now(), sleep: async () => undefined });

beforeAll(async () => {
  db = await reportingDb();
  await db.query("insert into auth.users (id, email) values ($1, 'a@x'), ($2, 'b@x')", [W1, W2]);
  const c = pgRpc(db);
  expect((await c.rpc("set_reporting_capture", { p_enabled: true })).error).toBeNull();
  expect((await c.rpc("set_reporting_site_mode", { p_site: "uk", p_read_mode: null, p_processor_enabled: true })).error).toBeNull();
  await insert(base());
}, 120_000);
afterAll(async () => db?.close());

describe("Task 15 worker over the real SQL (PGlite)", () => {
  it("a rebuild publishes facts equal to the whole-batch reference", async () => {
    const r = await runReportingCycle(env(), { site: "uk", mode: "rebuild" });
    expect(r.problems).toEqual([]);
    expect(r.state).toBe("published");
    const facts = await publishedFacts();
    expect(facts.length).toBeGreaterThan(60); // site + self audiences of 42 events: non-vacuous
    expect(facts.some((k) => k.startsWith(`self|${W2}|`))).toBe(true);
    expect(facts).toEqual(await referenceFacts(await cutoffOf()));
    const runs = await db.query<{ outcome: string }>("select outcome from reporting_private.worker_runs order by run_id");
    expect(runs.rows.map((x) => x.outcome)).toEqual(["published"]);
  }, 120_000);
  it("a refresh after edits (insert, delete, re-owner, new cancellation) publishes the new state exactly", async () => {
    await insert([{ id: "n-1", order: "O-NEW", at: "2026-02-16T08:00:00+00:00" }, { id: "c-2", order: "O-3", type: "cancelled", parent: "e003", sku: null, qty: null, at: "2026-02-16T09:00:00+00:00" }]);
    await db.query("delete from public.production_events where location = 'uk' and id = 'e005'");
    await db.query("update public.production_events set order_number = 'O-X', staff_id = $1 where location = 'uk' and id = 'e007'", [W2]);
    const r = await runReportingCycle(env(), { site: "uk", mode: "refresh" });
    expect(r.problems).toEqual([]);
    expect(r.state).toBe("published");
    const facts = await publishedFacts();
    expect(facts.some((k) => k.includes("|e005|"))).toBe(false); // deleted
    expect(facts.some((k) => k.startsWith(`self|${W2}|e007|`))).toBe(true); // re-staffed
    expect(facts.some((k) => k.includes("|n-1|"))).toBe(true); // inserted
    expect(facts).toEqual(await referenceFacts(await cutoffOf()));
    const p = await db.query<{ complete: boolean; n: number }>("select wp.enum_complete as complete, wp.owners_discovered as n from reporting_private.worker_progress wp join reporting_private.batches b on b.batch_id = wp.batch_id where b.kind = 'refresh'");
    expect(p.rows[0]).toMatchObject({ complete: true });
    expect(p.rows[0].n).toBeGreaterThan(0);
  }, 120_000);
  it("a no-change refresh publishes zero work and advances verification", async () => {
    const before = (await db.query<{ v: string }>("select max(verified_at)::text as v from reporting_private.generations where site = 'uk'")).rows[0].v;
    const r = await runReportingCycle(env(), { site: "uk", mode: "refresh" });
    expect(r.state).toBe("published");
    expect(r.counts.sealedWork).toBe(0);
    const after = (await db.query<{ v: string }>("select max(verified_at)::text as v from reporting_private.generations where site = 'uk'")).rows[0].v;
    expect(after >= before).toBe(true);
  }, 120_000);
  it("cleanup runs over the real tables and keeps every retained version", async () => {
    const before = await publishedFacts();
    const r = await runReportingCycle(env(), { site: "uk", mode: "cleanup" });
    expect(r.state).toBe("done");
    expect(await publishedFacts()).toEqual(before);
  }, 120_000);
  it("client roles cannot call the worker RPCs", async () => {
    for (const role of ["anon", "authenticated"]) {
      const r = await pgRpc(db, { role }).rpc("read_reporting_worker_progress", { p_batch: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", p_fence: 1 });
      expect(r.error?.message).toMatch(/permission denied/);
    }
  }, 60_000);
});
