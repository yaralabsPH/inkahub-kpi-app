/**
 * Task 12 staging capture/ACL checks (pure parts). The runner
 * (`reporting-capture.ts`) executes the SQL; this module holds the catalog
 * query, the expected access model, the capture step list and the report.
 * STAGING ONLY (ybrzhrgfrnvtcwymjdrq). Never logs claims or credentials.
 */

export const REPORTING_SCHEMA = "reporting_private";

export const CAPTURE_MODES = ["--rehearse-migration", "--check", "--concurrency"] as const;
export type CaptureMode = "rehearse-migration" | "check" | "concurrency";

/** Exactly one mode flag; anything else is refused before any connection. */
export function parseCaptureMode(argv: readonly string[]): { mode: CaptureMode | null; problems: string[] } {
  const flags = argv.filter((a) => a.startsWith("--"));
  const known = flags.filter((f) => (CAPTURE_MODES as readonly string[]).includes(f));
  const problems = flags.filter((f) => !(CAPTURE_MODES as readonly string[]).includes(f)).map((f) => `unknown flag ${f}`);
  if (known.length !== 1) problems.push(`choose exactly one of ${CAPTURE_MODES.join(", ")}`);
  return { mode: problems.length ? null : (known[0].slice(2) as CaptureMode), problems };
}
export const CAPTURE_ROLE = "reporting_capture";
export const CAPTURE_FUNCTION = "capture_production_event_change";
export const CAPTURE_TRIGGER = "production_events_reporting_capture";
/** 0036's installed production_events policy hash (Task 10 retained evidence); 0037 must not change it. */
export const INSTALLED_0036_POLICY_HASH = "b7884efe22600764525362bc13a976ecdf2f895489da6377ecd7f8257d7bb99b";

export const REPORTING_TABLES = [
  "batch_changes",
  "batch_events",
  "batches",
  "cancel_edges",
  "changes",
  "control",
  "daily_totals",
  "event_facts",
  "generations",
  "order_occurrences",
  "partition_results",
  "partition_work",
  "site_state",
  "source_current",
  "timing_facts",
] as const;
export const REPORTING_FUNCTIONS = [CAPTURE_FUNCTION, "control_guard", "generations_guard"] as const;
const ROLES = ["anon", "authenticated", "service_role", CAPTURE_ROLE] as const;
const CLIENT_ROLES = ["anon", "authenticated", "authenticator", "service_role"];

