/**
 * Edge Function: remove-member
 *
 * Called by the Team page (supabase.functions.invoke("remove-member")).
 * Revokes a member's access while keeping their history: blocks the login,
 * turns off active lanyard barcodes, deletes location grants and the profile.
 * See ../_shared/remove-member-core.ts for the order and reasoning.
 *
 * The service role is used ONLY for the Auth admin API (ban the login).
 * Table writes run as the calling owner under the existing RLS policies.
 */
import { createClient } from "npm:@supabase/supabase-js@2.105.4";
import { runRemoveMember, type RemoveMemberDeps } from "../_shared/remove-member-core.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** ~100 years: effectively permanent, and reversible by an admin unban. */
const BAN_DURATION = "876000h";

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
  const admin = createClient(url, serviceKey, { auth: noSession });
  const asCaller = createClient(url, anonKey, {
    auth: noSession,
    global: { headers: { Authorization: authHeader } },
  });

  const deps: RemoveMemberDeps = {
    async verifyToken(token) {
      const { data, error } = await asCaller.auth.getUser(token);
      return error || !data.user ? null : data.user.id;
    },
    async getRole(userId) {
      const { data, error } = await asCaller.from("profiles").select("role").eq("user_id", userId).maybeSingle();
      if (error) throw new Error("Role lookup failed");
      return !data ? null : String(data.role);
    },
    async blockLogin(userId) {
      const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: BAN_DURATION });
      if (error) throw new Error("Block failed");
    },
    async getCallerLocations(userId) {
      const { data, error } = await asCaller.from("user_locations").select("location").eq("user_id", userId);
      if (error) throw new Error("Location lookup failed");
      return (data ?? []).map((r: { location: string }) => r.location);
    },
    async revokeBarcodes(userId, revokedAt) {
      const { data, error } = await asCaller
        .from("staff_barcodes")
        .update({ active: false, revoked_at: revokedAt })
        .eq("user_id", userId)
        .eq("active", true)
        .select("user_id");
      if (error) throw new Error("Barcode revoke failed");
      return data?.length ?? 0;
    },
    async countActiveBarcodes(userId) {
      const { count, error } = await asCaller
        .from("staff_barcodes")
        .select("user_id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("active", true);
      if (error || count === null) throw new Error("Barcode check failed");
      return count;
    },
    async deleteLocations(userId) {
      const { error } = await asCaller.from("user_locations").delete().eq("user_id", userId);
      if (error) throw new Error("Location delete failed");
    },
    async deleteProfile(userId) {
      const { error } = await asCaller.from("profiles").delete().eq("user_id", userId);
      if (error) throw new Error("Profile delete failed");
    },
    now: () => new Date().toISOString(),
    reportFailure(stage, userId) {
      console.error("remove-member failed", { stage, userId });
    },
  };

  let body: unknown = null;
  try { body = await req.json(); } catch { body = null; }

  const result = await runRemoveMember(deps, authHeader, body);
  return json(result.status, result.body);
});
