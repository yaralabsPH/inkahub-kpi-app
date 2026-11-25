-- STAGING ONLY. G5 part 2: the documented edge. NEW app classic dispatch station in AUTOMATIC packaging mode
-- (event insert -> component deduction -> packaging_apply), then the OLD app completes the same order again.
delete from rehearsal.smoke where step like 'g5b:%';
create or replace function pg_temp.old_dispatch(p_event text, p_order text, p_uid uuid, p_lines jsonb) returns text language plpgsql as $$
declare v_res jsonb;
begin
  begin
    insert into public.production_events(id, location, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id)
    values (p_event, 'f7race', p_uid, 'dispatch', p_order, null, null, 'dispatched', 'dispatch-1', '', now(), null, null);
  exception when others then
    return 'insert refused: '||sqlerrm;
  end;
  v_res := public.deduct_inventory_for_event(p_event, p_lines);
  return 'inserted; deduct='||v_res::text;
end $$;
select set_config('g5b.c0', (select current_on_hand::text from public.products where location='f7race' and id='f7r-a2b'), false),
       set_config('g5b.b0', (select current_on_hand::text from public.products where location='f7race' and id='f7r-box'), false);

-- NEW app, classic station, auto packaging, order 10978004
begin;
select set_config('request.jwt.claim.sub', 'f7800000-0000-4000-8000-0000000000d1', true),
       set_config('request.jwt.claims', '{"sub":"f7800000-0000-4000-8000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
select set_config('g5b.new_evt', pg_temp.old_dispatch('evt_g5b_new_disp4', '10978004', 'f7800000-0000-4000-8000-000000000005'::uuid,
  '[{"code":"F7R-A2B","qty":2}]'::jsonb), true);
select set_config('g5b.apply', public.packaging_apply('f7race', 'pkg-apply:g5b-0004', 'evt_g5b_new_disp4', 'f7r-rs', true,
  '{"f7r-box":1}'::jsonb, '{"f7r-box":1}'::jsonb, '{}'::jsonb)::text, true);
select set_config('g5b.apply_retry', public.packaging_apply('f7race', 'pkg-apply:g5b-0004', 'evt_g5b_new_disp4', 'f7r-rs', true,
  '{"f7r-box":1}'::jsonb, '{"f7r-box":1}'::jsonb, '{}'::jsonb)::text, true);
reset role;
insert into rehearsal.smoke(step, ok, detail) values
 ('g5b:1 new classic dispatch + auto box', current_setting('g5b.apply')::jsonb->>'status' = 'applied', left(current_setting('g5b.new_evt'),160)||' | '||left(current_setting('g5b.apply'), 250)),
 ('g5b:2 packaging retry with same request id adds nothing', (current_setting('g5b.apply_retry')::jsonb->>'replayed')::boolean is true or current_setting('g5b.apply_retry')::jsonb->>'status'='already_applied', left(current_setting('g5b.apply_retry'), 250)),
 ('g5b:3 after new app', (select current_on_hand from public.products where location='f7race' and id='f7r-a2b') = current_setting('g5b.c0')::numeric - 2
     and (select current_on_hand from public.products where location='f7race' and id='f7r-box') = current_setting('g5b.b0')::numeric - 1,
  'component '||(select current_on_hand::text from public.products where location='f7race' and id='f7r-a2b')||', box '||(select current_on_hand::text from public.products where location='f7race' and id='f7r-box'));
commit;

-- APP ROLLED BACK: old app re-dispatches 10978004, scanning the box as the old flow requires
begin;
select set_config('request.jwt.claim.sub', 'f7800000-0000-4000-8000-0000000000d1', true),
       set_config('request.jwt.claims', '{"sub":"f7800000-0000-4000-8000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
select set_config('g5b.old', pg_temp.old_dispatch('evt_g5b_old_disp4', '10978004', 'f7800000-0000-4000-8000-000000000005'::uuid,
  '[{"code":"F7R-A2B","qty":2},{"code":"F7R-BOX","qty":1}]'::jsonb), true);
reset role;
insert into rehearsal.smoke(step, ok, detail) values
 ('g5b:4 old app re-dispatch (documented edge)', true, left(current_setting('g5b.old'), 300)),
 ('g5b:5 component not double-charged', (select current_on_hand from public.products where location='f7race' and id='f7r-a2b') = current_setting('g5b.c0')::numeric - 2,
  'component '||(select current_on_hand::text from public.products where location='f7race' and id='f7r-a2b')),
 ('g5b:6 box (expected edge: second box possible)', true,
  'box '||current_setting('g5b.b0')||' -> '||(select current_on_hand::text from public.products where location='f7race' and id='f7r-box')
  ||'; order ledger: '||(select string_agg(source_id||' '||delta::text, ' | ' order by ts) from public.ledger where location='f7race' and (source_id like '%10978004%' or source_id like 'pkg:%')));
commit;
select step, ok, detail from rehearsal.smoke where step like 'g5b:%' order by step;
