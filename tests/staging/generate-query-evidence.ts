/**
 * Regenerates supabase/staging/item-counting/03-query-evidence.sql from
 * migration 0034 and MEASURE_CASES / STAGING_CUTOFF, so the SQL evidence and
 * the timed loads always use the same scopes, cutoff and function body.
 *
 *   npx vite-node tests/staging/generate-query-evidence.ts --write
 */
import { readFileSync, writeFileSync } from "node:fs";
import { productionRange } from "../../src/lib/domain/productionPeriods";
import { MEASURE_CASES, STAGING_CUTOFF } from "./measure-item-counting";

const mig = readFileSync("supabase/migrations/0034_load_production_evidence.sql", "utf8").replace(/\r\n/g, "\n");
const body = /AS \$fn\$\r?\n([\s\S]*?)\r?\n\$fn\$;/.exec(mig)![1];

const scopes = MEASURE_CASES.map((c) => {
  const r = productionRange(c.site, c.first, c.last);
  return { scope: c.scope, site: c.site, s: r.startUtc, e: r.endUtcExclusive };
});
const lit = (v: string) => `'${v}'`;
const ts = (v: string) => `'${v}'::timestamptz`;
const C = STAGING_CUTOFF;
const call = (site: string, s: string, e: string) => `public.load_production_evidence(${lit(site)}, ${ts(s)}, ${ts(e)}, ${ts(C)})`;
const bodyWith = (site: string, s: string, e: string) =>
  body.replace(/p_site/g, `${lit(site)}::text`).replace(/p_start_utc/g, ts(s))
    .replace(/p_end_utc_exclusive/g, ts(e)).replace(/p_as_of_utc/g, ts(C));

function become(role: string): string {
  return `reset role;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users where email = '${role}@inka-staging.test'),
                    'role', 'authenticated')::text, true) as become_${role};
set local role authenticated;`;
}

function independent(role: string, scope: string, site: string, s: string, e: string): string {
  const W = `pe.location = ${lit(site)} and pe.created_at >= ${ts(s)} and pe.created_at < ${ts(e)} and pe.created_at <= ${ts(C)}`;
  return `-- independent expectation (EXISTS form, not the function's IN form)
with w as (
  select pe.id, pe.event_type, pe.order_number, pe.parent_event_id from public.production_events pe
  where ${W} and pe.event_type in ('line_verified', 'completed', 'dispatched', 'cancelled')
), q as (
  select x.id from public.production_events x
  where x.location = ${lit(site)} and x.event_type = 'line_verified' and x.created_at < ${ts(s)} and x.created_at <= ${ts(C)}
    and exists (select 1 from w where w.event_type in ('completed', 'dispatched')
                and coalesce(btrim(w.order_number), '') <> '' and w.order_number = x.order_number)
), p as (
  select x.id from public.production_events x
  where x.location = ${lit(site)} and x.created_at < ${ts(s)} and x.created_at <= ${ts(C)}
    and exists (select 1 from w where w.event_type = 'cancelled' and coalesce(w.parent_event_id, '') <> '' and w.parent_event_id = x.id)
), l as (
  select x.id from public.production_events x
  where x.location = ${lit(site)} and x.event_type = 'cancelled' and x.created_at >= ${ts(e)} and x.created_at <= ${ts(C)}
    and exists (select 1 from w where w.event_type in ('line_verified', 'completed', 'dispatched') and w.id = x.parent_event_id)
)
select '${role}' as role, '${scope}' as scope,
  (${call(site, s, e)} ->> 'rowCount')::bigint as fn_row_count,
  (select count(*) from w) as window_rows,
  (select count(*) from q) as qualification_rows,
  (select count(*) from p) as parent_rows,
  (select count(*) from l) as later_rows,
  (select count(*) from (select id from w union select id from q union select id from p union select id from l) u) as independent_total;`;
}

