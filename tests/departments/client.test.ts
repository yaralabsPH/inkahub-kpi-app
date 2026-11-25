import { describe, expect, it } from "vitest";
import {
  classifyDepartmentError,
  departmentAdmin,
  fetchAllDepartmentRows,
  fetchDepartmentControl,
  fetchDepartmentPage,
  sendDepartmentChange,
  setDepartmentSnapshotEnabled,
  type DepartmentsClient,
} from "@/lib/departments/client";
import type { DepartmentAdminArgs } from "@/lib/domain/departments";
import { ASSIGN_A, DEPT_A, DEPT_B, PERSON_1, PERSON_2, REQUEST_1 } from "../fixtures/departments";

/** A fake client that records calls and answers from a queue. Proves nothing about RLS. */
function fake(answers: Array<{ data?: unknown; error?: { code?: string; message?: string } | null } | Error>) {
  const calls: Array<{ fn: string; args: unknown }> = [];
  const next = () => {
    const answer = answers.shift();
    if (!answer) throw new Error("unexpected call");
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null });
  };
  const client = {
    rpc: (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return next();
    },
    from: (table: string) => ({
      select: (columns: string) => ({
        maybeSingle: () => {
          calls.push({ fn: `from:${table}`, args: columns });
          return next();
        },
      }),
    }),
  } as unknown as DepartmentsClient;
  return { client, calls };
}

const applied = {
  request_id: REQUEST_1, outcome: "applied", effective_at: "2026-11-22T10:00:00.123456+00:00",
  department_id: DEPT_A, department_version: "2", assignment_id: null, control_version: null,
};
const blank: DepartmentAdminArgs = {
  operation: "create", departmentId: null, personId: null, name: null,
  expectedVersion: null, expectedAssignmentId: null, reason: "",
};
const department = (id: string, name: string) => ({
  id, name, version: "1", archived_at: null, created_at: "2026-11-22T00:00:00+00:00",
  updated_at: "2026-11-22T00:00:00+00:00", member_count: 0,
});

describe("departmentAdmin", () => {
  it("sends exactly the eight named arguments, with explicit nulls and the normalized name", async () => {
    const { client, calls } = fake([{ data: applied }]);
    const result = await departmentAdmin(client, REQUEST_1, { ...blank, name: "  Department   A " });
    expect(result).toEqual({ outcome: "ok", value: applied });
    expect(calls).toEqual([{
      fn: "department_admin",
      args: {
        p_operation: "create", p_request_id: REQUEST_1, p_department_id: null, p_person_id: null,
        p_name: "Department A", p_expected_version: null, p_expected_assignment_id: null, p_reason: "",
      },
    }]);
  });

  it("sends the version as a decimal string and keeps it a string in the result", async () => {
    const big = { ...applied, department_version: "9007199254740993" };
    const { client, calls } = fake([{ data: big }]);
    const result = await departmentAdmin(client, REQUEST_1, {
      ...blank, operation: "assign", departmentId: DEPT_B, personId: PERSON_1,
      expectedVersion: "9007199254740992", expectedAssignmentId: ASSIGN_A,
    });
    expect((calls[0].args as Record<string, unknown>).p_expected_version).toBe("9007199254740992");
    expect(result.outcome === "ok" && result.value.department_version).toBe("9007199254740993");
  });

  it("refuses bad input in the browser without calling the server", async () => {
    const { client, calls } = fake([]);
    const result = await departmentAdmin(client, REQUEST_1, { ...blank, operation: "correct", departmentId: DEPT_B, personId: PERSON_1, expectedVersion: "1", reason: "  " });
    expect(result).toMatchObject({ outcome: "error", kind: "invalid" });
    expect(calls).toEqual([]);
  });

  it("treats an unreadable answer as unknown, never as success", async () => {
    const { client } = fake([{ data: { outcome: "applied" } }]);
    expect(await departmentAdmin(client, REQUEST_1, { ...blank, name: "A" })).toMatchObject({ outcome: "error", kind: "unknown" });
  });

  it("treats a dropped connection as unknown", async () => {
    const { client } = fake([new TypeError("Failed to fetch")]);
    expect(await departmentAdmin(client, REQUEST_1, { ...blank, name: "A" })).toMatchObject({ outcome: "error", kind: "unknown" });
  });
});

