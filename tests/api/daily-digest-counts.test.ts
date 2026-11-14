/**
 * F1 count tests for api/reports/daily-digest.ts (Task 8).
 *
 * Supabase (tables + the evidence RPC), XLSX and fetch are mocked; values
 * are synthetic. Expected numbers are written out from the fixture, never
 * computed by the code under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Op = [string, unknown[]];

const h = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, Row[]>,
    tableErrors: {} as Record<string, { message: string }>,
    /** Server row cap per request (PostgREST max-rows). */
    maxRows: 1000,
    /** Replace one page's response (failure injection). */
    pageHook: null as null | ((table: string, win: [number, number] | null) => { data: unknown; error: unknown; count?: number | null } | null),
    queries: [] as Array<{ table: string; ops: Op[] }>,
    rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
    rpcImpl: null as null | ((name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }),
    rpcOverride: null as null | ((envelope: unknown) => { data: unknown; error: unknown }),
  };
  function applyFilters(rows: Row[], ops: Op[]): Row[] {
    return rows.filter((row) =>
      ops.every(([op, args]) => {
        const v = row[String(args[0])];
        switch (op) {
          case "eq": return v === args[1];
          case "gte": return String(v) >= String(args[1]);
          case "lt": return typeof args[1] === "number" ? Number(v) < args[1] : String(v) < String(args[1]);
          case "lte": return String(v) <= String(args[1]);
          case "in": return (args[1] as unknown[]).includes(v);
          default: return true;
        }
      }),
    );
  }
  function makeQuery(table: string) {
    const rec = { table, ops: [] as Op[] };
    state.queries.push(rec);
    const q: Record<string, unknown> = {};
    let win: [number, number] | null = null;
    let counted = false;
    for (const m of ["select", "eq", "gte", "lt", "lte", "in", "order"]) {
      q[m] = (...args: unknown[]) => {
        if (m === "select") counted = (args[1] as { count?: string } | undefined)?.count === "exact";
        else if (m !== "order") rec.ops.push([m, args]);
        return q;
      };
    }
    q.range = (from: number, to: number) => { win = [from, to]; return q; };
    q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
      const err = state.tableErrors[table];
      const rows = applyFilters(state.tables[table] ?? [], rec.ops);
      const hook = state.pageHook?.(table, win);
      if (hook) return Promise.resolve(hook).then(ok, bad);
      return Promise.resolve(err ? { data: null, error: err } : { data: win ? rows.slice(win[0], Math.min(win[1] + 1, win[0] + state.maxRows)) : rows, error: null, count: counted ? rows.length : null }).then(ok, bad);
    };
    return q;
  }
  const createClient = vi.fn((_url: string, _key: string) => ({
    from: vi.fn((table: string) => makeQuery(table)),
    rpc: vi.fn((name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      let result = state.rpcImpl ? state.rpcImpl(name, args) : { data: null, error: { message: "no rpc" } };
      if (state.rpcOverride) result = state.rpcOverride(result.data);
      return { then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(result).then(ok, bad) };
    }),
  }));
  const utils = {
    aoa_to_sheet: vi.fn((rows: unknown[][]) => ({ __rows: rows })),
    book_new: vi.fn(() => ({ sheets: [] as unknown[] })),
    book_append_sheet: vi.fn((wb: { sheets: unknown[] }, sheet: unknown, name: string) => { wb.sheets.push({ name, sheet }); }),
  };
  const write = vi.fn(() => new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer);
  return { state, createClient, utils, write };
});

vi.mock("@supabase/supabase-js", () => ({ createClient: h.createClient }));
vi.mock("xlsx", () => ({ utils: h.utils, write: h.write }));

import handler from "../../api/reports/daily-digest";
import { encodeV2, fakeEvidence, type FakeRpcArgs } from "../fixtures/fakeSupabaseEvents";
import type { ProductionEvidenceEvent } from "../../src/lib/domain/productionCounts";

