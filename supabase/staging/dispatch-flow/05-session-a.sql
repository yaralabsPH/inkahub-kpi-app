-- F7 dispatch flow: two-session race checks. SESSION A.
--
-- STAGING ONLY. Needs TWO database connections that can each keep a
-- transaction open (two psql windows; one-shot SQL tools cannot do this).
-- Open 05-session-b.sql in the other window.
--
-- Before: apply 0056, run 01-fixtures.sql. After: run 09-cleanup.sql.
--
-- Run ONE step at a time in the numbered order, switching windows when a
-- step says B. A step that "waits" is expected to hang until the other
-- session commits or rolls back: do not cancel it. No step sleeps; the
-- per-order and per-person advisory locks decide the order.
--
-- Request ids are fixed so every run is identical:
--   f7810000-0000-4000-8000-0000000000NN
-- Every dispatch below is the same small payload: one framed A2 line
-- (2 items), component F7R-A2B x2 and one Dispatch box.

-- ---------------------------------------------------------------------------
-- A0. Act as Kiosk A for the whole session.
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', 'f7800000-0000-4000-8000-0000000000d1', false),
       set_config('request.jwt.claims', '{"sub":"f7800000-0000-4000-8000-0000000000d1","role":"authenticated"}', false);

-- ===========================================================================
-- R1. Two devices dispatch the same order: one saves, the other waits and
--     then adds nothing. Stock and box charged once.
-- ===========================================================================
-- R1-A1: dispatch 10978001 and keep the transaction OPEN.
BEGIN;
SELECT public.scanner_commit_dispatch('f7race', 'f7810000-0000-4000-8000-000000000001', 'f7r-desk', 'S1',
  'f7800000-0000-4000-8000-000000000005', 'F78E0005', '10978001', now(), 2,
  '[{"sku":"INKA-ABC0001-A2-FB","quantity":2,"work_type":"framed"}]', '[{"code":"F7R-A2B","qty":2}]',
  '{"rule_set_id":"f7r-rs","rule_set_version":1,"resolved":true,"predicted":{"f7r-box":1},"target":{"f7r-box":1},"snapshot":{}}',
  '[]', 'f7800000-0000-4000-8000-0000000000d1') ->> 'status' AS r1_a;
-- Expect: saved.
-- >>> now run R1-B1 in session B (it waits) <<<

-- R1-A2:
COMMIT;
-- >>> R1-B1 returns already_recorded "order already dispatched" <<<

-- ===========================================================================
-- R2. Measured evidence arrives between the picker and the commit. Session
--     B's classic framing holds the order lock (the F6 c6 guard takes it on
--     every framing insert); this dispatch, sent with a MANUAL choice of
--     Framer 2, waits, then finds Framer 1's measured record and stores it
--     as source "scan".
-- ===========================================================================
-- >>> first run R2-B1 in session B <<<

-- R2-A1: waits until R2-B2 commits.
SELECT public.scanner_commit_dispatch('f7race', 'f7810000-0000-4000-8000-000000000002', 'f7r-desk', 'S1',
  'f7800000-0000-4000-8000-000000000005', 'F78E0005', '10978002', now(), 2,
  '[{"sku":"INKA-ABC0001-A2-FB","quantity":2,"work_type":"framed"}]', '[{"code":"F7R-A2B","qty":2}]',
  '{"rule_set_id":"f7r-rs","rule_set_version":1,"resolved":true,"predicted":{"f7r-box":1},"target":{"f7r-box":1},"snapshot":{}}',
  '[{"sku":"INKA-ABC0001-A2-FB","person_id":"f7800000-0000-4000-8000-000000000002"}]',
  'f7800000-0000-4000-8000-0000000000d1') -> 'attributions' AS r2_a;
-- Expect (after B commits): [{"sku": "INKA-ABC0001-A2-FB", "source": "scan",
--   "person_id": "f7800000-0000-4000-8000-000000000001", ...}]  (measured wins).

