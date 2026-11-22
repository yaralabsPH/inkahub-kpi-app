import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Structural checks on the F5 migration text. These catch a privilege, an
 * object or an ordering rule being dropped by accident. They do NOT prove the
 * SQL behaves: that is supabase/staging/departments/*.sql, run on staging.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "supabase", "migrations");
const read = (name: string) => readFileSync(join(migrationsDir, name), "utf8");
/** SQL with comments removed, so prose cannot satisfy or break a check. */
const code = (sql: string) => sql.replace(/--.*$/gm, "");

const TABLES = [
  "business_departments",
  "business_department_names",
  "person_department_assignments",
  "department_audit",
  "department_requests",
  "department_snapshot_control",
];

describe("migration files", () => {
  it("uses the three reserved numbers and nothing else claims them", () => {
    const files = readdirSync(migrationsDir);
    for (const n of ["0052", "0053", "0054"]) {
      expect(files.filter((f) => f.startsWith(n))).toHaveLength(1);
    }
    expect(files).toContain("0052_departments.sql");
  });

  it("never numbers a file with a placeholder", () => {
    expect(readdirSync(migrationsDir).filter((f) => /NN|XX/.test(f.slice(0, 4)))).toEqual([]);
  });
});

describe("0052 storage and privileges", () => {
  const sql = code(read("0052_departments.sql"));

  it("creates the six tables", () => {
    for (const t of TABLES) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${t}`);
  });

  it("installs btree_gist in extensions before the first exclusion constraint", () => {
    const ext = sql.indexOf("CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions");
    const firstExclude = sql.indexOf("EXCLUDE USING gist");
    expect(ext).toBeGreaterThan(-1);
    expect(firstExclude).toBeGreaterThan(ext);
    expect(sql).toContain("Not relocating it");
  });

  it("forbids overlapping intervals in the database, with half-open ranges", () => {
    expect(sql).toContain("CONSTRAINT person_department_assignments_no_overlap EXCLUDE USING gist");
    expect(sql).toContain("CONSTRAINT business_department_names_no_overlap EXCLUDE USING gist");
    expect(sql.match(/tstzrange\(valid_from, valid_to, '\[\)'\) WITH &&/g)).toHaveLength(2);
    expect(sql.match(/extensions\.gist_uuid_ops WITH =/g)).toHaveLength(2);
    expect(sql).toContain("person_department_assignments_one_open");
    expect(sql).toContain("business_department_names_one_open");
    expect(sql.match(/valid_to > valid_from/g)).toHaveLength(2);
  });

  it("ties a person to the Auth user, never to profiles", () => {
    expect(sql).toContain("REFERENCES auth.users(id) ON DELETE RESTRICT");
    expect(sql).not.toMatch(/REFERENCES\s+(public\.)?profiles/);
  });

  it("seeds only the switch, and seeds it OFF", () => {
    const inserts = sql.match(/INSERT INTO [\w.]+/g) ?? [];
    expect(inserts).toEqual(["INSERT INTO public.department_snapshot_control"]);
    expect(sql).toMatch(/VALUES \(true, false, clock_timestamp\(\)/);
    expect(sql).toContain("enabled             boolean     NOT NULL DEFAULT false");
  });

  it("turns on row-level security for every table", () => {
    for (const t of TABLES) expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`));
  });

  it("revokes everything first and grants no client write", () => {
    const revoke = sql.indexOf("FROM PUBLIC, anon, authenticated, service_role");
    const grant = sql.indexOf("TO authenticated");
    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
    // The only table grants are SELECT.
    for (const g of sql.match(/GRANT [^;]+ ON TABLE[^;]+;/g) ?? []) expect(g).toMatch(/^GRANT SELECT ON TABLE/);
    expect(sql).not.toMatch(/GRANT[^;]*\b(INSERT|UPDATE|DELETE|ALL)\b[^;]*ON TABLE/);
    expect(sql).not.toMatch(/TO (anon|service_role)\b/);
    // Receipts are internal: not granted to anyone.
    for (const g of sql.match(/GRANT SELECT ON TABLE[^;]+;/g) ?? []) expect(g).not.toContain("department_requests");
  });

  it("lets only owners read, through policies", () => {
    const ownerPolicies = sql.match(/FOR SELECT TO authenticated USING \(public\.is_owner\(\)\)/g) ?? [];
    expect(ownerPolicies).toHaveLength(5);
    expect(sql).not.toMatch(/FOR (INSERT|UPDATE|DELETE|ALL)\b/);
  });

  it("gives the resolver role nothing but four reads", () => {
    expect(sql).toMatch(/CREATE ROLE departments_resolver\s+NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
    const grant = sql.match(/GRANT SELECT ON TABLE([^;]+)TO departments_resolver;/);
    expect(grant).not.toBeNull();
    const tables = grant![1];
    expect(tables).toContain("person_department_assignments");
    expect(tables).not.toContain("department_requests");
    expect(tables).not.toContain("department_audit");
    expect(sql).not.toMatch(/profiles[^;]*TO departments_resolver/);
  });

  it("does not touch production_events, existing tables or item-counting objects", () => {
    // (It is mentioned in comments on the new tables, but never read or written.)
    expect(sql).not.toMatch(/(ON|TABLE|INTO|FROM|UPDATE|JOIN)\s+(public\.)?production_events/);
    expect(sql).not.toMatch(/reporting_private|reporting_capture/);
    expect(sql).not.toMatch(/ALTER TABLE (public\.)?(profiles|user_locations|staff_barcodes|staff_rates)/);
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN|SCHEMA|FUNCTION)/);
  });
});