/** One read-only statement returning every catalog fact the checks need, as JSON. */
export const CATALOG_SQL = `select json_build_object(
  'schema', (select nspname from pg_catalog.pg_namespace where nspname = '${REPORTING_SCHEMA}'),
  'tables', (select json_agg(json_build_object('t', c.relname, 'rls', c.relrowsecurity, 'owner', pg_catalog.pg_get_userbyid(c.relowner)) order by c.relname)
               from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
              where n.nspname = '${REPORTING_SCHEMA}' and c.relkind = 'r'),
  'functions', (select json_agg(json_build_object('f', p.proname, 'owner', pg_catalog.pg_get_userbyid(p.proowner), 'secdef', p.prosecdef,
                                 'config', p.proconfig, 'dynamic', p.prosrc ~* '\\m(execute|format)\\M') order by p.proname)
                  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = '${REPORTING_SCHEMA}'),
  'policies', (select json_agg(json_build_object('t', tablename, 'p', policyname, 'cmd', cmd, 'roles', roles::text[], 'permissive', permissive) order by tablename, policyname)
                 from pg_catalog.pg_policies where schemaname = '${REPORTING_SCHEMA}'),
  'role', (select json_build_object('login', rolcanlogin, 'inherit', rolinherit, 'super', rolsuper, 'bypass', rolbypassrls,
                                    'createrole', rolcreaterole, 'createdb', rolcreatedb, 'replication', rolreplication)
             from pg_catalog.pg_roles where rolname = '${CAPTURE_ROLE}'),
  'memberOf', (select coalesce(json_agg(r.rolname order by r.rolname), '[]'::json) from pg_catalog.pg_auth_members m
                 join pg_catalog.pg_roles r on r.oid = m.roleid join pg_catalog.pg_roles u on u.oid = m.member where u.rolname = '${CAPTURE_ROLE}'),
  'members', (select coalesce(json_agg(json_build_object('member', u.rolname, 'inherit', m.inherit_option) order by u.rolname), '[]'::json)
                from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid = m.roleid join pg_catalog.pg_roles u on u.oid = m.member
               where r.rolname = '${CAPTURE_ROLE}'),
  'triggers', (select coalesce(json_agg(json_build_object('n', t.tgname, 'def', pg_catalog.pg_get_triggerdef(t.oid)) order by t.tgname), '[]'::json)
                 from pg_catalog.pg_trigger t where t.tgrelid = 'public.production_events'::regclass and not t.tgisinternal),
  'schemaPrivs', (select json_agg(json_build_object('role', r, 'usage', pg_catalog.has_schema_privilege(r, '${REPORTING_SCHEMA}', 'USAGE'),
                                    'create', pg_catalog.has_schema_privilege(r, '${REPORTING_SCHEMA}', 'CREATE')) order by r)
                    from unnest(array['${ROLES.join("','")}']) r),
  'tablePrivs', (select json_agg(json_build_object('role', r, 't', c.relname,
                    'privs', concat_ws(',',
                      case when pg_catalog.has_table_privilege(r, c.oid, 'SELECT') then 'SELECT' end,
                      case when pg_catalog.has_table_privilege(r, c.oid, 'INSERT') then 'INSERT' end,
                      case when pg_catalog.has_table_privilege(r, c.oid, 'UPDATE') then 'UPDATE' end,
                      case when pg_catalog.has_table_privilege(r, c.oid, 'DELETE') then 'DELETE' end,
                      case when pg_catalog.has_table_privilege(r, c.oid, 'TRUNCATE') then 'TRUNCATE' end,
                      case when pg_catalog.has_table_privilege(r, c.oid, 'REFERENCES') then 'REFERENCES' end,
                      case when pg_catalog.has_table_privilege(r, c.oid, 'TRIGGER') then 'TRIGGER' end)) order by r, c.relname)
                   from unnest(array['${ROLES.join("','")}']) r, pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = '${REPORTING_SCHEMA}' and c.relkind = 'r'),
  'functionExec', (select json_agg(json_build_object('role', r, 'f', p.proname, 'x', pg_catalog.has_function_privilege(r, p.oid, 'EXECUTE')) order by r, p.proname)
                     from unnest(array['anon','authenticated','service_role']) r, pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = '${REPORTING_SCHEMA}'),
  'publicAcl', (select json_agg(json_build_object('o', o, 'public', acl ~ '(^|[{,])=')) from (
                  select 'schema' as o, coalesce(nspacl::text, '') as acl from pg_catalog.pg_namespace where nspname = '${REPORTING_SCHEMA}'
                  union all select p.proname, coalesce(p.proacl::text, '=X') from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = '${REPORTING_SCHEMA}'
                  union all select c.relname, coalesce(c.relacl::text, '') from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = '${REPORTING_SCHEMA}') x),
  'exposed', (select coalesce(array_to_string(rolconfig, ';'), '') from pg_catalog.pg_roles where rolname = 'authenticator'),
  'control', (select row_to_json(c) from ${REPORTING_SCHEMA}.control c),
  'siteState', (select json_agg(json_build_object('site', site, 'processor', processor_enabled, 'mode', read_mode) order by site) from ${REPORTING_SCHEMA}.site_state)
) as j`;

