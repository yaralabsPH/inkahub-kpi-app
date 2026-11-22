import { describe, expect, it } from "vitest";
import {
  DEPARTMENT_SNAPSHOT_FIELDS,
  DepartmentMutationResultSchema,
  FUTURE_CLAMP_US,
  REPORTED_OLD_US,
  checkDepartmentAdminArgs,
  checkDepartmentName,
  checkDepartmentReason,
  classifyDepartmentTime,
  containsDepartmentInstant,
  departmentIntervalsOverlap,
  departmentNameKey,
  departmentSnapshotProblem,
  formatDepartmentInstant,
  previewDepartmentName,
  resolveDepartmentInterval,
  type DepartmentAdminArgs,
} from "../departments";
import { ProductionEventSchema } from "../schemas";
import {
  ASSIGN_A, ASSIGN_B, DAY_US, DEPT_A, EVENT_INSERT_PAYLOADS, F5_SNAPSHOT_COLUMNS, HOUR_US, NAME_A1,
  PERSON_1, PERSON_1_INTERVALS, REQUEST_1, T, us,
} from "../../../../tests/fixtures/departments";

describe("department names", () => {
  it("collapses spaces and trims but keeps the casing", () => {
    expect(previewDepartmentName("  Department   A  ")).toBe("Department A");
    expect(previewDepartmentName("Department\u00A0\u2003A")).toBe("Department A");
  });

  it("uses a lower-cased key for uniqueness", () => {
    expect(departmentNameKey("  DEPARTMENT   a ")).toBe("department a");
  });

  it("refuses tabs, line breaks and control characters instead of collapsing them", () => {
    for (const bad of ["Dept\tA", "Dept\nA", "Dept\u0000A", "Dept\u0085A", "Dept\u2028A"]) {
      expect(checkDepartmentName(bad).ok).toBe(false);
    }
  });

  it("requires 1 to 80 characters after normalizing, counted as code points", () => {
    expect(checkDepartmentName("   ").ok).toBe(false);
    expect(checkDepartmentName("x".repeat(80))).toEqual({ ok: true, name: "x".repeat(80) });
    expect(checkDepartmentName("x".repeat(81)).ok).toBe(false);
    // 80 astral characters are 160 UTF-16 units but 80 characters.
    expect(checkDepartmentName("\u{1F600}".repeat(80)).ok).toBe(true);
    expect(checkDepartmentName("\u{1F600}".repeat(81)).ok).toBe(false);
    // Padding does not count.
    expect(checkDepartmentName(`  ${"x".repeat(80)}  `).ok).toBe(true);
  });

  it("limits reasons to 500 characters and requires one only when asked", () => {
    expect(checkDepartmentReason("", false)).toEqual({ ok: true, reason: "" });
    expect(checkDepartmentReason("   ", true).ok).toBe(false);
    expect(checkDepartmentReason("r".repeat(500), true).ok).toBe(true);
    expect(checkDepartmentReason("r".repeat(501), false).ok).toBe(false);
  });
});

describe("time classification (O = reported, S = received)", () => {
  const S = us("2026-11-22T10:00:00.000Z");
  const at = (delta: bigint) => classifyDepartmentTime(S + delta, S);

  it("uses the reported time when it is not ahead and not old", () => {
    expect(at(0n)).toEqual({ timeStatus: "reported", resolutionUs: S });
    expect(at(-1_000_000n)).toEqual({ timeStatus: "reported", resolutionUs: S - 1_000_000n });
  });

  it("clamps a slightly fast clock to the receipt time, up to exactly 5 seconds", () => {
    expect(at(1n)).toEqual({ timeStatus: "future_clamped", resolutionUs: S });
    expect(at(1_000_000n)).toEqual({ timeStatus: "future_clamped", resolutionUs: S });
    expect(at(2_000_000n)).toEqual({ timeStatus: "future_clamped", resolutionUs: S });
    expect(at(FUTURE_CLAMP_US)).toEqual({ timeStatus: "future_clamped", resolutionUs: S });
  });

  it("gives no resolution instant beyond 5 seconds ahead", () => {
    expect(at(FUTURE_CLAMP_US + 1n)).toEqual({ timeStatus: "invalid_time", resolutionUs: null });
    expect(at(30_000_000n)).toEqual({ timeStatus: "invalid_time", resolutionUs: null });
  });

  it("flags, but still uses, a reported time more than 5 minutes behind", () => {
    expect(at(-REPORTED_OLD_US)).toEqual({ timeStatus: "reported", resolutionUs: S - REPORTED_OLD_US });
    expect(at(-REPORTED_OLD_US - 1n)).toEqual({ timeStatus: "reported_old", resolutionUs: S - REPORTED_OLD_US - 1n });
    expect(at(-2n * HOUR_US).timeStatus).toBe("reported_old");
    expect(at(-2n * DAY_US)).toEqual({ timeStatus: "reported_old", resolutionUs: S - 2n * DAY_US });
  });

  it("treats a missing or non-finite reported time as invalid", () => {
    expect(classifyDepartmentTime(null, S)).toEqual({ timeStatus: "invalid_time", resolutionUs: null });
  });
});

