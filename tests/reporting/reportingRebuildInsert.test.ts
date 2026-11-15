/**
 * T13B2b-19: the append-only 0039 rebuild-insert repair. Migration fidelity
 * (0039 = the installed 0038 publish_reporting_batch with ONLY its rebuild
 * source_versions INSERT changed), immutable 0037/0038, and the rollback
 * rehearsal coordinator / proof helpers without a database.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrationBody } from "../staging/reportingPublication";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
/** Checkout-independent identities: the LF form (as git stores it) and the CRLF form (0038 was installed from a CRLF working copy). */
const shaLf = (p: string) => createHash("sha256").update(read(p)).digest("hex");
const shaCrlf = (p: string) => createHash("sha256").update(read(p).replace(/\n/g, "\r\n")).digest("hex");
const M37 = "supabase/migrations/0037_reporting_storage.sql";
const M38 = "supabase/migrations/0038_reporting_jobs.sql";
const M39 = "supabase/migrations/0039_reporting_rebuild_insert.sql";

/** The installed 0038 rebuild INSERT (0038 lines 1943-1947) and its 0039 replacement. */
export const OLD_REBUILD_INSERT = `    INSERT INTO reporting_private.source_versions (site, event_id, valid_from_seq, image)
    SELECT b.site, c.event_id, v_seq, c.image
      FROM reporting_private.source_candidate c
     WHERE c.batch_id = p_batch AND c.site = b.site
       AND NOT EXISTS (SELECT 1 FROM reporting_private.source_versions v WHERE v.site = b.site AND v.event_id = c.event_id AND v.valid_to_seq IS NULL);`;
export const NEW_REBUILD_INSERT = `    INSERT INTO reporting_private.source_versions (site, event_id, valid_from_seq, image)
    SELECT b.site, c.event_id, v_seq, c.image
      FROM reporting_private.source_candidate c
     WHERE c.batch_id = p_batch AND c.site = b.site
    ON CONFLICT (site, event_id) WHERE valid_to_seq IS NULL DO NOTHING;`;

function publish0038(): string {
  const t = read(M38);
  const start = t.indexOf("CREATE FUNCTION public.publish_reporting_batch(p_batch uuid, p_fence bigint)");
  const end = t.indexOf("\n$fn$;", start) + "\n$fn$;".length;
  expect(start).toBeGreaterThan(0);
  return t.slice(start, end);
}

describe("T13B2b-19: installed migrations are immutable", () => {
  it("0037 and 0038 keep their installed identity (checked line-ending independently)", () => {
    expect(shaLf(M37)).toBe("531bb2c5706b9ac4d73a7ca3dc74dead7e34a53160e57fe2971aaf061c6a6a4f"); // 0037 is LF in git and on disk
    expect(shaLf(M38)).toBe("002d6e58034aef1c83f94863bb89ce83dadeb225106cd804d2a46798193dd68f"); // 0038 as git stores it
    expect(shaCrlf(M38)).toBe("14a808ea0787009650437444baaa886da218349353e3ee4a854a97ef68714b1d"); // the installed (CRLF working-copy) bytes
    expect([shaLf(M38), shaCrlf(M38)]).toContain(sha(M38)); // whatever this checkout uses
  });
  it("the replaced INSERT is exactly 0038 lines 1943-1947, once, in the rebuild branch only", () => {
    const t = read(M38);
    expect(t.split(OLD_REBUILD_INSERT)).toHaveLength(2);
    expect(t.split("\n").slice(1942, 1947).join("\n")).toBe(OLD_REBUILD_INSERT);
  });
});

describe("T13B2b-19: 0039 migration fidelity", () => {
  it("exists at the allocated number; 0040/0041 are not yet created", () => {
    expect(existsSync(M39)).toBe(true);
    expect(existsSync("supabase/migrations/0040_reporting_dependency_reads.sql")).toBe(false);
    expect(existsSync("supabase/migrations/0041_reporting_reads.sql")).toBe(false);
  });

  it("is ONE BEGIN/COMMIT transaction with exactly one statement: CREATE OR REPLACE of publish_reporting_batch(uuid,bigint)", () => {
    const t = read(M39);
    const body = migrationBody(t);
    expect(body).toHaveLength(1);
    expect(body[0].trimStart().startsWith("CREATE OR REPLACE FUNCTION public.publish_reporting_batch(p_batch uuid, p_fence bigint)")).toBe(true);
    const code = t.split("\n").filter((l) => !l.startsWith("--")).join("\n").trim();
    expect(code.startsWith("BEGIN;")).toBe(true);
    expect(code.endsWith("COMMIT;")).toBe(true);
  });

  it("is the installed 0038 definition with ONLY the rebuild INSERT replaced (closure, refresh branch, fences, receipts, replay, security and search_path unchanged)", () => {
    const expected = publish0038().replace("CREATE FUNCTION public.publish_reporting_batch(", "CREATE OR REPLACE FUNCTION public.publish_reporting_batch(").replace(OLD_REBUILD_INSERT, NEW_REBUILD_INSERT);
    const t = read(M39);
    const start = t.indexOf("CREATE OR REPLACE FUNCTION public.publish_reporting_batch(");
    const end = t.indexOf("\n$fn$;", start) + "\n$fn$;".length;
    expect(t.slice(start, end)).toBe(expected);
  });

  it("the conflict handling is targeted at the partial unique index; never an untargeted DO NOTHING", () => {
    const t = read(M39).split("\n").filter((l) => !l.startsWith("--")).join("\n"); // executable lines only
    expect(t.match(/DO NOTHING/g)).toHaveLength(1);
    expect(t).toContain("ON CONFLICT (site, event_id) WHERE valid_to_seq IS NULL DO NOTHING;");
    expect(t).not.toMatch(/ON CONFLICT\s+DO NOTHING/i);
    // The partial unique index the target infers is the one 0038 installed.
    expect(read(M38)).toContain("CREATE UNIQUE INDEX source_versions_current ON reporting_private.source_versions (site, event_id) WHERE valid_to_seq IS NULL;");
  });

  it("keeps the preceding closure UPDATE and the refresh branch exactly (they appear verbatim and the rebuild anti-join is gone)", () => {
    const t = read(M39);
    expect(t).toContain(`    UPDATE reporting_private.source_versions v SET valid_to_seq = v_seq
     WHERE v.site = b.site AND v.valid_to_seq IS NULL
       AND NOT EXISTS (SELECT 1 FROM reporting_private.source_candidate c WHERE c.batch_id = p_batch AND c.site = b.site AND c.event_id = v.event_id AND c.image = v.image);`);
    expect(t).toContain("AND NOT EXISTS (SELECT 1 FROM reporting_private.source_versions v WHERE v.site = b.site AND v.event_id = be.event_id AND v.valid_to_seq IS NULL);"); // refresh: unchanged
    expect(t).not.toContain("v.event_id = c.event_id AND v.valid_to_seq IS NULL);"); // the rebuild self anti-join
  });

  it("does not drop/recreate the function or touch grants, tables, indexes or settings", () => {
    const code = read(M39).split("\n").filter((l) => !l.startsWith("--")).join("\n");
    expect(code).not.toMatch(/\b(DROP|GRANT|REVOKE|ALTER|CREATE (UNIQUE )?INDEX|CREATE TABLE|VACUUM|ANALYZE|NOTIFY)\b/);
    expect(code).not.toMatch(/set_config|SET (LOCAL )?(statement_timeout|lock_timeout|work_mem|enable_)/i);
  });
});

