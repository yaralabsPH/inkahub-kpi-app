/**
 * Real Supabase sessions for the staging test users, used ONLY to supply each
 * role's exact JWT claims text to the SQL evidence (so RLS costs what it
 * costs through the API). STAGING ONLY.
 *
 * The claims text stays in memory and is passed to SQL as a bound parameter.
 * Only sizes/shapes (ClaimsSource) are kept for reports. Sessions are signed
 * out locally afterwards (refresh tokens are not revoked).
 */
import { createClient } from "@supabase/supabase-js";
import { assertStagingSupabaseUrl } from "./measure-item-counting";
import { claimsSource, jwtPayloadText, type ClaimsSource } from "./itemCountingPolicyParity";
import { STAGING_ISSUER } from "./generate-query-evidence";

export const SESSION_ROLES = ["owner", "manager", "staff", "kiosk", "cs"] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

export interface SessionLogin {
  email: string;
  password: string;
}

export interface SessionClaims {
  /** Exact claims JSON text per role: in memory only, never logged or written. */
  text: Record<string, string>;
  /** Sizes/shapes/problems per role, safe to report. */
  sources: Record<string, ClaimsSource>;
}

export async function signInClaims(supabaseUrl: string, anonKey: string, logins: Record<SessionRole, SessionLogin>): Promise<SessionClaims> {
  assertStagingSupabaseUrl(supabaseUrl);
  const out: SessionClaims = { text: {}, sources: {} };
  for (const role of SESSION_ROLES) {
    const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await client.auth.signInWithPassword(logins[role]);
    if (error || !data.session) throw new Error(`Sign-in failed for the ${role} test user: ${error?.message ?? "no session"}`);
    try {
      const text = jwtPayloadText(data.session.access_token);
      out.text[role] = text;
      out.sources[role] = claimsSource(role, text, { issuer: STAGING_ISSUER, nowSec: Math.floor(Date.now() / 1000) });
    } finally {
      await client.auth.signOut({ scope: "local" });
    }
  }
  return out;
}
