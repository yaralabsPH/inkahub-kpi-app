/**
 * T14S1: the prepared (NOT run) rollback-only 0040 + 0041 dependency-read
 * rehearsal, without a database: argument/dispatch wiring, exact migration
 * identities and bodies, the six SQL bindings, the SQL RpcClient feeding the
 * real reader, plan statements, the guard, comparisons, fixtures, and the
 * coordinator's refusals, fail-fast, rollback and evidence rules.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rpcFrozenReader } from "../../api/_lib/production-reporting-reader";
import { compareUtf8 } from "../../api/_lib/reporting-stage";
import { materializeOwners, memoryFrozenReader, ownerKey, type MaterializedWork, type Owner } from "../../api/_lib/production-reporting-materialize";
import type { ProductionEvidenceEvent } from "../../src/lib/domain/productionCounts";
import { runCaptureLifecycle } from "../staging/reportingCapture";
import {
  BIG_IDS, BIG_NOTE, CASE_SQL, checkOwnerByteProbe, OWNER_PROBE_ANCHOR, runOwnerByteProbe, compareEvents, compareMaterialization, DEPENDENCY_RPCS, dependencyFixtures, dependencyGuard, dependencyRpcSql,
  effectiveReadQuery, evidenceProblems, expectedChangedKeys, frozenOracle, functionBody, isContinuation, MIB, missingRequired, rawView, requiredWorks, MIGRATION_0040, MIGRATION_0041, newDependencyEvidence, newRpcStats, planSql,
  refreshInserts, rehearseDependencyReads, REQUIRED_CASES, REVIEWED, runDependencyCases, sqlRpcClient, type DependencyCtx, type DependencyDeps,
} from "../staging/reportingDependencyRehearsal";
import { compareFullState, migrationBody, newPublicationReport, parsePublicationArgs, productionEventAdmissibility, publicationStatus, ROLLBACK_ONLY, type Db, type FullState, type Observation } from "../staging/reportingPublication";
import { bodyHashes, FUNCTION_SQL, publishBody } from "../staging/reportingRebuildRepair";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const shaLf = (p: string) => createHash("sha256").update(read(p)).digest("hex");
const M37 = "supabase/migrations/0037_reporting_storage.sql";
const M38 = "supabase/migrations/0038_reporting_jobs.sql";
const M39 = "supabase/migrations/0039_reporting_rebuild_insert.sql";
const READS = Object.keys(DEPENDENCY_RPCS);
const W = { w1: "11111111-1111-4111-8111-111111111111", w2: "22222222-2222-4222-8222-222222222222", w3: "33333333-3333-4333-8333-333333333333", w4: "44444444-4444-4444-8444-444444444444" };

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe("T14S1: argument and dispatch wiring", () => {
  it("--rehearse-dependency-reads takes exactly --sites=A,B (and the existing --max-pages)", () => {
    expect(parsePublicationArgs(["--rehearse-dependency-reads", "--sites=uk,us"])).toMatchObject({ mode: "rehearse-dependency-reads", sites: ["uk", "us"], problems: [] });
    expect(parsePublicationArgs(["--rehearse-dependency-reads", "--sites=uk,us", "--max-pages=400"])).toMatchObject({ mode: "rehearse-dependency-reads", maxPages: 400 });
  });
  for (const argv of [["--rehearse-dependency-reads", "--site=uk"], ["--rehearse-dependency-reads", "--sites=uk,uk"], ["--rehearse-dependency-reads", "--sites=uk"], ["--rehearse-dependency-reads", "--sites=uk,us", "--commit"],
    ["--rehearse-dependency-reads", "--rehearse-rebuild-repair", "--sites=uk,us"], ["--rehearse-dependency-reads", "--sites=uk,us", "--max-pages=0"]]) {
    it(`refuses ${argv.join(" ")}`, () => expect(parsePublicationArgs(argv).mode).toBeNull());
  }
  it("the runner dispatches it inside the guarded lifecycle: baseline first, the rehearsal, ROLLBACK_ONLY fresh audit; main() and usage know the flag", () => {
    const runner = read("tests/staging/reporting-jobs.ts");
    const pub = runner.slice(runner.indexOf("async function publicationMain"), runner.indexOf("async function main()"));
    expect(pub.indexOf("open = () => openGuarded(s.STAGING_DB_URL, target, watch);")).toBeGreaterThan(0); // every connection is the guarded staging target
    expect(pub.indexOf("assertStagingSupabaseUrl(s.STAGING_SUPABASE_URL);")).toBeLessThan(pub.indexOf("open = () => openGuarded("));
    expect(pub.indexOf("before = await fullState(main);")).toBeLessThan(pub.indexOf('if (mode === "rehearse-dependency-reads") {'));
    expect(pub).toMatch(/await rehearseDependencyReads\(main, \{ sites, maxPages, staff, as, record, redact: redactSecrets, now: \(\) => performance\.now\(\), emit: \(ev\) => \{ report\.dependency = ev as unknown as Record<string, unknown>; save\(\); \} \}\);\n\s+return;/);
    expect(pub).toMatch(/if \(mode !== "rehearse-migration" && mode !== "baseline-smoke" && !installed\) throw/);
    expect(pub).toMatch(/const allow = mode === "committed-interleavings" && own \? committedAllowance\(own\) : ROLLBACK_ONLY;/);
    const main = runner.slice(runner.indexOf("async function main()"));
    expect(main).toMatch(/f === "--rehearse-dependency-reads"( \|\| f === "--[a-z-]+")*\)\) return publicationMain\(flags\);/); // T14S3 appends one more mode after it
    expect(main).toMatch(/--rehearse-dependency-reads --sites=A,B \[--max-pages=N\]/);
  });
  it("is never COMPLETE without complete dependency evidence, even with every observation ok and a verified restoration", () => {
    const r = newPublicationReport("rehearse-dependency-reads", ["uk", "us"], "rev", "t0", "sha");
    Object.assign(r, { finishedAt: "t1", restorationVerified: true, observations: [{ id: "D0", what: "x", expected: "y", result: "ok", ok: true, ms: 0 }] });
    expect(publicationStatus(r)).toBe("STATUS: FAILED – dependency-read evidence is missing or incomplete");
    r.dependency = { ...newDependencyEvidence(), complete: false };
    expect(publicationStatus(r)).toMatch(/^STATUS: FAILED – dependency-read evidence/);
    r.dependency = { ...newDependencyEvidence(), complete: true };
    expect(publicationStatus(r)).toBe("STATUS: COMPLETE");
    const other = newPublicationReport("rehearse-rebuild-repair", ["uk", "us"], "rev", "t0", "sha");
    Object.assign(other, { finishedAt: "t1", restorationVerified: true, observations: r.observations });
    expect(publicationStatus(other)).toBe("STATUS: COMPLETE"); // other modes unchanged
  });
  it("the strict API typecheck includes the rehearsal module and this test", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["typecheck:digest"]).toContain("tests/staging/reportingDependencyRehearsal.ts");
    expect(pkg.scripts["typecheck:digest"]).toContain("tests/reporting/reportingDependencyRehearsal.test.ts");
  });
});

// ---------------------------------------------------------------------------
// Migration identities and bodies
// ---------------------------------------------------------------------------

describe("T14S1: exact migration identities and the two applied bodies", () => {
  it("0040 and 0041 are the reviewed drafts; 0039 the installed identity", () => {
    expect(REVIEWED["0040"]).toContain(shaLf(MIGRATION_0040));
    expect(REVIEWED["0041"]).toContain(shaLf(MIGRATION_0041));
    expect(REVIEWED["0039"]).toContain(shaLf(M39));
  });
  it("0040 parses to 25 statements (helper, six reads, four indexes, grants) and 0041 to the six replacements in order", () => {
    const b40 = migrationBody(read(MIGRATION_0040));
    const b41 = migrationBody(read(MIGRATION_0041));
    expect(b40).toHaveLength(25);
    expect(b41.map((s) => /CREATE OR REPLACE FUNCTION public\.(\w+)\(/.exec(s)?.[1])).toEqual(READS);
    expect([...b40, ...b41].some((s) => /^\s*(BEGIN|COMMIT|END|ROLLBACK)\s*;?\s*$/i.test(s))).toBe(false); // no transaction control of its own
  });
  it("functionBody extracts every effective prosrc (0040 helper, 0041 reads)", () => {
    expect(functionBody(read(MIGRATION_0040), "reporting_private.frozen_read_batch")).toMatch(/dependency reads need a frozen batch/);
    for (const fn of READS) expect(functionBody(read(MIGRATION_0041), `public.${fn}`)).toMatch(/frozen_read_batch\(p_batch, p_fence\)/);
    expect(() => functionBody(read(MIGRATION_0041), "public.nope")).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// SQL bindings and the adapter
// ---------------------------------------------------------------------------

const headerArgs = (fn: string) => {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(([^)]*)\\)`).exec(read(MIGRATION_0041))!;
  return m[1].split(",").map((a) => a.trim().replace(/ DEFAULT .*/, "").split(" ")) as Array<[string, string]>;
};
const argsFor = (fn: string): Record<string, unknown> => Object.fromEntries(DEPENDENCY_RPCS[fn].map(([k]) => [k, null]));