// ---------------------------------------------------------------------------
// The rehearsal: statement fidelity, pure proof checks, guard, coordinator
// ---------------------------------------------------------------------------

import {
  bodyHashes,
  checkRebuildPlan,
  checkVersionIntervals,
  FUNCTION_SQL,
  INSTALLED,
  PROOF_IDS,
  PROOF_SQL,
  publishBody,
  rehearseRebuildRepair,
  REPAIR_EXPLAIN_SQL,
  REPAIR_INSERT_SQL,
  repairGuard,
  type RepairCtx,
  type RepairDeps,
  type RepairEvidence,
  type VersionRow,
} from "../staging/reportingRebuildRepair";
import { runCaptureLifecycle } from "../staging/reportingCapture";
import { BACKEND_SAMPLE_SQL, compactSamples, compareFullState, i4Monitored, monitorBackends, newPublicationReport, parsePublicationArgs, publicationStatus, ROLLBACK_ONLY, type Db, type FullState, type InterleaveCtx, type Observation } from "../staging/reportingPublication";

const nrm = (s: string) => s.replace(/\s+/g, " ").trim();

describe("T13B2b-19: the rehearsal's EXPLAIN statement is the exact 0039 INSERT", () => {
  it("REPAIR_INSERT_SQL = 0039's rebuild INSERT with b.site/v_seq/p_batch bound as $1/$2/$3; EXPLAIN never ANALYZE", () => {
    const bound = nrm(NEW_REBUILD_INSERT).replace(/;$/, "").replace(/\bb\.site\b/g, "$1::text").replace(/\bv_seq\b/g, "$2::bigint").replace(/\bp_batch\b/g, "$3::uuid");
    expect(nrm(REPAIR_INSERT_SQL)).toBe(bound);
    expect(read(M39)).toContain(NEW_REBUILD_INSERT);
    expect(REPAIR_EXPLAIN_SQL.startsWith("EXPLAIN (VERBOSE, SETTINGS, FORMAT JSON) INSERT")).toBe(true);
    expect(REPAIR_EXPLAIN_SQL).not.toMatch(/analy[sz]e/i);
  });
  it("installed identities are pinned; the function body extractor finds 0038's and 0039's prosrc", () => {
    expect(INSTALLED["0037"]).toContain(shaLf(M37));
    expect(INSTALLED["0038"]).toContain(shaLf(M38));
    expect(INSTALLED["0038"]).toContain(shaCrlf(M38));
    const b38 = publishBody(read(M38));
    const b39 = publishBody(read(M39));
    expect(b38.startsWith("\n#variable_conflict use_column\nDECLARE")).toBe(true);
    expect(b38.replace(OLD_REBUILD_INSERT, NEW_REBUILD_INSERT)).toBe(b39);
    expect(bodyHashes(b38)).not.toEqual(bodyHashes(b39));
  });
});

