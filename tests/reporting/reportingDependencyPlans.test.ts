/**
 * T14S3: the prepared (NOT run) bounded access-path diagnostic, without a
 * database: wiring, exact extracted SELECTs and the split-owner alternative,
 * the EXPLAIN ANALYZE allowlist, the fixed case matrix, parity sensitivity,
 * plan summaries, and the coordinator end to end over a scripted database.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareStream } from "../../api/_lib/production-reporting-materialize";
import { runCaptureLifecycle } from "../staging/reportingCapture";
import {
  comparePages, DIAG_PREFIX, diagnoseDependencyPlans, diagnosticStatements, EXPLAIN_CASES, expectedMembers, expectedStreamCount, explainAllowlist, MAX_EXPLAINS, memberPage, newPlanEvidence, OR_CANDIDATE, OR_MIRROR,
  PLAN_SQL, planEvidenceProblems, REQUIRED_PLAN_CASES, runPlanCases, smallLimit, SPLIT_CANDIDATE, SPLIT_MIRROR, splitMembersSql, summarizePlan, type MemberRow, type PlanCtx, type PlanDeps, type PlanEvidence,
  ACCESS_FUNCTIONS, ACCESS_NAMES, accessAcceptanceProblems, accessAllowlist, accessBodyProblems, accessStatements, COLLATION_INVARIANT_SQL, diagnoseAccessPaths, MIGRATION_0042, ownerKeyProblems, relationReads, REQUIRED_ACCESS_CASES, REVIEWED_0042_LF,
} from "../staging/reportingDependencyPlans";
import { fileIdentity } from "../staging/reportingRebuildRepair";
import { boundReadQuery, CASE_SQL, dependencyGuard, effectiveReadQuery, executesExplain, planSql, stripSqlComments, functionBody, MIGRATION_0040, MIGRATION_0041, rawView } from "../staging/reportingDependencyRehearsal";
import { accessAcceptanceLines, compareFullState, migrationBody, newPublicationReport, parsePublicationArgs, publicationMarkdown, publicationStatus, ROLLBACK_ONLY, type Db, type FullState, type Observation } from "../staging/reportingPublication";
import { bodyHashes, FUNCTION_SQL, publishBody } from "../staging/reportingRebuildRepair";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const T41 = read(MIGRATION_0041);
const ST = diagnosticStatements(T41);
const T42 = read(MIGRATION_0042);
const AS = accessStatements(T41, T42);
const B42 = migrationBody(T42);
const S = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe("T14S3: argument and dispatch wiring", () => {
  it("--diagnose-dependency-plans takes exactly --sites=A,B (and --max-pages)", () => {
    expect(parsePublicationArgs(["--diagnose-dependency-plans", "--sites=uk,us"])).toMatchObject({ mode: "diagnose-dependency-plans", sites: ["uk", "us"], problems: [] });
    for (const argv of [["--diagnose-dependency-plans", "--site=uk"], ["--diagnose-dependency-plans", "--sites=uk,uk"], ["--diagnose-dependency-plans", "--rehearse-dependency-reads", "--sites=uk,us"], ["--diagnose-dependency-plans", "--sites=uk,us", "--analyze"]]) expect(parsePublicationArgs(argv).mode).toBeNull();
  });
  it("the runner dispatches it inside the guarded lifecycle (baseline first, ROLLBACK_ONLY audit); main() and usage know the flag", () => {
    const runner = read("tests/staging/reporting-jobs.ts");
    const pub = runner.slice(runner.indexOf("async function publicationMain"), runner.indexOf("async function main()"));
    expect(pub.indexOf("before = await fullState(main);")).toBeLessThan(pub.indexOf('if (mode === "diagnose-dependency-plans") {'));
    expect(pub).toMatch(/await diagnoseDependencyPlans\(main, \{ sites, maxPages, staff, as, record, redact: redactSecrets, now: \(\) => performance\.now\(\), emit: \(ev\) => \{ report\.dependencyPlans = ev as unknown as Record<string, unknown>; save\(\); \} \}\);\n\s+return;/);
    expect(pub).toMatch(/const allow = mode === "committed-interleavings" && own \? committedAllowance\(own\) : ROLLBACK_ONLY;/);
    expect(pub).toContain('const out = `staging-results-reporting-publication-${mode}-'); // unique per run; never overwrites the earlier reports
    const main = runner.slice(runner.indexOf("async function main()"));
    expect(main).toMatch(/f === "--diagnose-dependency-plans"( \|\| f === "--diagnose-access-paths")?\)\) return publicationMain\(flags\);/); // + the 0042 follow-up flag
    expect(main).toContain("--diagnose-dependency-plans --sites=A,B [--max-pages=N]");
  });
  it("is never COMPLETE without complete plan evidence; other modes unchanged", () => {
    const r = newPublicationReport("diagnose-dependency-plans", ["uk", "us"], "rev", "t0", "sha");
    Object.assign(r, { finishedAt: "t1", restorationVerified: true, observations: [{ id: "D0", what: "x", expected: "y", result: "ok", ok: true, ms: 0 }] });
    expect(publicationStatus(r)).toBe("STATUS: FAILED – dependency-plan evidence is missing or incomplete");
    r.dependencyPlans = { ...newPlanEvidence(), complete: true };
    expect(publicationStatus(r)).toBe("STATUS: COMPLETE");
    const d = newPublicationReport("rehearse-dependency-reads", ["uk", "us"], "rev", "t0", "sha");
    Object.assign(d, { finishedAt: "t1", restorationVerified: true, observations: r.observations, dependency: { complete: true } });
    expect(publicationStatus(d)).toBe("STATUS: COMPLETE");
  });
  it("the strict API typecheck includes the diagnostic module and this test", () => {
    const s = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts["typecheck:digest"];
    expect(s).toContain("tests/staging/reportingDependencyPlans.ts");
    expect(s).toContain("tests/reporting/reportingDependencyPlans.test.ts");
  });
});

// ---------------------------------------------------------------------------
// Exact statements
// ---------------------------------------------------------------------------

describe("T14S3: exact extracted SELECTs and the ONE split-owner alternative", () => {
  it("the original member and stream statements are the bound 0041 SELECTs (un-binding gives back the migration text)", () => {
    expect(ST["members-original"]).toBe(boundReadQuery(T41, "read_reporting_owner_members"));
    expect(ST.stream).toBe(boundReadQuery(T41, "read_reporting_staff_stream"));
    const names = ["b.batch_id", "b.site", "b.kind", "p_owners", "p_after_index", "p_after_event_id", "p_limit"];
    expect(ST["members-original"].replace(/\$(\d+)::[a-z]+/g, (_, n) => names[Number(n) - 1])).toBe(effectiveReadQuery(T41, "read_reporting_owner_members"));
  });
  it("the split differs from the original ONLY in its two OR joins (each replaced once; reversing gives the original exactly)", () => {
    const split = splitMembersSql(T41);
    expect(split).not.toBe(ST["members-original"]);
    expect(split.replace(SPLIT_MIRROR, OR_MIRROR).replace(SPLIT_CANDIDATE, OR_CANDIDATE)).toBe(ST["members-original"]);
    expect(split).not.toMatch(/OR \(o\.kind/);
    expect(ST["members-original"].match(/OR \(o\.kind/g)).toHaveLength(2);
    expect(split.match(/UNION ALL/g)!.length).toBe(ST["members-original"].match(/UNION ALL/g)!.length + 2);
    for (const q of [split, ST["members-original"]]) expect([...new Set([...q.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it("the split keeps equality semantics, ordinality, overlay/tombstone rules, outer cursor, order and limit; no COLLATE rewrite or index", () => {
    const split = splitMembersSql(T41);
    for (const branch of [SPLIT_MIRROR, SPLIT_CANDIDATE]) {
      expect(branch).toMatch(/order_key = o\.key\n/);
      expect(branch).toMatch(/event_id = o\.key AND coalesce\(s?c?\.?order_key, ''\) = ''/);
      expect(branch).not.toMatch(/COLLATE/);
    }
    expect(SPLIT_MIRROR.match(/NOT EXISTS \(SELECT 1 FROM reporting_private\.batch_events be WHERE be\.batch_id = \$1::uuid AND be\.site = \$2::text AND be\.event_id = s\.event_id\)/g)).toHaveLength(2);
    expect(split).toContain("WITH ORDINALITY AS x(v, ord)");
    expect(split).toContain('ORDER BY m.idx, m.event_id COLLATE "C"');
    expect(split.trimEnd().endsWith("LIMIT $7::integer")).toBe(true);
    expect(split).toContain("CROSS JOIN LATERAL reporting_private.owner_partition(be.image) op"); // the batch overlay branch is unchanged
    expect(split).not.toMatch(/\bCREATE\b|\bINDEX\b|\bSET\b/);
  });
  it("refuses a 0041 text whose OR joins changed (no silent alternative)", () => {
    expect(() => splitMembersSql(T41.replace("(o.kind = 'event' AND sc.event_id = o.key", "(o.kind = 'event' AND sc.event_id = o.key "))).toThrow(/exactly the two expected OR joins/);
  });
});

// ---------------------------------------------------------------------------
// Allowlist / guard
// ---------------------------------------------------------------------------

describe("T14S3: EXPLAIN ANALYZE only for the exact allowlisted diagnostic SELECTs", () => {
  const body = [...migrationBody(read(MIGRATION_0040)), ...migrationBody(T41)];
  const allow = explainAllowlist(T41);
  const raw = () => {
    const sent: string[] = [];
    return { sent, db: { query: async (q: string) => (sent.push(q), { rows: [], rowCount: 0 }) } as Db };
  };
  it("the allowlist is exactly the three statements with the diagnostic prefix (BUFFERS, SETTINGS, TIMING OFF)", () => {
    expect([...allow].sort()).toEqual([DIAG_PREFIX + ST["members-original"], DIAG_PREFIX + ST["members-split"], DIAG_PREFIX + ST.stream].sort());
    expect(DIAG_PREFIX).toBe("EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON, TIMING OFF) ");
  });
  it("lets through the three allowlisted statements and their plain SELECTs", async () => {
    const r = raw();
    const g = dependencyGuard(r.db, new Set(body), [], allow);
    for (const q of [...allow, ST["members-original"], ST["members-split"], ST.stream]) await g.query(q);
    expect(r.sent).toHaveLength(6);
  });
  const forbidden = [
    `EXPLAIN (ANALYZE) INSERT INTO public.production_events (id) VALUES ('x')`, `EXPLAIN (ANALYZE, BUFFERS) UPDATE reporting_private.batches SET state = 'failed'`, `EXPLAIN (ANALYZE, FORMAT JSON) DELETE FROM reporting_private.source_candidate`,
    "analyze reporting_private.source_candidate", "ANALYZE", "vacuum reporting_private.source_candidate", `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON, TIMING OFF) select 1`,
    `EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON) ${ST["members-original"]}`, DIAG_PREFIX + ST["members-original"].replace("LIMIT", "LIMIT  "), DIAG_PREFIX + ST.stream + ";", `${DIAG_PREFIX}SELECT * FROM public.read_reporting_staff_stream($1, $2, $3, $4, $5, $6, $7)`,
    "set enable_seqscan = off", "set local statement_timeout = 0", "select set_config('enable_nestloop', 'off', true)", "set random_page_cost = 1", "create index x on reporting_private.source_candidate (order_key)",
  ];
  for (const sql of forbidden) {
    it(`refuses before sending: ${sql.slice(0, 70)}`, async () => {
      const r = raw();
      await expect(dependencyGuard(r.db, new Set(body), [], allow).query(sql)).rejects.toThrow(/dependency-read rehearsal refuses/);
      expect(r.sent).toEqual([]);
    });
  }
  it("the existing rehearsal (no allowlist) still cannot execute EXPLAIN ANALYZE, even of a diagnostic statement", async () => {
    const r = raw();
    for (const q of allow) await expect(dependencyGuard(r.db, new Set(body)).query(q)).rejects.toThrow(/refuses/);
    expect(r.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fixed matrix, pagination, comparisons, summaries
// ---------------------------------------------------------------------------

describe("T14S3: fixed case matrix and evidence", () => {
  it("20 explained executions (at most 24): rebuild and refresh x members original/split first/later/normal + streams before/after first/later", () => {
    expect(EXPLAIN_CASES).toHaveLength(20);
    expect(EXPLAIN_CASES.length).toBeLessThanOrEqual(MAX_EXPLAINS);
    expect(MAX_EXPLAINS).toBe(24);
    for (const id of ["D0", "D1", "D2", "D3", "R0", "R1", "M-rb-small", "M-rb-normal", "C-rb-stream", "P0", "F0", "M-rf-small", "M-rf-normal", "C-rf-stream", "D9"]) expect(REQUIRED_PLAN_CASES).toContain(id);
    for (const id of EXPLAIN_CASES) expect(REQUIRED_PLAN_CASES).toContain(id);
  });
  it("planEvidenceProblems: missing case, missing probe or a wrong explain count is never complete", () => {
    const ev = newPlanEvidence();
    ev.recorded = [...REQUIRED_PLAN_CASES];
    ev.explains = 20;
    for (const id of EXPLAIN_CASES) ev.probes[id] = {} as PlanEvidence["probes"][string];
    expect(planEvidenceProblems(ev)).toEqual([]);
    expect(planEvidenceProblems({ ...ev, recorded: ev.recorded.filter((x) => x !== "M-rf-small") }).join()).toMatch(/not recorded: M-rf-small/);
    const { "E-rf-sb-2": _gone, ...rest } = ev.probes;
    void _gone;
    expect(planEvidenceProblems({ ...ev, probes: rest }).join()).toMatch(/plan evidence is missing for: E-rf-sb-2/);
    expect(planEvidenceProblems({ ...ev, explains: 21 }).join()).toMatch(/21 explained executions, expected exactly 20/);
    expect(ev.label).toMatch(/not acceptable performance/);
    expect(ev.label).toMatch(/not an approved fix/);
  });
  it("smallLimit makes the later page genuinely non-empty; fewer than 2 members is refused", () => {
    for (let n = 2; n <= 12; n++) {
      const all: MemberRow[] = Array.from({ length: n }, (_, i) => ({ idx: 0, event_id: `e${String(i).padStart(2, "0")}`, img: {} }));
      const L = smallLimit(n);
      const p1 = memberPage(all, null, L);
      const p2 = memberPage(all, { idx: 0, id: p1[p1.length - 1].event_id }, L);
      expect(p1.length).toBe(L);
      expect(p2.length).toBeGreaterThan(0);
    }
    expect(() => smallLimit(1)).toThrow(/at least 2/);
  });
  it("expectedMembers keeps owner ordinality and bytewise ids; an event owner only for its blank-order event; absent rows (tombstones) are not members", () => {
    const img = (id: string, order: string | null) => ({ img: { id, location: "uk", event_type: "started", created_at: "2026-02-10T08:00:00+00:00", order_number: order, staff_id: S } });
    const v = rawView([img("b", "O-1"), img("a", "O-1"), img("e1", "   "), img("e2", "O-2"), img("\u{1F600}", "O-1")], "uk");
    const got = expectedMembers(v, [{ partitionKind: "event", partitionKey: "e1" }, { partitionKind: "order", partitionKey: "O-1" }]);
    expect(got.map((r) => [r.idx, r.event_id])).toEqual([[0, "e1"], [1, "a"], [1, "b"], [1, "\u{1F600}"]]);
  });
  describe("comparePages catches missing, duplicate, reordered, extra and wrong-image rows", () => {
    const want: MemberRow[] = [{ idx: 0, event_id: "a", img: { n: 1 } }, { idx: 0, event_id: "b", img: { n: 2 } }, { idx: 1, event_id: "c", img: { n: 3 } }];
    const row = (r: MemberRow, img: unknown = r.img) => ({ idx: r.idx, event_id: r.event_id, image: img });
    it("accepts the exact page", () => expect(comparePages("x", want, want.map((r) => row(r)))).toEqual([]));
    it("missing", () => expect(comparePages("x", want, [row(want[0]), row(want[2])]).join()).toMatch(/2 rows, expected 3/));
    it("duplicate", () => expect(comparePages("x", want, [row(want[0]), row(want[0]), row(want[2])]).join()).toMatch(/returned twice/));
    it("reordered", () => expect(comparePages("x", want, [row(want[1]), row(want[0]), row(want[2])]).join()).toMatch(/position 0/));
    it("extra", () => expect(comparePages("x", want, [...want.map((r) => row(r)), { idx: 1, event_id: "d", image: {} }]).join()).toMatch(/4 rows, expected 3/));
    it("incorrect overlay image", () => expect(comparePages("x", want, [row(want[0]), row(want[1], { n: 9 }), row(want[2])]).join()).toMatch(/"b" image differs/));
    it("wrong owner index", () => expect(comparePages("x", want, [row(want[0]), row(want[1]), { ...row(want[2]), idx: 0 }]).join()).toMatch(/position 2/));
  });
  it("summarizePlan keeps scans, conditions, actual/estimated rows, loops, removed rows, sort, buffers and server times; never Output; bounded", () => {
    const plan = [{ Plan: { "Node Type": "Limit", "Plan Rows": 1, "Actual Rows": 3, "Actual Loops": 1, Output: ["m.image"], Plans: [{ "Node Type": "Sort", "Sort Key": ["m.idx"], "Sort Method": "quicksort", "Sort Space Used": 25, "Actual Rows": 3, Plans: [{ "Node Type": "Index Scan", "Index Name": "source_candidate_pkey", "Relation Name": "source_candidate", "Index Cond": "(batch_id = $1)", "Join Filter": "(...)", "Rows Removed by Join Filter": 43387, "Plan Rows": 1, "Actual Rows": 3, "Actual Loops": 2, "Shared Hit Blocks": 900, "Shared Read Blocks": 12, Output: ["sc.image"] }] }] }, "Planning Time": 0.4, "Execution Time": 88.1, Settings: { work_mem: "4MB" } }];
    const s = summarizePlan(plan);
    expect(s).toMatchObject({ planningMs: 0.4, executionMs: 88.1, rootRows: 3, settings: { work_mem: "4MB" }, truncated: false });
    expect(s.nodes[2]).toMatchObject({ depth: 2, "Index Name": "source_candidate_pkey", "Rows Removed by Join Filter": 43387, "Actual Loops": 2, "Shared Read Blocks": 12, "Plan Rows": 1 });
    expect(s.nodes[1]).toMatchObject({ "Sort Method": "quicksort" });
    expect(JSON.stringify(s)).not.toContain("Output");
    const deep: Record<string, unknown> = { "Node Type": "Result" };
    let n = deep;
    for (let i = 0; i < 100; i++) { const k = { "Node Type": "Result" }; n.Plans = [k]; n = k; }
    const t = summarizePlan([{ Plan: deep }]);
    expect(t.nodes).toHaveLength(80);
    expect(t.truncated).toBe(true);
    expect(() => summarizePlan([])).toThrow(/no JSON plan/);
  });
  it("expectedStreamCount uses the exact instant and bytewise id, away from the cursor, capped at the limit", () => {
    const img = (id: string, at: string, s = S) => ({ img: { id, location: "uk", event_type: "started", created_at: at, order_number: "O", staff_id: s } });
    const v = rawView([img("a", "2026-02-10T08:00:00+00:00"), img("b", "2026-02-10T08:00:00+00:00"), img("c", "2026-02-10T08:00:00.000001+00:00"), img("d", "2026-02-10T09:00:00+00:00", S2)], "uk");
    expect(expectedStreamCount(v, S, "after", { at: "2026-02-10T08:00:00Z", id: "a" }, 1000)).toBe(2);
    expect(expectedStreamCount(v, S, "before", { at: "2026-02-10T08:00:00.000001Z", id: "c" }, 1000)).toBe(2);
    expect(expectedStreamCount(v, S, "after", { at: "2000-01-01T00:00:00Z", id: "" }, 1)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// End to end over a scripted database
// ---------------------------------------------------------------------------

type Img = Record<string, unknown> & { id: string; location: string; order_number: string | null; staff_id: string | null; created_at: string };
type Fail = Partial<Record<"splitFirstDrop" | "splitReordered" | "explainRows" | "rollbackFails" | "alreadyApplied" | "candidateDiffers" | "streamShort" | "stale42" | "unkeyed42" | "collation", boolean>>;
function scriptedDb(fail: Fail = {}) {
  const sent: string[] = [];
  const t40 = read(MIGRATION_0040);
  const b39 = bodyHashes(publishBody(read("supabase/migrations/0039_reporting_rebuild_insert.sql")))[0];
  const src = new Map<string, Img>();
  const mk = (id: string, order: string | null, staff: string, at: string): Img => ({ id, location: "uk", order_number: order, staff_id: staff, created_at: at, event_type: "started", department: "framed", line_sku: null, line_quantity: null, parent_event_id: null, cs_case_id: null, note: "", station_id: "s" });
  for (let i = 0; i < 4; i++) src.set(`r-o${i}`, mk(`r-o${i}`, "O-1", S, `2026-02-0${i + 1}T08:00:00+00:00`));
  for (let i = 0; i < 30; i++) src.set(`r-s${String(i).padStart(2, "0")}`, mk(`r-s${String(i).padStart(2, "0")}`, `O-${100 + i}`, S2, `2026-01-0${(i % 9) + 1}T0${i % 10}:00:00+00:00`));
  const view = () => rawView([...src.values()].map((img) => ({ img })), "uk");
  const members = (params: unknown[]) => {
    const owners = (JSON.parse(String(params[3])) as Array<[string, string]>).map(([k, key]) => ({ partitionKind: k as "order" | "event", partitionKey: key }));
    const after = params[4] === null ? null : { idx: Number(params[4]), id: String(params[5]) };
    return memberPage(expectedMembers(view(), owners), after, Number(params[6])).map((r) => ({ idx: r.idx, event_id: r.event_id, image: r.img }));
  };
  const stream = (params: unknown[]) => {
    const [staff, dir, at, atId, limit] = [String(params[3]), String(params[4]), String(params[5]), String(params[6]), Number(params[7])];
    const anchor = { created_at: at, id: atId };
    const xs = view().events.filter((e) => e.staff_id === staff && (dir === "after" ? compareStream(e, anchor) > 0 : compareStream(e, anchor) < 0)).sort(compareStream);
    if (dir === "before") xs.reverse();
    return xs.slice(0, fail.streamShort ? Math.max(0, limit - 995) : limit).map((e) => ({ event_id: e.id, image: src.get(e.id) }));
  };
  let batch = 0;
  let applied42 = false;
  const db: Db = {
    query: async (sql: string, params: unknown[] = []) => {
      sent.push(sql);
      if (B42.includes(sql) && sql.startsWith("CREATE OR REPLACE FUNCTION")) applied42 = true;
      if (sql === CASE_SQL.effective && applied42) {
        const r = ["frozen_read_batch", "list_reporting_owners", "read_reporting_changed_keys", "read_reporting_children", "read_reporting_events_by_id", "read_reporting_owner_members", "read_reporting_staff_stream"].map((name) => ({ name, body_md5: bodyHashes(name === "frozen_read_batch" ? functionBody(t40, "reporting_private.frozen_read_batch") : functionBody((ACCESS_FUNCTIONS as readonly string[]).includes(name) && !fail.stale42 ? T42 : T41, `public.${name}`))[0], definer: false, config: 'search_path=""', anon: false, authenticated: false, service: true }));
        return { rows: r, rowCount: r.length };
      }
      if (sql === COLLATION_INVARIANT_SQL) return { rows: [{ columns: ["event_id=100", "order_key=100"], key_collation: '"default"', default_deterministic: !fail.collation, database_locale: "c:C.UTF-8", equality_agrees: true }], rowCount: 1 };
      if (sql === AS["members-split"]) return { rows: members(params), rowCount: 0 };
      if (sql === AS.stream) return { rows: stream(params), rowCount: 0 };
      if (sql.startsWith(DIAG_PREFIX) && sql.slice(DIAG_PREFIX.length) === AS["members-split"] && batch === 1) {
        // the rebuild 0042 member plan: owner-keyed, or (unkeyed42) the hosted failure shape that still runs fast
        const n = members(params).length;
        const cond = fail.unkeyed42 ? "((sc.batch_id = 'b'::uuid) AND (sc.site = 'uk'::text))" : "((sc.batch_id = 'b'::uuid) AND (sc.site = 'uk'::text) AND ((sc.order_key)::text = (o.key)::text))";
        const scan = { "Node Type": "Index Scan", "Relation Name": "source_candidate", "Index Name": "source_candidate_owner_order", "Index Cond": cond, "Actual Rows": n, "Rows Removed by Filter": fail.unkeyed42 ? 42337 : 0, "Actual Loops": 1 };
        return { rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Limit", "Actual Rows": n, Plans: [scan] }, "Planning Time": 0.1, "Execution Time": 2 }] }], rowCount: 1 };
      }
      if (sql.startsWith(DIAG_PREFIX) && sql.slice(DIAG_PREFIX.length) === AS.stream) {
        const n = stream(params).length;
        return { rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Limit", "Actual Rows": n, Plans: [{ "Node Type": "Index Scan", "Relation Name": "source_candidate", "Actual Rows": n, "Actual Loops": 1 }, { "Node Type": "Seq Scan", "Relation Name": "batch_events", "Actual Rows": 1, "Rows Removed by Filter": 3, "Actual Loops": 1 }] }, "Planning Time": 0.1, "Execution Time": 2 }] }], rowCount: 1 };
      }
      const rows = (r: Array<Record<string, unknown>>) => ({ rows: r, rowCount: r.length });
      if (sql === "rollback" && fail.rollbackFails) throw new Error("connection terminated");
      if (sql === FUNCTION_SQL) return rows([{ body_md5: b39, security_definer: false, service_exec: true, authenticated_exec: false, anon_exec: false }]);
      if (sql === CASE_SQL.absent) return rows([{ functions: fail.alreadyApplied ? 7 : 0, indexes: 0, active: 0, marker: 1 }]);
      if (sql === CASE_SQL.collisions) return rows([{ n: 0 }]);
      if (sql === CASE_SQL.effective) return rows(["frozen_read_batch", "list_reporting_owners", "read_reporting_changed_keys", "read_reporting_children", "read_reporting_events_by_id", "read_reporting_owner_members", "read_reporting_staff_stream"].map((name) => ({ name, body_md5: bodyHashes(name === "frozen_read_batch" ? functionBody(t40, "reporting_private.frozen_read_batch") : functionBody(T41, `public.${name}`))[0], definer: false, config: 'search_path=""', anon: false, authenticated: false, service: true })));
      if (sql === CASE_SQL.indexes) return rows([{ n: 4 }]);
      if (sql === PLAN_SQL.owner) return rows([{ k: "O-1", raw: "O-1", n: 4 }]);
      if (sql === PLAN_SQL.staff) return rows([{ s: S2, n: 30 }]);
      if (sql.startsWith("insert into public.production_events")) {
        for (const x of JSON.parse(String(params[1])) as Array<Record<string, unknown>>) src.set(String(x.id), { ...mk(String(x.id), x.order_number as string, String(x.staff_id), String(x.created_at)), note: String(x.note) });
        return rows([]);
      }
      if (sql.startsWith("update public.production_events set note")) { for (const id of ["dr-pm-1", "dr-pe"]) src.set(id, { ...src.get(id)!, note: "diagnostic overlay" }); return rows([]); }
      if (sql.startsWith("delete from public.production_events")) { src.delete("dr-pm-3"); return rows([]); }
      if (sql.includes("begin_reporting_rebuild") || sql.includes("begin_reporting_batch")) return rows([{ batch_id: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${++batch}`, lease_fence: 1 }]);
      if (sql.includes("copy_reporting_source_page")) return rows([{ complete: true, pages: 1, total_rows: src.size }]);
      if (sql === CASE_SQL.batch) return rows([{ batch_id: params[0], fence: "1", cutoff: "2026-03-01T00:00:00.000000Z", state: "frozen", kind: batch === 1 ? "rebuild" : "refresh" }]);
      if (sql === CASE_SQL.view) return rows([...src.values()].map((img) => ({ img })));
      if (sql === CASE_SQL.candidateEquality) return rows([{ candidate_rows: String(src.size), source_rows: String(src.size), candidate_md5: fail.candidateDiffers ? "x" : "m", source_md5: "m" }]);
      if (sql.includes("publish_reporting_batch")) return rows([{ generation_seq: "1" }]);
      if (sql === ST["members-original"]) return rows(members(params));
      if (sql === ST["members-split"]) { const r = members(params); const first = params[4] === null && Number(params[6]) < 1000; return rows(fail.splitReordered ? [...r].reverse() : fail.splitFirstDrop && first ? r.slice(0, -1) : r); }
      if (sql === ST.stream) return rows(stream(params));
      if (sql.startsWith(DIAG_PREFIX)) {
        const q = sql.slice(DIAG_PREFIX.length);
        const n = q === ST.stream ? stream(params).length : members(params).length;
        return rows([{ "QUERY PLAN": [{ Plan: { "Node Type": "Limit", "Actual Rows": fail.explainRows ? n + 1 : n, "Plan Rows": 1, Plans: [{ "Node Type": "Index Scan", "Index Name": "x", "Actual Rows": n, Output: ["image"] }] }, "Planning Time": 0.1, "Execution Time": 2 }] }]);
      }
      return rows([]);
    },
  };
  return { db, sent };
}
function planCtx(over: Partial<PlanCtx> = {}): { ctx: PlanCtx; recorded: Observation[]; emitted: PlanEvidence[] } {
  const recorded: Observation[] = [];
  const emitted: PlanEvidence[] = [];
  return { recorded, emitted, ctx: { sites: ["uk", "us"], maxPages: 200, staff: S, as: async () => undefined, record: (o) => void recorded.push(o), redact: (s) => s, now: () => 0, emit: (e) => void emitted.push(JSON.parse(JSON.stringify(e)) as PlanEvidence), ...over } };
}
const realDeps = (over: Partial<PlanDeps> = {}): PlanDeps => ({ read: (p) => readFileSync(p), cases: runPlanCases, ...over });

describe("T14S3: the diagnostic end to end (real cases over a scripted database)", () => {
  it("success: refusals before BEGIN, the reviewed bodies, exactly 20 allowlisted explains, parity on both batches, ROLLBACK, never COMMIT; COMPLETE evidence", async () => {
    const s = scriptedDb();
    const t = planCtx();
    const ev = await diagnoseDependencyPlans(s.db, t.ctx, realDeps());
    const begin = s.sent.indexOf("begin");
    expect(s.sent.slice(0, begin)).toEqual([FUNCTION_SQL, CASE_SQL.absent, CASE_SQL.collisions]);
    expect(s.sent.at(-1)).toBe("rollback");
    expect(s.sent.some((q) => /^\s*(commit|end)\b/i.test(q))).toBe(false);
    const explains = s.sent.filter((q) => /^\s*explain/i.test(q));
    expect(explains).toHaveLength(20);
    const allow = explainAllowlist(T41);
    expect(explains.every((q) => allow.has(q))).toBe(true);
    expect(ev.complete).toBe(true);
    expect(ev.explains).toBe(20);
    expect(Object.keys(ev.probes).sort()).toEqual([...EXPLAIN_CASES].sort());
    expect(t.recorded.map((o) => o.id)).toEqual([...REQUIRED_PLAN_CASES.slice(0, 8), "M-rb-small", "M-rb-normal", ...EXPLAIN_CASES.slice(0, 6), "C-rb-stream", ...EXPLAIN_CASES.slice(6, 10), "P0", "F0", "M-rf-small", "M-rf-normal", ...EXPLAIN_CASES.slice(10, 16), "C-rf-stream", ...EXPLAIN_CASES.slice(16), "D9"]);
    expect(t.recorded.every((o) => o.ok)).toBe(true);
    expect(ev.comparisons).toMatchObject({ "rb-small": "exact (3 + 3 of 7)", "rf-small": "exact (3 + 3 of 7)" }); // 4 real + 2 order fixtures + 1 event owner; refresh: +dr-pm-2, -dr-pm-3
    expect(ev.probes["E-rb-mo-2"]).toMatchObject({ statement: "members-original", batch: "rebuild", page: "later (small)", limit: 3, expectedRows: 3, actualRows: 3, cursor: { idx: 0, id: "r-o0" } });
    expect(ev.probes["E-rf-sa-2"].expectedRows).toBe(0); // 30 rows: the later 1,000-row page is empty (recorded, not forced)
    expect(JSON.stringify(ev)).not.toMatch(/diagnostic overlay|"note"/); // no source payloads in evidence
    expect(t.emitted.at(-1)!.complete).toBe(true);
  });
  const failures: Array<[string, Fail, Partial<PlanDeps>, RegExp]> = [
    ["the split returns reordered rows (parity)", { splitReordered: true }, {}, /M-rb-small failed/],
    ["the split drops a row on the small FIRST page only (parity)", { splitFirstDrop: true }, {}, /M-rb-small failed/],
    ["the fixed explain cap is reached", {}, { cases: async (c, ctx, env) => { env.ev.explains = MAX_EXPLAINS - 1; await runPlanCases(c, ctx, env); } }, /E-rb-mo-2 failed/],
    ["an explained execution returns a different row count", { explainRows: true }, {}, /E-rb-mo-1 failed/],
    ["the candidate is not the full source", { candidateDiffers: true }, {}, /R1 failed/],
    ["a stream first page does not match the independent count", { streamShort: true }, {}, /C-rb-stream failed/],
    ["0040 is already applied", { alreadyApplied: true }, {}, /D1 failed/],
    ["the cases record nothing (incomplete evidence)", {}, { cases: async () => undefined }, /not recorded: S0/],
  ];
  for (const [name, fail, dep, re] of failures) {
    it(`stops, rolls back (if begun) and is never complete when ${name}`, async () => {
      const s = scriptedDb(fail);
      const t = planCtx();
      await expect(diagnoseDependencyPlans(s.db, t.ctx, realDeps(dep))).rejects.toThrow(re);
      if (s.sent.includes("begin")) expect(s.sent.at(-1)).toBe("rollback");
      expect(s.sent.some((q) => /^\s*commit\b/i.test(q))).toBe(false);
      expect(t.emitted.every((e) => !e.complete)).toBe(true);
    });
  }
  it("every diagnostic SELECT, plain or explained, runs as service_role (as the invoker functions would)", async () => {
    const s = scriptedDb();
    let service = false;
    const roles: Array<[boolean, string]> = [];
    const db: Db = { query: async (q: string, p?: unknown[]) => (roles.push([service, q]), s.db.query(q, p)) };
    await diagnoseDependencyPlans(db, planCtx({ as: async (_c, sv) => void (service = sv) }).ctx, realDeps());
    const diag = roles.filter(([, q]) => q === ST["members-original"] || q === ST["members-split"] || q === ST.stream || q.startsWith(DIAG_PREFIX));
    expect(diag.length).toBe(20 + 2 * (4 + 2 + 2)); // 20 explains + per batch: 4 small and 2 normal plain member pages, 2 plain stream first pages
    expect(diag.every(([sv]) => sv)).toBe(true);
    expect(service).toBe(false); // reset after each
  });
  it("an evidence (emit) failure stops and still rolls back", async () => {
    const s = scriptedDb();
    let n = 0;
    await expect(diagnoseDependencyPlans(s.db, planCtx({ emit: () => { if (++n === 3) throw new Error("ENOSPC"); } }).ctx, realDeps())).rejects.toThrow(/D3 failed/);
    expect(s.sent.at(-1)).toBe("rollback");
  });
  it("a rollback failure after an earlier failure is kept BESIDE it", async () => {
    await expect(diagnoseDependencyPlans(scriptedDb({ splitReordered: true, rollbackFails: true }).db, planCtx().ctx, realDeps())).rejects.toThrow(/^M-rb-small failed; later steps depend on it; cleanup failed: rehearsal rollback: connection terminated$/);
  });
  for (const [name, dep, change] of [["success", {}, false], ["incomplete evidence", { cases: async () => undefined }, false], ["an unexpected change", {}, true]] as const) {
    it(`inside the actual lifecycle (${name}): rolled back and closed, a fresh ZERO-change audit, COMPLETE only with complete evidence`, async () => {
      const report = newPublicationReport("diagnose-dependency-plans", ["uk", "us"], "rev", "t0", "sha");
      const st = (x: string): FullState => ({ surfaces: { "index:reporting_private.source_candidate_owner_order": x }, privateTables: {}, control: { capture_epoch: "21", capture_enabled: false, rule_version: "r", updated_at: "t" }, siteState: [] });
      const conns: Array<{ s: ReturnType<typeof scriptedDb>; ended: boolean }> = [];
      await runCaptureLifecycle(report, {
        open: async () => { const s = scriptedDb(); const o = { s, ended: false }; conns.push(o); return { query: s.db.query, end: async () => void (o.ended = true) }; },
        body: async (main) => { await diagnoseDependencyPlans(main as unknown as Db, planCtx({ record: (o) => void report.observations.push(o), emit: (e) => void (report.dependencyPlans = e as unknown as Record<string, unknown>) }).ctx, realDeps(dep as Partial<PlanDeps>)); },
        audit: async () => compareFullState(st("absent"), st(change ? "present" : "absent"), ROLLBACK_ONLY),
        save: () => undefined, now: () => "t1", redact: (x) => x, stderr: () => undefined,
      });
      expect(conns).toHaveLength(2);
      expect(conns.every((o) => o.ended)).toBe(true);
      expect(conns[0].s.sent.includes("rollback")).toBe(true);
      if (name === "success") expect(publicationStatus(report)).toBe("STATUS: COMPLETE");
      else expect(publicationStatus(report)).toMatch(/^STATUS: FAILED/);
    });
  }
});

// ---------------------------------------------------------------------------
// T14S3 review repairs (777f466)
// ---------------------------------------------------------------------------

describe("T14S3 review: every executing EXPLAIN form is refused unless exactly allowlisted", () => {
  const body = [...migrationBody(read(MIGRATION_0040)), ...migrationBody(T41)];
  const allow = explainAllowlist(T41);
  const executing = [
    `EXPLAIN ANALYZE ${ST["members-original"]}`, `EXPLAIN ANALYZE ${ST.stream}`, "EXPLAIN ANALYZE UPDATE reporting_private.batches SET state = 'failed'", "explain analyse select 1", "EXPLAIN ANALYZE VERBOSE select 1",
    "/* c */ EXPLAIN\n  ANALYZE delete from reporting_private.source_candidate", "-- c\nexplain analyze insert into x values (1)", "EXPLAIN (FORMAT JSON, ANALYZE TRUE) select 1", "explain (analyze false) select 1", "EXPLAIN (ANALYSE) WITH x AS (SELECT 1) SELECT * FROM x",
    `EXPLAIN ANALYZE ${DIAG_PREFIX.slice("EXPLAIN ".length)}${ST.stream}`,
  ];
  for (const sql of executing) {
    it(`refuses before sending: ${sql.replace(/\s+/g, " ").slice(0, 70)}`, async () => {
      expect(executesExplain(sql)).toBe(true);
      const sent: string[] = [];
      const db: Db = { query: async (q: string) => (sent.push(q), { rows: [], rowCount: 0 }) };
      await expect(dependencyGuard(db, new Set(body), [], allow).query(sql)).rejects.toThrow(/dependency-read rehearsal refuses/);
      expect(sent).toEqual([]);
    });
  }
  it("non-executing plans and ordinary statements are not executing EXPLAINs; the exact diagnostic strings are still allowed", async () => {
    for (const q of [planSql(T41, "read_reporting_owner_members"), planSql(T41, "read_reporting_staff_stream"), "EXPLAIN select 1", "explain (verbose, format json) select analyze_col from t", "select 'explain analyze'", ST.stream]) expect(executesExplain(q)).toBe(false);
    const sent: string[] = [];
    const db: Db = { query: async (q: string) => (sent.push(q), { rows: [], rowCount: 0 }) };
    const g = dependencyGuard(db, new Set(body), [], allow);
    for (const q of [...allow, planSql(T41, "read_reporting_staff_stream")]) await g.query(q);
    expect(sent).toHaveLength(4);
  });
});

