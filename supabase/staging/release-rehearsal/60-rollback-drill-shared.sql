-- STAGING ONLY. G5 rollback drill on the upgraded schema (inka-staging-2), site f7race (repo fixture 01-fixtures.sql).
-- Phase 1 = NEW app writes (scanner_commit_dispatch, auto packaging). Phase 2 = OLD app (git 79a0031 == live) acts on
-- the same orders after an app rollback, with its exact calls. Phase 3 = summary.
create table if not exists rehearsal.smoke(step text, ok boolean, detail text, ts timestamptz default clock_timestamp());
delete from rehearsal.smoke where step like 'g5:%';

-- Phase 1: new app dispatches order 10978001 (framed by Framer 1) on a shared desk scanner, box picked automatically.
begin;
select set_config('request.jwt.claim.sub', 'f7800000-0000-4000-8000-0000000000d1', true),
       set_config('request.jwt.claims', '{"sub":"f7800000-0000-4000-8000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
select set_config('g5.new', public.scanner_commit_dispatch('f7race', 'f7810000-0000-4000-8000-000000000001', 'f7r-desk', 'S1',
  'f7800000-0000-4000-8000-000000000005', 'F78E0005', '10978001', now(), 2,
  '[{"sku":"INKA-ABC0001-A2-FB","quantity":2,"work_type":"framed"}]', '[{"code":"F7R-A2B","qty":2}]',
  '{"rule_set_id":"f7r-rs","rule_set_version":1,"resolved":true,"predicted":{"f7r-box":1},"target":{"f7r-box":1},"snapshot":{}}',
  '[]', 'f7800000-0000-4000-8000-0000000000d1')::text, true);
-- retry with the SAME request id (what the new app's outbox does after a lost response)
select set_config('g5.retry', public.scanner_commit_dispatch('f7race', 'f7810000-0000-4000-8000-000000000001', 'f7r-desk', 'S1',
  'f7800000-0000-4000-8000-000000000005', 'F78E0005', '10978001', now(), 2,
  '[{"sku":"INKA-ABC0001-A2-FB","quantity":2,"work_type":"framed"}]', '[{"code":"F7R-A2B","qty":2}]',
  '{"rule_set_id":"f7r-rs","rule_set_version":1,"resolved":true,"predicted":{"f7r-box":1},"target":{"f7r-box":1},"snapshot":{}}',
  '[]', 'f7800000-0000-4000-8000-0000000000d1')::text, true);
reset role;
insert into rehearsal.smoke(step, ok, detail) values
 ('g5:1a new app dispatch saved', current_setting('g5.new')::jsonb->>'status' = 'saved', left(current_setting('g5.new'), 300)),
 ('g5:1b same-request retry adds nothing', coalesce((current_setting('g5.retry')::jsonb->>'replayed')::boolean, false) or current_setting('g5.retry')::jsonb->>'status' in ('saved','already_recorded'), left(current_setting('g5.retry'), 300)),
 ('g5:1c stock + box charged once', (select current_on_hand from public.products where location='f7race' and id='f7r-a2b') = 98
     and (select current_on_hand from public.products where location='f7race' and id='f7r-box') = 99,
  'component '||(select current_on_hand::text from public.products where location='f7race' and id='f7r-a2b')||', box '||(select current_on_hand::text from public.products where location='f7race' and id='f7r-box'));
commit;

-- Phase 2a: APP ROLLED BACK. Old app (dispatch station, classic) re-dispatches 10978001: inserts a `dispatched` event,
-- then (only if the insert succeeded) calls deduct_inventory_for_event with the component and the scanned box code.
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
begin;
select set_config('request.jwt.claim.sub', 'f7800000-0000-4000-8000-0000000000d1', true),
       set_config('request.jwt.claims', '{"sub":"f7800000-0000-4000-8000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
select set_config('g5.old_redispatch', pg_temp.old_dispatch('evt_g5_old_redisp', '10978001', 'f7800000-0000-4000-8000-000000000005'::uuid,
  '[{"code":"F7R-A2B","qty":2},{"code":"F7R-BOX","qty":1}]'::jsonb), true);
reset role;
insert into rehearsal.smoke(step, ok, detail) values
 ('g5:2a old app re-dispatch of a new-app order', true, left(current_setting('g5.old_redispatch'), 400)),
 ('g5:2b stock after old re-dispatch', (select current_on_hand from public.products where location='f7race' and id='f7r-a2b') = 98,
  'component '||(select current_on_hand::text from public.products where location='f7race' and id='f7r-a2b')||', box '||(select current_on_hand::text from public.products where location='f7race' and id='f7r-box'));
commit;

-- Phase 2b: old app dispatches a DIFFERENT order (10978003, framed earlier, never dispatched) the classic way: must work and charge once.
begin;
select set_config('request.jwt.claim.sub', 'f7800000-0000-4000-8000-0000000000d1', true),
       set_config('request.jwt.claims', '{"sub":"f7800000-0000-4000-8000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
select set_config('g5.old_new_order', pg_temp.old_dispatch('evt_g5_old_disp3', '10978003', 'f7800000-0000-4000-8000-000000000005'::uuid,
  '[{"code":"F7R-A2B","qty":2},{"code":"F7R-BOX","qty":1}]'::jsonb), true);
select set_config('g5.old_again', pg_temp.old_dispatch('evt_g5_old_disp3b', '10978003', 'f7800000-0000-4000-8000-000000000005'::uuid,
  '[{"code":"F7R-A2B","qty":2},{"code":"F7R-BOX","qty":1}]'::jsonb), true);
reset role;
insert into rehearsal.smoke(step, ok, detail) values
 ('g5:2c old app classic dispatch works', current_setting('g5.old_new_order') like 'inserted;%"deducted": 2%', left(current_setting('g5.old_new_order'), 300)),
 ('g5:2d old app second dispatch idempotent', current_setting('g5.old_again') like 'inserted;%"deducted": 0%', left(current_setting('g5.old_again'), 300)),
 ('g5:2e stock after old classic dispatch', (select current_on_hand from public.products where location='f7race' and id='f7r-a2b') = 96
     and (select current_on_hand from public.products where location='f7race' and id='f7r-box') = 98,
  'component '||(select current_on_hand::text from public.products where location='f7race' and id='f7r-a2b')||', box '||(select current_on_hand::text from public.products where location='f7race' and id='f7r-box'));
commit;

-- Phase 3: back to the NEW app: shared dispatch of 10978003 (already dispatched classically by the old app) must add nothing.
begin;
select set_config('request.jwt.claim.sub', 'f7800000-0000-4000-8000-0000000000d1', true),
       set_config('request.jwt.claims', '{"sub":"f7800000-0000-4000-8000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
select set_config('g5.new_after', public.scanner_commit_dispatch('f7race', 'f7810000-0000-4000-8000-0000000000a3', 'f7r-desk', 'S1',
  'f7800000-0000-4000-8000-000000000005', 'F78E0005', '10978003', now(), 2,
  '[{"sku":"INKA-ABC0001-A2-FB","quantity":2,"work_type":"framed"}]', '[{"code":"F7R-A2B","qty":2}]',
  '{"rule_set_id":"f7r-rs","rule_set_version":1,"resolved":true,"predicted":{"f7r-box":1},"target":{"f7r-box":1},"snapshot":{}}',
  '[]', 'f7800000-0000-4000-8000-0000000000d1')::text, true);
reset role;
insert into rehearsal.smoke(step, ok, detail) values
 ('g5:3a new app after rollback-forward on an old-app order', true, left(current_setting('g5.new_after'), 300)),
 ('g5:3b final stock', true,
  'component '||(select current_on_hand::text from public.products where location='f7race' and id='f7r-a2b')||', box '||(select current_on_hand::text from public.products where location='f7race' and id='f7r-box')
  ||'; ledger rows: '||(select string_agg(source_id||' '||delta::text, ' | ' order by ts) from public.ledger where location='f7race'));
commit;

select step, ok, detail from rehearsal.smoke where step like 'g5:%' order by step;
