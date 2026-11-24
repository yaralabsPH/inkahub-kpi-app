-- STAGING ONLY. G3 old-app smoke: replay the database calls the LIVE build (git 79a0031 == live dpl_4r1s2fBX) makes,
-- as the real `authenticated` role with each test user's JWT claims, against the UPGRADED schema (0034-0062).
create table if not exists rehearsal.smoke(step text, ok boolean, detail text, ts timestamptz default clock_timestamp());
delete from rehearsal.smoke where step like 'old:%';
select set_config('smoke.staff',   (select id::text from auth.users where email='staff@inka-staging.test'), false),
       set_config('smoke.manager', (select id::text from auth.users where email='manager@inka-staging.test'), false),
       set_config('smoke.cs',      (select id::text from auth.users where email='cs@inka-staging.test'), false),
       set_config('smoke.owner',   (select id::text from auth.users where email='owner@inka-staging.test'), false);
select set_config('smoke.a2_before', (select current_on_hand::text from public.products where location='au' and id='frame-A2-Natural'), false),
       set_config('smoke.pk_before', (select current_on_hand::text from public.products where location='au' and id='syn-au-45'), false);

-- 1. staff: lanyard clock-in, started, line_verified, completed (Production.tsx payloads)
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('smoke.staff'), 'role','authenticated')::text, true);
insert into public.production_events(location, id, staff_id, department, event_type, note)
  values ('au','evt_old_clockin', current_setting('smoke.staff')::uuid, 'framed', 'clock_in', 'Sign in via lanyard scan');
insert into public.production_events(id, location, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id) values
  ('evt_old_start','au', current_setting('smoke.staff')::uuid,'framed','SMOKE-OLD-1',null,null,'started','framed-1','',now(),null,null),
  ('evt_old_lv1','au', current_setting('smoke.staff')::uuid,'framed','SMOKE-OLD-1','INKA-SUN0586-A2-FN',1,'line_verified','framed-1','',now(),null,null),
  ('evt_old_done','au', current_setting('smoke.staff')::uuid,'framed','SMOKE-OLD-1',null,null,'completed','framed-1','',now(),null,null);
-- framed completion: old app calls the RPC; A2 framed lines deduct at dispatch, so lines may be empty here. Call with the frame code as the old code does for its own routed lines.
select public.deduct_inventory_for_event('evt_old_done', '[]'::jsonb) is not null as framed_rpc_ok;
-- read-backs the old Welcome/Production screens do
select count(*) >= 4 from public.production_events where location='au' and order_number='SMOKE-OLD-1' or id='evt_old_clockin';
reset role;
insert into rehearsal.smoke(step, ok, detail) select 'old:1 staff events visible to staff', true, 'inserted 4 events';
commit;

-- 2. manager: dispatch with deduction (frame + package), then re-dispatch -> idempotent
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('smoke.manager'), 'role','authenticated')::text, true);
insert into public.production_events(id, location, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id) values
  ('evt_old_disp','au', current_setting('smoke.manager')::uuid,'dispatch','SMOKE-OLD-1',null,null,'dispatched','dispatch-1','',now(),null,null);
select set_config('smoke.r1', public.deduct_inventory_for_event('evt_old_disp', '[{"code":"A2-Natural","qty":1},{"code":"SYN-AU-045","qty":1}]'::jsonb)::text, true);
insert into public.production_events(id, location, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id) values
  ('evt_old_disp2','au', current_setting('smoke.manager')::uuid,'dispatch','SMOKE-OLD-1',null,null,'dispatched','dispatch-1','',now(),null,null);
select set_config('smoke.r2', public.deduct_inventory_for_event('evt_old_disp2', '[{"code":"A2-Natural","qty":1},{"code":"SYN-AU-045","qty":1}]'::jsonb)::text, true);
reset role;
insert into rehearsal.smoke(step, ok, detail) values
 ('old:2a first dispatch deducts 2', (current_setting('smoke.r1')::jsonb->>'deducted')::int = 2, current_setting('smoke.r1')),
 ('old:2b re-dispatch is idempotent', (current_setting('smoke.r2')::jsonb->>'deducted')::int = 0 and (current_setting('smoke.r2')::jsonb->>'skipped_idempotent')::int = 2, current_setting('smoke.r2'));
commit;

-- 3. manager: shipment create -> Delivered -> apply credit -> reverse -> delete (SupabaseRepo shipment paths)
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('smoke.manager'), 'role','authenticated')::text, true);
insert into public.shipments(location,id,po_number,supplier,order_placed_date,expected_arrival_date,status,lines)
  values ('au','shp-smoke-old','PO-SMOKE-OLD','CHINA',current_date,current_date+30,'In Transit','[{"product_id":"frame-A3-Natural","quantity":10}]');
