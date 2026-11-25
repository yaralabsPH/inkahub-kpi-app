import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The staging SQL scripts are run by a person against the staging database;
 * vitest never runs them. This test only keeps the paperwork honest:
 *   - every acceptance checkbox in the spec points at a named SQL case
 *     and/or a Preview (Gate B) step;
 *   - every named case really exists in the scripts;
 *   - the scripts keep their safety properties (staging guard, rollback, no
 *     credentials, no sleeps, nothing that touches item-counting objects).
 * Passing this test says NOTHING about whether the SQL cases pass.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dir = join(root, "supabase", "staging", "departments");
// Line endings are normalized: a Windows checkout may have CRLF.
const text = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const script = (name: string) => text(join(dir, name));
const code = (sql: string) => sql.replace(/--.*$/gm, "");

const SCRIPTS = [
  "00-preflight.sql", "01-fixtures.sql", "02-assertions.sql", "05-session-a.sql", "05-session-b.sql",
  "06-composition.sql", "07-performance.sql", "08-health.sql", "09-cleanup.sql",
];

interface Coverage {
  /** Start of the spec checkbox text. */
  criterion: string;
  /** Case ids in 02-assertions.sql. */
  sql: string[];
  /** Also checked by hand on the Preview. */
  ui?: boolean;
}

// One entry per acceptance checkbox, in the spec's order.
const COVERAGE: Coverage[] = [
  { criterion: "Create \u201C  Department   A  \u201D", sql: ["E01", "E02", "C01"], ui: true },
  { criterion: "Rename unused C to", sql: ["E12", "E13"], ui: true },
  { criterion: "Archive C2: it disappears", sql: ["E21", "E22"], ui: true },
  { criterion: "Restore C2: it returns", sql: ["E25", "E26"], ui: true },
  { criterion: "Assign Person 1 to A", sql: ["E27", "E28", "E29"], ui: true },
  { criterion: "Transfer Person 1 from A to B", sql: ["F16", "F18"], ui: true },
  { criterion: "Re-read E1 after that transfer", sql: ["F19"] },
  { criterion: "Rename A to \u201CDepartment A2\u201D at R", sql: ["F22", "F23"] },
  { criterion: "Archive B while Person 1 belongs to it", sql: ["E33", "E34"], ui: true },
  { criterion: "Person 2 records an authorized work event", sql: ["F12", "F13"] },
  { criterion: "Replay an old payload omitting all F5 fields", sql: ["F08", "F09", "F08b", "F09b"], ui: true },
  { criterion: "Insert one of each of the seven event types", sql: ["F08", "F09", "F10"] },
  { criterion: "Turn the owner switch off and record E2", sql: ["F24", "F25", "F26"], ui: true },
  { criterion: "Turn the switch on and record E3", sql: ["F27", "F28", "F29"], ui: true },
  { criterion: "Each manager/staff/kiosk/CS account calls create/transfer/control RPCs", sql: ["D01", "D02", "D05", "D06", "D08"], ui: true },
  { criterion: "Each non-owner directly requests the new department/assignment tables", sql: ["D03", "D04"], ui: true },
  { criterion: "Compare a pre-migration event before/after migration", sql: ["I01", "I02", "I03"] },
  { criterion: "With reported time O = receipt S + 2 seconds", sql: ["G26", "G27"] },
  { criterion: "SQL boundary fixture at O = S + 5 seconds:", sql: ["B04"] },
  { criterion: "SQL boundary fixture at O = S + 5 seconds + 1 microsecond", sql: ["B05"] },
  { criterion: "Insert an event reported 30 seconds ahead", sql: ["G28", "G29"] },
  { criterion: "For a clamped event received before transfer T", sql: ["G31", "G32", "G33"] },
  { criterion: "SQL boundary fixture at O = S \u2212 5 minutes:", sql: ["B06"] },
  { criterion: "SQL boundary fixture at O = S \u2212 5 minutes \u2212 1 microsecond", sql: ["B07"] },
  { criterion: "With tracked O two hours before receipt", sql: ["G10", "G11"] },
  { criterion: "Run the health query over those fixtures", sql: ["N01", "N02", "N03"] },
  { criterion: "Submit a delayed event exactly at T", sql: ["G18", "G19"] },
  { criterion: "Submit a delayed event in A's interval exactly at R", sql: ["G14", "G15"] },
  { criterion: "With only the resolver trigger disabled", sql: ["M01", "M02"] },
  { criterion: "Retry one transfer request after a simulated lost response", sql: ["F17", "F18"] },
];