describe("half-open assignment intervals", () => {
  it("includes the start and excludes the end", () => {
    const from = us("2026-11-20T00:00:00.000Z");
    expect(containsDepartmentInstant(from, T, from)).toBe(true);
    expect(containsDepartmentInstant(from, T, T - 1n)).toBe(true);
    expect(containsDepartmentInstant(from, T, T)).toBe(false);
    expect(containsDepartmentInstant(from, T, from - 1n)).toBe(false);
    expect(containsDepartmentInstant(T, null, T + 365n * DAY_US)).toBe(true);
  });

  it("selects the old department before a transfer and the new one exactly at it", () => {
    expect(resolveDepartmentInterval(PERSON_1_INTERVALS, T - 1n)).toEqual({ outcome: "one", id: ASSIGN_A });
    expect(resolveDepartmentInterval(PERSON_1_INTERVALS, T)).toEqual({ outcome: "one", id: ASSIGN_B });
    // A scan made a day earlier but synced later still resolves to A.
    expect(resolveDepartmentInterval(PERSON_1_INTERVALS, T - DAY_US)).toEqual({ outcome: "one", id: ASSIGN_A });
  });

  it("reports a gap as no assignment, never the nearest one", () => {
    expect(resolveDepartmentInterval(PERSON_1_INTERVALS, us("2026-11-19T23:59:59.999Z"))).toEqual({ outcome: "none" });
    expect(resolveDepartmentInterval([], T)).toEqual({ outcome: "none" });
  });

  it("reports overlapping history as inconsistent rather than picking one", () => {
    const broken = [...PERSON_1_INTERVALS, { id: "x", fromUs: T - HOUR_US, toUs: T + HOUR_US }];
    expect(resolveDepartmentInterval(broken, T)).toEqual({ outcome: "inconsistent" });
  });

  it("knows that adjacent intervals do not overlap and nested ones do", () => {
    const [a, b] = PERSON_1_INTERVALS;
    expect(departmentIntervalsOverlap(a, b)).toBe(false);
    expect(departmentIntervalsOverlap(a, { id: "x", fromUs: T - 1n, toUs: null })).toBe(true);
    expect(departmentIntervalsOverlap(b, { id: "y", fromUs: T + DAY_US, toUs: null })).toBe(true);
  });
});

describe("event snapshot", () => {
  const assigned = {
    business_department_id: DEPT_A,
    business_department_name: "Department A",
    business_department_assignment_id: ASSIGN_A,
    business_department_name_version_id: NAME_A1,
    business_department_status: "assigned" as const,
    department_snapshot_version: 1,
  };

  it("lists the eleven columns the database owns", () => {
    expect([...DEPARTMENT_SNAPSHOT_FIELDS].sort()).toEqual([...F5_SNAPSHOT_COLUMNS].sort());
  });

  it("accepts assigned with all four references and a legacy row with nothing", () => {
    expect(departmentSnapshotProblem(assigned)).toBeNull();
    expect(departmentSnapshotProblem({})).toBeNull();
    expect(departmentSnapshotProblem({ business_department_status: null })).toBeNull();
  });

  it("rejects assigned with a missing reference", () => {
    expect(departmentSnapshotProblem({ ...assigned, business_department_name_version_id: null })).not.toBeNull();
  });

  it("rejects any other status that still carries a department", () => {
    for (const status of ["unassigned", "disabled", "invalid_time", "resolver_unavailable", "resolution_error"] as const) {
      expect(departmentSnapshotProblem({ business_department_status: status })).toBeNull();
      expect(departmentSnapshotProblem({ ...assigned, business_department_status: status })).not.toBeNull();
    }
  });

  it("rejects a legacy row that carries any snapshot field", () => {
    expect(departmentSnapshotProblem({ department_received_at: "2026-11-22T10:00:00Z" })).not.toBeNull();
  });
});

