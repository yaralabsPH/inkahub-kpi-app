/**
 * The four-case collector (`--policy-parity=cases`, Task 4 M6 amendment,
 * review r2) and its run lifecycle, against a fake database that models
 * transactions, savepoints, memberships, saved rows and the two policy sets.
 * No real database or network.
 */
import { describe, expect, it, vi } from "vitest";
import { collectCaseParity, PRE_0036_RESTORE, readerSql, type QueryClient } from "./policyParityRun";
import { PRE_0036_RESTORE as WRITE_COMPAT_RESTORE } from "./writeCompatRun";
import {
  casesModeArgProblems,
  caseCollectionHash,
  caseParityMarkdown,
  caseParityProblems,
  PARITY_CASES,
  STANDARD_MEMBERSHIPS,
  type BaselineCatalog,
  type CaseCollection,
  type CaseUser,
} from "./itemCountingParityCases";
import { runCasesMode, type CasesModeIO } from "./caseParityMode";
import { claimsSetting } from "./generate-query-evidence";
import { checkParityArtifact, parityArtifactHash, policyHash, READER_PROBES, type ParityArtifact } from "./itemCountingPolicyParity";
import { CATALOG_OTHER, claimsSources, legacyParityArtifact, POST_POLICY_HASH, postPolicies, prePolicies, sessionClaims } from "./gateTestFixtures";

const USERS: CaseUser[] = ["owner", "manager", "staff", "kiosk", "cs"];
const CLAIMS = Object.fromEntries(USERS.map((u) => [u, JSON.stringify(sessionClaims(u))]));
const UID = Object.fromEntries(USERS.map((u) => [u, String(sessionClaims(u).sub)])) as Record<CaseUser, string>;
const ROLE_BY_SETTING = new Map([...USERS, "no-subject"].map((r) => [claimsSetting(r), r]));
const PRE_HASH = policyHash(prePolicies()).hash;
const BASELINE: BaselineCatalog = { policyHash: PRE_HASH, other: { ...CATALOG_OTHER }, revision: "r0", capturedAt: "t0" };
const SOURCES = () => Object.fromEntries(Object.entries(claimsSources()).map(([r, c]) => [r, { bytes: c.bytes, problems: [...c.problems] }]));

interface State {
  memberships: Map<string, Set<string>>;
  policy: "pre" | "post";
}
const copy = (s: State): State => ({ memberships: new Map([...s.memberships].map(([k, v]) => [k, new Set(v)])), policy: s.policy });

/** Saved rows: at au/uk/us one row per test user; at `staging` only the two probes (staff and kiosk). */
function savedRows(withProbes: boolean): Array<{ site: string; id: string; staff: CaseUser }> {
  const out: Array<{ site: string; id: string; staff: CaseUser }> = [];
  for (const site of ["au", "uk", "us"]) for (const u of USERS) out.push({ site, id: `${u}-1`, staff: u });
  if (withProbes) out.push({ site: "staging", id: "parity-probe-staff-1", staff: "staff" }, { site: "staging", id: "parity-probe-kiosk-1", staff: "kiosk" });
  return out;
}

/** A small model of the staging database, enough for the collector's statements. */
class FakeDb implements QueryClient {
  state: State = { memberships: new Map(USERS.map((u) => [UID[u], new Set(STANDARD_MEMBERSHIPS[u])])), policy: "post" };
  rows = savedRows(true);
  inTx = false;
  base: State | null = null;
  savepoints: Array<{ name: string; snap: State }> = [];
  role: "postgres" | "authenticated" = "postgres";
  settings = new Map<string, string>();
  claimsRole: string | null = null;
  timeoutApplied = false;
  timeoutSetting = "8s";
  other: Record<string, string> = { ...CATALOG_OTHER };
  log: Array<{ sql: string; params: unknown[]; inTx: boolean; policy: string }> = [];
  /** Inject a failure (return an Error) or a side effect. */
  failWhen: (sql: string, params: unknown[], db: FakeDb) => Error | undefined = () => undefined;
  preRowSuffix = "";
  preReaderField = false;
  onRollback: (db: FakeDb) => void = () => {};
  rollbackFails = false;

