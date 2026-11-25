-- F5 departments: two-session concurrency checks. SESSION A.
--
-- STAGING ONLY. Needs TWO separate database connections that can each keep a
-- transaction open (two psql windows; the Supabase SQL editor and one-shot
-- "execute SQL" tools cannot do this). Open 05-session-b.sql in the other.
--
-- Before you start: apply 0052-0054, run 01-fixtures.sql (it prints the ids
-- used below; they are fixed, so nothing needs editing).
-- Afterwards: run 09-cleanup.sql.
--
-- How to use: run ONE step at a time, in the order A0, then for each
-- schedule the steps exactly as numbered (S1-A1, S1-B1, S1-A2, ...), switching
-- windows where the step name says B. Each step states what you must see.
-- A step that "waits" is expected to hang for the stated time: do not cancel
-- it. If you see anything else, stop and record it. No step uses a sleep to
-- "win" a race: the locks themselves decide the order.
--
-- Synthetic ids (from 01-fixtures.sql):
--   Owner 1   f5710000-0000-4000-8000-0000000000f1
--   Owner 2   f5710000-0000-4000-8000-0000000000f2
--   Kiosk     f5710000-0000-4000-8000-0000000000d2
--   Person 1  f5710000-0000-4000-8000-000000000001   (home: F5X Department A)
--   Person 2  f5710000-0000-4000-8000-000000000002   (no home)

-- ---------------------------------------------------------------------------
-- A0. Set-up (session A). Act as Owner 1 and make sure snapshots are ON.
--     Note the "was_enabled" value: step A-END puts the switch back.
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', 'f5710000-0000-4000-8000-0000000000f1', false),
       set_config('request.jwt.claims', '{"sub":"f5710000-0000-4000-8000-0000000000f1","role":"authenticated"}', false);

SELECT enabled AS was_enabled, version FROM public.department_snapshot_control;

-- Turn ON if it is off (a no-op receipt if it is already on).
SELECT public.department_set_snapshot_enabled(gen_random_uuid(), true,
         (SELECT version FROM public.department_snapshot_control), 'F5 two-session test: on');
-- Expect: outcome "applied" (or "noop" if it was already on).

-- ===========================================================================
-- S1. An owner change is in progress: a scan must NOT wait, and is saved as
--     "resolution_busy".
-- ===========================================================================
-- S1-A1 (session A): hold the admin lock, exactly as an in-flight change does.
BEGIN;
SELECT pg_advisory_xact_lock(494749, 5);
-- Expect: returns at once. Leave this transaction OPEN.

-- >>> now run S1-B1 in session B <<<

-- S1-A2 (session A): release.
ROLLBACK;

-- >>> now run S1-B2 in session B <<<

-- ===========================================================================
-- S2. A scan is in flight (holding the shared lock): an owner change waits at
--     most 2 seconds, fails with a retryable error, and the SAME request then
--     succeeds with an effective time AFTER the scan was received.
-- ===========================================================================
-- >>> first run S2-B1 in session B (it leaves an insert uncommitted) <<<

-- S2-A1 (session A): transfer Person 1 from A to B.
SELECT public.department_admin('assign', 'f5720000-0000-4000-8000-0000000000a2',
         (SELECT id FROM public.business_departments WHERE normalized_name = 'f5x department b'),
         'f5710000-0000-4000-8000-000000000001', NULL,
         (SELECT version FROM public.business_departments WHERE normalized_name = 'f5x department b'),
         (SELECT id FROM public.person_department_assignments
           WHERE person_id = 'f5710000-0000-4000-8000-000000000001' AND valid_to IS NULL),
         'F5 two-session test S2');
-- Expect: WAITS about 2 seconds, then
--         ERROR 55P03 "canceling statement due to lock timeout".
--         (Not a hang, and not success.)

-- >>> now run S2-B2 in session B (commit the scan) <<<

-- S2-A2 (session A): the SAME request id again. The expected current
-- assignment is still A's, because nothing was applied the first time.
SELECT public.department_admin('assign', 'f5720000-0000-4000-8000-0000000000a2',
         (SELECT id FROM public.business_departments WHERE normalized_name = 'f5x department b'),
         'f5710000-0000-4000-8000-000000000001', NULL,
         (SELECT version FROM public.business_departments WHERE normalized_name = 'f5x department b'),
         (SELECT id FROM public.person_department_assignments
           WHERE person_id = 'f5710000-0000-4000-8000-000000000001' AND valid_to IS NULL),
         'F5 two-session test S2');