export interface ReportingCatalog {
  schema: string | null;
  tables: Array<{ t: string; rls: boolean; owner: string }> | null;
  functions: Array<{ f: string; owner: string; secdef: boolean; config: string[] | null; dynamic: boolean }> | null;
  policies: Array<{ t: string; p: string; cmd: string; roles: string[]; permissive: string }> | null;
  role: { login: boolean; inherit: boolean; super: boolean; bypass: boolean; createrole: boolean; createdb: boolean; replication: boolean } | null;
  memberOf: string[];
  members: Array<{ member: string; inherit: boolean }>;
  triggers: Array<{ n: string; def: string }>;
  schemaPrivs: Array<{ role: string; usage: boolean; create: boolean }>;
  tablePrivs: Array<{ role: string; t: string; privs: string }>;
  functionExec: Array<{ role: string; f: string; x: boolean }>;
  publicAcl: Array<{ o: string; public: boolean }>;
  exposed: string;
  control: { capture_epoch: number; capture_enabled: boolean; rule_version: string } | null;
  siteState: Array<{ site: string; processor: boolean; mode: string }> | null;
  /** Filled by the runner from the shared policy catalog. */
  sourcePolicyHash?: string;
}

/** Expected table privileges per role after 0037. */
export function expectedTablePrivs(role: string, table: string): string {
  if (role === "service_role") return "SELECT,INSERT,UPDATE,DELETE";
  if (role === CAPTURE_ROLE) return table === "control" ? "SELECT" : table === "changes" ? "INSERT" : "";
  return "";
}

