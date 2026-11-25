import type { PickedPackage } from "@/lib/domain/packaging/evaluate";
import { toQuantities, type Quantities } from "@/lib/domain/packaging/reconcile";
import type { RuleSetBody } from "@/lib/domain/packaging/ruleSet";
import { pickedFromQuantities } from "@/lib/domain/packaging/session";
import type { OverrideOutcome, PackagingPick } from "@/lib/repository/supabase/orderPackaging";

/**
 * F4 box-auto-pick: changing a pick that is already saved (the worker
 * noticed after Complete). Pure state transitions so they can be tested
 * without a screen.
 */

/** Exactly what was sent. Resent unchanged while its outcome is unknown. */
export interface CorrectionSubmission {
  requestId: string;
  expectedRevision: number;
  target: Quantities;
  reason: string;
  staffId: string | null;
}

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
  /** The last request sent; null before the first save. */
  submitted: CorrectionSubmission | null;
  /**
   * The last save got no answer: it may have committed. The draft, reason
   * and request are frozen until a retry gets an answer (or the order is
   * reloaded, which re-reads the saved pick).
   */
  uncertain: boolean;
}

export interface CorrectionState {
  pick: PackagingPick;
  editing: CorrectionEditing | null;
}

export const UNCERTAIN_SAVE_MESSAGE =
  "No connection. The change may already be saved. Tap Retry to check; the box cannot be changed until then.";

export function startCorrection(pick: PackagingPick, ruleSet: RuleSetBody | null, requestId: string): CorrectionState {
  return {
    pick,
    editing: { draft: pickedFromQuantities(ruleSet, pick.target), busy: false, message: null, requestId, submitted: null, uncertain: false },
  };
}

/** Change the draft; refused while a save is in flight or its outcome is unknown. */
export function editCorrectionDraft(state: CorrectionState, change: (draft: PickedPackage[]) => PickedPackage[]): CorrectionState {
  const editing = state.editing;
  if (!editing || editing.busy || editing.uncertain) return state;
  return { pick: state.pick, editing: { ...editing, draft: change(editing.draft), message: null } };
}

/** Close the editor; refused while a save is in flight or its outcome is unknown. */
export function cancelCorrection(state: CorrectionState): CorrectionState {
  if (!state.editing || state.editing.busy || state.editing.uncertain) return state;
  return { pick: state.pick, editing: null };
}

/**
 * Start a save. After an uncertain save this resends the earlier request
 * exactly (same id, revision, target, reason and staff), whatever reason was
 * tapped now. Returns null when nothing should be sent.
 */
export function beginCorrectionSubmit(
  state: CorrectionState,
  reason: string,
  staffId: string | null,
): { state: CorrectionState; request: CorrectionSubmission } | null {
  const editing = state.editing;
  if (!editing || editing.busy) return null;
  const request: CorrectionSubmission =
    editing.uncertain && editing.submitted
      ? editing.submitted
      : { requestId: editing.requestId, expectedRevision: state.pick.revision, target: toQuantities(editing.draft), reason, staffId };
  return { state: { pick: state.pick, editing: { ...editing, busy: true, message: null, submitted: request } }, request };
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
          submitted: null,
          uncertain: false,
        },
      };
    case "network_error":
      return { pick: state.pick, editing: { ...editing, busy: false, message: UNCERTAIN_SAVE_MESSAGE, uncertain: true } };
    case "rejected":
      return {
        pick: state.pick,
        editing: { ...editing, busy: false, message: outcome.message, requestId: nextRequestId, submitted: null, uncertain: false },
      };
  }
}
