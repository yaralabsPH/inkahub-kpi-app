/**
 * Regenerates supabase/staging/item-counting/03-query-evidence.sql from
 * migrations 0034 (v1, compatibility evidence only) and 0035 (v2, measured)
 * and MEASURE_CASES / STAGING_CUTOFF, so the SQL evidence and the timed loads
 * always use the same scopes, cutoff and function body.
 *
 *   npx vite-node tests/staging/generate-query-evidence.ts --write
 *
 * The generated SQL mirrors the API: after every `set local role
 * authenticated` it applies authenticated's own statement_timeout read from
 * pg_roles (PostgREST does this per request; SET ROLE alone does not), and it
 * runs PostgREST's real scalar statement shape with the whole body converted
 * to text. Anything over the limit cancels in SQL and fails the gate before
 * any API timing. It changes nothing: no ANALYZE, no ALTER, and it rolls back.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { productionRange } from "../../src/lib/domain/productionPeriods";
import { MEASURE_CASES, STAGING_CUTOFF } from "./measure-item-counting";
import { HARNESS_VERSION, V1_FUNCTION, V2_FUNCTION } from "./itemCountingEvidence";

const SIG = "(text, timestamptz, timestamptz, timestamptz)";

const readLf = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
/** The v2 function body from migration 0035, read when the SQL is built (not at import time). */
let v2BodyCache: string | null = null;
function v2Body(): string {
  v2BodyCache ??= /AS \$fn\$\n([\s\S]*?)\n\$fn\$;/.exec(readLf("supabase/migrations/0035_load_production_evidence_v2.sql"))![1]
    .replace(/^\s*--.*$/gm, "").replace(/\n{2,}/g, "\n");
  return v2BodyCache;
}

const scopes = MEASURE_CASES.map((c) => {
  const r = productionRange(c.site, c.first, c.last);
  return { scope: c.scope, site: c.site, s: r.startUtc, e: r.endUtcExclusive, day: c.first === c.last };
});
const lit = (v: string) => `'${v}'`;
const ts = (v: string) => `'${v}'::timestamptz`;
const C = STAGING_CUTOFF;
const call = (fn: string, site: string, s: string, e: string) =>
  `public.${fn}(${lit(site)}, ${ts(s)}, ${ts(e)}, ${ts(C)})`;
const bodyWith = (site: string, s: string, e: string) =>
  v2Body().replace(/p_site/g, `${lit(site)}::text`).replace(/p_start_utc/g, ts(s))
    .replace(/p_end_utc_exclusive/g, ts(e)).replace(/p_as_of_utc/g, ts(C));

/** The transaction-local setting the runner fills with a role's real session claims (never a literal here). */
export const claimsSetting = (role: string) => `inka_staging.jwt_${role.replace(/-/g, "_")}`;
export const STAGING_ISSUER = "https://ybrzhrgfrnvtcwymjdrq.supabase.co/auth/v1";

/**
 * Switch identity using that role's REAL session claims, supplied by the
 * runner as a bound parameter into a transaction-local setting. Standalone
 * SQL without them fails (current_setting without missing_ok); there is no
 * fallback to minimal {sub, role} claims. Then record claims evidence (sizes,
 * shape, booleans — never values), switch to authenticated, apply
 * authenticated's catalog statement_timeout and record the settings.
 */