const goodPlan = () => [{ Plan: { "Node Type": "ModifyTable", Operation: "Insert", "Relation Name": "source_versions", "Conflict Resolution": "NOTHING", "Conflict Arbiter Indexes": ["source_versions_current"], Plans: [{ "Node Type": "Index Scan", "Relation Name": "source_candidate" }] } }];
describe("T13B2b-19: checkRebuildPlan", () => {
  it("accepts the arbiter plan with only a candidate scan", () => expect(checkRebuildPlan(goodPlan())).toEqual([]));
  const breaks: Array<[string, (p: ReturnType<typeof goodPlan>) => void, RegExp]> = [
    ["the old anti-join", (p) => void (p[0].Plan.Plans = [{ "Node Type": "Nested Loop", "Join Type": "Anti", Plans: [{ "Node Type": "Seq Scan", "Relation Name": "source_candidate" }, { "Node Type": "Seq Scan", "Relation Name": "source_versions" }] } as never]), /anti-join remains.*|Seq Scan of source_versions remains/],
    ["an inner source_versions scan", (p) => void (p[0].Plan.Plans = [{ "Node Type": "Seq Scan", "Relation Name": "source_versions" }]), /Seq Scan of source_versions remains under the insert/],
    ["no conflict clause", (p) => void delete (p[0].Plan as Record<string, unknown>)["Conflict Resolution"], /conflict resolution is undefined/],
    ["another arbiter", (p) => void (p[0].Plan["Conflict Arbiter Indexes"] = ["source_versions_pkey"]), /expected \["source_versions_current"\]/],
    ["an untargeted (all-index) arbiter", (p) => void (p[0].Plan["Conflict Arbiter Indexes"] = ["source_versions_current", "source_versions_pkey"]), /expected \["source_versions_current"\]/],
    ["DO UPDATE", (p) => void (p[0].Plan["Conflict Resolution"] = "UPDATE"), /expected NOTHING/],
    ["not an insert", (p) => void (p[0].Plan.Operation = "Update"), /expected ModifyTable\/Insert/],
  ];
  for (const [name, mut, re] of breaks) it(`rejects ${name}`, () => { const p = goodPlan(); mut(p); expect(checkRebuildPlan(p).join("; ")).toMatch(re); });
  it("rejects no plan", () => expect(checkRebuildPlan([])).toEqual(["EXPLAIN returned no JSON plan"]));
});

describe("T13B2b-19: checkVersionIntervals (rebuild, not refresh)", () => {
  const before = { [PROOF_IDS.unchanged]: "hu", [PROOF_IDS.changed]: "hc1", [PROOF_IDS.absent]: "ha" };
  const after = { [PROOF_IDS.unchanged]: "hu", [PROOF_IDS.changed]: "hc2", [PROOF_IDS.created]: "hn" };
  const good = (): VersionRow[] => [
    { event_id: PROOF_IDS.absent, valid_from_seq: "10", valid_to_seq: "11", image_md5: "ha" },
    { event_id: PROOF_IDS.changed, valid_from_seq: "10", valid_to_seq: "11", image_md5: "hc1" },
    { event_id: PROOF_IDS.changed, valid_from_seq: "11", valid_to_seq: null, image_md5: "hc2" },
    { event_id: PROOF_IDS.created, valid_from_seq: "11", valid_to_seq: null, image_md5: "hn" },
    { event_id: PROOF_IDS.unchanged, valid_from_seq: "10", valid_to_seq: null, image_md5: "hu" },
  ];
  it("accepts exact intervals", () => expect(checkVersionIntervals(good(), PROOF_IDS, "10", "11", { before, after })).toEqual([]));
  const breaks: Array<[string, (r: VersionRow[]) => VersionRow[], RegExp]> = [
    ["an unchanged row reissued (closed and re-opened)", (r) => [...r.filter((x) => x.event_id !== PROOF_IDS.unchanged), { event_id: PROOF_IDS.unchanged, valid_from_seq: "10", valid_to_seq: "11", image_md5: "hu" }, { event_id: PROOF_IDS.unchanged, valid_from_seq: "11", valid_to_seq: null, image_md5: "hu" }], /rr-unchanged/],
    ["a changed row not closed (the conflict skipped its new image)", (r) => r.filter((x) => !(x.event_id === PROOF_IDS.changed && x.valid_from_seq === "11")).map((x) => (x.event_id === PROOF_IDS.changed ? { ...x, valid_to_seq: null } : x)), /rr-changed/],
    ["an absent row still current", (r) => r.map((x) => (x.event_id === PROOF_IDS.absent ? { ...x, valid_to_seq: null } : x)), /rr-absent/],
    ["a created row missing", (r) => r.filter((x) => x.event_id !== PROOF_IDS.created), /rr-created/],
    ["a wrong image", (r) => r.map((x) => (x.event_id === PROOF_IDS.unchanged ? { ...x, image_md5: "zz" } : x)), /rr-unchanged/],
  ];
  for (const [name, mut, re] of breaks) it(`rejects ${name}`, () => expect(checkVersionIntervals(mut(good()), PROOF_IDS, "10", "11", { before, after }).join("; ")).toMatch(re));
  it("rejects a source change that did not change the image", () => expect(checkVersionIntervals(good(), PROOF_IDS, "10", "11", { before, after: { ...after, [PROOF_IDS.changed]: "hc1" } }).join()).toMatch(/did not change its image/));
});

describe("T13B2b-19: the rehearsal guard", () => {
  const body = migrationBody(read(M39));
  const forbidden = ["commit", "end", "vacuum reporting_private.source_versions", "analyze", "checkpoint", "set statement_timeout = 0", "set lock_timeout = '1h'", "select set_config('statement_timeout', '0', true)", "select set_config('work_mem', '1GB', true)",
    "insert into supabase_migrations.schema_migrations (version) values ('0039')", "create index x on reporting_private.source_versions (site)", "drop function public.publish_reporting_batch(uuid, bigint)", "grant execute on function public.publish_reporting_batch(uuid, bigint) to anon",
    `EXPLAIN (ANALYZE, VERBOSE) ${REPAIR_INSERT_SQL}`, body[0].replace("DO NOTHING", "DO NOTHING ")];
  for (const sql of forbidden) {
    it(`refuses before sending: ${sql.slice(0, 50)}`, async () => {
      const sent: string[] = [];
      const raw: Db = { query: async (q: string) => (sent.push(q), { rows: [], rowCount: 0 }) };
      await expect(repairGuard(raw, new Set(body)).query(sql)).rejects.toThrow(/rebuild-repair rehearsal refuses/);
      expect(sent).toEqual([]);
    });
  }
  it("lets through the exact 0039 statement, role switching and the flow's ordinary SQL", async () => {
    const sent: string[] = [];
    const raw: Db = { query: async (q: string) => (sent.push(q), { rows: [], rowCount: 0 }) };
    const g = repairGuard(raw, new Set(body));
    for (const q of [body[0], "begin", "rollback", "savepoint rp_probe", "set local role service_role", "reset role", "select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', '', true)", "select * from public.publish_reporting_batch($1, $2)", REPAIR_EXPLAIN_SQL, PROOF_SQL.pkProbe]) await g.query(q);
    expect(sent).toHaveLength(10);
  });
});

