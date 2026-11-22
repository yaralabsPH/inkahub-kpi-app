import { z } from "zod";

/**
 * F5 departments: shared contracts for managed business departments.
 *
 * A business department is the team a person belongs to. It is NOT the
 * routing work type stored in `production_events.department` (a0_framed,
 * framed, unframed, dispatch); nothing here changes routing.
 *
 * The database (migrations 0052-0054) is the authority for every rule in
 * this file. The helpers mirror the SQL so the browser can preview a name
 * and so the boundary rules have fast unit tests; the server always wins.
 */

// ---------------------------------------------------------------------------
// Limits and vocabularies (must match the SQL)
// ---------------------------------------------------------------------------

export const DEPARTMENT_NAME_MAX = 80;
export const DEPARTMENT_REASON_MAX = 500;
/** A reported time up to this far ahead of receipt is clamped to receipt. */
export const FUTURE_CLAMP_US = 5_000_000n; // 5 seconds, inclusive
/** A reported time more than this far behind receipt is flagged, not refused. */
export const REPORTED_OLD_US = 300_000_000n; // 5 minutes, exclusive
export const DEPARTMENT_SNAPSHOT_VERSION = 1;
export const DEPARTMENT_PAGE_MAX = 100;
export const DEPARTMENT_PAGE_DEFAULT = 50;

export const DEPARTMENT_STATUSES = [
  "assigned",
  "unassigned",
  "before_tracking",
  "invalid_time",
  "resolution_busy",
  "resolution_error",
  "disabled",
  "control_missing",
  "resolver_unavailable",
] as const;
export const DepartmentStatusSchema = z.enum(DEPARTMENT_STATUSES);
export type DepartmentStatus = z.infer<typeof DepartmentStatusSchema>;

export const DEPARTMENT_TIME_STATUSES = ["reported", "future_clamped", "reported_old", "invalid_time"] as const;
export const DepartmentTimeStatusSchema = z.enum(DEPARTMENT_TIME_STATUSES);
export type DepartmentTimeStatus = z.infer<typeof DepartmentTimeStatusSchema>;

export const DEPARTMENT_ADMIN_OPERATIONS = ["create", "rename", "archive", "restore", "assign", "correct"] as const;
export type DepartmentAdminOperation = (typeof DEPARTMENT_ADMIN_OPERATIONS)[number];

export const DEPARTMENT_AUDIT_OPERATIONS = [
  "create", "rename", "archive", "restore", "assign", "transfer", "correct", "remove", "control",
] as const;

export const DEPARTMENT_PAGE_KINDS = [
  "departments_active", "departments_archived", "people", "members", "history", "audit",
] as const;
export type DepartmentPageKind = (typeof DEPARTMENT_PAGE_KINDS)[number];

// ---------------------------------------------------------------------------
// Names and reasons
// ---------------------------------------------------------------------------

