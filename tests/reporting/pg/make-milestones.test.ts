/**
 * F11 Make milestones SQL (0060), offline on PGlite: atomic envelope acceptance
 * (identical retry / conflicting occurrence / rollback), Part 1 membership
 * aliases resolved by explicit Part 2 mappings (event-before-membership),
 * changed successful subsets, cross-site and ambiguous refusal, durable
 * unresolved status, and grants.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { reportingDb } from "./harness";
import { pgRpc } from "./rpc";
import { readOrderTimeline } from "../../../api/_lib/order-timeline";
import type { ReportingPrincipal } from "../../../api/_lib/production-reporting";

const SHOP = "inka-staging-synthetic.myshopify.com";
const OWNER = "11111111-1111-4111-8111-111111111111";
let db: PGlite;
const rpc = () => pgRpc(db);
type Env = { stage: string; occurrenceId: string; happenedAt: string; batchId: string; membershipVersion: number; members: Array<Record<string, string>> };
const env = (over: Partial<Env>): Env => ({ stage: "submitted", occurrenceId: "p1:B1:v1", happenedAt: "2026-11-20T09:00:00Z", batchId: "B1", membershipVersion: 1, members: [], ...over });
async function send(e: Env, site = "au", shop = SHOP) {
  const r = await rpc().rpc("ingest_make_milestone", { p_site: site, p_shop: shop, p_scope: "au-staging", p_envelope: e });
  if (r.error) throw new Error(r.error.message);
  return r.data as { result: string; reason: string | null; members: Record<string, number> };
}
/** Attached (non-retraction) make facts as "<occurrence id>|<order alias>" (keys are hashed: "mk:<sha256>|<occurrence id>"). */
const evidenceKeys = async (where = "true", on: PGlite = db) =>
  (await on.query<{ k: string }>(`select substr(occurrence_key, position('|' in occurrence_key) + 1) || '|' || order_number as k from public.order_timeline_evidence
     where source = 'make' and retracts_key is null and ${where} order by 1`)).rows.map((r) => r.k);
const owner: ReportingPrincipal = { userId: OWNER, role: "owner", nav: new Set(["reports"]), sites: new Set(["au", "uk"]) };

beforeAll(async () => {
  db = await reportingDb();
});

describe("0060 envelope acceptance", () => {
  it("identical retry is a duplicate; altered content under the same occurrence conflicts and writes nothing", async () => {
    const p1 = env({ occurrenceId: "p1:R1:v1", batchId: "R1", members: [{ memberKey: "m1", orderNumber: "7001" }] });
    expect(await send(p1)).toMatchObject({ result: "accepted" });
    expect(await send(p1)).toMatchObject({ result: "duplicate" });
    const altered = await send({ ...p1, members: [{ memberKey: "m1", orderNumber: "7002" }] });
    expect(altered).toMatchObject({ result: "conflict" });
    expect((await db.query("select order_number from public.make_milestone_members where batch_id = 'R1'")).rows).toEqual([{ order_number: "7001" }]);
    // a second Part 1 occurrence may not redefine an existing membership version
    expect(await send({ ...p1, occurrenceId: "p1:R1:v1:again" })).toMatchObject({ result: "conflict", reason: expect.stringMatching(/membership/) });
  });
  it("one invalid record rolls back the whole envelope (nothing durable, nothing acknowledged)", async () => {
    const r = await rpc().rpc("ingest_make_milestone", { p_site: "au", p_shop: SHOP, p_scope: "au-staging",
      p_envelope: env({ occurrenceId: "p1:R2:v1", batchId: "R2", members: [{ memberKey: "ok", orderNumber: "7101" }, { memberKey: "bad", orderNumber: "x".repeat(65) }] }) });
    expect(r.error).not.toBeNull();
    expect((await db.query("select count(*)::int n from public.make_milestone_occurrences where batch_id = 'R2'")).rows[0]).toEqual({ n: 0 });
    expect((await db.query("select count(*)::int n from public.make_milestone_members where batch_id = 'R2'")).rows[0]).toEqual({ n: 0 });
  });
  it("refuses unknown stages, local times, duplicate member keys and oversized member lists", async () => {
    for (const bad of [env({ occurrenceId: "x1", stage: "printed" }), env({ occurrenceId: "x2", happenedAt: "2026-11-20T09:00:00" }),
      env({ occurrenceId: "x3", members: [{ memberKey: "a", orderNumber: "1" }, { memberKey: "a", orderNumber: "2" }] }),
      env({ occurrenceId: "x4", members: Array.from({ length: 501 }, (_, i) => ({ memberKey: `k${i}`, orderNumber: `${i}` })) })]) {
      expect((await rpc().rpc("ingest_make_milestone", { p_site: "au", p_shop: SHOP, p_scope: "au-staging", p_envelope: bad })).error).not.toBeNull();
    }
  });
});