-- Expect: outcome "applied".

-- S2-A3 (session A): the scan that was in flight keeps Department A, and the
-- transfer took effect after that scan was received.
SELECT e.id, e.business_department_status, e.business_department_name,
       e.department_received_at < a.valid_from AS transfer_is_after_the_scan,
       (SELECT count(*) FROM public.department_audit WHERE request_id = 'f5720000-0000-4000-8000-0000000000a2') AS audit_rows
  FROM public.production_events e,
       public.person_department_assignments a
 WHERE e.location = 'staging' AND e.id = 'f5x-hold-1'
   AND a.person_id = 'f5710000-0000-4000-8000-000000000001' AND a.valid_to IS NULL;
-- Expect one row: assigned | F5X Department A | transfer_is_after_the_scan = true | audit_rows = 1

-- ===========================================================================
-- S3. Two owners make the same move from the same starting point: exactly one
--     wins; the other is told to refresh. One audit row.
--     (Person 1 is now in B. Both owners try to move them back to A.)
-- ===========================================================================
-- S3-A1 (session A, Owner 1): start the move and keep the transaction open.
BEGIN;
SELECT public.department_admin('assign', 'f5720000-0000-4000-8000-0000000000a3',
         (SELECT id FROM public.business_departments WHERE normalized_name = 'f5x department a'),
         'f5710000-0000-4000-8000-000000000001', NULL,
         (SELECT version FROM public.business_departments WHERE normalized_name = 'f5x department a'),
         (SELECT id FROM public.person_department_assignments
           WHERE person_id = 'f5710000-0000-4000-8000-000000000001' AND valid_to IS NULL),
         'F5 two-session test S3 owner 1');
-- Expect: outcome "applied". Leave the transaction OPEN.

-- >>> now run S3-B1 in session B <<<

-- S3-A2 (session A): commit.
COMMIT;

-- >>> now run S3-B2 in session B <<<

-- S3-A3 (session A): exactly one of the two requests was applied.
SELECT (SELECT count(*) FROM public.department_audit
         WHERE request_id IN ('f5720000-0000-4000-8000-0000000000a3', 'f5720000-0000-4000-8000-0000000000b3')) AS audit_rows,
       (SELECT count(*) FROM public.person_department_assignments
         WHERE person_id = 'f5710000-0000-4000-8000-000000000001' AND valid_to IS NULL) AS open_assignments,
       (SELECT d.name FROM public.person_department_assignments a JOIN public.business_departments d ON d.id = a.department_id
         WHERE a.person_id = 'f5710000-0000-4000-8000-000000000001' AND a.valid_to IS NULL) AS home;
-- Expect: audit_rows = 1 | open_assignments = 1 | home = F5X Department A

-- ===========================================================================
-- S5. A person is being removed while an owner assigns them: the assignment
--     cannot slip in. (Person 2 has no home.)
-- ===========================================================================
-- S5-A1 (session A): remove Person 2's profile and keep the transaction open.
BEGIN;
DELETE FROM public.profiles WHERE user_id = 'f5710000-0000-4000-8000-000000000002';
-- Expect: DELETE 1. Leave the transaction OPEN.

-- >>> now run S5-B1 in session B <<<

-- S5-A2 (session A): commit the removal.
COMMIT;

-- >>> now run S5-B2 in session B <<<

-- S5-A3 (session A): the removed person has no assignment at all.
SELECT count(*) AS assignments_for_removed_person
  FROM public.person_department_assignments WHERE person_id = 'f5710000-0000-4000-8000-000000000002';
-- Expect: 0

-- ===========================================================================
-- S6. Even writes that bypass the functions cannot create two open homes: the
--     database constraint decides. (Operator inserts, on purpose.)
-- ===========================================================================
-- S6-A1 (session A): open a home for Person 2 directly and keep it uncommitted.
BEGIN;
INSERT INTO public.person_department_assignments (person_id, department_id, valid_from, valid_to, created_at, created_by, request_id)
VALUES ('f5710000-0000-4000-8000-000000000002',
        (SELECT id FROM public.business_departments WHERE normalized_name = 'f5x department a'),
        clock_timestamp(), NULL, clock_timestamp(), 'f5710000-0000-4000-8000-0000000000f1', gen_random_uuid());