export function become(role: string, email = `${role}@inka-staging.test`): string[] {
  return [
    "reset role;",
    `select set_config('request.jwt.claims', current_setting('${claimsSetting(role)}'), true) is not null as claims_set,
       set_config('request.jwt.claim.sub', '', true) = '' and set_config('request.jwt.claim.role', '', true) = '' as legacy_cleared;`,
    `select '${role}' as claims_for,
       octet_length(current_setting('request.jwt.claims')) as claims_bytes,
       (select string_agg(k || ':' || json_typeof(c.j -> k), ',' order by k collate "C") from json_object_keys(c.j) k) as claims_shape,
       (c.j ->> 'role') = 'authenticated' as claims_db_role_ok,
       (c.j ->> 'aud') = 'authenticated' as claims_aud_ok,
       (c.j ->> 'iss') = '${STAGING_ISSUER}' as claims_iss_ok,
       (c.j ->> 'exp')::bigint > extract(epoch from now()) as claims_unexpired,
       coalesce((select u.email from auth.users u where u.id::text = c.j ->> 'sub') = '${email}', false) as claims_subject_ok,
       coalesce(current_setting('request.jwt.claim.sub', true), '') = '' and coalesce(current_setting('request.jwt.claim.role', true), '') = '' as legacy_overrides_empty,
       (select p.role from public.profiles p where p.user_id::text = c.j ->> 'sub') as profile_role,
       (select string_agg(ul.location, ',' order by ul.location) from public.user_locations ul where ul.user_id::text = c.j ->> 'sub') as memberships
from (select current_setting('request.jwt.claims')::json as j) c;`,
    "set local role authenticated;",
    `-- apply the API role's own statement_timeout (read from the catalog, never hardcoded)
do $$
declare
  entries text[];
begin
  select array_agg(c) into entries
  from pg_catalog.pg_roles r, unnest(r.rolconfig) c
  where r.rolname = 'authenticated' and c like 'statement_timeout=%';
  if entries is null or array_length(entries, 1) <> 1 then
    raise exception 'gate: authenticated must have exactly one statement_timeout setting (found %)', coalesce(array_length(entries, 1), 0);
  end if;
  execute format('set local statement_timeout = %L', substr(entries[1], length('statement_timeout=') + 1));
end
$$;`,
    `select '${role}' as timeout_for,
       current_user as current_user_name,
       session_user as session_user_name,
       (select setting::bigint from pg_catalog.pg_settings where name = 'statement_timeout') as effective_timeout_ms,
       current_setting('statement_timeout') as effective_timeout,
       (select string_agg(substr(c, length('statement_timeout=') + 1), ',')
          from pg_catalog.pg_roles r, unnest(r.rolconfig) c
         where r.rolname = 'authenticated' and c like 'statement_timeout=%') as catalog_timeout,
       (select coalesce(array_to_string(rolconfig, ', '), '') from pg_catalog.pg_roles where rolname = 'authenticated') as authenticated_config,
       (select coalesce(array_to_string(rolconfig, ', '), '') from pg_catalog.pg_roles where rolname = 'authenticator') as authenticator_config,
       (select coalesce(array_to_string(rolconfig, ', '), '') from pg_catalog.pg_roles where rolname = 'anon') as anon_config,
       current_setting('row_security') as row_security,
       current_setting('work_mem') as work_mem,
       version() as server_version;`,
  ];
}

/** All policies on public.production_events, as pg prints them (hashed and checked by the gate). */
export const POLICY_CATALOG_SQL = `-- production_events policies (all of them; hashed by the gate)
select 'production_events' as policy_catalog, schemaname, tablename, policyname, permissive, roles::text[] as roles, cmd, qual, with_check
from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'production_events'
order by policyname;`;

