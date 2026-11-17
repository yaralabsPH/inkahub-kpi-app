import { describe, expect, it, vi } from "vitest";
import { runAddMember, type AddMemberDeps } from "../../supabase/functions/_shared/add-member-core";

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
const OWNER = "Bearer owner-token";

describe("add-member edge function core", () => {
  it("creates login, profile and de-duplicated locations for an owner", async () => {
    const d = deps();
    const r = await runAddMember(d, OWNER, goodBody);
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ user_id: "new-id", email: "jane@example.com" });
    expect(d.createLogin).toHaveBeenCalledWith("jane@example.com", "s3cret-pass");
    expect(d.insertProfile).toHaveBeenCalledWith({ user_id: "new-id", display_name: "Jane Smith", role: "staff" });
    expect(d.insertLocations).toHaveBeenCalledWith([
      { user_id: "new-id", location: "au" },
      { user_id: "new-id", location: "uk" },
    ]);
    expect(d.deleteLogin).not.toHaveBeenCalled();
  });

  it("never echoes the password back", async () => {
    const r = await runAddMember(deps(), OWNER, goodBody);
    expect(JSON.stringify(r.body)).not.toContain("s3cret-pass");
  });

  it("rejects a missing or invalid token", async () => {
    for (const header of [null, "Bearer bogus", "Basic abc"]) {
      const d = deps();
      const r = await runAddMember(d, header, goodBody);
      expect(r.status).toBe(401);
      expect(d.createLogin).not.toHaveBeenCalled();
    }
  });

  it("rejects callers who are not owners", async () => {
    const d = deps();
    const r = await runAddMember(d, "Bearer staff-token", goodBody);
    expect(r.status).toBe(403);
    expect(d.createLogin).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...goodBody, email: "nope" }, "valid email"],
    [{ ...goodBody, password: "short" }, "at least 8"],
    [{ ...goodBody, password: "x".repeat(73) }, "72"],
    [{ ...goodBody, display_name: "  " }, "display name"],
    [{ ...goodBody, role: "admin" }, "role"],
    [{ ...goodBody, locations: [] }, "at least one location"],
    [{ ...goodBody, locations: ["mars"] }, "locations"],
    [null, "invalid"],
  ])("validates input (%#)", async (body, msg) => {
    const d = deps();
    const r = await runAddMember(d, OWNER, body);
    expect(r.status).toBe(400);
    expect(String((r.body as { error: string }).error).toLowerCase()).toContain(msg.toLowerCase());
    expect(d.createLogin).not.toHaveBeenCalled();
  });

  it("returns 409 when the email already has a login", async () => {
    const d = deps({ createLogin: vi.fn(async () => ({ ok: false as const, alreadyExists: true, message: "exists" })) });
    const r = await runAddMember(d, OWNER, goodBody);
    expect(r.status).toBe(409);
    expect(d.insertProfile).not.toHaveBeenCalled();
  });

  it("returns 502 with Supabase's message for other login errors", async () => {
    const d = deps({ createLogin: vi.fn(async () => ({ ok: false as const, alreadyExists: false, message: "Password is too weak" })) });
    const r = await runAddMember(d, OWNER, goodBody);
    expect(r.status).toBe(502);
    expect((r.body as { error: string }).error).toContain("Password is too weak");
  });

  it("deletes the new login if the profile insert fails", async () => {
    const d = deps({ insertProfile: vi.fn(async () => "boom") });
    const r = await runAddMember(d, OWNER, goodBody);
    expect(r.status).toBe(500);
    expect(d.deleteLogin).toHaveBeenCalledWith("new-id");
    expect(d.insertLocations).not.toHaveBeenCalled();
  });

  it("deletes the new login if the location insert fails", async () => {
    const d = deps({ insertLocations: vi.fn(async () => "boom") });
    const r = await runAddMember(d, OWNER, goodBody);
    expect(r.status).toBe(500);
    expect(d.deleteLogin).toHaveBeenCalledWith("new-id");
  });
});