describe("T14S3 review: the owner choice tie-breaks on the text key", () => {
  it("orders by count then the order_key expression COLLATE \"C\" (never the ordinal 1)", () => {
    expect(PLAN_SQL.owner).toContain('order by count(*) desc, reporting_private.order_key(pe.order_number) collate "C" limit 1');
    expect(PLAN_SQL.owner).not.toMatch(/,\s*1\s+collate/i);
    expect(PLAN_SQL.owner).toContain("group by 1");
  });
});

// ---------------------------------------------------------------------------
// Planner review: comment-hidden statement keywords (T14S3 guard)
// ---------------------------------------------------------------------------

describe("T14S3 review 2: comments can never hide ANALYZE or a statement's kind", () => {
  const body = [...migrationBody(read(MIGRATION_0040)), ...migrationBody(T41)];
  const allow = explainAllowlist(T41);
  const hidden = [
    "EXPLAIN /* select */ ANALYZE DELETE FROM x",
    "EXPLAIN -- select\nANALYZE DELETE FROM x",
    "EXPLAIN /* a /* nested select */ still comment */ ANALYZE UPDATE x SET y = 1",
    "EXPLAIN /**/ANALYZE/**/DELETE FROM x",
    "EXPLAIN (/* select */ ANALYZE) DELETE FROM x",
    "EXPLAIN (FORMAT JSON, -- with\n ANALYZE) INSERT INTO x VALUES (1)",
    "EXPLAIN (\"analyze\") SELECT 1",
    "EXPLAIN /* unterminated ANALYZE DELETE FROM x",
    "/* lead */ EXPLAIN /* select */ ANALYZE DELETE FROM x",
  ];
  for (const sql of hidden) {
    it(`refuses before sending: ${JSON.stringify(sql).slice(0, 70)}`, async () => {
      expect(executesExplain(sql)).toBe(true);
      const sent: string[] = [];
      const db: Db = { query: async (q: string) => (sent.push(q), { rows: [], rowCount: 0 }) };
      await expect(dependencyGuard(db, new Set(body), [], allow).query(sql)).rejects.toThrow(/dependency-read rehearsal refuses/);
      expect(sent).toEqual([]);
    });
  }
  const ddl = ["/* a /* b */ c */ DROP TABLE reporting_private.batches", "/* x */ -- y\n/* z */ CREATE TABLE x (a int)", "/* unterminated DROP TABLE x", "-- only a comment\n"];
  for (const sql of ddl) {
    it(`a nested/unterminated leading comment cannot hide DDL: ${JSON.stringify(sql).slice(0, 60)}`, async () => {
      const sent: string[] = [];
      const db: Db = { query: async (q: string) => (sent.push(q), { rows: [], rowCount: 0 }) };
      await expect(dependencyGuard(db, new Set(body), [], allow).query(sql)).rejects.toThrow(/dependency-read rehearsal refuses/);
      expect(sent).toEqual([]);
    });
  }
  it("keywords inside strings, identifiers or dollar quotes are not comments and not ANALYZE options; allowed statements still pass", async () => {
    for (const q of ["EXPLAIN SELECT '/* ANALYZE */'", "EXPLAIN SELECT $x$ -- ANALYZE $x$", "EXPLAIN (VERBOSE) SELECT \"analyze\" FROM t", planSql(T41, "read_reporting_staff_stream")]) expect(executesExplain(q)).toBe(false);
    expect(stripSqlComments("select 1 /* a /* b */ c */ + 2 -- x\n")).toBe("select 1   + 2  \n");
    expect(stripSqlComments("select '--x' /* y */")).toBe("select '--x'  ");
    expect(stripSqlComments("select 1 /* open")).toBeNull();
    const sent: string[] = [];
    const db: Db = { query: async (q: string) => (sent.push(q), { rows: [], rowCount: 0 }) };
    const g = dependencyGuard(db, new Set(body), [], allow);
    for (const q of [...allow, ...body]) await g.query(q);
    expect(sent).toHaveLength(allow.size + body.length);
  });
});

