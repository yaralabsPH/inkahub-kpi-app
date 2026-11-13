/**
 * F1 consumer parity (Task 9): one explicit fixture through the Reports view,
 * the Welcome view, the Production counter and the authenticated digest
 * handler (mocked Supabase/XLSX/fetch), compared for equal site, person,
 * work type, window and as-of scope. Expected values are explicit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Op = [string, unknown[]];
const h = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, Row[]>,
    rpcImpl: null as null | ((name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }),
  };
  function makeQuery(table: string) {
    const ops: Op[] = [];
    let win: [number, number] | null = null;
    let counted = false;
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "lt", "lte", "in", "order"]) {
      q[m] = (...args: unknown[]) => {
        if (m === "select") counted = (args[1] as { count?: string } | undefined)?.count === "exact";
        else if (m !== "order") ops.push([m, args]);
        return q;
      };
    }
    q.range = (a: number, b: number) => { win = [a, b]; return q; };
    q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
      const rows = (state.tables[table] ?? []).filter((row) => ops.every(([op, args]) => {
        const v = row[String(args[0])];
        if (op === "eq") return v === args[1];
        if (op === "gte") return String(v) >= String(args[1]);
        if (op === "lt") return typeof args[1] === "number" ? Number(v) < args[1] : String(v) < String(args[1]);
        if (op === "lte") return String(v) <= String(args[1]);
        if (op === "in") return (args[1] as unknown[]).includes(v);
        return true;
      }));
      return Promise.resolve({ data: win ? rows.slice(win[0], win[1] + 1) : rows, error: null, count: counted ? rows.length : null }).then(ok, bad);
    };
    return q;
  }
  const createClient = vi.fn(() => ({
    from: (t: string) => makeQuery(t),
    rpc: (name: string, args: Record<string, unknown>) => {
      const r = state.rpcImpl!(name, args);
      return { then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(r).then(ok, bad) };
    },
  }));
  const utils = {
    aoa_to_sheet: vi.fn((rows: unknown[][]) => ({ __rows: rows })),
    book_new: vi.fn(() => ({})),
    book_append_sheet: vi.fn(),
  };
  return { state, createClient, utils, write: vi.fn(() => new Uint8Array([1]).buffer) };
});
vi.mock("@supabase/supabase-js", () => ({ createClient: h.createClient }));
vi.mock("xlsx", () => ({ utils: h.utils, write: h.write }));

import handler from "../../api/reports/daily-digest";
import { prepareProductionEvidence, summarizeProduction, type ProductionEvidenceEvent } from "../../src/lib/domain/productionCounts";
import { productionRange } from "../../src/lib/domain/productionPeriods";
import { buildProductionReportView } from "../../src/lib/domain/productionReportView";
import { buildProductionWelcomeView } from "../../src/lib/domain/productionWelcomeView";
import { buildProductionCounterView } from "../../src/lib/domain/productionCounterView";
import { encodeV2, fakeEvidence, type FakeRpcArgs } from "../fixtures/fakeSupabaseEvents";
import { CASE_1, SKU, WORKER_A, WORKER_B, cancel, complete, dispatch, resetIds, shuffled, verify } from "../fixtures/item-counting";

h.state.rpcImpl = (_name, raw) => {
  const args = raw as unknown as FakeRpcArgs;
  const rows = (h.state.tables.production_events ?? []) as unknown as ProductionEvidenceEvent[];
  const enc = encodeV2(fakeEvidence(rows, args, () => true));
  return { data: { version: 2, site: args.p_site, startUtc: args.p_start_utc, endUtcExclusive: args.p_end_utc_exclusive, asOfUtc: args.p_as_of_utc, complete: true, rowCount: enc.rows.length, staffIds: enc.staffIds, skus: enc.skus, rows: enc.rows }, error: null };
};

const AS_OF = "2026-01-17T12:00:00.000Z";
const DAY = productionRange("uk", "2026-01-15", "2026-01-15");
const BOTH = productionRange("uk", "2026-01-14", "2026-01-15");
const at = (d: string, t: string) => `2026-01-${d}T${t}:00.000Z`;

/** UK, January (local = UTC). Day 2026-01-15 plus 2026-01-14 context. */
function fixture(): ProductionEvidenceEvent[] {
  resetIds();
  const yLine = verify({ order_number: "900", line_sku: SKU.unSet2, line_quantity: 1, created_at: at("14", "15:00") });
  return [
    // Yesterday: A verifies a UN S2 set (2 Items) on 900; B cancels it today (removes yesterday's 2).
    yLine,
    complete({ order_number: "800", created_at: at("14", "10:00") }),
    verify({ order_number: "800", line_sku: SKU.unSingle, line_quantity: 1, created_at: at("14", "09:50") }),
    cancel(yLine, { staff_id: WORKER_B, created_at: at("15", "08:00") }),
    // Today, unframed, A: two UN S2 sets (4) on 1001, completed twice (one Order).
    verify({ order_number: "1001", line_sku: SKU.unSet2, line_quantity: 2, created_at: at("15", "09:00") }),
    complete({ order_number: "1001", created_at: at("15", "09:10") }),
    complete({ order_number: "1001", created_at: at("15", "09:20") }),
    // Today, unframed, A: 800 again (completed on both days), plus an excluded hook line.
    verify({ order_number: "800", line_sku: SKU.unSingle, line_quantity: 1, created_at: at("15", "10:00") }),
    verify({ order_number: "800", line_sku: SKU.hook, line_quantity: 3, created_at: at("15", "10:01") }),
    complete({ order_number: "800", created_at: at("15", "10:05") }),
    // Today, unframed, B: verification-only (1 Item, no Order).
    verify({ staff_id: WORKER_B, order_number: "1002", line_sku: SKU.unSingle, line_quantity: 1, created_at: at("15", "11:00") }),
    // Today, framed CS rework, A.
    verify({ department: "framed", order_number: "2002", cs_case_id: CASE_1, line_sku: SKU.framedSingle, line_quantity: 1, created_at: at("15", "13:00") }),
    complete({ department: "framed", order_number: "2002", cs_case_id: CASE_1, created_at: at("15", "13:10") }),
    // Today, dispatch, B dispatches 1001 with a verified frame line (1 Item).
    verify({ staff_id: WORKER_B, department: "dispatch", order_number: "1001", line_sku: SKU.framedSingle, line_quantity: 1, created_at: at("15", "14:00") }),
    dispatch({ staff_id: WORKER_B, order_number: "1001", created_at: at("15", "14:05") }),
  ];
}