h.state.rpcImpl = (name, raw) => {
  if (name !== "load_production_evidence_v2") return { data: null, error: { message: `unexpected rpc ${name}` } };
  const args = raw as unknown as FakeRpcArgs;
  const rows = (h.state.tables.production_events ?? []).filter((r) => ["line_verified", "completed", "dispatched", "cancelled"].includes(String(r.event_type))) as unknown as ProductionEvidenceEvent[];
  const enc = encodeV2(fakeEvidence(rows, args, () => true));
  return {
    data: { version: 2, site: args.p_site, startUtc: args.p_start_utc, endUtcExclusive: args.p_end_utc_exclusive, asOfUtc: args.p_as_of_utc, complete: true, rowCount: enc.rows.length, staffIds: enc.staffIds, skus: enc.skus, rows: enc.rows },
    error: null,
  };
};

type Req = Parameters<typeof handler>[0];
interface Out { status: number | null; headers: Record<string, string>; json: unknown; sent: unknown }
async function call(query: Req["query"], headers: Req["headers"] = AUTH): Promise<Out> {
  const out: Out = { status: null, headers: {}, json: undefined, sent: undefined };
  const res = {
    status(c: number) { out.status = c; return res; },
    json(b: unknown) { out.json = b; },
    send(b: string | Buffer) { out.sent = b; },
    setHeader(k: string, v: string) { out.headers[k.toLowerCase()] = v; },
  };
  await handler({ method: "GET", headers, query }, res);
  return out;
}

const SECRET = "test-cron-secret-counts-0123456789";
const AUTH = { authorization: `Bearer ${SECRET}` };
const RESEND_URL = "https://api.resend.com/emails";
const ENV = {
  CRON_SECRET: SECRET,
  REPORT_RECIPIENT: "default-inbox@example.test",
  RESEND_API_KEY: "re_test_key",
  FROM_EMAIL: "reports@example.test",
  SUPABASE_URL: "https://staging.example.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
} as const;
const ENV_KEYS = [...Object.keys(ENV), "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "REPORT_RECIPIENT_ALLOWLIST"];
let saved: Record<string, string | undefined> = {};
const fetchMock = vi.fn(async (input: unknown, _init?: unknown): Promise<unknown> => {
  if (String(input) === RESEND_URL) return { ok: true, status: 200, text: async () => "{}" };
  throw new Error(`unexpected network call to ${String(input)}`);
});

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
let seq = 0;
function ev(p: Partial<ProductionEvidenceEvent> & { event_type: string; created_at: string }): Row {
  seq += 1;
  return {
    id: `uk-${String(seq).padStart(3, "0")}`, location: "uk", staff_id: A, department: "unframed", order_number: "1001",
    line_sku: null, line_quantity: null, parent_event_id: null, cs_case_id: null, ...p,
  };
}
function seed(...rows: Row[]) {
  h.state.tables.production_events = [...(h.state.tables.production_events ?? []), ...rows];
}

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, ENV);
  h.state.tables = { staff_barcodes: [{ user_id: A, display_name: "Ana", location: "uk" }, { user_id: B, display_name: "Ben", location: "uk" }] };
  h.state.tableErrors = {};
  h.state.queries = [];
  h.state.rpcCalls = [];
  h.state.rpcOverride = null;
  h.state.maxRows = 1000;
  h.state.pageHook = null;
  seq = 0;
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-17T12:00:00Z"));
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const sheet = (i: number) => h.utils.aoa_to_sheet.mock.calls[i][0] as unknown[][];
const byHeader = (i: number) => {
  const [head, ...rows] = sheet(i);
  return rows.map((r) => Object.fromEntries((head as string[]).map((k, j) => [k, r[j]])));
};
const emailText = () => {
  const c = fetchMock.mock.calls.find((x) => String(x[0]) === RESEND_URL);
  return c ? (JSON.parse(String((c[1] as { body: string }).body)) as { text: string; html: string }).text : null;
};

