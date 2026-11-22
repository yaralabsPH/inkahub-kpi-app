-- F5 departments: two-session concurrency checks. SESSION B.
--
-- STAGING ONLY. Read the header of 05-session-a.sql first. Run each step only
-- when session A's script tells you to.

-- ---------------------------------------------------------------------------
-- B0. Set-up (session B). Act as Owner 2.
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', 'f5710000-0000-4000-8000-0000000000f2', false),
       set_config('request.jwt.claims', '{"sub":"f5710000-0000-4000-8000-0000000000f2","role":"authenticated"}', false);

-- ===========================================================================
-- S1
-- ===========================================================================
-- S1-B1 (while session A holds the admin lock): record a scan for Person 1.
INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, note, created_at)
VALUES ('staging', 'f5x-busy-1', 'f5710000-0000-4000-8000-000000000001', 'dispatch', 'F5X-1', 'completed', 'while admin lock held', clock_timestamp());
-- Expect: INSERT 0 1 AT ONCE (it must not wait for session A).
SELECT id, business_department_status, business_department_id IS NULL AS no_department, department_time_status
  FROM public.production_events WHERE location = 'staging' AND id = 'f5x-busy-1';
-- Expect: f5x-busy-1 | resolution_busy | true | reported

-- S1-B2 (after session A released the lock): the next scan is attributed normally.
INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, note, created_at)
VALUES ('staging', 'f5x-busy-2', 'f5710000-0000-4000-8000-000000000001', 'dispatch', 'F5X-1', 'completed', 'after release', clock_timestamp());
SELECT id, business_department_status, business_department_name
  FROM public.production_events WHERE location = 'staging' AND id IN ('f5x-busy-1', 'f5x-busy-2') ORDER BY id;
-- Expect: f5x-busy-1 | resolution_busy | (null)      <- not repaired afterwards
--         f5x-busy-2 | assigned        | F5X Department A

-- ===========================================================================
-- S2
-- ===========================================================================
-- S2-B1: a scan in flight. Insert and keep the transaction OPEN.
BEGIN;
INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, note, created_at)
VALUES ('staging', 'f5x-hold-1', 'f5710000-0000-4000-8000-000000000001', 'dispatch', 'F5X-1', 'completed', 'in flight', clock_timestamp());
-- Expect: INSERT 0 1. Leave the transaction OPEN.

-- >>> now run S2-A1 in session A (it waits ~2 s and fails with 55P03) <<<

-- S2-B2: commit the scan.
COMMIT;

-- >>> now run S2-A2 and S2-A3 in session A <<<

-- ===========================================================================
-- S3
-- ===========================================================================
-- S3-B1 (while session A's move is uncommitted): Owner 2 makes the same move
-- from the same starting point (Person 1's open assignment, which is still
-- B's as far as this session can see).
SELECT public.department_admin('assign', 'f5720000-0000-4000-8000-0000000000b3',
         (SELECT id FROM public.business_departments WHERE normalized_name = 'f5x department a'),
         'f5710000-0000-4000-8000-000000000001', NULL,
         (SELECT version FROM public.business_departments WHERE normalized_name = 'f5x department a'),
         (SELECT id FROM public.person_department_assignments
           WHERE person_id = 'f5710000-0000-4000-8000-000000000001' AND valid_to IS NULL),
         'F5 two-session test S3 owner 2');
-- Expect: WAITS about 2 seconds, then ERROR 55P03 (lock timeout).
-- WRITE DOWN the assignment id this session saw as current, for S3-B2:
SELECT id AS stale_assignment_id FROM public.person_department_assignments
 WHERE person_id = 'f5710000-0000-4000-8000-000000000001' AND valid_to IS NULL;

-- >>> now run S3-A2 in session A (commit) <<<

-- S3-B2: retry the SAME request with the SAME (now stale) expected assignment.
-- Replace <stale_assignment_id> with the id written down in S3-B1.
SELECT public.department_admin('assign', 'f5720000-0000-4000-8000-0000000000b3',
         (SELECT id FROM public.business_departments WHERE normalized_name = 'f5x department a'),
         'f5710000-0000-4000-8000-000000000001', NULL,
         (SELECT version FROM public.business_departments WHERE normalized_name = 'f5x department a'),
         '<stale_assignment_id>'::uuid,
         'F5 two-session test S3 owner 2');
-- Expect: ERROR 40001 "assignment_changed" (refresh required). Nothing applied.

-- >>> now run S3-A3 in session A <<<

-- ===========================================================================
-- S5
-- ===========================================================================
-- S5-B1 (while session A's removal of Person 2 is uncommitted): assign Person 2.
SELECT public.department_admin('assign', 'f5720000-0000-4000-8000-0000000000b5',
         (SELECT id FROM public.business_departments WHERE normalized_name = 'f5x department a'),
         'f5710000-0000-4000-8000-000000000002', NULL,
         (SELECT version FROM public.business_departments WHERE normalized_name = 'f5x department a'),
         NULL, 'F5 two-session test S5');
-- Expect: WAITS about 2 seconds, then ERROR 55P03 (lock timeout).

-- >>> now run S5-A2 in session A (commit the removal) <<<

-- S5-B2: the SAME request again.
SELECT public.department_admin('assign', 'f5720000-0000-4000-8000-0000000000b5',
         (SELECT id FROM public.business_departments WHERE normalized_name = 'f5x department a'),
         'f5710000-0000-4000-8000-000000000002', NULL,
         (SELECT version FROM public.business_departments WHERE normalized_name = 'f5x department a'),
         NULL, 'F5 two-session test S5');
-- Expect: ERROR 22023 "person_not_on_team". Nothing applied.

-- >>> now run S5-A3 in session A <<<

-- ===========================================================================
-- S6
-- ===========================================================================
-- S6-B1 (while session A's direct insert is uncommitted): a second open home.
INSERT INTO public.person_department_assignments (person_id, department_id, valid_from, valid_to, created_at, created_by, request_id)
VALUES ('f5710000-0000-4000-8000-000000000002',
        (SELECT id FROM public.business_departments WHERE normalized_name = 'f5x department b'),
        clock_timestamp(), NULL, clock_timestamp(), 'f5710000-0000-4000-8000-0000000000f2', gen_random_uuid());
-- Expect: WAITS until session A commits (S6-A2), then
--         ERROR 23505 (person_department_assignments_one_open) or
--         ERROR 23P01 (person_department_assignments_no_overlap).
--         It must NOT succeed.

-- ===========================================================================
-- S7
-- ===========================================================================
-- S7-B1 (while session A's insert of the same id is uncommitted):
INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, note, created_at)
VALUES ('staging', 'f5x-dup-1', 'f5710000-0000-4000-8000-000000000001', 'dispatch', 'F5X-1', 'completed', 'session B', clock_timestamp());
-- Expect: WAITS until session A commits (S7-A2), then
--         ERROR 23505 duplicate key (production_events_pkey). It must NOT succeed.

-- ===========================================================================
-- S8
-- ===========================================================================
-- S8-B1 (while session A's insert is uncommitted): another scan, different id.
INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, note, created_at)
VALUES ('staging', 'f5x-par-2', 'f5710000-0000-4000-8000-000000000001', 'dispatch', 'F5X-1', 'completed', 'parallel B', clock_timestamp());
-- Expect: INSERT 0 1 AT ONCE. Two scans never wait for each other.

-- >>> now run S8-A2 in session A <<<