describe("T14S1: all six SQL bindings", () => {
  for (const fn of READS) {
    it(`${fn}: every argument bound by name with the 0041 header's exact type`, () => {
      expect(DEPENDENCY_RPCS[fn].map(([k, t]) => [k, t])).toEqual(headerArgs(fn));
      const { sql, params } = dependencyRpcSql(fn, argsFor(fn));
      expect(sql).toBe(`select coalesce(pg_catalog.json_agg(t), '[]'::json)::text as body from public.${fn}(${DEPENDENCY_RPCS[fn].map(([, t], i) => `$${i + 1}::${t}`).join(", ")}) t`);
      expect(params).toHaveLength(DEPENDENCY_RPCS[fn].length);
    });
  }
  it("parameters follow the declared order regardless of object order; jsonb owners are serialized", () => {
    const { params } = dependencyRpcSql("read_reporting_owner_members", { p_limit: 5, p_owners: [["order", "A"]], p_after_event_id: "x", p_after_index: 0, p_fence: 3, p_batch: "b" });
    expect(params).toEqual(["b", 3, '[["order","A"]]', 0, "x", 5]);
  });
  it("refuses an unknown function, a missing or an extra argument", () => {
    expect(() => dependencyRpcSql("copy_reporting_source_page", {})).toThrow(/unknown function/);
    expect(() => dependencyRpcSql("read_reporting_events_by_id", { p_batch: "b", p_fence: 1 })).toThrow(/arguments must be exactly/);
    expect(() => dependencyRpcSql("read_reporting_events_by_id", { p_batch: "b", p_fence: 1, p_ids: [], p_limit: 1 })).toThrow(/arguments must be exactly/);
  });
});

const BATCH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ev = (id: string, o: Partial<ProductionEvidenceEvent> = {}): ProductionEvidenceEvent => ({ id, location: "uk", staff_id: W.w1, department: "framed", order_number: "O-1", line_sku: null, line_quantity: null, event_type: "started", created_at: "2026-02-10T08:00:00+00:00", parent_event_id: null, cs_case_id: null, ...o });
const imageOf = (e: ProductionEvidenceEvent) => ({ ...e, note: "", station_id: "s" });