/** The four families, written independently (EXISTS, not the function's IN), as full rows. */
function familiesSql(site: string, s: string, e: string): string {
  const W = `pe.location = ${lit(site)} and pe.created_at >= ${ts(s)} and pe.created_at < ${ts(e)} and pe.created_at <= ${ts(C)}`;
  const cols = "x.id, x.staff_id, x.department, x.order_number, x.line_sku, x.line_quantity, x.event_type, x.created_at, x.parent_event_id, x.cs_case_id";
  return `w as (
  select pe.id, pe.staff_id, pe.department, pe.order_number, pe.line_sku, pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
  from public.production_events pe
  where ${W} and pe.event_type in ('line_verified', 'completed', 'dispatched', 'cancelled')
), q as (
  select ${cols} from public.production_events x
  where x.location = ${lit(site)} and x.event_type = 'line_verified' and x.created_at < ${ts(s)} and x.created_at <= ${ts(C)}
    and exists (select 1 from w where w.event_type in ('completed', 'dispatched')
                and coalesce(btrim(w.order_number), '') <> '' and w.order_number = x.order_number)
), p as (
  select ${cols} from public.production_events x
  where x.location = ${lit(site)} and x.created_at < ${ts(s)} and x.created_at <= ${ts(C)}
    and exists (select 1 from w where w.event_type = 'cancelled' and coalesce(w.parent_event_id, '') <> '' and w.parent_event_id = x.id)
), l as (
  select ${cols} from public.production_events x
  where x.location = ${lit(site)} and x.event_type = 'cancelled' and x.created_at >= ${ts(e)} and x.created_at <= ${ts(C)}
    and exists (select 1 from w where w.event_type in ('line_verified', 'completed', 'dispatched') and w.id = x.parent_event_id)
), expected as (
  select * from w union select * from q union select * from p union select * from l
)`;
}

function independent(role: string, scope: string, site: string, s: string, e: string): string {
  return `-- independent expectation (EXISTS form)
with ${familiesSql(site, s, e)}
select '${role}' as role, '${scope}' as scope,
  (select count(*) from w) as window_rows,
  (select count(*) from q) as qualification_rows,
  (select count(*) from p) as parent_rows,
  (select count(*) from l) as later_rows,
  (select count(*) from expected) as independent_total;`;
}

/**
 * The function's rowCount. json ->> would re-parse the whole (up to 15 MB)
 * body under the 8 s limit; json_build_object writes rowCount before staffIds,
 * skus and rows, so the first "rowCount" in the text is the envelope's.
 */
function fnRowCount(role: string, scope: string, site: string, s: string, e: string): string {
  return `select '${role}' as role, '${scope}' as scope,
  substring((${call(V2_FUNCTION, site, s, e)})::text from '"rowCount" *: *([0-9]+)')::bigint as fn_row_count;`;
}

/** Decode v2 rows with its dictionaries and compare every field with the independent table rows. */
function fieldCompare(role: string, scope: string, site: string, s: string, e: string): string {
  return `-- field-by-field: decoded v2 rows versus the independent table rows
with ${familiesSql(site, s, e)},
v2 as (select ${call(V2_FUNCTION, site, s, e)} as b),
decoded as (
  select r ->> 0 as id, (v2.b -> 'staffIds' ->> ((r ->> 1)::int))::uuid as staff_id, r ->> 2 as department,
         r ->> 3 as order_number, v2.b -> 'skus' ->> ((r ->> 4)::int) as line_sku, (r ->> 5)::int as line_quantity,
         r ->> 6 as event_type, (r ->> 7)::timestamptz as created_at, r ->> 8 as parent_event_id, r ->> 9 as cs_case_id
  from v2, json_array_elements(v2.b -> 'rows') r
)
select '${role}' as role, '${scope}' as scope,
  (select count(*) from decoded) as decoded_rows,
  (select count(*) from (select * from decoded except select * from expected) x) as only_in_function,
  (select count(*) from (select * from expected except select * from decoded) x) as only_in_table,
  (select json_array_length(b -> 'staffIds') from v2) as staff_entries,
  (select count(distinct staff_id) from expected where staff_id is not null) as expected_staff,
  (select json_array_length(b -> 'skus') from v2) as sku_entries,
  (select count(distinct line_sku) from expected where line_sku is not null) as expected_skus;`;
}