// C0/C1 control characters plus the line and paragraph separators. Tabs and
// newlines are control characters: they are refused, not collapsed.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
// The spaces that are collapsed to one ordinary space.
const SPACE_RUN = /[ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g;

export type NameCheck = { ok: true; name: string } | { ok: false; error: string };

/** Collapse spaces and trim. Display casing is kept. */
export function previewDepartmentName(raw: string): string {
  return raw.replace(SPACE_RUN, " ").trim();
}

/** Code points, to match Postgres `char_length`. */
function length(text: string): number {
  return Array.from(text).length;
}

export function checkDepartmentName(raw: string): NameCheck {
  if (CONTROL_CHARS.test(raw)) return { ok: false, error: "Names can't contain tabs, line breaks or control characters." };
  const name = previewDepartmentName(raw);
  if (name.length === 0) return { ok: false, error: "Enter a department name." };
  if (length(name) > DEPARTMENT_NAME_MAX) return { ok: false, error: `Names can be at most ${DEPARTMENT_NAME_MAX} characters.` };
  return { ok: true, name };
}

/** The key the server uses for uniqueness (lower-cased normalized name). */
export function departmentNameKey(name: string): string {
  return previewDepartmentName(name).toLowerCase();
}

export type ReasonCheck = { ok: true; reason: string } | { ok: false; error: string };

export function checkDepartmentReason(raw: string, required: boolean): ReasonCheck {
  const reason = raw.trim();
  if (required && reason.length === 0) return { ok: false, error: "Enter a reason." };
  if (length(reason) > DEPARTMENT_REASON_MAX) return { ok: false, error: `Reasons can be at most ${DEPARTMENT_REASON_MAX} characters.` };
  return { ok: true, reason };
}

// ---------------------------------------------------------------------------
// Time rules (integer microseconds, like Postgres timestamptz)
// ---------------------------------------------------------------------------

export interface DepartmentTimeClass {
  timeStatus: DepartmentTimeStatus;
  /** The instant used to look up the assignment; null means no lookup. */
  resolutionUs: bigint | null;
}

/**
 * Mirrors `departments_private.classify_time`.
 * `occurredUs` is null for a missing or non-finite reported time.
 */
export function classifyDepartmentTime(occurredUs: bigint | null, receivedUs: bigint): DepartmentTimeClass {
  if (occurredUs === null) return { timeStatus: "invalid_time", resolutionUs: null };
  const ahead = occurredUs - receivedUs;
  if (ahead > FUTURE_CLAMP_US) return { timeStatus: "invalid_time", resolutionUs: null };
  if (ahead > 0n) return { timeStatus: "future_clamped", resolutionUs: receivedUs };
  if (-ahead > REPORTED_OLD_US) return { timeStatus: "reported_old", resolutionUs: occurredUs };
  return { timeStatus: "reported", resolutionUs: occurredUs };
}

/** Half-open interval [from, to); a null end means "still open". */
export function containsDepartmentInstant(fromUs: bigint, toUs: bigint | null, instantUs: bigint): boolean {
  return fromUs <= instantUs && (toUs === null || instantUs < toUs);
}

export interface DepartmentInterval {
  id: string;
  fromUs: bigint;
  toUs: bigint | null;
}

/** True when two half-open intervals share at least one instant. */
export function departmentIntervalsOverlap(a: DepartmentInterval, b: DepartmentInterval): boolean {
  const aEndsBeforeB = a.toUs !== null && a.toUs <= b.fromUs;
  const bEndsBeforeA = b.toUs !== null && b.toUs <= a.fromUs;
  return !aEndsBeforeB && !bEndsBeforeA;
}

export type IntervalResolution =
  | { outcome: "none" }
  | { outcome: "one"; id: string }
  | { outcome: "inconsistent" };

/** Which interval is in force at an instant: none, exactly one, or broken history. */
export function resolveDepartmentInterval(intervals: DepartmentInterval[], instantUs: bigint): IntervalResolution {
  const hits = intervals.filter((i) => containsDepartmentInstant(i.fromUs, i.toUs, instantUs));
  if (hits.length === 0) return { outcome: "none" };
  if (hits.length > 1) return { outcome: "inconsistent" };
  return { outcome: "one", id: hits[0].id };
}

// ---------------------------------------------------------------------------
// Event snapshot (the eleven columns added to production_events)
// ---------------------------------------------------------------------------

const NullableText = z.string().nullable().optional();

/**
 * All fields are optional and nullable: rows written before migration 0054
 * (and every Dexie row) have none of them. NULL status means "legacy, never
 * resolved", which is different from `unassigned`.
 */
export const DepartmentSnapshotShape = {
  business_department_id: NullableText,
  business_department_name: NullableText,
  business_department_assignment_id: NullableText,
  business_department_name_version_id: NullableText,
  business_department_status: DepartmentStatusSchema.nullable().optional(),
  department_snapshot_version: z.number().int().nullable().optional(),
  department_occurred_at: NullableText,
  department_received_at: NullableText,
  department_resolution_instant: NullableText,
  department_time_status: DepartmentTimeStatusSchema.nullable().optional(),
  department_resolved_at: NullableText,
} as const;

export const DepartmentSnapshotSchema = z.object(DepartmentSnapshotShape);
export type DepartmentSnapshot = z.infer<typeof DepartmentSnapshotSchema>;

export const DEPARTMENT_SNAPSHOT_FIELDS = Object.keys(DepartmentSnapshotShape) as Array<keyof DepartmentSnapshot>;

/**
 * The rule the triggers keep: `assigned` carries all four references, every
 * other status (and a legacy row) carries none. Returns null when coherent.
 */
export function departmentSnapshotProblem(row: DepartmentSnapshot): string | null {
  const refs = [
    row.business_department_id,
    row.business_department_name,
    row.business_department_assignment_id,
    row.business_department_name_version_id,
  ];
  const present = refs.filter((r) => r !== null && r !== undefined).length;
  const status = row.business_department_status ?? null;
  if (status === "assigned") return present === 4 ? null : "assigned without all four department references";
  if (present !== 0) return `${status ?? "legacy"} row carries department references`;
  if (status === null) {
    const stray = DEPARTMENT_SNAPSHOT_FIELDS.some((f) => row[f] !== null && row[f] !== undefined);
    return stray ? "legacy row carries snapshot fields" : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Admin requests and results
// ---------------------------------------------------------------------------

const Uuid = z.string().uuid();
/** bigint versions travel as decimal strings. */
const VersionString = z.string().regex(/^[1-9][0-9]{0,17}$/);

export interface DepartmentAdminArgs {
  operation: DepartmentAdminOperation;
  departmentId: string | null;
  personId: string | null;
  name: string | null;
  expectedVersion: string | null;
  expectedAssignmentId: string | null;
  reason: string;
}

export type ArgsCheck = { ok: true; value: DepartmentAdminArgs } | { ok: false; error: string };

const isUuid = (v: string | null): v is string => v !== null && Uuid.safeParse(v).success;
const isVersion = (v: string | null): v is string => v !== null && VersionString.safeParse(v).success;

/**
 * Same field rules as `public.department_admin`: each operation takes exactly
 * its own arguments and refuses the rest.
 */
export function checkDepartmentAdminArgs(raw: DepartmentAdminArgs): ArgsCheck {
  if (!(DEPARTMENT_ADMIN_OPERATIONS as readonly string[]).includes(raw.operation)) {
    return { ok: false, error: "Unknown operation." };
  }
  const op = raw.operation;
  const needsReason = op === "correct";
  const reason = checkDepartmentReason(raw.reason ?? "", needsReason);
  if (!reason.ok) return reason;
  const value: DepartmentAdminArgs = { ...raw, reason: reason.reason };

  const refuse = (what: string): ArgsCheck => ({ ok: false, error: `${op} does not take ${what}.` });

  if (op === "create") {
    if (raw.departmentId !== null) return refuse("a department");
    if (raw.personId !== null) return refuse("a person");
    if (raw.expectedVersion !== null) return refuse("a version");
    if (raw.expectedAssignmentId !== null) return refuse("an assignment");
    const name = checkDepartmentName(raw.name ?? "");
    if (!name.ok) return name;
    return { ok: true, value: { ...value, name: name.name } };
  }

  if (!isUuid(raw.departmentId)) return { ok: false, error: "Pick a department." };
  if (!isVersion(raw.expectedVersion)) return { ok: false, error: "Refresh and try again." };

  if (op === "rename") {
    if (raw.personId !== null) return refuse("a person");
    if (raw.expectedAssignmentId !== null) return refuse("an assignment");
    const name = checkDepartmentName(raw.name ?? "");
    if (!name.ok) return name;
    return { ok: true, value: { ...value, name: name.name } };
  }

  if (raw.name !== null) return refuse("a name");

  if (op === "archive" || op === "restore") {
    if (raw.personId !== null) return refuse("a person");
    if (raw.expectedAssignmentId !== null) return refuse("an assignment");
    return { ok: true, value };
  }

  // assign / correct
  if (!isUuid(raw.personId)) return { ok: false, error: "Pick a person." };
  if (raw.expectedAssignmentId !== null && !isUuid(raw.expectedAssignmentId)) {
    return { ok: false, error: "Refresh and try again." };
  }
  return { ok: true, value };
}

export const DepartmentMutationResultSchema = z.object({
  request_id: Uuid,
  outcome: z.enum(["applied", "noop"]),
  effective_at: z.string().nullable(),
  department_id: Uuid.nullable(),
  department_version: VersionString.nullable(),
  assignment_id: Uuid.nullable(),
  control_version: VersionString.nullable(),
});
export type DepartmentMutationResult = z.infer<typeof DepartmentMutationResultSchema>;

// ---------------------------------------------------------------------------
// Owner pages
// ---------------------------------------------------------------------------

export const DepartmentRowSchema = z.object({
  id: Uuid,
  name: z.string(),
  version: VersionString,
  archived_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  member_count: z.number().int().nonnegative(),
});
export type DepartmentRow = z.infer<typeof DepartmentRowSchema>;

/** One current profile (people) or one open assignment (members). */
export const DepartmentPersonRowSchema = z.object({
  person_id: Uuid,
  /** null when the person has no profile any more ("Removed person"). */
  display_name: z.string().nullable(),
  assignment_id: Uuid.nullable(),
  department_id: Uuid.nullable(),
  department_name: z.string().nullable(),
  valid_from: z.string().nullable(),
});
export type DepartmentPersonRow = z.infer<typeof DepartmentPersonRowSchema>;

export const DepartmentHistoryRowSchema = z.object({
  id: Uuid,
  person_id: Uuid,
  department_id: Uuid,
  /** The department's name while this assignment was opened. */
  department_name: z.string().nullable(),
  valid_from: z.string(),
  valid_to: z.string().nullable(),
  reason: z.string(),
  created_by: Uuid.nullable(),
  closed_by: Uuid.nullable(),
});
export type DepartmentHistoryRow = z.infer<typeof DepartmentHistoryRowSchema>;

export const DepartmentAuditRowSchema = z.object({
  id: Uuid,
  request_id: Uuid.nullable(),
  operation: z.enum(DEPARTMENT_AUDIT_OPERATIONS),
  actor_id: Uuid.nullable(),
  actor_name: z.string().nullable(),
  department_id: Uuid.nullable(),
  person_id: Uuid.nullable(),
  person_name: z.string().nullable(),
  assignment_id: Uuid.nullable(),
  recorded_at: z.string(),
  effective_at: z.string(),
  before_data: z.unknown(),
  after_data: z.unknown(),
  reason: z.string(),
});
export type DepartmentAuditRow = z.infer<typeof DepartmentAuditRowSchema>;

export const DepartmentControlSchema = z.object({
  enabled: z.boolean(),
  tracking_started_at: z.string(),
  // PostgREST returns bigint as a JSON number; keep it as a string.
  version: z.union([z.string(), z.number()]).transform((v) => String(v)).pipe(VersionString),
  updated_at: z.string(),
});
export type DepartmentControl = z.infer<typeof DepartmentControlSchema>;

export const DepartmentCursorSchema = z.record(z.string()).nullable();
export type DepartmentCursor = z.infer<typeof DepartmentCursorSchema>;

export function departmentPageSchema<T extends z.ZodTypeAny>(row: T) {
  return z.object({ rows: z.array(row), next_cursor: DepartmentCursorSchema });
}

export const DEPARTMENT_PAGE_ROW_SCHEMAS = {
  departments_active: DepartmentRowSchema,
  departments_archived: DepartmentRowSchema,
  people: DepartmentPersonRowSchema,
  members: DepartmentPersonRowSchema,
  history: DepartmentHistoryRowSchema,
  audit: DepartmentAuditRowSchema,
} as const;

export interface DepartmentPageRows {
  departments_active: DepartmentRow;
  departments_archived: DepartmentRow;
  people: DepartmentPersonRow;
  members: DepartmentPersonRow;
  history: DepartmentHistoryRow;
  audit: DepartmentAuditRow;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** Confirmed site zones (ROADMAP-REVIEW F6 / 12). Other sites show UTC. */
export const SITE_TIME_ZONES: Record<string, string> = {
  au: "Australia/Sydney",
  uk: "Europe/London",
  us: "America/Chicago",
};

export function siteTimeZone(location: string): string {
  return SITE_TIME_ZONES[location] ?? "UTC";
}

/** "22 Nov 2026, 09:05 (Australia/Sydney)": stored in UTC, shown in the site's zone. */
export function formatDepartmentInstant(iso: string | null | undefined, location: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const zone = siteTimeZone(location);
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${text} (${zone})`;
}

/** Name shown for an Auth id with no profile any more. */
export const REMOVED_PERSON_LABEL = "Removed person";
export const NO_HOME_LABEL = "No home assigned";
