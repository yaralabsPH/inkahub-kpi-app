/**
 * Task 18 over the REAL 0037–0044 SQL (PGlite, offline): the daily digest for a
 * site in SUMMARY read mode reads ONE complete published generation through the
 * internal published reader (no HTTP self-call), prints its source cutoff,
 * published-at and rule version, and refuses (no workbook, no email) when the
 * publication is missing or more than 30 minutes stale. The oracle is the app's
 * own live counter (summarizeProduction over the four-family snapshot) at the
 * generation's exact cutoff; a newer worker save differs until the next
 * publication. Operational reads (clock rows, ledger boxes, names) are bounded,
 * labelled with their own cutoff and served here by small in-memory fakes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as XLSX from "xlsx";
import { createDigestHandler, type DigestDeps } from "../../../api/reports/daily-digest";
import { runReportingCycle } from "../../../api/_lib/production-reporting-worker";
import { imageToEvent } from "../../../api/_lib/production-reporting-reader";
import { rpcPublishedReader } from "../../../api/_lib/production-reporting-rpc";
import type { ReaderScope } from "../../../api/_lib/production-reporting";
import { prepareProductionEvidence, summarizeProduction, type ProductionEvidenceEvent, type WorkType } from "../../../src/lib/domain/productionCounts";
import { productionRange } from "../../../src/lib/domain/productionPeriods";
import { fourFamilySnapshot } from "../../fixtures/reporting-history";
import { reportingDb } from "./harness";
import { pgRpc } from "./rpc";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const SITE = "uk";
const DAY = "2026-01-15";
const PREV = "2026-01-14";
const SECRET = "test-cron-secret-0123456789";
const SKU = "INKA-KAN0566-A4-FB";
let db: PGlite;

type Row = Record<string, unknown>;
const ev = (id: string, staff: string, department: string, order: string, type: string, at: string, qty: number | null = 1) =>
  ({ id, location: SITE, staff_id: staff, department, order_number: order, line_sku: type === "line_verified" ? SKU : null, line_quantity: type === "line_verified" ? qty : null, event_type: type, created_at: at, cs_case_id: null, parent_event_id: null, station_id: "s", note: "" });
const SRC = [
  ev("y1", A, "framed", "Y-1", "line_verified", `${PREV}T10:00:00.000000Z`, 2), ev("y2", A, "framed", "Y-1", "completed", `${PREV}T10:30:00.000000Z`),
  ev("t1", A, "framed", "T-1", "line_verified", `${DAY}T09:00:00.000000Z`, 3), ev("t2", A, "framed", "T-1", "completed", `${DAY}T09:30:00.000000Z`),
  ev("t3", B, "unframed", "T-2", "line_verified", `${DAY}T10:00:00.000000Z`), ev("t4", B, "unframed", "T-2", "completed", `${DAY}T10:20:00.000000Z`),
  ev("t5", B, "dispatch", "T-1", "dispatched", `${DAY}T11:00:00.000000Z`),
];
/** Operational rows (not counting evidence): clock rows, package products, ledger and names. */
const OPS: Record<string, Row[]> = {
  production_events: [
    { id: "c1", location: SITE, staff_id: A, department: "framed", event_type: "clock_in", created_at: `${DAY}T08:00:00.000Z` },
    { id: "c2", location: SITE, staff_id: A, department: "framed", event_type: "clock_out", created_at: `${DAY}T16:00:00.000Z` },
  ],
  products: [{ id: "p-a0", location: SITE, code: "A0-Single" }],
  ledger: [{ id: "l1", location: SITE, product_id: "p-a0", delta: -2, ts: `${DAY}T12:00:00.000Z` }],
  staff_barcodes: [{ user_id: A, display_name: "Ana", barcode: "1", location: SITE }, { user_id: B, display_name: "Ben", barcode: "2", location: SITE }],
};

/** A tiny PostgREST-shaped builder over the operational rows (filters, exact count, range). */
function opsFrom(table: string) {
  const ops: Array<[string, unknown[]]> = [];
  let counted = false;
  let win: [number, number] | null = null;
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "lt", "lte", "in", "order"]) {
    q[m] = (...args: unknown[]) => {
      if (m === "select") counted = (args[1] as { count?: string } | undefined)?.count === "exact";
      else if (m !== "order") ops.push([m, args]);
      return q;
    };
  }
  q.range = (from: number, to: number) => ((win = [from, to]), q);
  q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
    const rows = (OPS[table] ?? []).filter((r) => ops.every(([op, a]) => {
      const v = r[String(a[0])];
      if (op === "eq") return v === a[1];
      if (op === "gte") return String(v) >= String(a[1]);
      if (op === "lt") return typeof a[1] === "number" ? Number(v) < a[1] : String(v) < String(a[1]);
      if (op === "lte") return String(v) <= String(a[1]);
      if (op === "in") return (a[1] as unknown[]).includes(v);
      return true;
    }));
    return Promise.resolve({ data: win ? rows.slice(win[0], win[1] + 1) : rows, error: null, count: counted ? rows.length : null }).then(ok, bad);
  };
  return q;
}