// --- the coordinator, against a scripted database --------------------------------------------------------
type CFail = Partial<Record<"baselineNot38" | "already39" | "applyFails" | "verifyStill38" | "aclChanged" | "rollbackFails" | "noFunction" | "privileges", boolean>>;
function scripted(fail: CFail = {}) {
  const sent: string[] = [];
  let applied = false;
  const b38 = bodyHashes(publishBody(read(M38)))[0];
  const b39 = bodyHashes(publishBody(read(M39)))[0];
  const fn = () => ({ body_md5: fail.already39 ? b39 : fail.baselineNot38 ? "deadbeef" : applied && !fail.verifyStill38 ? b39 : b38, security_definer: false, config: '{"search_path=\\"\\""}', acl: applied && fail.aclChanged ? "{changed}" : "{service_role=X/postgres}", service_exec: true, authenticated_exec: !!fail.privileges, anon_exec: false, owner: "postgres" });
  const db: Db = {
    query: async (sql: string) => {
      sent.push(sql);
      if (sql === "rollback" && fail.rollbackFails) throw new Error("connection terminated");
      if (sql === FUNCTION_SQL) return fail.noFunction ? { rows: [], rowCount: 0 } : { rows: [fn()], rowCount: 1 };
      if (sql.startsWith("\nCREATE OR REPLACE FUNCTION") || sql.trimStart().startsWith("CREATE OR REPLACE FUNCTION")) {
        if (fail.applyFails) throw Object.assign(new Error("syntax error at or near \"ON\""), { code: "42601" });
        applied = true;
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { db, sent };
}
function repairCtx(over: Partial<RepairCtx> = {}): { ctx: RepairCtx; recorded: Observation[]; emitted: number } {
  const recorded: Observation[] = [];
  const box = { ctx: null as unknown as RepairCtx, recorded, emitted: 0 };
  box.ctx = {
    sites: ["uk", "us"], maxPages: 200, staff: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", as: async () => undefined, record: (o) => void recorded.push(o), redact: (s) => s, now: () => 0,
    emit: () => void box.emitted++, ...over,
  };
  return box;
}
function deps(calls: string[], over: Partial<RepairDeps> = {}): RepairDeps {
  return { read: (p) => readFileSync(p), flow: async () => void calls.push("flow"), proof: async (_c, _x, ev: RepairEvidence) => { calls.push("proof"); ev.proof.site = "uk"; }, ...over };
}

describe("T13B2b-19: the rehearsal coordinator", () => {
  it("success: identity -> baseline -> BEGIN -> 0039 -> verify -> flow -> proof -> ROLLBACK; never COMMIT", async () => {
    const s = scripted();
    const t = repairCtx();
    const calls: string[] = [];
    const ev = await rehearseRebuildRepair(s.db, t.ctx, deps(calls));
    expect(calls).toEqual(["flow", "proof"]);
    expect(s.sent[0]).toBe(FUNCTION_SQL); // the baseline read is before BEGIN
    expect(s.sent[1]).toBe("begin");
    expect(s.sent[2].trimStart().startsWith("CREATE OR REPLACE FUNCTION public.publish_reporting_batch(")).toBe(true);
    expect(s.sent[3]).toBe(FUNCTION_SQL);
    expect(s.sent.at(-1)).toBe("rollback");
    expect(s.sent.some((q) => /^\s*commit\b/i.test(q))).toBe(false);
    expect(ev.statementsApplied).toBe(1);
    expect(ev.files.map((f) => f.path)).toEqual([M37, M38, M39]);
    expect(t.recorded.map((o) => `${o.id}:${o.ok}`)).toEqual(["K0:true", "K1:true", "K2:true", "K3:true", "K9:true"]);
    expect(t.emitted).toBeGreaterThanOrEqual(4);
  });

  const refusals: Array<[string, CFail | null, Partial<RepairDeps>, RegExp, boolean]> = [
    ["the installed publisher is not 0038", { baselineNot38: true }, {}, /K1 failed/, false],
    ["0039 is already installed", { already39: true }, {}, /K1 failed/, false],
    ["the publisher is missing", { noFunction: true }, {}, /K1 failed/, false],
    ["unexpected privileges", { privileges: true }, {}, /K1 failed/, false],
    ["0038 file is not the installed identity", null, { read: (p) => (p === M38 ? Buffer.from(read(M38).replace("Part A", "Part X")) : readFileSync(p)) }, /K0 failed/, false],
    ["0039 has more than the one statement", null, { read: (p) => (p === M39 ? Buffer.from(read(M39).replace("COMMIT;", "SELECT 1;\nCOMMIT;")) : readFileSync(p)) }, /K0 failed/, false],
  ];
  for (const [name, fail, dep, re] of refusals) {
    it(`refuses BEFORE BEGIN when ${name}`, async () => {
      const s = scripted(fail ?? {});
      const calls: string[] = [];
      await expect(rehearseRebuildRepair(s.db, repairCtx().ctx, deps(calls, dep))).rejects.toThrow(re);
      expect(s.sent).not.toContain("begin");
      expect(s.sent.some((q) => q.includes("CREATE OR REPLACE"))).toBe(false);
      expect(calls).toEqual([]);
    });
  }

  const inside: Array<[string, CFail, Partial<RepairDeps>, RegExp, string[]]> = [
    ["applying 0039 fails", { applyFails: true }, {}, /K2 failed/, []],
    ["the function is still 0038 after applying", { verifyStill38: true }, {}, /K3 failed/, []],
    ["the privileges changed", { aclChanged: true }, {}, /K3 failed/, []],
    ["the established flow fails", {}, { flow: async () => { throw new Error("F9j failed; later steps depend on it"); } }, /F9j failed/, []],
    ["the proof fails", {}, { proof: async () => { throw new Error("V4 failed; later steps depend on it"); } }, /V4 failed/, ["flow"]],
  ];
  for (const [name, fail, dep, re, wantCalls] of inside) {
    it(`stops and ALWAYS rolls back when ${name}`, async () => {
      const s = scripted(fail);
      const calls: string[] = [];
      await expect(rehearseRebuildRepair(s.db, repairCtx().ctx, deps(calls, dep))).rejects.toThrow(re);
      expect(s.sent.at(-1)).toBe("rollback");
      expect(s.sent.some((q) => /^\s*commit\b/i.test(q))).toBe(false);
      expect(calls).toEqual(wantCalls);
    });
  }

  it("a persistence (emit) failure stops and still rolls back", async () => {
    const s = scripted();
    let n = 0;
    const t = repairCtx({ emit: () => { if (++n === 3) throw new Error("ENOSPC"); } }); // 1 K0, 2 K1, 3 K3 (inside the transaction)
    await expect(rehearseRebuildRepair(s.db, t.ctx, deps([]))).rejects.toThrow(/K3 failed/);
    expect(s.sent.at(-1)).toBe("rollback");
  });

  it("a rollback failure after an earlier failure is kept BESIDE it", async () => {
    const s = scripted({ applyFails: true, rollbackFails: true });
    await expect(rehearseRebuildRepair(s.db, repairCtx().ctx, deps([]))).rejects.toThrow(/^K2 failed; later steps depend on it; cleanup failed: rehearsal rollback: connection terminated$/);
  });

  for (const [name, fail, dep, change] of [["success", {}, {}, false], ["a proof failure", {}, { proof: async () => { throw new Error("V5 failed"); } }, false], ["an unexpected change", {}, {}, true]] as const) {
    it(`inside the actual lifecycle (${name}): main rolled back and closed, a fresh ZERO-change audit`, async () => {
      const report = newPublicationReport("rehearse-rebuild-repair", ["uk", "us"], "rev", "t0", "sha");
      const st = (x: string): FullState => ({ surfaces: { "function:public.publish_reporting_batch": x }, privateTables: {}, control: { capture_epoch: "13", capture_enabled: false, rule_version: "r", updated_at: "t" }, siteState: [] });
      const conns: Array<{ s: ReturnType<typeof scripted>; ended: boolean }> = [];
      await runCaptureLifecycle(report, {
        open: async () => { const s = scripted(fail); const o = { s, ended: false }; conns.push(o); return { query: s.db.query, end: async () => void (o.ended = true) }; },
        body: async (main) => { await rehearseRebuildRepair(main as unknown as Db, repairCtx({ record: (o) => void report.observations.push(o), emit: (ev) => void (report.repair = ev as unknown as Record<string, unknown>) }).ctx, deps([], dep as Partial<RepairDeps>)); },
        audit: async () => compareFullState(st("0038"), st(change ? "0039" : "0038"), ROLLBACK_ONLY),
        save: () => undefined, now: () => "t1", redact: (x) => x, stderr: () => undefined,
      });
      expect(conns).toHaveLength(2);
      expect(conns.every((o) => o.ended)).toBe(true);
      expect(conns[0].s.sent.includes("rollback")).toBe(true);
      expect(conns[0].s.sent.some((q) => /^\s*commit\b/i.test(q))).toBe(false);
      if (name === "success") expect(publicationStatus(report)).toBe("STATUS: COMPLETE");
      else expect(publicationStatus(report)).toMatch(/^STATUS: FAILED/);
      if (change) expect(report.restorationProblems.join()).toMatch(/function:public\.publish_reporting_batch differs/);
    });
  }

  it("--rehearse-rebuild-repair takes --sites=A,B; the runner takes the baseline first and audits with ROLLBACK_ONLY", () => {
    expect(parsePublicationArgs(["--rehearse-rebuild-repair", "--sites=uk,us"])).toMatchObject({ mode: "rehearse-rebuild-repair", sites: ["uk", "us"], problems: [] });
    expect(parsePublicationArgs(["--rehearse-rebuild-repair", "--site=uk"]).mode).toBeNull();
    const runner = read("tests/staging/reporting-jobs.ts");
    const pub = runner.slice(runner.indexOf("async function publicationMain"), runner.indexOf("async function main()"));
    expect(pub.indexOf("before = await fullState(main);")).toBeLessThan(pub.indexOf('if (mode === "rehearse-rebuild-repair") {'));
    expect(pub).toMatch(/await rehearseRebuildRepair\(main, \{ sites, maxPages, staff, as, record, redact: redactSecrets, now: \(\) => performance\.now\(\), emit: \(ev\) => \{ report\.repair = ev as unknown as Record<string, unknown>; save\(\); \} \}\);\n\s+return;/);
    expect(pub).toMatch(/if \(mode !== "rehearse-migration" && mode !== "baseline-smoke" && !installed\) throw/); // needs installed 0038
    expect(pub).toMatch(/const allow = mode === "committed-interleavings" && own \? committedAllowance\(own\) : ROLLBACK_ONLY;/);
  });
});

// ---------------------------------------------------------------------------
// Monitored I4: exact PIDs, bounded sampling, sticky monitor failure, no stranded publication
// ---------------------------------------------------------------------------

describe("T13B2b-19: monitored I4", () => {
  const ictx = (): InterleaveCtx => {
    let t = 0;
    return { sites: ["uk", "us"], staff: "s", open: async () => { throw new Error("unused"); }, as: async () => undefined, record: () => undefined, redact: (s) => s, now: () => (t += 10), sleep: () => new Promise<void>((r) => setTimeout(r, 0)), maxPages: 1 }; // yields, so a timer can settle a job
  };
  const deferred = <T>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const p = new Promise<T>((a, b) => ((resolve = a), (reject = b))); return { p, resolve, reject }; };
  const worker = (pid: number) => { const log: string[] = []; return { log, db: { query: async (q: string) => (log.push(q), q.startsWith("select pg_backend_pid()") ? { rows: [{ p: pid }], rowCount: 1 } : { rows: [], rowCount: 0 }) } as Db }; };

  it("success: PIDs are read inside each explicit transaction BEFORE publishing; only those PIDs are sampled; sampling stops when both settle", async () => {
    const a = worker(101);
    const b = worker(202);
    const jobs = [deferred<string>(), deferred<string>()];
    const monLog: Array<{ q: string; p?: unknown[] }> = [];
    let polls = 0;
    const mon: Db = { query: async (q: string, p?: unknown[]) => { monLog.push({ q, p }); if (++polls === 3) { jobs[0].resolve("ok"); jobs[1].resolve("ok"); } return { rows: [{ pid: 101, state: "active", wait_event_type: "Lock", wait_event: "transactionid", blocking: [202], xact_ms: "5" }, { pid: 202, state: "active", wait_event_type: null, wait_event: null, blocking: [], xact_ms: "5" }], rowCount: 2 }; } };
    let started = 0;
    const r = await i4Monitored(ictx(), a.db, b.db, mon, (c) => { started++; expect((c === a.db ? a : b).log).toEqual(["begin", "select pg_backend_pid() as p"]); return jobs[started - 1].p; });
    expect(r.ok).toBe(true);
    expect(monLog.every((m) => m.q === BACKEND_SAMPLE_SQL && JSON.stringify(m.p) === "[[101,202]]")).toBe(true);
    expect(monLog.length).toBe(3);
    expect(BACKEND_SAMPLE_SQL).not.toMatch(/\bquery\b|application_name/);
    const ev = JSON.parse(r.result.slice(r.result.indexOf("monitor: ") + 9));
    expect(ev.pids).toEqual({ uk: 101, us: 202 });
    expect(ev.samples).toEqual([
      expect.objectContaining({ pid: 101, wait_event_type: "Lock", wait_event: "transactionid", blocking: [202], n: 3 }),
      expect.objectContaining({ pid: 202, state: "active", wait_event_type: null, n: 3 }),
    ]);
  });

  it("a publication failure: both outcomes returned (no stranding), I4 fails with the SQL error kept", async () => {
    const jobs = [deferred<string>(), deferred<string>()];
    let polls = 0;
    const mon: Db = { query: async () => { if (++polls === 2) { jobs[0].reject(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })); jobs[1].resolve("ok"); } return { rows: [], rowCount: 0 }; } };
    let i = 0;
    const r = await i4Monitored(ictx(), worker(1).db, worker(2).db, mon, () => jobs[i++].p);
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/^uk: 57014 canceling statement due to statement timeout; us: published; monitor: /);
  });

  it("a monitor failure is sticky: sampling stops, the pending publications are still awaited, I4 fails", async () => {
    const jobs = [deferred<string>(), deferred<string>()];
    let polls = 0;
    const mon: Db = { query: async () => { if (++polls === 2) { setTimeout(() => { jobs[0].resolve("ok"); jobs[1].resolve("ok"); }, 5); throw new Error("monitor connection lost"); } return { rows: [], rowCount: 0 }; } };
    let i = 0;
    const r = await i4Monitored(ictx(), worker(1).db, worker(2).db, mon, () => jobs[i++].p);
    expect(polls).toBe(2);
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/^uk: published; us: published; monitor: .*"monitorError":"monitor failed: monitor connection lost"/);
  });

  it("the sampling is bounded: after maxSamples it stops and still awaits the jobs", async () => {
    const jobs = [deferred<string>()];
    let polls = 0;
    const mon: Db = { query: async () => { if (++polls === 4) setTimeout(() => jobs[0].resolve("late"), 5); return { rows: [], rowCount: 0 }; } };
    const m = await monitorBackends(mon, [1], [jobs[0].p], ictx(), { maxSamples: 4 });
    expect(polls).toBe(4);
    expect(m.exhausted).toBe(true); // T13B2b-21: still pending at the bound
    expect(m.monitorError).toBe("monitor exhausted: 4 samples taken while 1 job(s) were still pending");
    expect(m.outcomes).toEqual([{ ok: true, v: "late" }]);
  });

  it("an already-rejected job never surfaces as an unhandled rejection", async () => {
    const seen: unknown[] = [];
    const h = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", h);
    try {
      const m = await monitorBackends({ query: async () => ({ rows: [], rowCount: 0 }) }, [1], [Promise.reject(new Error("x"))], ictx());
      await new Promise((r) => setTimeout(r, 10));
      expect(m.outcomes[0].ok).toBe(false);
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", h);
    }
  });

  it("compactSamples collapses consecutive identical samples per PID", () => {
    const s = (t: number, pid: number, w: string | null) => ({ t, pid, state: "active", wait_event_type: w, wait_event: null, blocking: [], xact_ms: t });
    expect(compactSamples([s(0, 1, null), s(10, 1, null), s(20, 1, "Lock"), s(30, 1, null)]).map((x) => `${x.t}-${x.until}:${x.wait_event_type}:${x.n}`)).toEqual(["0-10:null:2", "20-20:Lock:1", "30-30:null:1"]);
  });

  it("I4 uses the monitored helper on three connections (two workers + an independent monitor)", () => {
    const pub = read("tests/staging/reportingPublication.ts");
    expect(pub).toMatch(/withConnections\(ctx, 3, async \(\[a, b, mon\]\) => i4Monitored\(ctx, a, b, mon, \(c, site\) => zeroWorkRebuild\(c, ctx, site\)\), cleanupFailures\)\);/);
  });
});

