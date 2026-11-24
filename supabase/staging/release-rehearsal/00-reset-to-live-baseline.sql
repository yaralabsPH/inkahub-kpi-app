-- STAGING ONLY (inka-staging-2, yqfrtikujqmwykfyrtbb): return public to live's pre-0034 state.
do $$
declare r record;
begin
  if current_database() <> 'postgres' or (select count(*) from public.locations) > 50 then raise exception 'guard'; end if;
  for r in select c.relname from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','p','v','m','f') loop
    execute format('drop %s if exists public.%I cascade', case (select relkind from pg_class where relname=r.relname and relnamespace='public'::regnamespace) when 'v' then 'view' when 'm' then 'materialized view' when 'f' then 'foreign table' else 'table' end, r.relname);
  end loop;
  for r in select p.oid::regprocedure::text sig, p.prokind from pg_proc p where p.pronamespace='public'::regnamespace loop
    execute format('drop %s if exists %s cascade', case r.prokind when 'p' then 'procedure' when 'a' then 'aggregate' else 'function' end, r.sig);
  end loop;
  for r in select t.typname from pg_type t where t.typnamespace='public'::regnamespace and t.typtype in ('e','c','d') and not exists(select 1 from pg_class c where c.reltype=t.oid) loop
    execute format('drop type if exists public.%I cascade', r.typname);
  end loop;
  for r in select c.relname from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='S' loop
    execute format('drop sequence if exists public.%I cascade', r.relname);
  end loop;
end $$;
drop schema if exists reporting_private cascade;
drop schema if exists departments_private cascade;
drop extension if exists btree_gist;
do $$ begin
  if exists (select 1 from pg_roles where rolname='reporting_capture') then
    execute 'grant reporting_capture to postgres with inherit true'; execute 'drop owned by reporting_capture'; execute 'drop role reporting_capture'; end if;
  if exists (select 1 from pg_roles where rolname='departments_resolver') then
    execute 'grant departments_resolver to postgres with inherit true'; execute 'drop owned by departments_resolver'; execute 'drop role departments_resolver'; end if;
end $$;
delete from supabase_migrations.schema_migrations;
-- public schema ownership/ACL and default privileges exactly as live
alter schema public owner to postgres;
revoke all on schema public from public, anon, authenticated, service_role, postgres;
grant usage, create on schema public to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on tables from public, anon, authenticated, service_role, postgres;
alter default privileges for role postgres in schema public revoke all on functions from public, anon, authenticated, service_role, postgres;
alter default privileges for role postgres in schema public revoke all on sequences from public, anon, authenticated, service_role, postgres;
alter default privileges for role postgres in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges for role postgres in schema public grant select on tables to service_role;
alter default privileges for role postgres in schema public grant execute on functions to authenticated;