/** Every catalog problem (empty = the access model is exactly as designed). */
export function checkCatalog(c: ReportingCatalog): string[] {
  const p: string[] = [];
  if (c.schema !== REPORTING_SCHEMA) return [`schema ${REPORTING_SCHEMA} is not installed`];
  const tables = (c.tables ?? []).map((t) => t.t);
  if (tables.join(",") !== [...REPORTING_TABLES].join(",")) p.push(`tables are [${tables.join(", ")}], expected [${REPORTING_TABLES.join(", ")}]`);
  for (const t of c.tables ?? []) {
    if (!t.rls) p.push(`RLS is off on ${t.t}`);
    if (t.owner === CAPTURE_ROLE) p.push(`${CAPTURE_ROLE} owns table ${t.t}`);
  }
  const fns = c.functions ?? [];
  if (fns.map((f) => f.f).join(",") !== [...REPORTING_FUNCTIONS].sort().join(",")) p.push(`functions are [${fns.map((f) => f.f).join(", ")}]`);
  for (const f of fns) {
    const cfg = (f.config ?? []).join(";");
    if (cfg !== 'search_path=""') p.push(`${f.f} search_path is "${cfg}", expected search_path=""`);
    if (f.dynamic) p.push(`${f.f} contains EXECUTE/format (dynamic SQL)`);
    if (f.f === CAPTURE_FUNCTION) {
      if (f.owner !== CAPTURE_ROLE) p.push(`${f.f} is owned by ${f.owner}, expected ${CAPTURE_ROLE}`);
      if (!f.secdef) p.push(`${f.f} is not SECURITY DEFINER`);
    } else {
      if (f.secdef) p.push(`${f.f} must be SECURITY INVOKER`);
      if (f.owner === CAPTURE_ROLE) p.push(`${f.f} must not be owned by ${CAPTURE_ROLE}`);
    }
  }
  const pol = (c.policies ?? []).map((x) => `${x.t}.${x.p}:${x.cmd}:${x.roles.join("|")}:${x.permissive}`).sort();
  const wantPol = [`changes.changes_capture_insert:INSERT:${CAPTURE_ROLE}:PERMISSIVE`, `control.control_capture_select:SELECT:${CAPTURE_ROLE}:PERMISSIVE`];
  if (pol.join(",") !== wantPol.join(",")) p.push(`policies are [${pol.join(", ")}], expected only [${wantPol.join(", ")}]`);
  const r = c.role;
  if (!r) p.push(`role ${CAPTURE_ROLE} is missing`);
  else {
    for (const [k, v] of Object.entries(r)) if (v !== false) p.push(`${CAPTURE_ROLE} has ${k}`);
  }
  if (c.memberOf.length) p.push(`${CAPTURE_ROLE} is a member of ${c.memberOf.join(", ")}`);
  for (const m of c.members) {
    if (CLIENT_ROLES.includes(m.member)) p.push(`${CAPTURE_ROLE} is granted to client role ${m.member}`);
    if (m.inherit) p.push(`${m.member} inherits ${CAPTURE_ROLE}`);
  }
  const trig = c.triggers.map((t) => t.n);
  if (trig.join(",") !== CAPTURE_TRIGGER) p.push(`production_events triggers are [${trig.join(", ")}], expected only ${CAPTURE_TRIGGER}`);
  const def = c.triggers.find((t) => t.n === CAPTURE_TRIGGER)?.def ?? "";
  if (def && !/AFTER INSERT OR DELETE OR UPDATE ON public\.production_events FOR EACH ROW EXECUTE FUNCTION reporting_private\.capture_production_event_change\(\)/.test(def)) {
    p.push(`capture trigger definition is unexpected: ${def}`);
  }
  for (const s of c.schemaPrivs) {
    const wantUsage = s.role === "service_role" || s.role === CAPTURE_ROLE;
    if (s.usage !== wantUsage) p.push(`${s.role} schema USAGE is ${s.usage}`);
    if (s.create) p.push(`${s.role} has CREATE on ${REPORTING_SCHEMA}`);
  }
  for (const t of c.tablePrivs) {
    const want = expectedTablePrivs(t.role, t.t);
    if (t.privs !== want) p.push(`${t.role} on ${t.t} has [${t.privs}], expected [${want}]`);
  }
  for (const f of c.functionExec) if (f.x) p.push(`${f.role} can execute ${f.f}`);
  for (const a of c.publicAcl) if (a.public) p.push(`PUBLIC holds a privilege on ${a.o}`);
  if (/pgrst\.db_schemas=[^;]*reporting_private/.test(c.exposed)) p.push("reporting_private is in the Data API exposed schemas");
  if (!c.control) p.push("control row is missing");
  if (c.sourcePolicyHash !== undefined && c.sourcePolicyHash !== INSTALLED_0036_POLICY_HASH) {
    p.push(`production_events policy hash ${c.sourcePolicyHash.slice(0, 12)} differs from installed 0036 ${INSTALLED_0036_POLICY_HASH.slice(0, 12)}`);
  }
  if ((c.siteState ?? []).map((s) => s.site).join(",") !== "au,uk,us") p.push("site_state must hold exactly au, uk, us");
  return p;
}

// ---------------------------------------------------------------------------
// Capture steps (run inside ONE transaction that is always rolled back)
// ---------------------------------------------------------------------------

export type CaptureActor = "postgres" | "owner" | "manager" | "staff" | "kiosk" | "cs" | "service_role" | "anon";

export interface CaptureStep {
  id: string;
  actor: CaptureActor;
  what: string;
  sql: string;
  params?: ("staff" | "manager")[];
  /** Run inside its own savepoint that is rolled back afterwards (failure/rollback probes). */
  isolated?: CaptureActor | null;
  /** Statements run as postgres inside the isolated savepoint before `sql`. */
  setup?: string[];
  /** Expected normalised result: a row-count string, a value, or `error <sqlstate>`. */
  expect: string | RegExp;
}

export const RC_ORDER = "RC-STAGING-1";
const RC_TIME = "'2026-11-11T02:00:00Z'";
const J = (ids: string) => `select coalesce(string_agg(op || '|' || coalesce(old_site, '') || '/' || coalesce(old_event_id, '') || '>' || coalesce(new_site, '') || '/' || coalesce(new_event_id, ''), ';' order by change_id), '') as result
  from reporting_private.changes where coalesce(new_event_id, old_event_id) in (${ids}) or old_event_id in (${ids})`;
