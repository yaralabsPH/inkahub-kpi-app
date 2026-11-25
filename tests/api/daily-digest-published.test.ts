/**
 * Task 18: the daily digest's read-mode gate and published-generation refusals,
 * with a scripted RPC client (the real-SQL counts are pinned separately in
 * tests/reporting/pg/digest-published.test.ts). Every refusal happens BEFORE a
 * workbook is built or an email is sent; S1 authentication stays first.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDigestHandler, MAX_DIGEST_XLSX_BYTES } from "../../api/reports/daily-digest";

const SECRET = "test-cron-secret-0123456789";
const GEN = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-01-15T12:00:00.000Z");
const ENV = { CRON_SECRET: SECRET, VITE_SUPABASE_URL: "https://staging.example", SUPABASE_SERVICE_ROLE_KEY: "service-role-test", RESEND_API_KEY: "re_test", REPORT_RECIPIENT: "ops@example.com" };

const statusRow = (mode: string) => ({ site: "uk", processor_enabled: true, read_mode: mode, capture_enabled: true, capture_epoch: 1, source_epoch: 1, active_generation_id: GEN, active_batch_id: null, active_batch_state: null, active_batch_kind: null, lease_fence: 0, lease_expires_at: null, heartbeat_at: null, last_verified_cutoff: null, pending_changes: 0, oldest_pending_captured_at: null });
const genRow = (o: Record<string, unknown> = {}) => ({ generation_id: GEN, site: "uk", state: "published", complete: true, rule_version: "item-counting-summary-v1", source_cutoff: "2026-01-15T11:55:00.000000Z", verified_at: "2026-01-15T11:55:00.000000Z", published_at: "2026-01-15T11:56:00.000000Z", expires_at: null, read_mode: "summary", ...o });
const g = (items: number | null, orders: number) => ({ normal: { items, orders }, rework: { items: 0, orders: 0 } });
const cov = { issueCounts: { invalid_event: 0, unclassified_sku: 0, invalid_quantity: 0, unresolved_parent: 0, missing_completion_detail: 0, ambiguous_repeat: 0 }, notes: { expected_exclusion: 0, corrected_verification: 0, reversed_terminal: 0, excluded_only_completion: 0 }, issueRows: 0, overflow: false };
/** A read_reporting_summary answer for one day: `wt` null = every work type (framed 3/1), else that work type's own totals. */
function summary(args: Record<string, unknown>, o: { framedOrders?: number } = {}) {
  const wt = args.p_work_type as string | null;
  const framed = g(3, o.framedOrders ?? 1);
  const totals = wt === null || wt === "framed" ? framed : g(0, 0);
  return {
    report: {
      totals, byWorkType: ["a0_framed", "framed", "unframed", "dispatch"].map((w) => ({ workType: w, totals: w === "framed" ? g(3, 1) : g(0, 0) })),
      coverage: cov, tileCoverage: cov, activeStaff: 1, staffDays: 1, avgOrdersPerStaffDay: 1, timing: { durationMin: 0, timedWeight: 0, avgMinPerUnit: 0 },
      people: { rows: wt === null || wt === "framed" ? [{ staffId: U, ...framed, daysWorked: 1, itemsPerDay: 3, ordersPerDay: 1, timing: { durationMin: 0, timedWeight: 0, avgMinPerUnit: 0 } }] : [], total: wt === null || wt === "framed" ? 1 : 0 },
      skuTiming: [], daily: { rows: [{ productionDate: args.p_first_date, totals }], total: 1 },
    },
    welcome: null,
  };
}
type Rpc = (fn: string, args: Record<string, unknown>) => { data: unknown; error: { message: string } | null };
function client(rpc: Rpc, calls: Array<{ fn: string; args: Record<string, unknown> }>) {
  const empty = () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "lt", "lte", "in", "order", "range"]) q[m] = () => q;
    q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(ok);
    return q;
  };
  return { rpc: async (fn: string, args: Record<string, unknown>) => (calls.push({ fn, args }), rpc(fn, args)), from: empty };
}
interface Out { status: number; body: unknown; sent: unknown; emails: number; created: number; calls: Array<{ fn: string; args: Record<string, unknown> }> }
async function run(rpc: Rpc, query: Record<string, string> = { location: "uk", date: "2026-01-15", dry: "1" }, o: { headers?: Record<string, string>; method?: string; maxXlsxBytes?: number; now?: number } = {}): Promise<Out> {
  const out: Out = { status: 0, body: null, sent: null, emails: 0, created: 0, calls: [] };
  const handler = createDigestHandler({
    now: () => o.now ?? NOW,
    createClient: () => ((out.created++), client(rpc, out.calls)) as never,
    fetch: (async () => ((out.emails++), { ok: true, status: 200, text: async () => "" })) as never,
    ...(o.maxXlsxBytes ? { maxXlsxBytes: o.maxXlsxBytes } : {}),
  });
  const res = {
    setHeader: () => undefined,
    status: (s: number) => ((out.status = s), res),
    json: (b: unknown) => void (out.body = b),
    send: (b: unknown) => void (out.sent = b),
  };
  await handler({ method: o.method ?? "GET", headers: o.headers ?? { authorization: `Bearer ${SECRET}` }, query } as never, res as never);
  return out;
}
const published = (o: { gen?: Record<string, unknown>[] | null; summaryError?: string; framedOrders?: number } = {}): Rpc => (fn, args) => {
  if (fn === "get_reporting_job_status") return { data: [statusRow("summary")], error: null };
  if (fn === "read_reporting_generation") return { data: o.gen === undefined ? [genRow()] : o.gen ?? [], error: null };
  if (fn === "read_reporting_summary") return o.summaryError ? { data: null, error: { message: o.summaryError } } : { data: summary(args, { framedOrders: o.framedOrders }), error: null };
  return { data: null, error: { message: `unexpected rpc ${fn}` } };
};

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = {};
  for (const k of Object.keys(ENV)) saved[k] = process.env[k];
  Object.assign(process.env, ENV);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

