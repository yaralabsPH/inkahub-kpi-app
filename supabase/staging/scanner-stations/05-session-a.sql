-- F6 shared scanner stations: two-session race checks. SESSION A.
--
-- STAGING ONLY. Needs TWO database connections that can each keep a
-- transaction open (two psql windows; one-shot SQL tools cannot do this).
-- Open 05-session-b.sql in the other window.
--
-- Before: apply 0055, run 01-fixtures.sql. After: run 09-cleanup.sql.
--
-- Run ONE step at a time in the numbered order, switching windows when a
-- step says B. A step that "waits" is expected to hang until the other
-- session commits or rolls back: do not cancel it. No step sleeps; the
-- per-order and per-person advisory locks decide the order.
--
-- Request ids are fixed so every run is identical:
--   f6810000-0000-4000-8000-0000000000NN

-- ---------------------------------------------------------------------------
-- A0. Act as Kiosk A for the whole session.
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', 'f6800000-0000-4000-8000-0000000000d1', false),
       set_config('request.jwt.claims', '{"sub":"f6800000-0000-4000-8000-0000000000d1","role":"authenticated"}', false);

-- ===========================================================================
-- R1. Shared commit first; the classic deduction for the same order waits
--     and then charges nothing.
-- ===========================================================================
-- R1-A1: save A0 order 10968001 and keep the transaction OPEN.
BEGIN;
SELECT public.scanner_commit_framing('f6race', 'f6810000-0000-4000-8000-000000000001', 'f6r-wall', 'S1',
  'f6800000-0000-4000-8000-000000000001', 'F68E0001', '10968001', now(),
  '[{"sku":"INKA-ABC0001-A0-FB","quantity":2,"work_type":"a0_framed"}]', '[{"code":"F6R-A0B","qty":2}]',
  '{"rule_set_id":"f6r-rs","rule_set_version":1,"resolved":true,"predicted":{"f6r-box":1},"target":{"f6r-box":1},"snapshot":{}}') ->> 'status' AS r1_a;
-- Expect: saved.
-- >>> now run R1-B1 and R1-B2 in session B (R1-B2 waits) <<<

-- R1-A2:
COMMIT;
-- >>> R1-B2 in session B now returns; then run R1-B3 <<<

-- ===========================================================================
-- R2. Classic deduction first (holding the order lock); the shared commit
--     waits, then sees the classic completion and adds nothing.
-- ===========================================================================
-- >>> first run R2-B1 in session B <<<

-- R2-A1: waits until R2-B2 commits.
SELECT public.scanner_commit_framing('f6race', 'f6810000-0000-4000-8000-000000000002', 'f6r-wall', 'S1',
  'f6800000-0000-4000-8000-000000000001', 'F68E0001', '10968002', now(),
  '[{"sku":"INKA-ABC0001-A0-FB","quantity":2,"work_type":"a0_framed"}]', '[{"code":"F6R-A0B","qty":2}]',
  '{"rule_set_id":"f6r-rs","rule_set_version":1,"resolved":true,"predicted":{"f6r-box":1},"target":{"f6r-box":1},"snapshot":{}}')::text AS r2_a;
-- Expect (after B commits): {"status": "already_recorded", "reason": "a0_framed already completed"}.

-- ===========================================================================
-- R3. A lost-response retry races the original request.
-- ===========================================================================
-- R3-A1: the original; keep OPEN.
BEGIN;
SELECT public.scanner_commit_framing('f6race', 'f6810000-0000-4000-8000-000000000003', 'f6r-wall', 'S1',
  'f6800000-0000-4000-8000-000000000001', 'F68E0001', '10968003', '2026-11-22T05:00:00Z'::timestamptz,
  '[{"sku":"INKA-ABC0001-A0-FB","quantity":2,"work_type":"a0_framed"}]', '[{"code":"F6R-A0B","qty":2}]',
  '{"rule_set_id":"f6r-rs","rule_set_version":1,"resolved":true,"predicted":{"f6r-box":1},"target":{"f6r-box":1},"snapshot":{}}') ->> 'status' AS r3_a;
-- Expect: saved. (The fixed scan times in R3/R3b must be within the last
-- 14 days; if not, replace them in BOTH files with the same recent value.)
-- >>> run R3-B1 in session B (it waits) <<<

