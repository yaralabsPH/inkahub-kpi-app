/**
 * The four-case collector (`--policy-parity=cases`, Task 4 M6 amendment)
 * against a fake database that models transactions, savepoints, memberships
 * and the two policy sets. No real database or network.
 */
import { describe, expect, it } from "vitest";
import { collectCaseParity, PRE_0036_RESTORE, type QueryClient } from "./policyParityRun";
import { PRE_0036_RESTORE as WRITE_COMPAT_RESTORE } from "./writeCompatRun";
import { casesModeArgProblems, caseParityMarkdown, caseParityProblems, PARITY_CASES, STANDARD_MEMBERSHIPS, type CaseUser } from "./itemCountingParityCases";
import { claimsSetting } from "./generate-query-evidence";
import { policyHash } from "./itemCountingPolicyParity";
import { claimsSources, POST_POLICY_HASH, postPolicies, prePolicies, sessionClaims } from "./gateTestFixtures";

const USERS: CaseUser[] = ["owner", "manager", "staff", "kiosk", "cs"];
const CLAIMS = Object.fromEntries(USERS.map((u) => [u, JSON.stringify(sessionClaims(u))]));
const UID = Object.fromEntries(USERS.map((u) => [u, String(sessionClaims(u).sub)])) as Record<CaseUser, string>;
const ROLE_BY_SETTING = new Map([...USERS, "no-subject"].map((r) => [claimsSetting(r), r]));
const PRE_HASH = policyHash(prePolicies()).hash;

interface State {
  memberships: Map<string, Set<string>>;
  policy: "pre" | "post";
}
const copy = (s: State): State => ({ memberships: new Map([...s.memberships].map(([k, v]) => [k, new Set(v)])), policy: s.policy });

/** A small model of the staging database, enough for the collector's statements. */
class FakeDb implements QueryClient {
  state: State = {
    memberships: new Map(USERS.map((u) => [UID[u], new Set(STANDARD_MEMBERSHIPS[u])])),
    policy: "post",
  };
  inTx = false;
  base: State | null = null;
  savepoints: Array<{ name: string; snap: State }> = [];
  role: "postgres" | "authenticated" = "postgres";
  settings = new Map<string, string>();
  claimsRole: string | null = null;
  timeoutApplied = false;
  log: Array<{ sql: string; inTx: boolean; policy: string }> = [];
  /** Inject a failure (return an Error) or a different pre-0036 result. */
  failWhen: (sql: string, params: unknown[], db: FakeDb) => Error | undefined = () => undefined;
  preRowSuffix = "";
  onRollback: (db: FakeDb) => void = () => {};
  rollbackFails = false;

