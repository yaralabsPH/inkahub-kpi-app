/**
 * Task 15 staging harness: an RpcClient over ONE direct PostgreSQL connection
 * that behaves like the PostgREST calls the server makes with the service
 * key (no SUPABASE_SERVICE_ROLE_KEY is available locally, so the real worker
 * is driven through this instead of supabase-js):
 *
 *   - one public function per call, named arguments with the function's
 *     declared types (an unknown argument is refused like PostgREST's PGRST202);
 *   - each call is its OWN transaction: BEGIN; request.jwt.claims =
 *     {"role":"service_role"}; SET LOCAL ROLE service_role; the service_role
 *     role's own configured settings (as PostgREST applies them per request,
 *     read once from pg_db_role_setting, never invented or loosened); the call;
 *     COMMIT. A failure rolls back and is returned as {error}, never thrown;
 *   - set-returning functions come back as an array of row objects (also with
 *     one column), scalar/json functions as their value (json, like PostgREST).
 *
 * Fault injection (tests and the runtime gate's lost-response case only):
 * `fault(fn, n)` may return "lost-after-commit" (the call COMMITS, then the
 * client reports a transient connection error as if the response was lost) or
 * "fail-before" (nothing is sent; a transient error is returned).
 *
 * The connection is the caller's (target-guarded and marker-checked by the
 * runner); this module never opens, ends or re-targets one.
 */
import type { RpcClient } from "../../api/_lib/reporting-jobs";

export interface SqlConn {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}
export type RpcFault = "lost-after-commit" | "fail-before" | null;
export interface ServiceRpcOptions {
  /** Fault for the n-th call (1-based, per function name) of `fn`. */
  fault?: (fn: string, n: number) => RpcFault;
}
export interface ServiceRpcClient extends RpcClient {
  /** Function names called, in order (never arguments or results). */
  calls: string[];
  /** Faults actually injected, in order. */
  injected: Array<{ fn: string; n: number; fault: Exclude<RpcFault, null> }>;
  /** The service_role role settings applied to every call (name=value). */
  roleSettings(): Promise<string[]>;
}

interface Sig { args: Array<[string, string]>; set: boolean }
const IDENT = /^[a-z_][a-z0-9_]*$/;
const SAFE_SETTING = /^[a-z_][a-z0-9_.]*=.*$/;
export const LOST_RESPONSE = "fetch failed: injected lost response after commit";
export const FAILED_BEFORE = "fetch failed: injected failure before send";

export const SIGNATURE_SQL = `select p.proargnames as names, array(select pg_catalog.format_type(t, null) from unnest(p.proargtypes) t) as types, p.proretset as set
   from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`;
export const ROLE_SETTINGS_SQL = `select coalesce(array_agg(x order by x), '{}') as s from (
  select unnest(d.setconfig) as x from pg_catalog.pg_db_role_setting d
   where d.setrole = (select oid from pg_catalog.pg_roles where rolname = 'service_role')
     and (d.setdatabase = 0 or d.setdatabase = (select oid from pg_catalog.pg_database where datname = pg_catalog.current_database()))) t`;

export function serviceRpcClient(c: SqlConn, opts: ServiceRpcOptions = {}): ServiceRpcClient {
  const sigs = new Map<string, Sig>();
  const counts = new Map<string, number>();
  const calls: string[] = [];
  const injected: ServiceRpcClient["injected"] = [];
  let settings: string[] | null = null;
  const roleSettings = async (): Promise<string[]> => {
    if (settings) return settings;
    const raw = ((await c.query(ROLE_SETTINGS_SQL)).rows[0]?.s ?? []) as string[];
    for (const s of raw) if (!SAFE_SETTING.test(s)) throw new Error(`unexpected service_role setting ${JSON.stringify(s)}`);
    settings = raw;
    return raw;
  };
  const sig = async (fn: string): Promise<Sig> => {
    const hit = sigs.get(fn);
    if (hit) return hit;
    if (!IDENT.test(fn)) throw Object.assign(new Error(`invalid function name ${fn}`), { code: "PGRST202" });
    const r = await c.query(SIGNATURE_SQL, [fn]);
    if (r.rows.length !== 1) throw Object.assign(new Error(`function public.${fn} not found (or overloaded)`), { code: "PGRST202" });
    const row = r.rows[0] as { names: string[] | null; types: string[]; set: boolean };
    const types = row.types ?? [];
    const s: Sig = { args: types.map((t, i) => [row.names?.[i] ?? `$${i + 1}`, t]), set: Boolean(row.set) };
    sigs.set(fn, s);
    return s;
  };
  const rpc: ServiceRpcClient["rpc"] = async (fn, args) => {
    const n = (counts.get(fn) ?? 0) + 1;
    counts.set(fn, n);
    calls.push(fn);
    const fault = opts.fault?.(fn, n) ?? null;
    if (fault === "fail-before") {
      injected.push({ fn, n, fault });
      return { data: null, error: { message: FAILED_BEFORE, code: "08006" } };
    }
    let open = false;
    try {
      const s = await sig(fn);
      const role = await roleSettings();
      for (const k of Object.keys(args)) if (!s.args.some(([name]) => name === k)) throw Object.assign(new Error(`unknown argument ${k} for ${fn}`), { code: "PGRST202" });
      const used = s.args.filter(([name]) => name in args);
      const call = `public.${fn}(${used.map(([name, t], i) => `${name} => $${i + 1}::${t}`).join(", ")})`;
      const params = used.map(([name, t]) => {
        const v = args[name];
        if (v === null || v === undefined) return null;
        if (t === "jsonb" || t === "json") return JSON.stringify(v);
        if (t.endsWith("[]")) return v;
        return typeof v === "object" ? JSON.stringify(v) : v;
      });
      await c.query("begin");
      open = true;
      await c.query("select pg_catalog.set_config('request.jwt.claims', $1, true), pg_catalog.set_config('request.jwt.claim.role', 'service_role', true)", [JSON.stringify({ role: "service_role" })]);
      await c.query("set local role service_role");
      for (const kv of role) {
        const i = kv.indexOf("=");
        await c.query("select pg_catalog.set_config($1, $2, true)", [kv.slice(0, i), kv.slice(i + 1)]);
      }
      const sql = s.set ? `select coalesce(json_agg(to_json(t)), '[]'::json) as v from (select * from ${call}) t` : `select to_json(${call}) as v`;
      const r = await c.query(sql, params);
      await c.query("commit");
      open = false;
      if (fault === "lost-after-commit") {
        injected.push({ fn, n, fault });
        return { data: null, error: { message: LOST_RESPONSE, code: "08006" } };
      }
      return { data: r.rows[0]?.v ?? null, error: null };
    } catch (e) {
      if (open) await c.query("rollback").catch(() => undefined);
      const err = e as { message?: string; code?: string };
      return { data: null, error: { message: err.message ?? String(e), code: err.code } };
    }
  };
  // ONE connection: calls from concurrently materialized owners are serialized so each stays its own
  // transaction (PostgREST runs each request on its own pooled connection; this keeps the same atomicity).
  let queue: Promise<unknown> = Promise.resolve();
  const serialized: ServiceRpcClient["rpc"] = (fn, args) => {
    const next = queue.then(() => rpc(fn, args));
    queue = next.catch(() => undefined);
    return next;
  };
  return { rpc: serialized, calls, injected, roleSettings };
}