-- R3-A2:
COMMIT;
-- >>> R3-B1 returns: "replayed": true, same event ids <<<

-- ===========================================================================
-- R3b. The original rolls back: the retry then saves, exactly once.
-- ===========================================================================
-- R3b-A1: keep OPEN.
BEGIN;
SELECT public.scanner_commit_framing('f6race', 'f6810000-0000-4000-8000-000000000004', 'f6r-wall', 'S1',
  'f6800000-0000-4000-8000-000000000001', 'F68E0001', '10968004', '2026-11-22T06:00:00Z'::timestamptz,
  '[{"sku":"INKA-ABC0001-A0-FB","quantity":2,"work_type":"a0_framed"}]', '[{"code":"F6R-A0B","qty":2}]',
  '{"rule_set_id":"f6r-rs","rule_set_version":1,"resolved":true,"predicted":{"f6r-box":1},"target":{"f6r-box":1},"snapshot":{}}') ->> 'status' AS r3b_a;
-- Expect: saved.
-- >>> run R3b-B1 in session B (it waits) <<<

-- R3b-A2:
ROLLBACK;
-- >>> R3b-B1 returns saved, NOT replayed <<<

-- ===========================================================================
-- R4. Two scanners, two requests, the same order.
-- ===========================================================================
-- R4-A1: keep OPEN.
BEGIN;
SELECT public.scanner_commit_framing('f6race', 'f6810000-0000-4000-8000-000000000005', 'f6r-wall', 'S1',
  'f6800000-0000-4000-8000-000000000001', 'F68E0001', '10968005', now(),
  '[{"sku":"INKA-ABC0001-A0-FB","quantity":2,"work_type":"a0_framed"}]', '[{"code":"F6R-A0B","qty":2}]',
  '{"rule_set_id":"f6r-rs","rule_set_version":1,"resolved":true,"predicted":{"f6r-box":1},"target":{"f6r-box":1},"snapshot":{}}') ->> 'status' AS r4_a;
-- Expect: saved.
-- >>> run R4-B1 in session B (it waits) <<<

-- R4-A2:
COMMIT;
-- >>> R4-B1 returns already_recorded <<<

-- ===========================================================================
-- R5. One badge on two scanners at once: one clock-in.
-- ===========================================================================
-- R5-A1: keep OPEN.
BEGIN;
SELECT public.scanner_activate_badge('f6race', 'f6810000-0000-4000-8000-000000000007', 'f6r-wall', 'S1', 'F68E0002')::text AS r5_a;
-- Expect: activated, "clocked_in": true.
-- >>> run R5-B1 in session B (it waits) <<<

-- R5-A2:
COMMIT;
-- >>> R5-B1 returns activated, "clocked_in": false <<<

-- ===========================================================================
-- A-END. Totals (either session). Every line must say true.
-- ===========================================================================
SELECT
  (SELECT current_on_hand FROM public.products WHERE location = 'f6race' AND id = 'f6r-a0b') = 90 AS a0b_charged_once_per_order,
  (SELECT current_on_hand FROM public.products WHERE location = 'f6race' AND id = 'f6r-box') = 96 AS one_box_per_shared_save,
  (SELECT count(*) FROM public.ledger WHERE location = 'f6race' AND product_id = 'f6r-a0b') = 5 AS five_component_rows,
  (SELECT count(*) FROM public.scanner_requests WHERE location = 'f6race' AND kind = 'commit') = 4 AS four_receipts,
  (SELECT count(*) FROM public.production_events WHERE location = 'f6race' AND order_number = '10968004') = 2 AS r3b_saved_once,
  (SELECT count(*) FROM public.production_events WHERE location = 'f6race' AND order_number = '10968005'
     AND staff_id = 'f6800000-0000-4000-8000-000000000002') = 0 AS r4_no_credit_to_second_scanner,
  (SELECT count(*) FROM public.production_events WHERE location = 'f6race' AND event_type = 'clock_in'
     AND staff_id = 'f6800000-0000-4000-8000-000000000002') = 1 AS r5_one_clock_in,
  NOT EXISTS (SELECT 1 FROM public.production_events WHERE location = 'f6race' AND id LIKE 'scn-%'
     AND (business_department_status IS NULL OR business_department_status = 'resolver_unavailable')) AS f5_snapshot_resolved;
