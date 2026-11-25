import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ProductionEventSchema } from "@/lib/domain/schemas";
import { EVENT_INSERT_PAYLOADS, F5_SNAPSHOT_COLUMNS } from "../fixtures/departments";

/**
 * F5 adds the department snapshot in the database. The app must keep sending
 * exactly what it sends today: Production.tsx is not edited for snapshots,
 * and no browser code may try to write the new columns.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const production = readFileSync(join(root, "src", "pages", "Production.tsx"), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const relative = (file: string) => file.slice(root.length + 1).replace(/\\/g, "/");

/** The argument of every `.from("production_events").insert(...)`. */
function insertSites(source: string): string[] {
  const sites: string[] = [];
  const marker = /from\("production_events"\)\s*\.insert\(/g;
  for (let m = marker.exec(source); m; m = marker.exec(source)) {
    const start = m.index + m[0].length;
    let depth = 1;
    let end = start;
    while (end < source.length && depth > 0) {
      if (source[end] === "(") depth += 1;
      if (source[end] === ")") depth -= 1;
      end += 1;
    }
    sites.push(source.slice(start, end - 1));
  }
  return sites;
}

describe("production event inserts stay exactly as they are", () => {
  const sites = insertSites(production);

  it("finds the five insert sites in Production.tsx", () => {
    expect(sites).toHaveLength(5);
  });

  it("sends no F5 column from Production.tsx", () => {
    for (const column of F5_SNAPSHOT_COLUMNS) expect(production).not.toContain(column);
  });

  it("has no other writer of production_events in the app or the api", () => {
    const writers = [...sourceFiles(join(root, "src")), ...sourceFiles(join(root, "api"))].filter((file) =>
      /from\(["']production_events["']\)\s*\.(insert|upsert|update)\(/.test(readFileSync(file, "utf8")));
    expect(writers.map(relative)).toEqual(["src/pages/Production.tsx"]);
  });

  it("mentions the F5 columns nowhere outside the shared contracts", () => {
    const allowed = new Set(["src/lib/domain/departments.ts", "src/lib/domain/schemas.ts"]);
    const offenders = [...sourceFiles(join(root, "src")), ...sourceFiles(join(root, "api"))]
      .filter((file) => !allowed.has(relative(file)))
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return F5_SNAPSHOT_COLUMNS.some((c) => text.includes(c));
      });
    expect(offenders.map(relative)).toEqual([]);
  });

  it("still sends the work type, never a business department", () => {
    const literals = sites.filter((s) => s.trimStart().startsWith("{"));
    expect(literals.length).toBeGreaterThan(0);
    for (const site of literals) {
      expect(site).toMatch(/\bdepartment\b/);
      expect(site).not.toMatch(/business_department|department_id/);
    }
  });
});

describe("fixtures match what the insert sites send", () => {
  it("cover all seven event types, the case and parent fields, and default-time clock events", () => {
    const payloads = Object.values(EVENT_INSERT_PAYLOADS);
    expect(new Set(payloads.map((p) => p.event_type))).toEqual(
      new Set(["started", "completed", "cancelled", "dispatched", "line_verified", "clock_in", "clock_out"]));
    expect(payloads.some((p) => p.cs_case_id === "case-1")).toBe(true);
    expect(payloads.some((p) => p.parent_event_id === "evt_2")).toBe(true);
    for (const clock of payloads.filter((p) => String(p.event_type).startsWith("clock_"))) {
      expect(clock).not.toHaveProperty("created_at");
      expect(clock).not.toHaveProperty("order_number");
    }
  });

  it("parse once the database has added its defaults, with or without a snapshot", () => {
    for (const [site, payload] of Object.entries(EVENT_INSERT_PAYLOADS)) {
      const stored = { order_number: null, created_at: "2026-11-22T09:00:00.000Z", ...payload };
      expect(ProductionEventSchema.safeParse(stored).success, site).toBe(true);
      const resolved = { ...stored, business_department_status: "unassigned", department_snapshot_version: 1, department_time_status: "reported" };
      expect(ProductionEventSchema.safeParse(resolved).success, site).toBe(true);
    }
  });
});
