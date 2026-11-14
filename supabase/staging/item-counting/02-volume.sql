-- item-counting · Task 4 staging gate · step 2 of 3: synthetic volume history
--
-- STAGING ONLY (project ybrzhrgfrnvtcwymjdrq). Run 01-sites.sql first.
-- NOT a migration. Never run against production.
--
-- Deterministic (no random()): re-running inserts nothing new.
-- Two years (2024-11-01 .. 2026-10-31) at AU, UK and US:
--   * baseline 20 orders per production day per site
--   * AU "busy quarter" 2026-08-01 .. 2026-10-31 at 450 orders per day,
--     so the AU three-month read is > 100,000 count rows and a busy AU day
--     is > 1,000 rows
-- Expect roughly 240,000 count events plus ~4,400 clock rows in total.
--
-- Shapes included on purpose (by order sequence number):
--   seq % 2  = 0  second line on the order
--   seq % 10 = 0  both verifications share one timestamp (tied keyset)
--   seq % 11 = 0  second line is a gift card (mixed order)
--   seq % 13 = 0  verification only, never completed
--   seq % 3  = 0  also dispatched
--   seq % 17 = 0  worker B cancels worker A's first line
--   seq % 34 = 0  ... and the cancellation is duplicated
--   seq % 19 = 0  rework: every event tagged with a synthetic CS case id
--   seq % 29 = 0  the completion itself is reversed
--   seq % 40 = 0  order number contains quotes, comma and parentheses
--   seq % 50 = 0  verified the previous production day (context before window)
--   seq % 53 = 0  null line quantity (legal legacy detail)
--   seq % 97 = 0  first line cancelled 40 days later (distant correction)
-- Every synthetic row has id prefix 'vol-' and note 'item-counting synthetic volume'.
-- Rows are inserted as the SQL editor role, so no inventory deduction runs.
--
-- If the SQL editor times out, edit the `sites` list to run one site at a time.

begin;

do $$
begin
  if not exists (select 1 from public.locations where key = 'staging')
     or exists (select 1 from public.locations where key = 'default')
     or (select count(*) from public.locations where key in ('au', 'uk', 'us')) <> 3
  then
    raise exception 'Refusing to run: not staging, or 01-sites.sql has not been run';
  end if;
end $$;

insert into public.production_events
  (location, id, staff_id, department, order_number, line_sku, line_quantity,
   event_type, station_id, note, created_at, cs_case_id, parent_event_id)
with
sites(site, tz) as (values
  ('au', 'Australia/Sydney'),
  ('uk', 'Europe/London'),
  ('us', 'America/Chicago')
),
who as (
  select
    (select id from auth.users where email = 'owner@inka-staging.test')   as owner_id,
    (select id from auth.users where email = 'manager@inka-staging.test') as manager_id,
    (select id from auth.users where email = 'staff@inka-staging.test')   as staff_id
),
days as (
  select s.site, s.tz, d::date as day,
         case when s.site = 'au' and d >= date '2026-08-01' then 450 else 20 end as n
  from sites s
  cross join generate_series(date '2024-11-01', date '2026-10-31', interval '1 day') d
),
o as (
  select
    dy.site, dy.day, g.seq,
    format('vol-%s-%s-%s-', dy.site, to_char(dy.day, 'YYYYMMDD'), g.seq) as pfx,
    case when g.seq % 40 = 0
      then format('VOL-%s-%s-%s "q,(x)"', upper(dy.site), to_char(dy.day, 'YYYYMMDD'), g.seq)
      else format('VOL-%s-%s-%s', upper(dy.site), to_char(dy.day, 'YYYYMMDD'), g.seq)
    end as ord,
    -- spread orders over 20 hours from 04:00 site-local
    ((dy.day + time '04:00') at time zone dy.tz)
      + make_interval(secs => (g.seq - 1) * (72000 / dy.n)) as base,
    (array['a0_framed', 'framed', 'unframed'])[1 + g.seq % 3] as wt,
    case when dy.site = 'au' and g.seq % 5 = 0 then w.staff_id
         when g.seq % 4 = 0 then w.manager_id
         else w.owner_id end as worker,
    case when g.seq % 4 = 0 then w.owner_id else w.manager_id end as other_worker,
    (array['INKA-S2BON0064-A1-UN', 'INKA-S3WIL0049-A2-FN', 'INKA-KAN0566-A4-FB',
           'INKA-KAN0566-A4-UN', 'INKA-PF0004-A0-PW', 'INKA-S6GAL0001-GW-FB',
           'INKA-KAN0566-A2-SC'])[1 + g.seq % 7] as sku1,
    case when g.seq % 11 = 0 then 'INKA-GC0001-100'
         when g.seq % 11 = 1 then 'INKA-AUXESP'
         else 'INKA-KAN0566-A4-UN' end as sku2,
    case when g.seq % 53 = 0 then null else 1 + g.seq % 3 end as q1,
    1 + (g.seq / 3) % 2 as q2,
    case when g.seq % 19 = 0 then format('vol-case-%s-%s-%s', dy.site, to_char(dy.day, 'YYYYMMDD'), g.seq) end as case_id
  from days dy
  cross join lateral generate_series(1, dy.n) g(seq)
  cross join who w
),
t as (
  select o.*,
    o.base - case when o.seq % 50 = 0 then interval '1 day' else interval '0' end as v1_ts,
    nullif(coalesce(o.q1, 0) + case when o.seq % 2 = 0 then o.q2 else 0 end, 0) as total_qty
  from o
)
select t.site, e.id, e.staff, e.dept, t.ord, e.sku, e.qty, e.typ, null,
       'item-counting synthetic volume', e.ts, t.case_id, e.parent
