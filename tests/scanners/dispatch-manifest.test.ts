import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Paperwork only: the F7 SQL is exercised by supabase/staging/dispatch-flow
 * (run on staging; pre-checked on local PGlite). This keeps the migration's
 * safety properties and the scripts' guards from silently regressing.
 * Passing this says NOTHING about whether the SQL cases pass.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const text = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const code = (sql: string) => sql.replace(/--.*$/gm, "");
const migrations = join(root, "supabase", "migrations");
const staging = join(root, "supabase", "staging", "dispatch-flow");
const m56 = code(text(join(migrations, "0056_dispatch_flow.sql")));

describe("0056 migration", () => {
  it("is the only F7 number and follows F6; 0048-0051 stay free for F3", () => {
    const files = readdirSync(migrations);
    expect(files.filter((f) => f.startsWith("0056"))).toEqual(["0056_dispatch_flow.sql"]);
    expect(files.filter((f) => /^004[89]|^005[01]/.test(f))).toEqual([]);
  });

  it("pins search_path on every function, revokes defaults, grants no helper", () => {
    const fns = [...m56.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(/g)].map((x) => x[1]);
    expect(fns.sort()).toEqual([
      "dispatch_active_person_name_", "dispatch_attribution_immutable_", "dispatch_canonical_lines_", "dispatch_framing_evidence_",
      "dispatch_person_name_", "scanner_activate_dispatch", "scanner_commit_dispatch", "scanner_dispatch_evidence", "scanner_dispatch_people",
    ]);
    const bodies = m56.split("CREATE OR REPLACE FUNCTION").slice(1);
    for (const b of bodies) expect(b.split("AS $$")[0]).toMatch(/SET search_path = /);
    for (const f of fns) expect(m56).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\(`));
    for (const f of fns.filter((x) => x.endsWith("_"))) expect(m56).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${f}\\(`));
  });

  it("adds tables with RLS, select-only grants and an immutable attribution table", () => {
    for (const t of ["dispatch_requests", "dispatch_framer_attributions"]) {
      expect(m56).toContain(`CREATE TABLE IF NOT EXISTS public.${t}`);
      expect(m56).toContain(`ALTER TABLE public.${t} `);
    }
    expect(m56).toMatch(/REVOKE ALL ON public\.dispatch_requests, public\.dispatch_framer_attributions FROM PUBLIC, anon, authenticated/);
    expect(m56).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*dispatch_/);
    expect(m56).toMatch(/BEFORE UPDATE ON public\.dispatch_framer_attributions/);
    expect(m56).toMatch(/UNIQUE \(location, dispatch_event_id, sku\)/);
    expect(m56).toMatch(/dispatch_requests_one_dispatch_per_order[\s\S]*WHERE kind = 'dispatch' AND outcome = 'saved'/);
  });

  it("is expand-only and never touches F6 objects", () => {
    expect(m56).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION|INDEX|TRIGGER|CONSTRAINT)\b/i);
    expect(m56).not.toMatch(/\bRENAME\b|\bALTER\s+COLUMN\b|SET NOT NULL/i);
    expect(m56).not.toMatch(/ALTER TABLE public\.(scanner_requests|production_events|ledger|products|packaging_)/);
    for (const f6 of ["scanner_commit_framing", "scanner_activate_badge", "scanner_guard_classic_credit_", "production_deduct_locked_", "deduct_inventory_for_event"]) {
      expect(m56).not.toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${f6}\\(`));
    }
    // It reuses the F6 order lock, the locked deduction and F4's apply.
    expect(m56).toMatch(/PERFORM production_order_lock_\(p_location, p_order_number\)/);
    expect(m56).toMatch(/production_deduct_locked_\(p_location, v_event/);
    expect(m56).toMatch(/packaging_apply\(p_location, 'dsp:'/);
  });

  it("manual attribution never writes a framing event", () => {
    const commit = m56.split("CREATE OR REPLACE FUNCTION public.scanner_commit_dispatch(")[1].split("$$;")[0];
    const inserts = [...commit.matchAll(/INSERT INTO production_events[\s\S]*?;/g)].map((m) => m[0]);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatch(/'dispatched'/);
    expect(inserts[0]).not.toMatch(/line_verified|'completed'|'started'/);
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
