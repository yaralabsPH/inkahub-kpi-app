/**
 * Task 16 (server layer): authorized published report reads, without a
 * database. Auth/membership/nav come from fakes of Supabase getUser and the
 * caller-JWT reads; the published reader is a fake that records exactly what
 * scope (audience!) it was asked for. SQL parity of the 0044 reader is a
 * separate staging gate (tests/staging/reporting-read-parity.ts).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  audienceFor, authorizeReportingRequest, bearerToken, effectiveNav, errorResponse, filterKey, freshness, NAV, readPublishedDetail, readPublishedSummary, ReportingHttpError, resolveGeneration, signCursor, verifyCursor,
  type AuthDeps, type GenerationMeta, type PublishedReader, type ReaderScope, type ReportingPrincipal, type SummaryBody,
} from "../../api/_lib/production-reporting";
import { parseGeneration, rpcPublishedReader } from "../../api/_lib/production-reporting-rpc";
import { parseDetailResponse, parseSummaryResponse } from "../../api/_lib/production-reporting-dto";
import { createDetailHandler } from "../../api/reports/detail";
import { createSummaryHandler } from "../../api/reports/summary";
import { effectiveNavAccess } from "../../src/lib/auth/permissions";
import { NAV_KEYS } from "../../src/lib/domain";

const U = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln";
const NOW = Date.parse("2026-11-16T12:00:00Z");
const SECRET = "cursor-secret-for-tests";

const gen = (o: Partial<GenerationMeta> = {}): GenerationMeta => ({ generationId: "g-1", site: "uk", state: "published", complete: true, ruleVersion: "item-counting-summary-v1", sourceCutoffUtc: "2026-11-16T11:50:00.000000Z", verifiedAtUtc: "2026-11-16T11:50:00.000Z", publishedAtUtc: "2026-11-16T11:51:00.000Z", expiresAtUtc: null, readMode: "summary", ...o });
const body = (): SummaryBody => ({
  totals: { normal: { items: 4, orders: 1 }, rework: { items: 0, orders: 0 } }, byWorkType: [], dailyPage: { rows: [], nextCursor: null, pageComplete: true, totalRows: 0 },
  coverage: { issueCounts: {} as never, notes: {} as never, visibility: { kind: "site" }, incomplete: false, issueRows: 0 }, timing: {} as never,
  peoplePage: { rows: [{} as never], nextCursor: null, pageComplete: true, totalRows: 1 }, activeStaff: 1, staffDays: 1, avgOrdersPerStaffDay: 1, skuBoard: [{ sku: "X", weight: 1, durationMin: 1, avgMin: 1 }],
  welcome: { today: "2026-11-16", coverage: { issueCounts: {}, notes: {}, visibility: { kind: "site" }, incomplete: false, issueRows: 0 }, todayCoverage: { issueCounts: {}, notes: {}, visibility: { kind: "site" }, incomplete: false, issueRows: 0 } } as never,
});
function fakeReader(g: GenerationMeta | null = gen(), detailRows = 3, siteMode: GenerationMeta["readMode"] | Error = "summary"): PublishedReader & { scopes: ReaderScope[]; generations: Array<string | null> } {
  const scopes: ReaderScope[] = [];
  const generations: Array<string | null> = [];
  return {
    scopes, generations,
    async generation(_s, id) { generations.push(id); return g; },
    async siteReadMode() { if (siteMode instanceof Error) throw siteMode; return siteMode; },
    async summary(scope) { scopes.push(scope); return body(); },
    async detail(scope, kind, _o, after, limit) {
      scopes.push(scope);
      const start = typeof after === "number" ? after : 0;
      const rows = Array.from({ length: Math.min(limit, Math.max(0, detailRows - start)) }, (_, i) => ({ kind, row: { n: start + i } }) as never);
      return { rows, last: start + rows.length, more: start + rows.length < detailRows, totalRows: detailRows };
    },
  };
}
const principal = (role: ReportingPrincipal["role"], sites = ["uk"], allowed: string[] | null = null): ReportingPrincipal => ({ userId: U, role, nav: effectiveNav({ role, allowed_nav: allowed }), sites: new Set(sites) });
function auth(role: string | null, sites: string[] = ["uk"], allowed: string[] | null = null, user: string | null = U): AuthDeps & { calls: string[] } {
  const calls: string[] = [];
  return { calls, async getUser(t) { calls.push("getUser"); return t === JWT ? user : null; }, async profile() { calls.push("profile"); return role ? { role, allowed_nav: allowed } : null; }, async memberships() { calls.push("memberships"); return sites; } };
}
const deps = (reader = fakeReader(), now = NOW) => ({ reader, now: () => now, cursorSecret: SECRET });
const SUM = { site: "uk" as const, firstDate: "2026-11-01", lastDate: "2026-11-16", view: "reports" as const };
const DET = { site: "uk" as const, generationId: "g-1", kind: "orders" as const, firstDate: "2026-11-01", lastDate: "2026-11-16" };

// ---------------------------------------------------------------------------

describe("Task 16: the server nav mirror equals the app's effectiveNavAccess", () => {
  it("same key list as NAV_KEYS", () => expect([...NAV]).toEqual([...NAV_KEYS]));
  const overrides: Array<string[] | null> = [null, [], ["reports"], ["dashboard", "reports"], ["welcome"], ["team", "settings"], [...NAV_KEYS]];
  for (const role of ["owner", "manager", "staff", "kiosk", "cs", "intruder"]) {
    for (const allowed of overrides) {
      it(`${role} with allowed_nav ${JSON.stringify(allowed)}`, () => {
        expect([...effectiveNav({ role, allowed_nav: allowed })].sort()).toEqual([...effectiveNavAccess({ user_id: U, display_name: "x", role: role as never, allowed_nav: allowed })].sort());
      });
    }
  }
});

describe("Task 16: authentication and audience (never client-chosen)", () => {
  it("bearer tokens must be exactly one well-formed JWT header", () => {
    expect(bearerToken({ authorization: `Bearer ${JWT}` })).toBe(JWT);
    for (const h of [{}, { authorization: JWT }, { authorization: `Bearer ${JWT} x` }, { authorization: "Bearer abc" }, { authorization: `Bearer ${JWT}`, Authorization: `Bearer ${JWT}` }]) expect(bearerToken(h)).toBeNull();
  });
  it("401 for missing/invalid/unknown sessions before any profile read; 403 for an unknown role", async () => {
    for (const h of [{}, { authorization: "Bearer a.b.c" }]) {
      const a = auth("owner");
      await expect(authorizeReportingRequest(h, a)).rejects.toMatchObject({ status: 401 });
      expect(a.calls).not.toContain("profile");
    }
    await expect(authorizeReportingRequest({ authorization: `Bearer ${JWT}` }, auth("owner", ["uk"], null, null))).rejects.toMatchObject({ status: 401 });
    await expect(authorizeReportingRequest({ authorization: `Bearer ${JWT}` }, auth("intruder"))).rejects.toMatchObject({ status: 403 });
    await expect(authorizeReportingRequest({ authorization: `Bearer ${JWT}` }, auth(null))).rejects.toMatchObject({ status: 403 });
  });
  const cases: Array<[ReportingPrincipal["role"], string[] | null, "reports" | "welcome", "site" | "self" | 403]> = [
    ["owner", null, "reports", "site"], ["manager", null, "reports", "site"], ["kiosk", null, "reports", 403], ["kiosk", null, "welcome", "site"], ["cs", null, "reports", 403], ["cs", null, "welcome", "site"],
    ["staff", null, "reports", "self"], ["staff", null, "welcome", "self"], ["staff", ["reports"], "reports", "self"], ["kiosk", ["reports"], "reports", "site"], ["manager", ["welcome"], "reports", 403],
  ];
  for (const [role, allowed, view, want] of cases) {
    it(`${role} (${JSON.stringify(allowed)}) ${view} → ${String(want)}`, () => {
      const p = principal(role, ["uk"], allowed);
      if (want === 403) expect(() => audienceFor(p, "uk", view)).toThrow(ReportingHttpError);
      else expect(audienceFor(p, "uk", view).audience).toEqual(want === "site" ? { kind: "site" } : { kind: "self", staffId: U });
    });
  }
  it("no membership for the site is 403 for every role", () => {
    for (const role of ["owner", "manager", "staff", "kiosk", "cs"] as const) expect(() => audienceFor(principal(role, ["au"]), "uk", "welcome")).toThrow(/membership/);
  });
  it("a staff user explicitly granted Reports reads ONLY their own audience, labelled limited, even when asking about another worker", async () => {
    const r = fakeReader();
    const out = await readPublishedSummary(principal("staff", ["uk"], ["reports"]), { ...SUM, staffId: OTHER }, deps(r));
    expect(r.scopes[0].audience).toEqual({ kind: "self", staffId: U });
    expect(r.scopes[0].staffId).toBe(OTHER); // a filter inside the self audience, never authority
    expect(out.meta.visibility).toEqual({ kind: "limited", reason: "own work only" });
  });
});

describe("Task 16: generations, freshness and the Welcome shape", () => {
  it("freshness boundaries from verified coverage: ≤30 current, ≤120 delayed, then outdated", () => {
    const v = "2026-11-16T10:00:00.000Z";
    expect(freshness(v, Date.parse("2026-11-16T10:30:00.000Z")).state).toBe("current");
    expect(freshness(v, Date.parse("2026-11-16T10:30:00.001Z")).state).toBe("delayed");
    expect(freshness(v, Date.parse("2026-11-16T12:00:00.000Z")).state).toBe("delayed");
    expect(freshness(v, Date.parse("2026-11-16T12:00:00.001Z")).state).toBe("outdated");
    expect(freshness(v, 0).freshUntilUtc).toBe("2026-11-16T10:30:00.000Z");
  });
  it("missing → 503, incomplete/building/failed → 503, expired/past expiry → 410, a missing PINNED generation → 410, another site → 400", async () => {
    await expect(resolveGeneration(fakeReader(null), "uk", null, NOW)).rejects.toMatchObject({ status: 503, code: "UNAVAILABLE" });
    await expect(resolveGeneration(fakeReader(null), "uk", "g-9", NOW)).rejects.toMatchObject({ status: 410, code: "GENERATION_EXPIRED" });
    // R2-1: no publication yet, but the site is explicitly on legacy/shadow reads -> that signal, not UNAVAILABLE.
    await expect(resolveGeneration(fakeReader(null, 3, "legacy"), "uk", null, NOW)).rejects.toMatchObject({ status: 503, code: "READ_MODE_LEGACY" });
    await expect(resolveGeneration(fakeReader(null, 3, "shadow"), "uk", null, NOW)).rejects.toMatchObject({ status: 503, code: "READ_MODE_SHADOW" });
    // A pinned generation that is gone is still 410 even for a legacy site (the view must reload).
    await expect(resolveGeneration(fakeReader(null, 3, "legacy"), "uk", "g-9", NOW)).rejects.toMatchObject({ status: 410, code: "GENERATION_EXPIRED" });
    // Site state unreadable: fail closed with the reader's 503, never a legacy answer.
    await expect(resolveGeneration(fakeReader(null, 3, new ReportingHttpError(503, "UNAVAILABLE", "site reporting state is missing")), "uk", null, NOW)).rejects.toMatchObject({ status: 503, code: "UNAVAILABLE" });
    for (const g of [gen({ complete: false }), gen({ state: "building" }), gen({ state: "failed" })]) await expect(resolveGeneration(fakeReader(g), "uk", null, NOW)).rejects.toMatchObject({ status: 503 });
    await expect(resolveGeneration(fakeReader(gen({ state: "expired" })), "uk", "g-1", NOW)).rejects.toMatchObject({ status: 410 });
    await expect(resolveGeneration(fakeReader(gen({ state: "superseded", expiresAtUtc: "2026-11-16T11:59:59Z" })), "uk", "g-1", NOW)).rejects.toMatchObject({ status: 410 });
    expect((await resolveGeneration(fakeReader(gen({ state: "superseded", expiresAtUtc: "2026-11-20T00:00:00Z" })), "uk", "g-1", NOW)).state).toBe("superseded");
    await expect(resolveGeneration(fakeReader(gen({ site: "au" })), "uk", null, NOW)).rejects.toMatchObject({ status: 400 });
    // the effective per-site mode: legacy/shadow sites tell the app explicitly to keep its existing reads
    await expect(resolveGeneration(fakeReader(gen({ readMode: "legacy" })), "uk", null, NOW)).rejects.toMatchObject({ status: 503, code: "READ_MODE_LEGACY" });
    await expect(resolveGeneration(fakeReader(gen({ readMode: "shadow" })), "uk", null, NOW)).rejects.toMatchObject({ status: 503, code: "READ_MODE_SHADOW" });
  });
  it("a stale generation is returned labelled (not zeroed); the reader scope is one pinned generation", async () => {
    const r = fakeReader(gen({ verifiedAtUtc: "2026-11-16T08:00:00.000Z" }));
    const out = await readPublishedSummary(principal("owner"), SUM, deps(r));
    expect(out.meta).toMatchObject({ state: "outdated", generationId: "g-1" });
    expect(out.totals.normal.items).toBe(4);
    expect(r.scopes[0]).toMatchObject({ generationId: "g-1", startUtc: "2026-11-01T04:00:00.000Z", endUtcExclusive: "2026-11-17T04:00:00.000Z", audience: { kind: "site" } });
  });
  it("Welcome returns only its shape: no people list and no SKU board", async () => {
    const out = await readPublishedSummary(principal("cs"), { ...SUM, view: "welcome" }, deps());
    expect(out.peoplePage).toEqual({ rows: [], nextCursor: null, pageComplete: true, totalRows: 0 });
    expect(out.skuBoard).toEqual([]);
    expect(out.welcome).toBeTruthy();
  });
  it("invalid selectors are 400 before the generation is read; permission 403 before data", async () => {
    const r = fakeReader();
    await expect(readPublishedSummary(principal("owner"), { ...SUM, lastDate: "2026-10-01" }, deps(r))).rejects.toMatchObject({ status: 400 });
    await expect(readPublishedSummary(principal("owner"), { ...SUM, workType: "paper" as never }, deps(r))).rejects.toMatchObject({ status: 400 });
    await expect(readPublishedSummary(principal("kiosk"), SUM, deps(r))).rejects.toMatchObject({ status: 403 });
    expect(r.generations).toEqual([]);
  });
  it("an oversized summary fails explicitly (never clipped)", async () => {
    const r = fakeReader();
    r.summary = async () => ({ ...body(), skuBoard: [{ sku: "x".repeat(1024 * 1024), weight: 1, durationMin: 1, avgMin: 1 }] });
    await expect(readPublishedSummary(principal("owner"), SUM, deps(r))).rejects.toMatchObject({ status: 503, code: "TOO_LARGE" });
  });
});

describe("Task 16: detail pages and signed cursors", () => {
  it("pages to the end with signed cursors; only a null cursor ends; totals independent of page size", async () => {
    const r = fakeReader(gen(), 5);
    const p1 = await readPublishedDetail(principal("owner"), { ...DET, limit: 2 }, deps(r));
    expect(p1).toMatchObject({ totalRows: 5, pageComplete: true });
    expect(p1.rows).toHaveLength(2);
    const p2 = await readPublishedDetail(principal("owner"), { ...DET, limit: 2, cursor: p1.nextCursor! }, deps(r));
    const p3 = await readPublishedDetail(principal("owner"), { ...DET, limit: 2, cursor: p2.nextCursor! }, deps(r));
    expect([p2.rows.length, p3.rows.length, p3.nextCursor]).toEqual([2, 1, null]);
    expect(p3.totalRows).toBe(5);
  });
  it("an altered or rebound cursor is 400: other site, audience, filter, generation, kind, forged signature", async () => {
    const r = fakeReader(gen(), 5);
    const p1 = await readPublishedDetail(principal("owner"), { ...DET, limit: 2 }, deps(r));
    const c = p1.nextCursor!;
    const [b, s] = c.split(".");
    const decoded = JSON.parse(Buffer.from(b, "base64url").toString()) as Record<string, unknown>;
    const forged = Buffer.from(JSON.stringify({ ...decoded, last: 0 })).toString("base64url");
    for (const bad of [`${forged}.${s}`, `${b}.${s.slice(1)}x`, `${b}`, `${b}.${s}.x`, "garbage"]) await expect(readPublishedDetail(principal("owner"), { ...DET, cursor: bad }, deps(r))).rejects.toMatchObject({ status: 400, code: "BAD_CURSOR" });
    await expect(readPublishedDetail(principal("owner"), { ...DET, cursor: c, staffId: OTHER }, deps(r))).rejects.toMatchObject({ status: 400 });
    await expect(readPublishedDetail(principal("owner"), { ...DET, cursor: c, kind: "events" }, deps(r))).rejects.toMatchObject({ status: 400 });
    await expect(readPublishedDetail(principal("owner"), { ...DET, cursor: c, lastDate: "2026-11-15" }, deps(r))).rejects.toMatchObject({ status: 400 });
    await expect(readPublishedDetail(principal("staff", ["uk"], ["reports"]), { ...DET, cursor: c }, deps(r))).rejects.toMatchObject({ status: 400 }); // a site cursor cannot be replayed by a self audience
    const g2 = fakeReader(gen({ generationId: "g-2" }), 5);
    await expect(readPublishedDetail(principal("owner"), { ...DET, generationId: "g-2", cursor: c }, deps(g2))).rejects.toMatchObject({ status: 400 });
    expect(() => verifyCursor(SECRET, { v: 1, site: "uk", audience: "site", filter: filterKey(DET), generationId: "g-1", kind: "orders" }, signCursor("other", { v: 1, site: "uk", audience: "site", filter: filterKey(DET), generationId: "g-1", kind: "orders" }, 1))).toThrow(/cursor/);
  });
  it("every page re-authorizes: a revoked membership or permission between pages is 403 even with a valid cursor", async () => {
    const r = fakeReader(gen(), 5);
    const p1 = await readPublishedDetail(principal("owner"), { ...DET, limit: 2 }, deps(r));
    await expect(readPublishedDetail(principal("owner", ["au"]), { ...DET, cursor: p1.nextCursor! }, deps(r))).rejects.toMatchObject({ status: 403 });
    await expect(readPublishedDetail(principal("manager", ["uk"], ["welcome"]), { ...DET, cursor: p1.nextCursor! }, deps(r))).rejects.toMatchObject({ status: 403 });
  });
  it("an expired generation mid-paging is 410 (whole-view reload), paging needs its secret, and a page over 1 MiB fails", async () => {
    await expect(readPublishedDetail(principal("owner"), DET, deps(fakeReader(gen({ state: "expired" }))))).rejects.toMatchObject({ status: 410 });
    await expect(readPublishedDetail(principal("owner"), DET, { ...deps(), cursorSecret: undefined })).rejects.toMatchObject({ status: 500 });
    const r = fakeReader(gen(), 5);
    r.detail = async (_s, kind) => ({ rows: [{ kind, row: { x: "y".repeat(1024 * 1024) } } as never], last: 1, more: false, totalRows: 1 });
    await expect(readPublishedDetail(principal("owner"), DET, deps(r))).rejects.toMatchObject({ status: 503, code: "TOO_LARGE" });
    await expect(readPublishedDetail(principal("owner"), { ...DET, limit: 1001 }, deps())).rejects.toMatchObject({ status: 400 });
  });
  it("5xx bodies never leak internals; typed statuses pass through", () => {
    expect(errorResponse(new Error("password=hunter2 at db"))).toEqual({ status: 500, body: { error: "Report service error", code: "ERROR" } });
    expect(errorResponse(new ReportingHttpError(503, "UNAVAILABLE", "No published report"))).toMatchObject({ status: 503, body: { error: "No published report" } });
    expect(errorResponse(new ReportingHttpError(500, "CONFIG", "SUPABASE_SERVICE_ROLE_KEY missing at /var/task"))).toEqual({ status: 500, body: { error: "Report service error", code: "CONFIG" } });
  });
});

const ORDER_ROW = { key: "uk|O-1", orderNumber: "O-1", caseId: null, group: "normal", firstAtUtc: "2026-11-01T09:00:00.000000Z", lastAtUtc: "2026-11-01T10:00:00.000000Z", workTypes: ["framed", "dispatch"], verifiedLines: 2, items: 4, completed: true };
describe("Task 16: the RPC reader contract", () => {
  it("passes only the derived scope (audience kind/staff, generation, window) and validates shapes", async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const client = { rpc: async (fn: string, args: Record<string, unknown>) => (calls.push({ fn, args }), { data: fn === "read_reporting_detail" ? { rows: [ORDER_ROW], last: "uk|O-1", more: true, total_rows: 9 } : sqlSummary("2026-11-01", 2), error: null }) };
    const reader = rpcPublishedReader(client);
    const scope: ReaderScope = { site: "uk", audience: { kind: "self", staffId: U }, generationId: "g-1", firstDate: "2026-11-01", lastDate: "2026-11-02", startUtc: "s", endUtcExclusive: "e", staffId: null, workType: "framed" };
    await reader.summary(scope, "reports", { dailyLimit: 1000, peopleLimit: 200 });
    expect(calls[0]).toEqual({ fn: "read_reporting_summary", args: { p_site: "uk", p_audience_kind: "self", p_audience_staff: U, p_generation: "g-1", p_first_date: "2026-11-01", p_last_date: "2026-11-02", p_start: "s", p_end: "e", p_staff: null, p_work_type: "framed", p_view: "reports", p_daily_limit: 1000, p_people_limit: 200 } });
    expect(await reader.detail(scope, "orders", null, null, 1)).toEqual({ rows: [{ kind: "orders", row: ORDER_ROW }], last: "uk|O-1", more: true, totalRows: 9 });
    expect(calls[1]).toEqual({ fn: "read_reporting_detail", args: { ...calls[0].args, p_view: undefined, p_daily_limit: undefined, p_people_limit: undefined, p_kind: "orders", p_order: null, p_after: null, p_limit: 1 } });
    await expect(reader.detail(scope, "people", null, "x", 1)).rejects.toMatchObject({ status: 400 }); // an offset cursor must be a safe count
    const broken = rpcPublishedReader({ rpc: async () => ({ data: { totals: {} }, error: null }) });
    await expect(broken.summary(scope, "reports", { dailyLimit: 1, peopleLimit: 1 })).rejects.toMatchObject({ status: 503 });
    const failing = rpcPublishedReader({ rpc: async () => ({ data: null, error: { message: "permission denied for function read_reporting_summary" } }) });
    await expect(failing.generation("uk", null)).rejects.toMatchObject({ status: 503 });
  });
  it("parseGeneration: none → null; strict states and fields", () => {
    expect(parseGeneration([])).toBeNull();
    expect(parseGeneration([{ generation_id: "g", site: "uk", state: "published", complete: true, rule_version: "r", source_cutoff: "c", verified_at: "v", published_at: "p", expires_at: null, read_mode: "summary" }])).toMatchObject({ generationId: "g", expiresAtUtc: null, readMode: "summary" });
    expect(() => parseGeneration([{ generation_id: "g", site: "uk", state: "published", complete: true, rule_version: "r", source_cutoff: "c", verified_at: "v", published_at: "p", expires_at: null }])).toThrow(/read mode/);
    expect(() => parseGeneration([{ generation_id: "g", site: "uk", state: "weird", complete: true }])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function res() {
  const r = { status: 0, body: null as unknown, headers: {} as Record<string, string> };
  return { r, res: { setHeader: (n: string, v: string) => void (r.headers[n] = v), status: (c: number) => ({ json: (b: unknown) => void ((r.status = c), (r.body = b)) }) } };
}
describe("Task 16 handlers", () => {
  const q = { site: "uk", firstDate: "2026-11-01", lastDate: "2026-11-16", view: "reports" };
  it("summary: 401 without a session and nothing read; then 405 → 400 (unknown/repeated params) → 403 → 200; always no-store", async () => {
    const reader = fakeReader();
    const run = async (a: ReturnType<typeof auth>, req: { method: string; headers: Record<string, string>; query: Record<string, string | string[]> }) => {
      const h = createSummaryHandler({ auth: () => a, reader: () => reader, now: () => NOW });
      const { r, res: out } = res();
      await h(req, out);
      expect(r.headers["Cache-Control"]).toBe("no-store");
      return r;
    };
    const ok = { authorization: `Bearer ${JWT}` };
    const a0 = auth("owner");
    expect((await run(a0, { method: "POST", headers: {}, query: { ...q, site: "zz" } })).status).toBe(401);
    expect(a0.calls).toEqual([]);
    expect(reader.generations).toEqual([]);
    expect((await run(auth("owner"), { method: "POST", headers: ok, query: q })).status).toBe(405);
    expect((await run(auth("owner"), { method: "GET", headers: ok, query: { ...q, audience: "site" } })).status).toBe(400);
    expect((await run(auth("owner"), { method: "GET", headers: ok, query: { ...q, site: ["uk", "au"] } })).status).toBe(400);
    expect((await run(auth("kiosk"), { method: "GET", headers: ok, query: q })).status).toBe(403);
    expect((await run(auth("owner", ["au"]), { method: "GET", headers: ok, query: q })).status).toBe(403);
    const good = await run(auth("owner"), { method: "GET", headers: ok, query: q });
    expect(good.status).toBe(200);
    expect((good.body as { meta: { generationId: string } }).meta.generationId).toBe("g-1");
  });
  it("detail: the same precedence; a bad limit is 400; a forged cursor is 400", async () => {
    const reader = fakeReader(gen(), 5);
    const h = createDetailHandler({ auth: () => auth("owner"), reader: () => reader, now: () => NOW, cursorSecret: () => SECRET });
    const dq = { site: "uk", generationId: "g-1", kind: "orders", firstDate: "2026-11-01", lastDate: "2026-11-16" };
    const call = async (query: Record<string, string>, headers: Record<string, string> = { authorization: `Bearer ${JWT}` }) => {
      const { r, res: out } = res();
      await h({ method: "GET", headers, query }, out);
      return r;
    };
    expect((await call(dq, {})).status).toBe(401);
    expect((await call({ ...dq, limit: "0" })).status).toBe(400);
    expect((await call({ ...dq, limit: "2.5" })).status).toBe(400);
    expect((await call({ ...dq, cursor: "x.y" })).status).toBe(400);
    const p = await call({ ...dq, limit: "2" });
    expect(p.status).toBe(200);
    expect((p.body as { nextCursor: string }).nextCursor).toMatch(/\./);
  });
});

describe("Task 16 review: bearer auth is parsed before any configuration or client work", () => {
  const bad: Array<Record<string, string>> = [{}, { authorization: "Bearer" }, { authorization: "Basic abc" }, { authorization: `Bearer ${JWT}`, Authorization: `Bearer ${JWT}` }, { authorization: `Bearer ${JWT} extra` }];
  for (const headers of bad) {
    it(`401 with zero auth/env/reader calls even when misconfigured: ${JSON.stringify(Object.keys(headers))} ${JSON.stringify(Object.values(headers)[0] ?? "").slice(0, 20)}`, async () => {
      const calls: string[] = [];
      for (const h of [
        createSummaryHandler({ auth: () => (calls.push("auth"), null), reader: () => (calls.push("reader"), null), now: () => (calls.push("now"), NOW) }),
        createDetailHandler({ auth: () => (calls.push("auth"), null), reader: () => (calls.push("reader"), null), now: () => (calls.push("now"), NOW), cursorSecret: () => (calls.push("secret"), undefined) }),
      ]) {
        const { r, res: out } = res();
        await h({ method: "GET", headers, query: { site: "uk" } }, out);
        expect(r.status).toBe(401);
        expect(r.headers["Cache-Control"]).toBe("no-store");
      }
      expect(calls).toEqual([]);
    });
  }
  it("a well-formed token with missing configuration is the documented 500 (after the header check)", async () => {
    const h = createSummaryHandler({ auth: () => null, reader: () => null, now: () => NOW });
    const { r, res: out } = res();
    await h({ method: "GET", headers: { authorization: `Bearer ${JWT}` }, query: {} }, out);
    expect(r.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Review item 2: strict count safety of the 0044 response
// ---------------------------------------------------------------------------

function sqlSummary(first = "2026-11-16", days = 1): Record<string, unknown> {
  const g = (items: number | null = 3, orders = 1) => ({ normal: { items, orders }, rework: { items: 0, orders: 0 } });
  const date = (i: number) => new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
  const cov = { issueCounts: { invalid_event: 0, unclassified_sku: 0, invalid_quantity: 0, unresolved_parent: 0, missing_completion_detail: 0, ambiguous_repeat: 0 }, notes: { expected_exclusion: 0, corrected_verification: 0, reversed_terminal: 0, excluded_only_completion: 0 }, issueRows: 0, overflow: false };
  return {
    report: {
      totals: g(), byWorkType: ["a0_framed", "framed", "unframed", "dispatch"].map((workType) => ({ workType, totals: g() })), coverage: cov, tileCoverage: cov,
      activeStaff: 1, staffDays: 2, avgOrdersPerStaffDay: 0.5, timing: { durationMin: 10.5, timedWeight: 2, avgMinPerUnit: 5.25 },
      people: { rows: [{ staffId: U, ...g(), daysWorked: 2, itemsPerDay: 1.5, ordersPerDay: 0.5, timing: { durationMin: 1, timedWeight: 1, avgMinPerUnit: 1 } }], total: 1 },
      skuTiming: [], daily: { rows: Array.from({ length: days }, (_, i) => ({ productionDate: date(i), totals: g() })), total: days },
    },
    welcome: null,
  };
}
describe("Task 16 review: every summary count is exact, safe and validated deeply", () => {
  const parse = (v: unknown) => parseSummaryResponse(v, "reports", { firstDate: "2026-11-16", lastDate: "2026-11-16" }, { dailyLimit: 1000, peopleLimit: 200 });
  it("a valid response parses; Items may be the overflow null (never zero), Orders stay exact", () => {
    const v = sqlSummary();
    ((v.report as Record<string, unknown>).totals as { normal: { items: number | null } }).normal.items = null;
    const out = parse(v);
    expect(out.totals.normal).toEqual({ items: null, orders: 1 });
    expect(out.byWorkType.map((w) => w.workType)).toEqual(["a0_framed", "framed", "unframed", "dispatch"]);
  });
  const MUT: Array<[string, (r: Record<string, any>) => void]> = [
    ["negative orders", (r) => (r.totals.normal.orders = -1)],
    ["fractional orders", (r) => (r.totals.rework.orders = 1.5)],
    ["unsafe items in a work type", (r) => (r.byWorkType[1].totals.normal.items = 2 ** 53)],
    ["unsafe daily orders", (r) => (r.daily.rows[0].totals.normal.orders = 2 ** 53 + 2)],
    ["string count", (r) => (r.activeStaff = "1")],
    ["NaN rate", (r) => (r.avgOrdersPerStaffDay = Number.NaN)],
    ["infinite timing", (r) => (r.timing.durationMin = Number.POSITIVE_INFINITY)],
    ["negative person items", (r) => (r.people.rows[0].normal.items = -3)],
    ["unsafe person days", (r) => (r.people.rows[0].daysWorked = Number.MAX_SAFE_INTEGER + 1)],
    ["unsafe issue count", (r) => (r.coverage.issueCounts.invalid_event = 2 ** 60)],
    ["missing note kind", (r) => delete r.coverage.notes.reversed_terminal],
    ["extra key", (r) => (r.totals.extra = 1)],
    ["missing work type", (r) => r.byWorkType.pop()],
    ["work types out of order", (r) => r.byWorkType.reverse()],
    ["bad person id", (r) => (r.people.rows[0].staffId = "x")],
    ["bad date", (r) => (r.daily.rows[0].productionDate = "16/11/2026")],
    ["null orders", (r) => (r.totals.normal.orders = null)],
    ["unsafe daily total", (r) => (r.daily.total = 2 ** 53)],
    ["unsafe people total", (r) => (r.people.total = Number.MAX_SAFE_INTEGER + 2)],
    ["people total below its rows", (r) => (r.people.total = 0)],
    ["daily total not the range", (r) => (r.daily.total = 3)],
    ["a page without total", (r) => delete r.people.total],
    ["a whole array instead of a page", (r) => (r.people = r.people.rows)],
    ["a repeated person", (r) => r.people.rows.push(r.people.rows[0]) && (r.people.total = 2)],
  ];
  for (const [name, mut] of MUT) {
    it(`refuses: ${name}`, () => {
      const v = sqlSummary();
      mut(v.report as Record<string, any>);
      expect(() => parse(v)).toThrow(/read_reporting_summary/);
    });
  }
  it("a Reports response carrying a Welcome part, or a Welcome request without one, is refused", () => {
    expect(() => parse({ ...sqlSummary(), welcome: { cells: [] } })).toThrow(/no Welcome view/);
    expect(() => parseSummaryResponse(sqlSummary(), "welcome", { firstDate: "2026-11-16", lastDate: "2026-11-16" }, { dailyLimit: 1, peopleLimit: 1 })).toThrow(/welcome/);
  });
  it("summary pages are SQL-bounded first pages: at most the limit, exact totals, consecutive dates, short only when last", () => {
    const R = { firstDate: "2026-11-12", lastDate: "2026-11-16" };
    const ok = sqlSummary("2026-11-12", 2);
    ((ok.report as Record<string, any>).daily.total = 5);
    const out = parseSummaryResponse(ok, "reports", R, { dailyLimit: 2, peopleLimit: 200 });
    expect([out.dailyPage.rows.map((d) => d.productionDate), out.dailyPage.totalRows]).toEqual([["2026-11-12", "2026-11-13"], 5]);
    const page = (mut: (r: Record<string, any>) => void, limit = 2) => {
      const v = sqlSummary("2026-11-12", 2);
      (v.report as Record<string, any>).daily.total = 5;
      mut(v.report as Record<string, any>);
      return () => parseSummaryResponse(v, "reports", R, { dailyLimit: limit, peopleLimit: 200 });
    };
    expect(page(() => undefined, 1)).toThrow(/page limit is 1/); // more rows than the limit: never sliced
    expect(page((r) => r.daily.rows.pop())).toThrow(/short page but not the last/);
    expect(page((r) => (r.daily.rows[1].productionDate = "2026-11-14"))).toThrow(/no gap or repeat/);
    expect(page((r) => (r.daily.rows[1].productionDate = "2026-11-12"))).toThrow(/no gap or repeat/);
    expect(page((r) => (r.daily.rows[0].productionDate = "2026-11-11"))).toThrow(/no gap or repeat/);
  });
  it("the server signs a continuation cursor when a summary page does not hold every row; no secret → 500", async () => {
    const r = fakeReader();
    r.summary = async () => ({ ...body(), dailyPage: { rows: [{} as never], nextCursor: null, pageComplete: true, totalRows: 3 } });
    const out = await readPublishedSummary(principal("owner"), SUM, deps(r));
    expect(out.dailyPage.nextCursor).toMatch(/\./);
    expect(out.peoplePage.nextCursor).toBeNull();
    await expect(readPublishedSummary(principal("owner"), SUM, { ...deps(r), cursorSecret: undefined })).rejects.toMatchObject({ status: 500 });
  });
});

// ---------------------------------------------------------------------------
// Task 16 review: strict per-kind detail pages
// ---------------------------------------------------------------------------

describe("Task 16 review: every detail kind is validated deeply", () => {
  const g = () => ({ normal: { items: 1, orders: 1 }, rework: { items: null, orders: 0 } });
  const EV = { id: "e1", staffId: U, department: "framed", orderNumber: "O-1", sku: "INKA-KAN0566-A4-FB", quantity: "2", eventType: "line_verified", createdAtUtc: "2026-11-16T09:00:00.123456Z", parentEventId: null, caseId: null };
  const ROWS: Record<string, { row: Record<string, unknown>; last: unknown }> = {
    days: { row: { productionDate: "2026-11-16", totals: g() }, last: 1 },
    people: { row: { staffId: U, ...g(), daysWorked: 1, itemsPerDay: 1, ordersPerDay: 1, timing: { durationMin: 0, timedWeight: 0, avgMinPerUnit: 0 } }, last: 1 },
    orders: { row: ORDER_ROW, last: "uk|O-1" },
    events: { row: EV, last: [EV.createdAtUtc, "e1"] },
    "raw-export": { row: { ...EV, note: "", stationId: "s1" }, last: [EV.createdAtUtc, "e1"] },
    coverage: { row: { kind: "unclassified_sku", eventId: "e1", location: "uk", detail: null }, last: ["unclassified_sku", "e1"] },
    timing: { row: { eventId: "e1", staffId: U, workType: "framed", orderNumber: "O-1", sku: null, weight: 1, startedAtUtc: "2026-11-16T08:50:00.000000Z", completedAtUtc: "2026-11-16T09:00:00.000000Z", durationMin: 10 }, last: ["2026-11-16T09:00:00.000000Z", "e1"] },
  };
  const ctx = { site: "uk", firstDate: "2026-11-16", lastDate: "2026-11-16", limit: 1, offset: 0 };
  const resp = (kind: string, mut?: (row: Record<string, any>, page: Record<string, any>) => void) => {
    const page: Record<string, any> = { rows: [JSON.parse(JSON.stringify(ROWS[kind].row))], last: ROWS[kind].last, more: false, total_rows: 1 };
    mut?.(page.rows[0], page);
    return page;
  };
  for (const kind of Object.keys(ROWS)) {
    it(`${kind}: a valid page parses exactly`, () => {
      const out = parseDetailResponse(resp(kind), kind as never, ctx);
      expect(out).toEqual({ rows: [{ kind, row: ROWS[kind].row }], last: ROWS[kind].last, more: false, totalRows: 1 });
    });
    const common: Array<[string, (row: Record<string, any>, page: Record<string, any>) => void]> = [
      ["an extra row key", (row) => (row.extra = 1)],
      ["a missing row key", (row) => delete row[Object.keys(row)[0]]],
      ["unsafe total_rows", (_r, p) => (p.total_rows = 2 ** 53)],
      ["negative total_rows", (_r, p) => (p.total_rows = -1)],
      ["string total_rows", (_r, p) => (p.total_rows = "1")],
      ["more rows than the limit", (row, p) => p.rows.push(row)],
      ["a last that is not the last row's keyset", (_r, p) => (p.last = "zz")],
      ["more on a short page", (_r, p) => ((p.more = true), (p.total_rows = 5), (p.rows = []), (p.last = null))],
      ["an extra page key", (_r, p) => (p.cursor = "x")],
    ];
    for (const [name, mut] of common) it(`${kind}: refuses ${name}`, () => expect(() => parseDetailResponse(resp(kind, mut), kind as never, ctx)).toThrow(/read_reporting_detail/));
  }
  const SPECIFIC: Array<[string, string, (row: Record<string, any>, page: Record<string, any>) => void]> = [
    ["days", "a date outside the offset sequence", (row) => (row.productionDate = "2026-11-15")],
    ["days", "unsafe nested orders", (row) => (row.totals.normal.orders = 2 ** 53)],
    ["days", "total_rows that is not the range", (_r, p) => (p.total_rows = 2)],
    ["people", "unsafe days worked", (row) => (row.daysWorked = 2 ** 53)],
    ["people", "a negative rate", (row) => (row.itemsPerDay = -1)],
    ["people", "an infinite timing value", (row) => (row.timing.durationMin = Number.POSITIVE_INFINITY)],
    ["people", "a bad staff id", (row) => (row.staffId = "U")],
    ["orders", "unsafe verified lines", (row) => (row.verifiedLines = 2 ** 53)],
    ["orders", "fractional items", (row) => (row.items = 1.5)],
    ["orders", "a group that contradicts the case", (row) => (row.group = "rework")],
    ["orders", "a key that is not the overall order key", (row, p) => ((row.key = "uk|O-2"), (p.last = "uk|O-2"))],
    ["orders", "work types out of order", (row) => (row.workTypes = ["dispatch", "framed"])],
    ["orders", "an unknown work type", (row) => (row.workTypes = ["paint"])],
    ["orders", "a non-UTC instant", (row) => (row.firstAtUtc = "2026-11-01 09:00")],
    ["orders", "an order that ends before it starts", (row) => (row.lastAtUtc = "2026-11-01T08:00:00.000000Z")],
    ["orders", "a non-boolean completion", (row) => (row.completed = 1)],
    ["events", "a bad staff id", (row) => (row.staffId = "nope")],
    ["events", "a non-string event type", (row) => (row.eventType = 7)],
    ["events", "a numeric department", (row) => (row.department = 3)],
    ["events", "a missing quantity", (row) => delete row.quantity],
    ["raw-export", "a non-string note", (row) => (row.note = 5)],
    ["coverage", "an unknown issue kind", (row, p) => ((row.kind = "other"), (p.last = ["other", "e1"]))],
    ["coverage", "another site", (row) => (row.location = "us")],
    ["timing", "an unknown work type", (row) => (row.workType = "paint")],
    ["timing", "a negative weight", (row) => (row.weight = -1)],
    ["timing", "a NaN duration", (row) => (row.durationMin = Number.NaN)],
    ["timing", "completion before start", (row, p) => ((row.completedAtUtc = "2026-11-16T08:00:00.000000Z"), (p.last = ["2026-11-16T08:00:00.000000Z", "e1"]))],
  ];
  for (const [kind, name, mut] of SPECIFIC) it(`${kind}: refuses ${name}`, () => expect(() => parseDetailResponse(resp(kind, mut), kind as never, ctx)).toThrow(/read_reporting_detail/));
  it("Items may be the overflow null only where the contract allows it", () => {
    expect(parseDetailResponse(resp("orders", (row) => (row.items = null)), "orders", ctx).rows[0].row).toMatchObject({ items: null });
    expect(() => parseDetailResponse(resp("orders", (row) => (row.verifiedLines = null)), "orders", ctx)).toThrow(/verifiedLines/);
    expect(() => parseDetailResponse(resp("days", (row) => (row.totals.normal.orders = null)), "days", ctx)).toThrow(/orders/);
  });
  it("days/people continue an offset: rows follow the offset, last = offset + rows, more agrees with total_rows", () => {
    const c = { ...ctx, firstDate: "2026-11-14", limit: 1, offset: 2 };
    const p = { rows: [{ productionDate: "2026-11-16", totals: g() }], last: 3, more: false, total_rows: 3 };
    expect(parseDetailResponse(p, "days", c)).toMatchObject({ last: 3, more: false, totalRows: 3 });
    expect(() => parseDetailResponse({ ...p, more: true }, "days", c)).toThrow(/more disagrees/);
    expect(() => parseDetailResponse({ ...p, last: 1 }, "days", c)).toThrow(/keyset/);
    expect(() => parseDetailResponse({ ...p, rows: [{ productionDate: "2026-11-15", totals: g() }] }, "days", c)).toThrow(/no gap or repeat/);
  });
});

describe("Task 16 review: parser error context and the detail page bound", () => {
  it("each parse names its own RPC, whatever parsed or failed before it (no shared mutable parser state)", () => {
    const badSummary = sqlSummary();
    (badSummary.report as Record<string, any>).activeStaff = -1;
    const badDetail = { rows: [], last: null, more: false, total_rows: -1 };
    const R = { firstDate: "2026-11-16", lastDate: "2026-11-16" };
    const P = { dailyLimit: 10, peopleLimit: 10 };
    const C = { site: "uk", firstDate: "2026-11-16", lastDate: "2026-11-16", limit: 1, offset: 0 };
    for (let i = 0; i < 3; i++) {
      expect(() => parseDetailResponse(badDetail, "orders", C)).toThrow(/^read_reporting_detail: total_rows/);
      expect(() => parseSummaryResponse(badSummary, "reports", R, P)).toThrow(/^read_reporting_summary: activeStaff/);
      expect(parseDetailResponse({ rows: [], last: null, more: false, total_rows: 0 }, "orders", C).totalRows).toBe(0);
      expect(() => parseSummaryResponse(badSummary, "reports", R, P)).toThrow(/^read_reporting_summary: /);
      expect(() => parseDetailResponse(badDetail, "coverage", C)).toThrow(/^read_reporting_detail: /);
    }
    // a detail failure inside a summary-shaped value still names the detail RPC, and vice versa
    expect(() => parseDetailResponse(sqlSummary(), "days", C)).toThrow(/^read_reporting_detail: response has unexpected keys/);
    expect(() => parseSummaryResponse(badDetail, "reports", R, P)).toThrow(/^read_reporting_summary: response has unexpected keys/);
  });
  it("the module keeps no mutable top-level state", () => {
    const src = readFileSync(new URL("../../api/_lib/production-reporting-dto.ts", import.meta.url), "utf8");
    expect(src.match(/^(let|var)\s/gm)).toBeNull();
  });
  it("an invalid detail limit is refused before any RPC (zero calls)", async () => {
    let calls = 0;
    const reader = rpcPublishedReader({ rpc: async () => (calls++, { data: null, error: null }) });
    const scope: ReaderScope = { site: "uk", audience: { kind: "site" }, generationId: "g-1", firstDate: "2026-11-16", lastDate: "2026-11-16", startUtc: "s", endUtcExclusive: "e", staffId: null, workType: null };
    for (const limit of [0, -1, 1.5, 1001, Number.NaN, Number.POSITIVE_INFINITY, "5" as unknown as number, 2 ** 53]) {
      await expect(reader.detail(scope, "orders", null, null, limit)).rejects.toMatchObject({ status: 400, code: "BAD_REQUEST" });
    }
    await expect(reader.detail(scope, "people", null, -2, 10)).rejects.toMatchObject({ status: 400 }); // the offset cursor guard stays
    expect(calls).toBe(0);
  });
});
