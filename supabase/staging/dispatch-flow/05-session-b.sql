-- F7 dispatch flow: two-session race checks. SESSION B.
--
-- STAGING ONLY. See 05-session-a.sql for how to run. Steps run only when
-- session A says so.

-- ---------------------------------------------------------------------------
-- B0. Act as Kiosk B for the whole session.
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', 'f7800000-0000-4000-8000-0000000000d2', false),
       set_config('request.jwt.claims', '{"sub":"f7800000-0000-4000-8000-0000000000d2","role":"authenticated"}', false);

-- ===========================================================================
-- R1: a second device dispatches the same order. WAITS for A.
-- ===========================================================================
-- R1-B1:
SELECT public.scanner_commit_dispatch('f7race', 'f7810000-0000-4000-8000-000000000011', 'f7r-desk-2', 'S1',
  'f7800000-0000-4000-8000-000000000005', 'F78E0005', '10978001', now(), 2,
  '[{"sku":"INKA-ABC0001-A2-FB","quantity":2,"work_type":"framed"}]', '[{"code":"F7R-A2B","qty":2}]',
  '{"rule_set_id":"f7r-rs","rule_set_version":1,"resolved":true,"predicted":{"f7r-box":1},"target":{"f7r-box":1},"snapshot":{}}',
  '[]', 'f7800000-0000-4000-8000-0000000000d2')::text AS r1_b;
-- Expect after A commits: {"status": "already_recorded", "reason": "order already dispatched"}.

-- ===========================================================================
-- R2: classic framing of 10978002 by Framer 1, kept OPEN (holds the order lock).
-- ===========================================================================
-- R2-B1:
BEGIN;
INSERT INTO public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note)
VALUES ('f7race', 'f7rb-10978002-v', 'f7800000-0000-4000-8000-000000000001', 'framed', '10978002', 'INKA-ABC0001-A2-FB', 2, 'line_verified', 'classic', 'F7 race');
INSERT INTO public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note)
VALUES ('f7race', 'f7rb-10978002-c', 'f7800000-0000-4000-8000-000000000001', 'framed', '10978002', NULL, 2, 'completed', 'classic', 'F7 race');
-- Expect: INSERT 0 1 twice, at once.
-- >>> run R2-A1 in session A (it waits) <<<

-- R2-B2:
COMMIT;
-- >>> R2-A1 returns the "scan" attribution for Framer 1 <<<

-- ===========================================================================
-- R3: the retry of request ...03 with the identical payload. WAITS for A.
-- ===========================================================================
-- A retry comes from the SAME account (a second tab, or the same tab after a
-- lost response), so act as Kiosk A here.
SELECT set_config('request.jwt.claim.sub', 'f7800000-0000-4000-8000-0000000000d1', false),
       set_config('request.jwt.claims', '{"sub":"f7800000-0000-4000-8000-0000000000d1","role":"authenticated"}', false);
-- R3-B1:
SELECT public.scanner_commit_dispatch('f7race', 'f7810000-0000-4000-8000-000000000003', 'f7r-desk', 'S1',
  'f7800000-0000-4000-8000-000000000005', 'F78E0005', '10978003', '2026-11-22T05:00:00Z'::timestamptz, 2,
  '[{"sku":"INKA-ABC0001-A2-FB","quantity":2,"work_type":"framed"}]', '[{"code":"F7R-A2B","qty":2}]',
  '{"rule_set_id":"f7r-rs","rule_set_version":1,"resolved":true,"predicted":{"f7r-box":1},"target":{"f7r-box":1},"snapshot":{}}',
  '[]', 'f7800000-0000-4000-8000-0000000000d1') ->> 'replayed' AS r3_b_replayed;
-- Expect after A commits: true (the stored answer, nothing written twice).

-- R3-B2 (no wait): the same request id from ANOTHER account is refused.
SELECT set_config('request.jwt.claim.sub', 'f7800000-0000-4000-8000-0000000000d2', false),
       set_config('request.jwt.claims', '{"sub":"f7800000-0000-4000-8000-0000000000d2","role":"authenticated"}', false);
