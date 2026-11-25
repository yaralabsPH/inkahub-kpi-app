/**
 * Task 14 access-path repair: migration allocation, immutability and the
 * effective definitions of 0042 (text checks, plus the real catalog after the
 * real 0037–0044 migrations in PGlite).
 */
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { migrationBody } from "../staging/reportingPublication";
import { effectiveReadQuery, functionBody, stripSqlComments } from "../staging/reportingDependencyRehearsal";
import { reportingDb } from "./pg/harness";
import { COLLATION_INVARIANT_SQL, collationInvariantProblems } from "../staging/reportingDependencyPlans";

const lfOf = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const M40 = "supabase/migrations/0040_reporting_dependency_reads.sql";
const M41 = "supabase/migrations/0041_reporting_dependency_read_bounds.sql";
const M42 = "supabase/migrations/0042_reporting_access_paths.sql";
const T41 = lfOf(M41);
const T42 = lfOf(M42);
const READS = ["read_reporting_changed_keys", "list_reporting_owners", "read_reporting_owner_members", "read_reporting_events_by_id", "read_reporting_children", "read_reporting_staff_stream"];
const REPLACED = ["read_reporting_owner_members", "read_reporting_staff_stream"];

describe("0042 allocation and immutability", () => {
  it("0042 is the reserved number between the Task 14 drafts and Task 15/16 (append-only)", () => {
    const names = readdirSync("supabase/migrations").filter((n) => /^004\d_/.test(n)).sort();
    expect(names).toEqual(["0040_reporting_dependency_reads.sql", "0041_reporting_dependency_read_bounds.sql", "0042_reporting_access_paths.sql", "0043_reporting_worker_state.sql", "0044_reporting_reads.sql", "0045_reporting_predecessor_page.sql", "0046_reporting_owner_inputs.sql", "0047_packaging_auto_pick.sql"]); // 0047 is F4 packaging (integration)
  });
  it("0040 and 0041 are byte-identical to the reviewed drafts the T14S3 evidence ran", () => {
    expect(sha(lfOf(M40))).toBe("4e39243e2ee6526f656eb1b462156d6bc9eabf17cac78fcb2d873cd4498968b2");
    expect(sha(T41)).toBe("dfa49d597cc37cef92314a4d2dcaf79d195949741fc0534fc57345c12f419646");
  });
  it("0042 is one transaction of exactly the two same-signature replacements plus restated grants: no DROP, index, table, timeout or other function", () => {
    const code = (stripSqlComments(T42) ?? "").replace(/\$fn\$[\s\S]*?\$fn\$/g, "$fn$$fn$");
    expect(code.trim().startsWith("BEGIN;")).toBe(true);
    expect(code.trim().endsWith("COMMIT;")).toBe(true);
    expect(code).not.toMatch(/\b(DROP|ALTER|TRUNCATE|DELETE|UPDATE|INSERT|CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+TABLE|statement_timeout|lock_timeout|SECURITY\s+DEFINER)\b/i);
    const body = migrationBody(T42).map((s) => (stripSqlComments(s) ?? "").trim());
    expect(body).toHaveLength(6);
    const created = [...T42.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(([^)]*)\)/g)].map((m) => [m[1], m[2]]);
    expect(created.map((c) => c[0])).toEqual(REPLACED);
    // same signatures and RETURNS TABLE as 0041
    for (const [name, args] of created) {
      expect(T41).toContain(`CREATE OR REPLACE FUNCTION public.${name}(${args})`);
      const ret = (t: string) => t.slice(t.indexOf(`FUNCTION public.${name}(`)).match(/RETURNS TABLE \([^)]*\)/)![0];
      expect(ret(T42)).toBe(ret(T41));
    }
    for (const name of REPLACED) {
      const head = T42.slice(T42.indexOf(`FUNCTION public.${name}(`), T42.indexOf("AS $fn$", T42.indexOf(`FUNCTION public.${name}(`)));
      expect(head).toMatch(/SECURITY INVOKER\nSET search_path = ''\n$/);
    }
  });
  it("the validation, frozen lock and complete-response accounting are 0041's text; only the FOR query changed", () => {
    for (const name of REPLACED) {
      const [b41, b42] = [functionBody(T41, `public.${name}`), functionBody(T42, `public.${name}`)];
      const [q41, q42] = [effectiveReadQuery(T41, name), effectiveReadQuery(T42, name)];
      expect(b42.replace(q42, "<Q>")).toBe(b41.replace(q41, "<Q>"));
      expect(q42).not.toBe(q41);
    }
  });
  it("owner equality keeps the default collation; the only bytewise equalities are the two access-path twins, each ANDed right after its default-collation equality", () => {
    const q = effectiveReadQuery(T42, "read_reporting_owner_members");
    expect(q).toContain(`sc.order_key = o.key AND sc.order_key COLLATE "C" = o.key COLLATE "C"`);
    expect(q).toContain(`sc.event_id = o.key AND sc.event_id COLLATE "C" = o.key COLLATE "C" AND coalesce(sc.order_key, '') = ''`);
    // exactly two bytewise equalities, and none anywhere else (refresh branches and the stream have none)
    expect([...q.matchAll(/COLLATE "C"\s*=/g)]).toHaveLength(2);
    expect([...q.matchAll(/(\w+\.\w+) = o\.key AND \1 COLLATE "C" = o\.key COLLATE "C"/g)]).toHaveLength(2);
    expect(q).not.toMatch(/COLLATE "C"\s*<>|<>\s*\S+\s+COLLATE "C"/);
    expect([...effectiveReadQuery(T42, "read_reporting_staff_stream").matchAll(/COLLATE "C"\s*(=|<>)/g)]).toHaveLength(0);
  });
  it("the rebuild members are two per-kind LATERAL lookups: the order lookup orders bytewise and stops at p_limit; the event lookup has no ordering and LIMIT 1", () => {
    const q = effectiveReadQuery(T42, "read_reporting_owner_members");
    const rebuild = q.slice(q.indexOf("-- the frozen candidate (rebuild), order owners"));
    const [order, event] = rebuild.split("-- the frozen candidate (rebuild), event owners");
    expect(order).toMatch(/CROSS JOIN LATERAL \([\s\S]*o\.kind = 'order'[\s\S]*ORDER BY sc\.event_id COLLATE "C"\s+LIMIT p_limit\s+\) c/);
    expect(event).toMatch(/CROSS JOIN LATERAL \([\s\S]*o\.kind = 'event'[\s\S]*LIMIT 1\s+\) c/);
    expect(event).not.toMatch(/ORDER BY sc\./);
    expect(rebuild).not.toMatch(/\) u\s+ORDER BY/); // no shared ordering across owner kinds any more
  });
  it("every stream branch has its own direction guard, ORDER BY and LIMIT p_limit before the merge; no OFFSET", () => {
    const q = effectiveReadQuery(T42, "read_reporting_staff_stream");
    const branches = q.split("UNION ALL");
    expect(branches).toHaveLength(6);
    for (const b of branches) {
      expect(b).toMatch(/p_direction = '(after|before)'/);
      expect(b).toMatch(/ORDER BY [\s\S]*LIMIT p_limit\)/);
    }
    expect(q).not.toMatch(/\bOFFSET\b/i);
    // the overlay branches still exclude tombstones and the base branches still exclude superseded rows
    expect(branches.filter((b) => b.includes("FROM reporting_private.batch_events be") && b.includes("be.image IS NOT NULL"))).toHaveLength(2);
    expect(branches.filter((b) => b.includes("FROM reporting_private.source_current s") && b.includes("NOT EXISTS"))).toHaveLength(2);
  });
  it("the 0042 header does not claim the overlay branch is bounded", () => {
    expect(T42).toMatch(/It is NOT claimed bounded; it stays a measured hosted gate/);
  });
});

