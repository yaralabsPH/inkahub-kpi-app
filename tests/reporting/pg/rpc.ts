/**
 * An RpcClient over PGlite that behaves like the PostgREST calls the server
 * makes: one public function per call, named arguments with the function's
 * declared types, executed as service_role (SET ROLE, then RESET), result
 * rows returned as JSON (json_agg; a scalar/json function returns its value).
 */
import type { PGlite } from "@electric-sql/pglite";
import type { RpcClient } from "../../../api/_lib/reporting-jobs";

interface Sig { args: Array<[string, string]>; set: boolean }

export function pgRpc(db: PGlite, opts: { role?: string } = {}): RpcClient & { calls: string[] } {
  const sigs = new Map<string, Sig>();
  const calls: string[] = [];
  const sig = async (fn: string): Promise<Sig> => {
    const hit = sigs.get(fn);
    if (hit) return hit;
    const r = await db.query<{ names: string[] | null; types: string[]; set: boolean }>(
      `select p.proargnames as names, array(select pg_catalog.format_type(t, null) from unnest(p.proargtypes) t) as types, p.proretset as set
         from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [fn]);
    if (r.rows.length !== 1) throw new Error(`function public.${fn} not found (or overloaded)`);
    const row = r.rows[0];
    const s: Sig = { args: row.types.map((t, i) => [row.names![i], t]), set: row.set };
    sigs.set(fn, s);
    return s;
  };
  return {
    calls,
    async rpc(fn, args) {
      calls.push(fn);
      try {
        const s = await sig(fn);
        const given = Object.keys(args);
        for (const k of given) if (!s.args.some(([n]) => n === k)) throw Object.assign(new Error(`unknown argument ${k} for ${fn}`), { code: "PGRST" });
        const used = s.args.filter(([n]) => n in args);
        const call = `public.${fn}(${used.map(([n, t], i) => `${n} => $${i + 1}::${t}`).join(", ")})`;
        const params = used.map(([n, t]) => {
          const v = args[n];
          if (v === null || v === undefined) return null;
          if (t === "jsonb" || t === "json") return JSON.stringify(v);
          if (t.endsWith("[]")) return v; // PGlite serializes JS arrays
          return typeof v === "object" ? JSON.stringify(v) : v;
        });
        await db.exec(`SET ROLE ${opts.role ?? "service_role"}`);
        try {
          // PostgREST returns RETURNS TABLE rows as objects even with ONE column (a bare alias would unwrap it).
          const sql = s.set ? `select coalesce(json_agg(to_json(t)), '[]'::json) as v from (select * from ${call}) t` : `select to_json(${call}) as v`;
          const r = await db.query<{ v: unknown }>(sql, params);
          return { data: r.rows[0]?.v ?? null, error: null };
        } finally {
          await db.exec("RESET ROLE");
        }
      } catch (e) {
        const err = e as { message?: string; code?: string };
        return { data: null, error: { message: err.message ?? String(e), code: err.code } };
      }
    },
  };
}