// ---------------------------------------------------------------------------
// Task 14: the 0042 access-path follow-up (prepared; NOT run)
// ---------------------------------------------------------------------------

describe("Task 14 0042 follow-up: wiring, pin, statements and allowlist", () => {
  it("--diagnose-access-paths takes exactly --sites=A,B; the runner dispatches it in the guarded lifecycle; COMPLETE only with complete evidence", () => {
    expect(parsePublicationArgs(["--diagnose-access-paths", "--sites=uk,us"])).toMatchObject({ mode: "diagnose-access-paths", sites: ["uk", "us"], problems: [] });
    for (const argv of [["--diagnose-access-paths", "--site=uk"], ["--diagnose-access-paths", "--diagnose-dependency-plans", "--sites=uk,us"]]) expect(parsePublicationArgs(argv).mode).toBeNull();
    const runner = read("tests/staging/reporting-jobs.ts");
    const pub = runner.slice(runner.indexOf("async function publicationMain"), runner.indexOf("async function main()"));
    expect(pub.indexOf("before = await fullState(main);")).toBeLessThan(pub.indexOf('if (mode === "diagnose-access-paths") {'));
    expect(pub).toMatch(/await diagnoseAccessPaths\(main, \{ sites, maxPages, staff, as, record, redact: redactSecrets, now: \(\) => performance\.now\(\), emit: \(ev\) => \{ report\.accessPaths = ev as unknown as Record<string, unknown>; save\(\); \} \}\);\n\s+return;/);
    expect(runner.slice(runner.indexOf("async function main()"))).toContain('f === "--diagnose-access-paths")) return publicationMain(flags);');
    const r = newPublicationReport("diagnose-access-paths", ["uk", "us"], "rev", "t0", "sha");
    Object.assign(r, { finishedAt: "t1", restorationVerified: true, observations: [{ id: "D0", what: "x", expected: "y", result: "ok", ok: true, ms: 0 }] });
    expect(publicationStatus(r)).toBe("STATUS: FAILED – 0042 access-path evidence is missing or incomplete");
    r.accessPaths = { complete: true };
    expect(publicationStatus(r)).toBe("STATUS: COMPLETE");
  });
  it("the pin is the current 0042 file; the body is exactly the two replacements and their restated grants", () => {
    expect(fileIdentity(MIGRATION_0042).lf).toBe(REVIEWED_0042_LF);
    expect(accessBodyProblems(B42)).toEqual([]);
    expect(accessBodyProblems([...B42, "CREATE INDEX x ON y (z)"])).toEqual(["0042 has 7 statements, expected 6"]);
    expect(accessBodyProblems(B42.map((s, i) => (i === 1 ? s.replace("read_reporting_staff_stream", "read_reporting_children") : s)))[0]).toMatch(/statement 2/);
  });
  it("the slots: members-original = 0041 members, members-split = 0042 members, stream = 0042 stream; exactly three allowlisted EXPLAINs", () => {
    expect(AS["members-original"]).toBe(ST["members-original"]);
    expect(AS["members-split"]).toBe(boundReadQuery(T42, "read_reporting_owner_members"));
    expect(AS.stream).toBe(boundReadQuery(T42, "read_reporting_staff_stream"));
    expect(AS["members-split"]).not.toBe(AS["members-original"]);
    expect(AS.stream).not.toBe(ST.stream);
    expect([...accessAllowlist(T41, T42)].sort()).toEqual(Object.values(AS).map((q) => DIAG_PREFIX + q).sort());
    expect(ACCESS_NAMES).toEqual({ "members-original": "members-0041", "members-split": "members-0042", stream: "stream-0042" });
  });
  it("the guard runs the exact 0042 statements only when the follow-up passes them; the T14S3 guard still refuses them", async () => {
    const db: Db = { query: async () => ({ rows: [], rowCount: 0 }) };
    const body41 = migrationBody(T41);
    await expect(dependencyGuard(db, new Set(body41)).query(B42[0])).rejects.toThrow(/refuses/);
    const g = dependencyGuard(db, new Set([...body41, ...B42]));
    for (const q of B42) await g.query(q);
    await expect(g.query("CREATE INDEX x ON reporting_private.batch_events (event_id)")).rejects.toThrow(/refuses/);
  });
  it("relationReads sums (rows + removed by filter/recheck) x loops per relation over the whole plan", () => {
    const plan = [{ Plan: { "Node Type": "Limit", "Actual Rows": 5, Plans: [
      { "Node Type": "Index Scan", "Relation Name": "source_candidate", "Actual Rows": 4, "Rows Removed by Filter": 1, "Actual Loops": 3 },
      { "Node Type": "Seq Scan", "Relation Name": "batch_events", "Actual Rows": 2, "Rows Removed by Filter": 40, "Actual Loops": 1, Plans: [{ "Node Type": "Bitmap Heap Scan", "Relation Name": "source_candidate", "Actual Rows": 1, "Rows Removed by Index Recheck": 1, "Actual Loops": 2 }] },
      { "Node Type": "Index Scan", "Relation Name": "source_current", "Actual Loops": 0 },
    ] } }];
    expect(relationReads(plan)).toEqual({ source_candidate: 19, batch_events: 42, source_current: 0 });
    expect(() => relationReads([{}])).toThrow(/no JSON plan/);
  });
  it("ownerKeyProblems is structural: the exact hosted 0042 nodes (14 ms) are rejected; keyed default, bytewise and bitmap accesses pass", () => {
    const wrap = (...scans: Array<Record<string, unknown>>) => [{ Plan: { "Node Type": "Limit", Plans: scans }, "Execution Time": 14.424 }];
    const bs = "(sc.batch_id = '068ae6dc-a61a-49aa-b9ec-447db65df4f8'::uuid) AND (sc.site = 'uk'::text)";
    // verbatim from the hosted report (E-rb-ms-1): fast, but keyed only on (batch_id, site)
    const hosted = wrap(
      { "Node Type": "Index Scan", "Relation Name": "source_candidate", "Index Name": "source_candidate_owner_order", "Index Cond": `(${bs})`, Filter: "(sc.order_key = o.key)", "Actual Rows": 6, "Rows Removed by Filter": 42337, "Actual Loops": 1 },
      { "Node Type": "Index Scan", "Relation Name": "source_candidate", "Index Name": "source_candidate_owner_event", "Index Cond": `(${bs.replace(/sc\./g, "sc_1.")})`, Filter: "(sc_1.event_id = o.key)", "Actual Rows": 1, "Rows Removed by Filter": 1460, "Actual Loops": 1 },
    );
    const p = ownerKeyProblems(hosted);
    expect(p).toHaveLength(2);
    expect(p[0]).toBe(`Index Scan source_candidate_owner_order on source_candidate: the index condition lacks the owner key ((${bs}))`);
    expect(ownerKeyProblems(wrap(
      { "Node Type": "Index Scan", "Relation Name": "source_candidate", "Index Cond": `(${bs} AND ((sc.order_key)::text = (o.key)::text))` },
      { "Node Type": "Index Scan", "Relation Name": "source_candidate", "Index Cond": `(${bs} AND (sc_1.event_id = o_1.key))` },
      { "Node Type": "Bitmap Heap Scan", "Relation Name": "source_candidate", "Recheck Cond": `(${bs} AND (sc.order_key = o.key))`, Plans: [{ "Node Type": "Bitmap Index Scan", "Index Cond": "x" }] },
      { "Node Type": "Seq Scan", "Relation Name": "source_current" }, // other relations are not judged here
    ))).toEqual([]);
    expect(ownerKeyProblems(wrap({ "Node Type": "Seq Scan", "Relation Name": "source_candidate", Filter: "(sc.order_key = o.key)" }))).toEqual(["Seq Scan on source_candidate is not an index access"]);
    // a keyset comparison on event_id is not an owner key
    expect(ownerKeyProblems(wrap({ "Node Type": "Index Scan", "Relation Name": "source_candidate", "Index Cond": `(${bs} AND ((sc.event_id)::text > 'v'::text))` }))).toHaveLength(1);
  });
  it("acceptance needs owner-key evidence on every 0042 rebuild member probe, and renders as its own line", () => {
    const ev = newPlanEvidence();
    expect(accessAcceptanceProblems(ev)).toEqual(["no 0042 rebuild member probe was recorded"]);
    const probe = { statement: "members-0042", batch: "rebuild" as const, page: "p", limit: 3, cursor: null, expectedRows: 3, actualRows: 3, reads: {}, plan: { planningMs: 0, executionMs: 1, rootRows: 3, settings: {}, nodes: [], truncated: false } };
    ev.probes = { a: { ...probe, ownerKey: [] }, b: { ...probe }, c: { ...probe, statement: "members-0041", ownerKey: ["x"] }, d: { ...probe, batch: "refresh" } };
    expect(accessAcceptanceProblems(ev)).toEqual(["b: owner-key evidence is missing"]);
    expect(accessAcceptanceLines(undefined)).toEqual(["- acceptance: not evaluated"]);
    expect(accessAcceptanceLines({ accepted: true, problems: [] })[0]).toMatch(/ACCEPTED/);
    expect(accessAcceptanceLines({ accepted: false, problems: ["p1"] })).toEqual(["- acceptance: REJECTED", "  - p1"]);
  });
});

