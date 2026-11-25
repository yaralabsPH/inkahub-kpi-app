import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  handler: null as null | ((request: Request) => Promise<Response>),
  createClient: vi.fn(),
}));
vi.mock("npm:@supabase/supabase-js@2.105.4", () => ({ createClient: fixture.createClient }));

describe("add-member HTTP adapter", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  let admin: { auth: { admin: { createUser: ReturnType<typeof vi.fn>; deleteUser: ReturnType<typeof vi.fn> } } };
  let caller: { auth: { getUser: ReturnType<typeof vi.fn> }; from: ReturnType<typeof vi.fn> };
  let profileInsert: ReturnType<typeof vi.fn>;
  let locationInsert: ReturnType<typeof vi.fn>;
  let logs: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    logs = vi.spyOn(console, "error").mockImplementation(() => {});
    profileInsert = vi.fn(async () => ({ error: null }));
    locationInsert = vi.fn(async () => ({ error: null }));
    admin = { auth: { admin: {
      createUser: vi.fn(async () => ({ data: { user: { id: "new-user" } }, error: null })),
      deleteUser: vi.fn(async () => ({ data: { user: null }, error: null })),
    } } };
    caller = {
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: "owner" } }, error: null })) },
      from: vi.fn((table: string) => {
        if (table === "profiles") return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "owner" }, error: null }) }) }),
          insert: profileInsert,
        };
        if (table === "user_locations") return { insert: locationInsert };
        throw new Error(`Unexpected table: ${table}`);
      }),
    };
    fixture.createClient.mockReset().mockImplementation((_url, key) => key === "test-service-key" ? admin : caller);
    vi.stubGlobal("Deno", {
      env: { get: (key: string) => ({ SUPABASE_URL: "https://example.invalid", SUPABASE_SERVICE_ROLE_KEY: "test-service-key", SUPABASE_ANON_KEY: "test-anon-key" })[key] },
      serve: (handler: typeof fixture.handler) => { fixture.handler = handler; },
    });
    await import("../../supabase/functions/add-member/index");
  });

  function request(method = "POST") {
    return new Request("https://example.invalid/add-member", {
      method,
      headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ email: "jane@example.com", password: "test-password", display_name: "Jane", role: "staff", locations: ["au"] }) } : {}),
    });
  }

  it("uses service privileges only for create/delete and caller credentials for tables/token verification", async () => {
    const response = await fixture.handler!(request());
    expect(response.status).toBe(201);
    expect(caller.auth.getUser).toHaveBeenCalledWith("owner-token");
    expect(fixture.createClient).toHaveBeenCalledWith("https://example.invalid", "test-anon-key", expect.objectContaining({
      global: { headers: { Authorization: "Bearer owner-token" } },
    }));
    expect(profileInsert).toHaveBeenCalledWith({ user_id: "new-user", display_name: "Jane", role: "staff" });
    expect(locationInsert).toHaveBeenCalledWith([{ user_id: "new-user", location: "au" }]);
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).not.toContain("test-password");
  });

  it("reports returned Auth delete errors rather than pretending rollback succeeded", async () => {
    locationInsert.mockResolvedValue({ error: { message: "internal detail test-password" } });
    admin.auth.admin.deleteUser.mockResolvedValue({ data: { user: null }, error: { message: "internal detail test-password" } });
    const response = await fixture.handler!(request());
    expect(response.status).toBe(500);
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith("new-user");
    const body = await response.json();
    expect(body.error).toMatch(/cleanup.*could not be confirmed/i);
    expect(logs).toHaveBeenCalledWith("add-member failed", { stage: "rollback", userId: "new-user" });
    expect(JSON.stringify([body, logs.mock.calls])).not.toMatch(/test-password|internal detail|owner-token|test-service-key/);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it.each([["OPTIONS", 200], ["GET", 405]] as const)("handles %s without constructing privileged clients", async (method, status) => {
    expect((await fixture.handler!(request(method))).status).toBe(status);
    expect(fixture.createClient).not.toHaveBeenCalled();
  });
});
