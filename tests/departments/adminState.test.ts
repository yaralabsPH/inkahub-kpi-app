import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  departmentAdminReducer,
  departmentPayloadKey,
  initialDepartmentAdminState,
  isDepartmentChangeBusy,
  type DepartmentAdminState,
} from "@/lib/departments/adminState";
import { clearDepartmentsCache, departmentsKey, departmentsKeyPrefix } from "@/lib/hooks/useDepartments";
import { OWNER_1, PERSON_1, REQUEST_1, REQUEST_2 } from "../fixtures/departments";

type Input = { name: string };
const start = (): DepartmentAdminState<Input> => initialDepartmentAdminState<Input>();
const submit = (state: DepartmentAdminState<Input>, name: string, newRequestId: string) =>
  departmentAdminReducer(state, { type: "submit", input: { name }, payloadKey: departmentPayloadKey({ name }), newRequestId });

describe("one change, one request", () => {
  it("sends the first click with a new request id", () => {
    const s = submit(start(), "Department A", REQUEST_1);
    expect(s.status).toBe("submitting");
    expect(s.send).toEqual({ requestId: REQUEST_1, payloadKey: '{"name":"Department A"}', input: { name: "Department A" } });
    expect(isDepartmentChangeBusy(s)).toBe(true);
  });

  it("sends nothing for a second click while the first is in flight", () => {
    const first = submit(start(), "Department A", REQUEST_1);
    const second = submit(first, "Department A", REQUEST_2);
    expect(second.send).toBeNull();
    expect(second.pending?.requestId).toBe(REQUEST_1);
    expect(second.status).toBe("submitting");
  });

  it("is done only when the server confirmed that request", () => {
    const s = departmentAdminReducer(submit(start(), "Department A", REQUEST_1), { type: "succeeded", requestId: REQUEST_1 });
    expect(s).toMatchObject({ status: "done", pending: null, input: null, message: null });
  });
});

describe("no answer: retry the same request", () => {
  const lost = () => departmentAdminReducer(submit(start(), "Department A", REQUEST_1),
    { type: "failed", requestId: REQUEST_1, kind: "unknown", message: "No clear answer" });

  it("keeps the input and the request id, and does not claim success", () => {
    const s = lost();
    expect(s.status).toBe("unknown");
    expect(s.input).toEqual({ name: "Department A" });
    expect(s.pending?.requestId).toBe(REQUEST_1);
    expect(s.message).toBe("No clear answer");
  });

  it("re-sends the SAME id when the same change is retried", () => {
    const retry = submit(lost(), "Department A", REQUEST_2);
    expect(retry.send?.requestId).toBe(REQUEST_1);
    expect(retry.status).toBe("submitting");
  });

  it("treats 'server busy' the same way", () => {
    const busy = departmentAdminReducer(submit(start(), "Department A", REQUEST_1),
      { type: "failed", requestId: REQUEST_1, kind: "busy", message: "busy" });
    expect(submit(busy, "Department A", REQUEST_2).send?.requestId).toBe(REQUEST_1);
  });

  it("uses a NEW id when the input was changed before retrying", () => {
    const changed = submit(lost(), "Department B", REQUEST_2);
    expect(changed.send?.requestId).toBe(REQUEST_2);
    expect(changed.send?.input).toEqual({ name: "Department B" });
  });
});

describe("someone else changed it: refresh and reapply", () => {
  const conflict = () => departmentAdminReducer(submit(start(), "Department A", REQUEST_1),
    { type: "failed", requestId: REQUEST_1, kind: "conflict", message: "Refresh and try again." });

  it("drops the request id but keeps what was typed", () => {
    const s = conflict();
    expect(s).toMatchObject({ status: "conflict", pending: null, input: { name: "Department A" } });
  });

  it("needs a NEW id to apply the same change again", () => {
    expect(submit(conflict(), "Department A", REQUEST_2).send?.requestId).toBe(REQUEST_2);
  });
});

describe("refused input", () => {
  it("keeps the input for correction and uses a new id next time", () => {
    for (const kind of ["invalid", "name_taken", "has_members", "forbidden"] as const) {
      const s = departmentAdminReducer(submit(start(), "Department A", REQUEST_1),
        { type: "failed", requestId: REQUEST_1, kind, message: "no" });
      expect(s).toMatchObject({ status: "error", pending: null, input: { name: "Department A" }, message: "no" });
      expect(submit(s, "Department A", REQUEST_2).send?.requestId).toBe(REQUEST_2);
    }
  });
});

describe("late answers", () => {
  it("ignores an answer to a request that is no longer the current one", () => {
    const conflicted = departmentAdminReducer(submit(start(), "Department A", REQUEST_1),
      { type: "failed", requestId: REQUEST_1, kind: "conflict", message: "stale" });
    const second = submit(conflicted, "Department A", REQUEST_2);
    const lateSuccess = departmentAdminReducer(second, { type: "succeeded", requestId: REQUEST_1 });
    expect(lateSuccess.status).toBe("submitting");
    expect(lateSuccess.pending?.requestId).toBe(REQUEST_2);
    const lateFailure = departmentAdminReducer(second, { type: "failed", requestId: REQUEST_1, kind: "invalid", message: "x" });
    expect(lateFailure.status).toBe("submitting");
  });

  it("ignores an answer after a reset", () => {
    const reset = departmentAdminReducer(submit(start(), "Department A", REQUEST_1), { type: "reset" });
    expect(departmentAdminReducer(reset, { type: "succeeded", requestId: REQUEST_1 }).status).toBe("idle");
  });
});

describe("payload key", () => {
  it("is the same for the same change whatever the field order", () => {
    expect(departmentPayloadKey({ a: 1, b: { d: 2, c: 3 } })).toBe(departmentPayloadKey({ b: { c: 3, d: 2 }, a: 1 }));
    expect(departmentPayloadKey({ a: 1 })).not.toBe(departmentPayloadKey({ a: 2 }));
    expect(departmentPayloadKey({ a: null })).not.toBe(departmentPayloadKey({ a: "" }));
  });
});

describe("cache is kept per signed-in owner", () => {
  it("prefixes every key with the caller and the global scope", () => {
    expect(departmentsKey(OWNER_1, "people")).toEqual(["departments", OWNER_1, "global", "people", null, "all"]);
    expect(departmentsKey(OWNER_1, "history", PERSON_1, "paged")).toEqual(["departments", OWNER_1, "global", "history", PERSON_1, "paged"]);
    expect(departmentsKey(OWNER_1, "control").slice(0, 3)).toEqual(departmentsKeyPrefix(OWNER_1));
  });

  it("clears one caller's lists without touching another caller or other data", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(departmentsKey(OWNER_1, "people"), ["owner 1 people"]);
    queryClient.setQueryData(departmentsKey(OWNER_1, "control"), { enabled: false });
    queryClient.setQueryData(departmentsKey("someone-else", "people"), ["other people"]);
    queryClient.setQueryData(["dataset", "au"], { rows: 1 });

    await clearDepartmentsCache(queryClient, OWNER_1);

    expect(queryClient.getQueryData(departmentsKey(OWNER_1, "people"))).toBeUndefined();
    expect(queryClient.getQueryData(departmentsKey(OWNER_1, "control"))).toBeUndefined();
    expect(queryClient.getQueryData(departmentsKey("someone-else", "people"))).toEqual(["other people"]);
    expect(queryClient.getQueryData(["dataset", "au"])).toEqual({ rows: 1 });
  });
});