SELECT public.scanner_commit_dispatch('f7race', 'f7810000-0000-4000-8000-000000000003', 'f7r-desk', 'S1',
  'f7800000-0000-4000-8000-000000000005', 'F78E0005', '10978003', '2026-11-22T05:00:00Z'::timestamptz, 2,
  '[{"sku":"INKA-ABC0001-A2-FB","quantity":2,"work_type":"framed"}]', '[{"code":"F7R-A2B","qty":2}]',
  '{"rule_set_id":"f7r-rs","rule_set_version":1,"resolved":true,"predicted":{"f7r-box":1},"target":{"f7r-box":1},"snapshot":{}}',
  '[]', 'f7800000-0000-4000-8000-0000000000d2')::text AS r3_b2;
-- Expect: ERROR scanner: request_conflict.

-- ===========================================================================
-- R3b: the retry of request ...06 (same account as A). WAITS for A, which rolls back.
-- ===========================================================================
SELECT set_config('request.jwt.claim.sub', 'f7800000-0000-4000-8000-0000000000d1', false),
       set_config('request.jwt.claims', '{"sub":"f7800000-0000-4000-8000-0000000000d1","role":"authenticated"}', false);
-- R3b-B1:
SELECT public.scanner_commit_dispatch('f7race', 'f7810000-0000-4000-8000-000000000006', 'f7r-desk', 'S1',
  'f7800000-0000-4000-8000-000000000005', 'F78E0005', '10978006', '2026-11-22T05:00:00Z'::timestamptz, 2,
  '[{"sku":"INKA-ABC0001-A2-FB","quantity":2,"work_type":"framed"}]', '[{"code":"F7R-A2B","qty":2}]',
  '{"rule_set_id":"f7r-rs","rule_set_version":1,"resolved":true,"predicted":{"f7r-box":1},"target":{"f7r-box":1},"snapshot":{}}',
  '[]', 'f7800000-0000-4000-8000-0000000000d1')::text AS r3b_b;
-- Expect after A rolls back: status saved, no "replayed" key.

-- Back to Kiosk B.
SELECT set_config('request.jwt.claim.sub', 'f7800000-0000-4000-8000-0000000000d2', false),
       set_config('request.jwt.claims', '{"sub":"f7800000-0000-4000-8000-0000000000d2","role":"authenticated"}', false);

-- ===========================================================================
-- R4: the classic dispatch station dispatches and deducts 10978004; keep OPEN.
-- ===========================================================================
-- R4-B1:
BEGIN;
INSERT INTO public.production_events (location, id, staff_id, department, order_number, line_quantity, event_type, station_id, note)
VALUES ('f7race', 'f7rb-10978004-d', 'f7800000-0000-4000-8000-000000000005', 'dispatch', '10978004', 2, 'dispatched', 'classic', 'F7 race');
SELECT public.deduct_inventory_for_event('f7rb-10978004-d', '[{"code":"F7R-A2B","qty":2}]') ->> 'deducted' AS r4_b;
-- Expect: 1.
-- >>> run R4-A1 in session A (it waits) <<<

-- R4-B2:
COMMIT;
-- >>> R4-A1 returns already_recorded <<<

-- ===========================================================================
-- R5: a classic dispatch races the shared one A holds open.
-- ===========================================================================
-- R5-B1 (no wait: dispatch rows are not framing credit):
INSERT INTO public.production_events (location, id, staff_id, department, order_number, line_quantity, event_type, station_id, note)
VALUES ('f7race', 'f7rb-10978005-d', 'f7800000-0000-4000-8000-000000000005', 'dispatch', '10978005', 2, 'dispatched', 'classic', 'F7 race');
-- R5-B2: WAITS until A commits.
SELECT public.deduct_inventory_for_event('f7rb-10978005-d', '[{"code":"f7r-a2b","qty":2}]')::text AS r5_b;
-- Expect after A commits: "deducted": 0, "skipped_idempotent": 1.

-- ===========================================================================
-- R6: dispatch sign-in of the same person A is signing in for framing. WAITS.
-- ===========================================================================
-- R6-B1:
SELECT public.scanner_activate_dispatch('f7race', 'f7810000-0000-4000-8000-000000000008', 'f7r-desk', 'S2', 'F78E0002',
  'f7800000-0000-4000-8000-0000000000d2')::text AS r6_b;
-- Expect after A commits: activated, "clocked_in": false.