/** UK, January (local = UTC). Report day 2026-01-15; yesterday 2026-01-14. */
function standardDay() {
  seed(
    // Ana, unframed: two UN S2 sets = 4 Items; completes order 1001.
    ev({ event_type: "clock_in", created_at: "2026-01-15T08:00:00.000Z" }),
    ev({ event_type: "line_verified", line_sku: "INKA-S2BON0064-A1-UN", line_quantity: 2, created_at: "2026-01-15T09:00:00.000Z" }),
    ev({ event_type: "completed", line_quantity: 7, created_at: "2026-01-15T09:10:00.000Z" }),
    ev({ event_type: "completed", line_quantity: 7, created_at: "2026-01-15T09:12:00.000Z" }), // repeated terminal: still one Order
    ev({ event_type: "clock_out", created_at: "2026-01-15T16:00:00.000Z" }),
    // Ben, dispatch: verifies the framed print (1 Item) and dispatches the SAME order.
    ev({ staff_id: B, department: "dispatch", event_type: "line_verified", line_sku: "INKA-KAN0566-A4-FB", line_quantity: 1, created_at: "2026-01-15T11:00:00.000Z" }),
    ev({ staff_id: B, department: "dispatch", event_type: "dispatched", created_at: "2026-01-15T11:05:00.000Z" }),
    // Ana, framed CS rework on case c-1: 1 rework Item, 1 rework Order.
    ev({ department: "framed", order_number: "2002", cs_case_id: "c-1", event_type: "line_verified", line_sku: "INKA-KAN0566-A4-FB", line_quantity: 1, created_at: "2026-01-15T13:00:00.000Z" }),
    ev({ department: "framed", order_number: "2002", cs_case_id: "c-1", event_type: "completed", created_at: "2026-01-15T13:30:00.000Z" }),
    // Yesterday: Ana completes 3003 with an A4 FB single (1 Item).
    ev({ order_number: "3003", event_type: "line_verified", line_sku: "INKA-KAN0566-A4-UN", line_quantity: 1, created_at: "2026-01-14T10:00:00.000Z" }),
    ev({ order_number: "3003", event_type: "completed", created_at: "2026-01-14T10:10:00.000Z" }),
  );
}

