import { describe, expect, it, vi } from "vitest";
import { createAddMemberHandler, type AddMemberDeps } from "../../api/team/add-member";

function fakeRes() {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) { out.status = code; return res; },
    json(body: unknown) { out.body = body; },
    setHeader: vi.fn(),
  };
  return { res, out };
}

function deps(over: Partial<AddMemberDeps> = {}): AddMemberDeps {
  return {
    verifyToken: vi.fn(async (t: string) => (t === "owner-token" ? "owner-id" : t === "staff-token" ? "staff-id" : null)),
    getRole: vi.fn(async (id: string) => (id === "owner-id" ? "owner" : "staff")),
    createLogin: vi.fn(async () => ({ ok: true as const, userId: "new-id" })),
    insertProfile: vi.fn(async () => null),
    insertLocations: vi.fn(async () => null),
    deleteLogin: vi.fn(async () => {}),
    ...over,
  };
}

const goodBody = {
  email: "  Jane@Example.com ",
  password: "s3cret-pass",
  display_name: " Jane Smith ",
  role: "staff",
  locations: ["au", "au", "uk"],
};

function req(body: unknown, token: string | null = "owner-token", method = "POST") {
  return {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  };
}

describe("POST /api/team/add-member", () => {
  it("creates login, profile and de-duplicated locations for an owner", async () => {
    const d = deps();
    const { res, out } = fakeRes();
    await createAddMemberHandler(d)(req(goodBody), res);
    expect(out.status).toBe(201);
    expect(out.body).toEqual({ user_id: "new-id", email: "jane@example.com" });
    expect(d.createLogin).toHaveBeenCalledWith("jane@example.com", "s3cret-pass");
    expect(d.insertProfile).toHaveBeenCalledWith({ user_id: "new-id", display_name: "Jane Smith", role: "staff" });
    expect(d.insertLocations).toHaveBeenCalledWith([
      { user_id: "new-id", location: "au" },
      { user_id: "new-id", location: "uk" },
    ]);
    expect(d.deleteLogin).not.toHaveBeenCalled();
  });

  it("never echoes the password back", async () => {
    const { res, out } = fakeRes();
    await createAddMemberHandler(deps())(req(goodBody), res);
    expect(JSON.stringify(out.body)).not.toContain("s3cret-pass");
  });

  it("rejects non-POST", async () => {
    const { res, out } = fakeRes();
    await createAddMemberHandler(deps())(req(goodBody, "owner-token", "GET"), res);
    expect(out.status).toBe(405);
  });

  it("rejects a missing or invalid token", async () => {
    for (const token of [null, "bogus"]) {
      const d = deps();
      const { res, out } = fakeRes();
      await createAddMemberHandler(d)(req(goodBody, token), res);
      expect(out.status).toBe(401);
      expect(d.createLogin).not.toHaveBeenCalled();
    }
  });

  it("rejects callers who are not owners", async () => {
    const d = deps();
    const { res, out } = fakeRes();
    await createAddMemberHandler(d)(req(goodBody, "staff-token"), res);
    expect(out.status).toBe(403);
    expect(d.createLogin).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...goodBody, email: "nope" }, "valid email"],
    [{ ...goodBody, password: "short" }, "at least 8"],
    [{ ...goodBody, display_name: "  " }, "display name"],
    [{ ...goodBody, role: "admin" }, ""],
    [{ ...goodBody, locations: [] }, "at least one location"],
    [{ ...goodBody, locations: ["mars"] }, ""],
  ])("validates input (%#)", async (body, msg) => {
    const d = deps();
    const { res, out } = fakeRes();
    await createAddMemberHandler(d)(req(body), res);
    expect(out.status).toBe(400);
    expect(String((out.body as { error: string }).error).toLowerCase()).toContain(msg.toLowerCase());
    expect(d.createLogin).not.toHaveBeenCalled();
  });

  it("accepts a JSON string body", async () => {
    const { res, out } = fakeRes();
    await createAddMemberHandler(deps())(req(JSON.stringify(goodBody)), res);
    expect(out.status).toBe(201);
  });

  it("returns 409 when the email already has a login", async () => {
    const d = deps({ createLogin: vi.fn(async () => ({ ok: false as const, alreadyExists: true, message: "exists" })) });
    const { res, out } = fakeRes();
    await createAddMemberHandler(d)(req(goodBody), res);
    expect(out.status).toBe(409);
    expect(d.insertProfile).not.toHaveBeenCalled();
  });

  it("deletes the new login if the profile insert fails", async () => {
    const d = deps({ insertProfile: vi.fn(async () => "boom") });
    const { res, out } = fakeRes();
    await createAddMemberHandler(d)(req(goodBody), res);
    expect(out.status).toBe(500);
    expect(d.deleteLogin).toHaveBeenCalledWith("new-id");
    expect(d.insertLocations).not.toHaveBeenCalled();
  });

  it("deletes the new login if the location insert fails", async () => {
    const d = deps({ insertLocations: vi.fn(async () => "boom") });
    const { res, out } = fakeRes();
    await createAddMemberHandler(d)(req(goodBody), res);
    expect(out.status).toBe(500);
    expect(d.deleteLogin).toHaveBeenCalledWith("new-id");
  });
});
