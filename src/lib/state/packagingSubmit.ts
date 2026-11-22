import type { SupabaseClient } from "@supabase/supabase-js";
import { applyPackaging, type ApplyArgs, type PackagingPick } from "@/lib/repository/supabase/orderPackaging";
import type { PackagingOutbox } from "./packagingOutbox";

/**
 * F4 box-auto-pick: send a packaging apply, and never lose one silently.
 *
 *  saved   the server has the pick (new, replayed, or it already existed)
 *  queued  no answer; kept on the device and retried with the same request id
 *  failed  the server refused, or the device could not keep the request
 */
export type SubmitResult =
  | { kind: "saved"; pick: PackagingPick; alreadyApplied: boolean; stockIssue: boolean }
  | { kind: "queued" }
  | { kind: "failed"; message: string };

export async function submitPackagingApply(
  client: SupabaseClient,
  outbox: PackagingOutbox,
  args: ApplyArgs,
  orderNumber: string,
): Promise<SubmitResult> {
  const out = await applyPackaging(client, args);
  if (out.outcome === "applied") {
    return { kind: "saved", pick: out.pick, alreadyApplied: false, stockIssue: out.pick.stock_state !== "posted" };
  }
  if (out.outcome === "already_applied") {
    return { kind: "saved", pick: out.pick, alreadyApplied: true, stockIssue: out.pick.stock_state !== "posted" };
  }
  if (out.outcome === "network_error") {
    if (outbox.enqueue({ args, orderNumber })) return { kind: "queued" };
    return {
      kind: "failed",
      message: `Packaging for #${orderNumber} could not be saved or kept for retry. Tell a manager.`,
    };
  }
  return { kind: "failed", message: `Packaging for #${orderNumber} was not recorded: ${out.message}` };
}

/** Retry everything queued on this device. Returns how many entries were settled. */
export function drainPackagingOutbox(client: SupabaseClient, outbox: PackagingOutbox): Promise<number> {
  return outbox.drain(async (entry) => {
    const out = await applyPackaging(client, entry.args);
    // Any definitive answer settles the entry. A refusal will not improve by
    // retrying; the completion then shows in the managers' attention list
    // as "no packaging record".
    return out.outcome === "network_error" ? "retry" : "done";
  });
}