describe("0060 membership resolution", () => {
  it("events before membership wait durably, then attach atomically when Part 1 and the Part 2 mapping exist", async () => {
    // Part 3 and Part 2 arrive before Part 1
    expect(await send(env({ stage: "planned", occurrenceId: "p3:B1:v1", happenedAt: "2026-11-20T11:00:00Z", members: [{ memberKey: "m1" }] }))).toMatchObject({ result: "accepted", members: { pending: 1 } });
    expect(await send(env({ stage: "files_found", occurrenceId: "p2:B1:v1", happenedAt: "2026-11-20T10:00:00Z", members: [{ memberKey: "m1", shopifyOrderId: "8001" }] }))).toMatchObject({ members: { pending: 1 } });
    expect(await evidenceKeys()).toEqual([]);
    const r = await send(env({ members: [{ memberKey: "m1", orderNumber: "#9001" }, { memberKey: "m2", orderNumber: "9002" }] }));
    expect(r).toMatchObject({ result: "accepted", members: { resolved: 1, unresolved: 1 } });
    expect(await evidenceKeys("shopify_order_id = '8001'")).toEqual(["p1:B1:v1|9001", "p2:B1:v1|9001", "p3:B1:v1|9001"]);
    // m2 has no Part 2 mapping: durable and unresolved, attached to nothing
    expect((await db.query("select member_key, status, shopify_order_id from public.make_milestone_members where batch_id = 'B1' order by 1")).rows)
      .toEqual([{ member_key: "m1", status: "resolved", shopify_order_id: "8001" }, { member_key: "m2", status: "unresolved", shopify_order_id: null }]);
    // the scope routed the previously unknown order to AU (set once) with the Part 1 alias, so the F10 read shows the steps
    const t = await readOrderTimeline(owner, { site: "au", orderNumber: "9001" }, { rpc: rpc(), now: () => Date.parse("2026-11-21T00:00:00Z") });
    expect(t.stages?.filter((s) => s.stage.startsWith("make_")).map((s) => [s.stage, s.status])).toEqual([
      ["make_submitted", "confirmed"], ["make_files_found", "confirmed"], ["make_planned", "confirmed"], ["make_images_ready", "missing"], ["make_packing_ready", "missing"]]);
    expect(t.gaps.find((g) => g.from === "make_submitted")).toMatchObject({ status: "measured", hours: 1 });
    expect(t.gaps.find((g) => g.from === "make_planned")).toMatchObject({ status: "unknown" }); // missing later step: never invented
    expect(t.evidence.filter((e) => e.source === "make").map((e) => [e.stage, e.batchId, e.runId])).toEqual([
      ["make_submitted", "B1", "p1:B1:v1"], ["make_files_found", "B1", "p2:B1:v1"], ["make_planned", "B1", "p3:B1:v1"]]);
  });
  it("successful subsets are scoped to their batch/version; a later version never inherits an earlier one; non-members fail closed", async () => {
    await send(env({ occurrenceId: "p1:S:v1", batchId: "S", members: [{ memberKey: "a", orderNumber: "9101" }, { memberKey: "b", orderNumber: "9102" }, { memberKey: "c", orderNumber: "9103" }] }));
    await send(env({ stage: "files_found", occurrenceId: "p2:S:v1", batchId: "S", happenedAt: "2026-11-20T10:00:00Z",
      members: [{ memberKey: "a", shopifyOrderId: "8101" }, { memberKey: "b", shopifyOrderId: "8102" }] }));
    const p5 = await send(env({ stage: "images_ready", occurrenceId: "p5:S:v1", batchId: "S", happenedAt: "2026-11-20T12:00:00Z", members: [{ memberKey: "a" }, { memberKey: "zz" }] }));
    expect(p5.members).toMatchObject({ attached: 1, notMember: 1 });
    expect(await evidenceKeys("batch_id = 'S'")).toEqual(["p1:S:v1|9101", "p1:S:v1|9102", "p2:S:v1|9101", "p2:S:v1|9102", "p5:S:v1|9101"]); // c: submitted but unresolved, b: no images_ready
    // version 2 (changed membership) is separate: its refs never attach through version 1's members
    await send(env({ stage: "packing_slips_ready", occurrenceId: "p6:S:v2", batchId: "S", membershipVersion: 2, happenedAt: "2026-11-20T13:00:00Z", members: [{ memberKey: "a" }] }));
    expect(await evidenceKeys("occurrence_key like '%|p6:S:%'")).toEqual([]);
    expect((await db.query("select status from public.make_milestone_refs where occurrence_id = 'p6:S:v2'")).rows).toEqual([{ status: "pending" }]);
  });
  it("cross-site: an order already routed to another site is never reassigned or attached; the member stays blocked", async () => {
    await rpc().rpc("ingest_order_timeline", { p_order: { shop: SHOP, shopifyOrderId: "8201", orderNumber: "9201", site: "uk", routeReason: null }, p_evidence: [] });
    await send(env({ occurrenceId: "p1:X:v1", batchId: "X", members: [{ memberKey: "m", orderNumber: "9201" }] }));
    const r = await send(env({ stage: "files_found", occurrenceId: "p2:X:v1", batchId: "X", members: [{ memberKey: "m", shopifyOrderId: "8201" }] }));
    expect(r.members).toMatchObject({ blocked: 1, attached: 0 });
    expect((await db.query("select status from public.make_milestone_members where batch_id = 'X'")).rows).toEqual([{ status: "site_conflict" }]);
    expect((await db.query("select site from public.order_timeline_orders where shopify_order_id = '8201'")).rows).toEqual([{ site: "uk" }]);
    expect(await evidenceKeys("batch_id = 'X'")).toEqual([]);
  });
  it("ambiguous or changing mappings fail closed: two members to one order, or one member to two orders", async () => {
    await send(env({ occurrenceId: "p1:A:v1", batchId: "A", members: [{ memberKey: "m1", orderNumber: "9301" }, { memberKey: "m2", orderNumber: "9302" }] }));
    await send(env({ stage: "files_found", occurrenceId: "p2:A:v1", batchId: "A", members: [{ memberKey: "m1", shopifyOrderId: "8301" }, { memberKey: "m2", shopifyOrderId: "8301" }] }));
    expect((await db.query("select status from public.make_milestone_members where batch_id = 'A' order by member_key")).rows).toEqual([{ status: "ambiguous" }, { status: "ambiguous" }]);
    expect(await evidenceKeys("batch_id = 'A'")).toEqual([]);
    await send(env({ occurrenceId: "p1:C:v1", batchId: "C", members: [{ memberKey: "m", orderNumber: "9401" }] }));
    await send(env({ stage: "files_found", occurrenceId: "p2:C:v1", batchId: "C", members: [{ memberKey: "m", shopifyOrderId: "8401" }] }));
    await send(env({ stage: "files_found", occurrenceId: "p2:C:v1:rerun", batchId: "C", happenedAt: "2026-11-20T10:30:00Z", members: [{ memberKey: "m", shopifyOrderId: "8402" }] }));
    expect((await db.query("select status, shopify_order_id from public.make_milestone_members where batch_id = 'C'")).rows).toEqual([{ status: "mapping_conflict", shopify_order_id: "8401" }]);
    expect((await db.query("select status from public.make_milestone_refs where occurrence_id = 'p2:C:v1:rerun'")).rows).toEqual([{ status: "blocked" }]);
  });
  it("a different alias for an existing canonical order is not attached", async () => {
    await rpc().rpc("ingest_order_timeline", { p_order: { shop: SHOP, shopifyOrderId: "8501", orderNumber: "9501", site: "au", routeReason: null }, p_evidence: [] });
    await send(env({ occurrenceId: "p1:N:v1", batchId: "N", members: [{ memberKey: "m", orderNumber: "9599" }] }));
    expect((await send(env({ stage: "files_found", occurrenceId: "p2:N:v1", batchId: "N", members: [{ memberKey: "m", shopifyOrderId: "8501" }] }))).members).toMatchObject({ blocked: 1 });
    expect((await db.query("select status from public.make_milestone_members where batch_id = 'N'")).rows).toEqual([{ status: "alias_conflict" }]);
  });
  it("batch status is readable (unresolved stays visible) and bounded", async () => {
    const r = await rpc().rpc("read_make_batch", { p_site: "au", p_shop: SHOP, p_batch_id: "B1", p_limit: 100 });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ batchId: "B1", members: expect.arrayContaining([expect.objectContaining({ memberKey: "m2", status: "unresolved", orderNumber: "9002" })]) });
    expect((await rpc().rpc("read_make_batch", { p_site: "au", p_shop: SHOP, p_batch_id: "B1", p_limit: 1 })).error?.message).toMatch(/exceed the limit/);
    expect((await rpc().rpc("read_make_batch", { p_site: "uk", p_shop: SHOP, p_batch_id: "B1", p_limit: 100 })).data).toMatchObject({ members: [] }); // another site's scope sees nothing
  });
});

