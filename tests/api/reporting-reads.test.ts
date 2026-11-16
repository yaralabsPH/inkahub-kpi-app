/**
 * Task 16 (server layer): authorized published report reads, without a
 * database. Auth/membership/nav come from fakes of Supabase getUser and the
 * caller-JWT reads; the published reader is a fake that records exactly what
 * scope (audience!) it was asked for. SQL parity of the 0044 reader is a
 * separate staging gate (tests/staging/reporting-read-parity.ts).
 */
import { describe, expect, it } from "vitest";
import {
  audienceFor, authorizeReportingRequest, bearerToken, effectiveNav, errorResponse, filterKey, freshness, NAV, readPublishedDetail, readPublishedSummary, ReportingHttpError, resolveGeneration, signCursor, verifyCursor,
  type AuthDeps, type GenerationMeta, type PublishedReader, type ReaderScope, type ReportingPrincipal, type SummaryBody,
} from "../../api/_lib/production-reporting";
import { parseGeneration, rpcPublishedReader } from "../../api/_lib/production-reporting-rpc";
import { createDetailHandler } from "../../api/reports/detail";
import { createSummaryHandler } from "../../api/reports/summary";
import { effectiveNavAccess } from "../../src/lib/auth/permissions";
import { NAV_KEYS } from "../../src/lib/domain";

const U = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln";
const NOW = Date.parse("2026-11-16T12:00:00Z");
const SECRET = "cursor-secret-for-tests";

const gen = (o: Partial<GenerationMeta> = {}): GenerationMeta => ({ generationId: "g-1", site: "uk", state: "published", complete: true, ruleVersion: "item-counting-summary-v1", sourceCutoffUtc: "2026-11-16T11:50:00.000000Z", verifiedAtUtc: "2026-11-16T11:50:00.000Z", publishedAtUtc: "2026-11-16T11:51:00.000Z", expiresAtUtc: null, ...o });
const body = (): SummaryBody => ({
  totals: { normal: { items: 4, orders: 1 }, rework: { items: 0, orders: 0 } }, byWorkType: [], dailyPage: { rows: [], nextCursor: null, pageComplete: true, totalRows: 0 },
  coverage: { issueCounts: {} as never, notes: {} as never, visibility: { kind: "site" }, incomplete: false, issueRows: 0 }, timing: {} as never,
  peoplePage: { rows: [{} as never], nextCursor: null, pageComplete: true, totalRows: 1 }, activeStaff: 1, staffDays: 1, avgOrdersPerStaffDay: 1, skuBoard: [{ sku: "X", weight: 1, durationMin: 1, avgMin: 1 }],
  welcome: { today: "2026-11-16" } as never,
});
function fakeReader(g: GenerationMeta | null = gen(), detailRows = 3): PublishedReader & { scopes: ReaderScope[]; generations: Array<string | null> } {
  const scopes: ReaderScope[] = [];
  const generations: Array<string | null> = [];
  return {
    scopes, generations,
    async generation(_s, id) { generations.push(id); return g; },
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
    ["staff", null, "reports", 403], ["staff", null, "welcome", "self"], ["staff", ["reports"], "reports", "self"], ["kiosk", ["reports"], "reports", "site"], ["manager", ["welcome"], "reports", 403],
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
    await expect(resolveGeneration(fakeReader(null), "uk", null, NOW)).rejects.toMatchObject({ status: 503 });
    await expect(resolveGeneration(fakeReader(null), "uk", "g-9", NOW)).rejects.toMatchObject({ status: 410, code: "GENERATION_EXPIRED" });
    for (const g of [gen({ complete: false }), gen({ state: "building" }), gen({ state: "failed" })]) await expect(resolveGeneration(fakeReader(g), "uk", null, NOW)).rejects.toMatchObject({ status: 503 });
    await expect(resolveGeneration(fakeReader(gen({ state: "expired" })), "uk", "g-1", NOW)).rejects.toMatchObject({ status: 410 });
    await expect(resolveGeneration(fakeReader(gen({ state: "superseded", expiresAtUtc: "2026-11-16T11:59:59Z" })), "uk", "g-1", NOW)).rejects.toMatchObject({ status: 410 });
    expect((await resolveGeneration(fakeReader(gen({ state: "superseded", expiresAtUtc: "2026-11-20T00:00:00Z" })), "uk", "g-1", NOW)).state).toBe("superseded");
    await expect(resolveGeneration(fakeReader(gen({ site: "au" })), "uk", null, NOW)).rejects.toMatchObject({ status: 400 });
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

describe("Task 16: the RPC reader contract", () => {
  it("passes only the derived scope (audience kind/staff, generation, window) and validates shapes", async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const client = { rpc: async (fn: string, args: Record<string, unknown>) => (calls.push({ fn, args }), { data: fn === "read_reporting_detail" ? { rows: [{ a: 1 }], last: ["k"], more: true, total_rows: 9 } : { ...body() }, error: null }) };
    const reader = rpcPublishedReader(client);
    const scope: ReaderScope = { site: "uk", audience: { kind: "self", staffId: U }, generationId: "g-1", firstDate: "2026-11-01", lastDate: "2026-11-02", startUtc: "s", endUtcExclusive: "e", staffId: null, workType: "framed" };
    await reader.summary(scope, "reports", { dailyLimit: 1000, peopleLimit: 200 });
    expect(calls[0]).toEqual({ fn: "read_reporting_summary", args: { p_site: "uk", p_audience_kind: "self", p_audience_staff: U, p_generation: "g-1", p_first_date: "2026-11-01", p_last_date: "2026-11-02", p_start: "s", p_end: "e", p_staff: null, p_work_type: "framed", p_view: "reports", p_daily_limit: 1000, p_people_limit: 200 } });
    expect(await reader.detail(scope, "orders", null, null, 5)).toMatchObject({ rows: [{ kind: "orders", row: { a: 1 } }], last: ["k"], more: true, totalRows: 9 });
    const broken = rpcPublishedReader({ rpc: async () => ({ data: { totals: {} }, error: null }) });
    await expect(broken.summary(scope, "reports", { dailyLimit: 1, peopleLimit: 1 })).rejects.toMatchObject({ status: 503 });
    const failing = rpcPublishedReader({ rpc: async () => ({ data: null, error: { message: "permission denied for function read_reporting_summary" } }) });
    await expect(failing.generation("uk", null)).rejects.toMatchObject({ status: 503 });
  });
  it("parseGeneration: none → null; strict states and fields", () => {
    expect(parseGeneration([])).toBeNull();
    expect(parseGeneration([{ generation_id: "g", site: "uk", state: "published", complete: true, rule_version: "r", source_cutoff: "c", verified_at: "v", published_at: "p", expires_at: null }])).toMatchObject({ generationId: "g", expiresAtUtc: null });
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