describe("error mapping", () => {
  it("maps each agreed SQLSTATE to what the owner should do", () => {
    expect(classifyDepartmentError({ code: "42501", message: "owner_only" }).kind).toBe("forbidden");
    expect(classifyDepartmentError({ code: "22023", message: "reason_required" })).toEqual({ kind: "invalid", message: "Enter a reason." });
    expect(classifyDepartmentError({ code: "40001", message: "assignment_changed" }).kind).toBe("conflict");
    expect(classifyDepartmentError({ code: "55P03", message: "canceling statement due to lock timeout" }).kind).toBe("busy");
    expect(classifyDepartmentError({ code: "23505", message: "department_name_taken" }).kind).toBe("name_taken");
    expect(classifyDepartmentError({ code: "P0001", message: "department_has_members" }).kind).toBe("has_members");
  });

  it("treats anything else as unknown, including another P0001 and a missing code", () => {
    expect(classifyDepartmentError({ code: "P0001", message: "something else" }).kind).toBe("unknown");
    expect(classifyDepartmentError({ code: "57014", message: "canceling statement due to statement timeout" }).kind).toBe("unknown");
    expect(classifyDepartmentError({ message: "Failed to fetch" }).kind).toBe("unknown");
    expect(classifyDepartmentError(null).kind).toBe("unknown");
  });

  it("never shows a raw database message for an unknown failure", () => {
    const { message } = classifyDepartmentError({ code: "XX000", message: "relation \"secret\" does not exist" });
    expect(message).not.toContain("secret");
  });
});

describe("the switch", () => {
  it("requires a reason before calling, then sends four arguments", async () => {
    const none = fake([]);
    expect(await setDepartmentSnapshotEnabled(none.client, REQUEST_1, true, "1", " ")).toMatchObject({ outcome: "error", kind: "invalid" });
    expect(none.calls).toEqual([]);

    const result = { ...applied, department_id: null, department_version: null, control_version: "2" };
    const { client, calls } = fake([{ data: result }]);
    await setDepartmentSnapshotEnabled(client, REQUEST_1, true, "1", " Roster checked ");
    expect(calls).toEqual([{
      fn: "department_set_snapshot_enabled",
      args: { p_request_id: REQUEST_1, p_enabled: true, p_expected_version: "1", p_reason: "Roster checked" },
    }]);
  });

  it("reads the control row directly and keeps its version a string", async () => {
    const { client, calls } = fake([{ data: { enabled: false, tracking_started_at: "2026-11-22T00:00:00+00:00", version: 3, updated_at: "2026-11-22T00:00:00+00:00" } }]);
    const result = await fetchDepartmentControl(client);
    expect(calls[0].fn).toBe("from:department_snapshot_control");
    expect(result).toMatchObject({ outcome: "ok", value: { enabled: false, version: "3" } });
  });

  it("reports a missing control row as an error, not as off", async () => {
    const { client } = fake([{ data: null }]);
    expect(await fetchDepartmentControl(client)).toMatchObject({ outcome: "error" });
  });

  it("routes a change to the right function", async () => {
    const a = fake([{ data: applied }]);
    await sendDepartmentChange(a.client, { kind: "admin", args: { ...blank, name: "A" } }, REQUEST_1);
    expect(a.calls[0].fn).toBe("department_admin");
    const b = fake([{ data: { ...applied, control_version: "2" } }]);
    await sendDepartmentChange(b.client, { kind: "switch", enabled: false, expectedVersion: "1", reason: "stop" }, REQUEST_1);
    expect(b.calls[0].fn).toBe("department_set_snapshot_enabled");
  });
});