const ins = (id: string, site = "au", extra = "") =>
  `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id)
   values ('${site}', '${id}', $1::uuid, 'framed', '${RC_ORDER}', 'INKA-KAN0566-A4-FB', 1, 'line_verified', 'rc-station', 'reporting capture check${extra}', ${RC_TIME}, null, null)`;
const SRC = (id: string) => `select count(*)::text as result from public.production_events where id = '${id}'`;
const DENIED = "error 42501";

export const CAPTURE_STEPS: readonly CaptureStep[] = [
  { id: "c01", actor: "postgres", what: "enable capture for this transaction (epoch must advance)", sql: `update reporting_private.control set capture_enabled = true where singleton and not capture_enabled returning 'advanced' as result`, expect: /^(advanced|0)$/ },
  { id: "c02", actor: "staff", what: "staff saves a line at au", sql: ins("rc-ins"), params: ["staff"], expect: "1" },
  { id: "c03", actor: "postgres", what: "journal has the insert with the full new image", sql: `select op || ':' || (new_image ->> 'note') || ':' || (new_image ? 'station_id')::text || ':' || (new_image ->> 'created_at' is not null)::text as result from reporting_private.changes where new_event_id = 'rc-ins'`, expect: "INSERT:reporting capture check:true:true" },
  { id: "c04", actor: "manager", what: "manager corrects order, person and time", sql: `update public.production_events set order_number = 'RC-STAGING-2', staff_id = $1::uuid, created_at = '2026-11-11T02:30:00Z' where id = 'rc-ins'`, params: ["manager"], expect: "1" },
  { id: "c05", actor: "postgres", what: "journal keeps old and new order/person/time", sql: `select (old_image ->> 'order_number') || '>' || (new_image ->> 'order_number') || ':' || ((old_image ->> 'staff_id') <> (new_image ->> 'staff_id'))::text || ':' || ((old_image ->> 'created_at') <> (new_image ->> 'created_at'))::text as result from reporting_private.changes where op = 'UPDATE' and new_event_id = 'rc-ins'`, expect: "RC-STAGING-1>RC-STAGING-2:true:true" },
  { id: "c06", actor: "owner", what: "owner moves the event au -> uk", sql: `update public.production_events set location = 'uk' where location = 'au' and id = 'rc-ins'`, expect: "1" },
  { id: "c07", actor: "owner", what: "owner no-op update", sql: `update public.production_events set note = note where location = 'uk' and id = 'rc-ins'`, expect: "1" },
  { id: "c08", actor: "owner", what: "owner deletes it (existing delete works)", sql: `delete from public.production_events where location = 'uk' and id = 'rc-ins'`, expect: "1" },
  { id: "c09", actor: "postgres", what: "journal: insert, correction, move (both sides), delete; nothing for the no-op", sql: J("'rc-ins'"), expect: "INSERT|/>au/rc-ins;UPDATE|au/rc-ins>au/rc-ins;UPDATE|au/rc-ins>uk/rc-ins;DELETE|uk/rc-ins>/" },
  { id: "c10", actor: "staff", what: "staff saves at the unsupported staging site", sql: ins("rc-stg", "staging"), params: ["staff"], expect: "1" },
  { id: "c11", actor: "postgres", what: "no journal for the staging site", sql: J("'rc-stg'"), expect: "" },
  { id: "c12", actor: "staff", what: "two distinct saves with identical payload", sql: ins("rc-dup1"), params: ["staff"], expect: "1" },
  { id: "c13", actor: "staff", what: "second identical save", sql: ins("rc-dup2"), params: ["staff"], expect: "1" },
  { id: "c14", actor: "postgres", what: "both are journalled (no invented deduplication)", sql: `select count(*)::text as result from reporting_private.changes where new_event_id in ('rc-dup1', 'rc-dup2')`, expect: "2" },
  { id: "c15", actor: "staff", what: "a save rolled back takes its journal row with it", sql: ins("rc-rb"), params: ["staff"], isolated: "postgres", expect: "1" },
  { id: "c16", actor: "postgres", what: "no source row and no journal row after that rollback", sql: `select (${SRC("rc-rb").replace(" as result", "")}) || ':' || (select count(*) from reporting_private.changes where new_event_id = 'rc-rb') as result`, expect: "0:0" },
  { id: "c17", actor: "staff", what: "journal insert refused (privilege revoked) -> the save fails", sql: ins("rc-fail1"), params: ["staff"], isolated: "postgres", setup: ["revoke insert on reporting_private.changes from reporting_capture"], expect: DENIED },
  { id: "c18", actor: "staff", what: "control row missing -> the save fails visibly", sql: ins("rc-fail2"), params: ["staff"], isolated: "postgres", setup: ["delete from reporting_private.control"], expect: "error P0001" },
  { id: "c19", actor: "postgres", what: "neither failed save exists", sql: `select count(*)::text as result from public.production_events where id in ('rc-fail1', 'rc-fail2')`, expect: "0" },
  // Client denial.
  ...(["anon", "staff", "kiosk", "cs", "manager", "owner"] as const).flatMap((a, i) => [
    { id: `d${i}1`, actor: a, what: `${a} reads the journal`, sql: `select count(*)::text as result from reporting_private.changes`, expect: DENIED },
    { id: `d${i}2`, actor: a, what: `${a} writes the journal`, sql: `insert into reporting_private.changes (capture_epoch, op, new_site, new_event_id, new_image) values (1, 'INSERT', 'au', 'x', '{"location":"au","id":"x"}')`, expect: DENIED },
    { id: `d${i}3`, actor: a, what: `${a} changes capture control`, sql: `update reporting_private.control set capture_enabled = false`, expect: DENIED },
    { id: `d${i}4`, actor: a, what: `${a} reads site state`, sql: `select count(*)::text as result from reporting_private.site_state`, expect: DENIED },
    { id: `d${i}5`, actor: a, what: `${a} calls the capture function`, sql: `select reporting_private.capture_production_event_change()`, expect: DENIED },
  ] as CaptureStep[]),
  { id: "d71", actor: "service_role", what: "server reads the journal", sql: `select (count(*) >= 0)::text as result from reporting_private.changes`, expect: "true" },
  { id: "d72", actor: "service_role", what: "server cannot call the capture function", sql: `select reporting_private.capture_production_event_change()`, expect: DENIED },
  // Epoch, completeness and integrity constraints.
  { id: "e01", actor: "service_role", what: "a generation of the current epoch", sql: `insert into reporting_private.generations (site, rule_version, capture_epoch, source_cutoff) select 'au', 'item-counting-summary-v1', capture_epoch, ${RC_TIME} from reporting_private.control returning 'ok' as result`, expect: "ok" },
  { id: "e02", actor: "postgres", what: "operator disables capture: epoch advances", sql: `update reporting_private.control set capture_enabled = false returning capture_enabled::text as result`, expect: "false" },
  { id: "e03", actor: "postgres", what: "that generation is no longer continuous (older epoch)", sql: `select bool_and(g.capture_epoch < c.capture_epoch)::text as result from reporting_private.generations g, reporting_private.control c where g.source_cutoff = ${RC_TIME}`, expect: "true" },
  { id: "e04", actor: "staff", what: "save while capture is disabled", sql: ins("rc-off"), params: ["staff"], expect: "1" },
  { id: "e05", actor: "postgres", what: "nothing journalled while disabled", sql: J("'rc-off'"), expect: "" },
  { id: "e06", actor: "postgres", what: "epoch cannot go back", sql: `update reporting_private.control set capture_epoch = 1`, isolated: "postgres", expect: "error P0001" },
  { id: "e07", actor: "postgres", what: "second active batch for a site is refused", sql: `insert into reporting_private.batches (site, kind, rule_version, capture_epoch, lease_fence) values ('au', 'refresh', 'item-counting-summary-v1', 1, 1), ('au', 'refresh', 'item-counting-summary-v1', 1, 2)`, isolated: "postgres", expect: "error 23505" },
  { id: "e08", actor: "postgres", what: "negative Items are refused", sql: `insert into reporting_private.daily_totals (site, audience_kind, production_date, staff_id, work_type, rework, valid_from_seq, items, line_count) values ('au', 'site', '2026-11-11', gen_random_uuid(), 'framed', false, 1, -1, 1)`, isolated: "postgres", expect: "error 23514" },
  { id: "e09", actor: "postgres", what: "published generation identity is immutable", isolated: "postgres", setup: [`update reporting_private.generations set state = 'published', complete = true, verified_at = now(), published_at = now(), reconciliation_fingerprint = repeat('a', 64) where source_cutoff = ${RC_TIME}`], sql: `update reporting_private.generations set rule_version = 'other' where source_cutoff = ${RC_TIME}`, expect: "error P0001" },
  { id: "e10", actor: "postgres", what: "self audience needs a staff id", sql: `insert into reporting_private.daily_totals (site, audience_kind, production_date, staff_id, work_type, rework, valid_from_seq, items, line_count) values ('au', 'self', '2026-11-11', gen_random_uuid(), 'framed', false, 1, 1, 1)`, isolated: "postgres", expect: "error 23514" },
  { id: "e11", actor: "postgres", what: "re-enable capture for the write-compat replay", sql: `update reporting_private.control set capture_enabled = true returning capture_enabled::text as result`, expect: "true" },
];

