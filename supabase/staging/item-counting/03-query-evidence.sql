-- item-counting · Task 4 staging gate · step 3 of 3: index and query-plan evidence
--
-- STAGING ONLY. Read-only: everything runs inside a transaction that is
-- rolled back. Run after 02-volume.sql. Paste the full output into the
-- plan's Implementation log (or send it to the coder).
--
-- Each EXPLAIN runs as the signed-in owner test user with the
-- `authenticated` role, so the real RLS policies apply. The four query shapes
-- are the ones src/lib/repository/supabase/productionEvidence.ts sends:
--   Q1 in-window count events, first page and a mid-window keyset page
--   Q2 before-window verifications for a batch of order numbers
--   Q3 before-window parents for a batch of cancellation ids
--   Q4 later cancellations (parent_event_id not null) at/after window end
-- Window: AU production days 2026-08-01 .. 2026-10-31
--   = [2026-07-31T18:00Z, 2026-10-31T17:00Z), cutoff 2026-11-12T00:00Z.

begin;

-- 1. Index definitions and table size
select indexname, indexdef from pg_indexes
where schemaname = 'public' and tablename = 'production_events'
order by indexname;

select pg_size_pretty(pg_total_relation_size('public.production_events')) as total_size,
       (select count(*) from public.production_events) as rows;

analyze public.production_events;

-- 2. Become the owner test user (RLS on)
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users where email = 'owner@inka-staging.test'),
                    'role', 'authenticated')::text, true);
set local role authenticated;

-- Q1a: first page of the three-month window
explain (analyze, buffers)
select id, location, staff_id, department, order_number, line_sku, line_quantity,
       event_type, created_at, parent_event_id, cs_case_id
from public.production_events
where location = 'au'
  and event_type in ('line_verified', 'cancelled', 'completed', 'dispatched')
  and created_at >= '2026-07-31T18:00:00Z' and created_at < '2026-10-31T17:00:00Z'
  and created_at <= '2026-11-12T00:00:00Z'
order by created_at, id
limit 500;

-- Q1b: a keyset page in the middle of the window
explain (analyze, buffers)
select id, location, staff_id, department, order_number, line_sku, line_quantity,
       event_type, created_at, parent_event_id, cs_case_id
from public.production_events
where location = 'au'
  and event_type in ('line_verified', 'cancelled', 'completed', 'dispatched')
  and created_at >= '2026-07-31T18:00:00Z' and created_at < '2026-10-31T17:00:00Z'
  and created_at <= '2026-11-12T00:00:00Z'
  and (created_at > '2026-09-15T00:00:00Z'
       or (created_at = '2026-09-15T00:00:00Z' and id > 'vol-au-20260915-1-v1'))
order by created_at, id
limit 500;

-- Q1c: one production day (busy AU day 2026-09-15)
explain (analyze, buffers)
select id, location, staff_id, department, order_number, line_sku, line_quantity,
       event_type, created_at, parent_event_id, cs_case_id
from public.production_events
where location = 'au'
  and event_type in ('line_verified', 'cancelled', 'completed', 'dispatched')
  and created_at >= '2026-09-14T18:00:00Z' and created_at < '2026-09-15T18:00:00Z'
  and created_at <= '2026-11-12T00:00:00Z'
order by created_at, id
limit 500;

-- Q2: before-window verifications for 100 order numbers
explain (analyze, buffers)
select id, location, staff_id, department, order_number, line_sku, line_quantity,
       event_type, created_at, parent_event_id, cs_case_id
from public.production_events
where location = 'au'
  and event_type = 'line_verified'
  and created_at < '2026-07-31T18:00:00Z'
  and created_at <= '2026-11-12T00:00:00Z'
  and order_number = any (array(select format('VOL-AU-20260801-%s', g) from generate_series(1, 100) g))
order by created_at, id
limit 500;

-- Q3: before-window parents for 100 ids
explain (analyze, buffers)
select id, location, staff_id, department, order_number, line_sku, line_quantity,
       event_type, created_at, parent_event_id, cs_case_id
from public.production_events
where location = 'au'
  and created_at < '2026-07-31T18:00:00Z'
  and created_at <= '2026-11-12T00:00:00Z'
  and id = any (array(select format('vol-au-20260701-%s-v1', g) from generate_series(1, 100) g))
order by created_at, id
limit 500;

-- Q4: later cancellations at/after window end
explain (analyze, buffers)
select id, location, staff_id, department, order_number, line_sku, line_quantity,
       event_type, created_at, parent_event_id, cs_case_id
from public.production_events
where location = 'au'
  and event_type = 'cancelled'
  and parent_event_id is not null
  and created_at >= '2026-10-31T17:00:00Z'
  and created_at <= '2026-11-12T00:00:00Z'
order by created_at, id
limit 500;

rollback;
