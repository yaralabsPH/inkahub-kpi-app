/**
 * Add-member logic shared by the `add-member` Edge Function and its tests.
 * Pure TypeScript with no imports, so it runs in Deno (Edge Functions) and
 * under vitest (Node) unchanged.
 *
 * Flow: verify the caller's token -> caller must be an owner -> validate
 * input -> create a confirmed email+password login -> insert profile ->
 * insert location grants. If a step after the login fails, login deletion
 * is attempted (profiles / user_locations cascade from auth.users).
 * Failed cleanup is reported explicitly for manual recovery.
 * The password is never logged or returned.
 */

export const TEAM_ROLES = ["owner", "manager", "staff", "kiosk", "cs"] as const;
export const TEAM_LOCATIONS = ["default", "uk", "us", "au"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export type TeamLocation = (typeof TEAM_LOCATIONS)[number];
export type AddMemberStage = "verify_token" | "get_role" | "create_login" | "insert_profile" | "insert_locations" | "rollback";

export interface AddMemberInput {
  email: string;
  password: string;
  display_name: string;
  role: TeamRole;
  locations: TeamLocation[];
}

export interface AddMemberDeps {
  /** Verify an access token; returns the caller's user id or null. */
  verifyToken(token: string): Promise<string | null>;
  /** The caller's app role from `profiles`, or null if they have no profile. */
  getRole(userId: string): Promise<string | null>;
  /** Create a confirmed email + password login. */
  createLogin(email: string, password: string): Promise<
    | { ok: true; userId: string }
    | { ok: false; alreadyExists: boolean; message: string }
  >;
  insertProfile(row: { user_id: string; display_name: string; role: string }): Promise<string | null>;
  insertLocations(rows: Array<{ user_id: string; location: string }>): Promise<string | null>;
  /** Remove the login again (cascades to profile + locations). Throw on failure. */
  deleteLogin(userId: string): Promise<void>;
  /** Log only a fixed stage and optional new user id, never input or error objects. */
  reportFailure?(stage: AddMemberStage, userId?: string): void;
}

export interface AddMemberResult {
  status: number;
  body: { user_id: string; email: string } | { error: string };
}

export function validateAddMember(raw: unknown): { ok: true; value: AddMemberInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Invalid details." };
  const r = raw as Record<string, unknown>;

  const email = typeof r.email === "string" ? r.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Enter a valid email address." };

  const password = typeof r.password === "string" ? r.password : "";
  if (password.length < 8) return { ok: false, error: "Password must be at least 8 characters." };
  if (new TextEncoder().encode(password).length > 72) return { ok: false, error: "Password must be 72 UTF-8 bytes or fewer." };

  const display_name = typeof r.display_name === "string" ? r.display_name.trim() : "";
  if (!display_name) return { ok: false, error: "Enter a display name." };
  if (display_name.length > 80) return { ok: false, error: "Display name is too long." };

  if (typeof r.role !== "string" || !(TEAM_ROLES as readonly string[]).includes(r.role)) {
    return { ok: false, error: "Pick a valid role." };
  }
  const role = r.role as TeamRole;

  if (!Array.isArray(r.locations) || r.locations.length === 0) {
    return { ok: false, error: "Tick at least one location." };
  }
  for (const l of r.locations) {
    if (typeof l !== "string" || !(TEAM_LOCATIONS as readonly string[]).includes(l)) {
      return { ok: false, error: "Pick valid locations." };
    }
  }
  const locations = Array.from(new Set(r.locations as TeamLocation[]));

  return { ok: true, value: { email, password, display_name, role, locations } };
}

export function bearerFrom(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

export async function runAddMember(
  deps: AddMemberDeps,
  authHeader: string | null | undefined,
  rawBody: unknown,
): Promise<AddMemberResult> {
  const token = bearerFrom(authHeader);
  if (!token) return { status: 401, body: { error: "Sign in again and retry." } };
  let userId: string | undefined;
  let stage: AddMemberStage = "verify_token";
  try {
    const callerId = await deps.verifyToken(token);
    if (!callerId) return { status: 401, body: { error: "Your session has expired. Sign in again and retry." } };
    stage = "get_role";
    if ((await deps.getRole(callerId)) !== "owner") {
      return { status: 403, body: { error: "Only owners can add team members." } };
    }

    const parsed = validateAddMember(rawBody);
    if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
    const input = parsed.value;

    stage = "create_login";
    const login = await deps.createLogin(input.email, input.password);
    if (!login.ok) {
      if (login.alreadyExists) return { status: 409, body: { error: "This email already has a login. Ask CJ to check the existing member before retrying." } };
      throw new Error("Login creation failed");
    }

    const newUserId = login.userId;
    userId = newUserId;
    stage = "insert_profile";
    const profileErr = await deps.insertProfile({ user_id: newUserId, display_name: input.display_name, role: input.role });
    if (profileErr) throw new Error("Profile creation failed");
    stage = "insert_locations";
    const locErr = await deps.insertLocations(input.locations.map((location) => ({ user_id: newUserId, location })));
    if (locErr) throw new Error("Location creation failed");

    return { status: 201, body: { user_id: newUserId, email: input.email } };
  } catch {
    deps.reportFailure?.(stage, userId);
    if (!userId) {
      return { status: 502, body: { error: "Couldn't complete the request. Ask CJ to check whether the login was created and check the password policy before retrying." } };
    }
    try {
      await deps.deleteLogin(userId);
    } catch {
      deps.reportFailure?.("rollback", userId);
      return { status: 500, body: { error: "Member setup failed and login cleanup could not be confirmed. Ask CJ to check the account before retrying." } };
    }
    return { status: 500, body: { error: "Member setup failed. The new login was removed; retry when the service is available." } };
  }
}
