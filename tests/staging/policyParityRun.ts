/**
 * Collect one policy-parity snapshot on STAGING (`--policy-parity=before|after`).
 *
 * One REPEATABLE READ transaction, rolled back, read-only:
 *   - as postgres: the policy catalog, other catalog fingerprints (helpers,
 *     RLS flags, grants, role settings, v1/v2 definitions and ACLs,
 *     user_locations policies) and a privileged fixture fingerprint;
 *   - per role (owner, manager, staff, kiosk, cs, and a no-subject session):
 *     that role's REAL session claims (bound parameter), legacy overrides
 *     cleared, then `authenticated` with RLS on and authenticated's catalog
 *     statement_timeout, reading every saved event's (location, id) at each
 *     site, month by month. Each read is under a savepoint, so a timeout is
 *     recorded as an error for that role instead of aborting the snapshot.
 *
 * Never applies 0036 or any other change. Never logs claims.
 */
import type pg from "pg";
import { policyHash, rolesOf, PARITY_ROLES, PARITY_SITES, READER_PROBES, type Arrangement, type ParitySnapshot, type PolicyRow, type RoleSnapshot } from "./itemCountingPolicyParity";
import { STAGING_CUTOFF } from "./measure-item-counting";
import { claimsSetting } from "./generate-query-evidence";
import { V1_FUNCTION, V2_FUNCTION } from "./itemCountingEvidence";

export const APPLY_TIMEOUT = `do $$
declare entries text[];
begin
  select array_agg(c) into entries from pg_catalog.pg_roles r, unnest(r.rolconfig) c
  where r.rolname = 'authenticated' and c like 'statement_timeout=%';
  if entries is null or array_length(entries, 1) <> 1 then
    raise exception 'gate: authenticated must have exactly one statement_timeout setting';
  end if;
  execute format('set local statement_timeout = %L', substr(entries[1], length('statement_timeout=') + 1));
end $$`;

/**
 * Each direct app reader's own filters (src/components/*Card.tsx, Production,
 * Reports, Welcome), with "now" fixed at the cutoff so before/after read the
 * same windows. Limits/order are left out: results are compared as id sets
 * (the readers' unchanged limits apply on top of the same set).
 */
const C = `'${STAGING_CUTOFF}'::timestamptz`;
/**
 * Fixed sample orders for the order-lookup readers (Production, Reports search):
 * the synthetic orders VOL-<SITE>-20260915-1..3. Picking orders with a subquery
 * would sort every row of the site under RLS, which is not what those readers do.
 */
const SAMPLE_ORDERS = "order_number = any($2::text[])";
const sampleOrders = (site: string) => [1, 2, 3].map((g) => `VOL-${site.toUpperCase()}-20260915-${g}`);
const READER_SQL: Record<(typeof READER_PROBES)[number], string> = {
  "currently-clocked-in": `event_type in ('clock_in', 'clock_out') and created_at >= ${C} - interval '16 hours'`,
  "daily-timesheet": `event_type in ('clock_in', 'clock_out', 'started', 'completed', 'dispatched') and created_at >= '2026-09-14T14:00:00Z' and created_at < '2026-09-15T14:00:00Z'`,
  "labour-hours-today": `event_type in ('clock_in', 'clock_out', 'started', 'completed', 'dispatched') and created_at >= ${C} - interval '1 day' and created_at < ${C}`,
  "live-order-completions": `event_type in ('completed', 'dispatched') and created_at >= ${C} - interval '7 days'`,
  "package-history": `event_type in ('dispatched', 'completed') and created_at >= '2026-10-01T00:00:00Z'`,
  "recent-activity": `created_at >= ${C} - interval '7 days'`,
  "production-verified-lines": `${SAMPLE_ORDERS} and event_type in ('line_verified', 'cancelled')`,
  "production-counters": `staff_id = (select auth.uid()) and event_type in ('completed', 'dispatched') and created_at >= '2026-09-14T14:00:00Z'`,
  "reports-event-stream": `event_type in ('line_verified', 'cancelled', 'completed', 'dispatched') and created_at >= '2026-09-01T00:00:00Z' and created_at <= '2026-10-01T00:00:00Z'`,
  "reports-order-search": SAMPLE_ORDERS,
  "welcome-team": `event_type in ('completed', 'dispatched', 'line_verified') and created_at >= ${C} - interval '8 days'`,
};

