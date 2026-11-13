/**
 * Collect policy-parity evidence on STAGING.
 *
 * `--policy-parity=before|after` (history): one REPEATABLE READ transaction,
 * rolled back, read-only:
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
 * `--policy-parity=cases` (Task 4 M6 amendment, acceptance): the four cases in
 * ONE REPEATABLE READ transaction that always ends in ROLLBACK. Each case
 * changes one user's memberships under a savepoint, reads under installed
 * 0036, then under a nested savepoint restores the exact pre-0036 SELECT
 * policies (the plan's Policy rollback body, without BEGIN/COMMIT) and reads
 * again. After ROLLBACK a fresh statement re-checks memberships, policies and
 * fixture (the restoration check).
 *
 * Never applies 0036, a migration or any committed change. Never logs claims.
 */
import { randomUUID } from "node:crypto";
import { checkPolicySet, policyHash, rolesOf, PARITY_ROLES, PARITY_SITES, READER_PROBES, type Arrangement, type ParitySnapshot, type PolicyRow, type RoleSnapshot } from "./itemCountingPolicyParity";
import {
  CASE_METHOD,
  CASE_SPECS,
  CASE_USERS,
  caseMemberships,
  compareCase,
  fixtureHash,
  PARITY_CASES,
  STANDARD_MEMBERSHIPS,
  type CaseCollection,
  type CaseEvidence,
  type CaseSide,
  type CaseUser,
  type ParityCase,
} from "./itemCountingParityCases";
import { STAGING_CUTOFF } from "./measure-item-counting";
import { claimsSetting } from "./generate-query-evidence";
import { V1_FUNCTION, V2_FUNCTION } from "./itemCountingEvidence";

/** Minimal client surface the collectors use (pg.Client satisfies it; tests use a fake). */
export interface QueryClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

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
 * The plan's Policy rollback body (Release and rollback), without BEGIN/COMMIT:
 * restores the two original 0012/0033 SELECT policies with unqualified names,
 * permissive/PUBLIC defaults and unwrapped helper calls. Only ever run inside a
 * savepoint of a transaction that is rolled back.
 */
export const PRE_0036_RESTORE = [
  "set local search_path = public",
  "drop policy production_events_read on public.production_events",
  "drop policy production_events_select on public.production_events",
  `create policy production_events_read on production_events for select
  using (can_access_location(location) and (staff_id = auth.uid() or is_manager_or_higher()))`,
  `create policy production_events_select on production_events for select
  using (can_access_location(location) and (staff_id = auth.uid() or current_user_role() in ('owner', 'manager', 'cs', 'kiosk')))`,
];

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
export const NO_SUBJECT_CLAIMS = JSON.stringify({ role: "authenticated", aud: "authenticated" });

async function one<T extends Record<string, unknown>>(client: QueryClient, sql: string, params: unknown[] = []): Promise<T> {
  return ((await client.query(sql, params)).rows[0] ?? {}) as T;
}

