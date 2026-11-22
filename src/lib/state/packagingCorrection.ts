import type { PickedPackage } from "@/lib/domain/packaging/evaluate";
import type { RuleSetBody } from "@/lib/domain/packaging/ruleSet";
import { pickedFromQuantities } from "@/lib/domain/packaging/session";
import type { OverrideOutcome, PackagingPick } from "@/lib/repository/supabase/orderPackaging";

/**
 * F4 box-auto-pick: changing a pick that is already saved (the worker
 * noticed after Complete). Pure state transitions so they can be tested
 * without a screen.
 */
export interface CorrectionEditing {
  draft: PickedPackage[];
  busy: boolean;
  message: string | null;
  /**
   * One request id per attempt at a given revision. It is kept across a
   * "no connection" retry so the server replays instead of applying twice,
   * and replaced after a conflict because that is a new attempt.
   */
  requestId: string;
}

export interface CorrectionState {
  pick: PackagingPick;
  editing: CorrectionEditing | null;
}

export function startCorrection(pick: PackagingPick, ruleSet: RuleSetBody | null, requestId: string): CorrectionState {
  return { pick, editing: { draft: pickedFromQuantities(ruleSet, pick.target), busy: false, message: null, requestId } };
}

export function afterOverride(
  state: CorrectionState,
  outcome: OverrideOutcome,
  ruleSet: RuleSetBody | null,
  nextRequestId: string,
): CorrectionState {
  const editing = state.editing;
  if (!editing) return state;
  switch (outcome.outcome) {
    case "overridden":
    case "unchanged":
      return { pick: outcome.pick, editing: null };
    case "conflict":
      return {
        pick: outcome.pick,
        editing: {
          draft: pickedFromQuantities(ruleSet, outcome.pick.target),
          busy: false,
          message: "This was changed on another device. Showing the latest. Change it again if it is still wrong.",
          requestId: nextRequestId,
        },
      };
    case "network_error":
      return {
        pick: state.pick,
        editing: { ...editing, busy: false, message: "No connection. Nothing was changed. Tap the reason again to retry." },
      };
    case "rejected":
      return { pick: state.pick, editing: { ...editing, busy: false, message: outcome.message, requestId: nextRequestId } };
  }
}