/** PostgREST's real scalar RPC statement (seen in pg_stat_statements), body forced to text. */
function bodyText(role: string, scope: string, run: number, site: string, s: string, e: string): string {
  const payload = JSON.stringify({ p_site: site, p_start_utc: s, p_end_utc_exclusive: e, p_as_of_utc: C });
  return `-- real PostgREST scalar shape, full body converted to text
WITH pgrst_source AS (
  SELECT pgrst_call.pgrst_scalar
  FROM (SELECT '${payload}'::json AS json_data) pgrst_payload,
  LATERAL (SELECT "p_site", "p_start_utc", "p_end_utc_exclusive", "p_as_of_utc"
           FROM json_to_record(pgrst_payload.json_data) AS _("p_site" text, "p_start_utc" timestamp with time zone,
                "p_end_utc_exclusive" timestamp with time zone, "p_as_of_utc" timestamp with time zone) LIMIT 1) pgrst_body,
  LATERAL (SELECT "public"."${V2_FUNCTION}"("p_site" := pgrst_body."p_site", "p_start_utc" := pgrst_body."p_start_utc",
           "p_end_utc_exclusive" := pgrst_body."p_end_utc_exclusive", "p_as_of_utc" := pgrst_body."p_as_of_utc") pgrst_scalar) pgrst_call
)
SELECT 'gate:text:${role}:${scope}:${run}' AS gate,
       octet_length((coalesce(json_agg(_postgrest_t.pgrst_scalar) -> 0, 'null'::json))::text) AS body_bytes,
       current_setting('statement_timeout') AS effective_timeout
FROM (SELECT "${V2_FUNCTION}".* FROM "pgrst_source" AS "${V2_FUNCTION}" LIMIT ALL OFFSET 0) _postgrest_t;`;
}

function catalog(fn: string): string {
  return `-- function catalog evidence: ${fn}
select p.proname as fn_name,
       pg_get_function_identity_arguments(p.oid) as fn_args,
       pg_get_function_result(p.oid) as fn_result,
       l.lanname as fn_language,
       p.provolatile as fn_volatility,
       p.prosecdef as fn_security_definer,
       coalesce(array_to_string(p.proconfig, ','), '') as fn_config,
       md5(pg_get_functiondef(p.oid)) as fn_definition_md5
from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
where n.nspname = 'public' and p.proname = '${fn}';`;
}

function privileges(fn: string): string {
  const regproc = `'public.${fn}${SIG}'`;
  return `-- function privileges: ${fn}
select '${fn}' as fn_privileges_for, r.grantee as fn_grantee,
       case when r.grantee = 'PUBLIC'
            then exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where p.oid = ${regproc}::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE')
            else has_function_privilege(r.grantee, ${regproc}, 'EXECUTE')
       end as can_execute
from (values ('PUBLIC'), ('anon'), ('authenticated'), ('service_role')) r(grantee);`;
}

