-- STAGING ONLY (inka-staging-2). Synthetic, sanitised data sized like live (2026-11-24).
-- No live rows are copied; shapes come from aggregate counts only.
insert into public.locations(key,label) values ('au','Australia'),('uk','United Kingdom'),('us','United States'),('default','Default');
insert into public.settings(location) select key from public.locations;

-- 49 synthetic auth users (no password, cannot sign in) + the 5 existing test logins
-- Token columns must be '' not NULL, or GoTrue fails every lookup of these users ("Database error finding user").
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, email_confirmed_at,
                        confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current,
                        phone_change, phone_change_token, reauthentication_token)
select '00000000-0000-0000-0000-000000000000'::uuid, ('5e000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid, 'authenticated','authenticated',
       'synthetic-'||g||'@inka-staging.test', now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(),
       '', '', '', '', '', '', '', ''
from generate_series(1,49) g
on conflict (id) do nothing;

insert into public.profiles(user_id, display_name, role)
select u.id, initcap(split_part(u.email,'@',1)), split_part(u.email,'@',1) from auth.users u where u.email in
  ('owner@inka-staging.test','manager@inka-staging.test','staff@inka-staging.test','kiosk@inka-staging.test','cs@inka-staging.test');
insert into public.profiles(user_id, display_name, role)
select ('5e000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid, 'Synthetic '||g,
       case when g<=2 then 'owner' when g<=4 then 'manager' when g<=5 then 'cs' else 'staff' end
from generate_series(1,49) g;

insert into public.user_locations(user_id, location)
select p.user_id, l from public.profiles p cross join unnest(array['au','uk','us']) l where p.display_name not like 'Synthetic %';
insert into public.user_locations(user_id, location)
select ('5e000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid, case when g<=30 then 'au' when g<=40 then 'us' else 'default' end from generate_series(1,49) g;
insert into public.user_locations(user_id, location)
select ('5e000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid, l from generate_series(1,5) g cross join unnest(array['au','uk','us','default']) l
on conflict do nothing;

-- staff badges: the two known test badges plus synthetic ones
insert into public.staff_barcodes(location, barcode, user_id, display_name)
select 'au', 'A1B2C3D4', id, 'Staff' from auth.users where email='staff@inka-staging.test'
union all select 'au', 'B2C3D4E5', id, 'Manager' from auth.users where email='manager@inka-staging.test';
insert into public.staff_barcodes(location, barcode, user_id, display_name, active)
select case when g<=30 then 'au' when g<=40 then 'us' else 'default' end, upper(substr(md5('badge'||g),1,8)),
       ('5e000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid, 'Synthetic '||g, g % 13 <> 0
from generate_series(1,49) g;

-- products: frame stock codes that the deduction uses (A0-A4 x colour) + synthetic products/consumables/packaging
insert into public.products(location, id, code, size, colour, product_type, supplier, current_on_hand)
select 'au', 'frame-'||s||'-'||c, s||'-'||c, s, c, 'product', 'CHINA', 500
from unnest(array['A0','A1','A2','A3','A4']) s cross join unnest(array['Natural','Black','White']) c;
insert into public.products(location, id, code, product_type, supplier, current_on_hand)
select 'au', 'syn-au-'||g, 'SYN-AU-'||lpad(g::text,3,'0'),
       case when g<=15 then 'product' when g<=44 then 'consumable' else 'packaging' end, 'LOCAL', 200
from generate_series(1,50) g;
insert into public.products(location, id, code, size, colour, product_type, supplier, current_on_hand)
select l, 'frame-'||s||'-'||c, s||'-'||c, s, c, 'product', 'CHINA', 300
from unnest(array['uk','us','default']) l cross join unnest(array['A0','A1','A2','A3','A4']) s cross join unnest(array['Natural','Black','White']) c;
insert into public.products(location, id, code, product_type, supplier, current_on_hand)
select l, 'syn-'||l||'-'||g, 'SYN-'||upper(l)||'-'||lpad(g::text,3,'0'), 'product', 'LOCAL', 100
from unnest(array['uk','us','default']) l cross join generate_series(1,33) g;
update public.products set components = jsonb_build_array(jsonb_build_object('child_product_id','syn-au-20','qty_per_unit',1))
 where location='au' and id in ('syn-au-1','syn-au-2','syn-au-3');

insert into public.production_size_effort(location,size,effort_score)
select l, v.s, v.e from unnest(array['au','uk','us','default']) l cross join (values ('A0',2.5),('A1',1.5),('A2',1.0),('A3',0.7),('A4',0.5)) v(s,e);
insert into public.staff_rates(location,user_id,hourly_rate)
select 'au', ('5e000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid, 25 + g from generate_series(6,20) g;

insert into public.bays(location,id,label,"row","column",max_pallets)
select 'au','bay-'||g,'Bay '||g, g/20, g%20, 2 from generate_series(1,328) g;
insert into public.weekly_entries(location, department, iso_week_start, total_orders)
select l, d, date '2024-06-03' + 7*g, 100+g
from unnest(array['au','us']) l cross join unnest(array['framed','unframed']) d cross join generate_series(0,61) g;
insert into public.weekly_sales(location, product_id, iso_week_start, units_sold)
select 'au', p.id, date '2025-01-06' + 7*g, (g*7+length(p.id))%40
from public.products p cross join generate_series(0,200) g where p.location='au' limit 3410;
insert into public.shipments(location,id,po_number,supplier,order_placed_date,expected_arrival_date,status,lines,inventory_applied_at)
select 'au','shp-'||g,'PO-SYN-'||g,'CHINA', date '2026-06-01'+g*5, date '2026-07-15'+g*5,
       case when g<=18 then 'Delivered' else 'In Transit' end,
       jsonb_build_array(jsonb_build_object('product_id','frame-A2-Natural','quantity',50)), case when g<=18 then now() end
from generate_series(1,24) g;
insert into public.shipment_status_log(id,location,shipment_id,from_status,to_status)
select 'ssl-'||g||'-'||k,'au','shp-'||g, case k when 1 then 'Ordered' else 'In Transit' end, case k when 1 then 'In Transit' else 'Delivered' end
from generate_series(1,24) g cross join generate_series(1,3) k where k<=2 and (g<=18 or k=1);
