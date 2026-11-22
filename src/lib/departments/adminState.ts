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
