/** F8 Reports v2: contract helpers and the /api/reports/overview handler (no database). */
import { describe, expect, it, vi } from "vitest";
import { createOverviewHandler } from "../../api/reports/overview";
import type { AuthDeps, GenerationMeta, PublishedReader } from "../../api/_lib/production-reporting";
import type { RpcClient } from "../../api/_lib/reporting-jobs";
import {
  csvCell,
  dateSpan,
  departmentLabel,
  overviewCsv,
  overviewKey,
  overviewQuery,
  parseOverviewBody,
  validateOverviewRequest,
  type OverviewResult,
} from "../../src/lib/domain/reportsOverview";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const D1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JWT = "aaa.bbb.ccc";
const zero = { items: 0, orders: 0 };

describe("request validation and identity", () => {
  it("accepts the documented filters and refuses anything else", () => {
    expect(validateOverviewRequest({ site: "au", firstDate: "2026-11-16", lastDate: "2026-11-22", staffId: U1, workType: "framed", departmentId: "unknown" })).toEqual({ site: "au", firstDate: "2026-11-16", lastDate: "2026-11-22", staffId: U1, workType: "framed", departmentId: "unknown" });
    for (const bad of [
      { site: "nz", firstDate: "2026-11-16", lastDate: "2026-11-16" },
      { site: "au", firstDate: "2026-11-17", lastDate: "2026-11-16" },
      { site: "au", firstDate: "2026-02-30", lastDate: "2026-03-01" },
      { site: "au", firstDate: "2024-11-21", lastDate: "2026-11-22" }, // 731 + 1 dates
      { site: "au", firstDate: "2026-11-16", lastDate: "2026-11-16", staffId: "me" },
      { site: "au", firstDate: "2026-11-16", lastDate: "2026-11-16", workType: "payroll" },
      { site: "au", firstDate: "2026-11-16", lastDate: "2026-11-16", departmentId: "Framing" },
    ]) expect(() => validateOverviewRequest(bad)).toThrow();
    expect(dateSpan("2024-11-22", "2026-11-22")).toBe(731);
    expect(() => validateOverviewRequest({ site: "au", firstDate: "2024-11-22", lastDate: "2026-11-22" })).not.toThrow();
  });
  it("the identity key changes with user and every filter", () => {
    const r = { site: "uk" as const, firstDate: "2026-11-16", lastDate: "2026-11-22" };
    const keys = [overviewKey(U1, r), overviewKey(U2, r), overviewKey(U1, { ...r, site: "au" }), overviewKey(U1, { ...r, departmentId: D1 }), overviewKey(U1, { ...r, workType: "dispatch" })];
    expect(new Set(keys).size).toBe(keys.length);
    expect(overviewQuery({ ...r, staffId: U1 })).toBe(`site=uk&firstDate=2026-11-16&lastDate=2026-11-22&staffId=${U1}`);
  });
});

describe("strict body parsing", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    totals: { normal: { items: 3, orders: 1 }, rework: zero },
    daily: [{ productionDate: "2026-11-16", normal: { items: 3, orders: 1 }, rework: zero }, { productionDate: "2026-11-17", normal: zero, rework: zero }],
    people: [{ staffId: U1, normal: { items: 3, orders: 1 }, rework: zero }],
    departments: [{ departmentId: D1, names: ["Framing"], normal: { items: null, orders: 1 }, rework: zero }, { departmentId: null, names: [], normal: zero, rework: zero }],
    ...over,
  });
  const scope = { firstDate: "2026-11-16", lastDate: "2026-11-17" };
  it("keeps overflow null and exact counts", () => {
    const b = parseOverviewBody(body(), scope);
    expect(b.departments[0].normal.items).toBeNull();
    expect(b.daily).toHaveLength(2);
  });
  it("refuses a missing day, a rounded count, a bad id or too many groups", () => {
    expect(() => parseOverviewBody(body({ daily: [] }), scope)).toThrow(/every production date/);
    expect(() => parseOverviewBody(body({ totals: { normal: { items: 1.5, orders: 1 }, rework: zero } }), scope)).toThrow();
    expect(() => parseOverviewBody(body({ people: [{ staffId: "x", normal: zero, rework: zero }] }), scope)).toThrow();
    expect(() => parseOverviewBody(body(), { ...scope, groupLimit: 1 })).toThrow(/limit/);
  });
});

describe("labels and CSV", () => {
  it("Unknown, renamed and unnamed departments", () => {
    expect(departmentLabel({ departmentId: null, names: [] })).toBe("Unknown");
    expect(departmentLabel({ departmentId: D1, names: ["Mounting", "Mount"] })).toBe("Mounting (also recorded as Mount)");
    expect(departmentLabel({ departmentId: D1, names: [] })).toBe("Unnamed department");
  });
  it("neutralises formula prefixes and quotes separators", () => {
    expect(["=1+1", "+1", "-1", "@x", "\tx", "a,b", 'say "hi"', null, 7].map(csvCell)).toEqual(["'=1+1", "'+1", "'-1", "'@x", "'\tx", '"a,b"', '"say ""hi"""', "", "7"]);
  });
  it("the summary CSV carries the filters, generation, cutoff and every shown row", () => {
    const r: OverviewResult = {
      ...parseOverviewBody({ totals: { normal: { items: null, orders: 2 }, rework: zero }, daily: [{ productionDate: "2026-11-16", normal: { items: null, orders: 2 }, rework: zero }], people: [{ staffId: U1, normal: { items: 1, orders: 1 }, rework: zero }], departments: [{ departmentId: null, names: [], normal: { items: 1, orders: 1 }, rework: zero }] }, { firstDate: "2026-11-16", lastDate: "2026-11-16" }),
      request: { site: "au", firstDate: "2026-11-16", lastDate: "2026-11-16", departmentId: "unknown" },
      meta: { site: "au", generationId: "g-1", ruleVersion: "r", sourceCutoffUtc: "2026-11-16T10:00:00.000000Z", verifiedAtUtc: "x", publishedAtUtc: "x", freshUntilUtc: "x", expiresAtUtc: "", visibility: { kind: "site" }, state: "outdated" },
    };
    const lines = overviewCsv(r, { person: () => "Ana", department: "Unknown" }).split("\r\n");
    expect(lines).toContain("department,Unknown");
    expect(lines).toContain("source_cutoff_utc,2026-11-16T10:00:00.000000Z");
    expect(lines).toContain("freshness,outdated");
    expect(lines).toContain("total,,Whole period,overflow,2,0,0");
    expect(lines).toContain(`person,${U1},Ana,1,1,0,0`);
    expect(lines).toContain("department,unknown,Unknown,1,1,0,0");
  });
});