  async query(raw: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount?: number }> {
    const sql = raw.trim().replace(/\s+/g, " ");
    this.log.push({ sql, params, inTx: this.inTx, policy: this.state.policy });
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
      this.savepoints.splice(this.savepoints.map((s) => s.name).lastIndexOf(m[1]));
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
    if (sql.startsWith("select (select md5(string_agg(n.nspname")) return { rows: [{ ...this.other }] };
    if (sql.includes("count(*)::text || ':' || md5")) {
      const sites = [...new Set(this.rows.map((r) => r.site))].sort();
      return { rows: sites.map((location) => ({ location, fp: `${this.rows.filter((r) => r.site === location).length}:${location}` })) };
    }
    if (sql.includes("min(created_at) as lo")) return { rows: [{ lo: "2026-09-02T00:00:00Z", hi: "2026-09-20T00:00:00Z" }] };
    if (sql.includes("from public.user_locations where user_id = any")) {
      const ids = params[0] as string[];
      return { rows: ids.flatMap((id) => [...(this.state.memberships.get(id) ?? [])].map((location) => ({ u: id, location }))) };
    }
    if (sql.includes("staff_id is distinct from $1::uuid and created_at <= $2::timestamptz group by location")) {
      const counts = new Map<string, number>();
      for (const r of this.rows) if (UID[r.staff] !== params[0]) counts.set(r.site, (counts.get(r.site) ?? 0) + 1);
      return { rows: [...counts].map(([location, n]) => ({ location, n })) };
    }
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
      return { rows: [{
        profile_role: uid ? r : null, memberships: uid ? [...this.state.memberships.get(uid)!].sort().join(",") || null : null,
        claims_bytes: Buffer.byteLength(this.settings.get(claimsSetting(r ?? "")) ?? ""), subject: uid,
      }] };
    }
    if (sql.startsWith("select current_user as u")) return { rows: [{ u: this.role, rls: "on", t: this.timeoutApplied ? this.timeoutSetting : "0", bypass: false }] };
    if (sql.includes("as k, (staff_id is distinct from")) {
      if (this.role !== "authenticated") throw new Error("role reads must run as authenticated");
      if (params.length !== 4) throw new Error("role reads must be bounded by the cutoff");
      if (params[1] !== "-infinity") return { rows: [] };
      return { rows: this.visible(String(params[0])).map((r) => ({ k: `${r.site}|${r.id}${this.suffix()}`, foreign_row: UID[r.staff] !== this.subject() })) };
    }
    if (sql.startsWith("select (to_jsonb(t) - 'parity_ord')::text as j")) {
      if (this.role !== "authenticated") throw new Error("reader replays must run as authenticated");
      const extra = this.preReaderField && this.state.policy === "pre" ? { note: "changed" } : {};
      return { rows: this.visible(String(params[0])).map((r) => ({ j: JSON.stringify({ id: r.id + this.suffix(), ...extra }) })) };
    }
    throw new Error(`unexpected statement: ${sql.slice(0, 80)}`);
  }

  private subject(): string | null {
    const r = this.claimsRole;
    return r && r !== "no-subject" ? UID[r as CaseUser] : null;
  }
  private suffix(): string {
    return this.state.policy === "pre" ? this.preRowSuffix : "";
  }
  private visible(site: string) {
    const uid = this.subject();
    if (!uid || !this.state.memberships.get(uid)!.has(site)) return [];
    const role = this.claimsRole;
    return this.rows.filter((r) => r.site === site && (role !== "staff" || UID[r.staff] === uid));
  }
}

