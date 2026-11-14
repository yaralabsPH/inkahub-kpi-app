/**
 * Task 4 write-path and digest compatibility around 0036 (staging only).
 *
 * SELECT policies take part in UPDATE/DELETE visibility, so the plan asks for
 * the app's existing write flows to be replayed on isolated `staging` fixtures
 * with 0036 and with the restored pre-0036 policies, plus the digest's
 * service-role read and anon rejection. This module holds the pure parts: the
 * step list (each one the app's own statement) and the checks. The runner
 * executes everything inside ONE transaction that is rolled back, so no event,
 * ledger row or stock change is kept.
 */

export type Actor = "postgres" | "owner" | "manager" | "staff" | "kiosk" | "cs" | "service_role" | "anon";
export type PolicySet = "post" | "pre";

export interface Step {
  id: string;
  actor: Actor;
  what: string;
  sql: string;
  /** Keys resolved from the run's context ($staff, $manager). */
  params?: ("staff" | "manager")[];
}

export interface StepOutcome {
  id: string;
  actor: Actor;
  /** Normalised result: row count, result text, or `error <sqlstate>`. */
  result: string;
}

export interface SetOutcome {
  set: PolicySet;
  policyHash: string;
  policyProblems: string[];
  steps: StepOutcome[];
}

export const WC_ORDER = "WC-STAGING-1";
const T = "'2026-11-11T01:00:00Z'";
const STAGING_DAY = "'2026-11-10T13:00:00Z'::timestamptz, '2026-11-11T13:00:00Z'::timestamptz";
const CUTOFF = "'2026-11-12T00:00:00Z'::timestamptz";
const AU_DAY = "'2026-09-14T18:00:00Z'::timestamptz, '2026-09-15T18:00:00Z'::timestamptz";
const DEDUCT_LINES = `'[{"code":"STG-FR-A3-BLK","qty":2},{"code":"STG-BOX-M","qty":1}]'::jsonb`;
const STOCK = `select string_agg(id || '=' || current_on_hand::text, ',' order by id) as result
  from public.products where location = 'staging' and id in ('stg-frame-a3-black', 'stg-box-medium')`;

const insert = (id: string, type: string, extra: { sku?: string; qty?: number; parent?: string; staff?: "staff" | "manager" } = {}) =>
  `insert into public.production_events
     (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id)
   values ('staging', '${id}', $1::uuid, 'framed', ${type === "clock_in" ? "null" : `'${WC_ORDER}'`},
           ${extra.sku ? `'${extra.sku}'` : "null"}, ${extra.qty ?? "null"}, '${type}', 'wc-station', 'write-compat', ${T}, null,
           ${extra.parent ? `'${extra.parent}'` : "null"})`;
const orderIds = `select coalesce(string_agg(id, ',' order by id), '') as result
  from public.production_events where location = 'staging' and order_number = '${WC_ORDER}'`;
const evidencePair = (site: string, window: string) =>
  `select 'v1=' || (public.load_production_evidence('${site}', ${window}, ${CUTOFF})::jsonb ->> 'rowCount')
       || ',v2=' || (public.load_production_evidence_v2('${site}', ${window}, ${CUTOFF})::jsonb ->> 'rowCount') as result`;
const DIGEST_READ = `select count(*) || ':' || coalesce(md5(string_agg(id, ',' order by id)), '') as result
  from public.production_events where location = 'au'
   and created_at >= '2026-09-14T14:00:00Z' and created_at < '2026-09-15T14:00:00Z'`;

