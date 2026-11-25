/**
 * Release review r2 R2-1: a DORMANT site (capture off, processor off, read mode
 * legacy, never published) must answer READ_MODE_LEGACY so Reports and Welcome
 * select their existing reads. Offline, end to end:
 * real 0037–0046 schema with no generation → real RPCs → rpcPublishedReader →
 * readPublishedSummary → errorResponse (the HTTP body) → the browser
 * PublishedViewController → rawRangeFor. Summary mode without a publication,
 * missing membership and a foreign pinned generation still fail closed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { errorResponse, readPublishedSummary, ReportingHttpError, type ReportingPrincipal } from "../../../api/_lib/production-reporting";
import { rpcPublishedReader } from "../../../api/_lib/production-reporting-rpc";
import { PublishedViewController, type PublishedIdentity } from "../../../src/lib/hooks/usePublishedProduction";
import { rawRangeFor } from "../../../src/lib/domain/productionPublishedView";
import type { FetchLike } from "../../../src/lib/repository/supabase/productionPublished";
import { reportingDb } from "./harness";
import { pgRpc } from "./rpc";

const OWNER = "11111111-1111-4111-8111-111111111111";
const SITES = ["au", "uk", "us"] as const;
const owner: ReportingPrincipal = { userId: OWNER, role: "owner", nav: new Set(["reports", "welcome"]), sites: new Set(SITES) };
const outsider: ReportingPrincipal = { userId: OWNER, role: "manager", nav: new Set(["reports", "welcome"]), sites: new Set(["uk"]) };
let db: PGlite;

beforeAll(async () => {
  db = await reportingDb();
}, 120_000);
afterAll(async () => db?.close());

const reader = () => rpcPublishedReader(pgRpc(db));
const summaryOf = (p: ReportingPrincipal, site: (typeof SITES)[number], view: "reports" | "welcome", generationId?: string) =>
  readPublishedSummary(p, { site, firstDate: "2026-11-02", lastDate: "2026-11-08", view, generationId }, { reader: reader(), now: () => Date.parse("2026-11-08T12:00:00Z"), cursorSecret: "s" });

/** The HTTP answer the summary endpoint would send for this request. */
async function httpAnswer(p: ReportingPrincipal, site: (typeof SITES)[number], view: "reports" | "welcome", generationId?: string) {
  try {
    await summaryOf(p, site, view, generationId);
    return { status: 200, body: {} as unknown };
  } catch (e) {
    const r = errorResponse(e);
    return { status: r.status, body: r.body as unknown };
  }
}

/** Feed that answer to the real browser controller and return what the page would do. */
async function browserState(answer: { status: number; body: unknown }, site: (typeof SITES)[number], view: "reports" | "welcome") {
  const fetchImpl: FetchLike = async () => ({ status: answer.status, ok: answer.status < 400, json: async () => answer.body });
  const ctrl = new PublishedViewController({ fetch: fetchImpl, token: async () => "tok" });
  const id: PublishedIdentity = { userId: OWNER, site, view, firstDate: "2026-11-02", lastDate: "2026-11-08" };
  await ctrl.load(id);
  const st = ctrl.get();
  return { status: st.status, rawRange: rawRangeFor(st.status, { first: id.firstDate, last: id.lastDate }) };
}

describe("R2-1: dormant sites keep their existing reads before the first publication", () => {
  it("the fresh schema really is dormant: no generation, legacy, processor and capture off", async () => {
    const c = pgRpc(db);
    for (const site of SITES) {
      const { data } = await c.rpc("get_reporting_job_status", { p_site: site });
      const r = (Array.isArray(data) ? data[0] : data) as Record<string, unknown>;
      expect(r).toMatchObject({ site, read_mode: "legacy", processor_enabled: false, capture_enabled: false, active_generation_id: null });
      expect(await reader().generation(site, null)).toBeNull();
    }
  }, 60_000);

  for (const site of SITES) {
    for (const view of ["reports", "welcome"] as const) {
      it(`${site} ${view}: READ_MODE_LEGACY → controller legacy → the existing raw reads run`, async () => {
        const answer = await httpAnswer(owner, site, view);
        expect(answer).toEqual({ status: 503, body: { error: "Published reports are not enabled for this site", code: "READ_MODE_LEGACY" } });
        const page = await browserState(answer, site, view);
        expect(page.status).toBe("legacy");
        expect(page.rawRange).toEqual({ first: "2026-11-02", last: "2026-11-08" });
      }, 60_000);
    }
  }

  it("the operator RPC refuses shadow/summary for a site with no publication", async () => {
    const c = pgRpc(db);
    for (const mode of ["shadow", "summary"]) {
      const r = await c.rpc("set_reporting_site_mode", { p_site: "us", p_read_mode: mode, p_processor_enabled: null });
      expect(r.error).toBeTruthy();
    }
  }, 60_000);

  it("the schema itself forbids shadow/summary without an active generation (so 'summary, nothing published' cannot be reached)", async () => {
    for (const mode of ["shadow", "summary"]) {
      await expect(db.query(`update reporting_private.site_state set read_mode = '${mode}' where site = 'us'`)).rejects.toMatchObject({ code: "23514" });
    }
  }, 60_000);

  it("no membership for the site is refused before any reporting read", async () => {
    const answer = await httpAnswer(outsider, "au", "reports");
    expect(answer.status).toBe(403);
    expect((await browserState(answer, "au", "reports")).rawRange).toBeNull();
  }, 60_000);

  it("a pinned generation that does not exist is 410, not a legacy fallback", async () => {
    const answer = await httpAnswer(owner, "au", "reports", "00000000-0000-4000-8000-000000000000");
    expect(answer).toMatchObject({ status: 410, body: { code: "GENERATION_EXPIRED" } });
  }, 60_000);

  it("missing site state fails closed (503), never legacy", async () => {
    await db.query("delete from reporting_private.site_state where site = 'au'");
    try {
      await expect(summaryOf(owner, "au", "reports")).rejects.toSatisfy((e: unknown) => e instanceof ReportingHttpError && e.status === 503 && e.code !== "READ_MODE_LEGACY");
    } finally {
      await db.query("insert into reporting_private.site_state (site) values ('au')");
    }
  }, 60_000);
});