// ---------------------------------------------------------------------------
// T13B2b-20: fail-fast recorder (persist the original observation, then stop)
// ---------------------------------------------------------------------------

import { failFast, runConstraintProbes } from "../staging/reportingRebuildRepair";
import { expectEqual, type FlowCtx } from "../staging/reportingPublication";

describe("T13B2b-20: the rehearsal stops at the first RECORDED failure", () => {
  it("a flow assertion that records ok:false (and would otherwise return) stops the rehearsal: the proof never begins, the observation is persisted, outer ROLLBACK", async () => {
    const s = scripted();
    const t = repairCtx();
    const calls: string[] = [];
    const flow = async (_c: Db, x: FlowCtx) => {
      calls.push("flow");
      expectEqual(x, "F9j", "source, mirror and current versions are the same set", { problems: ["rp-v6 is in source but missing from versions"] }, { problems: [] });
      calls.push("flow continued after a failed assertion");
    };
    await expect(rehearseRebuildRepair(s.db, t.ctx, deps(calls, { flow }))).rejects.toThrow(/^F9j failed; later steps depend on it$/);
    expect(calls).toEqual(["flow"]); // neither the rest of the flow nor the proof ran
    expect(t.recorded.find((o) => o.id === "F9j")).toMatchObject({ ok: false, result: '{"problems":["rp-v6 is in source but missing from versions"]}' }); // original evidence persisted first
    expect(s.sent.at(-1)).toBe("rollback");
    expect(s.sent.some((q) => /^\s*commit\b/i.test(q))).toBe(false);
  });

  it("a proof assertion that records ok:false stops before any further publication", async () => {
    const s = scripted();
    const calls: string[] = [];
    const proof = async (c: Db, x: FlowCtx) => {
      calls.push("proof");
      expectEqual(x, "V5x", "whole-site check", 1, 0);
      await c.query("select * from public.publish_reporting_batch($1, $2)", ["b", 1]); // must never be sent
    };
    await expect(rehearseRebuildRepair(s.db, repairCtx().ctx, deps(calls, { proof }))).rejects.toThrow(/^V5x failed/);
    expect(s.sent).not.toContain("select * from public.publish_reporting_batch($1, $2)"); // the publish call was never sent
    expect(s.sent.at(-1)).toBe("rollback");
  });

  // V7 through the REAL refused() path, inside the rehearsal (outer rollback) and directly (savepoint order).
  function probeDb(v7a: "succeeds" | "wrong-error" | "right-error") {
    const sent: string[] = [];
    const base = scripted();
    const db: Db = {
      query: async (q: string, p?: unknown[]) => {
        sent.push(q);
        if (q === PROOF_SQL.pkProbe) {
          if (v7a === "succeeds") return { rows: [], rowCount: 1 };
          throw Object.assign(new Error(v7a === "wrong-error" ? "permission denied for table source_versions" : 'duplicate key value violates unique constraint "source_versions_pkey"'), { code: v7a === "wrong-error" ? "42501" : "23505" });
        }
        if (q === PROOF_SQL.checkProbe) throw Object.assign(new Error('new row for relation "source_versions" violates check constraint "source_versions_check1"'), { code: "23514" });
        return base.db.query(q, p);
      },
    };
    return { db, sent };
  }
  for (const v7a of ["succeeds", "wrong-error"] as const) {
    it(`V7a ${v7a === "succeeds" ? "unexpectedly succeeds" : "fails with the wrong error"}: its savepoint is rolled back and released, V7b is NOT sent, the outer transaction rolls back`, async () => {
      const p = probeDb(v7a);
      const t = repairCtx();
      await expect(rehearseRebuildRepair(p.db, t.ctx, deps([], { proof: (c, x) => runConstraintProbes(c, x, "uk") }))).rejects.toThrow(/^V7a failed; later steps depend on it$/);
      const i = p.sent.indexOf(PROOF_SQL.pkProbe);
      expect(p.sent.slice(i - 1, i + 3)).toEqual(["savepoint rp_probe", PROOF_SQL.pkProbe, "rollback to savepoint rp_probe", "release savepoint rp_probe"]);
      expect(p.sent).not.toContain(PROOF_SQL.checkProbe);
      expect(p.sent.at(-1)).toBe("rollback");
      expect(t.recorded.find((o) => o.id === "V7a")).toMatchObject({ ok: false, result: v7a === "succeeds" ? "succeeded (expected a refusal)" : "42501 permission denied for table source_versions" });
    });
  }
  it("V7a and V7b both raising as expected pass, each in its own cleaned-up savepoint", async () => {
    const p = probeDb("right-error");
    const t = repairCtx();
    await rehearseRebuildRepair(p.db, t.ctx, deps([], { proof: (c, x) => runConstraintProbes(c, x, "uk") }));
    expect(t.recorded.filter((o) => o.id.startsWith("V7")).map((o) => `${o.id}:${o.ok}`)).toEqual(["V7a:true", "V7b:true"]);
    expect(p.sent.filter((q) => q === "release savepoint rp_probe")).toHaveLength(2);
  });

  it("a persistence failure while recording stays fatal (and the outer transaction rolls back)", async () => {
    const s = scripted();
    let n = 0;
    const t = repairCtx({ record: () => { if (++n === 4) throw new Error("ENOSPC"); } }); // K0, K1, K2 ok; K3's record fails
    await expect(rehearseRebuildRepair(s.db, t.ctx, deps([]))).rejects.toThrow(/K3 failed|ENOSPC/);
    expect(s.sent.at(-1)).toBe("rollback");
  });

  it("failFast persists the observation BEFORE throwing; passing observations pass through", () => {
    const seen: string[] = [];
    const ctx = failFast({ record: (o: Observation) => void seen.push(`${o.id}:${o.ok}`) });
    ctx.record({ id: "A", what: "", expected: "", result: "", ok: true, ms: 0 });
    expect(() => ctx.record({ id: "B", what: "", expected: "", result: "x", ok: false, ms: 0 })).toThrow("B failed; later steps depend on it");
    expect(seen).toEqual(["A:true", "B:false"]);
  });
});