describe("production event schema stays in step with the SQL", () => {
  it("accepts all seven event types exactly as the app sends them, without F5 fields", () => {
    const seen = new Set<string>();
    for (const [site, payload] of Object.entries(EVENT_INSERT_PAYLOADS)) {
      for (const column of F5_SNAPSHOT_COLUMNS) expect(payload, site).not.toHaveProperty(column);
      // The database supplies created_at for clock events and the order
      // number is absent for them.
      const stored = { order_number: null, created_at: "2026-11-22T09:00:00.000Z", ...payload };
      const parsed = ProductionEventSchema.safeParse(stored);
      expect(parsed.success, `${site}: ${JSON.stringify(parsed.success ? "" : parsed.error.issues)}`).toBe(true);
      seen.add(String(payload.event_type));
    }
    expect([...seen].sort()).toEqual(["cancelled", "clock_in", "clock_out", "completed", "dispatched", "line_verified", "started"]);
  });

  it("still accepts an old local row with only the original fields", () => {
    const old = { id: "e1", staff_id: PERSON_1, department: "framed", order_number: "#10186629", event_type: "completed", created_at: "2026-05-01T00:00:00.000Z" };
    const parsed = ProductionEventSchema.parse(old);
    expect(parsed.business_department_status ?? null).toBeNull();
    expect(parsed.line_sku).toBeNull();
  });

  it("requires an order number except on clock events", () => {
    const row = { id: "e1", staff_id: PERSON_1, department: "framed", created_at: "2026-05-01T00:00:00.000Z" };
    expect(ProductionEventSchema.safeParse({ ...row, event_type: "completed", order_number: null }).success).toBe(false);
    expect(ProductionEventSchema.safeParse({ ...row, event_type: "clock_in", order_number: "10001" }).success).toBe(false);
    expect(ProductionEventSchema.safeParse({ ...row, event_type: "clock_in", order_number: null }).success).toBe(true);
  });

  it("parses a row the database resolved", () => {
    const parsed = ProductionEventSchema.parse({
      id: "e1", staff_id: PERSON_1, department: "dispatch", order_number: "10001", event_type: "dispatched",
      created_at: "2026-11-22T09:00:00.000Z",
      business_department_id: DEPT_A, business_department_name: "Department A",
      business_department_assignment_id: ASSIGN_A, business_department_name_version_id: NAME_A1,
      business_department_status: "assigned", department_snapshot_version: 1,
      department_occurred_at: "2026-11-22T09:00:00+00:00", department_received_at: "2026-11-22T09:00:00.4+00:00",
      department_resolution_instant: "2026-11-22T09:00:00+00:00", department_time_status: "reported",
      department_resolved_at: "2026-11-22T09:00:00.41+00:00",
    });
    // Work type and business department are separate facts.
    expect(parsed.department).toBe("dispatch");
    expect(parsed.business_department_name).toBe("Department A");
  });
});

