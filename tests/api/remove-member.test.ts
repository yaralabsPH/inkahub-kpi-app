import { describe, expect, it, vi } from "vitest";
import { runRemoveMember, type RemoveMemberDeps } from "../../supabase/functions/_shared/remove-member-core";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const OWNER = "Bearer owner-token";

function deps(over: Partial<RemoveMemberDeps> = {}) {
  const calls: string[] = [];
  const d: RemoveMemberDeps = {
    verifyToken: vi.fn(async (t: string) => (t === "owner-token" ? OWNER_ID : t === "staff-token" ? "staff-id" : null)),
    getRole: vi.fn(async (id: string) => (id === OWNER_ID ? "owner" : "staff")),
    blockLogin: vi.fn(async () => { calls.push("block"); }),
    revokeBarcodes: vi.fn(async () => { calls.push("barcodes"); return 2; }),
    deleteLocations: vi.fn(async () => { calls.push("locations"); }),
    deleteProfile: vi.fn(async () => { calls.push("profile"); }),
    now: () => "2026-11-17T00:00:00.000Z",
    reportFailure: vi.fn(),
    ...over,
  };
  return { d, calls };
}

describe("remove-member edge function core", () => {
  it("blocks the login first, then revokes barcodes, locations and profile", async () => {
    const { d, calls } = deps();
    const r = await runRemoveMember(d, OWNER, { user_id: TARGET });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ user_id: TARGET, barcodes_revoked: 2 });
    expect(calls).toEqual(["block", "barcodes", "locations", "profile"]);
    expect(d.revokeBarcodes).toHaveBeenCalledWith(TARGET, "2026-11-17T00:00:00.000Z");
  });

  it("rejects missing/invalid tokens and non-owners before touching anything", async () => {
    for (const header of [null, "Bearer bogus", "Bearer staff-token"]) {
      const { d, calls } = deps();
      const r = await runRemoveMember(d, header, { user_id: TARGET });
      expect([401, 403]).toContain(r.status);
      expect(calls).toEqual([]);
    }
  });

  it("refuses to remove yourself", async () => {
    const { d, calls } = deps();
    const r = await runRemoveMember(d, OWNER, { user_id: OWNER_ID.toUpperCase() });
    expect(r.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it.each([[null], [{}], [{ user_id: "not-a-uuid" }], [{ user_id: 42 }]])("validates the target (%#)", async (body) => {
    const { d, calls } = deps();
    const r = await runRemoveMember(d, OWNER, body);
    expect(r.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("stops at the first failure, says what happened, and says retry is safe", async () => {
    const { d, calls } = deps({ deleteLocations: vi.fn(async () => { throw new Error("rls detail secret"); }) });
    const r = await runRemoveMember(d, OWNER, { user_id: TARGET });
    expect(r.status).toBe(500);
    const msg = (r.body as { error: string }).error;
    expect(msg).toContain("location access");
    expect(msg).toContain("login is already blocked");
    expect(msg).toContain("safe to try again");
    expect(msg).not.toContain("secret");
    expect(calls).toEqual(["block", "barcodes"]);
    expect(d.deleteProfile).not.toHaveBeenCalled();
    expect(d.reportFailure).toHaveBeenCalledWith("delete_locations", TARGET);
  });

  it("reports nothing changed when blocking the login fails", async () => {
    const { d, calls } = deps({ blockLogin: vi.fn(async () => { throw new Error("auth down"); }) });
    const r = await runRemoveMember(d, OWNER, { user_id: TARGET });
    expect(r.status).toBe(500);
    expect((r.body as { error: string }).error).toContain("Nothing was changed");
    expect(calls).toEqual([]);
  });

  it("is safe to run twice (each step is idempotent from the core's view)", async () => {
    const { d } = deps({ revokeBarcodes: vi.fn(async () => 0) });
    const first = await runRemoveMember(d, OWNER, { user_id: TARGET });
    const second = await runRemoveMember(d, OWNER, { user_id: TARGET });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ user_id: TARGET, barcodes_revoked: 0 });
  });
});