describe("digest counts use the shared F1 rules", () => {
  it("Summary, Departments, Staff and email agree with explicit fixture values", async () => {
    standardDay();
    const out = await call({ location: "uk", date: "2026-01-15" });
    expect(out.status).toBe(200);
    expect(out.json).toMatchObject({
      ymd: "2026-01-15",
      counts: { orders_today: 1, items_today: 5, staff_today: 2, rework_orders_today: 1, rework_items_today: 1 },
    });

    // One evidence read for both days under one cutoff.
    expect(h.state.rpcCalls).toHaveLength(1);
    expect(h.state.rpcCalls[0].args).toEqual({
      p_site: "uk",
      p_start_utc: "2026-01-14T04:00:00.000Z",
      p_end_utc_exclusive: "2026-01-16T04:00:00.000Z",
      p_as_of_utc: "2026-01-17T12:00:00.000Z",
    });

    const [summary] = byHeader(0);
    expect(summary).toMatchObject({
      date: "2026-01-15", location: "UK",
      orders_total: 1, // distinct across departments, not unframed 1 + dispatch 1
      items_total: 5, orders_yesterday: 1, items_yesterday: 1,
      staff_on_shift: 2, rework_orders: 1, rework_items: 1, coverage_issues: 0,
      timezone: "Europe/London", window_start_utc: "2026-01-15T04:00:00.000Z", window_end_utc: "2026-01-16T04:00:00.000Z",
      as_of_utc: "2026-01-17T12:00:00.000Z", status: "final (day closed before the cutoff)",
    });

    const depts = Object.fromEntries(byHeader(1).map((r) => [r.department, r]));
    expect(depts.Unframed).toMatchObject({ orders: 1, items: 4, orders_yesterday: 1, items_yesterday: 1, rework_orders: 0 });
    expect(depts.Dispatch).toMatchObject({ orders: 1, items: 1, orders_yesterday: 0, items_yesterday: 0 });
    expect(depts.Framed).toMatchObject({ orders: 0, items: 0, rework_orders: 1, rework_items: 1 });
    expect(depts["A0 Framed"]).toMatchObject({ orders: 0, items: 0 });

    const staff = byHeader(2);
    expect(staff.find((r) => r.department === "Unframed" && r.staff_name === "Ana")).toMatchObject({ orders: 1, items: 4, hours_worked: 8, items_per_hour: 0.5, shift_start: "08:00", shift_end: "16:00" });
    expect(staff.find((r) => r.department === "Dispatch" && r.staff_name === "Ben")).toMatchObject({ orders: 1, items: 1 });
    expect(staff.find((r) => r.department === "Framed" && r.staff_name === "Ana")).toMatchObject({ orders: 0, items: 0, rework_orders: 1, rework_items: 1 });

    const notes = byHeader(3).map((r) => r.note);
    expect(notes).toEqual(["Zero activity — rostering gap?"]); // A0 Framed only; no data warnings
    expect(byHeader(3)[0]).toMatchObject({ department: "A0 Framed", severity: "info" });

    const text = emailText()!;
    expect(text).toContain("Production day: 2026-01-15 04:00 to 2026-01-16 04:00 Europe/London");
    expect(text).toContain("Status: final (day closed before the cutoff)");
    expect(text).toContain("Cutoff (as of): 17 Jan 2026, 12:00 (2026-01-17T12:00:00.000Z)");
    expect(text).toMatch(/Orders completed\s+1\s/);
    expect(text).toMatch(/Items processed\s+5\s/);
    expect(text).toMatch(/CS \/ rework\s+1\s+orders, 1 items/);
    expect(text).toContain("  Unframed: 1 orders / 4 items   (^ from 1/1)");
    expect(text).toContain("  Framed: 0 orders / 0 items   (^ from 0/0); rework 1/1");
    expect(text).toContain("    1. Ana            1 orders / 4 items");
  });

  it("a cancellation today of yesterday's line lowers yesterday, never today", async () => {
    const y = ev({ department: "framed", order_number: "4004", event_type: "line_verified", line_sku: "INKA-KAN0566-A4-FB", line_quantity: 3, created_at: "2026-01-14T15:00:00.000Z" });
    seed(
      y,
      ev({ staff_id: B, department: "framed", order_number: "4004", event_type: "cancelled", parent_event_id: String(y.id), created_at: "2026-01-15T09:00:00.000Z" }),
      ev({ event_type: "line_verified", line_sku: "INKA-KAN0566-A4-UN", line_quantity: 1, created_at: "2026-01-15T10:00:00.000Z" }),
    );
    const out = await call({ location: "uk", date: "2026-01-15" });
    expect(out.json).toMatchObject({ counts: { items_today: 1 } });
    expect(byHeader(0)[0]).toMatchObject({ items_total: 1, items_yesterday: 0 });
  });

  it("UK autumn DST: 03:30 GMT after the clocks go back is still the previous production day", async () => {
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    seed(
      ev({ event_type: "line_verified", line_sku: "INKA-KAN0566-A4-UN", line_quantity: 1, created_at: "2026-10-25T03:30:00.000Z" }),
      ev({ event_type: "completed", created_at: "2026-10-25T03:40:00.000Z" }),
    );
    const out = await call({ location: "uk", date: "2026-10-24" });
    expect(out.json).toMatchObject({ counts: { orders_today: 1, items_today: 1 } });
    expect(byHeader(0)[0]).toMatchObject({ window_start_utc: "2026-10-24T03:00:00.000Z", window_end_utc: "2026-10-25T04:00:00.000Z" });
  });

  it("default date is the site's current production date and is labelled as-of while open", async () => {
    vi.setSystemTime(new Date("2026-01-15T22:55:00Z"));
    standardDay();
    const out = await call({ location: "uk" });
    expect(out.json).toMatchObject({ ymd: "2026-01-15", as_of_utc: "2026-01-15T22:55:00.000Z" });
    expect(String(byHeader(0)[0].status)).toContain("day not yet closed");
    expect(emailText()).toContain("(day not yet closed)");
  });

  it("a rework-only or warning-only day is not skipped as empty", async () => {
    seed(
      ev({ department: "framed", cs_case_id: "c-9", event_type: "line_verified", line_sku: "INKA-KAN0566-A4-FB", line_quantity: 1, created_at: "2026-01-15T09:00:00.000Z" }),
      ev({ department: "framed", cs_case_id: "c-9", event_type: "completed", created_at: "2026-01-15T09:30:00.000Z" }),
    );
    const rework = await call({ location: "uk", date: "2026-01-15" });
    expect(rework.json).toMatchObject({ ok: true, counts: { orders_today: 0, items_today: 0, rework_orders_today: 1 } });
    expect(emailText()).not.toBeNull();

    h.state.tables.production_events = [ev({ event_type: "line_verified", line_sku: "A4 21x30 cm / Framed Print (Black)", line_quantity: 1, created_at: "2026-01-16T09:00:00.000Z" })];
    h.utils.aoa_to_sheet.mockClear();
    const warn = await call({ location: "uk", date: "2026-01-16" });
    expect(warn.json).not.toHaveProperty("skipped");
    expect(byHeader(3).map((r) => r.note)).toContain("1 unrecognised SKUs: totals may be incomplete.");
    expect(byHeader(0)[0]).toMatchObject({ coverage_issues: 1 });
  });
});