interface Res { status: number; body: unknown; sent: Buffer | null; headers: Record<string, string> }
let emails: unknown[] = [];
let nowMs = 0;
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
function deps(): DigestDeps {
  const rpc = pgRpc(db);
  return {
    now: () => nowMs,
    createClient: () => ({ rpc: (fn: string, args: Record<string, unknown>) => (rpcCalls.push({ fn, args }), rpc.rpc(fn, args)), from: opsFrom }) as never,
    fetch: (async (url: string, init: { body?: string }) => {
      emails.push({ url, body: JSON.parse(String(init.body ?? "{}")) });
      return { ok: true, status: 200, text: async () => "", json: async () => ({ id: "email-1" }) };
    }) as never,
  };
}
async function digest(query: Record<string, string>): Promise<Res> {
  const out: Res = { status: 0, body: null, sent: null, headers: {} };
  const res = {
    setHeader: (k: string, v: string) => void (out.headers[k.toLowerCase()] = v),
    status: (s: number) => ((out.status = s), res),
    json: (b: unknown) => void (out.body = b),
    send: (b: Buffer) => void (out.sent = b),
  };
  await createDigestHandler(deps())({ method: "GET", headers: { authorization: `Bearer ${SECRET}` }, query } as never, res as never);
  return out;
}
const sheets = (buf: Buffer) => {
  const wb = XLSX.read(buf, { type: "buffer" });
  return Object.fromEntries(wb.SheetNames.map((n) => [n, XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[n])]));
};
const generation = async () => (await db.query<{ g: string; c: string; p: string; r: string; v: string }>(
  "select generation_id::text as g, to_char(source_cutoff at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as c, to_char(published_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as p, rule_version as r, to_char(verified_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as v from reporting_private.generations where site = 'uk' and state = 'published'")).rows[0];
/** The app's live counter for one production day at an exact cutoff (and optional work type). */
async function live(day: string, cutoff: string, workType?: WorkType) {
  const view = (await db.query<{ img: unknown }>("select to_jsonb(pe) as img from public.production_events pe where pe.location = 'uk'")).rows.map((r) => imageToEvent(r.img, SITE)) as ProductionEvidenceEvent[];
  const both = productionRange(SITE, PREV, DAY);
  const range = productionRange(SITE, day, day);
  const snap = fourFamilySnapshot(view, { startUtc: both.startUtc, endUtcExclusive: both.endUtcExclusive }, { kind: "site" }, SITE, cutoff);
  return summarizeProduction(prepareProductionEvidence(snap), { range, ...(workType ? { workTypes: [workType] } : {}) });
}
const cycle = async (mode: "rebuild" | "refresh") => {
  const r = await runReportingCycle({ client: pgRpc(db), now: () => Date.now(), sleep: async () => undefined }, { site: SITE, mode });
  if (r.state !== "published") throw new Error(r.problems.join("; "));
};

const ENV = { CRON_SECRET: SECRET, VITE_SUPABASE_URL: "https://staging.example", SUPABASE_SERVICE_ROLE_KEY: "service-role-test", RESEND_API_KEY: "re_test", REPORT_RECIPIENT: "ops@example.com" };
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = {};
  for (const k of Object.keys(ENV)) saved[k] = process.env[k];
  Object.assign(process.env, ENV);
  emails = [];
  rpcCalls = [];
  nowMs = Date.now();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

beforeAll(async () => {
  db = await reportingDb();
  await db.query("insert into auth.users (id) values ($1), ($2)", [A, B]);
  for (const e of SRC) {
    await db.query("insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at) values ('uk',$1,$2,$3,$4,$5,$6,$7,'s','',$8)",
      [e.id, e.staff_id, e.department, e.order_number, e.line_sku, e.line_quantity, e.event_type, e.created_at]);
  }
  const c = pgRpc(db);
  await c.rpc("set_reporting_capture", { p_enabled: true });
  await c.rpc("set_reporting_site_mode", { p_site: SITE, p_read_mode: null, p_processor_enabled: true });
  await cycle("rebuild");
  await c.rpc("set_reporting_site_mode", { p_site: SITE, p_read_mode: "summary", p_processor_enabled: null });
}, 180_000);
afterAll(async () => db?.close());

