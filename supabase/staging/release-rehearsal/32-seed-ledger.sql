-- STAGING ONLY. ledger in live's aggregate shape (2026-11-24).
with spec(loc, reason, n, nprod, mn) as (values
 ('au','sale',31853,28,'2026-05-17'),('default','sale',1382,20,'2026-05-13'),('us','sale',1220,19,'2026-09-23'),
 ('au','shipment',272,41,'2026-05-18'),('au','manual',237,48,'2026-05-19'),('au','usage',106,24,'2026-05-31'),
 ('default','manual',44,42,'2026-05-13'),('au','stocktake',7,7,'2026-05-13'),('au','initial',5,5,'2026-05-15'),
 ('default','bom',4,3,'2026-05-13'),('au','transfer',1,1,'2026-06-29'),('default','stocktake',1,1,'2026-05-13')),
prods as (select location, id, row_number() over (partition by location order by id) rn, count(*) over (partition by location) cnt from public.products)
insert into public.ledger(location, id, ts, product_id, delta, reason, source_id, parent_event_id, note)
select s.loc, 'led-syn-'||s.loc||'-'||s.reason||'-'||g,
  s.mn::timestamptz + (('2026-11-24'::date - s.mn::date) * interval '1 day') * ((g*0.7548776662) - floor(g*0.7548776662)),
  pr.id, case when s.reason in ('sale','usage','bom') then -1 else 5 end, s.reason,
  case when s.reason = 'sale' then 'prod:order_'||((case s.loc when 'au' then 10000000 when 'us' then 20000000 else 30000000 end) + g)::text||':'||pr.id
       else 'syn:'||s.reason||':'||g end,
  case when s.reason in ('sale','shipment','bom') then 'syn-parent-'||g end,
  'synthetic'
from spec s cross join lateral generate_series(1, s.n) g
join prods pr on pr.location = s.loc and pr.rn = 1 + (g % least(s.nprod, pr.cnt));