/** The full 03-query-evidence.sql text (pure; LF line endings). */
export function buildQueryEvidenceSql(): string {
const parts: string[] = [];
parts.push(`-- item-counting · Task 4 staging gate · step 3 of 3: function, plan and expectation evidence
--
-- GENERATED from supabase/migrations/0034_load_production_evidence.sql and
-- tests/staging/measure-item-counting.ts (MEASURE_CASES, STAGING_CUTOFF).
-- STAGING ONLY. Read-only: everything runs inside a transaction that is
-- rolled back. Needs migration 0034 applied on staging first (CJ).
--
-- 1. Function signature, security, settings and grants from the catalogs.
-- 2. For the owner and manager test users (authenticated role, RLS on), for
--    each of the six scopes:
--      - EXPLAIN (ANALYZE, BUFFERS) of the function call, three labelled runs
--      - EXPLAIN (ANALYZE, BUFFERS) of the exact function body with the same
--        arguments (the call's plan hides the internals)
--      - an independent expectation: the four families written with EXISTS,
--        counted, compared with the function's rowCount
-- 3. Small fixtures: staff, an empty window and invalid input.
-- Fixed cutoff for every scope: ${C}.
--
-- Labels: every EXPLAIN's first line selects 'gate:<kind>:<role>:<scope>:<run>' as gate.`);
parts.push("begin;");
parts.push(`-- function catalog evidence
select p.proname as fn_name,
       pg_get_function_identity_arguments(p.oid) as fn_args,
       pg_get_function_result(p.oid) as fn_result,
       l.lanname as fn_language,
       p.provolatile as fn_volatility,
       p.prosecdef as fn_security_definer,
       coalesce(array_to_string(p.proconfig, ','), '') as fn_config,
       md5(pg_get_functiondef(p.oid)) as fn_definition_md5
from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
where n.nspname = 'public' and p.proname = 'load_production_evidence';`);
parts.push(`-- function privileges
select r.grantee as fn_grantee,
       case when r.grantee = 'PUBLIC'
            then exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where p.oid = 'public.load_production_evidence(text, timestamptz, timestamptz, timestamptz)'::regprocedure
                           and a.grantee = 0 and a.privilege_type = 'EXECUTE')
            else has_function_privilege(r.grantee, 'public.load_production_evidence(text, timestamptz, timestamptz, timestamptz)', 'EXECUTE')
       end as can_execute
from (values ('PUBLIC'), ('anon'), ('authenticated'), ('service_role')) r(grantee);`);
parts.push(`select pg_size_pretty(pg_total_relation_size('public.production_events')) as total_size,
       (select count(*) from public.production_events) as rows;`);
parts.push("analyze public.production_events;");

for (const role of ["owner", "manager"]) {
  parts.push(become(role));
  for (const sc of scopes) {
    for (let run = 1; run <= 3; run++) {
      parts.push(`explain (analyze, buffers) select 'gate:call:${role}:${sc.scope}:${run}' as gate,\n  ${call(sc.site, sc.s, sc.e)};`);
    }
    parts.push(`explain (analyze, buffers) select 'gate:body:${role}:${sc.scope}:1' as gate, (\n${bodyWith(sc.site, sc.s, sc.e).trim()}\n) as evidence;`);
    parts.push(independent(role, sc.scope, sc.site, sc.s, sc.e));
  }
}

// Small fixtures.
const auDay = scopes.find((s) => s.scope === "au-busy-day")!;
parts.push(become("staff"));
parts.push(independent("staff", "au-busy-day", "au", auDay.s, auDay.e));
parts.push(become("owner"));
parts.push(`-- empty window and invalid input
select (${call("au", "2020-01-01T13:00:00.000Z", "2020-01-02T13:00:00.000Z")} ->> 'rowCount')::bigint as empty_window_row_count,
       public.load_production_evidence('au', '2026-09-15T00:00:00Z', '2026-09-14T00:00:00Z', '${C}') is null as reversed_window_is_null,
       public.load_production_evidence(' ', '2026-09-14T00:00:00Z', '2026-09-15T00:00:00Z', '${C}') is null as blank_site_is_null,
       public.load_production_evidence('au', 'infinity', '2026-09-15T00:00:00Z', '${C}') is null as infinite_start_is_null;`);
parts.push("rollback;");
return parts.join("\n\n") + "\n";
}

// Write only when asked (vite-node hides the script path from argv; tests import this module).
if (process.argv.includes("--write")) {
  writeFileSync("supabase/staging/item-counting/03-query-evidence.sql", buildQueryEvidenceSql(), "utf8");
  console.log(`wrote 03-query-evidence.sql (${scopes.length} scopes)`);
}