describe("admin request checks", () => {
  const blank: DepartmentAdminArgs = {
    operation: "create", departmentId: null, personId: null, name: null,
    expectedVersion: null, expectedAssignmentId: null, reason: "",
  };

  it("normalizes the name on create and refuses unrelated arguments", () => {
    expect(checkDepartmentAdminArgs({ ...blank, name: "  Department   A " })).toMatchObject({ ok: true, value: { name: "Department A" } });
    expect(checkDepartmentAdminArgs({ ...blank, name: "A", departmentId: DEPT_A }).ok).toBe(false);
    expect(checkDepartmentAdminArgs({ ...blank, name: "A", expectedVersion: "1" }).ok).toBe(false);
    expect(checkDepartmentAdminArgs({ ...blank, name: "" }).ok).toBe(false);
  });

  it("needs a department and its version to rename, archive or restore", () => {
    const rename = { ...blank, operation: "rename" as const, departmentId: DEPT_A, expectedVersion: "3", name: "Department A2" };
    expect(checkDepartmentAdminArgs(rename).ok).toBe(true);
    expect(checkDepartmentAdminArgs({ ...rename, expectedVersion: null }).ok).toBe(false);
    expect(checkDepartmentAdminArgs({ ...rename, expectedVersion: "0" }).ok).toBe(false);
    expect(checkDepartmentAdminArgs({ ...rename, expectedVersion: "-1" }).ok).toBe(false);
    expect(checkDepartmentAdminArgs({ ...rename, departmentId: "not-a-uuid" }).ok).toBe(false);
    const archive = { ...blank, operation: "archive" as const, departmentId: DEPT_A, expectedVersion: "3" };
    expect(checkDepartmentAdminArgs(archive).ok).toBe(true);
    expect(checkDepartmentAdminArgs({ ...archive, name: "x" }).ok).toBe(false);
    expect(checkDepartmentAdminArgs({ ...archive, personId: PERSON_1 }).ok).toBe(false);
  });

  it("needs a person to assign, and a reason only to correct", () => {
    const assign = { ...blank, operation: "assign" as const, departmentId: DEPT_A, expectedVersion: "1", personId: PERSON_1 };
    expect(checkDepartmentAdminArgs(assign).ok).toBe(true);
    expect(checkDepartmentAdminArgs({ ...assign, expectedAssignmentId: ASSIGN_A }).ok).toBe(true);
    expect(checkDepartmentAdminArgs({ ...assign, personId: null }).ok).toBe(false);
    expect(checkDepartmentAdminArgs({ ...assign, expectedAssignmentId: "nope" }).ok).toBe(false);
    expect(checkDepartmentAdminArgs({ ...assign, operation: "correct" }).ok).toBe(false);
    expect(checkDepartmentAdminArgs({ ...assign, operation: "correct", reason: " Wrong team picked " })).toMatchObject({ ok: true, value: { reason: "Wrong team picked" } });
  });

  it("refuses an unknown operation", () => {
    expect(checkDepartmentAdminArgs({ ...blank, operation: "delete" as never }).ok).toBe(false);
  });

  it("keeps versions as decimal strings in results", () => {
    const result = {
      request_id: REQUEST_1, outcome: "applied", effective_at: "2026-11-22T10:00:00.123456+00:00",
      department_id: DEPT_A, department_version: "9007199254740993", assignment_id: null, control_version: null,
    };
    expect(DepartmentMutationResultSchema.parse(result).department_version).toBe("9007199254740993");
    expect(DepartmentMutationResultSchema.safeParse({ ...result, department_version: 3 }).success).toBe(false);
    expect(DepartmentMutationResultSchema.safeParse({ ...result, outcome: "maybe" }).success).toBe(false);
  });
});

describe("showing times in the site's zone", () => {
  it("uses each site's confirmed zone and names it", () => {
    const iso = "2026-11-22T10:00:00.000Z";
    expect(formatDepartmentInstant(iso, "au")).toBe("22 Nov 2026, 21:00 (Australia/Sydney)");
    expect(formatDepartmentInstant(iso, "uk")).toBe("22 Nov 2026, 10:00 (Europe/London)");
    expect(formatDepartmentInstant(iso, "us")).toBe("22 Nov 2026, 04:00 (America/Chicago)");
  });

  it("follows daylight saving in each zone", () => {
    const july = "2026-07-01T10:00:00.000Z";
    expect(formatDepartmentInstant(july, "au")).toBe("01 Jul 2026, 20:00 (Australia/Sydney)");
    expect(formatDepartmentInstant(july, "uk")).toBe("01 Jul 2026, 11:00 (Europe/London)");
    expect(formatDepartmentInstant(july, "us")).toBe("01 Jul 2026, 05:00 (America/Chicago)");
  });

  it("falls back to UTC for other sites and to nothing for a bad value", () => {
    expect(formatDepartmentInstant("2026-11-22T10:00:00.000Z", "default")).toBe("22 Nov 2026, 10:00 (UTC)");
    expect(formatDepartmentInstant("not a date", "au")).toBe("");
    expect(formatDepartmentInstant(null, "au")).toBe("");
  });
});
