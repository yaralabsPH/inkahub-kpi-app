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
// Line endings are normalized: a Windows checkout may have CRLF.
const read = (name: string) => readFileSync(join(migrationsDir, name), "utf8").replace(/\r\n/g, "\n");
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
    expect(sql).not.toMatch(/\b(ON|TABLE|INTO|FROM|UPDATE|JOIN)\s+(public\.)?production_events\b/);
    expect(sql).not.toMatch(/reporting_private|reporting_capture/);
    expect(sql).not.toMatch(/ALTER TABLE (public\.)?(profiles|user_locations|staff_barcodes|staff_rates)/);
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN|SCHEMA|FUNCTION)/);
  });
});

describe("0053 administration and profile lifecycle", () => {
  const sql = code(read("0053_departments_admin.sql"));
  const PUBLIC_FUNCTIONS = [
    "public.department_admin(text, uuid, uuid, uuid, text, bigint, uuid, text)",
    "public.department_set_snapshot_enabled(uuid, boolean, bigint, text)",
    "public.department_owner_page(text, uuid, jsonb, integer)",
  ];
  /** The body of one function, from its CREATE to the closing $fn$;. */
  const body = (name: string) => {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    return sql.slice(start, sql.indexOf("$fn$;", start));
  };

  it("exposes exactly three functions, with no overloads or defaults", () => {
    const created = (sql.match(/CREATE OR REPLACE FUNCTION public\.\w+/g) ?? []).sort();
    expect(created).toEqual([
      "CREATE OR REPLACE FUNCTION public.department_admin",
      "CREATE OR REPLACE FUNCTION public.department_owner_page",
      "CREATE OR REPLACE FUNCTION public.department_set_snapshot_enabled",
    ]);
    expect(sql).not.toMatch(/\bDEFAULT\b/);
  });

  it("pins search_path on every function and uses no dynamic SQL", () => {
    const functions = sql.match(/CREATE OR REPLACE FUNCTION/g) ?? [];
    const pinned = sql.match(/SET search_path = pg_catalog/g) ?? [];
    expect(pinned).toHaveLength(functions.length);
    expect(sql).not.toMatch(/\bEXECUTE\s+(format|'|\w+\s*\|\|)/);
  });

  it("checks the owner role before anything else in each public function", () => {
    for (const name of ["public.department_admin", "public.department_set_snapshot_enabled", "public.department_owner_page"]) {
      const b = body(name);
      const begin = b.indexOf("BEGIN");
      const firstStatement = b.slice(begin + 5).trim();
      expect(firstStatement.startsWith("v_actor := departments_private.require_owner();")
        || firstStatement.startsWith("PERFORM departments_private.require_owner();"), name).toBe(true);
      expect(b).toContain("SECURITY DEFINER");
    }
    const owner = body("departments_private.require_owner");
    expect(owner).toContain("auth.uid()");
    expect(owner).toContain("FROM public.profiles p WHERE p.user_id = v_actor");
    expect(owner).toContain("IS DISTINCT FROM 'owner'");
    expect(owner).not.toMatch(/user_metadata|allowed_nav/);
  });

  it("authorizes and locks before returning a stored receipt, then picks the time", () => {
    for (const name of ["public.department_admin", "public.department_set_snapshot_enabled"]) {
      const b = body(name);
      const owner = b.indexOf("require_owner()");
      const lock = b.indexOf("PERFORM departments_private.lock_exclusive();");
      const receipt = b.indexOf("FROM public.department_requests r");
      const now = b.indexOf("v_now := clock_timestamp();");
      expect(owner).toBeGreaterThan(-1);
      expect(lock).toBeGreaterThan(owner);
      expect(receipt).toBeGreaterThan(lock);
      expect(now).toBeGreaterThan(receipt);
      expect(b).toContain("'request_id_reused'");
      // The receipt is written last, in the same transaction as the change.
      expect(b.lastIndexOf("INSERT INTO public.department_requests")).toBeGreaterThan(b.lastIndexOf("INSERT INTO public.department_audit"));
    }
  });

  it("uses the one reserved exclusive lock with a two-second bound", () => {
    const lock = body("departments_private.lock_exclusive");
    expect(lock).toContain("pg_advisory_xact_lock(494749, 5)");
    expect(lock).toContain("set_config('lock_timeout', '2s', true)");
    expect(lock).toContain("set_config('lock_timeout', v_previous, true)");
    expect(lock).toContain("'read committed'");
    expect(sql.match(/pg_advisory_xact_lock\(/g)).toHaveLength(1);
  });

  it("never lets a caller choose the effective time", () => {
    for (const fn of PUBLIC_FUNCTIONS) expect(fn).not.toMatch(/timestamptz/);
    expect(body("public.department_admin")).not.toMatch(/p_(effective|valid|at)\w*/);
  });

  it("uses the agreed error codes", () => {
    const admin = body("public.department_admin");
    for (const state of ["'22023'", "'40001'", "'23505'", "'P0001'"]) expect(admin).toContain(state);
    expect(admin).toContain("'department_has_members'");
    expect(body("departments_private.require_owner")).toContain("'42501'");
  });

  it("requires a current profile to open an assignment and never deletes history", () => {
    const admin = body("public.department_admin");
    expect(admin).toContain("FROM public.profiles p WHERE p.user_id = p_person_id");
    expect(sql).not.toMatch(/DELETE FROM/);
    // Updates of history rows only ever close them.
    for (const u of sql.match(/UPDATE public\.(person_department_assignments|business_department_names)[^;]+;/g) ?? []) {
      expect(u).toMatch(/SET valid_to = v_now, closed_at = v_now/);
    }
  });

  it("closes the open assignment when a profile is deleted, under the same lock", () => {
    expect(sql).toMatch(/CREATE TRIGGER profiles_f5_10_close_assignment\s+BEFORE DELETE ON public\.profiles\s+FOR EACH ROW/);
    const fn = body("departments_private.close_profile_assignment");
    expect(fn).toContain("PERFORM departments_private.lock_exclusive();");
    expect(fn).toContain("'profile_removed_actor_unavailable'");
    expect(fn).toContain("'remove'");
    // It does not touch the Auth user, barcodes or location grants.
    expect(fn).not.toMatch(/auth\.users|staff_barcodes|user_locations/);
  });

  it("limits pages to 100 rows and validates the cursor", () => {
    const page = body("public.department_owner_page");
    expect(page).toContain("p_limit < 1 OR p_limit > 100");
    expect(page).toContain("'invalid_cursor'");
    expect(page).not.toMatch(/hourly_rate|email|allowed_nav|\brole\b/);
  });

  it("revokes every function from every client role, then grants exactly the three", () => {
    const functions = sql.match(/CREATE OR REPLACE FUNCTION/g) ?? [];
    const revokes = sql.match(/REVOKE ALL ON FUNCTION[^;]+FROM PUBLIC, anon, authenticated, service_role;/g) ?? [];
    expect(revokes).toHaveLength(functions.length);
    const grants = sql.match(/GRANT EXECUTE ON FUNCTION[^;]+;/g) ?? [];
    expect(grants).toHaveLength(3);
    for (const g of grants) {
      expect(g).toMatch(/TO authenticated;$/);
      expect(g).toMatch(/ON FUNCTION public\./);
    }
    for (const fn of PUBLIC_FUNCTIONS) expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${fn}`);
  });

  it("does not read or write events, and changes no existing object", () => {
    expect(sql).not.toMatch(/production_events/);
    expect(sql).not.toMatch(/reporting_private|reporting_capture/);
    expect(sql).not.toMatch(/ALTER (TABLE|DEFAULT PRIVILEGES)/);
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN|SCHEMA|FUNCTION|POLICY)/);
  });
});

describe("0054 event snapshots", () => {
  const sql = code(read("0054_departments_snapshots.sql"));
  const COLUMNS = [
    "business_department_id", "business_department_name", "business_department_assignment_id",
    "business_department_name_version_id", "business_department_status", "department_snapshot_version",
    "department_occurred_at", "department_received_at", "department_resolution_instant",
    "department_time_status", "department_resolved_at",
  ];
  const body = (name: string) => {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION departments_private.${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    return sql.slice(start, sql.indexOf("$fn$;", start));
  };

  it("adds eleven nullable columns with no default, constraint or foreign key", () => {
    const alter = sql.slice(sql.indexOf("ALTER TABLE public.production_events"), sql.indexOf("COMMENT ON COLUMN"));
    const added = alter.match(/ADD COLUMN IF NOT EXISTS (\w+)\s+(\w+)(.*)/g) ?? [];
    expect(added).toHaveLength(11);
    for (const c of COLUMNS) expect(alter).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${c}\\s`));
    expect(alter).not.toMatch(/NOT NULL|DEFAULT|REFERENCES|CHECK/);
    expect(sql).not.toMatch(/ADD CONSTRAINT|ALTER COLUMN|DROP COLUMN|DROP CONSTRAINT/);
  });

  it("never updates or backfills events and never touches item-counting objects", () => {
    expect(sql).not.toMatch(/UPDATE\s+(public\.)?production_events/);
    expect(sql).not.toMatch(/INSERT INTO\s+(public\.)?production_events/);
    expect(sql).not.toMatch(/DELETE FROM/);
    expect(sql).not.toMatch(/reporting_private|reporting_capture/);
    expect(sql).not.toMatch(/ledger|deduct_inventory|packaging_/);
    expect(sql).not.toMatch(/DISABLE TRIGGER|DROP POLICY|CREATE POLICY|ALTER POLICY/);
  });

  it("names the triggers so sanitize fires before resolve", () => {
    const triggers = (sql.match(/CREATE TRIGGER (\w+)\s+BEFORE (INSERT|UPDATE) ON public\.production_events/g) ?? [])
      .map((t) => t.replace(/\s+/g, " "));
    expect(triggers).toEqual([
      "CREATE TRIGGER production_events_f5_10_sanitize BEFORE INSERT ON public.production_events",
      "CREATE TRIGGER production_events_f5_20_resolve BEFORE INSERT ON public.production_events",
      "CREATE TRIGGER production_events_f5_10_freeze BEFORE UPDATE ON public.production_events",
    ]);
    expect("production_events_f5_10_sanitize" < "production_events_f5_20_resolve").toBe(true);
    expect(sql).not.toMatch(/AFTER (INSERT|UPDATE|DELETE)/);
  });

  it("sanitize overwrites every F5 column and looks nothing up", () => {
    const fn = body("sanitize_event");
    for (const c of COLUMNS) expect(fn).toMatch(new RegExp(`NEW\\.${c}\\s+:=`));
    expect(fn).toContain("'resolver_unavailable'");
    expect(fn).toContain("NEW.department_occurred_at              := NEW.created_at;");
    expect(fn).toContain("NEW.department_received_at              := clock_timestamp();");
    const statements = fn.slice(fn.indexOf("AS $fn$"));
    expect(statements).not.toMatch(/SELECT|FROM public\.|departments_private\.|PERFORM/);
    expect(fn).not.toContain("SECURITY DEFINER");
  });

  it("freeze copies every F5 column back and protects who/when/where/which", () => {
    const fn = body("freeze_event");
    for (const c of COLUMNS) expect(fn).toMatch(new RegExp(`NEW\\.${c}\\s+:= OLD\\.${c};`));
    for (const key of ["staff_id", "created_at", "location", "id"]) {
      expect(fn).toMatch(new RegExp(`NEW\\.${key}\\s+IS DISTINCT FROM OLD\\.${key}`));
    }
    expect(fn).toContain("OLD.business_department_status IS NOT NULL");
    expect(fn).not.toMatch(/SELECT|SECURITY DEFINER/);
  });

  it("classifies time with the approved bounds", () => {
    const fn = body("classify_time");
    expect(fn).toContain("p_occurred_at - p_received_at > interval '5 seconds'");
    expect(fn).toContain("p_received_at - p_occurred_at > interval '5 minutes'");
    expect(fn).toContain("resolution_instant := p_received_at;");
    for (const s of ["invalid_time", "future_clamped", "reported_old", "reported"]) expect(fn).toContain(`'${s}'`);
    expect(fn).toContain("isfinite(p_occurred_at)");
  });

  it("resolves by the credited worker, with a try-shared lock and a fresh lookup after it", () => {
    const fn = body("resolve_event");
    expect(fn).toContain("WHERE a.person_id = NEW.staff_id");
    expect(fn).not.toContain("auth.uid()");
    const lock = fn.indexOf("pg_try_advisory_xact_lock_shared(494749, 5)");
    const lookup = fn.indexOf("FROM public.person_department_assignments a");
    expect(lock).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(lock);
    // Never a waiting lock on the insert path.
    expect(sql).not.toMatch(/pg_advisory_xact_lock\(|pg_advisory_lock\(|pg_advisory_xact_lock_shared\(/);
    expect(fn).toContain("'read committed'");
    for (const s of ["assigned", "unassigned", "before_tracking", "invalid_time", "resolution_busy", "resolution_error", "disabled", "control_missing"]) {
      expect(fn).toContain(`'${s}'`);
    }
    // Off / missing configuration is decided before time or lookup problems.
    expect(fn.indexOf("'control_missing'")).toBeLessThan(fn.indexOf("'before_tracking'"));
    expect(fn.indexOf("'disabled'")).toBeLessThan(fn.indexOf("'before_tracking'"));
    expect(fn).not.toMatch(/INSERT INTO|UPDATE |DELETE /);
  });

  it("turns a failed lookup into a status, not a rejected scan", () => {
    const fn = body("resolve_event");
    const handler = fn.slice(fn.indexOf("EXCEPTION WHEN OTHERS THEN"));
    expect(handler).toContain("NEW.business_department_status          := 'resolution_error';");
    expect(handler).toContain("NEW.business_department_id              := NULL;");
    // The warning carries the event key only, and cannot itself fail the insert.
    expect(handler).toContain("RAISE WARNING 'f5_departments resolution_error location=% id=% sqlstate=%', NEW.location, NEW.id, SQLSTATE;");
    expect(handler).not.toMatch(/order_number|note|line_sku|staff_id/);
    expect(handler.match(/EXCEPTION WHEN OTHERS THEN/g)).toHaveLength(2);
    expect(fn.replace(/\s+/g, " ").trimEnd().endsWith("RETURN NEW; END;")).toBe(true);
  });

  it("runs the resolver as departments_resolver and removes the temporary grants", () => {
    expect(sql).toContain("ALTER FUNCTION departments_private.resolve_event() OWNER TO departments_resolver;");
    const commit = sql.lastIndexOf("COMMIT;");
    const pairs = [
      ["GRANT departments_resolver TO CURRENT_USER;", "REVOKE departments_resolver FROM CURRENT_USER;"],
      ["GRANT CREATE ON SCHEMA departments_private TO departments_resolver;", "REVOKE CREATE ON SCHEMA departments_private FROM departments_resolver;"],
    ];
    for (const [grant, revoke] of pairs) {
      expect(sql.indexOf(grant)).toBeGreaterThan(-1);
      expect(sql.indexOf(revoke)).toBeGreaterThan(sql.indexOf(grant));
      expect(sql.indexOf(revoke)).toBeLessThan(commit);
    }
    const revokes = sql.match(/REVOKE ALL ON FUNCTION[^;]+FROM PUBLIC, anon, authenticated, service_role;/g) ?? [];
    expect(revokes).toHaveLength(4);
    const grants = sql.match(/GRANT EXECUTE ON FUNCTION[^;]+;/g) ?? [];
    expect(grants).toEqual(["GRANT EXECUTE ON FUNCTION departments_private.classify_time(timestamptz, timestamptz) TO departments_resolver;"]);
  });

  it("adds only the receipt-time index, for new rows only", () => {
    const indexes = sql.match(/CREATE INDEX[^;]+;/g) ?? [];
    expect(indexes).toHaveLength(1);
    expect(indexes[0]).toContain("production_events_department_received_idx");
    expect(indexes[0]).toContain("(department_received_at, location, id)");
    expect(indexes[0]).toContain("WHERE department_received_at IS NOT NULL");
  });
});
