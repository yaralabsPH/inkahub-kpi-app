/**
 * POST /api/team/add-member
 *
 * Lets an owner add a team member entirely from the Team page: creates the
 * Supabase auth login (email + password, pre-confirmed), the profile row and
 * the location grants in one call. Nobody has to open the Supabase dashboard.
 *
 * Security:
 *   - Caller must send `Authorization: Bearer <their Supabase access token>`.
 *   - The token is verified with Supabase and the caller's profile role must
 *     be `owner`. Everyone else gets 401/403.
 *   - The service-role key stays server-side (process.env), never in the browser.
 *   - The password is passed straight to Supabase Auth and never logged or
 *     returned.
 *
 * If any step after creating the login fails, the login is deleted again.
 * profiles and user_locations reference auth.users ON DELETE CASCADE, so that
 * also removes any rows already written.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

interface VercelRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface VercelResponse {
  status(code: number): VercelResponse;
  json(body: unknown): void;
  setHeader?(name: string, value: string): void;
}

export const TEAM_ROLES = ["owner", "manager", "staff", "kiosk", "cs"] as const;
export const TEAM_LOCATIONS = ["default", "uk", "us", "au"] as const;

export const AddMemberInput = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters.")
    .max(72, "Password must be 72 characters or fewer."),
  display_name: z.string().trim().min(1, "Enter a display name.").max(80, "Display name is too long."),
  role: z.enum(TEAM_ROLES),
  locations: z
    .array(z.enum(TEAM_LOCATIONS))
    .min(1, "Tick at least one location.")
    .transform((locs) => Array.from(new Set(locs))),
});
export type AddMemberInput = z.infer<typeof AddMemberInput>;

/** Everything the handler needs from Supabase, so tests can fake it. */
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

function bearer(headers: VercelRequest["headers"]): string | null {
  const raw = headers.authorization ?? headers.Authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  return m ? m[1].trim() : null;
}

function parseBody(body: unknown): unknown {
  if (typeof body === "string") {
    try { return JSON.parse(body); } catch { return null; }
  }
  return body;
}

export function createAddMemberHandler(deps: AddMemberDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader?.("Cache-Control", "no-store");
    if (req.method !== "POST") {
      res.setHeader?.("Allow", "POST");
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const token = bearer(req.headers);
    if (!token) {
      res.status(401).json({ error: "Sign in again and retry." });
      return;
    }
    const callerId = await deps.verifyToken(token);
    if (!callerId) {
      res.status(401).json({ error: "Your session has expired. Sign in again and retry." });
      return;
    }
    if ((await deps.getRole(callerId)) !== "owner") {
      res.status(403).json({ error: "Only owners can add team members." });
      return;
    }

    const parsed = AddMemberInput.safeParse(parseBody(req.body));
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid details." });
      return;
    }
    const input = parsed.data;

    const login = await deps.createLogin(input.email, input.password);
    if (!login.ok) {
      if (login.alreadyExists) {
        res.status(409).json({ error: `${input.email} already has a login.` });
      } else {
        res.status(502).json({ error: `Couldn't create the login: ${login.message}` });
      }
      return;
    }

    const userId = login.userId;
    const profileErr = await deps.insertProfile({
      user_id: userId,
      display_name: input.display_name,
      role: input.role,
    });
    if (profileErr) {
      await deps.deleteLogin(userId);
      res.status(500).json({ error: `Couldn't save the profile: ${profileErr}` });
      return;
    }
    const locErr = await deps.insertLocations(
      input.locations.map((location) => ({ user_id: userId, location })),
    );
    if (locErr) {
      await deps.deleteLogin(userId);
      res.status(500).json({ error: `Couldn't save locations: ${locErr}` });
      return;
    }

    res.status(201).json({ user_id: userId, email: input.email });
  };
}

/** Real Supabase-backed deps. Uses the service-role key (server only). */
export function supabaseAddMemberDeps(admin: SupabaseClient): AddMemberDeps {
  return {
    async verifyToken(token) {
      const { data, error } = await admin.auth.getUser(token);
      return error || !data.user ? null : data.user.id;
    },
    async getRole(userId) {
      const { data, error } = await admin
        .from("profiles")
        .select("role")
        .eq("user_id", userId)
        .maybeSingle();
      return error || !data ? null : String(data.role);
    },
    async createLogin(email, password) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (error || !data.user) {
        const msg = error?.message ?? "unknown error";
        const code = (error as { code?: string } | null)?.code;
        const alreadyExists = code === "email_exists" || /already (been )?registered|already exists/i.test(msg);
        return { ok: false, alreadyExists, message: msg };
      }
      return { ok: true, userId: data.user.id };
    },
    async insertProfile(row) {
      const { error } = await admin.from("profiles").insert(row);
      return error ? error.message : null;
    },
    async insertLocations(rows) {
      const { error } = await admin.from("user_locations").insert(rows);
      return error ? error.message : null;
    },
    async deleteLogin(userId) {
      await admin.auth.admin.deleteUser(userId);
    },
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    res.status(500).json({ error: "Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." });
    return;
  }
  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await createAddMemberHandler(supabaseAddMemberDeps(admin))(req, res);
}
