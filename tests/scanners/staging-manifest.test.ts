import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Paperwork only: the F6 SQL is exercised by supabase/staging/scanner-stations
 * (run on staging; pre-checked on local PGlite). This keeps the migration's
 * safety properties and the scripts' guards from silently regressing.
 * Passing this says NOTHING about whether the SQL cases pass.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const text = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const code = (sql: string) => sql.replace(/--.*$/gm, "");
const migrations = join(root, "supabase", "migrations");
const staging = join(root, "supabase", "staging", "scanner-stations");
const m55 = code(text(join(migrations, "0055_scanner_stations.sql")));

describe("0055 migration", () => {
  it("is the only F6 number; 0048-0051 stay free for F3", () => {
    const files = readdirSync(migrations);
    expect(files.filter((f) => f.startsWith("0055"))).toEqual(["0055_scanner_stations.sql"]);
    expect(files.filter((f) => /^005[0189]|^004[89]/.test(f))).toEqual([]);
  });

  it("pins search_path on every function and revokes defaults", () => {
    const fns = [...m55.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(/g)].map((x) => x[1]);
    expect(fns.sort()).toEqual([
      "deduct_inventory_for_event", "production_deduct_locked_", "production_order_lock_", "scanner_activate_badge",
      "scanner_commit_framing", "scanner_guard_classic_credit_", "scanner_hash_", "scanner_heartbeat", "scanner_require_operator_", "scanner_site_zone_",
      "scanner_workday_start_",
    ]);
    const bodies = m55.split("CREATE OR REPLACE FUNCTION").slice(1);
    for (const b of bodies) expect(b.split("AS $$")[0]).toMatch(/SET search_path = /);
    for (const f of fns) expect(m55).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\(`));
    for (const f of fns.filter((x) => x.endsWith("_"))) {
      expect(m55).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${f}\\(`));
    }
  });

  it("adds tables with RLS and no client writes", () => {
    for (const t of ["scanner_requests", "scanner_receivers"]) {
      expect(m55).toContain(`CREATE TABLE IF NOT EXISTS public.${t}`);
      expect(m55).toContain(`ALTER TABLE public.${t} `.trimEnd());
    }
    expect(m55).toMatch(/REVOKE ALL ON public\.scanner_requests, public\.scanner_receivers FROM PUBLIC, anon, authenticated/);
    expect(m55).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*scanner_(requests|receivers)/);
  });

  it("never drops, renames or retypes anything (expand only)", () => {
    expect(m55).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION|INDEX|TRIGGER)\b/i);
    expect(m55).not.toMatch(/\bRENAME\b|\bALTER\s+COLUMN\b|SET NOT NULL/i);
  });
});

describe("staging scripts", () => {
  const files = ["01-fixtures.sql", "02-assertions.sql", "05-session-a.sql", "05-session-b.sql", "09-cleanup.sql"];
  it("exist, and the ones that change data refuse to run outside staging", () => {
    for (const f of files) expect(readdirSync(staging)).toContain(f);
    for (const f of ["01-fixtures.sql", "02-assertions.sql", "09-cleanup.sql"]) {
      expect(text(join(staging, f))).toMatch(/Refusing to run: staging only/);
    }
  });
  it("02 rolls everything back; nothing sleeps", () => {
    expect(code(text(join(staging, "02-assertions.sql"))).trim().endsWith("ROLLBACK;")).toBe(true);
    for (const f of files) expect(code(text(join(staging, f)))).not.toMatch(/pg_sleep/);
  });
});