describe("0042 effective definitions (the real catalog after 0037–0044)", () => {
  let db: PGlite;
  beforeAll(async () => { db = await reportingDb(); }, 120_000);
  afterAll(async () => db?.close());
  it("the two replaced functions have the 0042 bodies; the other four still 0041; all invoker, empty search_path, service-only", async () => {
    const r = await db.query<{ name: string; src: string; definer: boolean; config: string; anon: boolean; auth: boolean; service: boolean; pub: boolean; args: string }>(
      `select p.proname::text as name, p.prosrc as src, p.prosecdef as definer, coalesce(array_to_string(p.proconfig, ','), '') as config, pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth, has_function_privilege('service_role', p.oid, 'EXECUTE') as service,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as pub
         from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any($1::text[]) order by 1`, [READS]);
    expect(r.rows.map((x) => x.name).sort()).toEqual([...READS].sort()); // one definition each (no overload)
    for (const x of r.rows) {
      const want = functionBody(REPLACED.includes(x.name) ? T42 : T41, `public.${x.name}`);
      expect(md5(x.src.replace(/\r\n/g, "\n")), x.name).toBe(md5(want));
      expect({ definer: x.definer, config: x.config, anon: x.anon, auth: x.auth, service: x.service, pub: x.pub }, x.name).toEqual({ definer: false, config: 'search_path=""', anon: false, auth: false, service: true, pub: false });
    }
  });
  it("collation invariant (the same query as the hosted A2 step): default-collation owner columns and key, deterministic default, equality agrees bytewise", async () => {
    const row = (await db.query<Record<string, unknown>>(COLLATION_INVARIANT_SQL)).rows[0];
    expect(collationInvariantProblems(row)).toEqual([]);
    expect(row.columns).toEqual(["event_id=100", "order_key=100"]);
  });
});

describe("collation invariant check (pure)", () => {
  const good = { columns: ["event_id=100", "order_key=100"], key_collation: '"default"', default_deterministic: true, database_locale: "c:C.UTF-8", equality_agrees: true };
  it("accepts the invariant and names every way it can break", () => {
    expect(collationInvariantProblems(good)).toEqual([]);
    expect(collationInvariantProblems(undefined)).toEqual(["the collation invariant query returned no row"]);
    expect(collationInvariantProblems({ ...good, columns: ["event_id=100", "order_key=950"] })[0]).toMatch(/not the database default collation/);
    expect(collationInvariantProblems({ ...good, key_collation: '"und-x-icu"' })[0]).toMatch(/owner key is not the default collation/);
    expect(collationInvariantProblems({ ...good, default_deterministic: false })).toEqual(["the database default collation is not deterministic"]);
    expect(collationInvariantProblems({ ...good, equality_agrees: false })[0]).toMatch(/disagree/);
  });
});
