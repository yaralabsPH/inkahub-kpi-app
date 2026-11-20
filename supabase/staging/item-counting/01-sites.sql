-- item-counting · Task 4 staging gate · step 1 of 3: synthetic AU/UK/US sites
--
-- STAGING ONLY (project ybrzhrgfrnvtcwymjdrq). CJ runs this in the staging
-- SQL editor. It is NOT a migration and must never run against production.
-- Safe to re-run: every insert skips rows that already exist.
--
-- Creates:
--   * locations au / uk / us (the existing `staging` location is kept)
--   * default settings rows for the three sites
--   * memberships per docs/plans/item-counting.md "Staging setup":
--       owner, kiosk          -> au, uk, us
--       manager, staff, cs    -> au only (denied-UK/US checks)
--   * worker barcodes for kiosk scanning
--   * one synthetic product per test SKU at each site
-- No real employees, customers or orders are used.

begin;

-- Guard: production has a `default` location and no `staging` location or
-- @inka-staging.test users. Refuse to continue anywhere else.
do $$
begin
  if not exists (select 1 from public.locations where key = 'staging')
     or exists (select 1 from public.locations where key = 'default')
     or (select count(*) from auth.users where email in (
           'owner@inka-staging.test', 'manager@inka-staging.test', 'staff@inka-staging.test',
           'kiosk@inka-staging.test', 'cs@inka-staging.test')) <> 5
  then
    raise exception 'Refusing to run: this database does not look like the staging project';
  end if;
end $$;

insert into public.locations (key, label) values
  ('au', 'AU (synthetic staging)'),
  ('uk', 'UK (synthetic staging)'),
  ('us', 'US (synthetic staging)')
on conflict do nothing;

insert into public.settings (location)
select key from public.locations where key in ('au', 'uk', 'us')
on conflict do nothing;

-- Memberships
insert into public.user_locations (user_id, location)
select u.id, s.site
from auth.users u
cross join (values ('au'), ('uk'), ('us')) s(site)
where u.email in ('owner@inka-staging.test', 'kiosk@inka-staging.test')
on conflict do nothing;

insert into public.user_locations (user_id, location)
select u.id, 'au'
from auth.users u
where u.email in ('manager@inka-staging.test', 'staff@inka-staging.test', 'cs@inka-staging.test')
on conflict do nothing;

-- Worker barcodes (scanned at the kiosk). Owner works at every site;
-- manager is the second worker identity (worker B) and staff the self-scope
-- worker, both at AU only.
insert into public.staff_barcodes (location, barcode, user_id, display_name)
select m.location,
       format('STG-%s-%s', upper(m.location), upper(split_part(u.email, '@', 1))),
       u.id,
       format('Test %s', initcap(split_part(u.email, '@', 1)))
from public.user_locations m
join auth.users u on u.id = m.user_id
where m.location in ('au', 'uk', 'us')
  and u.email in ('owner@inka-staging.test', 'manager@inka-staging.test', 'staff@inka-staging.test')
on conflict do nothing;

-- Synthetic products: one per test SKU at each site.
insert into public.products (location, id, code, size, supplier, product_type, notes)
select s.site, 'stg-ic-' || lower(p.code), p.code, p.size, 'Synthetic test supplier', p.product_type,
       'item-counting staging fixture: ' || p.note
from (values ('au'), ('uk'), ('us')) s(site)
cross join (values
  ('INKA-S2BON0064-A1-UN', 'A1', 'product',   'UN set of 2 -> 2 Items per unit'),
  ('INKA-S3WIL0049-A2-FN', 'A2', 'product',   'framed set of 3 -> 3 Items per unit'),
  ('INKA-KAN0566-A4-FB',   'A4', 'product',   'framed single -> 1 Item'),
  ('INKA-KAN0566-A4-UN',   'A4', 'product',   'UN single -> 1 Item'),
  ('INKA-PF0004-A0-PW',    'A0', 'product',   'frame only (PF) -> 1 Item'),
  ('INKA-S6GAL0001-GW-FB', 'GW', 'product',   'GW set of 6'),
  ('INKA-KAN0566-A2-SC',   'A2', 'product',   'canvas -> excluded'),
  ('INKA-AUX-HOOK',        '',   'consumable','accessory -> excluded'),
  ('INKA-AUXESP',          '',   'service',   'free print -> excluded'),
  ('INKA-GC0001-100',      '',   'service',   'gift card -> excluded')
) p(code, size, product_type, note)
on conflict do nothing;

-- Evidence for the plan's log
select 'locations' as what, string_agg(key, ', ' order by key) as detail from public.locations
union all
select 'membership ' || split_part(u.email, '@', 1), string_agg(m.location, ', ' order by m.location)
from public.user_locations m join auth.users u on u.id = m.user_id
where u.email like '%@inka-staging.test'
group by u.email
union all
select 'products per site', string_agg(location || '=' || n, ', ' order by location)
from (select location, count(*) n from public.products where id like 'stg-ic-%' group by location) x
union all
select 'barcodes', count(*)::text from public.staff_barcodes where barcode like 'STG-%';

commit;