/** The full 03-query-evidence.sql text (pure; LF line endings). */
export function buildQueryEvidenceSql(): string {
  const parts: string[] = [];
  parts.push(`-- item-counting · Task 4 staging gate · step 3 of 3: function, plan and expectation evidence
--
-- GENERATED by tests/staging/generate-query-evidence.ts (${HARNESS_VERSION}) from
-- supabase/migrations/0035_load_production_evidence_v2.sql and MEASURE_CASES /
-- STAGING_CUTOFF. STAGING ONLY. Needs 0034, 0035 and 0036 applied on staging.
-- Read-only: everything runs in one transaction that is rolled back; no
-- ANALYZE, no ALTER of any role or setting.
--
-- Identity switches use each role's REAL session claims, which the runner
-- puts into transaction-local inka_staging.jwt_<role> settings as bound
-- parameters right after BEGIN. Run standalone, without them, the first
-- switch fails: there is no fallback to minimal claims.
--
-- 1. v2 and v1 function catalog definitions and grants; all production_events
--    policies (hashed by the gate and checked against the reviewed 0036 text).
-- 2. After every switch to the authenticated role: record claims evidence
--    (size, shape, subject, issuer — never values), apply authenticated's own
--    statement_timeout from pg_roles with SET LOCAL (as PostgREST does) and
--    record the effective settings. Over-limit statements cancel and fail.
-- 3. Owner and manager (RLS on), each of the six scopes:
--      - EXPLAIN (ANALYZE, BUFFERS) of the v2 call, three labelled runs, and of
--        the exact function body with the same arguments
--      - three runs of PostgREST's real scalar statement with the whole body
--        converted to text (byte length recorded)
--      - the function's rowCount and an independent EXISTS expectation;
--        day scopes also compare every decoded field with the table rows
-- 4. Small fixtures: staff, an empty window and invalid input.
-- Fixed cutoff for every scope: ${C}.
--
-- Labels: EXPLAINs select 'gate:<call|body>:<role>:<scope>:<run>'; text runs
-- return 'gate:text:<role>:<scope>:<run>' in their gate column.`);
  parts.push("begin;");
  parts.push(catalog(V2_FUNCTION), privileges(V2_FUNCTION), catalog(V1_FUNCTION), privileges(V1_FUNCTION), POLICY_CATALOG_SQL);
  parts.push(`select pg_size_pretty(pg_total_relation_size('public.production_events')) as total_size,
       (select count(*) from public.production_events) as rows;`);

  for (const role of ["owner", "manager"]) {
    parts.push(...become(role));
    for (const sc of scopes) {
      for (let run = 1; run <= 3; run++) {
        parts.push(`explain (analyze, buffers) select 'gate:call:${role}:${sc.scope}:${run}' as gate,\n  ${call(V2_FUNCTION, sc.site, sc.s, sc.e)};`);
      }
      parts.push(`explain (analyze, buffers) select 'gate:body:${role}:${sc.scope}:1' as gate, (\n${bodyWith(sc.site, sc.s, sc.e).trim()}\n) as evidence;`);
      for (let run = 1; run <= 3; run++) parts.push(bodyText(role, sc.scope, run, sc.site, sc.s, sc.e));
      parts.push(fnRowCount(role, sc.scope, sc.site, sc.s, sc.e));
      parts.push(independent(role, sc.scope, sc.site, sc.s, sc.e));
      if (sc.day) parts.push(fieldCompare(role, sc.scope, sc.site, sc.s, sc.e));
    }
  }

  const auDay = scopes.find((s) => s.scope === "au-busy-day")!;
  parts.push(...become("staff"));
  parts.push(fnRowCount("staff", "au-busy-day", "au", auDay.s, auDay.e));
  parts.push(independent("staff", "au-busy-day", "au", auDay.s, auDay.e));
  parts.push(fieldCompare("staff", "au-busy-day", "au", auDay.s, auDay.e));
  parts.push(...become("owner"));
  parts.push(`-- empty window and invalid input
select (${call(V2_FUNCTION, "au", "2020-01-01T13:00:00.000Z", "2020-01-02T13:00:00.000Z")} ->> 'rowCount')::bigint as empty_window_row_count,
       ${call(V2_FUNCTION, "au", "2020-01-01T13:00:00.000Z", "2020-01-02T13:00:00.000Z")}::text as empty_window_body,
       public.${V2_FUNCTION}('au', '2026-09-15T00:00:00Z', '2026-09-14T00:00:00Z', '${C}') is null as reversed_window_is_null,
       public.${V2_FUNCTION}(' ', '2026-09-14T00:00:00Z', '2026-09-15T00:00:00Z', '${C}') is null as blank_site_is_null,
       public.${V2_FUNCTION}('au', 'infinity', '2026-09-15T00:00:00Z', '${C}') is null as infinite_start_is_null;`);
  parts.push("rollback;");
  return parts.join("\n\n") + "\n";
}

// Write only when asked (vite-node hides the script path from argv; tests import this module).
if (process.argv.includes("--write")) {
  writeFileSync("supabase/staging/item-counting/03-query-evidence.sql", buildQueryEvidenceSql(), "utf8");
  console.log(`wrote 03-query-evidence.sql (${scopes.length} scopes, ${HARNESS_VERSION})`);
}