/** A session with no subject: authenticated, but auth.uid() is NULL (must see nothing). */
const NO_SUBJECT_CLAIMS = JSON.stringify({ role: "authenticated", aud: "authenticated" });

async function one<T extends Record<string, unknown>>(client: pg.Client, sql: string, params: unknown[] = []): Promise<T> {
  return ((await client.query(sql, params)).rows[0] ?? {}) as T;
}

export async function catalog(client: pg.Client): Promise<ParitySnapshot["catalog"]> {
  const pol = await client.query(`select schemaname, tablename, policyname, permissive, roles::text[] as roles, cmd, qual, with_check
    from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'production_events' order by policyname`);
  const policies: PolicyRow[] = pol.rows.map((r) => ({
    schemaname: String(r.schemaname), tablename: String(r.tablename), policyname: String(r.policyname), permissive: String(r.permissive),
    roles: rolesOf(r.roles), cmd: String(r.cmd), qual: r.qual ?? null, with_check: r.with_check ?? null,
  }));
  const other = await one<Record<string, string>>(client, `select
    (select md5(string_agg(n.nspname || '.' || p.proname || ':' || pg_get_functiondef(p.oid), '|' order by n.nspname, p.proname))
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where (n.nspname = 'public' and p.proname in ('can_access_location', 'current_user_role', 'is_manager_or_higher', 'is_owner', 'is_kiosk_or_higher'))
         or (n.nspname = 'auth' and p.proname = 'uid')) as helpers,
    (select string_agg(relname || '=' || relrowsecurity || '/' || relforcerowsecurity, ',' order by relname)
       from pg_class where oid in ('public.production_events'::regclass, 'public.user_locations'::regclass)) as rls_flags,
    (select md5(string_agg(table_name || ':' || grantee || ':' || privilege_type, ',' order by table_name, grantee, privilege_type))
       from information_schema.role_table_grants where table_schema = 'public' and table_name in ('production_events', 'user_locations')) as table_grants,
    (select string_agg(rolname || '=' || coalesce(array_to_string(rolconfig, ';'), ''), ',' order by rolname)
       from pg_roles where rolname in ('anon', 'authenticated', 'authenticator', 'service_role')) as role_configs,
    (select md5(string_agg(p.proname || ':' || pg_get_functiondef(p.oid) || ':' || coalesce(p.proacl::text, ''), '|' order by p.proname))
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('${V1_FUNCTION}', '${V2_FUNCTION}')) as evidence_functions,
    (select md5(string_agg(policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), '|' order by policyname))
       from pg_policies where schemaname = 'public' and tablename = 'user_locations') as user_locations_policies`);
  return { policies, policyHash: policyHash(policies).hash, other: Object.fromEntries(Object.entries(other).map(([k, v]) => [k, String(v ?? "")])) };
}

async function fixture(client: pg.Client): Promise<Record<string, string>> {
  const r = await client.query(`select location, count(*)::text || ':' || md5(string_agg(
      id || '|' || created_at::text || '|' || event_type || '|' || staff_id::text || '|' || coalesce(order_number, '') || '|' ||
      coalesce(line_sku, '') || '|' || coalesce(line_quantity::text, '') || '|' || coalesce(parent_event_id, '') || '|' || coalesce(cs_case_id, ''),
      ',' order by id)) as fp
    from public.production_events group by location order by location`);
  return Object.fromEntries(r.rows.map((x) => [String(x.location), String(x.fp)]));
}