describe("pages", () => {
  it("asks for one page with the cursor it was given", async () => {
    const { client, calls } = fake([{ data: { rows: [department(DEPT_A, "Department A")], next_cursor: { id: DEPT_A } } }]);
    const page = await fetchDepartmentPage(client, "departments_active", null, null, 1);
    expect(calls).toEqual([{ fn: "department_owner_page", args: { p_kind: "departments_active", p_subject_id: null, p_cursor: null, p_limit: 1 } }]);
    expect(page).toMatchObject({ outcome: "ok", value: { nextCursor: { id: DEPT_A } } });
  });

  it("refuses a page size outside 1 to 100 without calling", async () => {
    const { client, calls } = fake([]);
    for (const limit of [0, 101, 1.5]) {
      expect(await fetchDepartmentPage(client, "people", null, null, limit)).toMatchObject({ outcome: "error", kind: "invalid" });
    }
    expect(calls).toEqual([]);
  });

  it("reads every page and stops only on a null cursor", async () => {
    const { client, calls } = fake([
      { data: { rows: [department(DEPT_A, "Department A")], next_cursor: { id: DEPT_A } } },
      { data: { rows: [department(DEPT_B, "Department B")], next_cursor: null } },
    ]);
    const all = await fetchAllDepartmentRows(client, "departments_active", null, 1);
    expect(all.outcome === "ok" && all.value.map((d) => d.name)).toEqual(["Department A", "Department B"]);
    expect(calls.map((c) => (c.args as Record<string, unknown>).p_cursor)).toEqual([null, { id: DEPT_A }]);
  });

  it("reports an error on a later page instead of returning a short list", async () => {
    const { client } = fake([
      { data: { rows: [department(DEPT_A, "Department A")], next_cursor: { id: DEPT_A } } },
      { error: { code: "57014", message: "timeout" } },
    ]);
    expect(await fetchAllDepartmentRows(client, "departments_active", null, 1)).toMatchObject({ outcome: "error", kind: "unknown" });
  });

  it("reports a cursor that does not move instead of looping or truncating", async () => {
    const stuck = { data: { rows: [department(DEPT_A, "Department A")], next_cursor: { id: DEPT_A } } };
    const { client } = fake([stuck, stuck, stuck]);
    expect(await fetchAllDepartmentRows(client, "departments_active", null, 1)).toMatchObject({ outcome: "error" });
  });

  it("parses people with and without a home, and a removed person in members", async () => {
    const { client } = fake([{ data: { rows: [
      { person_id: PERSON_1, display_name: "Person 1", assignment_id: ASSIGN_A, department_id: DEPT_A, department_name: "Department A", valid_from: "2026-11-22T00:00:00+00:00" },
      { person_id: PERSON_2, display_name: "Person 2", assignment_id: null, department_id: null, department_name: null, valid_from: null },
    ], next_cursor: null } }]);
    const people = await fetchDepartmentPage(client, "people", null, null);
    expect(people.outcome === "ok" && people.value.rows[1].department_id).toBeNull();

    const removed = fake([{ data: { rows: [
      { person_id: PERSON_1, display_name: null, assignment_id: ASSIGN_A, department_id: DEPT_A, department_name: "Department A", valid_from: "2026-11-22T00:00:00+00:00" },
    ], next_cursor: null } }]);
    const members = await fetchDepartmentPage(removed.client, "members", DEPT_A, null);
    expect(members.outcome === "ok" && members.value.rows[0].display_name).toBeNull();
  });

  it("passes a forbidden answer through", async () => {
    const { client } = fake([{ error: { code: "42501", message: "owner_only" } }]);
    expect(await fetchDepartmentPage(client, "audit", null, null)).toMatchObject({ outcome: "error", kind: "forbidden" });
  });
});
