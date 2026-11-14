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
  CASE_TIMEOUT_MS,
  timeoutMs,
  type BaselineCatalog,
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
 * Each direct app reader of production_events, replayed with its OWN columns,
 * filters, order and limit (src/components/*Card.tsx, Production, Reports),
 * with "now" fixed at the cutoff and every window closed at the cutoff. Rows
 * come back as JSON text in the reader's order; `id` is added as the final
 * tie-breaker so equal timestamps cannot reorder between the two sides.
 * Per-order readers read the three fixed sample orders, ordered by order (and
 * department) first, which is exactly the concatenation of the per-order reads.
 *   $1 = site, $2 = cutoff, $3 = sample orders.
 */
interface ReaderSpec {
  cols: string;
  where: string;
  order: string | null;
  limit?: number;
  orders?: boolean;
}
const SAMPLE = "order_number = any($3::text[])";
export const sampleOrders = (site: string) => [1, 2, 3].map((g) => `VOL-${site.toUpperCase()}-20260915-${g}`);
export const READER_SPECS: Record<(typeof READER_PROBES)[number], ReaderSpec> = {
  // CurrentlyClockedInCard: last 16 hours of clock events, oldest first.
  "currently-clocked-in": { cols: "staff_id, event_type, created_at", where: "event_type in ('clock_in', 'clock_out') and created_at >= $2::timestamptz - interval '16 hours' and created_at <= $2::timestamptz", order: "created_at asc, id asc" },
  // DailyTimesheetCard: one site-local day [start, end), oldest first.
  "daily-timesheet": { cols: "staff_id, event_type, order_number, created_at", where: "event_type in ('clock_in', 'clock_out', 'started', 'completed', 'dispatched') and created_at >= '2026-09-14T14:00:00Z' and created_at < '2026-09-15T14:00:00Z'", order: "created_at asc, id asc" },
  // LabourHoursTodayCard: the day before the cutoff, oldest first.
  "labour-hours-today": { cols: "staff_id, event_type, order_number, created_at", where: "event_type in ('clock_in', 'clock_out', 'started', 'completed', 'dispatched') and created_at >= $2::timestamptz - interval '1 day' and created_at < $2::timestamptz", order: "created_at asc, id asc" },
  // LiveOrderCompletionsCard: last 7 days, newest first, limit 500.
  "live-order-completions": { cols: "id, created_at, staff_id, order_number, department, event_type", where: "event_type in ('completed', 'dispatched') and created_at >= $2::timestamptz - interval '7 days' and created_at <= $2::timestamptz", order: "created_at desc, id desc", limit: 500 },
  // PackageHistoryCard: from its window start, oldest first, all pages.
  "package-history": { cols: "order_number, department, event_type, created_at", where: "event_type in ('dispatched', 'completed') and created_at >= '2026-10-01T00:00:00Z' and created_at <= $2::timestamptz", order: "created_at asc, id asc" },
  // RecentActivityCard: last 7 days, unordered (compared as a sorted multiset).
  "recent-activity": { cols: "order_number, department, line_quantity, event_type, created_at", where: "created_at >= $2::timestamptz - interval '7 days' and created_at <= $2::timestamptz", order: null },
  // Production verified lines: per order and department, oldest first.
  "production-verified-lines": { cols: "id, parent_event_id, event_type, staff_id, department, line_sku, created_at", where: `${SAMPLE} and event_type in ('line_verified', 'cancelled') and created_at <= $2::timestamptz`, order: "order_number asc, department asc, created_at asc, id asc", orders: true },
  // Production clock-state check: the session's own latest clock event since the day start, limit 1.
  "production-clock-state": { cols: "event_type, created_at", where: "staff_id = (select auth.uid()) and event_type in ('clock_in', 'clock_out') and created_at >= '2026-11-11T00:00:00Z' and created_at <= $2::timestamptz", order: "created_at desc, id desc", limit: 1 },
  // Reports CSV export extras: one production range, by time then id.
  "reports-export-extras": { cols: "id, station_id, note", where: "event_type in ('line_verified', 'cancelled', 'completed', 'dispatched') and created_at >= '2026-09-01T00:00:00Z' and created_at < '2026-10-01T00:00:00Z'", order: "created_at asc, id asc" },
  // Reports order lookup (loadOrderLookup): every column, up to the cutoff, newest first.
  "reports-order-search": { cols: "*", where: `${SAMPLE} and created_at <= $2::timestamptz`, order: "order_number asc, created_at desc, id desc", orders: true },
  // Production order status: one order's events, newest first.
  "production-order-events": { cols: "event_type, department, created_at", where: `${SAMPLE} and created_at <= $2::timestamptz`, order: "order_number asc, created_at desc, id desc", orders: true },
};

/** The SQL for one reader replay: rows as JSON text, in the reader's own order. */
export function readerSql(probe: (typeof READER_PROBES)[number]): string {
  const r = READER_SPECS[probe];
  const order = r.order ?? "id";
  const inner = `select ${r.cols === "*" ? "e.*" : r.cols}, row_number() over (order by ${order}) as parity_ord
      from public.production_events e where location = $1 and (${r.where}) order by ${order}${r.limit ? ` limit ${r.limit}` : ""}`;
  return `select (to_jsonb(t) - 'parity_ord')::text as j from (${inner}) t order by t.parity_ord`;
}

/** The highest `$N` placeholder a statement uses (Postgres requires exactly that many bind values). */
export function placeholderCount(sql: string): number {
  let n = 0;
  for (const m of sql.matchAll(/\$(\d+)/g)) n = Math.max(n, Number(m[1]));
  return n;
}

/** Bind values for one reader replay: only the placeholders its SQL uses. */
export function readerParams(probe: (typeof READER_PROBES)[number], site: string): unknown[] {
  return [site, STAGING_CUTOFF, sampleOrders(site)].slice(0, placeholderCount(readerSql(probe)));
}

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
 * Read one identity's complete per-site row sets (month by month, up to the
 * fixed cutoff) and the 11 direct-reader replays as `authenticated` with RLS
 * on, its real session claims (already bound under claimsSetting(role)),
 * legacy overrides cleared and authenticated's catalog statement_timeout
 * (reapplied and recorded after the role switch). Records the session's
 * subject, read environment and per-site rows not saved by that subject.
 * Ends back as postgres.
 */