describe("digest refuses to report from incomplete or unauthorized reads", () => {
  for (const [label, date] of [["impossible", "2026-02-30"], ["unpadded", "2026-1-5"], ["repeated", ["2026-01-15", "2026-01-15"]], ["empty", ""]] as const) {
    it(`400 for an ${label} date, before any report read`, async () => {
      const out = await call({ location: "uk", date: date as string | string[] });
      expect(out.status).toBe(400);
      expect(out.json).toEqual({ error: "Invalid date" });
      expect(out.headers["cache-control"]).toBe("no-store");
      expect(h.createClient).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("authentication still comes before date validation", async () => {
    const out = await call({ location: "uk", date: "nope" }, { authorization: "Bearer wrong" });
    expect(out.status).toBe(401);
  });

  it("without the service-role key the anon key is never used for a full-site report", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.VITE_SUPABASE_ANON_KEY = "anon-test-key";
    standardDay();
    const out = await call({ location: "uk", date: "2026-01-15" });
    expect(out.status).toBe(500);
    expect(out.json).toEqual({ error: "Full-site report needs SUPABASE_SERVICE_ROLE_KEY" });
    expect(h.createClient).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes the server credential to the client it reads with", async () => {
    standardDay();
    await call({ location: "uk", date: "2026-01-15", dry: "1" });
    expect(h.createClient).toHaveBeenCalledWith("https://staging.example.test", "service-role-test-key");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const failures: Array<[string, () => void]> = [
    ["an evidence RPC error", () => { h.state.rpcOverride = () => ({ data: null, error: { message: "timeout" } }); }],
    ["a malformed evidence envelope", () => { h.state.rpcOverride = (d) => ({ data: { ...(d as object), complete: false }, error: null }); }],
    ["a wrong evidence row count", () => { h.state.rpcOverride = (d) => ({ data: { ...(d as object), rowCount: 999 }, error: null }); }],
    ["a failed clock read", () => { h.state.tableErrors.production_events = { message: "boom" }; }],
    ["a failed products read", () => { h.state.tableErrors.products = { message: "boom" }; }],
    ["a failed ledger read", () => { h.state.tableErrors.ledger = { message: "boom" }; }],
    ["a failed staff-name read", () => { h.state.tableErrors.staff_barcodes = { message: "boom" }; }],
  ];
  for (const [label, arrange] of failures) {
    it(`no workbook and no email after ${label}`, async () => {
      standardDay();
      arrange();
      const out = await call({ location: "uk", date: "2026-01-15" });
      expect(out.status).toBe(500);
      expect(out.headers["cache-control"]).toBe("no-store");
      expect(h.write).not.toHaveBeenCalled();
      expect(h.utils.book_new).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("pages the clock read instead of truncating at one page", async () => {
    const clocks: Row[] = [];
    for (let i = 0; i < 1500; i++) clocks.push(ev({ event_type: i % 2 ? "clock_out" : "clock_in", created_at: `2026-01-15T${String(8 + Math.floor(i / 200)).padStart(2, "0")}:00:00.000Z` }));
    seed(...clocks, ev({ event_type: "clock_out", staff_id: B, department: "dispatch", created_at: "2026-01-15T20:00:00.000Z" }));
    seed(ev({ event_type: "line_verified", line_sku: "INKA-KAN0566-A4-UN", line_quantity: 1, created_at: "2026-01-15T10:00:00.000Z" }));
    const out = await call({ location: "uk", date: "2026-01-15" });
    // Ben appears only through the row on the second page.
    expect(out.json).toMatchObject({ counts: { staff_today: 2 } });
  });

  describe("ancillary reads are complete even under a smaller server row cap (review r1 M3)", () => {
    beforeEach(() => { h.state.maxRows = 500; });
    const line = () => ev({ event_type: "line_verified", line_sku: "INKA-KAN0566-A4-UN", line_quantity: 1, created_at: "2026-01-15T10:00:00.000Z" });

    it("clock rows: every page is read", async () => {
      const rows: Row[] = [];
      for (let i = 0; i < 1200; i++) rows.push(ev({ event_type: i % 2 ? "clock_out" : "clock_in", created_at: `2026-01-15T${String(8 + Math.floor(i / 200)).padStart(2, "0")}:00:00.000Z` }));
      seed(...rows, ev({ staff_id: B, department: "dispatch", event_type: "clock_out", created_at: "2026-01-15T20:00:00.000Z" }), line());
      const out = await call({ location: "uk", date: "2026-01-15" });
      expect(out.json).toMatchObject({ counts: { staff_today: 2 } });
      const pages = h.state.queries.filter((q) => q.table === "production_events");
      expect(pages.length).toBe(3); // 500 + 500 + 201
    });

    it("ledger rows: boxes count every page", async () => {
      h.state.tables.products = [{ id: "p-a0d", code: "A0-Double", location: "uk" }];
      const ledger: Row[] = [];
      for (let i = 0; i < 700; i++) ledger.push({ id: `l-${String(i).padStart(4, "0")}`, location: "uk", product_id: "p-a0d", delta: -1, ts: "2026-01-15T12:00:00.000Z" });
      h.state.tables.ledger = ledger;
      seed(line());
      await call({ location: "uk", date: "2026-01-15" });
      const a0 = byHeader(1).find((r) => r.department === "A0 Framed")!;
      expect(a0.boxes_used).toBe(700);
    });

    it("staff names: a name on a later page is still found", async () => {
      const names: Row[] = [];
      for (let i = 0; i < 600; i++) names.push({ user_id: A, display_name: "Ana", barcode: `b${String(i).padStart(4, "0")}`, location: "uk" });
      names.push({ user_id: B, display_name: "Ben", barcode: "z0001", location: "uk" });
      h.state.tables.staff_barcodes = names;
      seed(line(), ev({ staff_id: B, department: "dispatch", event_type: "dispatched", created_at: "2026-01-15T11:00:00.000Z" }));
      await call({ location: "uk", date: "2026-01-15" });
      expect(byHeader(2).map((r) => r.staff_name)).toContain("Ben");
    });

    const broken: Array<[string, string, () => { data: unknown; error: unknown; count?: number | null }]> = [
      ["an error on the second page", "ledger", () => ({ data: null, error: { message: "page 2 failed" }, count: null })],
      ["a body without rows and without an error", "ledger", () => ({ data: null, error: null, count: 700 })],
      ["a count that changes between pages", "ledger", () => ({ data: [], error: null, count: 701 })],
      ["an empty page before the count is reached", "production_events", () => ({ data: [], error: null, count: 1201 })],
      // Review r2 R2-6: later-page failures of the clock and staff-name readers too.
      ["a clock read error on the second page", "production_events", () => ({ data: null, error: { message: "clock page 2 failed" }, count: null })],
      ["a clock page without rows and without an error", "production_events", () => ({ data: null, error: null, count: 1201 })],
      ["a staff-name read error on the second page", "staff_barcodes", () => ({ data: null, error: { message: "names page 2 failed" }, count: null })],
      ["a staff-name page without rows and without an error", "staff_barcodes", () => ({ data: null, error: null, count: 600 })],
      ["a staff-name count that changes between pages", "staff_barcodes", () => ({ data: [], error: null, count: 601 })],
    ];
    for (const [label, table, page] of broken) {
      it(`fails before any workbook or email on ${label}`, async () => {
        h.state.tables.staff_barcodes = Array.from({ length: 600 }, (_, i) => ({ user_id: A, display_name: "Ana", barcode: `b${String(i).padStart(4, "0")}`, location: "uk" }));
        h.state.tables.products = [{ id: "p-a0d", code: "A0-Double", location: "uk" }];
        h.state.tables.ledger = Array.from({ length: 700 }, (_, i) => ({ id: `l-${String(i).padStart(4, "0")}`, location: "uk", product_id: "p-a0d", delta: -1, ts: "2026-01-15T12:00:00.000Z" }));
        const clocks: Row[] = [];
        for (let i = 0; i < 1200; i++) clocks.push(ev({ event_type: "clock_in", created_at: "2026-01-15T08:00:00.000Z" }));
        seed(...clocks, line());
        h.state.pageHook = (t, win) => (t === table && win && win[0] >= 500 ? page() : null);
        const out = await call({ location: "uk", date: "2026-01-15" });
        expect(out.status).toBe(500);
        expect(h.write).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
      });
    }

    it("a products read without rows fails the report", async () => {
      seed(line());
      h.state.pageHook = (t) => (t === "products" ? { data: null, error: null } : null);
      const out = await call({ location: "uk", date: "2026-01-15" });
      expect(out.status).toBe(500);
      expect(h.write).not.toHaveBeenCalled();
    });
  });
});

describe("warnings cover every published day (review r1 M5)", () => {
  it("a gap only on the comparison day is reported, not hidden", async () => {
    seed(
      ev({ order_number: "y1", event_type: "completed", created_at: "2026-01-14T10:00:00.000Z" }), // yesterday, no line detail
      ev({ event_type: "line_verified", line_sku: "INKA-KAN0566-A4-UN", line_quantity: 1, created_at: "2026-01-15T09:00:00.000Z" }),
      ev({ event_type: "completed", created_at: "2026-01-15T09:05:00.000Z" }),
    );
    await call({ location: "uk", date: "2026-01-15" });
    expect(byHeader(0)[0]).toMatchObject({ orders_yesterday: 1, coverage_issues: 0, coverage_issues_yesterday: 1 });
    expect(byHeader(3).map((r) => r.note)).toContain("1 completions without line detail on 2026-01-14 (comparison day): totals may be incomplete.");
    expect(emailText()).toContain("Data warnings yesterday (2026-01-14): 1 completions without line detail");
  });
});
