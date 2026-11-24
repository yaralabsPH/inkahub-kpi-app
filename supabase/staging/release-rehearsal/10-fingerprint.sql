with
cols as (select c.relname||'.'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'') s from pg_class c join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where c.relnamespace='public'::regnamespace and c.relkind in ('r','p')),
cons as (select conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) s from pg_constraint where connamespace='public'::regnamespace),
idx as (select pg_get_indexdef(indexrelid) s from pg_index i join pg_class c on c.oid=i.indrelid where c.relnamespace='public'::regnamespace),
fns as (select p.oid::regprocedure::text||':'||md5(replace(p.prosrc,E'\r',''))||':'||p.prosecdef::text||':'||p.provolatile::text||':'||coalesce(array_to_string(p.proconfig,','),'')||':'||pg_get_userbyid(p.proowner) s from pg_proc p where p.pronamespace='public'::regnamespace),
pols as (select tablename||':'||policyname||':'||permissive||':'||cmd||':'||roles::text||':'||coalesce(qual,'')||':'||coalesce(with_check,'') s from pg_policies where schemaname='public'),
trg as (select pg_get_triggerdef(t.oid) s from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and not t.tgisinternal),
tacl as (select c.relname||':'||coalesce(c.relacl::text,'')||':'||c.relrowsecurity::text||c.relforcerowsecurity::text||':'||pg_get_userbyid(c.relowner) s from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','p')),
facl as (select p.oid::regprocedure::text||':'||coalesce(p.proacl::text,'') s from pg_proc p where p.pronamespace='public'::regnamespace),
nsp as (select nspname||':'||coalesce(nspacl::text,'')||':'||pg_get_userbyid(nspowner) s from pg_namespace where nspname='public'),
dacl as (select defaclrole::regrole::text||':'||defaclobjtype::text||':'||defaclacl::text s from pg_default_acl where defaclnamespace='public'::regnamespace and defaclrole='postgres'::regrole),
ext as (select extname||'@'||extnamespace::regnamespace::text s from pg_extension),
sch as (select nspname s from pg_namespace where nspname not like 'pg_%' and nspname not in ('information_schema','supabase_migrations')),
rls as (select rolname s from pg_roles where rolname in ('reporting_capture','departments_resolver'))
select 'cols' k, count(*) n, md5(string_agg(s,'|' order by s)) h from cols
union all select 'cons', count(*), md5(string_agg(s,'|' order by s)) from cons
union all select 'idx', count(*), md5(string_agg(s,'|' order by s)) from idx
union all select 'fns', count(*), md5(string_agg(s,'|' order by s)) from fns
union all select 'pols', count(*), md5(string_agg(s,'|' order by s)) from pols
union all select 'trg', count(*), md5(string_agg(s,'|' order by s)) from trg
union all select 'tacl', count(*), md5(string_agg(s,'|' order by s)) from tacl
union all select 'facl', count(*), md5(string_agg(s,'|' order by s)) from facl
union all select 'nsp', count(*), md5(string_agg(s,'|' order by s)) from nsp
union all select 'dacl', count(*), md5(string_agg(s,'|' order by s)) from dacl
union all select 'ext', count(*), md5(string_agg(s,'|' order by s)) from ext
union all select 'schemas', count(*), md5(string_agg(s,'|' order by s)) from sch
union all select 'roles', count(*), coalesce(md5(string_agg(s,'|' order by s)),'-') from rls
order by 1;
