/**
 * Remove-member logic shared by the `remove-member` Edge Function and its
 * tests. Pure TypeScript with no imports (runs in Deno and vitest).
 *
 * "Remove" revokes access but keeps history:
 *   1. block the login (Auth ban), so no new sign-in or session refresh
 *   2. turn off the member's active lanyard barcodes
 *   3. delete their location grants (these alone give data access via
 *      can_access_location, even without a profile)
 *   4. delete their profile
 *
 * The auth user itself is NOT deleted: production_events references
 * auth.users ON DELETE RESTRICT, and staff_barcodes would cascade away the
 * barcode history used to attribute past scans.
 *
 * Steps run in that order so a failure part-way leaves the member with LESS
 * access, never more. Every step is idempotent, so a retry is always safe.
 */

export type RemoveMemberStage =
  | "verify_token"
  | "get_role"
  | "block_login"
  | "revoke_barcodes"
  | "delete_locations"
  | "delete_profile";

export interface RemoveMemberDeps {
  /** Verify an access token; returns the caller's user id or null. */
  verifyToken(token: string): Promise<string | null>;
  /** The caller's app role from `profiles`, or null if they have no profile. */
  getRole(userId: string): Promise<string | null>;
  /** Ban the login so it can't sign in or refresh. Throw on failure. */
  blockLogin(userId: string): Promise<void>;
  /** Mark active barcodes inactive. Returns how many were revoked. Throw on failure. */
  revokeBarcodes(userId: string, revokedAt: string): Promise<number>;
  /** Delete all location grants. Throw on failure. */
  deleteLocations(userId: string): Promise<void>;
  /** Delete the profile row. Throw on failure. */
  deleteProfile(userId: string): Promise<void>;
  /** Current time as ISO string (injectable for tests). */
  now(): string;
  /** Log only a fixed stage and target id, never error objects. */
  reportFailure?(stage: RemoveMemberStage, userId?: string): void;
}

export interface RemoveMemberResult {
  status: number;
  body: { user_id: string; barcodes_revoked: number } | { error: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STAGE_LABEL: Record<RemoveMemberStage, string> = {
  verify_token: "checking your session",
  get_role: "checking your role",
  block_login: "blocking their login",
  revoke_barcodes: "turning off their lanyard",
  delete_locations: "removing their location access",
  delete_profile: "removing their profile",
};

function bearerFrom(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

export async function runRemoveMember(
  deps: RemoveMemberDeps,
  authHeader: string | null | undefined,
  rawBody: unknown,
): Promise<RemoveMemberResult> {
  const token = bearerFrom(authHeader);
  if (!token) return { status: 401, body: { error: "Sign in again and retry." } };

  const targetId =
    rawBody && typeof rawBody === "object" && typeof (rawBody as Record<string, unknown>).user_id === "string"
      ? ((rawBody as Record<string, unknown>).user_id as string).trim()
      : "";

  let stage: RemoveMemberStage = "verify_token";
  try {
    const callerId = await deps.verifyToken(token);
    if (!callerId) return { status: 401, body: { error: "Your session has expired. Sign in again and retry." } };
    stage = "get_role";
    if ((await deps.getRole(callerId)) !== "owner") {
      return { status: 403, body: { error: "Only owners can remove team members." } };
    }
    if (!UUID.test(targetId)) return { status: 400, body: { error: "Pick a valid member to remove." } };
    if (targetId.toLowerCase() === callerId.toLowerCase()) {
      return { status: 400, body: { error: "You can't remove yourself." } };
    }

    stage = "block_login";
    await deps.blockLogin(targetId);
    stage = "revoke_barcodes";
    const revoked = await deps.revokeBarcodes(targetId, deps.now());
    stage = "delete_locations";
    await deps.deleteLocations(targetId);
    stage = "delete_profile";
    await deps.deleteProfile(targetId);

    return { status: 200, body: { user_id: targetId, barcodes_revoked: revoked } };
  } catch {
    deps.reportFailure?.(stage, targetId || undefined);
    const doneSoFar =
      stage === "block_login" || stage === "verify_token" || stage === "get_role"
        ? "Nothing was changed."
        : "Their login is already blocked.";
    return {
      status: 500,
      body: { error: `Removal stopped while ${STAGE_LABEL[stage]}. ${doneSoFar} It's safe to try again.` },
    };
  }
}