describe("Task 18: the digest for a summary-mode site is one published generation", () => {
  it("counts equal the app's live counter at the generation's exact cutoff, across every sheet; cutoff/published/rule printed", async () => {
    const g = await generation();
    const out = await digest({ location: SITE, date: DAY, dry: "1" });
    expect([out.status, out.body]).toEqual([200, null]);
    const s = sheets(out.sent!);
    const today = await live(DAY, g.c);
    const prev = await live(PREV, g.c);
    const sum = s.Summary[0];
    expect([sum.orders_total, sum.items_total, sum.orders_yesterday, sum.items_yesterday]).toEqual([today.normal.orders, today.normal.items, prev.normal.orders, prev.normal.items]);
    expect([sum.orders_total, sum.items_total]).toEqual([2, 4]); // non-vacuous: T-1 and T-2 completed; 3 + 1 Items
    expect(sum).toMatchObject({ source: "published", generation_id: g.g, as_of_utc: g.c, published_at_utc: g.p, rule_version: g.r, verified_at_utc: g.v });
    for (const d of ["framed", "unframed", "dispatch"] as const) {
      const ref = await live(DAY, g.c, d);
      const row = s.Departments.find((r) => String(r.department).toLowerCase().startsWith(d === "framed" ? "framed" : d))!;
      expect([d, row.orders, row.items]).toEqual([d, ref.normal.orders, ref.normal.items]);
    }
    const ana = s.Staff.find((r) => r.staff_name === "Ana" && r.department === "Framed")!;
    expect([ana.orders, ana.items, ana.hours_worked]).toEqual([1, 3, 8]); // hours from the operational clock rows
    expect(emails).toEqual([]); // dry: never emails
    // ONE generation across every published read of this workbook: each summary/detail call carries exactly
    // the expected p_generation, and the active generation is looked up once, BEFORE the first read (no switch).
    const reads = rpcCalls.filter((c) => c.fn === "read_reporting_summary" || c.fn === "read_reporting_detail");
    expect(reads.length).toBe(10); // 2 days x (all + 4 work types)
    expect(reads.map((c) => c.args.p_generation)).toEqual(reads.map(() => g.g));
    const lookups = rpcCalls.map((c, i) => [c, i] as const).filter(([c]) => c.fn === "read_reporting_generation");
    expect(lookups.map(([c]) => c.args.p_generation)).toEqual([null]);
    expect(lookups[0][1]).toBeLessThan(rpcCalls.findIndex((c) => c.fn === "read_reporting_summary"));
    expect(rpcCalls.map((c) => c.fn)).not.toContain("load_production_evidence_v2"); // no raw-history count read
  }, 120_000);
  it("three-way parity at ONE cutoff: the live counter, the management summary (same pinned generation) and the digest agree", async () => {
    const g = await generation();
    const reader = rpcPublishedReader(pgRpc(db));
    // The management summary exactly as Reports reads it, pinned to the digest's generation.
    const management = async (day: string, workType: WorkType | null) => {
      const range = productionRange(SITE, day, day);
      const scope: ReaderScope = { site: SITE, audience: { kind: "site" }, generationId: g.g, firstDate: day, lastDate: day, startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive, staffId: null, workType };
      return reader.summary(scope, "reports", { dailyLimit: 1, peopleLimit: 1000 });
    };
    const s = sheets((await digest({ location: SITE, date: DAY, dry: "1" })).sent!);
    expect(s.Summary[0].generation_id).toBe(g.g);
    const io = (x: { items: number | null; orders: number }) => [x.items, x.orders];

    // overall: today and yesterday
    for (const [day, digestCols] of [[DAY, ["items_total", "orders_total"]], [PREV, ["items_yesterday", "orders_yesterday"]]] as const) {
      const liveDay = await live(day, g.c);
      const mgmt = await management(day, null);
      const fromDigest = [s.Summary[0][digestCols[0]], s.Summary[0][digestCols[1]]];
      expect([day, io(liveDay.normal), io(mgmt.totals.normal), fromDigest]).toEqual([day, io(liveDay.normal), io(liveDay.normal), io(liveDay.normal)]);
      expect([day, io(mgmt.totals.rework)]).toEqual([day, io(liveDay.rework)]);
    }
    expect(io((await live(DAY, g.c)).normal)).toEqual([4, 2]); // non-vacuous: two completed orders, 3 + 1 Items
    expect(io((await live(PREV, g.c)).normal)).toEqual([2, 1]);

    // a work type: framed today
    const liveFramed = await live(DAY, g.c, "framed");
    const mgmtFramed = await management(DAY, "framed");
    const digestFramed = s.Departments.find((r) => r.department === "Framed")!;
    expect([io(liveFramed.normal), io(mgmtFramed.totals.normal), [digestFramed.items, digestFramed.orders]]).toEqual([[3, 1], [3, 1], [3, 1]]);

    // a person in that work type: Ana (A) at framed today
    const livePerson = liveFramed.byPerson[A];
    const mgmtPerson = mgmtFramed.peoplePage.rows.find((p) => p.staffId === A)!;
    const digestPerson = s.Staff.find((r) => r.staff_name === "Ana" && r.department === "Framed")!;
    expect([io(livePerson.normal), io(mgmtPerson.normal), [digestPerson.items, digestPerson.orders]]).toEqual([[3, 1], [3, 1], [3, 1]]);
  }, 120_000);
  it("operational reads are labelled with their own cutoff, never as the frozen summary evidence", async () => {
    const out = await digest({ location: SITE, date: DAY, dry: "1" });
    const s = sheets(out.sent!);
    expect(s.Summary[0].operational_reads_as_of_utc).toBe(new Date(nowMs).toISOString());
    expect(s.Notes.map((n) => String(n.note)).join(" ")).toMatch(/staff on shift, hours and boxes come from live operational reads/i);
    expect(s.Departments.find((r) => r.department === "A0 Framed" || String(r.department).startsWith("A0"))!.boxes_used).toBe(2);
  }, 120_000);
  it("a newer worker save differs from the digest until the next publication, then agrees", async () => {
    const g1 = await generation();
    await db.query("insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at) values ('uk','n1',$1,'framed','T-9',$2,5,'line_verified','s',''," + "'" + `${DAY}T13:00:00.000000Z` + "'),('uk','n2',$1,'framed','T-9',null,null,'completed','s','','" + `${DAY}T13:10:00.000000Z` + "')", [A, SKU]);
    const liveNow = await live(DAY, new Date().toISOString());
    const before = sheets((await digest({ location: SITE, date: DAY, dry: "1" })).sent!).Summary[0];
    expect(before.generation_id).toBe(g1.g);
    expect(before.orders_total).not.toBe(liveNow.normal.orders); // the newer save is not in this publication yet
    await cycle("refresh");
    nowMs = Date.now();
    const g2 = await generation();
    const after = sheets((await digest({ location: SITE, date: DAY, dry: "1" })).sent!).Summary[0];
    expect(after.generation_id).toBe(g2.g);
    expect(g2.g).not.toBe(g1.g);
    expect([after.orders_total, after.items_total]).toEqual([(await live(DAY, g2.c)).normal.orders, (await live(DAY, g2.c)).normal.items]);
    expect(after.orders_total).toBe(3);
  }, 180_000);
  it("a publication verified more than 30 minutes ago: no workbook and no email (dry or send)", async () => {
    const g = await generation();
    nowMs = Date.parse(g.v) + 31 * 60_000;
    for (const query of [{ location: SITE, date: DAY, dry: "1" }, { location: SITE, date: DAY, force: "1" }]) {
      const out = await digest(query);
      expect([out.status, out.sent]).toEqual([503, null]);
      expect(out.body).toMatchObject({ error: expect.stringMatching(/more than 30 minutes|stale/i) });
    }
    expect(emails).toEqual([]);
    nowMs = Date.parse(g.v) + 29 * 60_000; // inside the window: served
    expect((await digest({ location: SITE, date: DAY, dry: "1" })).status).toBe(200);
  }, 120_000);
  it("summary mode without a published generation cannot exist: the operator API and the schema both refuse it", async () => {
    const setMode = await pgRpc(db).rpc("set_reporting_site_mode", { p_site: "us", p_read_mode: "summary", p_processor_enabled: null });
    expect(setMode.error?.message).toMatch(/no published generation; it can only read legacy/);
    await expect(db.query("update reporting_private.site_state set read_mode = 'summary' where site = 'us'")).rejects.toThrow(/site_state_check/);
    // The us site therefore stays legacy, and the digest's own no-publication refusal is pinned in the unit tests.
    expect((await db.query<{ m: string }>("select read_mode as m from reporting_private.site_state where site = 'us'")).rows[0].m).toBe("legacy");
  }, 120_000);
  it("sends the workbook by email with the published counts when not dry", async () => {
    const out = await digest({ location: SITE, date: DAY, force: "1" });
    expect(out.status).toBe(200);
    expect(emails).toHaveLength(1);
    expect(out.body).toMatchObject({ ok: true, source: "published", generation_id: (await generation()).g });
  }, 120_000);
});