describe("review task1 P1: globally scoped deterministic timeline keys", () => {
  it("AU and UK scopes reusing identical occurrence/member ids attach to their own orders; retries stay idempotent", async () => {
    const SHOP2 = "inka-staging-synthetic-uk.myshopify.com";
    const p1 = env({ occurrenceId: "p1:G:v1", batchId: "G", members: [{ memberKey: "m", orderNumber: "9601" }] });
    const p2 = (id: string) => env({ stage: "files_found", occurrenceId: "p2:G:v1", batchId: "G", happenedAt: "2026-11-20T10:00:00Z", members: [{ memberKey: "m", shopifyOrderId: id }] });
    expect(await send(p1, "au", SHOP)).toMatchObject({ result: "accepted" });
    expect((await send(p2("8601"), "au", SHOP)).members).toMatchObject({ attached: 1 });
    expect(await send(p1, "uk", SHOP2)).toMatchObject({ result: "accepted" });
    expect((await send(p2("8602"), "uk", SHOP2)).members).toMatchObject({ attached: 1 });
    const rows = (await db.query<{ occurrence_key: string; site: string; shopify_order_id: string }>(
      "select occurrence_key, site, shopify_order_id from public.order_timeline_evidence where batch_id = 'G' order by site, occurrence_key")).rows;
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.occurrence_key)).size).toBe(4);
    expect(rows.every((r) => r.occurrence_key.length <= 200 && /^mk:[0-9a-f]{64}\|p[12]:G:v1$/.test(r.occurrence_key))).toBe(true);
    expect(rows.map((r) => [r.site, r.shopify_order_id])).toEqual([["au", "8601"], ["au", "8601"], ["uk", "8602"], ["uk", "8602"]]);
    // identical retries in both scopes: duplicates, no new rows
    for (const [site, shop, id] of [["au", SHOP, "8601"], ["uk", SHOP2, "8602"]] as const) {
      expect(await send(p1, site, shop)).toMatchObject({ result: "duplicate" });
      expect(await send(p2(id), site, shop)).toMatchObject({ result: "duplicate" });
    }
    expect((await db.query("select count(*)::int n from public.order_timeline_evidence where batch_id = 'G'")).rows[0]).toEqual({ n: 4 });
  });
});