-- ===========================================================================
-- R3. A lost-response retry races the original request.
-- ===========================================================================
-- R3-A1: the original; keep OPEN.
BEGIN;
SELECT public.scanner_commit_dispatch('f7race', 'f7810000-0000-4000-8000-000000000003', 'f7r-desk', 'S1',
  'f7800000-0000-4000-8000-000000000005', 'F78E0005', '10978003', '2026-11-22T05:00:00Z'::timestamptz, 2,
  '[{"sku":"INKA-ABC0001-A2-FB","quantity":2,"work_type":"framed"}]', '[{"code":"F7R-A2B","qty":2}]',
  '{"rule_set_id":"f7r-rs","rule_set_version":1,"resolved":true,"predicted":{"f7r-box":1},"target":{"f7r-box":1},"snapshot":{}}',
  '[]', 'f7800000-0000-4000-8000-0000000000d1') ->> 'status' AS r3_a;
-- Expect: saved.  (If 2026-11-22T05:00Z is more than 14 days ago when you run
-- this, change it in BOTH sessions to a recent time; it must be identical.)
-- >>> run R3-B1 in session B (it waits) <<<

-- R3-A2:
COMMIT;
-- >>> R3-B1 returns replayed: true; then run R3-B2 <<<

-- ===========================================================================
-- R3b. The original rolls back (nothing saved); the waiting retry then saves once.
-- ===========================================================================
-- R3b-A1: keep OPEN.
BEGIN;
SELECT public.scanner_commit_dispatch('f7race', 'f7810000-0000-4000-8000-000000000006', 'f7r-desk', 'S1',
  'f7800000-0000-4000-8000-000000000005', 'F78E0005', '10978006', '2026-11-22T05:00:00Z'::timestamptz, 2,
  '[{"sku":"INKA-ABC0001-A2-FB","quantity":2,"work_type":"framed"}]', '[{"code":"F7R-A2B","qty":2}]',
  '{"rule_set_id":"f7r-rs","rule_set_version":1,"resolved":true,"predicted":{"f7r-box":1},"target":{"f7r-box":1},"snapshot":{}}',
  '[]', 'f7800000-0000-4000-8000-0000000000d1') ->> 'status' AS r3b_a;
-- Expect: saved (not yet committed).
-- >>> run R3b-B1 in session B (it waits) <<<

-- R3b-A2:
ROLLBACK;
-- >>> R3b-B1 returns saved (NOT replayed) <<<

-- ===========================================================================
-- R4. Classic dispatch deduction first (holding the order lock): the shared
--     dispatch waits, then sees the classic dispatched event and adds nothing.
-- ===========================================================================
-- >>> first run R4-B1 in session B <<<

-- R4-A1: waits until R4-B2 commits.
SELECT public.scanner_commit_dispatch('f7race', 'f7810000-0000-4000-8000-000000000004', 'f7r-desk', 'S1',
  'f7800000-0000-4000-8000-000000000005', 'F78E0005', '10978004', now(), 2,
  '[{"sku":"INKA-ABC0001-A2-FB","quantity":2,"work_type":"framed"}]', '[{"code":"F7R-A2B","qty":2}]',
  '{"rule_set_id":"f7r-rs","rule_set_version":1,"resolved":true,"predicted":{"f7r-box":1},"target":{"f7r-box":1},"snapshot":{}}',
  '[]', 'f7800000-0000-4000-8000-0000000000d1')::text AS r4_a;
-- Expect (after B commits): {"status": "already_recorded", "reason": "order already dispatched"}.

