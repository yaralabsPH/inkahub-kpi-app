-- F6 shared scanner stations: two-session race checks. SESSION B.
--
-- STAGING ONLY. See 05-session-a.sql for how to run. Steps run only when
-- session A says so.

-- ---------------------------------------------------------------------------
-- B0. Act as Kiosk B for the whole session.
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', 'f6800000-0000-4000-8000-0000000000d2', false),
       set_config('request.jwt.claims', '{"sub":"f6800000-0000-4000-8000-0000000000d2","role":"authenticated"}', false);

-- ===========================================================================
-- R1 (shared first)
-- ===========================================================================
-- R1-B1: the classic A0 station saves its completion (autocommit, no lock needed).
INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, station_id, note)
VALUES ('f6race', 'f6r-classic-1', 'f6800000-0000-4000-8000-000000000002', 'a0_framed', '10968001', 'completed', 'classic', 'F6 race');
-- Expect: INSERT 0 1 at once.

-- R1-B2: ...then deducts. WAITS until session A commits (R1-A2).
SELECT public.deduct_inventory_for_event('f6r-classic-1', '[{"code":"f6r-a0b","qty":2}]')::text AS r1_b;
-- Expect after A commits: "deducted": 0, "skipped_idempotent": 1 (the id alias of the
-- product the shared save already charged under its code).

-- R1-B3:
SELECT current_on_hand AS a0b_after_r1 FROM public.products WHERE location = 'f6race' AND id = 'f6r-a0b';
-- Expect: 98.

-- ===========================================================================
-- R2 (classic first)
-- ===========================================================================
-- R2-B1: classic completion + deduction, keep OPEN (holds the order lock).
BEGIN;
INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, station_id, note)
VALUES ('f6race', 'f6r-classic-2', 'f6800000-0000-4000-8000-000000000002', 'a0_framed', '10968002', 'completed', 'classic', 'F6 race');
SELECT public.deduct_inventory_for_event('f6r-classic-2', '[{"code":"F6R-A0B","qty":2}]') ->> 'deducted' AS r2_b;
-- Expect: 1.
-- >>> run R2-A1 in session A (it waits) <<<

-- R2-B2:
COMMIT;
-- >>> R2-A1 returns already_recorded <<<

-- ===========================================================================
-- R3: the retry of request ...03 with the identical payload. WAITS for A.
-- ===========================================================================
-- A retry comes from the SAME account (a second tab, or the same tab after
-- a lost response), so act as Kiosk A here.
SELECT set_config('request.jwt.claim.sub', 'f6800000-0000-4000-8000-0000000000d1', false),
       set_config('request.jwt.claims', '{"sub":"f6800000-0000-4000-8000-0000000000d1","role":"authenticated"}', false);
-- R3-B1:
SELECT public.scanner_commit_framing('f6race', 'f6810000-0000-4000-8000-000000000003', 'f6r-wall', 'S1',
  'f6800000-0000-4000-8000-000000000001', 'F68E0001', '10968003', '2026-11-22T05:00:00Z'::timestamptz,
  '[{"sku":"INKA-ABC0001-A0-FB","quantity":2,"work_type":"a0_framed"}]', '[{"code":"F6R-A0B","qty":2}]',
  '{"rule_set_id":"f6r-rs","rule_set_version":1,"resolved":true,"predicted":{"f6r-box":1},"target":{"f6r-box":1},"snapshot":{}}') ->> 'replayed' AS r3_b_replayed;
-- Expect after A commits: true (the stored answer, nothing written twice).

-- R3-B2 (no wait): the same request id from ANOTHER account is refused.
SELECT set_config('request.jwt.claim.sub', 'f6800000-0000-4000-8000-0000000000d2', false),
       set_config('request.jwt.claims', '{"sub":"f6800000-0000-4000-8000-0000000000d2","role":"authenticated"}', false);
SELECT public.scanner_commit_framing('f6race', 'f6810000-0000-4000-8000-000000000003', 'f6r-wall', 'S1',
  'f6800000-0000-4000-8000-000000000001', 'F68E0001', '10968003', '2026-11-22T05:00:00Z'::timestamptz,
  '[{"sku":"INKA-ABC0001-A0-FB","quantity":2,"work_type":"a0_framed"}]', '[{"code":"F6R-A0B","qty":2}]',
  '{"rule_set_id":"f6r-rs","rule_set_version":1,"resolved":true,"predicted":{"f6r-box":1},"target":{"f6r-box":1},"snapshot":{}}')::text AS r3_b_other_account;
-- Expect: ERROR scanner: request_conflict.
SELECT set_config('request.jwt.claim.sub', 'f6800000-0000-4000-8000-0000000000d1', false),
       set_config('request.jwt.claims', '{"sub":"f6800000-0000-4000-8000-0000000000d1","role":"authenticated"}', false);

-- ===========================================================================
-- R3b: retry of request ...04 as Kiosk A (still set above). WAITS for A.
-- ===========================================================================
-- R3b-B1:
SELECT public.scanner_commit_framing('f6race', 'f6810000-0000-4000-8000-000000000004', 'f6r-wall', 'S1',
  'f6800000-0000-4000-8000-000000000001', 'F68E0001', '10968004', '2026-11-22T06:00:00Z'::timestamptz,
  '[{"sku":"INKA-ABC0001-A0-FB","quantity":2,"work_type":"a0_framed"}]', '[{"code":"F6R-A0B","qty":2}]',
  '{"rule_set_id":"f6r-rs","rule_set_version":1,"resolved":true,"predicted":{"f6r-box":1},"target":{"f6r-box":1},"snapshot":{}}')::text AS r3b_b;
-- Expect after A rolls back: "status": "saved" with NO "replayed" key.

-- Back to Kiosk B for the rest.
SELECT set_config('request.jwt.claim.sub', 'f6800000-0000-4000-8000-0000000000d2', false),
       set_config('request.jwt.claims', '{"sub":"f6800000-0000-4000-8000-0000000000d2","role":"authenticated"}', false);

-- ===========================================================================
-- R4: a second scanner scans the same order for Person 2. WAITS for A.
-- ===========================================================================
-- R4-B1:
SELECT public.scanner_commit_framing('f6race', 'f6810000-0000-4000-8000-000000000006', 'f6r-wall', 'S2',
  'f6800000-0000-4000-8000-000000000002', 'F68E0002', '10968005', now(),
  '[{"sku":"INKA-ABC0001-A0-FB","quantity":2,"work_type":"a0_framed"}]', '[{"code":"F6R-A0B","qty":2}]',
  '{"rule_set_id":"f6r-rs","rule_set_version":1,"resolved":true,"predicted":{"f6r-box":1},"target":{"f6r-box":1},"snapshot":{}}')::text AS r4_b;
-- Expect after A commits: "status": "already_recorded".

-- ===========================================================================
-- R5: the same badge on a second scanner. WAITS for A.
-- ===========================================================================
-- R5-B1:
SELECT public.scanner_activate_badge('f6race', 'f6810000-0000-4000-8000-000000000008', 'f6r-wall', 'S2', 'F68E0002')::text AS r5_b;
-- Expect after A commits: activated, "clocked_in": false.

-- >>> now run A-END in session A <<<