describe("Task 14 0042 follow-up end to end (real cases over a scripted database)", () => {
  it("success: refusals before BEGIN, 0040/0041 then 0042 inside, effective 0042 bodies, 20 allowlisted explains with per-relation reads, ROLLBACK; COMPLETE", async () => {
    const s = scriptedDb();
    const t = planCtx();
    const ev = await diagnoseAccessPaths(s.db, t.ctx, realDeps());
    const begin = s.sent.indexOf("begin");
    expect(s.sent.slice(0, begin)).toEqual([FUNCTION_SQL, CASE_SQL.absent, CASE_SQL.collisions]);
    const at42 = s.sent.indexOf(B42[0]);
    expect(at42).toBeGreaterThan(s.sent.indexOf(CASE_SQL.indexes)); // after D3
    expect(s.sent.slice(at42, at42 + B42.length)).toEqual(B42);
    expect(s.sent.at(-1)).toBe("rollback");
    expect(s.sent.some((q) => /^\s*(commit|end)\b/i.test(q))).toBe(false);
    const explains = s.sent.filter((q) => /^\s*explain/i.test(q));
    expect(explains).toHaveLength(20);
    const allow = accessAllowlist(T41, T42);
    expect(explains.every((q) => allow.has(q))).toBe(true);
    expect(ev.complete).toBe(true);
    expect(REQUIRED_ACCESS_CASES.every((id) => ev.recorded.includes(id))).toBe(true);
    expect(t.recorded.map((o) => o.id).slice(0, 7)).toEqual(["D0", "D1", "D2", "D3", "A0", "A1", "A2"]);
    expect(s.sent.indexOf(COLLATION_INVARIANT_SQL)).toBeLessThan(s.sent.findIndex((q) => /^\s*explain/i.test(q))); // the invariant is checked before any probe
    expect(ev.functions.collation0042).toMatchObject({ default_deterministic: true, equality_agrees: true });
    expect(ev.probes["E-rb-ms-1"].ownerKey).toEqual([]);
    expect(ev.probes["E-rf-sa-1"].ownerKey).toBeUndefined(); // stream probes carry no owner-key verdict
    expect(ev.acceptance).toEqual({ accepted: true, problems: [] });
    expect(ev.files.map((f) => f.path).at(-1)).toBe(MIGRATION_0042);
    expect(ev.statementsApplied).toBe(25 + 6 + 6);
    expect(ev.probes["E-rb-ms-1"].statement).toBe("members-0042");
    expect(ev.probes["E-rb-mo-1"].statement).toBe("members-0041");
    expect(ev.probes["E-rf-sa-1"].statement).toBe("stream-0042");
    expect(ev.probes["E-rf-sa-1"].reads.batch_events).toBe(4); // the overlay branch is measured
    expect(ev.label).toMatch(/overlay \(batch_events\) branch is measured, not claimed bounded/);
  });
  it("refuses before BEGIN on an unreviewed 0042 file", async () => {
    const s = scriptedDb();
    await expect(diagnoseAccessPaths(s.db, planCtx().ctx, { ...realDeps(), pin: "0".repeat(64) })).rejects.toThrow(/0042 is not the reviewed draft/);
    expect(s.sent).toEqual([]);
  });
  it("A1 refuses when the effective functions are not the 0042 bodies; rolls back and is never complete", async () => {
    const s = scriptedDb({ stale42: true });
    const t = planCtx();
    await expect(diagnoseAccessPaths(s.db, t.ctx, realDeps())).rejects.toThrow(/A1 failed/);
    expect(s.sent.at(-1)).toBe("rollback");
    expect(t.emitted.every((e) => !e.complete)).toBe(true);
  });
  it("is never complete when the cases record nothing", async () => {
    const s = scriptedDb();
    await expect(diagnoseAccessPaths(s.db, planCtx().ctx, realDeps({ cases: async () => undefined }))).rejects.toThrow(/not recorded/);
    expect(s.sent.at(-1)).toBe("rollback");
  });
  it("REJECTS the hosted failure shape (Index Cond only batch_id/site) even though it ran in 2 ms: evidence COMPLETE, acceptance REJECTED", async () => {
    const s = scriptedDb({ unkeyed42: true });
    const ev = await diagnoseAccessPaths(s.db, planCtx().ctx, realDeps());
    expect(ev.complete).toBe(true); // evidence collected
    expect(ev.probes["E-rb-ms-1"].plan.executionMs).toBe(2);
    expect(ev.acceptance?.accepted).toBe(false);
    expect(ev.acceptance?.problems).toHaveLength(3); // the three 0042 rebuild member probes
    expect(ev.acceptance?.problems[0]).toMatch(/^E-rb-ms-1: Index Scan source_candidate_owner_order on source_candidate: the index condition lacks the owner key/);
    const r = { ...newPublicationReport("diagnose-access-paths", ["uk", "us"], "x", "y", "z"), accessPaths: ev as unknown as Record<string, unknown> };
    expect(publicationMarkdown(r)).toContain("- acceptance: REJECTED");
  });
  it("A2 refuses a non-deterministic default collation before any probe; rolls back and is never complete", async () => {
    const s = scriptedDb({ collation: true });
    const t = planCtx();
    await expect(diagnoseAccessPaths(s.db, t.ctx, realDeps())).rejects.toThrow(/A2 failed/);
    expect(JSON.stringify(t.recorded.find((o) => o.id === "A2"))).toMatch(/not deterministic/);
    expect(s.sent.some((q) => /^\s*explain/i.test(q))).toBe(false);
    expect(s.sent.at(-1)).toBe("rollback");
    expect(t.emitted.every((e) => !e.complete)).toBe(true);
  });
  it("the functions under test are the two 0042 replacements", () => {
    expect(ACCESS_FUNCTIONS).toEqual(["read_reporting_owner_members", "read_reporting_staff_stream"]);
  });
});