describe("Task 18: the digest's read-mode gate", () => {
  it("a summary-mode site builds the workbook from ONE generation: every published read pinned to it", async () => {
    const out = await run(published());
    expect([out.status, out.sent instanceof Buffer]).toEqual([200, true]);
    const reads = out.calls.filter((c) => c.fn === "read_reporting_summary");
    expect(reads).toHaveLength(10);
    expect(new Set(reads.map((c) => c.args.p_generation))).toEqual(new Set([GEN]));
    expect(out.calls.map((c) => c.fn)).not.toContain("load_production_evidence_v2");
  });
  for (const mode of ["legacy", "shadow"]) {
    it(`a ${mode} site keeps the existing raw digest path (no published read)`, async () => {
      const out = await run((fn) => (fn === "get_reporting_job_status" ? { data: [statusRow(mode)], error: null } : { data: null, error: { message: `legacy read ${fn}` } }));
      expect(out.calls.map((c) => c.fn)).toEqual(["get_reporting_job_status", "load_production_evidence_v2"]);
      expect(out.emails).toBe(0);
    });
  }
  it("an unreadable read mode fails the digest (no silent fallback to either path)", async () => {
    const out = await run((fn) => (fn === "get_reporting_job_status" ? { data: null, error: { message: "function not found" } } : { data: null, error: null }));
    expect([out.status, out.sent, out.emails]).toEqual([500, null, 0]);
    expect(out.calls.map((c) => c.fn)).toEqual(["get_reporting_job_status"]);
  });
});

describe("Task 18: published refusals happen before any workbook or email", () => {
  const CASES: Array<[string, Rpc, RegExp, number?]> = [
    ["no published generation", published({ gen: [] }), /no published report/i],
    ["an incomplete generation", published({ gen: [genRow({ complete: false })] }), /incomplete/i],
    ["a building generation", published({ gen: [genRow({ state: "building" })] }), /incomplete/i],
    ["another site's generation", published({ gen: [genRow({ site: "au" })] }), /incomplete/i],
    ["a read mode that changed meanwhile", published({ gen: [genRow({ read_mode: "legacy" })] }), /read mode changed/i],
    ["a summary read that fails (expired/unavailable generation)", published({ summaryError: "generation is not a retained complete publication" }), /read_reporting_summary failed/],
  ];
  for (const [name, rpc, msg] of CASES) {
    for (const query of [{ location: "uk", date: "2026-01-15", dry: "1" }, { location: "uk", date: "2026-01-15", force: "1" }]) {
      it(`${name} (${query.dry ? "dry" : "send"}): 503, no workbook, no email`, async () => {
        const out = await run(rpc, query);
        expect([out.status, out.sent, out.emails]).toEqual([503, null, 0]);
        expect(out.body).toMatchObject({ error: expect.stringMatching(msg) });
      });
    }
  }
  it("staleness: verified 31 minutes ago is refused before any summary read; 30 minutes is served", async () => {
    const verified = Date.parse(genRow().verified_at as string);
    const stale = await run(published(), undefined, { now: verified + 31 * 60_000 });
    expect([stale.status, stale.sent, stale.emails]).toEqual([503, null, 0]);
    expect(stale.body).toMatchObject({ error: expect.stringMatching(/stale: verified 31 minutes ago/) });
    expect(stale.calls.map((c) => c.fn)).toEqual(["get_reporting_job_status", "read_reporting_generation"]);
    expect((await run(published(), undefined, { now: verified + 30 * 60_000 })).status).toBe(200);
  });
  it("reads of one generation that disagree (a department's totals vs the day's breakdown) fail the digest", async () => {
    const out = await run(published({ framedOrders: 2 }));
    expect([out.status, out.sent, out.emails]).toEqual([500, null, 0]);
    expect(out.body).toMatchObject({ error: expect.stringMatching(/differ between reads of one generation/) });
  });
});

describe("Task 18: context, size and S1 order", () => {
  it("without the service-role key the digest refuses (an RLS-limited view is never a complete site): no client, no RPC", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const out = await run(published());
    expect([out.status, out.created, out.calls.length, out.emails]).toEqual([500, 0, 0, 0]);
    expect(out.body).toMatchObject({ error: expect.stringMatching(/SUPABASE_SERVICE_ROLE_KEY/) });
  });
  it("a workbook over the explicit ceiling fails (never truncated): no download, no email", async () => {
    expect(MAX_DIGEST_XLSX_BYTES).toBe(4 * 1024 * 1024);
    for (const query of [{ location: "uk", date: "2026-01-15", dry: "1" }, { location: "uk", date: "2026-01-15", force: "1" }]) {
      const out = await run(published(), query, { maxXlsxBytes: 100 });
      expect([out.status, out.sent, out.emails]).toEqual([500, null, 0]);
      expect(out.body).toMatchObject({ error: expect.stringMatching(/over the 100-byte limit; nothing was sent/) });
    }
  });
  it("S1 stays first: no/invalid auth is 401 and a wrong method 405, before any client or read", async () => {
    for (const headers of [{}, { authorization: "Bearer wrong" }]) {
      const out = await run(published(), undefined, { headers });
      expect([out.status, out.created, out.calls.length]).toEqual([401, 0, 0]);
    }
    const post = await run(published(), undefined, { method: "POST" });
    expect([post.status, post.created, post.calls.length]).toEqual([405, 0, 0]);
  });
});