-- Expect: INSERT 0 1. Leave the transaction OPEN.

-- >>> now run S6-B1 in session B (it will wait) <<<

-- S6-A2 (session A): commit. Session B's waiting insert must now FAIL.
COMMIT;

-- S6-A3 (session A): still exactly one open home; remove this operator-made row.
SELECT count(*) AS open_homes FROM public.person_department_assignments
 WHERE person_id = 'f5710000-0000-4000-8000-000000000002' AND valid_to IS NULL;
-- Expect: 1
DELETE FROM public.person_department_assignments WHERE person_id = 'f5710000-0000-4000-8000-000000000002';

-- ===========================================================================
-- S7. The same event id sent twice at once: one row, never two, never an update.
-- ===========================================================================
-- S7-A1 (session A): insert and keep the transaction open.
BEGIN;
INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, note, created_at)
VALUES ('staging', 'f5x-dup-1', 'f5710000-0000-4000-8000-000000000001', 'dispatch', 'F5X-1', 'completed', 'session A', clock_timestamp());
-- Expect: INSERT 0 1. Leave the transaction OPEN.

-- >>> now run S7-B1 in session B (it will wait) <<<

-- S7-A2 (session A): commit. Session B's waiting insert must now FAIL (23505).
COMMIT;

-- S7-A3 (session A): one row, the one session A wrote.
SELECT count(*) AS rows, min(note) AS note, min(business_department_status) AS status
  FROM public.production_events WHERE location = 'staging' AND id = 'f5x-dup-1';
-- Expect: 1 | session A | assigned

-- ===========================================================================
-- S8. Two scans at the same moment do not block each other.
-- ===========================================================================
-- S8-A1 (session A): insert and keep the transaction open.
BEGIN;
INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, note, created_at)
VALUES ('staging', 'f5x-par-1', 'f5710000-0000-4000-8000-000000000001', 'dispatch', 'F5X-1', 'completed', 'parallel A', clock_timestamp());

-- >>> now run S8-B1 in session B: it must return AT ONCE, not wait <<<

-- S8-A2 (session A): commit and check both.
COMMIT;
SELECT id, business_department_status, business_department_name
  FROM public.production_events WHERE location = 'staging' AND id IN ('f5x-par-1', 'f5x-par-2') ORDER BY id;
-- Expect two rows, both: assigned | F5X Department A

-- ===========================================================================
-- S9. (one session only) Outside READ COMMITTED the lookup could read stale
--     data, so it is refused rather than trusted.
-- ===========================================================================
-- S9-A1: a scan inside a REPEATABLE READ transaction is saved, with no department.
BEGIN ISOLATION LEVEL REPEATABLE READ;
INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, note, created_at)
VALUES ('staging', 'f5x-rr-1', 'f5710000-0000-4000-8000-000000000001', 'dispatch', 'F5X-1', 'completed', 'repeatable read', clock_timestamp());
COMMIT;
SELECT id, business_department_status, business_department_id IS NULL AS no_department
  FROM public.production_events WHERE location = 'staging' AND id = 'f5x-rr-1';
-- Expect: f5x-rr-1 | resolution_error | true

-- S9-A2: an owner change inside REPEATABLE READ is refused outright.
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT public.department_admin('create', gen_random_uuid(), NULL, NULL, 'F5X Should Not Exist', NULL, NULL, '');
-- Expect: ERROR 25001 "department changes need READ COMMITTED isolation"
ROLLBACK;

-- ---------------------------------------------------------------------------
-- A-END. Put the switch back the way A0 found it. If "was_enabled" in A0 was
--        false, run this; if it was true, skip it.
-- ---------------------------------------------------------------------------
SELECT public.department_set_snapshot_enabled(gen_random_uuid(), false,
         (SELECT version FROM public.department_snapshot_control), 'F5 two-session test: restore off');

SELECT enabled, version FROM public.department_snapshot_control;
-- Then run 09-cleanup.sql.

-- NOT covered by this script (still pending, do not record as passed):
--   * a transfer that commits in the instant between a scan's receipt and its
--     lookup. That window cannot be held open from outside without changing
--     the resolver function. What it must do (use the earlier interval) is
--     proved for delayed events in 02-assertions.sql cases G18-G21 and G33.