-- ===========================================================================
-- R5. Shared dispatch first; a classic dispatch deduction races it: it
--     waits for the order lock, then charges nothing again.
-- ===========================================================================
-- R5-A1: keep OPEN.
BEGIN;
SELECT public.scanner_commit_dispatch('f7race', 'f7810000-0000-4000-8000-000000000005', 'f7r-desk', 'S1',
  'f7800000-0000-4000-8000-000000000005', 'F78E0005', '10978005', now(), 2,
  '[{"sku":"INKA-ABC0001-A2-FB","quantity":2,"work_type":"framed"}]', '[{"code":"F7R-A2B","qty":2}]',
  '{"rule_set_id":"f7r-rs","rule_set_version":1,"resolved":true,"predicted":{"f7r-box":1},"target":{"f7r-box":1},"snapshot":{}}',
  '[]', 'f7800000-0000-4000-8000-0000000000d1') ->> 'status' AS r5_a;
-- Expect: saved.
-- >>> run R5-B1 and R5-B2 in session B (R5-B2 waits) <<<

-- R5-A2:
COMMIT;
-- >>> R5-B2 returns deducted 0, skipped_idempotent 1 <<<

-- ===========================================================================
-- R6. One person signed in by a framing scanner and a dispatch scanner at
--     once: one clock-in (the same per-person lock), never rewritten.
-- ===========================================================================
-- R6-A1: keep OPEN.
BEGIN;
SELECT public.scanner_activate_badge('f7race', 'f7810000-0000-4000-8000-000000000007', 'f7r-wall', 'S1', 'F78E0002',
  'f7800000-0000-4000-8000-0000000000d1')::text AS r6_a;
-- Expect: activated, "clocked_in": true.
-- >>> run R6-B1 in session B (it waits) <<<

-- R6-A2:
COMMIT;
-- >>> R6-B1 returns activated, "clocked_in": false <<<

-- ===========================================================================
-- A-END. Totals (either session). Every column must say true.
-- ===========================================================================
SELECT
  (SELECT current_on_hand FROM public.products WHERE location = 'f7race' AND id = 'f7r-a2b') = 88 AS a2_charged_once_per_order,
  (SELECT current_on_hand FROM public.products WHERE location = 'f7race' AND id = 'f7r-box') = 95 AS one_box_per_shared_dispatch,
  (SELECT count(*) FROM public.dispatch_requests WHERE location = 'f7race' AND kind = 'dispatch') = 5 AS five_dispatch_receipts,
  (SELECT count(*) FROM public.production_events WHERE location = 'f7race' AND order_number = '10978001' AND event_type = 'dispatched') = 1 AS r1_one_dispatch,
  (SELECT source FROM public.dispatch_framer_attributions WHERE location = 'f7race' AND order_number = '10978002') = 'scan' AS r2_measured_won,
  (SELECT person_id FROM public.dispatch_framer_attributions WHERE location = 'f7race' AND order_number = '10978002')
     = 'f7800000-0000-4000-8000-000000000001' AS r2_framer_1,
  (SELECT count(*) FROM public.production_events WHERE location = 'f7race' AND order_number = '10978003' AND event_type = 'dispatched') = 1 AS r3_saved_once,
  (SELECT count(*) FROM public.production_events WHERE location = 'f7race' AND order_number = '10978006' AND event_type = 'dispatched') = 1 AS r3b_saved_once,
  (SELECT count(*) FROM public.dispatch_framer_attributions WHERE location = 'f7race' AND order_number = '10978004') = 0 AS r4_no_shared_rows,
  (SELECT count(*) FROM public.ledger WHERE location = 'f7race' AND source_id LIKE 'prod:order_10978005:%') = 1 AS r5_one_component_row,
  (SELECT count(*) FROM public.production_events WHERE location = 'f7race' AND event_type = 'clock_in'
     AND staff_id = 'f7800000-0000-4000-8000-000000000002') = 1 AS r6_one_clock_in,
  NOT EXISTS (SELECT 1 FROM public.production_events WHERE location = 'f7race'
     AND event_type IN ('line_verified', 'completed', 'started') AND id NOT LIKE 'f7r-%' AND id NOT LIKE 'f7rb-%') AS no_framing_invented;