/** A fake database answering only the adapter's json_agg calls, from an in-memory set of rows per function. */
function aggDb(answer: (fn: string, params: unknown[]) => unknown[]) {
  const sent: string[] = [];
  const db: Db = {
    query: async (sql: string, params?: unknown[]) => {
      sent.push(sql);
      const m = /from public\.(\w+)\(/.exec(sql);
      if (!m) return { rows: [], rowCount: 0 };
      return { rows: [{ body: JSON.stringify(answer(m[1], params ?? [])) }], rowCount: 1 };
    },
  };
  return { db, sent };
}

describe("T14S1: the SQL RpcClient on the rehearsal transaction", () => {
  it("switches to service_role for exactly one call, records calls/rows/PostgreSQL and compact bytes/short pages", async () => {
    const roles: boolean[] = [];
    const { db } = aggDb(() => [{ event_id: "a", image: imageOf(ev("a")) }]);
    const stats = newRpcStats();
    const c = sqlRpcClient(db, async (_c, s) => void roles.push(s), stats, () => 0);
    const r = await c.rpc("read_reporting_events_by_id", { p_batch: BATCH, p_fence: 1, p_ids: ["a"] });
    expect(r.error).toBeNull();
    expect(roles).toEqual([true, false]);
    expect(stats.read_reporting_events_by_id).toMatchObject({ calls: 1, rows: 1, maxRows: 1 });
    expect(stats.read_reporting_events_by_id.maxPgBytes).toBeGreaterThan(0);
    expect(stats.read_reporting_events_by_id.maxCompactBytes).toBe(Buffer.byteLength(JSON.stringify([{ event_id: "a", image: imageOf(ev("a")) }])));
    await c.rpc("read_reporting_children", { p_batch: BATCH, p_fence: 1, p_parent_ids: ["a"], p_after_parent_id: null, p_after_event_id: null, p_limit: 1000 });
    expect(stats.read_reporting_children.nonEmptyUnderLimit).toBe(1); // a raw count (here an ordinary final page)
    expect(stats.read_reporting_children.cappedContinuations).toBe(0); // NOT byte-cap evidence: nothing continued from it
  });
  it("cappedContinuations counts only a non-empty under-limit page followed by its EXACT keyset continuation that returns rows", async () => {
    const pages: Array<Array<Record<string, unknown>>> = [];
    const { db } = aggDb(() => pages.shift() ?? []);
    const stats = newRpcStats();
    const c = sqlRpcClient(db, async () => undefined, stats, () => 0);
    const args = (after: [string, string] | null) => ({ p_batch: BATCH, p_fence: 1, p_parent_ids: ["p"], p_after_parent_id: after?.[0] ?? null, p_after_event_id: after?.[1] ?? null, p_limit: 1000 });
    pages.push([{ parent_event_id: "p", event_id: "a" }], [{ parent_event_id: "p", event_id: "b" }], []);
    await c.rpc("read_reporting_children", args(null));
    await c.rpc("read_reporting_children", args(["p", "a"])); // exact continuation with rows: counted
    await c.rpc("read_reporting_children", args(["p", "b"])); // empty final page: not counted
    expect(stats.read_reporting_children.cappedContinuations).toBe(1);
    pages.push([{ parent_event_id: "p", event_id: "c" }], [{ parent_event_id: "p", event_id: "d" }]);
    await c.rpc("read_reporting_children", args(null));
    await c.rpc("read_reporting_children", args(["p", "x"])); // not the exact continuation: not counted
    expect(stats.read_reporting_children.cappedContinuations).toBe(1);
    // A FULL page (rows = limit) followed by its continuation is ordinary row-cap paging, not byte-cap evidence.
    pages.push([{ parent_event_id: "p", event_id: "e" }, { parent_event_id: "p", event_id: "f" }], [{ parent_event_id: "p", event_id: "g" }]);
    await c.rpc("read_reporting_children", { ...args(null), p_limit: 2 });
    await c.rpc("read_reporting_children", { ...args(["p", "f"]), p_limit: 2 });
    expect(stats.read_reporting_children.cappedContinuations).toBe(1);
  });
  it("isContinuation: the exact keyset of each read", () => {
    const b = { p_batch: BATCH, p_fence: 1 };
    expect(isContinuation("read_reporting_changed_keys", { ...b, p_after_event_id: null }, [{ event_id: "k" }], { ...b, p_after_event_id: "k" })).toBe(true);
    expect(isContinuation("read_reporting_changed_keys", { ...b }, [{ event_id: "k" }], { ...b, p_fence: 2, p_after_event_id: "k" })).toBe(false);
    expect(isContinuation("list_reporting_owners", { ...b }, [{ partition_kind: "order", partition_key: "K" }], { ...b, p_after_kind: "order", p_after_key: "K" })).toBe(true);
    expect(isContinuation("read_reporting_owner_members", { ...b, p_owners: [["order", "A"]] }, [{ owner_index: 0, event_id: "e" }], { ...b, p_owners: [["order", "A"]], p_after_index: 0, p_after_event_id: "e" })).toBe(true);
    expect(isContinuation("read_reporting_owner_members", { ...b, p_owners: [["order", "A"]] }, [{ owner_index: 0, event_id: "e" }], { ...b, p_owners: [["order", "B"]], p_after_index: 0, p_after_event_id: "e" })).toBe(false);
    expect(isContinuation("read_reporting_events_by_id", { ...b, p_ids: ["a", "b", "c"] }, [{ event_id: "a" }], { ...b, p_ids: ["b", "c"] })).toBe(true);
    expect(isContinuation("read_reporting_events_by_id", { ...b, p_ids: ["a", "b", "c"] }, [{ event_id: "a" }], { ...b, p_ids: ["c"] })).toBe(false);
    expect(isContinuation("read_reporting_staff_stream", { ...b, p_staff: "s", p_direction: "after" }, [{ event_id: "e", image: { created_at: "t" } }], { ...b, p_staff: "s", p_direction: "after", p_at: "t", p_at_event_id: "e" })).toBe(true);
    expect(isContinuation("read_reporting_staff_stream", { ...b, p_staff: "s", p_direction: "after" }, [{ event_id: "e", image: { created_at: "t" } }], { ...b, p_staff: "s", p_direction: "before", p_at: "t", p_at_event_id: "e" })).toBe(false);
    expect(isContinuation("read_reporting_children", { ...b }, [], { ...b })).toBe(false);
  });
  it("FAILS (never slices) a response over 1,000 rows or over 1 MiB of compact JSON", async () => {
    const many = aggDb(() => Array.from({ length: 1001 }, (_, i) => ({ event_id: String(i) })));
    await expect(sqlRpcClient(many.db, async () => undefined, newRpcStats(), () => 0).rpc("read_reporting_events_by_id", { p_batch: BATCH, p_fence: 1, p_ids: ["x"] })).rejects.toThrow(/more than 1,000/);
    const big = aggDb(() => [{ event_id: "x", image: { note: "é".repeat(MIB / 2 + 1) } }]);
    await expect(sqlRpcClient(big.db, async () => undefined, newRpcStats(), () => 0).rpc("read_reporting_events_by_id", { p_batch: BATCH, p_fence: 1, p_ids: ["x"] })).rejects.toThrow(/more than 1 MiB/);
  });
  it("feeds the ACTUAL rpcFrozenReader: a byte-capped short page continues to the empty page; non-progress is impossible", async () => {
    const view = Array.from({ length: 5 }, (_, i) => ev(`e${i}`, { parent_event_id: "p" }));
    let calls = 0;
    const { db } = aggDb((fn, params) => {
      calls++;
      expect(fn).toBe("read_reporting_children");
      const [afterParent, afterId] = [params[3] as string | null, params[4] as string | null];
      const rest = view.filter((e) => afterParent === null || e.id > afterId!);
      return rest.slice(0, 2).map((e) => ({ parent_event_id: "p", event_id: e.id, image: imageOf(e) })); // a "short" page of 2 under limit 1000
    });
    const reader = rpcFrozenReader(sqlRpcClient(db, async () => undefined, newRpcStats(), () => 0), { batchId: BATCH, fence: 1, site: "uk", cutoff: "2026-03-01T00:00:00.000000Z", kind: "rebuild" });
    const got: string[] = [];
    for await (const e of reader.children(["p"])) got.push(e.id);
    expect(got).toEqual(view.map((e) => e.id));
    expect(calls).toBe(4); // 2 + 2 + 1 + empty
  });
  it("the materializer through the SQL adapter equals the in-memory reader over the same view (descriptors, input hashes, rows)", async () => {
    const view = [ev("a1", { order_number: "O-1", event_type: "line_verified", line_sku: "INKA-KAN0566-A4-FB", line_quantity: 1 }), ev("a2", { order_number: "O-1", created_at: "2026-02-10T09:00:00+00:00", event_type: "completed" }), ev("b1", { order_number: "O-2", created_at: "2026-02-10T08:30:00+00:00" })];
    const mem = memoryFrozenReader({ site: "uk", cutoff: "2026-03-01T00:00:00.000000Z", kind: "rebuild", view, changed: [] });
    // Answer each SQL read from the in-memory reader (the transport is what is under test here).
    const { db } = aggDb((fn, p) => {
      if (fn === "read_reporting_owner_members") {
        const owners = JSON.parse(p[2] as string) as Array<[string, string]>;
        if (p[3] !== null) return [];
        return owners.flatMap(([k, key], i) => view.filter((e) => (k === "order" ? e.order_number === key : e.id === key)).sort((x, y) => (x.id < y.id ? -1 : 1)).map((e) => ({ owner_index: i, event_id: e.id, image: imageOf(e) })));
      }
      if (fn === "read_reporting_staff_stream") {
        const [staff, dir, at, atId] = [p[2], p[3], p[4], p[5]] as string[];
        const us = (s: string) => Date.parse(s);
        const xs = view.filter((e) => e.staff_id === staff && (dir === "after" ? us(e.created_at) > us(at) || (us(e.created_at) === us(at) && e.id > atId) : us(e.created_at) < us(at) || (us(e.created_at) === us(at) && e.id < atId)));
        xs.sort((x, y) => (us(x.created_at) - us(y.created_at)) || (x.id < y.id ? -1 : 1));
        if (dir === "before") xs.reverse();
        return xs.map((e) => ({ event_id: e.id, image: imageOf(e) }));
      }
      return [];
    });
    const reader = rpcFrozenReader(sqlRpcClient(db, async () => undefined, newRpcStats(), () => 0), { batchId: BATCH, fence: 1, site: "uk", cutoff: "2026-03-01T00:00:00.000000Z", kind: "rebuild" });
    const owners = [{ partitionKind: "order" as const, partitionKey: "O-1" }, { partitionKind: "order" as const, partitionKey: "O-2" }];
    const z = () => ({ owners: 0, works: 0, maxInput: 0, totalInput: 0, requests: 0, peakInput: 0 });
    const a: MaterializedWork[] = [];
    const b: MaterializedWork[] = [];
    await materializeOwners(reader, owners, new Map(), (w) => void a.push(w), z());
    await materializeOwners(mem, owners, new Map(), (w) => void b.push(w), z());
    expect(a.length).toBeGreaterThan(0);
    expect(compareMaterialization(a, b, frozenOracle("uk", "2026-03-01T00:00:00.000000Z", view))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Plan statements
// ---------------------------------------------------------------------------

describe("T14S1: full-volume plan statements are the effective 0041 queries", () => {
  const t41 = read(MIGRATION_0041);
  for (const fn of ["read_reporting_owner_members", "read_reporting_staff_stream"] as const) {
    it(`${fn}: EXPLAIN (VERBOSE, SETTINGS, FORMAT JSON), never ANALYZE; every $n bound; un-binding gives back the exact migration query`, () => {
      const q = planSql(t41, fn);
      expect(q.startsWith("EXPLAIN (VERBOSE, SETTINGS, FORMAT JSON) ")).toBe(true);
      expect(q).not.toMatch(/ANALYZE/i);
      const ns = [...new Set([...q.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((x, y) => x - y);
      expect(ns).toEqual(Array.from({ length: ns.length }, (_, i) => i + 1)); // contiguous: PostgreSQL can type every parameter
      expect(ns.length).toBe(fn === "read_reporting_owner_members" ? 7 : 8);
      const names = fn === "read_reporting_owner_members" ? ["b.batch_id", "b.site", "b.kind", "p_owners", "p_after_index", "p_after_event_id", "p_limit"] : ["b.batch_id", "b.site", "b.kind", "p_staff", "p_direction", "p_at", "p_at_event_id", "p_limit"];
      const back = q.slice("EXPLAIN (VERBOSE, SETTINGS, FORMAT JSON) ".length).replace(/\$(\d+)::[a-z]+/g, (_, n) => names[Number(n) - 1]);
      expect(back).toBe(effectiveReadQuery(t41, fn));
      expect(t41).toContain(back);
    });
  }
  it("refuses a query that would leave a variable unbound", () => {
    const broken = read(MIGRATION_0041).replace(/(CREATE OR REPLACE FUNCTION public\.read_reporting_staff_stream[\s\S]*?FOR r IN\n)/, "$1      SELECT v_extra,\n");
    expect(() => planSql(broken, "read_reporting_staff_stream")).toThrow(/unbound variable/);
  });
});

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

describe("T14S1: the statement guard", () => {
  const body = [...migrationBody(read(MIGRATION_0040)), ...migrationBody(read(MIGRATION_0041))];
  const forbidden = ["commit", "end", "abort", "vacuum reporting_private.source_candidate", "analyze", "checkpoint", "set statement_timeout = 0", "set session lock_timeout = '1h'", "set local statement_timeout = 0", "set local enable_seqscan = off", "set work_mem = '1GB'", "set enable_seqscan = off",
    "select set_config('statement_timeout', '0', true)", "select set_config('enable_seqscan', 'off', true)", "set local role postgres", "set role supabase_admin",
    "insert into supabase_migrations.schema_migrations (version) values ('0040')", "select net.http_get('https://example.com')", "select dblink('x', 'y')", "-- a comment first\ncreate table x (a int)", "/* c */ drop index reporting_private.source_current_staff_time", "  -- c\n  -- d\n  commit", "select pg_read_file('/etc/passwd')",
    "create index x on reporting_private.source_candidate (site)", "drop function public.read_reporting_children(uuid, bigint, text[], text, text, integer)", "do $$ begin end $$",
    "grant execute on function public.read_reporting_events_by_id(uuid, bigint, text[]) to anon", "EXPLAIN (ANALYZE, VERBOSE) select 1", "copy x to stdout", body.find((s) => s.includes("SECURITY INVOKER"))!.replace("SECURITY INVOKER", "SECURITY DEFINER")];
  for (const sql of forbidden) {
    it(`refuses before sending: ${sql.slice(0, 60)}`, async () => {
      const sent: string[] = [];
      const raw: Db = { query: async (q: string) => (sent.push(q), { rows: [], rowCount: 0 }) };
      await expect(dependencyGuard(raw, new Set(body)).query(sql)).rejects.toThrow(/dependency-read rehearsal refuses/);
      expect(sent).toEqual([]);
    });
  }
  it("lets through exactly the 31 reviewed statements, transaction/savepoint control, role switching and the case SQL", async () => {
    const sent: string[] = [];
    const raw: Db = { query: async (q: string) => (sent.push(q), { rows: [], rowCount: 0 }) };
    const g = dependencyGuard(raw, new Set(body));
    const ok = [...body, "begin", "rollback", "savepoint rp_probe", "rollback to savepoint rp_probe", "release savepoint rp_probe", "set local role service_role", "set local role anon", "set local role authenticated", "reset role",
      "select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', '', true)", ...Object.values(CASE_SQL), planSql(read(MIGRATION_0041), "read_reporting_staff_stream"),
      dependencyRpcSql("read_reporting_children", argsFor("read_reporting_children")).sql, "select * from public.publish_reporting_batch($1, $2)"];
    for (const q of ok) await g.query(q);
    expect(sent).toHaveLength(ok.length);
    expect(body).toHaveLength(31);
  });
});

// ---------------------------------------------------------------------------
// Comparisons and evidence
// ---------------------------------------------------------------------------

describe("T14S1: exact comparisons are sensitive", () => {
  const base = [ev("a"), ev("b", { created_at: "2026-02-10T08:00:00.000001+00:00" })];
  it("accepts an exact set in any order", () => expect(compareEvents("x", base, [base[1], base[0]])).toEqual([]));
  it("catches missing, extra, repeated and changed events", () => {
    expect(compareEvents("x", base, [base[0]]).join()).toMatch(/"b" is missing/);
    expect(compareEvents("x", base, [...base, ev("c")]).join()).toMatch(/"c" is not in the frozen view/);
    expect(compareEvents("x", base, [...base, base[0]]).join()).toMatch(/"a" returned twice/);
    expect(compareEvents("x", base, [base[0], { ...base[1], created_at: "2026-02-10T08:00:00+00:00" }]).join()).toMatch(/"b" differs/);
    expect(compareEvents("x", base, [base[0], { ...base[1], staff_id: W.w2 }]).join()).toMatch(/"b" differs/);
  });
  it("compareMaterialization catches a missing/extra work, a hash or row difference and an oracle difference", async () => {
    const view = [ev("a1", { event_type: "line_verified", line_sku: "INKA-KAN0566-A4-FB", line_quantity: 1 })];
    const mem = memoryFrozenReader({ site: "uk", cutoff: "2026-03-01T00:00:00.000000Z", kind: "rebuild", view, changed: [] });
    const works: MaterializedWork[] = [];
    await materializeOwners(mem, [{ partitionKind: "order", partitionKey: "O-1" }], new Map(), (w) => void works.push(w), { owners: 0, works: 0, maxInput: 0, totalInput: 0, requests: 0, peakInput: 0 });
    const oracle = frozenOracle("uk", "2026-03-01T00:00:00.000000Z", view);
    expect(compareMaterialization(works, works, oracle)).toEqual([]);
    expect(compareMaterialization(works.slice(1), works, oracle).join()).toMatch(/missing from the RPC path/);
    expect(compareMaterialization(works, works.slice(1), oracle).join()).toMatch(/extra on the RPC path/);
    const hash = works.map((w) => ({ ...w, desc: { ...w.desc, inputHash: "0".repeat(64) } }));
    expect(compareMaterialization(hash, works, oracle).join()).toMatch(/input hash differs/);
    const rows = works.map((w) => ({ ...w, rows: { ...w.rows, event_facts: [] } }));
    expect(compareMaterialization(rows, works, oracle).join()).toMatch(/rows differ from the independent view/);
    expect(compareMaterialization(rows, rows, oracle).join()).toMatch(/rows differ from the full frozen-view oracle/);
  });
  it("evidence is incomplete until every required case is recorded", () => {
    const e = newDependencyEvidence();
    expect(evidenceProblems(e).join()).toMatch(/D0, D1/);
    e.recorded = REQUIRED_CASES.filter((x) => x !== "R7s");
    expect(evidenceProblems(e)).toEqual(["required rehearsal cases were not recorded: R7s"]);
    e.recorded = [...REQUIRED_CASES];
    expect(evidenceProblems(e)).toEqual([]);
    expect(e.label).toMatch(/NOT an observed PostgREST HTTP response/);
    expect(e.label).toMatch(/not a scale certification/);
  });
  it("the required cases cover setup, all six reads, refusals, security, immutability, materialization, timings and the final rollback", () => {
    for (const id of ["D0", "D1", "D2", "D3", "R1", "R2", "R3", "R4", "R5", "R6", "R7", "R7m", "R7s", "R8", "R9", "F1", "F2", "F3", "F4", "F5x", "X1", "X2", "X3", "X4", "X5", "X6", "X6d", "X7", "X8", "X8t", "X9", "T1", "T2", "U1", "U2", "U3", "D9"]) expect(REQUIRED_CASES).toContain(id);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

describe("T14S1: fixed named fixtures", () => {
  const fx = dependencyFixtures(W);
  it("every row is admissible to production_events; ids are unique per site; the same id exists at both sites", () => {
    for (const [site, rows] of [["uk", fx.a], ["us", fx.b], ["uk", refreshInserts(W)]] as const) {
      expect(rows.flatMap((x) => productionEventAdmissibility(x, site))).toEqual([]);
      expect(new Set(rows.map((x) => x.id)).size).toBe(rows.length);
    }
    expect(fx.a.some((x) => x.id === "dr-dup") && fx.b.some((x) => x.id === "dr-dup")).toBe(true);
    expect(fx.b.find((x) => x.id === "dr-dupc")?.parent_event_id).toBe("dr-v"); // B's child of an A parent id: scope isolation
    expect([...fx.a, ...fx.b, ...refreshInserts(W)].every((x) => x.id.startsWith("dr-"))).toBe(true);
  });
  it("1,000 owners with ~1,200-byte keys; 15 big rows and 15 big children whose 1,000-row page would exceed 1 MiB", () => {
    const keys = fx.a.filter((x) => String(x.order_number).startsWith("DRK-"));
    expect(keys).toHaveLength(1000);
    expect(keys.every((x) => Buffer.byteLength(String(x.order_number)) >= 1200)).toBe(true);
    expect(new Set(keys.map((x) => x.order_number)).size).toBe(1000);
    expect(1000 * 1200).toBeGreaterThan(MIB);
    const jsonbBytes = Buffer.byteLength(JSON.stringify(BIG_NOTE));
    expect(jsonbBytes * 15).toBeGreaterThan(MIB); // 15 rows cannot share one response: a short page must continue
    expect(jsonbBytes).toBeLessThan(MIB / 4);
    expect(BIG_IDS).toHaveLength(15);
    expect(BIG_IDS.every((id) => fx.a.some((x) => x.id === id && x.order_number === "DR-BIG"))).toBe(true);
    expect(fx.a.filter((x) => x.parent_event_id === "dr-bp")).toHaveLength(15);
    expect(["\u{1F600}", "\\", '"', "é"].every((x) => BIG_NOTE.includes(x))).toBe(true); // non-BMP, escaped and multibyte
  });
  it("the T14R1 and T14R2 regressions are present exactly", () => {
    const at = (id: string) => fx.a.find((x) => x.id === id) as unknown as { created_at: string; order_number: string; parent_event_id: string | null; staff_id: string };
    expect(at("dr-\u{1F600}").created_at).toBe(at("dr-�").created_at);
    expect(at("dr-\u{1F600}").order_number).toBe(at("dr-�").order_number);
    expect([at("dr-prev").created_at < String(refreshInserts(W)[0].created_at), String(refreshInserts(W)[0].created_at) < at("dr-next").created_at]).toEqual([true, true]);
    expect(at("dr-Ta").created_at).toBe(at("dr-tb").created_at);
    expect(at("dr-fut").created_at.startsWith("2099")).toBe(true);
    expect(at("dr-orph").parent_event_id).toBe("dr-late");
    expect(at("dr-cx").staff_id).not.toBe(at("dr-v").staff_id);
    expect(at("dr-huge").staff_id).toBe(W.w4); // its worker is excluded from the full-volume stream timing
  });
});

// ---------------------------------------------------------------------------
// The coordinator against a scripted database
// ---------------------------------------------------------------------------

type CFail = Partial<Record<"publisherNot39" | "alreadyApplied" | "activeBatch" | "noMarker" | "collision" | "applyFails" | "definer" | "missingIndex" | "rollbackFails", boolean>>;
function scripted(fail: CFail = {}) {
  const sent: string[] = [];
  const t40 = read(MIGRATION_0040);
  const t41 = read(MIGRATION_0041);
  const b39 = bodyHashes(publishBody(read(M39)))[0];
  const db: Db = {
    query: async (sql: string) => {
      sent.push(sql);
      if (sql === "rollback" && fail.rollbackFails) throw new Error("connection terminated");
      if (sql === FUNCTION_SQL) return { rows: [{ body_md5: fail.publisherNot39 ? "deadbeef" : b39, security_definer: false, config: '{"search_path=\\"\\""}', acl: "{}", service_exec: true, authenticated_exec: false, anon_exec: false, owner: "postgres" }], rowCount: 1 };
      if (sql === CASE_SQL.absent) return { rows: [{ functions: fail.alreadyApplied ? 7 : 0, indexes: 0, active: fail.activeBatch ? 1 : 0, marker: fail.noMarker ? 0 : 1 }], rowCount: 1 };
      if (sql === CASE_SQL.collisions) return { rows: [{ n: fail.collision ? 3 : 0 }], rowCount: 1 };
      if (sql === CASE_SQL.effective) {
        const rows = ["frozen_read_batch", ...READS].sort().map((name) => ({
          name, body_md5: bodyHashes(name === "frozen_read_batch" ? functionBody(t40, "reporting_private.frozen_read_batch") : functionBody(t41, `public.${name}`))[0],
          definer: !!fail.definer && name === "read_reporting_children", config: 'search_path=""', anon: false, authenticated: false, service: true,
        }));
        return { rows, rowCount: rows.length };
      }
      if (sql === CASE_SQL.indexes) return { rows: [{ n: fail.missingIndex ? 3 : 4 }], rowCount: 1 };
      if (/^\s*CREATE (OR REPLACE )?FUNCTION/.test(sql) && fail.applyFails) throw Object.assign(new Error("syntax error"), { code: "42601" });
      return { rows: [], rowCount: 0 };
    },
  };
  return { db, sent };
}
function depCtx(over: Partial<DependencyCtx> = {}): { ctx: DependencyCtx; recorded: Observation[]; emitted: number } {
  const recorded: Observation[] = [];
  const box = { ctx: null as unknown as DependencyCtx, recorded, emitted: 0 };
  box.ctx = { sites: ["uk", "us"], maxPages: 200, staff: W.w1, as: async () => undefined, record: (o) => void recorded.push(o), redact: (s) => s, now: () => 0, emit: () => void box.emitted++, ...over };
  return box;
}
/** Cases that record every required case id (as the real cases would), or a chosen subset. */
const allCases = (ids: readonly string[] = REQUIRED_CASES.filter((x) => !x.startsWith("D"))): DependencyDeps["cases"] => async (_c, ctx) => {
  for (const id of ids) ctx.record({ id, what: id, expected: "x", result: "ok", ok: true, ms: 0 });
};
const deps = (over: Partial<DependencyDeps> = {}): DependencyDeps => ({ read: (p) => readFileSync(p), cases: allCases(), ...over });

describe("T14S1: the rehearsal coordinator", () => {
  it("success: identities -> installed checks -> BEGIN -> 0040 -> 0041 -> effective checks -> cases -> ROLLBACK; never COMMIT; evidence COMPLETE", async () => {
    const s = scripted();
    const t = depCtx();
    const ev = await rehearseDependencyReads(s.db, t.ctx, deps());
    const begin = s.sent.indexOf("begin");
    expect(s.sent.slice(0, begin)).toEqual([FUNCTION_SQL, CASE_SQL.absent, CASE_SQL.collisions]); // everything before BEGIN is a read
    const b40 = migrationBody(read(MIGRATION_0040));
    const b41 = migrationBody(read(MIGRATION_0041));
    expect(s.sent.slice(begin + 1, begin + 1 + 31)).toEqual([...b40, ...b41]); // exactly the two parsed bodies, 0040 first
    expect(s.sent.slice(begin + 32, begin + 34)).toEqual([CASE_SQL.effective, CASE_SQL.indexes]);
    expect(s.sent.at(-1)).toBe("rollback");
    expect(s.sent.some((q) => /^\s*(commit|end)\b/i.test(q))).toBe(false);
    expect(ev.complete).toBe(true);
    expect(ev.statementsApplied).toBe(31);
    expect(ev.files.map((f) => f.path)).toEqual([M37, M38, M39, MIGRATION_0040, MIGRATION_0041]);
    expect(t.recorded.map((o) => o.id).slice(0, 4)).toEqual(["D0", "D1", "D2", "D3"]);
    expect(t.recorded.at(-1)!.id).toBe("D9");
    expect(evidenceProblems(ev)).toEqual([]);
  });

  const before: Array<[string, CFail | null, Partial<DependencyDeps>, RegExp]> = [
    ["the installed publisher is not 0039", { publisherNot39: true }, {}, /D1 failed/],
    ["0040 objects already exist", { alreadyApplied: true }, {}, /D1 failed/],
    ["a reporting batch is active", { activeBatch: true }, {}, /D1 failed/],
    ["the staging marker is missing", { noMarker: true }, {}, /D1 failed/],
    ["dr- fixture ids already exist", { collision: true }, {}, /D1 failed/],
    ["0041 is not the reviewed draft", null, { read: (p) => (p === MIGRATION_0041 ? Buffer.from(read(MIGRATION_0041).replace("1 MiB", "2 MiB")) : readFileSync(p)) }, /D0 failed/],
    ["0040 is not the reviewed draft", null, { read: (p) => (p === MIGRATION_0040 ? Buffer.from(`${read(MIGRATION_0040)}\n`) : readFileSync(p)) }, /D0 failed/],
    ["0038 is not the installed identity", null, { read: (p) => (p === M38 ? Buffer.from(read(M38).replace("Part A", "Part X")) : readFileSync(p)) }, /D0 failed/],
  ];
  for (const [name, fail, dep, re] of before) {
    it(`refuses BEFORE BEGIN when ${name}`, async () => {
      const s = scripted(fail ?? {});
      let ran = false;
      await expect(rehearseDependencyReads(s.db, depCtx().ctx, deps({ cases: async () => void (ran = true), ...dep }))).rejects.toThrow(re);
      expect(s.sent).not.toContain("begin");
      expect(s.sent.some((q) => /CREATE (OR REPLACE )?FUNCTION|CREATE INDEX/.test(q))).toBe(false);
      expect(ran).toBe(false);
    });
  }

  const inside: Array<[string, CFail, Partial<DependencyDeps>, RegExp]> = [
    ["applying the bodies fails", { applyFails: true }, {}, /D2 failed/],
    ["a read is SECURITY DEFINER after applying", { definer: true }, {}, /D3 failed/],
    ["an index is missing after applying", { missingIndex: true }, {}, /D3 failed/],
    ["a case throws an unexpected SQL error", {}, { cases: async () => { throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); } }, /relation does not exist/],
    ["a case RECORDS a failure (and would otherwise continue)", {}, { cases: async (_c, ctx) => { ctx.record({ id: "R4", what: "x", expected: "y", result: "differs", ok: false, ms: 0 }); ctx.record({ id: "R5", what: "x", expected: "y", result: "ok", ok: true, ms: 0 }); } }, /R4 failed/],
    ["evidence is incomplete (a required case was never recorded)", {}, { cases: allCases(REQUIRED_CASES.filter((x) => !x.startsWith("D") && x !== "X7")) }, /not recorded: X7/],
  ];
  for (const [name, fail, dep, re] of inside) {
    it(`stops, ALWAYS rolls back and is never complete when ${name}`, async () => {
      const s = scripted(fail);
      const t = depCtx();
      let last: Record<string, unknown> | null = null;
      t.ctx.emit = (e) => void (last = e as unknown as Record<string, unknown>);
      await expect(rehearseDependencyReads(s.db, t.ctx, deps(dep))).rejects.toThrow(re);
      expect(s.sent).toContain("rollback");
      expect(s.sent.some((q) => /^\s*commit\b/i.test(q))).toBe(false);
      expect(last === null || (last as { complete: boolean }).complete === false).toBe(true);
    });
  }
  it("a recorded failure stops at once: nothing after it is recorded", async () => {
    const s = scripted();
    const t = depCtx();
    await expect(rehearseDependencyReads(s.db, t.ctx, deps({ cases: async (_c, ctx) => { ctx.record({ id: "R2", what: "x", expected: "y", result: "no", ok: false, ms: 0 }); ctx.record({ id: "R3", what: "x", expected: "y", result: "ok", ok: true, ms: 0 }); } }))).rejects.toThrow(/R2 failed/);
    expect(t.recorded.map((o) => o.id)).toEqual(["D0", "D1", "D2", "D3", "R2"]);
  });
  it("a persistence (emit) failure stops and still rolls back", async () => {
    const s = scripted();
    let n = 0;
    const t = depCtx({ emit: () => { if (++n === 3) throw new Error("ENOSPC"); } }); // 1 D0, 2 D1, 3 D3 (inside the transaction)
    await expect(rehearseDependencyReads(s.db, t.ctx, deps())).rejects.toThrow(/D3 failed/);
    expect(s.sent.at(-1)).toBe("rollback");
  });
  it("a rollback failure after an earlier failure is kept BESIDE it", async () => {
    const s = scripted({ applyFails: true, rollbackFails: true });
    await expect(rehearseDependencyReads(s.db, depCtx().ctx, deps())).rejects.toThrow(/^D2 failed; later steps depend on it; cleanup failed: rehearsal rollback: connection terminated$/);
  });
  it("the REAL cases stop at their first unexpected query result and the coordinator rolls back", async () => {
    const s = scripted();
    const db: Db = { query: async (sql: string, p?: unknown[]) => (sql === CASE_SQL.users ? { rows: [{ email: "staff@inka-staging.test", id: W.w1 }], rowCount: 1 } : s.db.query(sql, p)) };
    const t = depCtx();
    await expect(rehearseDependencyReads(db, t.ctx, deps({ cases: runDependencyCases }))).rejects.toThrow(/S0 failed/); // three of the four staging users missing
    expect(s.sent.at(-1)).toBe("rollback");
    expect(t.recorded.at(-1)).toMatchObject({ id: "S0", ok: false });
  });

  for (const [name, dep, change] of [["success", {}, false], ["incomplete evidence", { cases: allCases(["R1"]) }, false], ["an unexpected change", {}, true]] as const) {
    it(`inside the actual lifecycle (${name}): main rolled back and closed, fresh ZERO-change audit, COMPLETE only with complete evidence`, async () => {
      const report = newPublicationReport("rehearse-dependency-reads", ["uk", "us"], "rev", "t0", "sha");
      const st = (x: string): FullState => ({ surfaces: { "function:public.read_reporting_children": x }, privateTables: {}, control: { capture_epoch: "21", capture_enabled: false, rule_version: "r", updated_at: "t" }, siteState: [] });
      const conns: Array<{ s: ReturnType<typeof scripted>; ended: boolean }> = [];
      await runCaptureLifecycle(report, {
        open: async () => { const s = scripted(); const o = { s, ended: false }; conns.push(o); return { query: s.db.query, end: async () => void (o.ended = true) }; },
        body: async (main) => { await rehearseDependencyReads(main as unknown as Db, depCtx({ record: (o) => void report.observations.push(o), emit: (e) => void (report.dependency = e as unknown as Record<string, unknown>) }).ctx, deps(dep as Partial<DependencyDeps>)); },
        audit: async () => compareFullState(st("absent"), st(change ? "present" : "absent"), ROLLBACK_ONLY),
        save: () => undefined, now: () => "t1", redact: (x) => x, stderr: () => undefined,
      });
      expect(conns).toHaveLength(2);
      expect(conns.every((o) => o.ended)).toBe(true);
      expect(conns[0].s.sent.includes("rollback")).toBe(true);
      expect(conns[0].s.sent.some((q) => /^\s*commit\b/i.test(q))).toBe(false);
      if (name === "success") expect(publicationStatus(report)).toBe("STATUS: COMPLETE");
      else expect(publicationStatus(report)).toMatch(/^STATUS: FAILED/);
      if (change) expect(report.restorationProblems.join()).toMatch(/function:public\.read_reporting_children differs/);
    });
  }
});

// ---------------------------------------------------------------------------
// Planner early-review repairs (T14S1 r0) and the due probe
// ---------------------------------------------------------------------------

describe("T14S1 review: changed-key membership comes from FULL raw images", () => {
  const raw = (e: ProductionEvidenceEvent, note: string) => ({ img: { ...e, note, station_id: "s" } });
  const a = ev("a");
  const b = ev("b");
  it("a note-only change is a changed key (reduced images equal)", () => {
    const before = rawView([raw(a, "x"), raw(b, "same")], "uk");
    const after = rawView([raw(a, "y"), raw(b, "same")], "uk");
    expect(expectedChangedKeys(before, after, "2026-03-01T00:00:00.000000Z", "2026-03-01T00:00:00.000000Z")).toEqual([{ id: "a", before: a, after: a }]);
  });
  it("inserts, deletes and due keys are kept; unchanged non-due keys are not; ids sorted bytewise", () => {
    const due = ev("d", { created_at: "2026-03-01T00:00:00.5+00:00" });
    const before = rawView([raw(a, ""), raw(due, "")], "uk");
    const after = rawView([raw(b, ""), raw(due, "")], "uk");
    expect(expectedChangedKeys(before, after, "2026-03-01T00:00:00.000000Z", "2026-03-01T00:00:01.000000Z").map((k) => [k.id, k.before?.id ?? null, k.after?.id ?? null])).toEqual([["a", "a", null], ["b", null, "b"], ["d", "d", "d"]]);
    expect(expectedChangedKeys(before, before, "2026-03-01T00:00:01.000000Z", "2026-03-01T00:00:01.000000Z")).toEqual([]);
  });
  it("rawView refuses a duplicate id and keeps the full raw image", () => {
    expect(() => rawView([raw(a, ""), raw(a, "")], "uk")).toThrow(/twice/);
    expect(rawView([raw(a, "n")], "uk").raw.get("a")).toMatchObject({ note: "n" });
  });
});

describe("T14S1 review: required works are derived independently of the materializer's enumeration", () => {
  const cut = "2026-03-01T00:00:00.000000Z";
  const v = ev("v", { order_number: "O-V", event_type: "line_verified", line_sku: "INKA-KAN0566-A4-FB", line_quantity: 1 });
  const orph = ev("orph", { order_number: "   ", event_type: "cancelled", staff_id: W.w2, parent_event_id: "late", created_at: "2026-02-10T09:00:00+00:00" });
  const late = ev("late", { order_number: "O-L", event_type: "line_verified", line_sku: "INKA-KAN0566-A4-FB", line_quantity: 1, created_at: "2026-02-10T08:50:00+00:00" });
  it("a late parent's arrival requires the new owner and the orphan cancellation's event owner (site)", () => {
    const req = requiredWorks("uk", { view: [v, orph], cutoff: cut }, { view: [v, orph, late], cutoff: cut }, [W.w1, W.w2]);
    expect(req.has("site||order\u0000O-L")).toBe(true);
    expect(req.has("site||event\u0000orph")).toBe(true);
    expect(req.has("site||order\u0000O-V")).toBe(false); // unchanged
  });
  it("missing on BOTH paths fails (the materializer agreeing with itself is not enough)", () => {
    const w = (aud: string, key: string): MaterializedWork => ({ desc: { audienceKind: aud === "site" ? "site" : "self", audienceStaff: aud === "site" ? null : aud, partitionKind: "order", partitionKey: key, inputHash: "h" }, rows: { event_facts: [], cancel_edges: [], order_occurrences: [], timing_facts: [], source_issue_facts: [] }, inputRows: 0 });
    const req = ["site||order\u0000O-L", `self|${W.w1}|order\u0000O-L`];
    expect(missingRequired(req, [w("site", "O-L"), w(W.w1, "O-L")], [w("site", "O-L"), w(W.w1, "O-L")])).toEqual([]);
    expect(missingRequired(req, [w("site", "O-L")], [w("site", "O-L")])).toEqual([`required work self|${W.w1}|order\u0000O-L is missing from the RPC path`, `required work self|${W.w1}|order\u0000O-L is missing from the in-memory path`]);
    expect(missingRequired(req, [w("site", "O-L"), w(W.w1, "O-L")], [w("site", "O-L")]).join()).toMatch(/in-memory path/);
  });
  it("with no before view every non-empty owner is required (rebuild)", () => {
    expect([...requiredWorks("uk", null, { view: [v], cutoff: cut }, [W.w1])].sort()).toEqual([`self|${W.w1}|order\u0000O-V`, "site||order\u0000O-V"]);
  });
});

describe("T14S1 review: case structure (fingerprints, anchors, due probe)", () => {
  const src = read("tests/staging/reportingDependencyRehearsal.ts");
  const body = src.slice(src.indexOf("export async function runDependencyCases"), src.indexOf("// Coordinator"));
  const at = (s: string) => {
    const i = body.indexOf(s);
    expect(i, s).toBeGreaterThan(0);
    return i;
  };
  it("the rebuild fingerprint is taken before the first successful read (R2) and checked right after R9 and after T2", () => {
    expect(at("const before1 = await fp(rb.batchId);")).toBeLessThan(at('"R2"'));
    expect(at('"R9"')).toBeLessThan(at('"X8"'));
    expect(at('"X8"')).toBeLessThan(at('"X1"'));
    expect(at('"T2"')).toBeLessThan(at('"X8t"'));
  });
  it("the refresh fingerprint is taken before F1 and checked right after F3 (before F4); the check itself performs no read", () => {
    expect(at('"F0"')).toBeLessThan(at("const before2 = await fp(rf.batchId);"));
    expect(at("const before2 = await fp(rf.batchId);")).toBeLessThan(at('"F1"'));
    expect(at('"F3"')).toBeLessThan(at('"X9"'));
    expect(at('"X9"')).toBeLessThan(at('"F4"'));
    expect(body.slice(at('"X9"'), at('"F4"'))).not.toMatch(/drain\(|rreader\./);
  });
  it("R7s is anchored immediately before dr-huge (its exact instant, the smallest id, limit 1)", () => {
    expect(body.slice(at('"R7s"'), at("const oracle1"))).toContain('p_staff: w.w4, p_direction: "after", p_at: hugeAt, p_at_event_id: "", p_limit: 1 }');
  });
  it("membership of the expected refresh diff is raw (expectedChangedKeys), and both F1 and F3 use it", () => {
    expect(body).toContain("const changed = expectedChangedKeys(rv1, rv2, rb.cutoff, rf.cutoff);");
    expect(body).not.toContain("diffFrozenViews(");
    expect(body).toContain('memoryFrozenReader({ site: A, cutoff: rf.cutoff, kind: "refresh", view: view2, changed })');
  });
  it("byte-cap evidence uses cappedContinuations for owners, members, by id, children, streams and changed keys", () => {
    for (const fn of READS) expect(body).toContain(`capped("${fn}"`);
    expect(body).not.toMatch(/shortPages|nonEmptyUnderLimit/);
  });
  it("the due probe: dr-due inserted in S1 (before R0); savepoint after T2/X8t and before P0; restored and checked (U3) before P0", () => {
    expect(at("CASE_SQL.insertDue")).toBeLessThan(at('"R0"'));
    expect(at('"X8t"')).toBeLessThan(at('await c.query("savepoint dr_due");'));
    expect(at('"U1"')).toBeLessThan(at('"U2"'));
    expect(at('await c.query("rollback to savepoint dr_due");')).toBeLessThan(at('"U3"'));
    expect(at('"U3"')).toBeLessThan(at('"P0"'));
    expect(body.slice(at('"U1"'), at('"U3"'))).not.toMatch(/production_events|insertDependencyFixtures|touchHuge|padHuge/); // no source edit in the probe
  });
  it("the due SQL changes ONLY source_cutoff of a still-frozen, unsealed rebuild; dr-due is 500 ms before the transaction timestamp", () => {
    expect(CASE_SQL.dueCutoff).toBe("update reporting_private.batches set source_cutoff = pg_catalog.transaction_timestamp() - interval '1 second' where batch_id = $1::uuid and kind = 'rebuild' and state = 'frozen' and sealed_at is null");
    expect(CASE_SQL.insertDue).toMatch(/'dr-due'.*pg_catalog\.transaction_timestamp\(\) - interval '500 milliseconds'/);
    expect(CASE_SQL.dueWindow).toContain("b.source_cutoff < pe.created_at and pe.created_at <= r.source_cutoff");
    expect(CASE_SQL.duePending).toContain("reporting_private.site_pending_changes($1)");
  });
  it("cutoffs are read as exact microsecond UTC text (no JavaScript Date rounding)", () => {
    expect(CASE_SQL.batch).toContain(`pg_catalog.to_char(b.source_cutoff at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cutoff`);
  });
});

// ---------------------------------------------------------------------------
// T14S2: deterministic anchored owner byte-cap probe
// ---------------------------------------------------------------------------

/** list_reporting_owners as 0041 accounts it: brackets (2) + per row jsonb text + 1; a row that alone cannot fit raises; otherwise the page ends short. */
function ownerDb(keys: readonly string[]) {
  const owners = [...keys].map((k) => ({ partition_kind: "order", partition_key: k })).sort((a, b) => compareUtf8(`${a.partition_kind}\u0000${a.partition_key}`, `${b.partition_kind}\u0000${b.partition_key}`));
  const rowBytes = (r: { partition_kind: string; partition_key: string }) => Buffer.byteLength(`{"partition_key": ${JSON.stringify(r.partition_key)}, "partition_kind": ${JSON.stringify(r.partition_kind)}}`) + 1;
  return aggDb((fn, p) => {
    expect(fn).toBe("list_reporting_owners");
    const [afterKind, afterKey, limit] = [p[2] as string | null, p[3] as string | null, p[4] as number];
    const after = afterKind === null ? null : `${afterKind}\u0000${afterKey}`;
    const out: typeof owners = [];
    let bytes = 2;
    for (const r of owners) {
      if (after !== null && compareUtf8(`${r.partition_kind}\u0000${r.partition_key}`, after) <= 0) continue;
      if (out.length >= limit) break;
      const b = rowBytes(r);
      if (bytes + b > MIB) {
        if (!out.length) throw new Error(`one response row (owner ${r.partition_key.slice(0, 64)}) is larger than 1 MiB`);
        break;
      }
      bytes += b;
      out.push(r);
    }
    return out;
  });
}
const LONG = dependencyFixtures(W).a.filter((x) => String(x.order_number).startsWith("DRK-")).map((x) => String(x.order_number));
/** 600 pre-existing short owners before the long group and a few after it: the real staging shape that defeated R2's old assertion. */
const SHORT_BEFORE = Array.from({ length: 600 }, (_, i) => `A-${String(i).padStart(5, "0")}`);
const SHORT_AFTER = Array.from({ length: 50 }, (_, i) => `Z-${String(i).padStart(5, "0")}`);
const asOwners = (keys: readonly string[]): Owner[] => [...keys].map((k) => ({ partitionKind: "order" as const, partitionKey: k })).sort((a, b) => compareUtf8(ownerKey(a), ownerKey(b)));
const REF = { p_batch: BATCH, p_fence: 1 };

describe("T14S2: the owner byte cap is proven by an anchored probe, not by where ordinary pages fall", () => {
  const all = [...SHORT_BEFORE, ...LONG, ...SHORT_AFTER];
  const expected = asOwners(all);
  it("regression (staging shape): complete enumeration is exact, but its ordinary 1,000-row pages straddle the long keys and NO byte-capped page occurs, so the old R2 assertion fails", async () => {
    const stats = newRpcStats();
    const { db } = ownerDb(all);
    const reader = rpcFrozenReader(sqlRpcClient(db, async () => undefined, stats, () => 0), { batchId: BATCH, fence: 1, site: "uk", cutoff: "2026-03-01T00:00:00.000000Z", kind: "rebuild" });
    const got: Owner[] = [];
    for await (const o of reader.owners()) got.push(o);
    expect(got).toEqual(expected);
    expect(stats.list_reporting_owners.cappedContinuations).toBe(0); // the old assertion's input: it would report "no byte-capped non-final owner page"
    expect(stats.list_reporting_owners.maxCompactBytes).toBeLessThan(MIB);
  });
  it("the anchored probe through the actual adapter forces a byte cutoff and an exact non-empty continuation covering all 1,000 long keys", async () => {
    const stats = newRpcStats();
    const { db, sent } = ownerDb(all);
    const client = sqlRpcClient(db, async () => undefined, stats, () => 0);
    const call = async (fn: string, args: Record<string, unknown>) => (await client.rpc(fn, args)).data as Array<Record<string, unknown>>;
    const { page1, page2 } = await runOwnerByteProbe(call, REF);
    const r = checkOwnerByteProbe(expected, LONG, page1, page2);
    expect(r.problems).toEqual([]);
    expect(page1.length).toBeGreaterThan(0);
    expect(page1.length).toBeLessThan(1000);
    expect(page1.length + page2.length).toBeGreaterThanOrEqual(1000);
    expect(r.evidence.uncappedCompactBytes).toBeGreaterThan(MIB);
    expect(r.evidence.pages.every((x) => x.compactBytes <= MIB)).toBe(true);
    expect(r.evidence.longKeysCovered).toBe(1000);
    expect(stats.list_reporting_owners.cappedContinuations).toBe(1); // the existing owner cap check now has deterministic evidence
    expect(sent).toHaveLength(2);
    expect(OWNER_PROBE_ANCHOR).toEqual({ kind: "order", key: "DRK-" });
  });
  it("runOwnerByteProbe sends exactly the anchored call (limit 1,000) and then the continuation from the last returned key", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const pages = [[{ partition_kind: "order", partition_key: "DRK-1" }, { partition_kind: "order", partition_key: "DRK-2" }], [{ partition_kind: "order", partition_key: "DRK-3" }]];
    await runOwnerByteProbe(async (fn, args) => (expect(fn).toBe("list_reporting_owners"), calls.push(args), pages.shift()!), REF);
    expect(calls).toEqual([{ ...REF, p_after_kind: "order", p_after_key: "DRK-", p_limit: 1000 }, { ...REF, p_after_kind: "order", p_after_key: "DRK-2", p_limit: 1000 }]);
    const none: Array<Record<string, unknown>> = [];
    expect(await runOwnerByteProbe(async (_f, a) => (none.push(a), []), REF)).toEqual({ page1: [], page2: [] });
    expect(none).toHaveLength(1); // no continuation after an empty first page
  });

  describe("checkOwnerByteProbe catches every wrong outcome", () => {
    const rows = (os: readonly Owner[]) => os.map((o) => ({ partition_kind: o.partitionKind, partition_key: o.partitionKey }));
    const suffix = expected.filter((o) => compareUtf8(ownerKey(o), `order\u0000DRK-`) > 0);
    const good1 = rows(suffix.slice(0, 800)); // ~800 x 1.2 KB keys: under 1 MiB, short of 1,000
    const good2 = rows(suffix.slice(800, 1050));
    it("accepts the exact capped page and continuation", () => expect(checkOwnerByteProbe(expected, LONG, good1, good2).problems).toEqual([]));
    const cases: Array<[string, () => [Array<{ partition_kind: string; partition_key: string }>, Array<{ partition_kind: string; partition_key: string }>], RegExp]> = [
      ["a truncated continuation (not all 1,000 long keys)", () => [good1, good2.slice(0, 100)], /hold 900 of the 1000 long-key owners/],
      ["an owner missing from the first page", () => [[...good1.slice(0, 10), ...good1.slice(11)], good2], /position 10 \(first page\)/],
      ["a repeated owner at the continuation", () => [good1, [good1[good1.length - 1], ...good2]], /returned twice/],
      ["a wrong continuation (skips ahead)", () => [good1, good2.slice(5)], /position 800 \(continuation\)/],
      ["an incorrectly FULL first page", () => [rows(suffix.slice(0, 1000)), rows(suffix.slice(1000, 1050))], /first owner page is full \(1000 rows\)/],
      ["an empty continuation", () => [good1, []], /continuation after the byte-capped owner page is empty/],
      ["an empty first page", () => [[], good2], /anchored first owner page is empty/],
      ["a first page that starts before the anchor", () => [[{ partition_kind: "order", partition_key: "A-00599" }, ...good1], good2], /position 0 \(first page\)/],
    ];
    for (const [name, make, re] of cases) it(`rejects ${name}`, () => { const [a, b] = make(); expect(checkOwnerByteProbe(expected, LONG, a, b).problems.join("; ")).toMatch(re); });
    it("rejects an unexpected owner interleaved in the long-key prefix (never assumed away)", () => {
      const withIntruder = asOwners([...all, "DRK-0000-a"]); // a real key sorting inside the fixture group
      expect(checkOwnerByteProbe(withIntruder, LONG, good1, good2).problems.join("; ")).toMatch(/does not begin with the 1000 long-key fixture owners \(first difference at 0/);
    });
    it("rejects a fixture whose requested page would NOT exceed 1 MiB", () => {
      const short = Array.from({ length: 1000 }, (_, i) => `DRK-${String(i).padStart(4, "0")}`);
      const ex = asOwners([...SHORT_BEFORE, ...short]);
      const sfx = ex.filter((o) => o.partitionKey.startsWith("DRK-"));
      expect(checkOwnerByteProbe(ex, short, rows(sfx.slice(0, 500)), rows(sfx.slice(500))).problems.join("; ")).toMatch(/the probe needs more than 1 MiB/);
    });
    it("rejects a page over 1 MiB", () => {
      const huge = [{ partition_kind: "order", partition_key: "x".repeat(MIB) }];
      expect(checkOwnerByteProbe(expected, LONG, good1, huge).problems.join("; ")).toMatch(/exceeds 1 MiB/);
    });
  });

  it("R2 keeps only complete enumeration parity; R2c (required, before R3) holds the anchored probe and the existing owner cap check", () => {
    const src = read("tests/staging/reportingDependencyRehearsal.ts");
    const body = src.slice(src.indexOf("export async function runDependencyCases"), src.indexOf("// Coordinator"));
    const r2 = body.slice(body.indexOf('"R2", "list_reporting_owners'), body.indexOf('"R2c"'));
    expect(r2).toContain("await drain(reader.owners())");
    expect(r2).toContain("canonicalJson(got) !== canonicalJson(ownersExpected)");
    expect(r2).toContain('o.partitionKey.startsWith("DRK-")).length !== 1000');
    expect(r2).not.toContain("capped(");
    const r2c = body.slice(body.indexOf('"R2c"'), body.indexOf("const controlled"));
    expect(r2c).toContain("runOwnerByteProbe(call, { p_batch: rb.batchId, p_fence: rb.fence })");
    expect(r2c).toContain("checkOwnerByteProbe(ownersExpected, longKeys, page1, page2)");
    expect(r2c).toContain('capped("list_reporting_owners", "owner", p)');
    expect(body.indexOf('"R2c"')).toBeLessThan(body.indexOf('"R3"'));
    expect(REQUIRED_CASES).toContain("R2c");
    expect(LONG).toHaveLength(1000);
  });
});