const prepared = (events: ProductionEvidenceEvent[]) =>
  prepareProductionEvidence({ events, range: { startUtc: BOTH.startUtc, endUtcExclusive: BOTH.endUtcExclusive }, asOfUtc: AS_OF, loadedAtUtc: AS_OF, visibility: { kind: "site" } });

beforeEach(() => {
  process.env.CRON_SECRET = "parity-secret-0123456789abcdef";
  process.env.SUPABASE_URL = "https://staging.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(AS_OF));
});
afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function digestSheets(events: ProductionEvidenceEvent[]) {
  h.state.tables = {
    production_events: events as unknown as Row[],
    staff_barcodes: [{ user_id: WORKER_A, display_name: "Ana", location: "uk" }, { user_id: WORKER_B, display_name: "Ben", location: "uk" }],
  };
  let json: unknown;
  const res = { status: () => res, json: (b: unknown) => { json = b; }, send: () => {}, setHeader: () => {} };
  await handler({ method: "GET", headers: { authorization: "Bearer parity-secret-0123456789abcdef" }, query: { location: "uk", date: "2026-01-15", dry: "1" } }, res);
  expect(json).toBeUndefined(); // dry download, not an error body
  const sheet = (i: number) => {
    const [head, ...rows] = h.utils.aoa_to_sheet.mock.calls[i][0] as unknown[][];
    return rows.map((r) => Object.fromEntries((head as string[]).map((k, j) => [k, r[j]])));
  };
  return { summary: sheet(0)[0], depts: sheet(1), staff: sheet(2) };
}