export const STEPS: readonly Step[] = [
  { id: "s00", actor: "postgres", what: "stock before", sql: STOCK },
  { id: "s01", actor: "kiosk", what: "Production clock-state lookup", sql: `select count(*)::text as result from public.production_events
      where location = 'staging' and staff_id = $1::uuid and event_type in ('clock_in', 'clock_out') and created_at >= '2026-11-10T13:00:00Z'`, params: ["staff"] },
  { id: "s02", actor: "kiosk", what: "kiosk clock-in for scanned worker", sql: insert("wc-clock", "clock_in"), params: ["staff"] },
  { id: "s03", actor: "kiosk", what: "kiosk verify line for scanned worker", sql: insert("wc-lv1", "line_verified", { sku: "STG-FR-A3-BLK", qty: 2 }), params: ["staff"] },
  { id: "s04", actor: "kiosk", what: "Production verified-line state", sql: `select coalesce(string_agg(id, ',' order by id), '') as result from public.production_events
      where location = 'staging' and order_number = '${WC_ORDER}' and event_type in ('line_verified', 'cancelled')` },
  { id: "s05", actor: "kiosk", what: "kiosk complete order", sql: insert("wc-done", "completed"), params: ["staff"] },
  { id: "s06", actor: "kiosk", what: "auto-deduct", sql: `select public.deduct_inventory_for_event('wc-done', ${DEDUCT_LINES}) as r` },
  { id: "s07", actor: "kiosk", what: "auto-deduct retry (idempotent)", sql: `select public.deduct_inventory_for_event('wc-done', ${DEDUCT_LINES}) as r` },
  { id: "s08", actor: "postgres", what: "stock and ledger after", sql: `select (${STOCK}) || ';ledger=' ||
      (select count(*) from public.ledger where location = 'staging' and parent_event_id = 'wc-done') as result` },
  { id: "s09", actor: "kiosk", what: "unverify (cancellation)", sql: insert("wc-cancel", "cancelled", { parent: "wc-lv1" }), params: ["staff"] },
  { id: "s10", actor: "staff", what: "staff own insert", sql: insert("wc-self", "line_verified", { sku: "STG-PAPER-A4", qty: 1 }), params: ["staff"] },
  { id: "s11", actor: "staff", what: "staff insert as another worker", sql: insert("wc-cross", "line_verified", { sku: "STG-PAPER-A4", qty: 1 }), params: ["manager"] },
  { id: "s12", actor: "staff", what: "staff reads order", sql: orderIds },
  { id: "s13", actor: "cs", what: "cs reads order", sql: orderIds },
  { id: "s14", actor: "owner", what: "Reports order search", sql: orderIds },
  { id: "s15", actor: "owner", what: "owner v1/v2 staging day", sql: evidencePair("staging", STAGING_DAY) },
  { id: "s16", actor: "manager", what: "manager v1/v2 staging day", sql: evidencePair("staging", STAGING_DAY) },
  { id: "s17", actor: "staff", what: "staff correction (update)", sql: `update public.production_events set note = 'write-compat corrected' where id = 'wc-done'` },
  { id: "s18", actor: "manager", what: "manager correction (update)", sql: `update public.production_events set note = 'write-compat corrected' where id = 'wc-done'` },
  { id: "s19", actor: "kiosk", what: "kiosk delete", sql: `delete from public.production_events where id = 'wc-done'` },
  { id: "s20", actor: "staff", what: "staff delete", sql: `delete from public.production_events where id = 'wc-done'` },
  { id: "s21", actor: "owner", what: "Reports remove: ledger first", sql: `delete from public.ledger where parent_event_id = 'wc-done'` },
  { id: "s22", actor: "owner", what: "Reports remove: event", sql: `delete from public.production_events where id = 'wc-done'` },
  { id: "s23", actor: "owner", what: "Reports search after remove", sql: orderIds },
  { id: "s24", actor: "service_role", what: "digest direct read (service role)", sql: DIGEST_READ },
  { id: "s25", actor: "postgres", what: "digest read without RLS (reference)", sql: DIGEST_READ },
  { id: "s26", actor: "service_role", what: "service-role v1/v2 AU day", sql: evidencePair("au", AU_DAY) },
  { id: "s27", actor: "anon", what: "anon v2", sql: `select public.load_production_evidence_v2('au', ${AU_DAY}, ${CUTOFF}) is not null as result` },
  { id: "s28", actor: "anon", what: "anon v1", sql: `select public.load_production_evidence('au', ${AU_DAY}, ${CUTOFF}) is not null as result` },
  { id: "s29", actor: "anon", what: "anon direct read", sql: `select count(*)::text as result from public.production_events` },
];