const opts = (over: Partial<Parameters<typeof collectCaseParity>[1]> = {}): Parameters<typeof collectCaseParity>[1] => ({
  revision: "rev", claimsText: CLAIMS, claimsSources: SOURCES(), baseline: BASELINE, expectedInstalledHash: POST_POLICY_HASH, log: () => {},
  newId: () => "coll-1", now: () => "2026-11-14T00:00:00Z", ...over,
});
const standard = (db: FakeDb) => USERS.every((u) => [...db.state.memberships.get(UID[u])!].sort().join(",") === [...STANDARD_MEMBERSHIPS[u]].sort().join(","));
const rollbacks = (db: FakeDb) => db.log.filter((x) => x.sql === "rollback").length;
const problems = (coll: CaseCollection) => caseParityProblems(BASELINE, coll);

describe("collectCaseParity (review r1 M6, r2)", () => {
  it("collects all four cases in one rolled-back transaction and passes the full gate", async () => {
    const db = new FakeDb();
    const coll = await collectCaseParity(db, opts());
    expect(coll.problems).toEqual([]);
    expect(coll.cases.map((c) => c.case)).toEqual([...PARITY_CASES]);
    expect(coll.restoration).toMatchObject({ passed: true, problems: [] });
    expect(problems(coll)).toEqual([]);
    expect(db.log[0].sql).toBe("begin isolation level repeatable read");
    expect(db.log.filter((x) => /^begin/.test(x.sql))).toHaveLength(1);
    expect(rollbacks(db)).toBe(1);
    expect(db.log.some((x) => /commit|schema_migrations|apply_migration/i.test(x.sql))).toBe(false);
    expect(db.log.filter((x) => x.sql === "rollback to savepoint parity_pre")).toHaveLength(4);
    expect(db.log.filter((x) => x.sql === "rollback to savepoint parity_case")).toHaveLength(4);
    const firstRestore = db.log.findIndex((x) => x.sql.startsWith("drop policy"));
    expect(db.log.slice(0, firstRestore).some((x) => x.sql.includes("as k, (staff_id"))).toBe(true);
    expect(db.log.filter((x) => x.sql.includes("as k, (staff_id") && x.policy === "pre").length).toBeGreaterThan(0);
    const rb = db.log.findIndex((x) => x.sql === "rollback");
    const after = db.log.slice(rb + 1);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((x) => !x.inTx)).toBe(true);
    expect(coll.restoration?.memberships?.manager).toEqual(["au", "staging"]);
    expect(coll.restoration?.catalog?.policyHash).toBe(POST_POLICY_HASH);
    expect(standard(db)).toBe(true);
    expect(db.state.policy).toBe("post");
  });

  it("reuses the write-compatibility rehearsal's exact restore body", () => {
    expect(PRE_0036_RESTORE).toBe(WRITE_COMPAT_RESTORE);
    expect(PRE_0036_RESTORE.some((s) => /begin|commit/i.test(s))).toBe(false);
  });

  it("each case reads exactly the named identities, as the collection's users, with exact environment evidence", async () => {
    const coll = await collectCaseParity(new FakeDb(), opts());
    const by = Object.fromEntries(coll.cases.map((c) => [c.case, c]));
    expect(Object.keys(by.baseline.after.roles).sort()).toEqual(["cs", "kiosk", "manager", "no-subject", "owner", "staff"]);
    expect(Object.keys(by["manager-all-sites"].after.roles)).toEqual(["manager"]);
    expect(by["manager-all-sites"].memberships.manager).toEqual(["au", "staging", "uk", "us"]);
    expect(by["owner-denied-uk"].memberships.owner).toEqual(["au", "staging", "us"]);
    expect(by["kiosk-denied-uk"].after.roles.kiosk!.visible.uk).toEqual([]);
    expect(by.baseline.after.roles.staff!.foreign).toEqual({ au: 0, uk: 0, us: 0, staging: 0 });
    expect(by.baseline.after.roles.owner!.foreign!.staging).toBe(2);
    expect(by.baseline.after.roles.owner!.subject).toBe(UID.owner);
    expect(by.baseline.after.roles["no-subject"]!.subject).toBeNull();
    expect(by.baseline.before.roles.cs!.env).toEqual({ user: "authenticated", rowSecurity: "on", timeoutMs: 8000, bypass: false });
    expect(coll.users).toEqual(UID);
  });

  it("every full-history read and every reader replay is bounded by the fixed cutoff", async () => {
    const db = new FakeDb();
    await collectCaseParity(db, opts());
    const reads = db.log.filter((x) => x.sql.includes("as k, (staff_id"));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((x) => x.sql.includes("created_at <= $4::timestamptz") && x.params[3] === "2026-11-12T00:00:00.000Z")).toBe(true);
    const replays = db.log.filter((x) => x.sql.startsWith("select (to_jsonb(t)"));
    expect(replays.every((x) => x.params[1] === "2026-11-12T00:00:00.000Z")).toBe(true);
    for (const probe of READER_PROBES) {
      const sql = readerSql(probe);
      expect(sql.includes("$2::timestamptz") || /< '20\d\d-/.test(sql)).toBe(true);
    }
    // The readers keep their own limits.
    expect(readerSql("live-order-completions")).toContain("limit 500");
    expect(readerSql("production-clock-state")).toContain("limit 1");
  });

  it("the same count with different ids under the restored policies fails", async () => {
    const db = new FakeDb();
    db.preRowSuffix = "-other";
    const coll = await collectCaseParity(db, opts());
    const all = problems(coll);
    expect(all.some((p) => /rows only under pre-0036/.test(p))).toBe(true);
    expect(all.some((p) => /reader .* rows only under pre-0036/.test(p))).toBe(true);
  });

  it("a changed returned field in a reader replay fails even with the same rows", async () => {
    const db = new FakeDb();
    db.preReaderField = true;
    const all = problems(await collectCaseParity(db, opts()));
    expect(all.some((p) => /reader .*: 1 rows only under pre-0036, 1 only under 0036/.test(p))).toBe(true);
  });

  it("without positive rows at the staging member site the collection fails", async () => {
    const db = new FakeDb();
    db.rows = savedRows(false);
    const all = problems(await collectCaseParity(db, opts()));
    expect(all.some((p) => /owner saw no rows at member site staging/.test(p))).toBe(true);
    expect(all.some((p) => /no other-worker rows at staging, so staff's exclusion there is not proven/.test(p))).toBe(true);
  });

  it("a site-wide role that never sees another worker's rows fails (self/other-worker probes)", async () => {
    const db = new FakeDb();
    db.rows = db.rows.filter((r) => !(r.site === "staging" && r.staff === "staff"));
    const all = problems(await collectCaseParity(db, opts()));
    expect(all.some((p) => /kiosk saw no other workers' rows at member site staging/.test(p))).toBe(true);
  });

  it("a read timeout is recorded for that role, the transaction still rolls back and restoration is checked", async () => {
    const db = new FakeDb();
    db.failWhen = (sql, _p, d) => (sql.includes("as k, (staff_id") && d.claimsRole === "manager" && d.state.policy === "pre" ? new Error("canceling statement due to statement timeout") : undefined);
    const coll = await collectCaseParity(db, opts());
    expect(rollbacks(db)).toBe(1);
    expect(coll.restoration?.passed).toBe(true);
    expect(problems(coll).some((p) => /manager: reading au .* statement timeout/.test(p))).toBe(true);
    expect(standard(db)).toBe(true);
  });

  it("a role read under any statement_timeout other than 8 s fails", async () => {
    const db = new FakeDb();
    db.timeoutSetting = "30s";
    const all = problems(await collectCaseParity(db, opts()));
    expect(all.some((p) => /statement_timeout is 30s, expected 8000 ms/.test(p))).toBe(true);
    expect(all.some((p) => /read with statement_timeout 30000 ms, expected 8000/.test(p))).toBe(true);
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
    expect(problems(coll)).toContain("parity case owner-denied-uk is missing");
  });

  it("cancellation before the last case rolls back, runs the restoration check and records FAILED", async () => {
    const db = new FakeDb();
    const ctl = new AbortController();
    const coll = await collectCaseParity(db, opts({ signal: ctl.signal, log: (l) => void (l.startsWith("baseline · restored") && ctl.abort()) }));
    expect(coll.problems).toContain("cancelled before completion");
    expect(rollbacks(db)).toBe(1);
    expect(coll.restoration?.passed).toBe(true);
  });

  it("cancellation during the LAST restored read still fails the collection (R2-2)", async () => {
    const ctl = new AbortController();
    const coll = await collectCaseParity(new FakeDb(), opts({ signal: ctl.signal, log: (l) => void (l.startsWith("kiosk-denied-uk · restored") && ctl.abort()) }));
    expect(coll.cases).toHaveLength(4);
    expect(coll.problems).toContain("cancelled before completion");
    expect(problems(coll)).toContain("cancelled before completion");
  });

  it("cancellation during the fresh restoration check still fails the collection (R2-2)", async () => {
    const db = new FakeDb();
    const ctl = new AbortController();
    db.failWhen = (sql, _p, d) => (!d.inTx && rollbacks(d) === 1 && sql.includes("from pg_catalog.pg_policies") ? (ctl.abort(), undefined) : undefined);
    const coll = await collectCaseParity(db, opts({ signal: ctl.signal }));
    expect(coll.restoration?.passed).toBe(true);
    expect(problems(coll)).toContain("cancelled before completion");
  });

  it("an unconfirmed ROLLBACK is never treated as restored", async () => {
    const db = new FakeDb();
    db.rollbackFails = true;
    const coll = await collectCaseParity(db, opts());
    expect(coll.restoration).toBeNull();
    expect(problems(coll)).toContain("the post-rollback restoration check is missing");
  });

  it("memberships that are not standard after rollback fail the restoration check", async () => {
    const db = new FakeDb();
    db.onRollback = (d) => void d.state.memberships.get(UID.cs)!.add("uk");
    const coll = await collectCaseParity(db, opts());
    expect(coll.restoration?.passed).toBe(false);
    expect(problems(coll).some((p) => /restoration check failed: after rollback: cs memberships/.test(p))).toBe(true);
  });

  it("does no database work without the original baseline or the retained installed hash (R2-3)", async () => {
    for (const over of [{ baseline: null }, { expectedInstalledHash: null }]) {
      const db = new FakeDb();
      const coll = await collectCaseParity(db, opts(over));
      expect(db.log).toHaveLength(0);
      expect(problems(coll).length).toBeGreaterThan(0);
    }
  });

  it("refuses helper, ACL or role-setting drift from the original baseline even when both sides agree (R2-3)", async () => {
    for (const key of ["helpers", "table_grants", "role_configs"]) {
      const db = new FakeDb();
      db.other = { ...CATALOG_OTHER, [key]: "changed" };
      const coll = await collectCaseParity(db, opts());
      expect(coll.cases).toHaveLength(0);
      expect(coll.problems[0]).toMatch(new RegExp(`installed catalog ${key} differ from the original pre-0036 baseline`));
      expect(rollbacks(db)).toBe(1);
    }
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

  it("claims problems and size mismatches are stored in the collection itself (R2-1)", async () => {
    const src = SOURCES();
    src.staff = { bytes: src.staff.bytes + 1, problems: ["staff: claims are minimal"] };
    const coll = await collectCaseParity(new FakeDb(), opts({ claimsSources: src }));
    expect(coll.problems).toContain("staff session claims: staff: claims are minimal");
    expect(problems(coll).some((p) => /staff SQL claims size .* differs from the signed-in session's/.test(p))).toBe(true);
  });

  it("the report ends with exactly one STATUS line and never contains claim values", async () => {
    const coll = await collectCaseParity(new FakeDb(), opts());
    const { markdown, status } = caseParityMarkdown({ coll, problems: [], lines: ["x"], claimsSources: claimsSources(), revision: "r", project: "p", finishedAt: "f" });
    expect(status).toBe("STATUS: COMPLETE");
    expect(markdown.trimEnd().split("\n").filter((l) => l.startsWith("STATUS:"))).toEqual(["STATUS: COMPLETE"]);
    expect(markdown).not.toMatch(/inka-staging\.test|"sub"|eyJ/);
  });
});

describe("checkCaseCollection validates the underlying evidence (R2-4)", () => {
  const passing = async () => collectCaseParity(new FakeDb(), opts());

  it("the evidence hash changes when ids are replaced identically on both sides", async () => {
    const a = await passing();
    const b = await passing();
    for (const side of [b.cases[1].before, b.cases[1].after]) side.roles.manager!.visible.uk = side.roles.manager!.visible.uk.map((k) => `${k}-swapped`);
    b.comparisons = b.comparisons.map((c) => ({ ...c }));
    expect(caseCollectionHash(a)).not.toBe(caseCollectionHash(b));
    expect(caseCollectionHash(a)).toBe(caseCollectionHash(await passing()));
  });

  it("rejects missing scope, identity and claims evidence", async () => {
    const c1 = await passing();
    c1.bounds = [];
    c1.cutoff = "2026-12-01T00:00:00.000Z";
    expect(problems(c1)).toEqual(expect.arrayContaining(["parity month bounds are missing", "parity cutoff is 2026-12-01T00:00:00.000Z, expected 2026-11-12T00:00:00.000Z"]));
    const c2 = await passing();
    delete c2.claimsBytes;
    delete c2.users;
    expect(problems(c2)).toEqual(expect.arrayContaining(["the owner session's claims evidence is not recorded", "the owner test user's identity is not recorded"]));
    const c3 = await passing();
    c3.cases[0].after.roles.kiosk!.subject = UID.owner;
    expect(problems(c3).some((p) => /kiosk was not read as the collection's kiosk test user/.test(p))).toBe(true);
  });

  it("rejects changed helper evidence on both sides and a stored hash that does not match its rows", async () => {
    const c1 = await passing();
    for (const ev of c1.cases) for (const side of [ev.before, ev.after]) side.other = { ...side.other, helpers: "changed" };
    expect(problems(c1).some((p) => /catalog helpers differ from the original pre-0036 baseline/.test(p))).toBe(true);
    const c2 = await passing();
    c2.cases[0].after.policyHash = "0".repeat(64);
    expect(problems(c2).some((p) => /stored policy hash does not match its catalog rows/.test(p))).toBe(true);
  });

  it("rejects a restoration that says passed but reports problems or lacks its evidence", async () => {
    const c1 = await passing();
    c1.restoration = { ...c1.restoration!, problems: ["after rollback: cs memberships are au,staging,uk"] };
    expect(problems(c1)).toContain("the post-rollback restoration check says passed but reports: after rollback: cs memberships are au,staging,uk");
    const c2 = await passing();
    c2.restoration = { checkedAt: "t", passed: true, problems: [] };
    expect(problems(c2)).toContain("the restoration check did not record the installed policies");
  });

  it("rejects a case swapped in from another collection", async () => {
    const a = await passing();
    const db = new FakeDb();
    db.rows = db.rows.map((r) => (r.site === "au" && r.staff === "cs" ? { ...r, id: "cs-2" } : r));
    const other = await collectCaseParity(db, opts({ newId: () => "coll-2" }));
    a.cases[0] = other.cases[0];
    expect(problems(a)).toContain("parity case baseline evidence was read in a different collection or fixture");
  });
});

describe("runCasesMode lifecycle (R2-1)", () => {
  function io(over: Partial<CasesModeIO> = {}) {
    let art: ParityArtifact | null = { ...legacyParityArtifact(), cases: null };
    const reports: string[] = [];
    const written: ParityArtifact[] = [];
    const db = new FakeDb();
    const value: CasesModeIO = {
      readArtifact: () => (art ? JSON.parse(JSON.stringify(art)) : null),
      writeArtifact: (a) => {
        art = JSON.parse(JSON.stringify(a));
        written.push(JSON.parse(JSON.stringify(a)));
      },
      writeReport: (md) => void reports.push(md),
      signIn: async () => ({ text: CLAIMS, sources: claimsSources() }),
      connect: async () => Object.assign(db, { end: async () => {} }),
      revision: "rev", project: "ybrz", now: () => "2026-11-14T00:00:00Z", newId: () => "coll-9", log: () => {}, signal: new AbortController().signal,
      ...over,
    };
    return { value, reports, written, db, artifact: () => art };
  }
  // The legacy history's baseline is the fixtures' pre-0036 catalog; its retained installed hash is POST_POLICY_HASH.

  it("a clean run publishes a passing collection and a COMPLETE report", async () => {
    const t = io();
    const r = await runCasesMode(t.value);
    expect(r.status).toBe("STATUS: COMPLETE");
    expect(checkParityArtifact(t.artifact(), POST_POLICY_HASH)).toEqual([]);
    expect(t.reports.at(-1)!.trimEnd().endsWith("STATUS: COMPLETE")).toBe(true);
    expect(t.artifact()!.snapshots).toHaveLength(1);
  });

  it("marks the attempt pending before sign-in, so a sign-in failure leaves no usable success", async () => {
    const good = io();
    await runCasesMode(good.value);
    const t = io({ readArtifact: () => good.artifact(), signIn: async () => Promise.reject(new Error("Sign-in failed for the owner test user")) });
    const r = await runCasesMode(t.value);
    expect(r.code).toBe(1);
    expect(t.written[0].cases!.collectionId).toBe("coll-9");
    expect(t.written[0].cases!.problems[0]).toMatch(/has not finished/);
    expect(checkParityArtifact(t.artifact(), POST_POLICY_HASH).length).toBeGreaterThan(0);
    expect(t.reports.every((md) => /STATUS: FAILED – /.test(md))).toBe(true);
  });

  it("a connection failure fails the stored attempt too", async () => {
    const t = io({ connect: async () => Promise.reject(new Error("connect ECONNREFUSED")) });
    await runCasesMode(t.value);
    expect(t.artifact()!.cases!.problems).toContain("connect ECONNREFUSED");
    expect(checkParityArtifact(t.artifact(), POST_POLICY_HASH).length).toBeGreaterThan(0);
  });

  it("while collecting (or if killed), the artifact on disk is the pending attempt and every report says FAILED", async () => {
    let midway: ParityArtifact | null = null;
    const t = io();
    t.value.collect = async (client, o) => {
      midway = t.artifact();
      o.log("baseline · installed 0036 · owner: 5 visible rows");
      return collectCaseParity(client, o);
    };
    await runCasesMode(t.value);
    expect(midway!.cases!.problems[0]).toMatch(/started at .* has not finished/);
    expect(checkParityArtifact(midway, POST_POLICY_HASH).length).toBeGreaterThan(0);
    const progress = t.reports.slice(0, -1);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.every((md) => /STATUS: FAILED – four-case collection coll-9 started/.test(md))).toBe(true);
  });

  it("claims validation failures are stored in the published artifact, not only the report", async () => {
    const src = claimsSources();
    src.cs = { ...src.cs, problems: ["cs: claims are minimal"] };
    const t = io({ signIn: async () => ({ text: CLAIMS, sources: src }) });
    const r = await runCasesMode(t.value);
    expect(r.code).toBe(1);
    expect(t.artifact()!.cases!.problems.some((p) => p.includes("cs: claims are minimal"))).toBe(true);
    expect(checkParityArtifact(t.artifact(), POST_POLICY_HASH).length).toBeGreaterThan(0);
  });

  it("the phase hash of the new evidence differs from any earlier collection's", async () => {
    const t1 = io();
    await runCasesMode(t1.value);
    const t2 = io({ newId: () => "coll-10" });
    await runCasesMode(t2.value);
    expect(parityArtifactHash(t1.artifact()!)).not.toBe(parityArtifactHash(t2.artifact()!));
  });

  it("never writes a heartbeat after finishing", async () => {
    vi.useFakeTimers();
    try {
      const t = io({ heartbeatMs: 10 });
      await runCasesMode(t.value);
      const n = t.reports.length;
      vi.advanceTimersByTime(100);
      expect(t.reports.length).toBe(n);
    } finally {
      vi.useRealTimers();
    }
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