describe("every consumer reports the same numbers for the same scope", () => {
  it("site/day, work type and person scopes agree across Reports, Welcome, Production and the digest", async () => {
    const events = fixture();
    const ev = prepared(events);

    // Whole site, whole day.
    const reports = buildProductionReportView(ev, { range: DAY });
    const welcome = buildProductionWelcomeView(ev, "uk", "2026-01-15T16:00:00.000Z");
    const digest = await digestSheets(events);
    expect(reports.summary.normal).toMatchObject({ items: 7, orders: 2 }); // 4 + 1 + 1 (B) + 1 (dispatch); orders 1001, 800
    expect(reports.summary.rework).toMatchObject({ items: 1, orders: 1 });
    expect(welcome.todayTotals).toEqual({ normal: { items: 7, orders: 2 }, rework: { items: 1, orders: 1 } });
    expect(digest.summary).toMatchObject({ orders_total: 2, items_total: 7, rework_orders: 1, rework_items: 1, items_yesterday: 1, orders_yesterday: 1 });
    expect(digest.summary.coverage_issues).toBe(reports.summary.coverage.issues.length);

    // Work type: unframed.
    const rUn = buildProductionReportView(ev, { range: DAY, workType: "unframed" }).summary;
    const dUn = digest.depts.find((r) => r.department === "Unframed")!;
    expect(rUn.normal).toMatchObject({ items: 6, orders: 2 });
    expect(welcome.perDepartment.unframed.normal).toEqual({ items: 6, orders: 2 });
    expect(dUn).toMatchObject({ orders: 2, items: 6 });

    // Person + work type: A at unframed.
    const rA = buildProductionReportView(ev, { range: DAY, staffId: WORKER_A, workType: "unframed" });
    const counter = buildProductionCounterView(ev, { site: "uk", date: "2026-01-15", staffId: WORKER_A, workType: "unframed" });
    const dA = digest.staff.find((r) => r.department === "Unframed" && r.staff_name === "Ana")!;
    expect(rA.summary.normal).toMatchObject({ items: 5, orders: 2 });
    expect(counter.normal).toEqual({ items: 5, orders: 2 });
    expect(welcome.perDepartment.unframed.topWorker).toEqual({ staffId: WORKER_A, orders: 2, items: 5 });
    expect(dA).toMatchObject({ orders: 2, items: 5 });
    expect(counter.coverage.issueCounts).toEqual(rA.summary.coverage.issueCounts);

    // Rework is separate everywhere.
    const rRework = buildProductionReportView(ev, { range: DAY, staffId: WORKER_A, workType: "framed" }).summary;
    const cRework = buildProductionCounterView(ev, { site: "uk", date: "2026-01-15", staffId: WORKER_A, workType: "framed" });
    const dRework = digest.staff.find((r) => r.department === "Framed" && r.staff_name === "Ana")!;
    expect(rRework.rework).toMatchObject({ items: 1, orders: 1 });
    expect(cRework.rework).toEqual({ items: 1, orders: 1 });
    expect(dRework).toMatchObject({ orders: 0, items: 0, rework_orders: 1, rework_items: 1 });
    expect(welcome.perDepartment.framed.rework).toEqual({ items: 1, orders: 1 });
  });

  it("summary equals its drill-down; reload, shuffle and repeated requests are identical", () => {
    const events = fixture();
    const a = buildProductionReportView(prepared(events), { range: DAY, staffId: WORKER_A });
    const drillItems = a.staffOrders.reduce((s, o) => s + (o.items ?? 0), 0);
    expect(drillItems).toBe((a.summary.normal.items ?? 0) + (a.summary.rework.items ?? 0));
    expect(a.staffOrders.filter((o) => o.completed).length).toBe(a.summary.normal.orders + a.summary.rework.orders);

    const reload = buildProductionReportView(prepared(shuffled(events)), { range: DAY, staffId: WORKER_A });
    const repeat = buildProductionReportView(prepared([...events, ...events]), { range: DAY, staffId: WORKER_A });
    expect(reload.summary.normal).toEqual(a.summary.normal);
    expect(repeat.summary.normal).toEqual(a.summary.normal);
    expect(reload.summary.coverage.issueCounts).toEqual(a.summary.coverage.issueCounts);
  });

  it("a longer period unions identities instead of summing days", () => {
    const ev = prepared(fixture());
    const both = summarizeProduction(ev, { range: { startUtc: BOTH.startUtc, endUtcExclusive: BOTH.endUtcExclusive } });
    const view = buildProductionReportView(ev, { range: BOTH, staffId: WORKER_A, workType: "unframed" });
    const daySum = view.personDaily!.reduce((s, d) => s + d.normal.orders, 0);
    expect(view.personDaily!.map((d) => d.normal.orders)).toEqual([1, 2]); // 800 on both days
    expect(daySum).toBe(3);
    expect(view.summary.normal.orders).toBe(2);
    expect(both.normal.orders).toBe(2);
  });

  it("a frozen snapshot keeps its values; a later corrected refresh shows the correction", () => {
    const events = fixture();
    const frozen = prepared(events);
    const before = buildProductionCounterView(frozen, { site: "uk", date: "2026-01-15", staffId: WORKER_A, workType: "unframed" });
    const lv = events.find((e) => e.order_number === "1001" && e.event_type === "line_verified" && e.department === "unframed")!;
    const corrected = prepared([...events, cancel(lv, { created_at: at("15", "18:00") })]);
    const after = buildProductionCounterView(corrected, { site: "uk", date: "2026-01-15", staffId: WORKER_A, workType: "unframed" });
    expect(before.normal).toEqual({ items: 5, orders: 2 });
    expect(after.normal).toEqual({ items: 1, orders: 2 }); // 1001 keeps its Order (qualified by original evidence)
    expect(buildProductionCounterView(frozen, { site: "uk", date: "2026-01-15", staffId: WORKER_A, workType: "unframed" }).normal).toEqual(before.normal);
  });
});
