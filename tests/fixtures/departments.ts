/**
 * Synthetic F5 fixtures. No real department names, people or assignments.
 * The same ids are used by the SQL scripts in supabase/staging/departments.
 */

export const DEPT_A = "f5000000-0000-4000-8000-00000000000a";
export const DEPT_B = "f5000000-0000-4000-8000-00000000000b";
export const PERSON_1 = "f5000000-0000-4000-8000-000000000001";
export const PERSON_2 = "f5000000-0000-4000-8000-000000000002";
export const OWNER_1 = "f5000000-0000-4000-8000-0000000000f1";
export const ASSIGN_A = "f5000000-0000-4000-8000-0000000000a1";
export const ASSIGN_B = "f5000000-0000-4000-8000-0000000000b1";
export const NAME_A1 = "f5000000-0000-4000-8000-0000000000c1";
export const REQUEST_1 = "f5000000-0000-4000-8000-0000000000e1";
export const REQUEST_2 = "f5000000-0000-4000-8000-0000000000e2";

/** Microseconds since the epoch for an ISO instant (whole milliseconds). */
export const us = (iso: string): bigint => BigInt(Date.parse(iso)) * 1000n;

export const SECOND_US = 1_000_000n;
export const MINUTE_US = 60n * SECOND_US;
export const HOUR_US = 60n * MINUTE_US;
export const DAY_US = 24n * HOUR_US;

/** Person 1: Department A until T, Department B from T. */
export const T = us("2026-11-22T10:00:00.000Z");
export const PERSON_1_INTERVALS = [
  { id: ASSIGN_A, fromUs: us("2026-11-20T00:00:00.000Z"), toUs: T },
  { id: ASSIGN_B, fromUs: T, toUs: null },
];

/**
 * What each place in Production.tsx sends today (main and the station
 * redesign): no F5 field at all. The database adds the snapshot.
 */
const base = { location: "au", staff_id: PERSON_1, department: "framed", station_id: null as string | null };

export const EVENT_INSERT_PAYLOADS: Record<string, Record<string, unknown>> = {
  // insertEvent(): started / completed / cancelled / dispatched / line_verified
  "insertEvent:started": { ...base, id: "evt_1", order_number: "10001", line_sku: "TEST-SKU-A1", line_quantity: 1, event_type: "started", note: "", created_at: "2026-11-22T09:00:00.000Z", cs_case_id: null, parent_event_id: null },
  "insertEvent:line_verified": { ...base, id: "evt_2", order_number: "10001", line_sku: "TEST-SKU-A1", line_quantity: 2, event_type: "line_verified", note: "", created_at: "2026-11-22T09:00:01.000Z", cs_case_id: null, parent_event_id: null },
  "insertEvent:completed": { ...base, id: "evt_3", order_number: "10001", line_sku: null, line_quantity: null, event_type: "completed", note: "", created_at: "2026-11-22T09:00:02.000Z", cs_case_id: "case-1", parent_event_id: null },
  // un-verify: a cancelled event pointing at the verified one
  "insertEvent:cancelled": { ...base, id: "evt_4", order_number: "10001", line_sku: "TEST-SKU-A1", line_quantity: 2, event_type: "cancelled", note: "un-verify", created_at: "2026-11-22T09:00:03.000Z", cs_case_id: null, parent_event_id: "evt_2" },
  "insertEvent:dispatched": { ...base, department: "dispatch", id: "evt_5", order_number: "10001", line_sku: null, line_quantity: null, event_type: "dispatched", note: "", created_at: "2026-11-22T09:00:04.000Z", cs_case_id: null, parent_event_id: null },
  // clock events: no order number and no created_at (the SQL default applies)
  "clock:clock_in": { location: "au", id: "evt_6", staff_id: PERSON_1, department: "framed", event_type: "clock_in", note: "Sign in via lanyard scan" },
  "clock:clock_out": { location: "au", id: "evt_7", staff_id: PERSON_1, department: "framed", event_type: "clock_out", note: "Sign out via lanyard scan" },
};

export const F5_SNAPSHOT_COLUMNS = [
  "business_department_id",
  "business_department_name",
  "business_department_assignment_id",
  "business_department_name_version_id",
  "business_department_status",
  "department_snapshot_version",
  "department_occurred_at",
  "department_received_at",
  "department_resolution_instant",
  "department_time_status",
  "department_resolved_at",
] as const;
