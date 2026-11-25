import type { SupabaseClient } from "@supabase/supabase-js";
import { applyPackaging, type ApplyArgs, type PackagingPick } from "@/lib/repository/supabase/orderPackaging";
import type { DrainScope, PackagingOutbox } from "./packagingOutbox";

/**
 * F4 box-auto-pick: send a packaging apply, and never lose one silently.
 *
 *  saved   the server has the pick (new, replayed, or it already existed)
 *  queued  no usable answer; stored on the device and retried with the same request id
 *  failed  the server refused, or the request could not be stored on the device
 *
 * The request is stored BEFORE the first send, so closing the page mid-send
 * cannot lose it. It leaves the queue only when the server settles it.
 */
export type SubmitResult =
  | { kind: "saved"; pick: PackagingPick; alreadyApplied: boolean; stockIssue: boolean }
  | { kind: "queued" }
  | { kind: "failed"; message: string };

/** The signed-in account, read from the local session (no network). Null when unknown. */
export async function currentUserId(client: SupabaseClient): Promise<string | null> {
  try {
    const { data } = await client.auth.getSession();
    return data?.session?.user?.id ?? null;
  } catch {
    return null;
  }
}

export async function submitPackagingApply(
  client: SupabaseClient,
  outbox: PackagingOutbox,
  args: ApplyArgs,
  orderNumber: string,
): Promise<SubmitResult> {
  // Store first. False means "not safely on this device"; the send still goes ahead.
  const stored = outbox.enqueue({ args, orderNumber, userId: await currentUserId(client) });
  const out = await applyPackaging(client, args);
  if (out.outcome === "applied") {
    outbox.remove(args.requestId);
    return { kind: "saved", pick: out.pick, alreadyApplied: false, stockIssue: out.pick.stock_state !== "posted" };
  }
  if (out.outcome === "already_applied") {
    outbox.remove(args.requestId);
    return { kind: "saved", pick: out.pick, alreadyApplied: true, stockIssue: out.pick.stock_state !== "posted" };
  }
  if (out.outcome === "network_error") {
    if (stored) return { kind: "queued" };
    return {
      kind: "failed",
      message: `Packaging for #${orderNumber} was not confirmed and could not be kept on this device. Do not rescan it; tell a manager.`,
    };
  }
  // A settled refusal: nothing to retry.
  outbox.remove(args.requestId);
  return { kind: "failed", message: `Packaging for #${orderNumber} was not recorded: ${out.message}` };
}

/**
 * Retry what this account queued at this site. Other accounts' and sites'
 * requests stay untouched. A sign-in problem keeps the request; only a
 * settled refusal moves it to the rejected list (with the reason).
 */
export async function drainPackagingOutbox(client: SupabaseClient, outbox: PackagingOutbox, scope?: DrainScope): Promise<number> {
  const userId = scope?.userId !== undefined ? scope.userId : await currentUserId(client);
  // Without a known account nothing is sent: a request must not go out under the wrong login.
  if (userId === null) return 0;
  return outbox.drain(
    async (entry) => {
      const out = await applyPackaging(client, entry.args);
      if (out.outcome === "network_error") return "retry";
      if (out.outcome === "rejected") return { rejected: out.message };
      return "done";
    },
    { ...scope, userId },
  );
}
