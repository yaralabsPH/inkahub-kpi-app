/**
 * Edge Function: add-member
 *
 * Called by the Team page (supabase.functions.invoke("add-member")).
 * Creates a team member's login, profile and location grants in one go,
 * after checking the caller is an owner. Supabase injects SUPABASE_URL,
 * SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY into Edge Functions, so no
 * key ever reaches the browser or a developer machine. The service role is
 * used only for the Auth admin API; table reads/writes run as the caller
 * under RLS. Logic lives in ../_shared/add-member-core.ts.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { runAddMember, type AddMemberDeps } from "../_shared/add-member-core.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !serviceKey || !anonKey) return json(500, { error: "Function is missing Supabase settings." });

  const authHeader = req.headers.get("Authorization") ?? "";
  const noSession = { autoRefreshToken: false, persistSession: false };

  // Admin client: ONLY for the Auth admin API (create / delete a login).
  // The service role has no grants on the app tables, by design.
  const admin = createClient(url, serviceKey, { auth: noSession });
  // Caller client: reads and writes app tables AS the signed-in owner, so the
  // existing RLS policies (is_owner()) decide what is allowed.
  const asCaller = createClient(url, anonKey, {
    auth: noSession,
    global: { headers: { Authorization: authHeader } },
  });

  const deps: AddMemberDeps = {
    async verifyToken(token) {
      const { data, error } = await admin.auth.getUser(token);
      return error || !data.user ? null : data.user.id;
    },
    async getRole(userId) {
      const { data, error } = await asCaller.from("profiles").select("role").eq("user_id", userId).maybeSingle();
      if (error) console.error("add-member: role lookup failed:", error.message);
      return error || !data ? null : String(data.role);
    },
    async createLogin(email, password) {
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error || !data.user) {
        const message = error?.message ?? "unknown error";
        const code = (error as { code?: string } | null)?.code;
        const alreadyExists = code === "email_exists" || /already (been )?registered|already exists/i.test(message);
        return { ok: false, alreadyExists, message };
      }
      return { ok: true, userId: data.user.id };
    },
    async insertProfile(row) {
      const { error } = await asCaller.from("profiles").insert(row);
      return error ? error.message : null;
    },
    async insertLocations(rows) {
      const { error } = await asCaller.from("user_locations").insert(rows);
      return error ? error.message : null;
    },
    async deleteLogin(userId) {
      await admin.auth.admin.deleteUser(userId);
    },
  };

  let body: unknown = null;
  try { body = await req.json(); } catch { body = null; }

  const result = await runAddMember(deps, authHeader, body);
  return json(result.status, result.body);
});