export async function catalog(client: QueryClient): Promise<ParitySnapshot["catalog"]> {
  const pol = await client.query(`select schemaname, tablename, policyname, permissive, roles::text[] as roles, cmd, qual, with_check
    from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'production_events' order by policyname`);
  const policies: PolicyRow[] = pol.rows.map((r) => ({
    schemaname: String(r.schemaname), tablename: String(r.tablename), policyname: String(r.policyname), permissive: String(r.permissive),
    roles: rolesOf(r.roles), cmd: String(r.cmd), qual: (r.qual as string | null) ?? null, with_check: (r.with_check as string | null) ?? null,
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

export async function fixture(client: QueryClient): Promise<Record<string, string>> {
  const r = await client.query(`select location, count(*)::text || ':' || md5(string_agg(
      id || '|' || created_at::text || '|' || event_type || '|' || staff_id::text || '|' || coalesce(order_number, '') || '|' ||
      coalesce(line_sku, '') || '|' || coalesce(line_quantity::text, '') || '|' || coalesce(parent_event_id, '') || '|' || coalesce(cs_case_id, ''),
      ',' order by id)) as fp
    from public.production_events group by location order by location`);
  return Object.fromEntries(r.rows.map((x) => [String(x.location), String(x.fp)]));
}

/** Month boundaries covering every saved event, with open ends. */
export async function monthBounds(client: QueryClient): Promise<string[]> {
  const r = await one<{ lo: Date | string | null; hi: Date | string | null }>(client, "select min(created_at) as lo, max(created_at) as hi from public.production_events");
  const bounds = ["-infinity"];
  if (r.lo && r.hi) {
    const lo = new Date(r.lo);
    const hi = new Date(r.hi);
    const d = new Date(Date.UTC(lo.getUTCFullYear(), lo.getUTCMonth(), 1));
    while (d.getTime() <= hi.getTime()) {
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

function roleLine(role: string, snap: RoleSnapshot): string {
  const rows = Object.values(snap.visible).reduce((n, k) => n + k.length, 0);
  return `${role}: ${rows.toLocaleString("en")} visible rows (memberships ${snap.memberships || "none"})${snap.errors.length ? ` · ERROR ${snap.errors[0]}` : ""}`;
}

/**
 * Read one identity's complete per-site row sets (month by month) and the 11
 * direct-reader replays as `authenticated` with RLS on, its real session
 * claims (already bound under claimsSetting(role)), legacy overrides cleared
 * and authenticated's catalog statement_timeout (reapplied and verified after
 * the role switch). Ends back as postgres. `counters.foreign` receives the
 * number of visible rows not saved by the session's own subject.
 */
export async function readRoleSnapshot(client: QueryClient, role: string, bounds: readonly string[], counters?: { foreign?: number | null }): Promise<RoleSnapshot> {
  const snap: RoleSnapshot = { profileRole: null, memberships: "", claimsBytes: null, visible: {}, errors: [] };
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
  const env = await one<{ u: string; rls: string; t: string; bypass: boolean | null }>(client,
    "select current_user as u, current_setting('row_security') as rls, current_setting('statement_timeout') as t, (select r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = current_user) as bypass");
  if (env.u !== "authenticated" || env.rls !== "on" || env.bypass !== false) snap.errors.push(`read as ${env.u} with row_security ${env.rls}${env.bypass === false ? "" : " and bypass-RLS not verified off"}`);
  if (!env.t || env.t === "0") snap.errors.push(`the catalog statement_timeout was not applied (${env.t ?? "none"})`);
  let foreign = 0;
  for (const site of PARITY_SITES) {
    const keys: string[] = [];
    for (let i = 0; i + 1 < bounds.length && !snap.errors.length; i++) {
      await client.query("savepoint parity_read");
      try {
        const r = await client.query(
          "select location || '|' || id as k, (staff_id is distinct from (select auth.uid())) as foreign_row from public.production_events where location = $1 and created_at >= $2::timestamptz and created_at < $3::timestamptz",
          [site, bounds[i], bounds[i + 1]],
        );
        for (const x of r.rows) {
          keys.push(String(x.k));
          if (x.foreign_row === true) foreign++;
        }
        await client.query("release savepoint parity_read");
      } catch (e) {
        await client.query("rollback to savepoint parity_read");
        snap.errors.push(`reading ${site} ${bounds[i]}..${bounds[i + 1]} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    keys.sort();
    snap.visible[site] = keys;
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
  await client.query("reset role");
  if (counters) counters.foreign = snap.errors.length ? null : foreign;
  return snap;
}

async function bindClaims(client: QueryClient, claimsText: Record<string, string>): Promise<void> {
  for (const [role, text] of Object.entries(claimsText)) {
    await client.query("select set_config($1, $2, true) is not null as ok", [claimsSetting(role), text]);
  }
  await client.query("select set_config($1, $2, true) is not null as ok", [claimsSetting("no-subject"), NO_SUBJECT_CLAIMS]);
}

export async function collectParitySnapshot(
  client: QueryClient,
  opts: { mode: "before" | "after"; arrangement: Arrangement; revision: string; claimsText: Record<string, string>; log: ParityProgress },
): Promise<ParitySnapshot> {
  await client.query("begin isolation level repeatable read");
  try {
    await bindClaims(client, opts.claimsText);
    const cat = await catalog(client);
    const fx = await fixture(client);
    const bounds = await monthBounds(client);
    opts.log(`catalog captured (policies ${cat.policyHash.slice(0, 12)}), ${bounds.length - 1} month chunks per site`);

    const roles: ParitySnapshot["roles"] = {};
    for (const role of PARITY_ROLES) {
      roles[role] = await readRoleSnapshot(client, role, bounds);
      opts.log(roleLine(role, roles[role]!));
    }
    return { mode: opts.mode, arrangement: opts.arrangement, capturedAt: new Date().toISOString(), revision: opts.revision, catalog: cat, fixture: fx, roles };
  } finally {
    await client.query("rollback").catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Four-case collection (`--policy-parity=cases`)
// ---------------------------------------------------------------------------

/** A condition that ends the collection early (recorded, then rolled back). */
class StopCollection extends Error {}

export interface CaseParityOptions {
  revision: string;
  /** Exact claims text per test user (owner, manager, staff, kiosk, cs): in memory only. */
  claimsText: Record<string, string>;
  /** The original pre-0036 baseline policy hash (restoration authority). */
  baselinePolicyHash: string | null;
  /** The retained post-0036 hash the installed catalog must match, when one is recorded. */
  expectedInstalledHash: string | null;
  log: ParityProgress;
  /** Cancellation: checked between steps; the transaction is still rolled back. */
  signal?: AbortSignal;
  newId?: () => string;
  now?: () => string;
}

/** Test-user ids from their own session claims (`sub`), never printed. */
function subjects(claimsText: Record<string, string>): Record<CaseUser, string> {
  const out = {} as Record<CaseUser, string>;
  for (const u of CASE_USERS) {
    let sub: unknown;
    try {
      sub = (JSON.parse(claimsText[u] ?? "") as { sub?: unknown }).sub;
    } catch {
      sub = undefined;
    }
    if (typeof sub !== "string" || !/^[0-9a-f-]{36}$/i.test(sub)) throw new StopCollection(`the ${u} session has no valid subject`);
    out[u] = sub;
  }
  return out;
}

async function membershipsOf(client: QueryClient, ids: Record<CaseUser, string>): Promise<Record<string, string[]>> {
  const r = await client.query("select user_id::text as u, location from public.user_locations where user_id = any($1::uuid[]) order by location", [Object.values(ids)]);
  const byId = new Map(Object.entries(ids).map(([u, id]) => [id, u]));
  const out: Record<string, string[]> = Object.fromEntries(CASE_USERS.map((u) => [u, [] as string[]]));
  for (const row of r.rows) {
    const u = byId.get(String(row.u));
    if (u) out[u].push(String(row.location));
  }
  for (const u of CASE_USERS) out[u].sort();
  return out;
}

function membershipProblems(got: Record<string, string[]>, want: Readonly<Record<CaseUser, readonly string[]>>, at: string): string[] {
  return CASE_USERS.filter((u) => [...(got[u] ?? [])].sort().join(",") !== [...want[u]].sort().join(","))
    .map((u) => `${at}: ${u} memberships are ${(got[u] ?? []).join(",") || "none"}, expected ${[...want[u]].sort().join(",")}`);
}

async function readSide(client: QueryClient, kase: ParityCase, bounds: readonly string[], searchPath: string, label: string, log: ParityProgress): Promise<CaseSide> {
  await client.query("reset role");
  await client.query("select set_config('search_path', $1, true) is not null as ok", [searchPath]);
  const cat = await catalog(client);
  const roles: CaseSide["roles"] = {};
  let staffForeignRows: number | null = null;
  for (const role of CASE_SPECS[kase].roles) {
    const counters: { foreign?: number | null } = {};
    roles[role] = await readRoleSnapshot(client, role, bounds, counters);
    if (role === "staff") staffForeignRows = counters.foreign ?? null;
    log(`${kase} · ${label} · ${roleLine(role, roles[role]!)}`);
  }
  return { policies: cat.policies, policyHash: cat.policyHash, other: cat.other, roles, staffForeignRows: CASE_SPECS[kase].roles.includes("staff") ? staffForeignRows : null };
}

/**
 * Collect all four cases in one rolled-back REPEATABLE READ transaction, then
 * run the fresh restoration check. Always returns a collection; any failure is
 * in `problems` (or the restoration result), never hidden by a later success.
 */
export async function collectCaseParity(client: QueryClient, opts: CaseParityOptions): Promise<CaseCollection> {
  const now = opts.now ?? (() => new Date().toISOString());
  const coll: CaseCollection = {
    collectionId: (opts.newId ?? randomUUID)(), capturedAt: now(), revision: opts.revision, method: CASE_METHOD, cutoff: STAGING_CUTOFF, bounds: [],
    fixture: {}, fixtureHash: "", baselinePolicyHash: opts.baselinePolicyHash ?? "", installedPolicyHash: "",
    startMemberships: {}, staffOtherWorkerRows: {}, cases: [], comparisons: [], restoration: null, problems: [],
  };
  const checkAbort = () => {
    if (opts.signal?.aborted) throw new StopCollection("cancelled before completion");
  };
  let ids: Record<CaseUser, string>;
  try {
    ids = subjects(opts.claimsText);
    if (!opts.baselinePolicyHash) throw new StopCollection("the original pre-0036 baseline snapshot is missing; nothing to restore against");
  } catch (e) {
    coll.problems.push(e instanceof Error ? e.message : String(e));
    return coll;
  }

  let began = false;
  let rolledBack = false;
  try {
    checkAbort();
    await client.query("begin isolation level repeatable read");
    began = true;
    await bindClaims(client, opts.claimsText);
    const searchPath = String((await one<{ p: string }>(client, "select current_setting('search_path') as p")).p ?? "");
    const cat = await catalog(client);
    coll.installedPolicyHash = cat.policyHash;
    const pol = checkPolicySet(cat.policies, "post");
    if (pol.length) throw new StopCollection(`installed policies are not the approved post-0036 set: ${pol[0]}`);
    if (opts.expectedInstalledHash && cat.policyHash !== opts.expectedInstalledHash) {
      throw new StopCollection(`installed policy hash ${cat.policyHash.slice(0, 12)} is not the retained post-0036 hash ${opts.expectedInstalledHash.slice(0, 12)}`);
    }
    coll.fixture = await fixture(client);
    coll.fixtureHash = fixtureHash(coll.fixture);
    coll.bounds = await monthBounds(client);
    coll.startMemberships = await membershipsOf(client, ids);
    const start = membershipProblems(coll.startMemberships, STANDARD_MEMBERSHIPS, "start");
    if (start.length) throw new StopCollection(`memberships are not standard at the start (${start[0]})`);
    const other = await client.query("select location, count(*)::int as n from public.production_events where staff_id is distinct from $1::uuid group by location order by location", [ids.staff]);
    coll.staffOtherWorkerRows = Object.fromEntries(other.rows.map((r) => [String(r.location), Number(r.n)]));
    opts.log(`installed policies ${cat.policyHash.slice(0, 12)} · fixture ${coll.fixtureHash.slice(0, 12)} · ${coll.bounds.length - 1} month chunks per site · standard memberships`);

    for (const kase of PARITY_CASES) {
      checkAbort();
      await client.query("reset role");
      await client.query("savepoint parity_case");
      let ev: CaseEvidence | null = null;
      try {
        const ch = CASE_SPECS[kase].change;
        if (ch) {
          for (const site of ch.add) await client.query("insert into public.user_locations (user_id, location) values ($1::uuid, $2)", [ids[ch.user], site]);
          for (const site of ch.remove) {
            const r = await client.query("delete from public.user_locations where user_id = $1::uuid and location = $2", [ids[ch.user], site]);
            if (r.rowCount !== 1) throw new StopCollection(`${kase}: removing ${ch.user} ${site} changed ${r.rowCount ?? 0} rows`);
          }
        }
        const memberships = await membershipsOf(client, ids);
        coll.problems.push(...membershipProblems(memberships, caseMemberships(kase), kase));
        opts.log(`${kase}: ${ch ? `${ch.user} ${[...ch.add.map((s) => `+${s}`), ...ch.remove.map((s) => `-${s}`)].join(" ")}` : "no membership change"}`);
        const after = await readSide(client, kase, coll.bounds, searchPath, "installed 0036", opts.log);
        checkAbort();
        await client.query("savepoint parity_pre");
        let before: CaseSide;
        try {
          for (const sql of PRE_0036_RESTORE) await client.query(sql);
          before = await readSide(client, kase, coll.bounds, searchPath, "restored pre-0036", opts.log);
        } finally {
          await client.query("reset role");
          await client.query("rollback to savepoint parity_pre");
        }
        const back = await catalog(client);
        if (back.policyHash !== coll.installedPolicyHash) coll.problems.push(`${kase}: 0036 policies were not back after the nested rollback`);
        ev = { case: kase, memberships, before, after };
      } finally {
        await client.query("reset role");
        await client.query("rollback to savepoint parity_case");
      }
      if (ev) coll.cases.push(ev);
      const restored = membershipProblems(await membershipsOf(client, ids), STANDARD_MEMBERSHIPS, `after ${kase}`);
      if (restored.length) throw new StopCollection(`memberships were not standard after the ${kase} savepoint (${restored[0]})`);
    }
  } catch (e) {
    coll.problems.push(e instanceof Error ? e.message : String(e));
  } finally {
    if (began) {
      try {
        await client.query("rollback");
        rolledBack = true;
      } catch (e) {
        coll.problems.push(`the parity transaction's ROLLBACK could not be confirmed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  coll.comparisons = coll.cases.map((ev) => compareCase(coll, ev));
  if (began && !rolledBack) return coll;
  // Fresh statements outside the rolled-back snapshot.
  const problems: string[] = [];
  try {
    problems.push(...membershipProblems(await membershipsOf(client, ids), STANDARD_MEMBERSHIPS, "after rollback"));
    const cat = await catalog(client);
    if (coll.installedPolicyHash && cat.policyHash !== coll.installedPolicyHash) problems.push(`after rollback: policy hash ${cat.policyHash.slice(0, 12)} is not the installed ${coll.installedPolicyHash.slice(0, 12)}`);
    if (coll.fixtureHash && fixtureHash(await fixture(client)) !== coll.fixtureHash) problems.push("after rollback: the fixture fingerprint changed");
    coll.restoration = { checkedAt: now(), passed: problems.length === 0, problems };
    opts.log(problems.length ? `restoration check FAILED: ${problems[0]}` : "restoration check: standard memberships, installed 0036 and the same fixture");
  } catch (e) {
    coll.restoration = { checkedAt: now(), passed: false, problems: [`the restoration check could not run: ${e instanceof Error ? e.message : String(e)}`] };
  }
  return coll;
}