/** Normalise a deduction result to the fields that matter (no generated ids). */
export function deductSummary(r: unknown): string {
  const o = (typeof r === "string" ? JSON.parse(r) : r) as Record<string, unknown> | null;
  if (!o) return "null";
  const arr = (v: unknown) => (Array.isArray(v) ? v.join("|") : "");
  return `status=${o.status},deducted=${o.deducted},skipped=${o.skipped_idempotent},missing=${arr(o.missing_codes)},negative=${arr(o.negative_codes)}`;
}

const stockMap = (s: string) => Object.fromEntries(s.split(";")[0].split(",").map((kv) => kv.split("=")).map(([k, v]) => [k, Number(v)]));

/** Expected behaviour of one policy set's run, independent of the other set. */
export function checkSet(o: SetOutcome): string[] {
  const p: string[] = [...o.policyProblems.map((x) => `${o.set}: ${x}`)];
  const r = Object.fromEntries(o.steps.map((s) => [s.id, s.result]));
  const want = (id: string, ok: (v: string) => boolean, expect: string) => {
    if (r[id] === undefined) p.push(`${o.set}: step ${id} did not run`);
    else if (!ok(r[id])) p.push(`${o.set}: step ${id} (${STEPS.find((s) => s.id === id)?.what}) gave "${r[id]}", expected ${expect}`);
  };
  for (const id of ["s02", "s03", "s05", "s09", "s10"]) want(id, (v) => v === "1", "1 row");
  want("s11", (v) => v === "error 42501", "an RLS denial");
  want("s04", (v) => v === "wc-lv1", "wc-lv1");
  want("s06", (v) => v === "status=ok,deducted=2,skipped=0,missing=,negative=", "2 deducted");
  want("s07", (v) => v === "status=ok,deducted=0,skipped=2,missing=,negative=", "0 deducted, 2 skipped");
  if (r.s00 && r.s08) {
    const a = stockMap(r.s00), b = stockMap(r.s08);
    if (b["stg-frame-a3-black"] !== a["stg-frame-a3-black"] - 2 || b["stg-box-medium"] !== a["stg-box-medium"] - 1) {
      p.push(`${o.set}: stock moved from ${r.s00} to ${r.s08}, expected -2 frame and -1 box exactly once`);
    }
    want("s08", (v) => v.endsWith(";ledger=2"), "2 ledger rows");
  }
  for (const id of ["s12", "s13", "s14"]) want(id, (v) => v === "wc-cancel,wc-done,wc-lv1,wc-self", "all four order events");
  for (const id of ["s15", "s16", "s26"]) want(id, (v) => /^v1=(\d+),v2=\1$/.test(v), "v1 and v2 row counts equal");
  for (const id of ["s17", "s19", "s20"]) want(id, (v) => v === "0", "0 rows");
  want("s18", (v) => v === "1", "1 row");
  want("s21", (v) => v === "2", "2 ledger rows removed");
  want("s22", (v) => v === "1", "1 row");
  want("s23", (v) => v === "wc-cancel,wc-lv1,wc-self", "wc-done gone");
  want("s24", (v) => v === r.s25 && !v.startsWith("0:"), "the same rows as the RLS-free reference");
  for (const id of ["s27", "s28", "s29"]) want(id, (v) => v === "error 42501", "permission denied");
  return p;
}

/** Both sets must behave identically, step by step. */
export function compareSets(post: SetOutcome, pre: SetOutcome): string[] {
  const out: string[] = [];
  const preBy = new Map(pre.steps.map((s) => [s.id, s.result]));
  for (const s of post.steps) {
    if (preBy.get(s.id) !== s.result) out.push(`step ${s.id} differs: with 0036 "${s.result}", pre-0036 "${preBy.get(s.id) ?? "missing"}"`);
  }
  if (pre.steps.length !== post.steps.length) out.push(`step counts differ: ${post.steps.length} vs ${pre.steps.length}`);
  return out;
}
