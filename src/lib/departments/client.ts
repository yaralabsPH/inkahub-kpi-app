import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import {
  DEPARTMENT_PAGE_DEFAULT,
  DEPARTMENT_PAGE_MAX,
  DEPARTMENT_PAGE_ROW_SCHEMAS,
  DepartmentControlSchema,
  DepartmentMutationResultSchema,
  checkDepartmentAdminArgs,
  checkDepartmentReason,
  departmentPageSchema,
  type DepartmentAdminArgs,
  type DepartmentControl,
  type DepartmentCursor,
  type DepartmentMutationResult,
  type DepartmentPageKind,
  type DepartmentPageRows,
} from "@/lib/domain/departments";

/**
 * F5 departments: the only place the app talks to the department functions
 * and tables (migrations 0052-0054). Team data is Supabase-only, so this
 * does not go through Repository.ts.
 *
 * Every function takes the client so it can be tested with a fake. Nothing
 * here is called until the page has checked "Supabase backend" and "owner".
 */

/** The slice of the Supabase client these functions use. */
export type DepartmentsClient = Pick<SupabaseClient, "rpc" | "from">;

export type DepartmentErrorKind =
  /** Not an owner, or not signed in. */
  | "forbidden"
  /** The server refused the input; fix it and send a NEW request. */
  | "invalid"
  /** Someone changed it first: refresh, look again, send a NEW request. */
  | "conflict"
  /** The server was busy with another change: retry the SAME request. */
  | "busy"
  | "name_taken"
  | "has_members"
  /** No answer, or one we cannot read: the change may or may not have been saved. Retry the SAME request. */
  | "unknown";

export type DepartmentResult<T> =
  | { outcome: "ok"; value: T }
  | { outcome: "error"; kind: DepartmentErrorKind; message: string };

interface RpcError {
  code?: string | null;
  message?: string | null;
}

const MESSAGES: Record<string, string> = {
  owner_only: "Only an owner can manage departments.",
  not_signed_in: "Sign in again to manage departments.",
  department_name_taken: "A department already has that name (archived departments keep their names).",
  department_has_members: "Move everyone out of this department before archiving it.",
  department_archived: "That department is archived. Restore it first.",
  department_changed: "Someone else changed this department. Refresh and try again.",
  assignment_changed: "This person's home department was changed by someone else. Refresh and try again.",
  control_changed: "Someone else changed the switch. Refresh and try again.",
  person_not_on_team: "That person is no longer on the team.",
  reason_required: "Enter a reason.",
  name_has_control_characters: "Names can't contain tabs, line breaks or control characters.",
  name_too_long: "Names can be at most 80 characters.",
  name_required: "Enter a department name.",
  too_soon_retry: "That was too soon after the last change. Refresh and try again.",
  request_id_reused: "That request was already used for a different change. Try again.",
};

/** Turn a PostgREST / Postgres error into what the UI should do next. */
export function classifyDepartmentError(error: RpcError | null | undefined): { kind: DepartmentErrorKind; message: string } {
  const code = error?.code ?? "";
  const raw = (error?.message ?? "").trim();
  const known = MESSAGES[raw];
  switch (code) {
    case "42501":
      return { kind: "forbidden", message: known ?? "Only an owner can manage departments." };
    case "22023":
      return { kind: "invalid", message: known ?? "That change was refused. Check the details and try again." };
    case "40001":
      return { kind: "conflict", message: known ?? "Someone else changed this first. Refresh and try again." };
    case "55P03":
      return { kind: "busy", message: "Another department change is in progress. Try again." };
    case "23505":
      return { kind: "name_taken", message: MESSAGES.department_name_taken };
    case "P0001":
      if (raw === "department_has_members") return { kind: "has_members", message: MESSAGES.department_has_members };
      break;
    default:
      break;
  }
  // Network failure, timeout, or anything unexpected: we do not know whether
  // the change was saved, so the caller must retry the same request id.
  return { kind: "unknown", message: "No clear answer from the server. The change may or may not have been saved." };
}

function parsed<S extends z.ZodTypeAny>(schema: S, data: unknown): DepartmentResult<z.infer<S>> {
  const result = schema.safeParse(data);
  if (result.success) return { outcome: "ok", value: result.data };
  return { outcome: "error", kind: "unknown", message: "The server answered in a form this version of the app does not understand." };
}

async function call<S extends z.ZodTypeAny>(
  schema: S,
  run: () => PromiseLike<{ data: unknown; error: RpcError | null }>,
): Promise<DepartmentResult<z.infer<S>>> {
  try {
    const { data, error } = await run();
    if (error) return { outcome: "error", ...classifyDepartmentError(error) };
    return parsed(schema, data);
  } catch {
    return { outcome: "error", ...classifyDepartmentError(null) };
  }
}

/**
 * Create / rename / archive / restore a department, or assign / correct a
 * person's home department. `requestId` identifies this one change: sending
 * it again returns the first result instead of applying it twice.
 */