  async query(raw: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount?: number }> {
    const sql = raw.trim().replace(/\s+/g, " ");
    this.log.push({ sql, inTx: this.inTx, policy: this.state.policy });
    const err = this.failWhen(sql, params, this);
    if (err) throw err;
    const ok = { rows: [{ ok: true }] };
    if (/^begin/.test(sql)) {
      this.inTx = true;
      this.base = copy(this.state);
      return ok;
    }
    if (sql === "rollback") {
      if (this.rollbackFails) throw new Error("connection terminated");
      this.state = this.base ?? this.state;
      this.inTx = false;
      this.savepoints = [];
      this.settings.clear();
      this.role = "postgres";
      this.onRollback(this);
      return ok;
    }
    if (/^commit/.test(sql)) throw new Error("the collector must never commit");
    let m = /^savepoint (\w+)$/.exec(sql);
    if (m) {
      this.savepoints.push({ name: m[1], snap: copy(this.state) });
      return ok;
    }
    m = /^release savepoint (\w+)$/.exec(sql);
    if (m) {
      const i = this.savepoints.map((s) => s.name).lastIndexOf(m[1]);
      this.savepoints.splice(i);
      return ok;
    }
    m = /^rollback to savepoint (\w+)$/.exec(sql);
    if (m) {
      const i = this.savepoints.map((s) => s.name).lastIndexOf(m[1]);
      if (i < 0) throw new Error(`no savepoint ${m[1]}`);
      this.state = copy(this.savepoints[i].snap);
      this.savepoints.splice(i + 1);
      return ok;
    }
    if (sql === "reset role") {
      this.role = "postgres";
      return ok;
    }
    if (sql === "set local role authenticated") {
      this.role = "authenticated";
      this.timeoutApplied = false;
      return ok;
    }
    if (sql.startsWith("do $$")) {
      this.timeoutApplied = true;
      return ok;
    }
    if (sql.startsWith("select set_config($1, $2, true)")) {
      this.settings.set(String(params[0]), String(params[1]));
      return ok;
    }
    if (sql.startsWith("select set_config('request.jwt.claims', current_setting($1)")) {
      this.claimsRole = ROLE_BY_SETTING.get(String(params[0])) ?? null;
      return ok;
    }
    if (sql.startsWith("select set_config('request.jwt.claim.sub'") || sql.startsWith("select set_config('search_path'")) return ok;
    if (sql === "select current_setting('search_path') as p") return { rows: [{ p: '"$user", public, extensions' }] };
    if (sql.includes("from pg_catalog.pg_policies")) return { rows: (this.state.policy === "pre" ? prePolicies() : postPolicies()).map((r) => ({ ...r })) };
    if (sql.startsWith("select (select md5(string_agg(n.nspname")) {
      return { rows: [{ helpers: "h", rls_flags: "production_events=true/false", table_grants: "g", role_configs: "c", evidence_functions: "f", user_locations_policies: "u" }] };
    }
    if (sql.includes("count(*)::text || ':' || md5")) return { rows: [{ location: "au", fp: "5:a" }, { location: "uk", fp: "5:b" }, { location: "us", fp: "5:c" }] };
    if (sql.includes("min(created_at) as lo")) return { rows: [{ lo: "2026-09-02T00:00:00Z", hi: "2026-09-20T00:00:00Z" }] };
    if (sql.includes("from public.user_locations where user_id = any")) {
      const ids = params[0] as string[];
      return { rows: ids.flatMap((id) => [...(this.state.memberships.get(id) ?? [])].map((location) => ({ u: id, location }))) };
    }
    if (sql.includes("staff_id is distinct from $1::uuid group by location")) return { rows: [{ location: "au", n: 3 }, { location: "uk", n: 5 }] };
    if (sql.startsWith("insert into public.user_locations")) {
      this.state.memberships.get(String(params[0]))!.add(String(params[1]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("delete from public.user_locations")) {
      const had = this.state.memberships.get(String(params[0]))!.delete(String(params[1]));
      return { rows: [], rowCount: had ? 1 : 0 };
    }
    if (sql.startsWith("set local search_path = public") || sql.startsWith("drop policy")) return ok;
    if (sql.startsWith("create policy production_events_select")) {
      this.state.policy = "pre";
      return ok;
    }
    if (sql.startsWith("create policy")) return ok;
    if (sql.includes("as profile_role")) {
      const r = this.claimsRole;
      const uid = r && r !== "no-subject" ? UID[r as CaseUser] : null;
      return { rows: [{ profile_role: uid ? r : null, memberships: uid ? [...this.state.memberships.get(uid)!].sort().join(",") || null : null, claims_bytes: Buffer.byteLength(this.settings.get(claimsSetting(r ?? "")) ?? "") }] };
    }
    if (sql.startsWith("select current_user as u")) {
      return { rows: [{ u: this.role, rls: "on", t: this.timeoutApplied ? "8s" : "0", bypass: false }] };
    }
    if (sql.includes("as k, (staff_id is distinct from")) {
      if (this.role !== "authenticated") throw new Error("role reads must run as authenticated");
      return { rows: params[1] === "-infinity" ? this.visible(String(params[0])).map((id) => ({ k: `${params[0]}|${id}`, foreign_row: this.claimsRole !== "staff" })) : [] };
    }
    if (sql.startsWith("select id from public.production_events where location = $1 and (")) {
      return { rows: this.visible(String(params[0])).map((id) => ({ id })) };
    }
    throw new Error(`unexpected statement: ${sql.slice(0, 80)}`);
  }

  private visible(site: string): string[] {
    const r = this.claimsRole;
    if (!r || r === "no-subject" || site === "staging") return [];
    if (!this.state.memberships.get(UID[r as CaseUser])!.has(site)) return [];
    return [`${r}-1${this.state.policy === "pre" ? this.preRowSuffix : ""}`];
  }
}

const opts = (over: Partial<Parameters<typeof collectCaseParity>[1]> = {}) => ({
  revision: "rev", claimsText: CLAIMS, baselinePolicyHash: PRE_HASH, expectedInstalledHash: POST_POLICY_HASH, log: () => {},
  newId: () => "coll-1", now: () => "2026-11-14T00:00:00Z", ...over,
});
const standard = (db: FakeDb) => USERS.every((u) => [...db.state.memberships.get(UID[u])!].sort().join(",") === [...STANDARD_MEMBERSHIPS[u]].sort().join(","));
const rollbacks = (db: FakeDb) => db.log.filter((x) => x.sql === "rollback").length;

describe("collectCaseParity (review r1 M6)", () => {
  it("collects all four cases in one rolled-back transaction and passes the full gate", async () => {
    const db = new FakeDb();
    const coll = await collectCaseParity(db, opts());
    expect(coll.problems).toEqual([]);
    expect(coll.cases.map((c) => c.case)).toEqual([...PARITY_CASES]);
    expect(coll.restoration).toMatchObject({ passed: true, problems: [] });
    expect(caseParityProblems(PRE_HASH, coll, claimsSources())).toEqual([]);
    // One transaction, REPEATABLE READ first, exactly one outer ROLLBACK, never a commit.
    expect(db.log[0].sql).toBe("begin isolation level repeatable read");
    expect(db.log.filter((x) => /^begin/.test(x.sql))).toHaveLength(1);
    expect(rollbacks(db)).toBe(1);
    expect(db.log.some((x) => /commit|schema_migrations|apply_migration/i.test(x.sql))).toBe(false);
    // Each case: its own savepoint, a nested restore that is rolled back, and the case rolled back.
    expect(db.log.filter((x) => x.sql === "rollback to savepoint parity_pre")).toHaveLength(4);
    expect(db.log.filter((x) => x.sql === "rollback to savepoint parity_case")).toHaveLength(4);
    // Installed reads come before the restore, and restored reads see the pre-0036 policies.
    const firstRestore = db.log.findIndex((x) => x.sql.startsWith("drop policy"));
    expect(db.log.slice(0, firstRestore).some((x) => x.sql.includes("as k, (staff_id"))).toBe(true);
    expect(db.log.filter((x) => x.sql.includes("as k, (staff_id") && x.policy === "pre").length).toBeGreaterThan(0);
    // The restoration check runs after ROLLBACK, outside the transaction.
    const rb = db.log.findIndex((x) => x.sql === "rollback");
    const after = db.log.slice(rb + 1);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((x) => !x.inTx)).toBe(true);
    expect(after.some((x) => x.sql.includes("from public.user_locations where user_id = any"))).toBe(true);
    expect(standard(db)).toBe(true);
    expect(db.state.policy).toBe("post");
  });

  it("reuses the write-compatibility rehearsal's exact restore body", () => {
    expect(PRE_0036_RESTORE).toBe(WRITE_COMPAT_RESTORE);
    expect(PRE_0036_RESTORE.some((s) => /begin|commit/i.test(s))).toBe(false);
  });

  it("each case reads exactly the named identities with the case's memberships", async () => {
    const coll = await collectCaseParity(new FakeDb(), opts());
    const by = Object.fromEntries(coll.cases.map((c) => [c.case, c]));
    expect(Object.keys(by.baseline.after.roles).sort()).toEqual(["cs", "kiosk", "manager", "no-subject", "owner", "staff"]);
    expect(Object.keys(by["manager-all-sites"].after.roles)).toEqual(["manager"]);
    expect(by["manager-all-sites"].memberships.manager).toEqual(["au", "staging", "uk", "us"]);
    expect(by["owner-denied-uk"].memberships.owner).toEqual(["au", "staging", "us"]);
    expect(by["kiosk-denied-uk"].after.roles.kiosk!.visible.uk).toEqual([]);
    expect(by.baseline.after.staffForeignRows).toBe(0);
  });

  it("the same count with different ids under the restored policies fails", async () => {
    const db = new FakeDb();
    db.preRowSuffix = "-other";
    const coll = await collectCaseParity(db, opts());
    const all = caseParityProblems(PRE_HASH, coll, claimsSources());
    expect(all.some((p) => /rows only under pre-0036/.test(p))).toBe(true);
    expect(all.some((p) => /reader .* ids only under pre-0036/.test(p))).toBe(true);
    expect(coll.restoration?.passed).toBe(true);
  });

  it("a read timeout is recorded for that role, the transaction still rolls back and restoration is checked", async () => {
    const db = new FakeDb();
    db.failWhen = (sql, _p, d) => (sql.includes("as k, (staff_id") && d.claimsRole === "manager" && d.state.policy === "pre" ? new Error("canceling statement due to statement timeout") : undefined);
    const coll = await collectCaseParity(db, opts());
    expect(rollbacks(db)).toBe(1);
    expect(coll.restoration?.passed).toBe(true);
    const all = caseParityProblems(PRE_HASH, coll, claimsSources());
    expect(all.some((p) => /manager: reading au .* statement timeout/.test(p))).toBe(true);
    expect(standard(db)).toBe(true);
  });

  it("an error inside the nested restore stops the run, keeps the failure and still rolls back", async () => {
    const db = new FakeDb();
    let n = 0;
    db.failWhen = (sql) => (sql.startsWith("create policy production_events_read") && ++n === 2 ? new Error("permission denied") : undefined);
    const coll = await collectCaseParity(db, opts());
    expect(coll.problems).toContain("permission denied");
    expect(coll.cases.map((c) => c.case)).toEqual(["baseline"]);
    expect(rollbacks(db)).toBe(1);
    expect(coll.restoration?.passed).toBe(true);
    expect(caseParityProblems(PRE_HASH, coll, claimsSources())).toContain("parity case owner-denied-uk is missing");
  });

  it("cancellation rolls back, runs the restoration check and records FAILED", async () => {
    const db = new FakeDb();
    const ctl = new AbortController();
    const coll = await collectCaseParity(db, opts({ signal: ctl.signal, log: (l) => void (l.startsWith("baseline · restored") && ctl.abort()) }));
    expect(coll.problems).toContain("cancelled before completion");
    expect(rollbacks(db)).toBe(1);
    expect(coll.restoration?.passed).toBe(true);
    const { status } = caseParityMarkdown({ coll, problems: caseParityProblems(PRE_HASH, coll, claimsSources()), lines: [], claimsSources: claimsSources(), revision: "r", project: "p", finishedAt: "f" });
    expect(status).toMatch(/^STATUS: FAILED – /);
  });

  it("an unconfirmed ROLLBACK is never treated as restored", async () => {
    const db = new FakeDb();
    db.rollbackFails = true;
    const coll = await collectCaseParity(db, opts());
    expect(coll.restoration).toBeNull();
    expect(coll.problems.some((p) => /ROLLBACK could not be confirmed/.test(p))).toBe(true);
    expect(caseParityProblems(PRE_HASH, coll, claimsSources())).toContain("the post-rollback restoration check is missing");
  });

  it("memberships that are not standard after rollback fail the restoration check", async () => {
    const db = new FakeDb();
    db.onRollback = (d) => void d.state.memberships.get(UID.cs)!.add("uk");
    const coll = await collectCaseParity(db, opts());
    expect(coll.restoration?.passed).toBe(false);
    expect(caseParityProblems(PRE_HASH, coll, claimsSources()).some((p) => /restoration check failed: after rollback: cs memberships/.test(p))).toBe(true);
  });

  it("does no database work without the original pre-0036 baseline", async () => {
    const db = new FakeDb();
    const coll = await collectCaseParity(db, opts({ baselinePolicyHash: null }));
    expect(db.log).toHaveLength(0);
    expect(coll.problems[0]).toMatch(/baseline snapshot is missing/);
  });

  it("refuses to run cases when the installed policies are not post-0036 or memberships are not standard", async () => {
    const pre = new FakeDb();
    pre.state.policy = "pre";
    const c1 = await collectCaseParity(pre, opts());
    expect(c1.cases).toHaveLength(0);
    expect(c1.problems[0]).toMatch(/installed policies are not the approved post-0036 set/);
    expect(rollbacks(pre)).toBe(1);
    const drift = new FakeDb();
    drift.state.memberships.get(UID.manager)!.add("uk");
    const c2 = await collectCaseParity(drift, opts());
    expect(c2.cases).toHaveLength(0);
    expect(c2.problems[0]).toMatch(/memberships are not standard at the start/);
    const other = await collectCaseParity(new FakeDb(), opts({ expectedInstalledHash: "f".repeat(64) }));
    expect(other.problems[0]).toMatch(/not the retained post-0036 hash/);
  });

  it("SQL claims sizes must match the signed-in sessions", async () => {
    const coll = await collectCaseParity(new FakeDb(), opts());
    const src = claimsSources();
    src.staff = { ...src.staff, bytes: src.staff.bytes + 1 };
    expect(caseParityProblems(PRE_HASH, coll, src)).toContain("baseline: staff SQL claims size differs from the session's");
  });

  it("the report ends with exactly one STATUS line and never contains claim values", async () => {
    const coll = await collectCaseParity(new FakeDb(), opts());
    const { markdown, status } = caseParityMarkdown({ coll, problems: [], lines: ["x"], claimsSources: claimsSources(), revision: "r", project: "p", finishedAt: "f" });
    expect(status).toBe("STATUS: COMPLETE");
    expect(markdown.trimEnd().split("\n").filter((l) => l.startsWith("STATUS:"))).toEqual(["STATUS: COMPLETE"]);
    expect(markdown.trimEnd().endsWith("STATUS: COMPLETE")).toBe(true);
    expect(markdown).not.toMatch(/inka-staging\.test|"sub"|eyJ|11111111-1111/);
  });
});

describe("casesModeArgProblems", () => {
  it("allows --policy-parity=cases on its own only", () => {
    expect(casesModeArgProblems(["--policy-parity=cases"])).toEqual([]);
    for (const extra of ["--measure-only", "--manager-phase=all-sites", "--arrangement=standard", "--parity-case=baseline", "--write-compat", "--seed", "--cleanup"]) {
      expect(casesModeArgProblems(["--policy-parity=cases", extra])).toHaveLength(1);
    }
  });
});