/** Month boundaries covering every saved event, with open ends. */
async function monthBounds(client: pg.Client): Promise<string[]> {
  const r = await one<{ lo: Date | null; hi: Date | null }>(client, "select min(created_at) as lo, max(created_at) as hi from public.production_events");
  const bounds = ["-infinity"];
  if (r.lo && r.hi) {
    const d = new Date(Date.UTC(r.lo.getUTCFullYear(), r.lo.getUTCMonth(), 1));
    while (d.getTime() <= r.hi.getTime()) {
      bounds.push(d.toISOString());
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    bounds.push(d.toISOString());
  }
  bounds.push("infinity");
  return bounds;
}

export interface ParityProgress {
  (line: string): void;
}

export async function collectParitySnapshot(
  client: pg.Client,
  opts: { mode: "before" | "after"; arrangement: Arrangement; revision: string; claimsText: Record<string, string>; log: ParityProgress },
): Promise<ParitySnapshot> {
  await client.query("begin isolation level repeatable read");
  try {
    for (const [role, text] of Object.entries(opts.claimsText)) {
      await client.query("select set_config($1, $2, true) is not null as ok", [claimsSetting(role), text]);
    }
    await client.query("select set_config($1, $2, true) is not null as ok", [claimsSetting("no-subject"), NO_SUBJECT_CLAIMS]);
    const cat = await catalog(client);
    const fx = await fixture(client);
    const bounds = await monthBounds(client);
    opts.log(`catalog captured (policies ${cat.policyHash.slice(0, 12)}), ${bounds.length - 1} month chunks per site`);

    const roles: ParitySnapshot["roles"] = {};
    for (const role of PARITY_ROLES) {
      const snap: RoleSnapshot = { profileRole: null, memberships: "", claimsBytes: null, visible: {}, errors: [] };
      roles[role] = snap;
      await client.query("reset role");
      await client.query("select set_config('request.jwt.claims', current_setting($1), true) is not null as ok", [claimsSetting(role)]);
      await client.query("select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', '', true)");
      const who = await one<{ profile_role: string | null; memberships: string | null; claims_bytes: number }>(client,
        `select (select p.role from public.profiles p where p.user_id::text = c.j ->> 'sub') as profile_role,
                (select string_agg(ul.location, ',' order by ul.location) from public.user_locations ul where ul.user_id::text = c.j ->> 'sub') as memberships,
                octet_length(current_setting('request.jwt.claims')) as claims_bytes
           from (select current_setting('request.jwt.claims')::json as j) c`);
      snap.profileRole = who.profile_role ?? null;
      snap.memberships = who.memberships ?? "";
      snap.claimsBytes = Number(who.claims_bytes);
      await client.query("set local role authenticated");
      await client.query(APPLY_TIMEOUT);
      const env = await one<{ u: string; rls: string; t: string }>(client, "select current_user as u, current_setting('row_security') as rls, current_setting('statement_timeout') as t");
      if (env.u !== "authenticated" || env.rls !== "on") snap.errors.push(`read as ${env.u} with row_security ${env.rls}`);
      let rows = 0;
      for (const site of PARITY_SITES) {
        const keys: string[] = [];
        for (let i = 0; i + 1 < bounds.length && !snap.errors.length; i++) {
          await client.query("savepoint parity_read");
          try {
            const r = await client.query(
              "select location || '|' || id as k from public.production_events where location = $1 and created_at >= $2::timestamptz and created_at < $3::timestamptz",
              [site, bounds[i], bounds[i + 1]],
            );
            for (const x of r.rows) keys.push(String(x.k));
            await client.query("release savepoint parity_read");
          } catch (e) {
            await client.query("rollback to savepoint parity_read");
            snap.errors.push(`reading ${site} ${bounds[i]}..${bounds[i + 1]} failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        keys.sort();
        snap.visible[site] = keys;
        rows += keys.length;
      }
      snap.readers = {};
      for (const probe of READER_PROBES) {
        for (const site of PARITY_SITES) {
          if (snap.errors.length) break;
          await client.query("savepoint parity_read");
          try {
            const sql = READER_SQL[probe];
            const r = await client.query(`select id from public.production_events where location = $1 and (${sql})`, sql.includes("$2") ? [site, sampleOrders(site)] : [site]);
            snap.readers[`${probe}:${site}`] = r.rows.map((x) => String(x.id)).sort();
            await client.query("release savepoint parity_read");
          } catch (e) {
            await client.query("rollback to savepoint parity_read");
            snap.errors.push(`reader ${probe} at ${site} failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      opts.log(`${role}: ${rows.toLocaleString("en")} visible rows (memberships ${snap.memberships || "none"})${snap.errors.length ? ` · ERROR ${snap.errors[0]}` : ""}`);
    }
    return { mode: opts.mode, arrangement: opts.arrangement, capturedAt: new Date().toISOString(), revision: opts.revision, catalog: cat, fixture: fx, roles };
  } finally {
    await client.query("rollback").catch(() => {});
  }
}