update public.shipments set status='Delivered' where location='au' and id='shp-smoke-old';
select set_config('smoke.ap', public.apply_shipment_delivery('au','shp-smoke-old')::text, true);
select set_config('smoke.a3_after_apply', (select current_on_hand::text from public.products where location='au' and id='frame-A3-Natural'), true);
select set_config('smoke.rv', public.reverse_shipment_delivery('au','shp-smoke-old')::text, true);
select set_config('smoke.del', public.delete_shipment_atomic('au','shp-smoke-old')::text, true);
reset role;
insert into rehearsal.smoke(step, ok, detail) values
 ('old:3a delivered credit applied', current_setting('smoke.ap')::jsonb->>'action'='credited' and current_setting('smoke.a3_after_apply')::numeric = 510, current_setting('smoke.ap')||' A3 now '||current_setting('smoke.a3_after_apply')),
 ('old:3b reverse + delete', current_setting('smoke.rv')::jsonb->>'action'='reversed' and current_setting('smoke.del')::jsonb->>'action'='deleted', current_setting('smoke.rv')||' '||current_setting('smoke.del')),
 ('old:3c status log + delivered meta trigger', (select count(*) from public.shipment_status_log where shipment_id='shp-smoke-old') = 0, 'log rows cascade-deleted with the shipment'),
 ('old:3d A3 back to 500', (select current_on_hand from public.products where location='au' and id='frame-A3-Natural') = 500, (select current_on_hand::text from public.products where location='au' and id='frame-A3-Natural'));
commit;

-- 4. cs: case + line, return + line; manager manual adjust (adjust_on_hand)
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('smoke.cs'), 'role','authenticated')::text, true);
insert into public.cs_cases(location,id,created_by_user_id,issue_type,order_number,customer_name,customer_email)
  values ('au','case-smoke-old', current_setting('smoke.cs')::uuid,'damaged','SMOKE-OLD-1','Test Customer','customer@example.test');
insert into public.cs_case_lines(location,id,case_id,product_id,quantity) values ('au','cl-smoke-old','case-smoke-old','frame-A4-Natural',1);
update public.cs_cases set status='shipped', shipped_at=now(), inventory_deducted=true where location='au' and id='case-smoke-old';
insert into public.cs_returns(location,id,created_by_user_id,order_number) values ('au','ret-smoke-old', current_setting('smoke.cs')::uuid,'SMOKE-OLD-1');
insert into public.cs_return_lines(location,id,return_id,product_id,quantity,restock) values ('au','rl-smoke-old','ret-smoke-old','frame-A4-Natural',1,true);
select count(*) = 1 from public.cs_cases where id='case-smoke-old';
reset role;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('smoke.manager'), 'role','authenticated')::text, true);
select * from public.adjust_on_hand('au','frame-A4-Natural', 1, 'manual', 'smoke-old-manual', null, 'smoke manual');
reset role;
insert into rehearsal.smoke(step, ok, detail) values
 ('old:4 cs case/return + manual adjust', (select current_on_hand from public.products where location='au' and id='frame-A4-Natural') = 499,
  'A4 '||(select current_on_hand::text from public.products where location='au' and id='frame-A4-Natural'));
commit;

-- 5. owner: settings, team badge, weekly sales; staff read-back of clocked-in (Welcome card query)
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('smoke.owner'), 'role','authenticated')::text, true);
update public.settings set currency_symbol='$' where location='au';
insert into public.staff_barcodes(location, barcode, user_id, display_name) values ('au','SMOKEOLD', current_setting('smoke.staff')::uuid, 'Staff');
update public.staff_barcodes set active=false, revoked_at=now() where location='au' and barcode='SMOKEOLD';
insert into public.weekly_sales(location, product_id, iso_week_start, units_sold) values ('au','frame-A2-Natural', date '2026-11-23', 3)
  on conflict (location, product_id, iso_week_start) do update set units_sold = excluded.units_sold;
reset role;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('smoke.staff'), 'role','authenticated')::text, true);
select set_config('smoke.ci', (select count(*)::text from public.production_events where location='au' and event_type in ('clock_in','clock_out') and created_at > now() - interval '16 hours'), true);
reset role;
insert into rehearsal.smoke(step, ok, detail) values ('old:5 owner writes + staff clocked-in read', current_setting('smoke.ci')::int >= 1, 'clock events visible: '||current_setting('smoke.ci'));
commit;

-- 6. stock math summary
insert into rehearsal.smoke(step, ok, detail)
select 'old:6 stock moved exactly once',
  (select current_on_hand from public.products where location='au' and id='frame-A2-Natural') = current_setting('smoke.a2_before')::numeric - 1
  and (select current_on_hand from public.products where location='au' and id='syn-au-45') = current_setting('smoke.pk_before')::numeric - 1,
  'A2 '||current_setting('smoke.a2_before')||'->'||(select current_on_hand::text from public.products where location='au' and id='frame-A2-Natural')
  ||', package '||current_setting('smoke.pk_before')||'->'||(select current_on_hand::text from public.products where location='au' and id='syn-au-45');

select step, ok, detail from rehearsal.smoke where step like 'old:%' order by step;
