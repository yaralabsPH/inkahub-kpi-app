/** F8 Reports v2 UI seams: role layout, stale-response isolation, periods and the rendered summary. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { reportsAccessFor, ReportsForAccess, reportsLayoutFor } from "../../src/pages/Reports";
import { buildOverviewRequest, OverviewBodyView } from "../../src/components/ReportsOverview";
import { createOverviewLoader, type OverviewState } from "../../src/lib/hooks/useReportsOverview";
import { effectiveNavAccess } from "../../src/lib/auth/permissions";
import { productionDateAt } from "../../src/lib/domain/productionPeriods";
import type { OverviewResult } from "../../src/lib/domain/reportsOverview";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const zero = { items: 0, orders: 0 };
const result = (site: "au" | "uk", orders: number): OverviewResult => ({
  totals: { normal: { items: orders * 2, orders }, rework: zero },
  daily: [{ productionDate: "2026-11-16", normal: { items: orders * 2, orders }, rework: zero }],
  people: [{ staffId: U1, normal: { items: orders * 2, orders }, rework: zero }],
  departments: [{ departmentId: null, names: [], normal: { items: null, orders }, rework: zero }],
  request: { site, firstDate: "2026-11-16", lastDate: "2026-11-16" },
  meta: { site, generationId: "abcdef12-0000-4000-8000-000000000000", ruleVersion: "r", sourceCutoffUtc: "2026-11-16T10:00:00Z", verifiedAtUtc: "x", publishedAtUtc: "x", freshUntilUtc: "x", expiresAtUtc: "", visibility: { kind: "site" }, state: "outdated" },
});

describe("role layout: restricted roles never mount the legacy full-team view", () => {
  it("owner/manager full, staff/CS overview only, kiosk denied, unknown profile pending", () => {
    expect(["owner", "manager", "staff", "cs", "kiosk", null].map(reportsLayoutFor)).toEqual(["full", "full", "overview_only", "overview_only", "denied", "pending"]);
  });
  it("legacy mounts only for a loaded, matching owner/manager session (review r1 #1: session switch with a retained profile)", () => {
    const owner = { user_id: U1, role: "owner" };
    const at = (a: Parameters<typeof reportsAccessFor>[0]) =>
      renderToStaticMarkup(<ReportsForAccess access={reportsAccessFor(a)} overview={(x) => <i>OVERVIEW:{x.scopeKey}</i>} legacy={() => <b>LEGACY</b>} />);
    const s1 = { id: U1 };
    // 1. owner signed in: summary + legacy
    expect(at({ loading: false, session: { user: s1 }, user: s1, profile: owner })).toContain("LEGACY");
    // 2. session switches to a staff user; AuthProvider still holds the OWNER profile: nothing role-dependent
    const s2 = { id: U2 };
    const mid = at({ loading: false, session: { user: s2 }, user: s2, profile: owner });
    expect(mid).not.toContain("LEGACY");
    expect(mid).not.toContain("OVERVIEW");
    expect(mid).toContain("Loading your access");
    // 3. still loading, or session/user disagree, or no session/profile: closed
    for (const a of [
      { loading: true, session: { user: s1 }, user: s1, profile: owner },
      { loading: false, session: { user: s2 }, user: s1, profile: owner },
      { loading: false, session: null, user: s1, profile: owner },
      { loading: false, session: { user: s1 }, user: s1, profile: null },
    ]) {
      const html = at(a);
      expect(html).not.toContain("LEGACY");
      expect(html).not.toContain("OVERVIEW");
    }
    // 4. the staff profile arrives: summary only, self scope
    const done = at({ loading: false, session: { user: s2 }, user: s2, profile: { user_id: U2, role: "staff" } });
    expect(done).not.toContain("LEGACY");
    expect(done).toContain(`OVERVIEW:${U2}|staff|self`);
    // kiosk refused; CS summary in site scope
    expect(at({ loading: false, session: { user: s2 }, user: s2, profile: { user_id: U2, role: "kiosk" } })).toContain("not available on kiosk");
    expect(at({ loading: false, session: { user: s2 }, user: s2, profile: { user_id: U2, role: "cs" } })).toContain(`OVERVIEW:${U2}|cs|site`);
  });
  it("the page passes the trusted scope as the summary's key and identity", () => {
    const src = readFileSync("src/pages/Reports.tsx", "utf8");
    const role = src.slice(src.indexOf("function RoleReports()"), src.indexOf("function SupabaseReports()"));
    expect(role).toContain("key={a.scopeKey}");
    expect(role).toContain("scopeKey={a.scopeKey}");
    expect(role).toContain("const access = reportsAccessFor(auth)");
    expect(src.split("<SupabaseReports />").length - 1).toBe(1);
  });
  it("staff get Reports by default; explicit overrides stay authoritative; CS still needs it explicitly", () => {
    expect(effectiveNavAccess({ role: "staff", allowed_nav: null } as never).has("reports")).toBe(true);
    expect(effectiveNavAccess({ role: "staff", allowed_nav: ["welcome"] } as never).has("reports")).toBe(false);
    expect(effectiveNavAccess({ role: "cs", allowed_nav: null } as never).has("reports")).toBe(false);
  });
});

describe("stale-response isolation", () => {
  function harness() {
    const pending: Array<{ url: string; resolve: (v: { ok: boolean; status: number; body: unknown }) => void; signal: AbortSignal }> = [];
    const seen: OverviewState[] = [];
    const loader = createOverviewLoader({
      token: async () => "t.t.t",
      fetch: (url, init) => new Promise((resolve) => pending.push({ url, signal: init.signal, resolve: (v) => resolve({ ok: v.ok, status: v.status, json: async () => v.body }) })),
      onChange: (s) => seen.push(s),
    });
    return { loader, pending, seen };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const AU = { site: "au" as const, firstDate: "2026-11-16", lastDate: "2026-11-16" };
  const UK = { ...AU, site: "uk" as const };

  it("a new identity clears the shown data at once and a late answer for the old one is ignored", async () => {
    const h = harness();
    void h.loader.load(U1, AU);
    await tick();
    h.pending[0].resolve({ ok: true, status: 200, body: result("au", 5) });
    await tick();
    expect(h.loader.state().status).toBe("ready");
    void h.loader.load(U1, UK); // site switch
    expect(h.loader.state()).toMatchObject({ status: "loading", data: null });
    await tick();
    void h.loader.load(U2, UK); // user switch while UK is in flight
    await tick();
    expect(h.pending[1].signal.aborted).toBe(true);
    h.pending[1].resolve({ ok: true, status: 200, body: result("uk", 99) }); // late answer for U1/UK
    await tick();
    expect(h.loader.state()).toMatchObject({ status: "loading", data: null });
    h.pending[2].resolve({ ok: true, status: 200, body: result("uk", 2) });
    await tick();
    expect(h.loader.state().data?.totals.normal.orders).toBe(2);
    expect(h.seen.some((s) => s.data?.totals.normal.orders === 99)).toBe(false);
  });
  it("review r1 #2: same user CS (Everyone, site scope) -> staff clears site data at once and drops a late CS reply", async () => {
    const h = harness();
    const CS = `${U1}|cs|site`;
    const STAFF = `${U1}|staff|self`;
    void h.loader.load(CS, AU); // CS "Everyone": no staffId
    await tick();
    h.pending[0].resolve({ ok: true, status: 200, body: result("au", 7) });
    await tick();
    expect(h.loader.state().data?.totals.normal.orders).toBe(7);
    void h.loader.load(CS, AU); // a CS refresh is in flight...
    await tick();
    void h.loader.load(STAFF, AU); // ...when the role drops to staff (same user, same query string)
    expect(h.loader.state()).toMatchObject({ status: "loading", data: null });
    await tick();
    h.pending[1].resolve({ ok: true, status: 200, body: result("au", 8) }); // the old CS answer lands late
    await tick();
    expect(h.loader.state()).toMatchObject({ status: "loading", data: null });
    h.pending[2].resolve({ ok: true, status: 200, body: result("au", 1) });
    await tick();
    expect(h.loader.state().data?.totals.normal.orders).toBe(1);
    const fromStaff = h.seen.slice(h.seen.findIndex((x) => x.key.startsWith(STAFF)));
    expect(fromStaff.some((x) => x.data !== null && x.data.totals.normal.orders !== 1)).toBe(false);
  });
  it("an unpublished site is not-ready (no fallback); other failures are errors with retry", async () => {
    const h = harness();
    void h.loader.load(U1, AU);
    await tick();
    h.pending[0].resolve({ ok: false, status: 503, body: { error: "Published reports are not enabled for this site", code: "READ_MODE_LEGACY" } });
    await tick();
    expect(h.loader.state()).toMatchObject({ status: "not_ready", data: null, code: "READ_MODE_LEGACY" });
    void h.loader.load(U1, AU); // Retry
    await tick();
    h.pending[1].resolve({ ok: false, status: 403, body: { error: "Staff can only open their own report", code: "FORBIDDEN" } });
    await tick();
    expect(h.loader.state()).toMatchObject({ status: "error", code: "FORBIDDEN" });
    expect(h.pending.map((p) => p.url.split("?")[0])).toEqual(["/api/reports/overview", "/api/reports/overview"]);
  });
});

describe("periods and request building", () => {
  const base = { site: "au", today: "2026-11-19", custom: { from: "2026-11-01", to: "2026-11-05" }, staffId: null, workType: null, departmentId: null };
  it("day, Monday week, month to date and custom", () => {
    const range = (period: "day" | "week" | "month" | "custom") => {
      const r = buildOverviewRequest({ ...base, period }).request!;
      return [r.firstDate, r.lastDate];
    };
    expect(range("day")).toEqual(["2026-11-19", "2026-11-19"]);
    expect(range("week")).toEqual(["2026-11-16", "2026-11-19"]); // Thursday -> Monday
    expect(range("month")).toEqual(["2026-11-01", "2026-11-19"]);
    expect(range("custom")).toEqual(["2026-11-01", "2026-11-05"]);
    expect(buildOverviewRequest({ ...base, period: "custom", custom: { from: "2026-11-09", to: "2026-11-02" } }).problem).toMatch(/after/);
    expect(buildOverviewRequest({ ...base, site: "staging", period: "day" }).request).toBeNull();
  });
  it("production dates start at 04:00 site time across DST", () => {
    // UK BST starts 2026-03-29 01:00 UTC: 03:30 UTC = 04:30 BST is already the 29th; 02:30 UTC = 03:30 BST is still the 28th
    expect(productionDateAt(new Date("2026-03-29T03:30:00Z"), "uk")).toBe("2026-03-29");
    expect(productionDateAt(new Date("2026-03-29T02:30:00Z"), "uk")).toBe("2026-03-28");
    // AU: 2026-10-04 is DST start in Sydney (UTC+11 after 02:00 local)
    expect(productionDateAt(new Date("2026-10-04T17:30:00Z"), "au")).toBe("2026-10-05"); // 04:30 AEDT on the 5th
    expect(productionDateAt(new Date("2026-10-04T16:30:00Z"), "au")).toBe("2026-10-04"); // 03:30 AEDT
  });
});

describe("rendered states", () => {
  const nameOf = (id: string) => (id === U1 ? "Ana" : id);
  it("ready: cutoff, version, stale warning, distinct-orders note, Unknown department and overflow", () => {
    const html = renderToStaticMarkup(<OverviewBodyView state={{ key: "k", status: "ready", data: result("au", 3), error: null, code: null }} nameOf={nameOf} onRetry={() => {}} />);
    expect(html).toContain("report version abcdef12");
    expect(html).toContain("outdated — newer work is not included");
    expect(html).toContain("distinct orders for the whole period");
    expect(html).toContain("Unknown");
    expect(html).toContain("too many");
    expect(html).toContain("Ana");
  });
  it("loading, not ready, error with Retry", () => {
    const r = (s: OverviewState) => renderToStaticMarkup(<OverviewBodyView state={s} nameOf={nameOf} onRetry={() => {}} />);
    expect(r({ key: "k", status: "loading", data: null, error: null, code: null })).toContain("Loading the production summary");
    expect(r({ key: "k", status: "not_ready", data: null, error: "Published reports are not enabled for this site", code: "READ_MODE_LEGACY" })).toContain("not ready for this site yet");
    const err = r({ key: "k", status: "error", data: null, error: "boom", code: "NETWORK" });
    expect(err).toContain("role=\"alert\"");
    expect(err).toContain("Retry");
  });
});