export async function departmentAdmin(
  client: DepartmentsClient,
  requestId: string,
  args: DepartmentAdminArgs,
): Promise<DepartmentResult<DepartmentMutationResult>> {
  const checked = checkDepartmentAdminArgs(args);
  if (!checked.ok) return { outcome: "error", kind: "invalid", message: checked.error };
  const a = checked.value;
  return call(DepartmentMutationResultSchema, () =>
    client.rpc("department_admin", {
      p_operation: a.operation,
      p_request_id: requestId,
      p_department_id: a.departmentId,
      p_person_id: a.personId,
      p_name: a.name,
      // bigint versions travel as decimal strings in both directions.
      p_expected_version: a.expectedVersion,
      p_expected_assignment_id: a.expectedAssignmentId,
      p_reason: a.reason,
    }));
}

/** The event-snapshot switch. A reason is always required. */
export async function setDepartmentSnapshotEnabled(
  client: DepartmentsClient,
  requestId: string,
  enabled: boolean,
  expectedVersion: string,
  reason: string,
): Promise<DepartmentResult<DepartmentMutationResult>> {
  const checked = checkDepartmentReason(reason, true);
  if (!checked.ok) return { outcome: "error", kind: "invalid", message: checked.error };
  return call(DepartmentMutationResultSchema, () =>
    client.rpc("department_set_snapshot_enabled", {
      p_request_id: requestId,
      p_enabled: enabled,
      p_expected_version: expectedVersion,
      p_reason: checked.reason,
    }));
}

export interface DepartmentPage<K extends DepartmentPageKind> {
  rows: DepartmentPageRows[K][];
  nextCursor: DepartmentCursor;
}

/** One page (at most 100 rows). `nextCursor` is null on the last page. */
export async function fetchDepartmentPage<K extends DepartmentPageKind>(
  client: DepartmentsClient,
  kind: K,
  subjectId: string | null,
  cursor: DepartmentCursor,
  limit: number = DEPARTMENT_PAGE_DEFAULT,
): Promise<DepartmentResult<DepartmentPage<K>>> {
  if (!Number.isInteger(limit) || limit < 1 || limit > DEPARTMENT_PAGE_MAX) {
    return { outcome: "error", kind: "invalid", message: `Pages hold 1 to ${DEPARTMENT_PAGE_MAX} rows.` };
  }
  const schema = departmentPageSchema(DEPARTMENT_PAGE_ROW_SCHEMAS[kind]);
  const result = await call(schema, () =>
    client.rpc("department_owner_page", {
      p_kind: kind,
      p_subject_id: subjectId,
      p_cursor: cursor,
      p_limit: limit,
    }));
  if (result.outcome !== "ok") return result;
  return {
    outcome: "ok",
    value: { rows: result.value.rows as DepartmentPageRows[K][], nextCursor: result.value.next_cursor },
  };
}

/**
 * Every row of a list, page by page. Stops only when the server says there
 * is no next page; an error or a cursor that does not move is reported, never
 * turned into a short list.
 */
export async function fetchAllDepartmentRows<K extends DepartmentPageKind>(
  client: DepartmentsClient,
  kind: K,
  subjectId: string | null,
  limit: number = DEPARTMENT_PAGE_MAX,
): Promise<DepartmentResult<DepartmentPageRows[K][]>> {
  const rows: DepartmentPageRows[K][] = [];
  let cursor: DepartmentCursor = null;
  const seen = new Set<string>();
  for (;;) {
    const page: DepartmentResult<DepartmentPage<K>> = await fetchDepartmentPage(client, kind, subjectId, cursor, limit);
    if (page.outcome !== "ok") return page;
    rows.push(...page.value.rows);
    cursor = page.value.nextCursor;
    if (cursor === null) return { outcome: "ok", value: rows };
    const key = JSON.stringify(cursor);
    if (seen.has(key)) {
      return { outcome: "error", kind: "unknown", message: "The list could not be read completely. Refresh and try again." };
    }
    seen.add(key);
  }
}

/** The one-row switch. Owners read it directly; everyone else sees no row. */
export async function fetchDepartmentControl(client: DepartmentsClient): Promise<DepartmentResult<DepartmentControl>> {
  return call(DepartmentControlSchema, () =>
    client.from("department_snapshot_control").select("enabled, tracking_started_at, version, updated_at").maybeSingle());
}

/** One owner change, as the UI describes it. */
export type DepartmentChange =
  | { kind: "admin"; args: DepartmentAdminArgs }
  | { kind: "switch"; enabled: boolean; expectedVersion: string; reason: string };

export function sendDepartmentChange(
  client: DepartmentsClient,
  change: DepartmentChange,
  requestId: string,
): Promise<DepartmentResult<DepartmentMutationResult>> {
  if (change.kind === "switch") {
    return setDepartmentSnapshotEnabled(client, requestId, change.enabled, change.expectedVersion, change.reason);
  }
  return departmentAdmin(client, requestId, change.args);
}
