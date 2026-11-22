import type { DepartmentErrorKind } from "./client";

/**
 * F5 departments: what happens to ONE admin change between the click and a
 * confirmed result. Pure, so the retry rules have unit tests.
 *
 * The rules (spec, "User stories" 4):
 *   - A change gets one request id. A second click while it is in flight
 *     sends nothing.
 *   - No answer (timeout, dropped connection) or "server busy": we do not
 *     know whether it was saved. Retrying the same input re-sends the SAME
 *     id, and the server returns the first result instead of doing it twice.
 *   - "Someone else changed it" (conflict): the id is dropped. The owner must
 *     refresh, look again and deliberately apply it again with a NEW id.
 *   - Changing the input after a failure is a different change: NEW id.
 *   - Nothing is shown as saved until the server said so.
 */

export interface PendingDepartmentChange<I> {
  requestId: string;
  /** Canonical form of the input, to recognise "same change again". */
  payloadKey: string;
  input: I;
}

export type DepartmentAdminStatus =
  | "idle"
  | "submitting"
  /** Outcome not known; retry re-sends the same request. */
  | "unknown"
  /** Stale: refresh and reapply deliberately. */
  | "conflict"
  /** Refused; the input is kept so it can be corrected. */
  | "error"
  | "done";

export interface DepartmentAdminState<I> {
  status: DepartmentAdminStatus;
  pending: PendingDepartmentChange<I> | null;
  /** The last input, kept on failure so the form is not emptied. */
  input: I | null;
  message: string | null;
  /** Set when a submit action actually has to be sent. */
  send: PendingDepartmentChange<I> | null;
}

export type DepartmentAdminAction<I> =
  | { type: "submit"; input: I; payloadKey: string; newRequestId: string }
  | { type: "succeeded"; requestId: string }
  | { type: "failed"; requestId: string; kind: DepartmentErrorKind; message: string }
  | { type: "reset" };

export function initialDepartmentAdminState<I>(): DepartmentAdminState<I> {
  return { status: "idle", pending: null, input: null, message: null, send: null };
}

/** Same key for the same change, whatever order the fields were written in. */
export function departmentPayloadKey(input: unknown): string {
  return JSON.stringify(input, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return value;
  });
}

export function departmentAdminReducer<I>(
  state: DepartmentAdminState<I>,
  action: DepartmentAdminAction<I>,
): DepartmentAdminState<I> {
  switch (action.type) {
    case "submit": {
      // Double-submit: one request only.
      if (state.status === "submitting") return { ...state, send: null };
      const retry = state.status === "unknown" && state.pending !== null && state.pending.payloadKey === action.payloadKey;
      const pending: PendingDepartmentChange<I> = retry
        ? state.pending!
        : { requestId: action.newRequestId, payloadKey: action.payloadKey, input: action.input };
      return { status: "submitting", pending, input: action.input, message: null, send: pending };
    }
    case "succeeded": {
      // A late answer to a request we are no longer waiting for is ignored.
      if (state.pending?.requestId !== action.requestId) return { ...state, send: null };
      return { status: "done", pending: null, input: null, message: null, send: null };
    }
    case "failed": {
      if (state.pending?.requestId !== action.requestId) return { ...state, send: null };
      if (action.kind === "unknown" || action.kind === "busy") {
        // Keep the id: the next attempt at the same change must reuse it.
        return { ...state, status: "unknown", message: action.message, send: null };
      }
      if (action.kind === "conflict") {
        return { status: "conflict", pending: null, input: state.input, message: action.message, send: null };
      }
      return { status: "error", pending: null, input: state.input, message: action.message, send: null };
    }
    case "reset":
      return initialDepartmentAdminState<I>();
    default:
      return state;
  }
}

export function isDepartmentChangeBusy(state: DepartmentAdminState<unknown>): boolean {
  return state.status === "submitting";
}

// ---------------------------------------------------------------------------
// Who the owner panel belongs to
// ---------------------------------------------------------------------------

/**
 * The id the owner panel may be shown and keyed for, or null.
 *
 * The profile is loaded a moment AFTER the session changes, so for a short
 * time the app can hold account B's session with account A's profile. The
 * panel is only allowed when the loaded profile belongs to the live session
 * and that profile is an owner. Anything else hides it at once.
 */
export function departmentsOwnerId(
  sessionUserId: string | null | undefined,
  profile: { user_id: string; role: string } | null | undefined,
): string | null {
  if (!sessionUserId || !profile) return null;
  if (profile.user_id !== sessionUserId) return null;
  if (profile.role !== "owner") return null;
  return sessionUserId;
}

/**
 * Whether an answer may still be applied: the panel that asked must still be
 * mounted, for the same signed-in owner who asked.
 */
export function acceptsDepartmentAnswer(mounted: boolean, askedBy: string, currentCaller: string): boolean {
  return mounted && askedBy === currentCaller;
}

// ---------------------------------------------------------------------------
// The switch: what the owner confirmed, frozen when the confirmation opened
// ---------------------------------------------------------------------------

export interface SwitchIntent {
  /** The state the owner asked for. Never recomputed from later reads. */
  target: boolean;
  /** The control version the owner was looking at. */
  expectedVersion: string;
}

export type SwitchIntentCheck =
  /** Still what the owner was looking at: may be submitted. */
  | "ready"
  /** The switch is already in the asked-for state (their own change landed, or someone else did it). */
  | "already_done"
  /** Someone changed the switch and it is not in the asked-for state: ask again from scratch. */
  | "changed";

export function openSwitchIntent(control: { enabled: boolean; version: string }): SwitchIntent {
  return { target: !control.enabled, expectedVersion: control.version };
}

/** Compare a frozen intent with the latest read. It never flips the target. */
export function checkSwitchIntent(intent: SwitchIntent, control: { enabled: boolean; version: string }): SwitchIntentCheck {
  if (control.enabled === intent.target) return "already_done";
  if (control.version !== intent.expectedVersion) return "changed";
  return "ready";
}