export interface StepResult {
  id: string;
  actor: CaptureActor;
  what: string;
  result: string;
  ms: number;
}

export function checkSteps(results: readonly StepResult[]): string[] {
  const p: string[] = [];
  const by = new Map(results.map((r) => [r.id, r]));
  for (const s of CAPTURE_STEPS) {
    const r = by.get(s.id);
    if (!r) {
      p.push(`step ${s.id} (${s.what}) did not run`);
      continue;
    }
    const ok = typeof s.expect === "string" ? r.result === s.expect : s.expect.test(r.result);
    if (!ok) p.push(`step ${s.id} (${s.what}) gave "${r.result}", expected ${String(s.expect)}`);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Overhead and concurrency
// ---------------------------------------------------------------------------

export interface OverheadSample {
  capture: boolean;
  rows: number;
  ms: number;
}

export function median(xs: readonly number[]): number {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function overheadSummary(samples: readonly OverheadSample[]): { offPerRowMs: number; onPerRowMs: number; deltaPerRowMs: number; ratio: number; rounds: number } {
  const per = (on: boolean) => samples.filter((s) => s.capture === on).map((s) => s.ms / s.rows);
  const off = median(per(false));
  const on = median(per(true));
  return { offPerRowMs: off, onPerRowMs: on, deltaPerRowMs: on - off, ratio: off > 0 ? on / off : Number.NaN, rounds: Math.min(per(false).length, per(true).length) };
}

export interface ConcurrencyResult {
  captureEnabledCommitted: boolean;
  firstHeldMs: number;
  secondMs: number | null;
  secondError: string | null;
  journalRowsSeenBySecond: number | null;
}

export function checkConcurrency(c: ConcurrencyResult): string[] {
  const p: string[] = [];
  if (c.secondError) p.push(`second source transaction failed while the first was open: ${c.secondError}`);
  if (!c.captureEnabledCommitted) p.push("capture is not enabled on staging, so the journal path was not exercised concurrently (operator enable needed)");
  return p;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface CaptureReport {
  mode: string;
  revision: string;
  startedAt: string;
  finishedAt: string;
  catalog: ReportingCatalog | null;
  catalogProblems: string[];
  steps: StepResult[];
  stepProblems: string[];
  writeCompatProblems: string[];
  writeCompatJournalRows: number | null;
  overhead: ReturnType<typeof overheadSummary> | null;
  concurrency: ConcurrencyResult | null;
  concurrencyProblems: string[];
  errors: string[];
  restoration: string | null;
}

export function captureStatus(r: CaptureReport): string {
  const all = [...r.errors, ...r.catalogProblems, ...r.stepProblems, ...r.writeCompatProblems, ...r.concurrencyProblems];
  if (!r.finishedAt) all.unshift("run not finished");
  if (r.mode !== "concurrency" && !r.overhead) all.push("trigger overhead was not measured");
  return all.length ? `STATUS: FAILED – ${all[0]}${all.length > 1 ? ` (+${all.length - 1} more)` : ""}` : "STATUS: COMPLETE";
}

export function captureMarkdown(r: CaptureReport): string {
  const f = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : "n/a");
  const lines = [
    `# Reporting capture checks (Task 12) — ${r.mode}`,
    "",
    `- project: ybrzhrgfrnvtcwymjdrq (staging) · code revision: ${r.revision}`,
    `- started: ${r.startedAt} · finished: ${r.finishedAt || "(not finished)"}`,
    "- every check ran inside a transaction that was ROLLED BACK; nothing was kept; credentials are not recorded",
    "",
    "## Catalog and access",
    "",
    r.catalog ? `- control: epoch ${r.catalog.control?.capture_epoch ?? "?"}, capture ${r.catalog.control?.capture_enabled ? "enabled" : "disabled"}; sites ${(r.catalog.siteState ?? []).map((s) => `${s.site}=${s.mode}/${s.processor ? "on" : "off"}`).join(", ")}` : "- catalog not read",
    r.catalog?.sourcePolicyHash ? `- production_events policy hash: ${r.catalog.sourcePolicyHash.slice(0, 12)}…` : "",
    ...(r.catalogProblems.length ? r.catalogProblems.map((x) => `- PROBLEM: ${x}`) : ["- access model exactly as designed"]),
    "",
    "## Capture steps",
    "",
    "| step | actor | what | result | ms |",
    "|---|---|---|---|---|",
    ...r.steps.map((s) => `| ${s.id} | ${s.actor} | ${s.what} | ${s.result.replace(/\|/g, "\\|")} | ${s.ms} |`),
    ...r.stepProblems.map((x) => `- PROBLEM: ${x}`),
    "",
    "## Existing write paths with capture enabled",
    "",
    r.writeCompatJournalRows === null ? "- not run" : `- write-compat replay journal rows for the staging site: ${r.writeCompatJournalRows} (expected 0)`,
    ...(r.writeCompatProblems.length ? r.writeCompatProblems.map((x) => `- PROBLEM: ${x}`) : r.writeCompatJournalRows === null ? [] : ["- every write-compat step behaved as before (inserts, RLS denial, deduction once, idempotent retry, updates, deletes, digest)"]),
    "",
    "## Trigger overhead",
    "",
    r.overhead ? `- per inserted row (median of ${r.overhead.rounds} rounds): capture off ${f(r.overhead.offPerRowMs)} ms, on ${f(r.overhead.onPerRowMs)} ms, delta ${f(r.overhead.deltaPerRowMs)} ms (×${f(r.overhead.ratio)})` : "- not measured",
    "",
    "## Concurrency",
    "",
    r.concurrency
      ? `- capture enabled (committed): ${r.concurrency.captureEnabledCommitted}; first transaction held ${r.concurrency.firstHeldMs} ms; second finished in ${r.concurrency.secondMs ?? "–"} ms${r.concurrency.secondError ? ` · ERROR ${r.concurrency.secondError}` : ""}`
      : "- not run in this mode",
    ...r.concurrencyProblems.map((x) => `- PROBLEM: ${x}`),
    "",
    r.restoration ? `- after rollback: ${r.restoration}` : "",
    ...r.errors.map((x) => `- ERROR: ${x}`),
    "",
    captureStatus(r),
    "",
  ];
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}
