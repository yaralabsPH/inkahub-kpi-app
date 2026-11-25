-- F5 departments: preflight snapshot. READ-ONLY.
--
-- STAGING ONLY. Run it twice and keep both outputs with the evidence:
--   1. BEFORE applying 0052-0054 (baseline)
--   2. AFTER applying them (compare)
-- It changes nothing. Every statement is a SELECT.
--
-- What to compare afterwards:
--   * section 6 (legacy fingerprint) must be IDENTICAL before and after: the
--     migrations do not touch existing event rows;
--   * section 3 must show the same pre-existing triggers plus the three F5
--     event triggers and the profile trigger, with sanitize before resolve;
--   * section 4/5 must show the pre-existing policies and grants unchanged.

-- 1. Where am I? (must show a 'staging' location; refuse to go on otherwise)
SELECT current_database() AS database, current_user AS role, version() AS postgres,
       current_setting('transaction_isolation') AS isolation,
       EXISTS (SELECT 1 FROM public.locations WHERE key = 'staging') AS has_staging_location,
       (SELECT array_agg(key ORDER BY key) FROM public.locations) AS locations;

-- 2. Extensions F5 depends on, and where they live.
SELECT a.name, a.default_version, a.installed_version, n.nspname AS installed_schema
  FROM pg_available_extensions a
  LEFT JOIN pg_extension e ON e.extname = a.name
  LEFT JOIN pg_namespace n ON n.oid = e.extnamespace
 WHERE a.name IN ('btree_gist', 'pgcrypto')
 ORDER BY a.name;

-- 3. Row triggers on the two tables F5 adds triggers to, in firing order
--    (Postgres fires same-event triggers in name order).
SELECT c.relname AS on_table, t.tgname AS trigger,
       CASE WHEN (t.tgtype & 2) = 2 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
       concat_ws(' OR ',
         CASE WHEN (t.tgtype & 4) = 4 THEN 'INSERT' END,
         CASE WHEN (t.tgtype & 16) = 16 THEN 'UPDATE' END,
         CASE WHEN (t.tgtype & 8) = 8 THEN 'DELETE' END) AS events,
       t.tgenabled AS enabled, -- O = enabled, D = disabled
       t.tgfoid::regprocedure AS function,
       pg_get_userbyid(p.proowner) AS function_owner, p.prosecdef AS security_definer
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_proc p ON p.oid = t.tgfoid
 WHERE NOT t.tgisinternal
   AND t.tgrelid IN ('public.production_events'::regclass, 'public.profiles'::regclass)
 ORDER BY c.relname, timing DESC, t.tgname;

-- 4. Policies on the tables F5 must leave alone.
SELECT tablename, policyname, cmd, roles, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename IN ('production_events', 'profiles', 'user_locations', 'staff_barcodes', 'staff_rates')
 ORDER BY tablename, policyname;

-- 5. Table grants on those tables (must be unchanged by F5).
SELECT table_name, grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public' AND table_name IN ('production_events', 'profiles')
   AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC')
 GROUP BY table_name, grantee
 ORDER BY table_name, grantee;

-- 6. Legacy fingerprint: existing events, by their ORIGINAL columns only, so
--    the same query works before and after the migration.
SELECT count(*) AS events,
       min(created_at) AS oldest, max(created_at) AS newest,
       md5(string_agg(md5(concat_ws('|', location, id, staff_id::text, department, coalesce(order_number, ''),
           coalesce(line_sku, ''), coalesce(line_quantity::text, ''), event_type, coalesce(station_id, ''), note,
           created_at::text, coalesce(cs_case_id, ''), coalesce(parent_event_id, ''))), '' ORDER BY location, id)) AS fingerprint
  FROM public.production_events
 WHERE created_at < now() - interval '1 hour';

-- 7. Columns of production_events (after the migration: eleven more, all
--    nullable, no default).
SELECT ordinal_position, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'production_events'
 ORDER BY ordinal_position;

-- 8. F5 objects (empty before the migration).
SELECT 'table' AS kind, c.relname AS name, c.relrowsecurity::text AS detail
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND c.relname IN ('business_departments','business_department_names','person_department_assignments',
                     'department_audit','department_requests','department_snapshot_control')
UNION ALL
SELECT 'function', p.oid::regprocedure::text, 'owner=' || pg_get_userbyid(p.proowner) || ' definer=' || p.prosecdef
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'departments_private' OR (n.nspname = 'public' AND p.proname LIKE 'department\_%')
UNION ALL
SELECT 'role', rolname, 'login=' || rolcanlogin || ' bypassrls=' || rolbypassrls FROM pg_roles WHERE rolname = 'departments_resolver'
 ORDER BY kind, name;

-- 9. Item-counting (F1) capture trigger, if it is installed on this database.
--    F5 never changes it; this only records its state for the evidence.
SELECT t.tgname, t.tgenabled AS enabled, t.tgfoid::regprocedure AS function
  FROM pg_trigger t
 WHERE t.tgrelid = 'public.production_events'::regclass AND t.tgname = 'production_events_reporting_capture';

-- 10. Identity check: every credited worker reference is an Auth user id
--     (constraints present, as on staging on 2026-11-22).
SELECT conrelid::regclass AS on_table, conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE contype = 'f' AND confrelid = 'auth.users'::regclass
   AND conrelid IN ('public.production_events'::regclass, 'public.profiles'::regclass, 'public.staff_barcodes'::regclass)
 ORDER BY 1, 2;