describe("GET /api/reports/overview", () => {
  const gen: GenerationMeta = { generationId: "99999999-9999-4999-8999-999999999999", site: "au", state: "published", complete: true, ruleVersion: "r1", sourceCutoffUtc: "2026-11-22T23:00:00Z", verifiedAtUtc: "2026-11-22T23:01:00Z", publishedAtUtc: "2026-11-22T23:02:00Z", expiresAtUtc: null, readMode: "summary" };
  const okBody = { totals: { normal: zero, rework: zero }, daily: [{ productionDate: "2026-11-22", normal: zero, rework: zero }], people: [], departments: [] };
  function setup(role: string, opts: { nav?: unknown; sites?: string[]; readMode?: GenerationMeta["readMode"]; rpcError?: string } = {}) {
    const rpc = vi.fn(async () => (opts.rpcError ? { data: null, error: { message: opts.rpcError } } : { data: okBody, error: null }));
    const reader = { generation: vi.fn(async () => ({ ...gen, readMode: opts.readMode ?? "summary" })) } as unknown as PublishedReader;
    const auth: AuthDeps = { getUser: async () => U1, profile: async () => ({ role, allowed_nav: opts.nav ?? null }), memberships: async () => opts.sites ?? ["au"] };
    const handler = createOverviewHandler({ auth: () => auth, service: () => ({ reader, rpc: { rpc } as unknown as RpcClient }), now: () => Date.parse("2026-11-23T00:00:00Z") });
    const call = async (query: Record<string, string>, method = "GET", headers: Record<string, string> = { authorization: `Bearer ${JWT}` }) => {
      let status = 0;
      let body: unknown;
      const res = { setHeader: () => res, status: (s: number) => ({ json: (b: unknown) => { status = s; body = b; } }) };
      await handler({ method, headers, query }, res);
      return { status, body: body as Record<string, unknown> };
    };
    return { call, rpc, reader };
  }
  const Q = { site: "au", firstDate: "2026-11-22", lastDate: "2026-11-22" };

  it("401 before anything; 405; 400 for unknown parameters", async () => {
    const s = setup("owner");
    expect((await s.call(Q, "GET", {})).status).toBe(401);
    expect((await s.call(Q, "POST")).status).toBe(405);
    expect((await s.call({ ...Q, payroll: "1" })).status).toBe(400);
    expect(s.rpc).not.toHaveBeenCalled();
  });
  it("owner reads; the RPC gets the server audience and the cutoff/generation come back", async () => {
    const s = setup("owner");
    const r = await s.call(Q);
    expect(r.status).toBe(200);
    expect((r.body.meta as Record<string, unknown>).generationId).toBe(gen.generationId);
    expect(s.rpc).toHaveBeenCalledWith("read_reports_overview", expect.objectContaining({ p_audience_kind: "site", p_audience_staff: null, p_start: "2026-11-21T17:00:00.000Z", p_group_limit: 1000 }));
  });
  it("staff are forced to themselves and a forged person is 403 with no data read; kiosk and CS without nav are 403", async () => {
    const staff = setup("staff", { nav: ["welcome", "reports"] });
    expect((await staff.call(Q)).status).toBe(200);
    expect(staff.rpc).toHaveBeenCalledWith("read_reports_overview", expect.objectContaining({ p_audience_kind: "self", p_audience_staff: U1, p_staff: U1 }));
    const forged = setup("staff", { nav: ["welcome", "reports"] });
    expect((await forged.call({ ...Q, staffId: U2 })).status).toBe(403);
    expect(forged.reader.generation).not.toHaveBeenCalled();
    expect((await setup("kiosk", { nav: ["order_submission", "reports"] }).call(Q)).status).toBe(403);
    expect((await setup("cs").call(Q)).status).toBe(403);
    expect((await setup("cs", { nav: ["cs_cases", "reports"] }).call(Q)).status).toBe(200);
    expect((await setup("manager", { sites: ["uk"] }).call(Q)).status).toBe(403); // not assigned to AU
  });
  it("a legacy site is an explicit 503 READ_MODE_LEGACY (no raw-history fallback); too many groups is TOO_LARGE", async () => {
    const legacy = await setup("owner", { readMode: "legacy" }).call(Q);
    expect([legacy.status, legacy.body.code]).toEqual([503, "READ_MODE_LEGACY"]);
    const big = await setup("owner", { rpcError: "read_reports_overview: 1200 people exceed the limit 1000" }).call(Q);
    expect([big.status, big.body.code]).toEqual([503, "TOO_LARGE"]);
  });
});