describe("spec acceptance criteria are all mapped", () => {
  const spec = text(join(root, "docs", "specs", "departments.md"));
  const section = spec.slice(spec.indexOf("## Acceptance criteria"), spec.indexOf("## Data and backend impact"));
  const checkboxes = section.split("\n").filter((l) => l.startsWith("- [ ] ")).map((l) => l.slice(6));
  const assertions = script("02-assertions.sql");

  it("finds the spec's thirty checkboxes", () => {
    expect(checkboxes).toHaveLength(30);
    expect(COVERAGE).toHaveLength(checkboxes.length);
  });

  it("maps each checkbox, in order, to at least one named SQL case", () => {
    checkboxes.forEach((text, i) => {
      expect(text.startsWith(COVERAGE[i].criterion), `checkbox ${i + 1}: "${text.slice(0, 60)}"`).toBe(true);
      expect(COVERAGE[i].sql.length, text).toBeGreaterThan(0);
    });
  });

  it("names only cases that exist in 02-assertions.sql", () => {
    for (const entry of COVERAGE) {
      for (const id of entry.sql) {
        expect(assertions.includes(`'${id} `), `${id} (for "${entry.criterion}")`).toBe(true);
      }
    }
  });

  it("uses each case id for one case only", () => {
    // (A case may be written twice when it has a pass branch and a fail
    // branch; what must not happen is one id naming two different cases.)
    const cases = [...assertions.matchAll(/pg_temp\.f5_(?:ok|must|refused)\(\s*(?:format\()?'(([A-Z]\d{2}b?) [^']*)'/g)];
    expect(cases.length).toBeGreaterThan(150);
    const names = new Map<string, Set<string>>();
    for (const m of cases) names.set(m[2], (names.get(m[2]) ?? new Set<string>()).add(m[1]));
    expect([...names].filter(([, set]) => set.size > 1).map(([id]) => id)).toEqual([]);
  });

  it("lists the Preview steps for the checkboxes that also need the real UI", () => {
    const runbook = text(join(root, "docs", "runbooks", "departments.md"));
    const needUi = COVERAGE.filter((c) => c.ui).length;
    expect(needUi).toBeGreaterThan(8);
    expect(runbook).toContain("(Gate B)");
    const steps = runbook.slice(runbook.indexOf("(Gate B)")).match(/^\| B\d+ /gm) ?? [];
    expect(steps.length).toBeGreaterThanOrEqual(needUi);
  });
});

describe("the scripts keep their safety properties", () => {
  it("delivers exactly the documented scripts", () => {
    expect(readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()).toEqual([...SCRIPTS].sort());
    expect(readdirSync(dir)).toContain("README.md");
  });

  it("refuses to change anything unless the database has a 'staging' location", () => {
    for (const name of ["01-fixtures.sql", "02-assertions.sql", "06-composition.sql", "07-performance.sql", "09-cleanup.sql"]) {
      const sql = code(script(name));
      expect(sql, name).toMatch(/IF NOT EXISTS \(SELECT 1 FROM public\.locations WHERE key = 'staging'\) THEN\s+RAISE EXCEPTION/);
    }
  });

  it("says STAGING ONLY at the top of every script", () => {
    for (const name of SCRIPTS) {
      const head = script(name).split("\n").slice(0, 12).join("\n");
      // The health queries are also the production read-only health check.
      if (name === "08-health.sql") expect(head).toContain("READ-ONLY");
      else expect(head, name).toContain("STAGING ONLY");
    }
  });

  it("keeps the read-only scripts read-only", () => {
    for (const name of ["00-preflight.sql", "08-health.sql"]) {
      const sql = code(script(name));
      const statements = sql.split(";").map((st) => st.trim()).filter(Boolean);
      expect(statements.length, name).toBeGreaterThan(5);
      for (const st of statements) expect(st.slice(0, 6), name).toBe("SELECT");
      expect(sql, name).not.toMatch(/set_config|department_admin|department_set_snapshot_enabled|pg_advisory|nextval| INTO /);
    }
  });

  it("rolls back everything in the single-transaction scripts", () => {
    for (const name of ["02-assertions.sql", "06-composition.sql", "07-performance.sql"]) {
      const sql = code(script(name));
      expect(sql.trimEnd().endsWith("ROLLBACK;"), name).toBe(true);
      expect(sql, name).not.toMatch(/^COMMIT;/m);
      expect(sql.match(/^BEGIN;/gm), name).toHaveLength(1);
    }
  });

  it("stops on the first failed assertion and never reports skipped cases as passed", () => {
    const sql = script("02-assertions.sql");
    expect(sql).toContain("RAISE EXCEPTION 'F5 verify FAILED [%] %'");
    expect(sql).toContain("Skipped cases are NOT passed");
    expect(sql).toContain("F5 verify: ALL CHECKS PASSED");
    expect(script("06-composition.sql")).toContain("PENDING, not passed");
    expect(script("07-performance.sql")).toContain("PENDING");
    expect(script("05-session-a.sql")).toContain("still pending, do not record as passed");
  });

  it("uses only synthetic names and ids", () => {
    for (const name of SCRIPTS) {
      const sql = script(name);
      for (const email of sql.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? []) expect(email, name).toMatch(/@inka-staging\.test$/);
      for (const id of sql.match(/'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}'/g) ?? []) {
        expect(id, name).toMatch(/^'f57[0-4]0000-/);
      }
    }
    const names = script("02-assertions.sql").match(/'F5T [A-Za-z0-9 ]+'/g) ?? [];
    expect(names.length).toBeGreaterThan(10);
  });

  it("contains no credentials, project URLs or connection strings", () => {
    for (const name of SCRIPTS) {
      const sql = script(name);
      expect(sql, name).not.toMatch(/postgres(ql)?:\/\/|supabase\.co|eyJ[A-Za-z0-9_-]{10,}|service_role_key|password\s*=/i);
    }
  });

  it("never applies a migration, drops an object or changes item-counting objects", () => {
    for (const name of SCRIPTS) {
      const sql = code(script(name));
      expect(sql, name).not.toMatch(/\bDROP (TABLE|SCHEMA|FUNCTION|TRIGGER|POLICY|EXTENSION|ROLE|COLUMN)\b/);
      expect(sql, name).not.toMatch(/CREATE (OR REPLACE )?FUNCTION (public|departments_private)\./);
      expect(sql, name).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE|TRUNCATE)\s+reporting_private/);
      expect(sql, name).not.toMatch(/(DISABLE|ENABLE) TRIGGER (ALL|USER|production_events_reporting_capture)/);
    }
  });

  it("only ever toggles the one named resolver trigger, and always turns it back on", () => {
    for (const name of ["02-assertions.sql", "07-performance.sql"]) {
      const sql = code(script(name));
      const off = sql.match(/ALTER TABLE public\.production_events DISABLE TRIGGER (\w+);/g) ?? [];
      const on = sql.match(/ALTER TABLE public\.production_events ENABLE TRIGGER (\w+);/g) ?? [];
      expect(off, name).toEqual(["ALTER TABLE public.production_events DISABLE TRIGGER production_events_f5_20_resolve;"]);
      expect(on, name).toEqual(["ALTER TABLE public.production_events ENABLE TRIGGER production_events_f5_20_resolve;"]);
    }
  });

  it("decides races with locks, not sleeps", () => {
    for (const name of ["05-session-a.sql", "05-session-b.sql"]) {
      expect(code(script(name)), name).not.toMatch(/pg_sleep/);
    }
    const a = script("05-session-a.sql");
    for (const schedule of ["S1", "S2", "S3", "S5", "S6", "S7", "S8", "S9"]) expect(a).toContain(`-- ${schedule}.`);
    expect(a.match(/-- Expect:/g)!.length).toBeGreaterThan(12);
    expect(script("05-session-b.sql").match(/-- Expect:/g)!.length).toBeGreaterThan(8);
  });

  it("cleans up only the synthetic F5X rows, with guards", () => {
    const sql = code(script("09-cleanup.sql"));
    expect(sql).toContain("normalized_name LIKE 'f5x %'");
    expect(sql).toContain("id LIKE 'f5x-%'");
    expect(sql).toContain("a non-synthetic person has history");
    expect(sql).not.toMatch(/DELETE FROM public\.\w+\s*;/); // no unfiltered delete
    for (const del of sql.match(/DELETE FROM [^;]+;/g) ?? []) expect(del).toMatch(/v_people|v_depts/);
  });
});