export async function readRoleSnapshot(client: QueryClient, role: string, bounds: readonly string[]): Promise<RoleSnapshot> {
  const snap: RoleSnapshot = { profileRole: null, memberships: "", claimsBytes: null, visible: {}, errors: [], foreign: {} };
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', current_setting($1), true) is not null as ok", [claimsSetting(role)]);
  await client.query("select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', '', true)");
  const who = await one<{ profile_role: string | null; memberships: string | null; claims_bytes: number; subject: string | null }>(client,
    `select (select p.role from public.profiles p where p.user_id::text = c.j ->> 'sub') as profile_role,
            (select string_agg(ul.location, ',' order by ul.location) from public.user_locations ul where ul.user_id::text = c.j ->> 'sub') as memberships,
            octet_length(current_setting('request.jwt.claims')) as claims_bytes,
            c.j ->> 'sub' as subject
       from (select current_setting('request.jwt.claims')::json as j) c`);
  snap.profileRole = who.profile_role ?? null;
  snap.memberships = who.memberships ?? "";
  snap.claimsBytes = Number(who.claims_bytes);
  snap.subject = who.subject ?? null;
  await client.query("set local role authenticated");
  await client.query(APPLY_TIMEOUT);
  const env = await one<{ u: string; rls: string; t: string; bypass: boolean | null }>(client,
    "select current_user as u, current_setting('row_security') as rls, current_setting('statement_timeout') as t, (select r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = current_user) as bypass");
  snap.env = { user: String(env.u), rowSecurity: String(env.rls), timeoutMs: timeoutMs(env.t), bypass: env.bypass ?? null };
  if (snap.env.user !== "authenticated" || snap.env.rowSecurity !== "on" || snap.env.bypass !== false) snap.errors.push(`read as ${snap.env.user} with row_security ${snap.env.rowSecurity}${snap.env.bypass === false ? "" : " and bypass-RLS not verified off"}`);
  if (snap.env.timeoutMs !== CASE_TIMEOUT_MS) snap.errors.push(`the catalog statement_timeout is ${env.t ?? "none"}, expected ${CASE_TIMEOUT_MS} ms`);
  for (const site of PARITY_SITES) {
    const keys: string[] = [];
    let foreign = 0;
    for (let i = 0; i + 1 < bounds.length && !snap.errors.length; i++) {
      await client.query("savepoint parity_read");
      try {
        const r = await client.query(
          "select location || '|' || id as k, (staff_id is distinct from (select auth.uid())) as foreign_row from public.production_events where location = $1 and created_at >= $2::timestamptz and created_at < $3::timestamptz and created_at <= $4::timestamptz",
          [site, bounds[i], bounds[i + 1], STAGING_CUTOFF],
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
    snap.foreign![site] = foreign;
  }
  snap.readers = {};
  for (const probe of READER_PROBES) {
    for (const site of PARITY_SITES) {
      if (snap.errors.length) break;
      await client.query("savepoint parity_read");
      try {
        const r = await client.query(readerSql(probe), readerParams(probe, site));
        const rows = r.rows.map((x) => String(x.j));
        snap.readers[`${probe}:${site}`] = READER_SPECS[probe].order ? rows : rows.sort();
        await client.query("release savepoint parity_read");
      } catch (e) {
        await client.query("rollback to savepoint parity_read");
        snap.errors.push(`reader ${probe} at ${site} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  await client.query("reset role");
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
  /** Signed-in session claims evidence (sizes/problems only) per user. */
  claimsSources: Record<string, { bytes: number; problems: string[] }>;
  /** The original pre-0036 baseline catalog (restoration and invariant authority). */
  baseline: BaselineCatalog | null;
  /** The retained post-0036 policy hash the installed catalog must match (required). */
  expectedInstalledHash: string | null;
  log: ParityProgress;
  /** Cancellation: checked between steps and again at the end; the transaction is still rolled back. */
  signal?: AbortSignal;
  newId?: () => string;
  now?: () => string;
}

const CANCELLED = "cancelled before completion";

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

function catalogDrift(other: Record<string, string>, baseline: BaselineCatalog): string[] {
  return [...new Set([...Object.keys(other), ...Object.keys(baseline.other)])].sort().filter((k) => other[k] !== baseline.other[k]);
}

async function readSide(client: QueryClient, kase: ParityCase, bounds: readonly string[], searchPath: string, label: string, log: ParityProgress): Promise<CaseSide> {
  await client.query("reset role");
  await client.query("select set_config('search_path', $1, true) is not null as ok", [searchPath]);
  const cat = await catalog(client);
  const roles: CaseSide["roles"] = {};
  for (const role of CASE_SPECS[kase].roles) {
    roles[role] = await readRoleSnapshot(client, role, bounds);
    log(`${kase} · ${label} · ${roleLine(role, roles[role]!)}`);
  }
  const staff = roles.staff;
  const staffForeignRows = staff && !staff.errors.length ? Object.values(staff.foreign ?? {}).reduce((a, b) => a + b, 0) : null;
  return { policies: cat.policies, policyHash: cat.policyHash, other: cat.other, roles, staffForeignRows: CASE_SPECS[kase].roles.includes("staff") ? staffForeignRows : null };
}

/**
 * Collect all four cases in one rolled-back REPEATABLE READ transaction, then
 * run the fresh restoration check. Always returns a collection; any failure is
 * in `problems` (or the restoration result), never hidden by a later success.
 * Cancellation is sticky: an aborted signal at any point, including during the
 * final restoration check, leaves the collection failed.
 */
export async function collectCaseParity(client: QueryClient, opts: CaseParityOptions): Promise<CaseCollection> {
  const now = opts.now ?? (() => new Date().toISOString());
  const coll: CaseCollection = {
    collectionId: (opts.newId ?? randomUUID)(), capturedAt: now(), revision: opts.revision, method: CASE_METHOD, cutoff: STAGING_CUTOFF, bounds: [],
    fixture: {}, fixtureHash: "", baselinePolicyHash: opts.baseline?.policyHash ?? "", baseline: opts.baseline, installedPolicyHash: "",
    claimsBytes: Object.fromEntries(Object.entries(opts.claimsSources).map(([r, c]) => [r, c.bytes])),
    startMemberships: {}, staffOtherWorkerRows: {}, cases: [], comparisons: [], restoration: null, problems: [],
  };
  const fail = (p: string) => {
    if (!coll.problems.includes(p)) coll.problems.push(p);
  };
  const checkAbort = () => {
    if (opts.signal?.aborted) throw new StopCollection(CANCELLED);
  };
  const finish = () => {
    if (opts.signal?.aborted) fail(CANCELLED);
    coll.finishedAt = now();
    return coll;
  };
  for (const [role, c] of Object.entries(opts.claimsSources)) for (const p of c.problems) fail(`${role} session claims: ${p}`);
  let ids: Record<CaseUser, string>;
  try {
    ids = subjects(opts.claimsText);
    coll.users = { ...ids };
    if (!opts.baseline) throw new StopCollection("the original pre-0036 baseline snapshot is missing; nothing to restore against");
    if (!opts.expectedInstalledHash) throw new StopCollection("the retained post-0036 policy hash is missing; the installed policies have no authority to match");
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
    return finish();
  }
  const baseline = opts.baseline;

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
    coll.installedOther = cat.other;
    const pol = checkPolicySet(cat.policies, "post");
    if (pol.length) throw new StopCollection(`installed policies are not the approved post-0036 set: ${pol[0]}`);
    if (cat.policyHash !== opts.expectedInstalledHash) {
      throw new StopCollection(`installed policy hash ${cat.policyHash.slice(0, 12)} is not the retained post-0036 hash ${opts.expectedInstalledHash.slice(0, 12)}`);
    }
    const drift = catalogDrift(cat.other, baseline);
    if (drift.length) throw new StopCollection(`installed catalog ${drift.join(", ")} differ from the original pre-0036 baseline`);
    coll.fixture = await fixture(client);
    coll.fixtureHash = fixtureHash(coll.fixture);
    coll.bounds = await monthBounds(client);
    coll.startMemberships = await membershipsOf(client, ids);
    const start = membershipProblems(coll.startMemberships, STANDARD_MEMBERSHIPS, "start");
    if (start.length) throw new StopCollection(`memberships are not standard at the start (${start[0]})`);
    const other = await client.query("select location, count(*)::int as n from public.production_events where staff_id is distinct from $1::uuid and created_at <= $2::timestamptz group by location order by location", [ids.staff, STAGING_CUTOFF]);
    coll.staffOtherWorkerRows = Object.fromEntries(other.rows.map((r) => [String(r.location), Number(r.n)]));
    opts.log(`installed policies ${cat.policyHash.slice(0, 12)} · fixture ${coll.fixtureHash.slice(0, 12)} · ${coll.bounds.length - 1} month chunks per site · standard memberships · catalog matches the pre-0036 baseline`);

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
        for (const p of membershipProblems(memberships, caseMemberships(kase), kase)) fail(p);
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
        if (back.policyHash !== coll.installedPolicyHash) fail(`${kase}: 0036 policies were not back after the nested rollback`);
        ev = { case: kase, collectionId: coll.collectionId, fixtureHash: coll.fixtureHash, memberships, before, after };
      } finally {
        await client.query("reset role");
        await client.query("rollback to savepoint parity_case");
      }
      if (ev) coll.cases.push(ev);
      checkAbort();
      const restored = membershipProblems(await membershipsOf(client, ids), STANDARD_MEMBERSHIPS, `after ${kase}`);
      if (restored.length) throw new StopCollection(`memberships were not standard after the ${kase} savepoint (${restored[0]})`);
    }
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  } finally {
    if (began) {
      try {
        await client.query("rollback");
        rolledBack = true;
      } catch (e) {
        fail(`the parity transaction's ROLLBACK could not be confirmed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  coll.comparisons = coll.cases.map((ev) => compareCase(coll, ev));
  if (began && !rolledBack) return finish();
  // Fresh statements outside the rolled-back snapshot; always run, even when cancelled.
  const problems: string[] = [];
  try {
    const memberships = await membershipsOf(client, ids);
    problems.push(...membershipProblems(memberships, STANDARD_MEMBERSHIPS, "after rollback"));
    const cat = await catalog(client);
    if (coll.installedPolicyHash && cat.policyHash !== coll.installedPolicyHash) problems.push(`after rollback: policy hash ${cat.policyHash.slice(0, 12)} is not the installed ${coll.installedPolicyHash.slice(0, 12)}`);
    const drift = catalogDrift(cat.other, baseline);
    if (drift.length) problems.push(`after rollback: catalog ${drift.join(", ")} differ from the original pre-0036 baseline`);
    const fx = coll.fixtureHash ? fixtureHash(await fixture(client)) : "";
    if (coll.fixtureHash && fx !== coll.fixtureHash) problems.push("after rollback: the fixture fingerprint changed");
    coll.restoration = { checkedAt: now(), passed: problems.length === 0, problems, memberships, catalog: { policyHash: cat.policyHash, other: cat.other }, fixtureHash: fx };
    opts.log(problems.length ? `restoration check FAILED: ${problems[0]}` : "restoration check: standard memberships, installed 0036, baseline catalog and the same fixture");
  } catch (e) {
    coll.restoration = { checkedAt: now(), passed: false, problems: [`the restoration check could not run: ${e instanceof Error ? e.message : String(e)}`] };
  }
  return finish();
}
