/**
 * Add-member logic shared by the `add-member` Edge Function and its tests.
 * Pure TypeScript with no imports, so it runs in Deno (Edge Functions) and
 * under vitest (Node) unchanged.
 *
 * Flow: verify the caller's token -> caller must be an owner -> validate
 * input -> create a confirmed email+password login -> insert profile ->
 * insert location grants. If a step after the login fails, the login is
 * deleted again (profiles / user_locations cascade from auth.users).
 * The password is never logged or returned.
 */

export const TEAM_ROLES = ["owner", "manager", "staff", "kiosk", "cs"] as const;
export const TEAM_LOCATIONS = ["default", "uk", "us", "au"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export type TeamLocation = (typeof TEAM_LOCATIONS)[number];

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
  /** Remove the login again (cascades to profile + locations). */
  deleteLogin(userId: string): Promise<void>;
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
  if (password.length > 72) return { ok: false, error: "Password must be 72 characters or fewer." };

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
  const callerId = await deps.verifyToken(token);
  if (!callerId) return { status: 401, body: { error: "Your session has expired. Sign in again and retry." } };
  if ((await deps.getRole(callerId)) !== "owner") {
    return { status: 403, body: { error: "Only owners can add team members." } };
  }

  const parsed = validateAddMember(rawBody);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  const input = parsed.value;

  const login = await deps.createLogin(input.email, input.password);
  if (!login.ok) {
    return login.alreadyExists
      ? { status: 409, body: { error: `${input.email} already has a login.` } }
      : { status: 502, body: { error: `Couldn't create the login: ${login.message}` } };
  }

  const userId = login.userId;
  const profileErr = await deps.insertProfile({ user_id: userId, display_name: input.display_name, role: input.role });
  if (profileErr) {
    await deps.deleteLogin(userId);
    return { status: 500, body: { error: `Couldn't save the profile: ${profileErr}` } };
  }
  const locErr = await deps.insertLocations(input.locations.map((location) => ({ user_id: userId, location })));
  if (locErr) {
    await deps.deleteLogin(userId);
    return { status: 500, body: { error: `Couldn't save locations: ${locErr}` } };
  }

  return { status: 201, body: { user_id: userId, email: input.email } };
}