from t
cross join lateral (values
  -- id                 staff           dept        sku     qty          type             ts                                         parent           keep
  (t.pfx || 'v1',  t.worker,       t.wt,       t.sku1, t.q1,        'line_verified', t.v1_ts,                                   null::text,      true),
  (t.pfx || 'v2',  t.worker,       t.wt,       t.sku2, t.q2,        'line_verified',
     case when t.seq % 10 = 0 then t.v1_ts else t.v1_ts + interval '30 seconds' end,      null,            t.seq % 2 = 0),
  (t.pfx || 'x1',  t.other_worker, t.wt,       t.sku1, t.q1,        'cancelled',     t.base + interval '2 minutes',             t.pfx || 'v1',   t.seq % 17 = 0),
  (t.pfx || 'x1b', t.other_worker, t.wt,       t.sku1, t.q1,        'cancelled',     t.base + interval '3 minutes',             t.pfx || 'v1',   t.seq % 34 = 0),
  (t.pfx || 'c',   t.worker,       t.wt,       null,   t.total_qty, 'completed',     t.base + interval '5 minutes',             null,            t.seq % 13 <> 0),
  (t.pfx || 'xc',  t.worker,       t.wt,       null,   t.total_qty, 'cancelled',     t.base + interval '7 minutes',             t.pfx || 'c',    t.seq % 13 <> 0 and t.seq % 29 = 0),
  (t.pfx || 'd',   t.worker,       'dispatch', null,   t.total_qty, 'dispatched',    t.base + interval '10 minutes',            null,            t.seq % 13 <> 0 and t.seq % 3 = 0),
  (t.pfx || 'xl',  t.other_worker, t.wt,       t.sku1, t.q1,        'cancelled',     t.base + interval '40 days',               t.pfx || 'v1',
     t.seq % 97 = 0 and t.day + 40 <= date '2026-10-31')
) e(id, staff, dept, sku, qty, typ, ts, parent, keep)
where e.keep
on conflict do nothing;

-- Clock rows (ignored by counting; present so reads must skip them).
insert into public.production_events
  (location, id, staff_id, department, order_number, line_sku, line_quantity,
   event_type, station_id, note, created_at, cs_case_id, parent_event_id)
select s.site, format('vol-%s-%s-%s', s.site, to_char(d, 'YYYYMMDD'), k.typ),
       (select id from auth.users where email = 'owner@inka-staging.test'),
       'framed', null, null, null, k.typ, null, 'item-counting synthetic volume',
       ((d::date + k.at) at time zone s.tz), null, null
from (values ('au', 'Australia/Sydney'), ('uk', 'Europe/London'), ('us', 'America/Chicago')) s(site, tz)
cross join generate_series(date '2024-11-01', date '2026-10-31', interval '1 day') d
cross join (values ('clock_in', time '04:30'), ('clock_out', time '23:30')) k(typ, at)
on conflict do nothing;

-- Evidence for the plan's log
select 'total synthetic rows' as what, count(*)::text as detail
from public.production_events where id like 'vol-%'
union all
select 'rows at ' || location, count(*)::text
from public.production_events where id like 'vol-%' group by location
union all
select 'AU count rows 2026-08-01..2026-10-31 (production days)', count(*)::text
from public.production_events
where location = 'au' and event_type in ('line_verified', 'cancelled', 'completed', 'dispatched')
  and created_at >= timestamptz '2026-07-31 18:00+00' and created_at < timestamptz '2026-10-31 17:00+00'
union all
select 'AU count rows on production day 2026-09-15', count(*)::text
from public.production_events
where location = 'au' and event_type in ('line_verified', 'cancelled', 'completed', 'dispatched')
  and created_at >= timestamptz '2026-09-14 18:00+00' and created_at < timestamptz '2026-09-15 18:00+00'
union all
select 'tied timestamps (groups)', count(*)::text
from (select location, created_at from public.production_events where id like 'vol-%'
      group by location, created_at having count(*) > 1) x;

commit;