// ---------------------------------------------------------------------------
// T13B2b-21: monitor exhaustion and exact-PID coverage are I4 failures
// ---------------------------------------------------------------------------

describe("T13B2b-21: I4 does not pass without monitoring coverage", () => {
  const ictx2 = (): InterleaveCtx => {
    let t = 0;
    return { sites: ["uk", "us"], staff: "s", open: async () => { throw new Error("unused"); }, as: async () => undefined, record: () => undefined, redact: (s) => s, now: () => (t += 10), sleep: () => new Promise<void>((r) => setTimeout(r, 0)), maxPages: 1 };
  };
  const deferred2 = <T>() => { let resolve!: (v: T) => void; const p = new Promise<T>((a) => (resolve = a)); return { p, resolve }; };
  const w = (pid: number) => ({ query: async (q: string) => (q.startsWith("select pg_backend_pid()") ? { rows: [{ p: pid }], rowCount: 1 } : { rows: [], rowCount: 0 }) }) as Db;
  const both = [{ pid: 101, state: "active", wait_event_type: null, wait_event: null, blocking: [], xact_ms: "1" }, { pid: 202, state: "active", wait_event_type: null, wait_event: null, blocking: [], xact_ms: "1" }];

  it("exhausted with jobs pending, then BOTH publications succeed: I4 still FAILS (sticky), and both jobs were awaited", async () => {
    const jobs = [deferred2<string>(), deferred2<string>()];
    let polls = 0;
    const mon: Db = { query: async () => { if (++polls === 3) setTimeout(() => { jobs[0].resolve("ok"); jobs[1].resolve("ok"); }, 5); return { rows: both, rowCount: 2 }; } };
    let i = 0;
    const r = await i4Monitored(ictx2(), w(101), w(202), mon, () => jobs[i++].p, { maxSamples: 3 });
    expect(polls).toBe(3);
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/^uk: published; us: published; monitor: /);
    const ev = JSON.parse(r.result.slice(r.result.indexOf("monitor: ") + 9));
    expect(ev.exhausted).toBe(true);
    expect(ev.monitorError).toBe("monitor exhausted: 3 samples taken while 2 job(s) were still pending");
  });

  it("completing exactly at the limit is NOT exhaustion", async () => {
    const jobs = [deferred2<string>(), deferred2<string>()];
    let polls = 0;
    const mon: Db = { query: async () => { if (++polls === 3) { jobs[0].resolve("ok"); jobs[1].resolve("ok"); } return { rows: both, rowCount: 2 }; } };
    let i = 0;
    const r = await i4Monitored(ictx2(), w(101), w(202), mon, () => jobs[i++].p, { maxSamples: 3 });
    expect(polls).toBe(3);
    const ev = JSON.parse(r.result.slice(r.result.indexOf("monitor: ") + 9));
    expect(ev.exhausted).toBe(false);
    expect(ev.monitorError).toBeNull();
    expect(r.ok).toBe(true);
  });

  it("a pinned PID never observed is an explicit failure, even when both publish", async () => {
    const jobs = [deferred2<string>(), deferred2<string>()];
    let polls = 0;
    const mon: Db = { query: async () => { if (++polls === 2) { jobs[0].resolve("ok"); jobs[1].resolve("ok"); } return { rows: [both[0]], rowCount: 1 }; } }; // only pid 101
    let i = 0;
    const r = await i4Monitored(ictx2(), w(101), w(202), mon, () => jobs[i++].p);
    expect(r.ok).toBe(false);
    const ev = JSON.parse(r.result.slice(r.result.indexOf("monitor: ") + 9));
    expect(ev.uncovered).toEqual([202]);
    expect(ev.monitorError).toBe("monitor coverage missing: no sample observed for pid(s) 202");
  });

  it("no rows at all (both PIDs uncovered) fails; every job is settled on every path", async () => {
    for (const mode of ["empty", "throws", "exhausted"] as const) {
      const jobs = [deferred2<string>(), deferred2<string>()];
      let polls = 0;
      const mon: Db = { query: async () => {
        polls++;
        if (mode === "throws" && polls === 1) { setTimeout(() => { jobs[0].resolve("a"); jobs[1].resolve("b"); }, 5); throw new Error("monitor lost"); }
        if (mode === "exhausted" && polls === 2) setTimeout(() => { jobs[0].resolve("a"); jobs[1].resolve("b"); }, 5);
        if (mode === "empty" && polls === 2) { jobs[0].resolve("a"); jobs[1].resolve("b"); }
        return { rows: [], rowCount: 0 };
      } };
      const m = await monitorBackends(mon, [101, 202], [jobs[0].p, jobs[1].p], ictx2(), { maxSamples: 2 });
      expect(m.outcomes, mode).toEqual([{ ok: true, v: "a" }, { ok: true, v: "b" }]);
      expect(m.monitorError, mode).toMatch(mode === "throws" ? /^monitor failed: monitor lost$/ : mode === "exhausted" ? /^monitor exhausted/ : /^monitor coverage missing: no sample observed for pid\(s\) 101, 202$/);
    }
  });
});