describe("review task1 P1: conflicts discovered after attachment fail closed like conflicts known first", () => {
  const makeStagesOn = async (on: PGlite, orderNumber: string) => {
    const t = await readOrderTimeline(owner, { site: "au", orderNumber }, { rpc: pgRpc(on), now: () => Date.parse("2026-11-21T00:00:00Z") });
    return (t.stages ?? []).filter((x) => x.stage.startsWith("make_") && x.status !== "missing").map((x) => x.stage);
  };
  const run = async (on: PGlite, list: Env[]) => {
    for (const e of list) {
      const r = await pgRpc(on).rpc("ingest_make_milestone", { p_site: "au", p_shop: SHOP, p_scope: "au-staging", p_envelope: e });
      if (r.error) throw new Error(r.error.message);
    }
  };
  it("mapping conflict: P1, P2(m->1010) attach, then P2'(m->1011) retracts exactly; equal to mappings-before-membership; retries never resurrect", async () => {
    const P1 = env({ occurrenceId: "p1:K:v1", batchId: "K", members: [{ memberKey: "m", orderNumber: "9010" }] });
    const P2a = env({ stage: "files_found", occurrenceId: "p2:K:v1:a", batchId: "K", happenedAt: "2026-11-20T10:00:00Z", members: [{ memberKey: "m", shopifyOrderId: "1010" }] });
    const P2b = env({ stage: "files_found", occurrenceId: "p2:K:v1:b", batchId: "K", happenedAt: "2026-11-20T10:30:00Z", members: [{ memberKey: "m", shopifyOrderId: "1011" }] });
    await run(db, [P1, P2a]);
    expect(await makeStagesOn(db, "9010")).toEqual(["make_submitted", "make_files_found"]); // attached first
    await run(db, [P2b]);
    expect(await makeStagesOn(db, "9010")).toEqual([]); // stale confirmations suppressed
    const t = await readOrderTimeline(owner, { site: "au", orderNumber: "9010" }, { rpc: rpc(), now: () => Date.parse("2026-11-21T00:00:00Z") });
    expect(t.evidence.filter((e) => e.source === "make").map((e) => [e.stage, e.retraction, e.revoked])).toEqual([
      ["make_submitted", false, true], ["make_submitted", true, false], ["make_files_found", false, true], ["make_files_found", true, false]]);
    expect(t.cancelled).toBeNull(); // never an order cancellation
    // history is immutable: original facts still stored; refs record what happened
    expect((await db.query("select status from public.make_milestone_refs where occurrence_id like 'p%:K:%' order by occurrence_id")).rows.map((r) => (r as { status: string }).status))
      .toEqual(["retracted", "retracted", "blocked"]);
    // retries (all three, any order) are duplicates: no second retraction, no resurrection
    const before = (await db.query("select count(*)::int n from public.order_timeline_evidence where batch_id = 'K'")).rows[0];
    for (const e of [P2a, P1, P2b, P2a]) expect((await send(e)).result).toBe("duplicate");
    expect((await db.query("select count(*)::int n from public.order_timeline_evidence where batch_id = 'K'")).rows[0]).toEqual(before);
    expect(await makeStagesOn(db, "9010")).toEqual([]);
    // a later successful step for the conflicted member never attaches
    expect((await send(env({ stage: "planned", occurrenceId: "p3:K:v1", batchId: "K", happenedAt: "2026-11-20T11:00:00Z", members: [{ memberKey: "m" }] }))).members).toMatchObject({ blocked: 1, attached: 0 });
    // equivalent eventual state with the mappings arriving before membership: same effective timeline (nothing)
    const other = await reportingDb();
    await run(other, [P2b, P2a, P1]);
    expect(await makeStagesOn(other, "9010")).toEqual([]);
    expect((await other.query("select status from public.make_milestone_members where batch_id = 'K'")).rows).toEqual([{ status: "mapping_conflict" }]);
    expect(await evidenceKeys("true", other)).toEqual([]);
  });
  it("ambiguity: m1->1020 attached, then m2->1020 makes both ambiguous and retracts m1's facts; equal to the order where both were known first", async () => {
    const P1 = env({ occurrenceId: "p1:Q:v1", batchId: "Q", members: [{ memberKey: "m1", orderNumber: "9020" }, { memberKey: "m2", orderNumber: "9021" }] });
    const A = env({ stage: "files_found", occurrenceId: "p2:Q:v1:a", batchId: "Q", happenedAt: "2026-11-20T10:00:00Z", members: [{ memberKey: "m1", shopifyOrderId: "1020" }] });
    const B = env({ stage: "files_found", occurrenceId: "p2:Q:v1:b", batchId: "Q", happenedAt: "2026-11-20T10:05:00Z", members: [{ memberKey: "m2", shopifyOrderId: "1020" }] });
    await run(db, [P1, A]);
    expect(await makeStagesOn(db, "9020")).toEqual(["make_submitted", "make_files_found"]);
    await run(db, [B]);
    expect((await db.query("select member_key, status from public.make_milestone_members where batch_id = 'Q' order by 1")).rows)
      .toEqual([{ member_key: "m1", status: "ambiguous" }, { member_key: "m2", status: "ambiguous" }]);
    expect(await makeStagesOn(db, "9020")).toEqual([]);
    expect((await send(B)).result).toBe("duplicate");
    expect(await makeStagesOn(db, "9020")).toEqual([]);
    const other = await reportingDb();
    await run(other, [B, A, P1]);
    expect(await makeStagesOn(other, "9020")).toEqual([]);
    expect(await evidenceKeys("true", other)).toEqual([]);
  });
});

describe("0060 grants", () => {
  it("browser roles cannot read the tables or execute the RPCs", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      try {
        for (const t of ["make_milestone_occurrences", "make_milestone_members", "make_milestone_refs"]) await expect(db.query(`select 1 from public.${t} limit 1`)).rejects.toThrow();
      } finally {
        await db.exec("RESET ROLE");
      }
      for (const fn of ["ingest_make_milestone", "read_make_batch"]) {
        const ok = (await db.query<{ ok: boolean }>(`select has_function_privilege($1, p.oid, 'EXECUTE') ok from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $2`, [role, fn])).rows;
        expect(ok, `${role} ${fn}`).toEqual([{ ok: false }]);
      }
    }
  });
});
