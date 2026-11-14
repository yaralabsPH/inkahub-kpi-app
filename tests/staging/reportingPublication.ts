/**
 * Task 13 Part B2b staging evidence: the full 0038 draft and atomic
 * publication against REAL SQL. Driven by tests/staging/reporting-jobs.ts:
 *
 *   --rehearse-migration --sites=A,B   0038 NOT installed: apply the whole draft
 *                                      inside ONE outer transaction (its own
 *                                      BEGIN/COMMIT stripped), run the flow,
 *                                      ALWAYS roll back, then a fresh audit.
 *   --check-installed --sites=A,B      0038 installed: the same flow, one
 *                                      rolled-back transaction.
 *   --interleavings --sites=A,B        0038 installed, capture and both
 *                                      processors already enabled by the
 *                                      operator: multi-connection lock/fault
 *                                      checks. Every connection rolls back.
 *
 * Nothing here commits. Capture/processor changes, fixture source rows, the
 * migration itself and every batch/generation exist only inside rolled-back
 * transactions. Multi-connection checks never pretend to run inside the
 * rehearsal transaction. Every cleanup failure is kept in the report.
 *
 * The flow (one connection, savepoints for refusal probes):
 *   rebuild A (copy pages, freeze) -> plan the fixture owners (site and self
 *   audiences) plus 650 escaping-heavy keys -> seal -> claim (serialized
 *   bound, no stranded work) -> staging refusals (T13B2a-1 null/calendar,
 *   T13B2a-2 wrong staff, identity family, four-array envelope) -> incomplete
 *   publish refused -> stage -> publish (facts, owners, daily = reducer,
 *   mirror/versions) -> lost-response replay -> refresh A after an update, a
 *   delete, an insert and an A->B move, with an expired-lease takeover (old
 *   fence refused) and empty replacements -> receipts (the move stays pending
 *   for B) -> rebuild B (the move is acknowledged) -> no-change publication.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { prepareProductionEvidence, type ProductionEvidenceEvent } from "../../src/lib/domain/productionCounts";
import { productionDateAt, type ReportSite } from "../../src/lib/domain/productionPeriods";
import { canonicalJson, REPORTING_RULE_VERSION, sha256Hex, type ReportingAudience } from "../../src/lib/domain/productionReporting";
import { projectReportingPartition } from "../../src/lib/domain/productionReportingProjection";
import { buildChunks, packStageRequests, reportingManifestHash, type ResultRows, type WorkDescriptor } from "../../api/_lib/reporting-stage";
import { emptyRows, ownerKey, rowsByOwner, type Owner } from "../fixtures/reporting-rows";
import { splitSqlStatements } from "./sqlStatements";
import type { LifecycleReport } from "./reportingCapture";

export const MIGRATION_0038 = "supabase/migrations/0038_reporting_jobs.sql";
export type Site = "au" | "uk" | "us";
export type PublicationMode = "rehearse-migration" | "check-installed" | "interleavings" | "committed-interleavings";
export interface Db {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

// ---------------------------------------------------------------------------
// Arguments and the migration body
// ---------------------------------------------------------------------------

export function parsePublicationArgs(argv: readonly string[]): { mode: PublicationMode | null; sites: [Site, Site] | null; maxPages: number; problems: string[] } {
  const problems: string[] = [];
  const modes = argv.filter((a) => ["--rehearse-migration", "--check-installed", "--interleavings", "--committed-interleavings"].includes(a));
  const sitesArg = argv.find((a) => a.startsWith("--sites="));
  const pagesArg = argv.find((a) => a.startsWith("--max-pages="));
  const unknown = argv.filter((a) => a.startsWith("--") && !modes.includes(a) && a !== sitesArg && a !== pagesArg);
  if (modes.length !== 1) problems.push("choose exactly one of --rehearse-migration, --check-installed, --interleavings, --committed-interleavings");
  if (unknown.length) problems.push(`unknown flags: ${unknown.join(" ")}`);
  const sites = sitesArg?.slice("--sites=".length).split(",") ?? [];
  const okSites = sites.length === 2 && sites.every((s) => s === "au" || s === "uk" || s === "us") && sites[0] !== sites[1];
  if (!okSites) problems.push("--sites=A,B must name two different supported sites (au, uk, us)");
  const maxPages = pagesArg ? Number(pagesArg.slice("--max-pages=".length)) : 200;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 5000) problems.push("--max-pages must be an integer 1..5000");
  return { mode: problems.length ? null : (modes[0].slice(2) as PublicationMode), sites: okSites ? (sites as [Site, Site]) : null, maxPages, problems };
}

/**
 * The draft's statements without its own outer BEGIN/COMMIT, so they run in
 * the runner's transaction. Any OTHER transaction control inside the draft
 * (which would commit or end the rehearsal early) is refused.
 */
export function migrationBody(text: string): string[] {
  const st = splitSqlStatements(text);
  const kw = (i: number) => leadingKeywords(st[i]?.text ?? "");
  if (kw(0)[0] !== "BEGIN" || kw(0).length !== 1 || kw(st.length - 1)[0] !== "COMMIT" || kw(st.length - 1).length !== 1) throw new Error("0038 must be one BEGIN … COMMIT transaction");
  const inner = st.slice(1, -1);
  for (const s of inner) {
    if (isTransactionControl(s.text)) throw new Error(`0038 contains transaction control inside its body: ${s.text.trim().slice(0, 60)}`);
  }
  return inner.map((s) => s.text);
}

/**
 * The first two executable keywords of one statement (uppercase), skipping
 * whitespace, "--" line comments and NESTED "/* *\/" block comments exactly as
 * PostgreSQL does. Anything inside quotes or dollar-quoted bodies comes after
 * the first keyword, so it can never be mistaken for the statement's verb.
 */
export function leadingKeywords(sql: string): string[] {
  let i = 0;
  const n = sql.length;
  const words: string[] = [];
  while (i < n && words.length < 2) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (sql.startsWith("--", i)) {
      while (i < n && sql[i] !== "\n") i++;
    } else if (sql.startsWith("/*", i)) {
      let depth = 0;
      while (i < n) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else i++;
      }
      if (depth !== 0) throw new Error("unterminated block comment");
    } else {
      const m = /^[A-Za-z_]+/.exec(sql.slice(i));
      if (!m) break;
      words.push(m[0].toUpperCase());
      i += m[0].length;
    }
  }
  return words;
}

/** Statements that would end, nest or commit the runner's outer transaction. */
export function isTransactionControl(sql: string): boolean {
  const [a, b] = leadingKeywords(sql);
  if (["BEGIN", "START", "COMMIT", "END", "ROLLBACK", "ABORT", "SAVEPOINT", "RELEASE"].includes(a)) return true;
  return a === "PREPARE" && b === "TRANSACTION";
}

export const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface Observation {
  id: string;
  what: string;
  expected: string;
  result: string;
  ok: boolean;
  ms: number;
}

export interface PublicationReport extends LifecycleReport {
  mode: PublicationMode;
  revision: string;
  startedAt: string;
  sites: [Site, Site];
  draftSha256: string;
  statementsApplied: number | null;
  settings: string;
  catalogProblems: string[];
  observations: Observation[];
  cleanup: string[];
  /** Committed harness only: exactly what this run owns (recorded before its first commit). */
  ownership: Record<string, unknown> | null;
}

export function newPublicationReport(mode: PublicationMode, sites: [Site, Site], revision: string, startedAt: string, draftSha256: string): PublicationReport {
  return { mode, sites, revision, startedAt, draftSha256, statementsApplied: null, settings: "", catalogProblems: [], observations: [], cleanup: [], ownership: null, errors: [], finishedAt: "", restorationVerified: null, restoration: null, restorationProblems: [] };
}

/** One STATUS line: COMPLETE only with every observation as expected, no error/cleanup failure and a verified restoration. */
export function publicationStatus(r: PublicationReport): string {
  const all = [...r.errors, ...r.cleanup.map((c) => `cleanup failed: ${c}`), ...r.catalogProblems, ...r.observations.filter((o) => !o.ok).map((o) => `${o.id} ${o.what}: ${o.result}`), ...r.restorationProblems];
  if (!r.finishedAt) all.unshift("run not finished");
  if (r.observations.length === 0) all.push("no observation was recorded");
  if (r.restorationVerified !== true && !all.some((x) => x.startsWith("restoration not verified"))) all.push("restoration not verified");
  return all.length ? `STATUS: FAILED – ${all[0]}${all.length > 1 ? ` (+${all.length - 1} more)` : ""}` : "STATUS: COMPLETE";
}

export function publicationMarkdown(r: PublicationReport): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const lines = [
    `# Reporting publication staging evidence (${r.mode})`,
    "",
    `- revision: ${r.revision}`,
    `- started: ${r.startedAt}`,
    `- finished: ${r.finishedAt || "(running)"}`,
    `- sites: ${r.sites.join(", ")}`,
    `- 0038 draft SHA-256: ${r.draftSha256}`,
    `- statements applied inside the rolled-back transaction: ${r.statementsApplied ?? "n/a"}`,
    `- existing settings (read only): ${r.settings || "(not read)"}`,
    `- restoration: ${r.restorationVerified === true ? "verified" : r.restorationVerified === false ? "NOT verified" : "not checked"}${r.restoration ? ` (${r.restoration})` : ""}`,
    "",
    "| id | check | expected | result | ok | ms |",
    "|---|---|---|---|---|---|",
    ...r.observations.map((o) => `| ${o.id} | ${esc(o.what)} | ${esc(o.expected)} | ${esc(o.result)} | ${o.ok ? "yes" : "NO"} | ${o.ms} |`),
    "",
    ...(r.catalogProblems.length ? ["## Catalog problems", ...r.catalogProblems.map((p) => `- ${p}`), ""] : []),
    ...(r.errors.length ? ["## Errors", ...r.errors.map((p) => `- ${p}`), ""] : []),
    ...(r.cleanup.length ? ["## Cleanup failures", ...r.cleanup.map((p) => `- ${p}`), ""] : []),
    ...(r.ownership ? ["## Cleanup ownership (recorded before the first commit)", "```json", JSON.stringify(r.ownership, null, 2), "```", ""] : []),
    ...(r.restorationProblems.length ? ["## Restoration problems", ...r.restorationProblems.map((p) => `- ${p}`), ""] : []),
    publicationStatus(r),
  ];
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Flow helpers
// ---------------------------------------------------------------------------

/** A service RPC with its own transaction boundary (committed harness only). */
export type ServiceCall = (c: Db, sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;

export interface FlowCtx {
  /** When set, every service RPC goes through it (the rollback-only flow leaves it unset). */
  call?: ServiceCall;
  sites: [Site, Site];
  maxPages: number;
  staff: string;
  /** Switch the connection to service_role (true) or back to the migration/owner role (false). */
  as(c: Db, service: boolean): Promise<void>;
  record(o: Observation): void;
  redact(s: string): string;
  now(): number;
}

const msgOf = (e: unknown, redact: (s: string) => string) => {
  const code = (e as { code?: string }).code;
  return `${code ? `${code} ` : ""}${redact(e instanceof Error ? e.message : String(e)).slice(0, 240)}`;
};

/** A step that must succeed; its failure is recorded and stops the flow. */
export async function step<T>(c: Db, ctx: FlowCtx, id: string, what: string, fn: () => Promise<T>, describe: (t: T) => string = () => "ok"): Promise<T> {
  const t0 = ctx.now();
  try {
    const out = await fn();
    ctx.record({ id, what, expected: "succeeds", result: describe(out), ok: true, ms: Math.round(ctx.now() - t0) });
    return out;
  } catch (e) {
    ctx.record({ id, what, expected: "succeeds", result: msgOf(e, ctx.redact), ok: false, ms: Math.round(ctx.now() - t0) });
    throw new Error(`${id} failed; later steps depend on it`);
  }
}

/** A refusal probe inside a savepoint: the error must match; whatever it did is rolled back to the savepoint. */
export async function refused(c: Db, ctx: FlowCtx, id: string, what: string, expected: RegExp, fn: () => Promise<unknown>): Promise<void> {
  const t0 = ctx.now();
  await c.query("savepoint rp_probe");
  let result: string;
  let ok: boolean;
  try {
    await fn();
    result = "succeeded (expected a refusal)";
    ok = false;
  } catch (e) {
    result = msgOf(e, ctx.redact);
    ok = expected.test(result);
  }
  await c.query("rollback to savepoint rp_probe");
  await c.query("release savepoint rp_probe");
  ctx.record({ id, what, expected: `refused: ${expected.source}`, result, ok, ms: Math.round(ctx.now() - t0) });
}

/** A checked value: records whether `got` equals `want` (JSON). */
export function expectEqual(ctx: FlowCtx, id: string, what: string, got: unknown, want: unknown): boolean {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  ctx.record({ id, what, expected: w.slice(0, 300), result: g.slice(0, 300), ok: g === w, ms: 0 });
  return g === w;
}

// ---------------------------------------------------------------------------
// Fixture source rows (ids rp-*; whitespace id of 37 spaces)
// ---------------------------------------------------------------------------

export const WS_ID = " ".repeat(37);
const FB = "INKA-KAN0566-A4-FB";
const HOOK = "INKA-AUX-HOOK";
const LEGACY = "A4 21x30 cm / Framed Print (Black)";
export function fixtureRows(staff: string): Array<Record<string, unknown>> {
  const r = (id: string, type: string, order: string | null, sku: string | null, qty: number | null, at: string, parent: string | null = null, dept = "framed") =>
    ({ id, event_type: type, order_number: order, line_sku: sku, line_quantity: qty, created_at: at, parent_event_id: parent, department: dept, staff_id: staff });
  return [
    r("rp-v1", "line_verified", "RP-1", FB, 2, "2026-01-12T11:00:00Z"),
    r("rp-v2", "line_verified", "RP-1", HOOK, 1, "2026-01-12T11:05:00Z"), // excluded: 0 Items, still a line
    r("rp-v3", "line_verified", "RP-1", FB, 1, "2026-01-12T11:10:00Z"),
    r("rp-c3", "cancelled", "RP-1", FB, 1, "2026-01-12T11:20:00Z", "rp-v3"),
    r("rp-v5", "line_verified", "RP-1", LEGACY, 1, "2026-01-12T11:25:00Z"), // unclassified: 0 Items, still a line
    r("rp-t1", "completed", "RP-1", null, null, "2026-01-12T11:30:00Z"),
    r("rp-x1", "line_verified", "", FB, 1, "2026-01-12T12:00:00Z"), // event partition
    r(WS_ID, "line_verified", "RP-1", FB, 1, "2026-01-12T12:10:00Z"), // source issue
    r("rp-m1", "line_verified", "RP-M", FB, 1, "2026-01-12T12:20:00Z"), // later moved A -> B
    r("rp-v9", "line_verified", "RP-9", FB, 1, "2026-01-12T12:30:00Z"), // RP-9: timing + occurrence, later deleted
    r("rp-t9", "completed", "RP-9", null, null, "2026-01-12T12:40:00Z"),
  ];
}
const FIXTURE_IDS = (rows: Array<Record<string, unknown>>) => rows.map((x) => String(x.id));

export async function insertFixtures(c: Db, site: Site, rows: Array<Record<string, unknown>>): Promise<void> {
  for (const x of rows) {
    await c.query(
      `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id)
       values ($1, $2, $3::uuid, $4, $5, $6, $7, $8, 'rp-station', 'publication rehearsal', $9::timestamptz, null, $10)`,
      [site, x.id, x.staff_id, x.department, x.order_number, x.line_sku, x.line_quantity, x.event_type, x.created_at, x.parent_event_id],
    );
  }
}

/** Frozen images (candidate or batch view) of the given ids, as evidence events. */
export async function frozenEvents(c: Db, batch: string, ids: string[]): Promise<ProductionEvidenceEvent[]> {
  const r = await c.query("select id, reporting_private.frozen_image($1::uuid, id) as img from unnest($2::text[]) as t(id)", [batch, ids]);
  return r.rows.filter((x) => x.img).map((x) => {
    const i = x.img as Record<string, unknown>;
    return {
      id: String(i.id), location: String(i.location), staff_id: (i.staff_id as string) ?? null, department: (i.department as string) ?? null,
      order_number: (i.order_number as string) ?? null, line_sku: (i.line_sku as string) ?? null, line_quantity: (i.line_quantity as number) ?? null,
      event_type: String(i.event_type), created_at: String(i.created_at), parent_event_id: (i.parent_event_id as string) ?? null, cs_case_id: (i.cs_case_id as string) ?? null,
    };
  });
}

export interface Planned {
  desc: WorkDescriptor;
  rows: ResultRows;
}
export function plannedFor(site: Site, events: ProductionEvidenceEvent[], cutoff: string, staff: string, keep: (o: Owner) => boolean, empties: Owner[] = []): Planned[] {
  const out = new Map<string, Planned>();
  for (const aud of [{ kind: "site" } as ReportingAudience, { kind: "self", staffId: staff } as ReportingAudience]) {
    const input = { site, audience: aud, ruleVersion: REPORTING_RULE_VERSION, sourceCutoffUtc: cutoff, events };
    const hash = sha256Hex(canonicalJson(input));
    const staffKey = aud.kind === "self" ? aud.staffId : null;
    for (const { owner, rows } of rowsByOwner(projectReportingPartition(input)).values()) {
      if (keep(owner)) out.set(`${aud.kind}|${ownerKey(owner)}`, { desc: { audienceKind: aud.kind, audienceStaff: staffKey, ...owner, inputHash: hash }, rows });
    }
    for (const o of empties) if (!out.has(`${aud.kind}|${ownerKey(o)}`)) out.set(`${aud.kind}|${ownerKey(o)}`, { desc: { audienceKind: aud.kind, audienceStaff: staffKey, ...o, inputHash: hash }, rows: emptyRows() });
  }
  return [...out.values()];
}

/** Daily groups the reducer gives for the frozen fixture events (lines = effective verifications; Items gated by status). */
export function reducerDaily(site: Site, events: ProductionEvidenceEvent[], cutoff: string, staffFilter: string | null): string[] {
  const visible = staffFilter ? events.filter((e) => e.staff_id === staffFilter) : events;
  const prepared = prepareProductionEvidence({
    events: visible, range: { startUtc: "2000-01-01T00:00:00Z", endUtcExclusive: cutoff }, asOfUtc: cutoff, loadedAtUtc: cutoff,
    visibility: staffFilter ? { kind: "limited", reason: "own work only" } : { kind: "site" },
  });
  const groups = new Map<string, { items: number; lines: number }>();
  for (const v of prepared.verifications) {
    if (!v.effective) continue;
    const k = [productionDateAt(new Date(v.ev.ms), site as ReportSite), v.ev.staff_id, v.workType, v.caseId !== null].join("|");
    const g = groups.get(k) ?? { items: 0, lines: 0 };
    g.lines++;
    if (v.item.status === "counted") g.items += v.item.items;
    groups.set(k, g);
  }
  return [...groups.entries()].map(([k, g]) => `${k}|${g.items}|${g.lines}`).sort();
}

async function sqlDaily(c: Db, site: Site, staff: string | null): Promise<string[]> {
  const r = await c.query(
    `select production_date::text || '|' || staff_id::text || '|' || work_type || '|' || rework::text || '|' || coalesce(items::text, 'overflow') || '|' || line_count::text as k
       from reporting_private.daily_totals
      where site = $1 and valid_to_seq is null and audience_kind = $2 and audience_staff is not distinct from $3::uuid`,
    [site, staff ? "self" : "site", staff],
  );
  return r.rows.map((x) => String(x.k)).sort();
}

/**
 * One service-only RPC as service_role. On success the role is reset; on a
 * failure the transaction is aborted and NOTHING more is sent (the caller's
 * savepoint rollback also undoes the SET LOCAL ROLE), so the database error
 * is never masked by a "transaction is aborted" one.
 */
export async function rpc(c: Db, ctx: Pick<FlowCtx, "as"> & { call?: ServiceCall }, sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  // Committed mode supplies its own call: one explicit transaction per RPC (tests/staging/reportingCommitted.ts).
  if (ctx.call) return ctx.call(c, sql, params);
  await ctx.as(c, true);
  const rows = (await c.query(sql, params)).rows;
  await ctx.as(c, false);
  return rows;
}

export async function planAll(c: Db, ctx: FlowCtx, batch: string, fence: number, descs: WorkDescriptor[]): Promise<void> {
  for (let i = 0; i < descs.length; i += 300) await rpc(c, ctx, "select * from public.plan_reporting_work($1, $2, $3::jsonb)", [batch, fence, JSON.stringify(descs.slice(i, i + 300))]);
}

export async function claimAll(c: Db, ctx: FlowCtx, batch: string, fence: number): Promise<{ calls: Array<{ rows: number; bytes: number }>; ids: Map<string, string> }> {
  const ids = new Map<string, string>();
  const calls: Array<{ rows: number; bytes: number }> = [];
  for (let i = 0; i < 20; i++) {
    const rows = await rpc(c, ctx, "select * from public.claim_reporting_work($1, $2, 1000)", [batch, fence]);
    if (rows.length === 0) break;
    calls.push({ rows: rows.length, bytes: Buffer.byteLength(JSON.stringify(rows), "utf8") });
    for (const r of rows) ids.set(`${r.audience_kind}|${r.audience_staff ?? ""}|${r.partition_kind}|${r.partition_key}`, String(r.work_id));
  }
  return { calls, ids };
}
const dkey = (d: WorkDescriptor) => `${d.audienceKind}|${d.audienceStaff ?? ""}|${d.partitionKind}|${d.partitionKey}`;

export async function stageAll(c: Db, ctx: FlowCtx, batch: string, fence: number, planned: Planned[], ids: Map<string, string>): Promise<void> {
  const entries = planned.flatMap((p) => buildChunks(p.rows).map((chunk) => ({ partition: ids.get(dkey(p.desc))!, chunk })));
  for (const req of packStageRequests(entries)) await rpc(c, ctx, "select * from public.stage_reporting_results($1, $2, $3::jsonb)", [batch, fence, JSON.stringify(req)]);
}

export async function copyAll(c: Db, ctx: FlowCtx, batch: string, fence: number): Promise<{ pages: number; rows: number }> {
  let after: string | null = null;
  for (let page = 1; page <= ctx.maxPages; page++) {
    const [r] = await rpc(c, ctx, "select * from public.copy_reporting_source_page($1, $2, $3)", [batch, fence, after]);
    if (r.complete) return { pages: Number(r.pages), rows: Number(r.total_rows) };
    after = String(r.next_after_event_id);
  }
  throw new Error(`the site needs more than ${ctx.maxPages} copy pages (raise --max-pages after checking its size)`);
}

export async function publish(c: Db, ctx: FlowCtx, batch: string, fence: number) {
  const [r] = await rpc(c, ctx, "select * from public.publish_reporting_batch($1, $2)", [batch, fence]);
  return r;
}

/** T13B2b-7: exact (event_id, image) set equality of candidate, mirror and current versions, both directions. */
export const IMAGE_DIFF_SQL = `select
  (select count(*) from (select event_id, image from reporting_private.source_candidate where batch_id = $1 except select event_id, image from reporting_private.source_current where site = $2) x)::int as candidate_not_mirror,
  (select count(*) from (select event_id, image from reporting_private.source_current where site = $2 except select event_id, image from reporting_private.source_candidate where batch_id = $1) x)::int as mirror_not_candidate,
  (select count(*) from (select event_id, image from reporting_private.source_candidate where batch_id = $1 except select event_id, image from reporting_private.source_versions where site = $2 and valid_to_seq is null) x)::int as candidate_not_versions,
  (select count(*) from (select event_id, image from reporting_private.source_versions where site = $2 and valid_to_seq is null except select event_id, image from reporting_private.source_candidate where batch_id = $1) x)::int as versions_not_candidate`;

/** Fixture ids: mirror image = current source row = current retained version (and a deleted id is in none). */
export const FIXTURE_IMAGE_SQL = `select
  (select count(*) from public.production_events pe where pe.location = $1 and pe.id = any($2::text[]))::int as source_rows,
  (select count(*) from reporting_private.source_current sc where sc.site = $1 and sc.event_id = any($2::text[]))::int as mirror_rows,
  (select count(*) from public.production_events pe join reporting_private.source_current sc on sc.site = pe.location and sc.event_id = pe.id
    where pe.location = $1 and pe.id = any($2::text[]) and sc.image is distinct from pg_catalog.to_jsonb(pe))::int as mirror_differs,
  (select count(*) from reporting_private.source_current sc join reporting_private.source_versions v on v.site = sc.site and v.event_id = sc.event_id and v.valid_to_seq is null
    where sc.site = $1 and sc.event_id = any($2::text[]) and v.image is distinct from sc.image)::int as version_differs,
  (select count(*) from reporting_private.source_versions v where v.site = $1 and v.event_id = any($2::text[]) and v.valid_to_seq is null
    and not exists (select 1 from public.production_events pe where pe.location = $1 and pe.id = v.event_id))::int as deleted_still_current`;

const FAMILY_KEY: Record<string, string> = { event_facts: "event_id", cancel_edges: "cancel_event_id", order_occurrences: "terminal_event_id", timing_facts: "event_id", source_issue_facts: "event_id" };
/** Current rows of every family at a site for the given ids, as "family|audience|staff|id" (sorted). */
async function currentFamilies(c: Db, site: Site, ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const [t, k] of Object.entries(FAMILY_KEY)) {
    const r = await c.query(`select audience_kind || '|' || coalesce(audience_staff::text, '') || '|' || ${k} as x from reporting_private.${t} where site = $1 and valid_to_seq is null and ${k} = any($2::text[])`, [site, ids]);
    for (const row of r.rows) out.push(`${t}|${String(row.x)}`);
  }
  return out.sort();
}
/** The same keys for planned rows. */
function plannedFamilies(planned: Planned[]): string[] {
  const out: string[] = [];
  for (const p of planned) {
    for (const [t, k] of Object.entries(FAMILY_KEY)) {
      for (const row of p.rows[t as keyof ResultRows]) out.push(`${t}|${p.desc.audienceKind}|${p.desc.audienceStaff ?? ""}|${String(row[k])}`);
    }
  }
  return out.sort();
}
const familyCounts = (keys: string[]) => Object.fromEntries(Object.keys(FAMILY_KEY).map((t) => [t, keys.filter((k) => k.startsWith(`${t}|`)).length]));

const counts = async (c: Db, site: Site) =>
  (await c.query(
    `select (select count(*) from reporting_private.source_current where site = $1)::int as mirror,
            (select count(*) from reporting_private.source_versions where site = $1 and valid_to_seq is null)::int as versions,
            (select count(*) from reporting_private.event_facts where site = $1 and valid_to_seq is null and partition_kind is null)::int as ownerless`,
    [site],
  )).rows[0];

// ---------------------------------------------------------------------------
// The single-connection flow (inside the caller's transaction)
// ---------------------------------------------------------------------------

export async function runPublicationFlow(c: Db, ctx: FlowCtx): Promise<void> {
  const [A, B] = ctx.sites;
  const fx = fixtureRows(ctx.staff);
  const ids = FIXTURE_IDS(fx);

  await step(c, ctx, "S0", "enable capture and both processors inside the rolled-back transaction", async () => {
    await rpc(c, ctx, "select * from public.set_reporting_capture(true)", []);
    await rpc(c, ctx, "update reporting_private.site_state set processor_enabled = true where site = any($1::text[])", [[A, B]]);
  });
  await step(c, ctx, "S1", `insert ${fx.length} fixture source rows at ${A}`, () => insertFixtures(c, A, fx));

  // --- Rebuild A -----------------------------------------------------------
  const [rb] = await step(c, ctx, "R1", `begin rebuild of ${A}`, () => rpc(c, ctx, "select * from public.begin_reporting_rebuild($1)", [A]));
  const batchA = String(rb.batch_id);
  const fenceA = Number(rb.lease_fence);
  await step(c, ctx, "R2", `copy every ${A} source page (keyset, bounded)`, () => copyAll(c, ctx, batchA, fenceA), (r) => `${r.pages} pages, ${r.rows} rows`);
  const [fr] = await step(c, ctx, "R3", "freeze the rebuild (one statement)", () => rpc(c, ctx, "select * from public.freeze_reporting_rebuild($1, $2)", [batchA, fenceA]));
  const cutoff = new Date(String(fr.source_cutoff)).toISOString();
  const frozen = await frozenEvents(c, batchA, ids);
  const planned = plannedFor(A, frozen, cutoff, ctx.staff, () => true);
  const heavy: Planned[] = Array.from({ length: 650 }, (_, i) => ({
    desc: { audienceKind: "site", audienceStaff: null, partitionKind: "event", partitionKey: `rp-q-${String(i).padStart(3, "0")}${'"'.repeat(800)}`, inputHash: "a".repeat(64) },
    rows: emptyRows(),
  }));
  const all = [...planned, ...heavy];
  await step(c, ctx, "R4", `plan ${all.length} works (fixture owners for both audiences + 650 escaping-heavy keys)`, () => planAll(c, ctx, batchA, fenceA, all.map((p) => p.desc)));
  await step(c, ctx, "R5", "seal with the TypeScript manifest", () => rpc(c, ctx, "select * from public.seal_reporting_work($1, $2, $3, $4)", [batchA, fenceA, all.length, reportingManifestHash(all.map((p) => p.desc))]));
  const claimed = await step(c, ctx, "R6", "claim until empty", () => claimAll(c, ctx, batchA, fenceA), (r) => JSON.stringify(r.calls));
  expectEqual(ctx, "B2a-3a", "every claim response is at most 1 MiB of serialized JSON", claimed.calls.every((x) => x.bytes <= 1048576), true);
  expectEqual(ctx, "B2a-3b", "the escaping-heavy set needs more than one claim (bound is binding)", claimed.calls.length > 1, true);
  expectEqual(ctx, "B2a-3c", "every planned work was returned exactly once (none stranded)", claimed.ids.size, all.length);

  // --- Staging refusals (real SQL regressions) -----------------------------
  const fixtureWork = planned.find((p) => p.desc.audienceKind === "site" && p.desc.partitionKey === "RP-1")!;
  const wid = claimed.ids.get(dkey(fixtureWork.desc))!;
  const v1 = fixtureWork.rows.event_facts.find((r) => r.event_id === "rp-v1")!;
  const stage1 = (rows: Partial<ResultRows>) => rpc(c, ctx, "select * from public.stage_reporting_result($1, $2, $3, $4::jsonb)", [batchA, fenceA, wid, JSON.stringify(buildChunks({ ...emptyRows(), ...rows })[0])]);
  await refused(c, ctx, "B2a-1a", "a required field set to null", /event_facts\.role must be one of/, () => stage1({ event_facts: [{ ...v1, role: null }] }));
  await refused(c, ctx, "B2a-1b", "production_date 2026-02-30 (calendar)", /production_date must be a YYYY-MM-DD date or null/, () => stage1({ event_facts: [{ ...v1, production_date: "2026-02-30" }] }));
  await refused(c, ctx, "B2a-1c", "production_date 2100-02-29 (not a leap year)", /production_date must be a YYYY-MM-DD date or null/, () => stage1({ event_facts: [{ ...v1, production_date: "2100-02-29" }] }));
  await refused(c, ctx, "B2a-2a", "another worker's staff id on the row", /staff_id differs from the frozen source/, () => stage1({ event_facts: [{ ...v1, staff_id: "00000000-0000-4000-8000-000000000001" }] }));
  await refused(c, ctx, "B2a-2b", "a whitespace-id row as an ordinary fact", /has a malformed identity/, () => stage1({ event_facts: [{ ...v1, event_id: WS_ID, created_at: fx.find((x) => x.id === WS_ID)!.created_at }] }));
  await refused(c, ctx, "B2a-2c", "a valid-id row as a source issue", /has a valid identity/, () => stage1({ source_issue_facts: [{ event_id: "rp-v1", event_type: "line_verified", created_at: v1.created_at, staff_id: ctx.staff, raw_order: "RP-1", parent_event_id: null, issue_kind: "invalid_event", issue_detail: "missing id or site" }] }));
  await refused(c, ctx, "B2a-0", "a four-array envelope", /exactly the arrays/, async () => {
    const four = canonicalJson({ event_facts: [], cancel_edges: [], order_occurrences: [], timing_facts: [] });
    const h = sha256Hex(four);
    await rpc(c, ctx, "select * from public.stage_reporting_result($1, $2, $3, $4::jsonb)", [batchA, fenceA, wid, JSON.stringify({ chunkNo: 0, chunkCount: 1, chunkHash: h, resultDigest: sha256Hex(h), canonicalRows: four })]);
  });
  expectEqual(ctx, "B2a-r", "no refused chunk was stored", Number((await c.query("select count(*)::int as n from reporting_private.partition_results r join reporting_private.partition_work w on w.work_id = r.work_id where w.batch_id = $1", [batchA])).rows[0].n), 0);
  await refused(c, ctx, "P0", "publication before every work is staged", /is incomplete/, () => publish(c, ctx, batchA, fenceA));

  // --- Stage and publish ---------------------------------------------------
  await step(c, ctx, "P1", "stage every work (bulk requests)", () => stageAll(c, ctx, batchA, fenceA, all, claimed.ids));
  const p1 = await step(c, ctx, "P2", `publish the ${A} rebuild`, () => publish(c, ctx, batchA, fenceA), (r) => `generation ${r.generation_seq}, replay ${r.replay}`);
  expectEqual(ctx, "P2a", "site metadata moved to the new generation", (await c.query("select active_generation_id::text as g, active_batch_id from reporting_private.site_state where site = $1", [A])).rows[0], { g: p1.generation_id, active_batch_id: null });
  expectEqual(ctx, "P2b", "daily totals (site) = reducer on the frozen fixture (excluded/unclassified lines kept, cancelled line removed)", await sqlDaily(c, A, null), reducerDaily(A, frozen, cutoff, null));
  expectEqual(ctx, "P2c", "daily totals (self) = reducer on that worker's rows", await sqlDaily(c, A, ctx.staff), reducerDaily(A, frozen, cutoff, ctx.staff));
  const k1 = await counts(c, A);
  expectEqual(ctx, "P2d", "mirror, current versions and frozen candidate are the SAME (event_id, image) set; no ownerless fact",
    { ...(await c.query(IMAGE_DIFF_SQL, [batchA, A])).rows[0], ownerless: k1.ownerless },
    { candidate_not_mirror: 0, mirror_not_candidate: 0, candidate_not_versions: 0, versions_not_candidate: 0, ownerless: 0 });
  const plannedKeys = plannedFamilies(planned);
  expectEqual(ctx, "P2f", "every one of the five families is non-empty in the fixture (non-vacuous)", Object.values(familyCounts(plannedKeys)).every((n) => n > 0), true);
  expectEqual(ctx, "P2g", "current rows of all five families at A are exactly the planned rows (both audiences)", await currentFamilies(c, A, ids), plannedKeys);
  expectEqual(ctx, "P2e", "the whitespace-id row is a current source issue, not a fact", (await c.query("select (select count(*) from reporting_private.source_issue_facts where site = $1 and event_id = $2 and valid_to_seq is null)::int as issues, (select count(*) from reporting_private.event_facts where site = $1 and event_id = $2)::int as facts", [A, WS_ID])).rows[0], { issues: 2, facts: 0 });
  const p1b = await step(c, ctx, "P3", "replay of the same publication inside this transaction (the committed lost response is --committed-interleavings C)", () => publish(c, ctx, batchA, fenceA), (r) => `generation ${r.generation_seq}, replay ${r.replay}`);
  expectEqual(ctx, "P3a", "replay returns the same generation and writes nothing", { g: p1b.generation_id, replay: p1b.replay, k: await counts(c, A) }, { g: p1.generation_id, replay: true, k: k1 });
  await refused(c, ctx, "P3b", "replay under another fence", /published under another fence/, () => publish(c, ctx, batchA, fenceA + 1));

  // --- Refresh A: update, delete, insert, move; takeover --------------------
  await step(c, ctx, "F1", "source changes at A: update rp-v1, delete rp-x1 and order RP-9 (timing + occurrence), insert rp-v6, move rp-m1 to B", async () => {
    await c.query("update public.production_events set line_quantity = 3 where location = $1 and id = 'rp-v1'", [A]);
    await c.query("delete from public.production_events where location = $1 and id = any(array['rp-x1', 'rp-v9', 'rp-t9'])", [A]);
    await insertFixtures(c, A, [{ ...fx[0], id: "rp-v6", line_quantity: 1, created_at: "2026-01-12T13:00:00Z" }]);
    await c.query("update public.production_events set location = $2 where location = $1 and id = 'rp-m1'", [A, B]);
  });
  const [rf] = await step(c, ctx, "F2", `begin refresh of ${A} (one-statement freeze)`, () => rpc(c, ctx, "select * from public.begin_reporting_batch($1)", [A]), (r) => `${r[0].change_count} changes, ${r[0].event_count} events`);
  const batchR = String(rf.batch_id);
  let fenceR = Number(rf.lease_fence);
  const cutoffR = new Date(String(rf.source_cutoff)).toISOString();
  const frozenR = await frozenEvents(c, batchR, [...ids, "rp-v6"]);
  const plannedR = plannedFor(A, frozenR, cutoffR, ctx.staff, (o) => o.partitionKey === "RP-1", [{ partitionKind: "event", partitionKey: "rp-x1" }, { partitionKind: "order", partitionKey: "RP-M" }, { partitionKind: "order", partitionKey: "RP-9" }]);
  await step(c, ctx, "F3", `plan, seal and claim ${plannedR.length} works (RP-1, empty rp-x1, RP-M and RP-9)`, async () => {
    await planAll(c, ctx, batchR, fenceR, plannedR.map((p) => p.desc));
    await rpc(c, ctx, "select * from public.seal_reporting_work($1, $2, $3, $4)", [batchR, fenceR, plannedR.length, reportingManifestHash(plannedR.map((p) => p.desc))]);
    await claimAll(c, ctx, batchR, fenceR);
  });
  await step(c, ctx, "F4", "the lease expires (fixture time shift inside the transaction)", async () => {
    await c.query("update reporting_private.batches set lease_expires_at = now() - interval '1 second' where batch_id = $1", [batchR]);
    await c.query("update reporting_private.site_state set lease_expires_at = now() - interval '1 second' where site = $1", [A]);
  });
  const oldFence = fenceR;
  const [rs] = await step(c, ctx, "F5", "takeover inside this transaction (resume: fence + 1, leased work back to pending; the durable cross-connection takeover is --committed-interleavings B)", () => rpc(c, ctx, "select * from public.resume_reporting_batch($1, $2)", [batchR, fenceR]), (r) => `fence ${r[0].lease_fence}, returned ${r[0].returned_work}`);
  fenceR = Number(rs.lease_fence);
  await refused(c, ctx, "F6", "the old worker publishes after takeover", /obsolete/, () => publish(c, ctx, batchR, oldFence));
  await refused(c, ctx, "F7", "the old worker claims after takeover", /obsolete/, () => rpc(c, ctx, "select * from public.claim_reporting_work($1, $2, 10)", [batchR, oldFence]));
  const claimedR = await step(c, ctx, "F8", "the new worker claims and stages everything", async () => {
    const cl = await claimAll(c, ctx, batchR, fenceR);
    await stageAll(c, ctx, batchR, fenceR, plannedR, cl.ids);
    return cl;
  }, (r) => `${r.ids.size} works`);
  expectEqual(ctx, "F8a", "every refresh work was reclaimed after takeover", claimedR.ids.size, plannedR.length);
  const p2 = await step(c, ctx, "F9", `publish the ${A} refresh`, () => publish(c, ctx, batchR, fenceR), (r) => `generation ${r.generation_seq}, receipts ${r.receipts}, acknowledged ${r.acknowledged}`);
  expectEqual(ctx, "F9a", "the deleted event's facts are closed (empty replacement) and its mirror row removed",
    (await c.query("select (select count(*) from reporting_private.event_facts where site = $1 and event_id = 'rp-x1' and valid_to_seq is null)::int as facts, (select count(*) from reporting_private.source_current where site = $1 and event_id = 'rp-x1')::int as mirror, (select count(*) from reporting_private.source_versions where site = $1 and event_id = 'rp-x1' and valid_to_seq is null)::int as versions", [A])).rows[0],
    { facts: 0, mirror: 0, versions: 0 });
  expectEqual(ctx, "F9b", "the moved event's old owner was emptied at A", Number((await c.query("select count(*)::int as n from reporting_private.event_facts where site = $1 and event_id = 'rp-m1' and valid_to_seq is null", [A])).rows[0].n), 0);
  expectEqual(ctx, "F9c", "daily totals (site) after the refresh = reducer", await sqlDaily(c, A, null), reducerDaily(A, frozenR, cutoffR, null));
  expectEqual(ctx, "F9d", "the updated event has a closed and a current version", (await c.query("select count(*)::int as n, count(*) filter (where valid_to_seq is null)::int as cur from reporting_private.source_versions where site = $1 and event_id = 'rp-v1'", [A])).rows[0], { n: 2, cur: 1 });
  const idsR = [...ids, "rp-v6"];
  expectEqual(ctx, "F9g", "after replacement and deletion, current rows of all five families at A are exactly the refresh's planned rows", await currentFamilies(c, A, idsR), plannedFamilies(plannedR));
  expectEqual(ctx, "F9h", "deleted RP-9: no current occurrence/timing row; its closed rows are RETAINED at the old generation",
    (await c.query("select (select count(*) from reporting_private.order_occurrences where site = $1 and terminal_event_id = 'rp-t9' and valid_to_seq is null)::int as occ_current, (select count(*) from reporting_private.order_occurrences where site = $1 and terminal_event_id = 'rp-t9' and valid_to_seq = $2::bigint)::int as occ_retained, (select count(*) from reporting_private.timing_facts where site = $1 and event_id = 'rp-v9' and valid_to_seq is null)::int as timing_current, (select count(*) from reporting_private.timing_facts where site = $1 and event_id = 'rp-v9' and valid_to_seq = $2::bigint)::int as timing_retained", [A, p2.generation_seq])).rows[0],
    { occ_current: 0, occ_retained: 2, timing_current: 0, timing_retained: 2 });
  expectEqual(ctx, "F9i", "replaced RP-1: occurrence and timing rows have a retained closed version and a new current one per audience",
    (await c.query("select (select count(*) filter (where valid_to_seq = $2::bigint) from reporting_private.order_occurrences where site = $1 and terminal_event_id = 'rp-t1')::int as occ_closed, (select count(*) filter (where valid_from_seq = $2::bigint and valid_to_seq is null) from reporting_private.order_occurrences where site = $1 and terminal_event_id = 'rp-t1')::int as occ_new, (select count(*) filter (where valid_to_seq = $2::bigint) from reporting_private.timing_facts where site = $1 and event_id = 'rp-v1')::int as timing_closed, (select count(*) filter (where valid_from_seq = $2::bigint and valid_to_seq is null) from reporting_private.timing_facts where site = $1 and event_id = 'rp-v1')::int as timing_new", [A, p2.generation_seq])).rows[0],
    { occ_closed: 2, occ_new: 2, timing_closed: 2, timing_new: 2 });
  expectEqual(ctx, "F9j", "fixture mirror images equal the source rows exactly, current versions equal the mirror, and deleted ids have no current version",
    (await c.query(FIXTURE_IMAGE_SQL, [A, idsR])).rows[0],
    { source_rows: idsR.length - 4, mirror_rows: idsR.length - 4, mirror_differs: 0, version_differs: 0, deleted_still_current: 0 });
  expectEqual(ctx, "F9e", "the A->B move is received by A but NOT acknowledged (B has not published)", (await c.query("select acknowledged_at is null as pending from reporting_private.changes where old_event_id = 'rp-m1' and old_site = $1 and new_site = $2", [A, B])).rows.map((x) => x.pending), [true]);
  expectEqual(ctx, "F9f", "previous generation superseded with a seven-day expiry", (await c.query("select state, (expires_at - superseded_at) = interval '7 days' as week from reporting_private.generations where generation_id = $1", [p1.generation_id])).rows[0], { state: "superseded", week: true });

  // --- Rebuild B: receives the move ---------------------------------------
  const [rbB] = await step(c, ctx, "X1", `begin rebuild of ${B}`, () => rpc(c, ctx, "select * from public.begin_reporting_rebuild($1)", [B]));
  const batchB = String(rbB.batch_id);
  const fenceB = Number(rbB.lease_fence);
  await step(c, ctx, "X2", `copy and freeze ${B}`, async () => {
    await copyAll(c, ctx, batchB, fenceB);
    return rpc(c, ctx, "select * from public.freeze_reporting_rebuild($1, $2)", [batchB, fenceB]);
  }, (r) => `${r[0].change_count} pending changes frozen`);
  const frozenB = await frozenEvents(c, batchB, ["rp-m1"]);
  const cutoffB = new Date(String((await c.query("select source_cutoff from reporting_private.batches where batch_id = $1", [batchB])).rows[0].source_cutoff)).toISOString();
  const plannedB = plannedFor(B, frozenB, cutoffB, ctx.staff, () => true);
  await step(c, ctx, "X3", `plan, seal, claim, stage and publish ${B}`, async () => {
    await planAll(c, ctx, batchB, fenceB, plannedB.map((p) => p.desc));
    await rpc(c, ctx, "select * from public.seal_reporting_work($1, $2, $3, $4)", [batchB, fenceB, plannedB.length, reportingManifestHash(plannedB.map((p) => p.desc))]);
    const cl = await claimAll(c, ctx, batchB, fenceB);
    await stageAll(c, ctx, batchB, fenceB, plannedB, cl.ids);
    return publish(c, ctx, batchB, fenceB);
  }, (r) => `generation ${r.generation_seq}, acknowledged ${r.acknowledged}`);
  expectEqual(ctx, "X3a", "the A->B move is acknowledged once both sites published", (await c.query("select acknowledged_at is not null as done from reporting_private.changes where old_event_id = 'rp-m1' and old_site = $1 and new_site = $2", [A, B])).rows.map((x) => x.done), [true]);
  expectEqual(ctx, "X3b", "the moved event is a current fact at B", Number((await c.query("select count(*)::int as n from reporting_private.event_facts where site = $1 and event_id = 'rp-m1' and valid_to_seq is null", [B])).rows[0].n) > 0, true);

  // --- No-change publication ------------------------------------------------
  const [nc] = await step(c, ctx, "N1", `begin a no-change refresh of ${A}`, () => rpc(c, ctx, "select * from public.begin_reporting_batch($1)", [A]), (r) => `${r[0].change_count} changes`);
  const p3 = await step(c, ctx, "N2", "seal zero work and publish", async () => {
    await rpc(c, ctx, "select * from public.seal_reporting_work($1, $2, 0, $3)", [nc.batch_id, nc.lease_fence, reportingManifestHash([])]);
    return publish(c, ctx, String(nc.batch_id), Number(nc.lease_fence));
  }, (r) => `generation ${r.generation_seq}`);
  expectEqual(ctx, "N2a", "a no-change generation installs no fact and closes none",
    (await c.query("select (select count(*) from reporting_private.event_facts where site = $1 and (valid_from_seq = $2::bigint or valid_to_seq = $2::bigint))::int as touched", [A, p3.generation_seq])).rows[0], { touched: 0 });
}

// ---------------------------------------------------------------------------
// Multi-connection interleavings (installed; nothing commits)
// ---------------------------------------------------------------------------

export interface InterleaveCtx {
  sites: [Site, Site];
  staff: string;
  open(): Promise<Db & { end(): Promise<void> }>;
  as(c: Db, service: boolean): Promise<void>;
  record(o: Observation): void;
  redact(s: string): string;
  now(): number;
  sleep(ms: number): Promise<void>;
  maxPages: number;
}

/** n fresh connections; each is rolled back and ended; every cleanup failure is reported. */
export async function withConnections<T>(ctx: Pick<InterleaveCtx, "open">, n: number, fn: (cs: Array<Db & { end(): Promise<void> }>) => Promise<T>, cleanupFailures: string[]): Promise<T> {
  const cs: Array<Db & { end(): Promise<void> }> = [];
  let failure: unknown = null;
  let result: T | undefined;
  try {
    for (let i = 0; i < n; i++) cs.push(await ctx.open());
    result = await fn(cs);
  } catch (e) {
    failure = e;
  }
  for (const c of cs) {
    await c.query("rollback").catch((e) => cleanupFailures.push(`scenario connection rollback: ${e instanceof Error ? e.message : String(e)}`));
    await c.end().catch((e) => cleanupFailures.push(`scenario connection disconnect: ${e instanceof Error ? e.message : String(e)}`));
  }
  if (failure) throw failure;
  return result as T;
}

/** Observe a promise at once (no unhandled rejection); inspect where awaited. */
function settle<T>(p: Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: unknown }> {
  return p.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }));
}

async function waitsOnLock(mon: Db, pid: number, ctx: Pick<InterleaveCtx, "sleep">): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    const r = await mon.query("select wait_event_type from pg_catalog.pg_stat_activity where pid = $1", [pid]);
    if (r.rows[0]?.wait_event_type === "Lock") return true;
    await ctx.sleep(100);
  }
  return false;
}

async function zeroWorkRebuild(c: Db, ctx: InterleaveCtx, site: Site): Promise<Record<string, unknown>> {
  const fctx = { ...ctx, record: () => undefined } as unknown as FlowCtx;
  const [b] = await rpc(c, fctx, "select * from public.begin_reporting_rebuild($1)", [site]);
  await copyAll(c, fctx, String(b.batch_id), Number(b.lease_fence));
  await rpc(c, fctx, "select * from public.freeze_reporting_rebuild($1, $2)", [b.batch_id, b.lease_fence]);
  await rpc(c, fctx, "select * from public.seal_reporting_work($1, $2, 0, $3)", [b.batch_id, b.lease_fence, reportingManifestHash([])]);
  return publish(c, fctx, String(b.batch_id), Number(b.lease_fence));
}

export async function runInterleavings(ctx: InterleaveCtx, cleanupFailures: string[]): Promise<void> {
  const [A, B] = ctx.sites;
  const run = async (id: string, what: string, expected: string, fn: () => Promise<{ ok: boolean; result: string }>) => {
    const t0 = ctx.now();
    try {
      const o = await fn();
      ctx.record({ id, what, expected, result: o.result, ok: o.ok, ms: Math.round(ctx.now() - t0) });
    } catch (e) {
      ctx.record({ id, what, expected, result: msgOf(e, ctx.redact), ok: false, ms: Math.round(ctx.now() - t0) });
    }
  };
  const pidOf = async (c: Db) => Number((await c.query("select pg_backend_pid() as p")).rows[0].p);
  const fctx = { ...ctx, record: () => undefined } as unknown as FlowCtx;

  await run("I0", "operator preconditions", "capture on, both processors on, no active batch", async () => {
    return withConnections(ctx, 1, async ([c]) => {
      const r = (await c.query("select (select capture_enabled from reporting_private.control where singleton) as cap, (select bool_and(processor_enabled) from reporting_private.site_state where site = any($1::text[])) as proc, (select count(*) from reporting_private.batches where site = any($1::text[]) and state in ('active','frozen','publishing'))::int as active", [[A, B]])).rows[0];
      return { ok: r.cap === true && r.proc === true && r.active === 0, result: JSON.stringify(r) };
    }, cleanupFailures);
  });

  await run("I1", "a second worker for the same site waits on the site row (no duplicate batch)", "second begin waits on a lock while the first is open", async () =>
    withConnections(ctx, 3, async ([a, b, mon]) => {
      await a.query("begin");
      await rpc(a, fctx, "select * from public.begin_reporting_rebuild($1)", [A]);
      await b.query("begin");
      const bPid = await pidOf(b);
      const second = settle(rpc(b, fctx, "select * from public.begin_reporting_rebuild($1)", [A]));
      const waited = await waitsOnLock(mon, bPid, ctx);
      await a.query("rollback");
      const out = await second;
      return { ok: waited, result: `waited=${waited}; after the first rolled back: ${out.ok ? "second began" : msgOf(out.e, ctx.redact)}` };
    }, cleanupFailures));

  await run("I2", "an UNCOMMITTED source write is invisible to a concurrent freeze (the committed lower-id case is --committed-interleavings A)", "the freeze does not include it", async () =>
    withConnections(ctx, 2, async ([w, a]) => {
      await w.query("begin");
      await insertFixtures(w, A, [fixtureRows(ctx.staff)[0]].map((x) => ({ ...x, id: "rp-i2" })));
      await a.query("begin");
      const [b] = await rpc(a, fctx, "select * from public.begin_reporting_rebuild($1)", [A]);
      await copyAll(a, fctx, String(b.batch_id), Number(b.lease_fence));
      await rpc(a, fctx, "select * from public.freeze_reporting_rebuild($1, $2)", [b.batch_id, b.lease_fence]);
      const seen = Number((await a.query("select count(*)::int as n from reporting_private.batch_events where batch_id = $1 and event_id = 'rp-i2'", [b.batch_id])).rows[0].n)
        + Number((await a.query("select count(*)::int as n from reporting_private.source_candidate where batch_id = $1 and event_id = 'rp-i2'", [b.batch_id])).rows[0].n);
      return { ok: seen === 0, result: `rows of the uncommitted event in the frozen batch: ${seen}` };
    }, cleanupFailures));

  await run("I3", "a source write during an open publication does not wait", "the writer finishes without a lock wait", async () =>
    withConnections(ctx, 3, async ([a, w, mon]) => {
      await a.query("begin");
      await zeroWorkRebuild(a, ctx, A); // published, not committed: its locks are held
      await w.query("begin");
      const wPid = await pidOf(w);
      const write = settle(insertFixtures(w, A, [{ ...fixtureRows(ctx.staff)[0], id: "rp-i3" }]));
      let waited = false;
      for (let i = 0; i < 10; i++) {
        const r = await mon.query("select wait_event_type, state from pg_catalog.pg_stat_activity where pid = $1", [wPid]);
        if (r.rows[0]?.wait_event_type === "Lock") waited = true;
        if (r.rows[0]?.state === "idle in transaction") break;
        await ctx.sleep(100);
      }
      const out = await write;
      return { ok: !waited && out.ok, result: `waited=${waited}; write ${out.ok ? "ok" : msgOf(out.e, ctx.redact)}` };
    }, cleanupFailures));

  await run("I4", "two sites publish concurrently without deadlock (no controlled shared move here; shared acknowledgement is --committed-interleavings D)", "both publications complete", async () =>
    withConnections(ctx, 2, async ([a, b]) => {
      await a.query("begin");
      await b.query("begin");
      const [x, y] = await Promise.all([settle(zeroWorkRebuild(a, ctx, A)), settle(zeroWorkRebuild(b, ctx, B))]);
      return { ok: x.ok && y.ok, result: `${A}: ${x.ok ? "published" : msgOf(x.e, ctx.redact)}; ${B}: ${y.ok ? "published" : msgOf(y.e, ctx.redact)}` };
    }, cleanupFailures));

  await run("I5", "a worker killed after publishing but before commit leaves nothing behind", "no generation, batch or mirror row survives", async () =>
    withConnections(ctx, 1, async ([mon]) => {
      const q = "select (select count(*) from reporting_private.generations where site = $1)::int as g, (select count(*) from reporting_private.batches where site = $1)::int as b, (select count(*) from reporting_private.source_current where site = $1)::int as m";
      const before = (await mon.query(q, [A])).rows[0];
      const victim = await ctx.open();
      const k = await killOwnVictim(victim, mon, cleanupFailures, ctx, async () => {
        await victim.query("begin");
        await zeroWorkRebuild(victim, ctx, A);
      });
      const after = (await mon.query(q, [A])).rows[0];
      return { ok: k.terminated && JSON.stringify(after) === JSON.stringify(before), result: `terminated=${k.terminated} (expected termination notices: ${k.expected}); before ${JSON.stringify(before)}, after ${JSON.stringify(after)}` };
    }, cleanupFailures));
}

/** SQLSTATE 57P01 (admin_shutdown): the notice a deliberately terminated session receives. */
export function isExpectedTermination(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === "57P01" || /terminating connection due to administrator command/i.test(e instanceof Error ? e.message : String(e));
}

/**
 * T13B2b-6: run `work` on a victim connection opened by THIS invocation, then
 * terminate exactly that backend. The victim is tagged with a run-unique
 * application_name and pg_terminate_backend is only called for a session
 * whose pid AND tag match, so no other session can be killed. The expected
 * 57P01 termination notice is evidence; any other error event, and any
 * failure to end the victim, is a cleanup failure that fails the report.
 */
export async function killOwnVictim(
  victim: Db & { end(): Promise<void>; on?: (ev: string, fn: (e: unknown) => void) => void },
  mon: Db,
  cleanupFailures: string[],
  ctx: Pick<InterleaveCtx, "redact" | "sleep">,
  work: () => Promise<void>,
): Promise<{ terminated: boolean; expected: number }> {
  let expected = 0;
  victim.on?.("error", (e) => {
    if (isExpectedTermination(e)) expected++;
    else cleanupFailures.push(`victim connection error: ${msgOf(e, ctx.redact)}`);
  });
  let terminated = false;
  try {
    const tag = `rp-victim-${Math.random().toString(16).slice(2, 10)}`;
    const pid = Number((await victim.query("select pg_backend_pid() as p, set_config('application_name', $1, false) as t", [tag])).rows[0].p);
    await work();
    const r = await mon.query("select pg_catalog.pg_terminate_backend(a.pid) as k from pg_catalog.pg_stat_activity a where a.pid = $1 and a.application_name = $2", [pid, tag]);
    terminated = r.rows.length === 1 && r.rows[0].k === true;
    await ctx.sleep(300);
  } finally {
    await victim.end().catch((e) => {
      if (isExpectedTermination(e)) expected++;
      else cleanupFailures.push(`victim connection disconnect: ${msgOf(e, ctx.redact)}`);
    });
  }
  return { terminated, expected };
}

// ---------------------------------------------------------------------------
// Full-state fingerprint for the fresh restoration audit (T13B2b-4)
// ---------------------------------------------------------------------------

/** Row count + md5 over every row's full JSON image, order-independent (no key assumption). */
const rowsHash = (from: string) => `select count(*)::text || ':' || md5(coalesce(string_agg(x, '' order by x), '')) as h from (select md5(to_jsonb(t)::text) as x from ${from} t) s`;

/** Fixed surfaces: every source payload, stock, ledger, memberships, and the catalog/function/ACL state of public + reporting_private. */
export const STATE_QUERIES: ReadonlyArray<readonly [string, string]> = [
  ["source:production_events", rowsHash("public.production_events")],
  ["stock:products", rowsHash("public.products")],
  ["ledger", rowsHash("public.ledger")],
  ["memberships:user_locations", rowsHash("public.user_locations")],
  ["memberships:profiles", rowsHash("public.profiles")],
  ["catalog:functions", `select md5(coalesce(string_agg(n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')|' || md5(p.prosrc) || '|' || coalesce(p.proacl::text, '') || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|' || p.prosecdef::text || '|' || pg_catalog.pg_get_userbyid(p.proowner), E'\\n' order by n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)), '')) as h
     from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'reporting_private')`],
  ["catalog:relations", `select md5(coalesce(string_agg(n.nspname || '.' || c.relname || '|' || c.relkind || '|' || coalesce(c.relacl::text, '') || '|' || c.relrowsecurity::text || '|' || pg_catalog.pg_get_userbyid(c.relowner), E'\\n' order by n.nspname, c.relname), '')) as h
     from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'reporting_private') and c.relkind in ('r', 'v', 'm', 'S', 'i', 'p')`],
  ["catalog:columns", `select md5(coalesce(string_agg(c.relname || '.' || a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' || coalesce(a.attacl::text, ''), E'\\n' order by c.relname, a.attnum), '')) as h
     from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'reporting_private') and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped`],
  ["catalog:constraints", `select md5(coalesce(string_agg(c.relname || '.' || k.conname || ':' || pg_catalog.pg_get_constraintdef(k.oid), E'\\n' order by c.relname, k.conname), '')) as h
     from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid = k.conrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'reporting_private')`],
  ["catalog:indexes", `select md5(coalesce(string_agg(d, E'\\n' order by d), '')) as h from (select pg_catalog.pg_get_indexdef(i.indexrelid) as d
     from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'reporting_private')) s`],
  ["catalog:policies", `select md5(coalesce(string_agg(schemaname || '.' || tablename || '.' || policyname || ':' || cmd || ':' || roles::text || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), E'\\n' order by schemaname, tablename, policyname), '')) as h
     from pg_catalog.pg_policies where schemaname in ('public', 'reporting_private')`],
  ["catalog:triggers", `select md5(coalesce(string_agg(c.relname || '.' || t.tgname || ':' || t.tgenabled || ':' || pg_catalog.pg_get_triggerdef(t.oid), E'\\n' order by c.relname, t.tgname), '')) as h
     from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'reporting_private') and not t.tgisinternal`],
  ["catalog:schemas-roles", `select md5(coalesce((select string_agg(nspname || ':' || coalesce(nspacl::text, ''), ',' order by nspname) from pg_catalog.pg_namespace where nspname in ('public', 'reporting_private')), '') || '|' ||
       coalesce((select string_agg(rolname || ':' || rolcanlogin::text || rolinherit::text || rolsuper::text || rolbypassrls::text || rolcreaterole::text || rolcreatedb::text, ',' order by rolname) from pg_catalog.pg_roles where rolname = 'reporting_capture'), '') || '|' ||
       coalesce((select string_agg(pg_catalog.pg_get_userbyid(m.roleid) || '>' || pg_catalog.pg_get_userbyid(m.member) || ':' || m.inherit_option::text || m.set_option::text, ',' order by 1) from pg_catalog.pg_auth_members m
                  where m.roleid = (select oid from pg_catalog.pg_roles where rolname = 'reporting_capture') or m.member = (select oid from pg_catalog.pg_roles where rolname = 'reporting_capture')), '')) as h`],
];

/** Single-row states compared field by field, so a mode can declare exactly which changes it may leave. */
export const CONTROL_SQL = "select capture_epoch::text as capture_epoch, capture_enabled, rule_version, updated_at::text as updated_at from reporting_private.control where singleton";
export const SITE_STATE_SQL =
  "select site, processor_enabled, read_mode, source_epoch::text as source_epoch, active_generation_id::text as active_generation_id, active_batch_id::text as active_batch_id, lease_fence::text as lease_fence, lease_expires_at::text as lease_expires_at, heartbeat_at::text as heartbeat_at, last_verified_cutoff::text as last_verified_cutoff, updated_at::text as updated_at from reporting_private.site_state order by site";

export interface FullState {
  surfaces: Record<string, string>;
  /** Every reporting_private table except control/site_state: row count + full-row hash. */
  privateTables: Record<string, string>;
  control: Record<string, unknown> | null;
  siteState: Array<Record<string, unknown>>;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
/**
 * Generated sequence positions are deliberately NOT part of the state: a
 * rolled-back insert still advances an identity sequence. Everything else
 * (rows, payloads, catalog, ACLs) must match exactly unless a mode declares it.
 */
export async function fullState(c: Db): Promise<FullState> {
  const surfaces: Record<string, string> = {};
  for (const [k, sql] of STATE_QUERIES) surfaces[k] = String((await c.query(sql)).rows[0].h);
  const privateTables: Record<string, string> = {};
  let control: Record<string, unknown> | null = null;
  let siteState: Array<Record<string, unknown>> = [];
  const hasSchema = Boolean((await c.query("select exists (select 1 from pg_catalog.pg_namespace where nspname = 'reporting_private') as x")).rows[0].x);
  if (hasSchema) {
    const tables = (await c.query("select c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'reporting_private' and c.relkind = 'r' order by c.relname")).rows.map((r) => String(r.relname));
    for (const t of tables) {
      if (!IDENT.test(t)) throw new Error(`unexpected table name ${t}`);
      if (t === "control" || t === "site_state") continue;
      privateTables[t] = String((await c.query(rowsHash(`reporting_private."${t}"`))).rows[0].h);
    }
    control = (await c.query(CONTROL_SQL)).rows[0] ?? null;
    siteState = (await c.query(SITE_STATE_SQL)).rows;
  }
  return { surfaces, privateTables, control, siteState };
}

/** Exactly which changes a mode may leave behind (everything else must be identical). */
export interface StateAllowance {
  /** control.capture_epoch must equal before + this (committed toggles); 0 for rollback-only modes. */
  epochIncrement: number;
  /** control.updated_at may differ (committed toggles). */
  controlUpdatedAt: boolean;
  /** site_state fields that may differ on `sites` (monotonic lease fence and lease/heartbeat timestamps). */
  siteFields: string[];
  sites: string[];
}
export const ROLLBACK_ONLY: StateAllowance = { epochIncrement: 0, controlUpdatedAt: false, siteFields: [], sites: [] };

export function compareFullState(before: FullState, after: FullState, allow: StateAllowance = ROLLBACK_ONLY): string[] {
  const p: string[] = [];
  for (const k of new Set([...Object.keys(before.surfaces), ...Object.keys(after.surfaces)])) {
    if (before.surfaces[k] !== after.surfaces[k]) p.push(`${k} differs (${before.surfaces[k] ?? "absent"} -> ${after.surfaces[k] ?? "absent"})`);
  }
  for (const k of new Set([...Object.keys(before.privateTables), ...Object.keys(after.privateTables)])) {
    if (before.privateTables[k] !== after.privateTables[k]) p.push(`reporting_private.${k} differs (${before.privateTables[k] ?? "absent"} -> ${after.privateTables[k] ?? "absent"})`);
  }
  const bc = before.control;
  const ac = after.control;
  if ((bc === null) !== (ac === null)) p.push("control row presence differs");
  else if (bc && ac) {
    const want = (BigInt(String(bc.capture_epoch)) + BigInt(allow.epochIncrement)).toString();
    if (String(ac.capture_epoch) !== want) p.push(`capture_epoch is ${String(ac.capture_epoch)}, expected exactly ${want} (${String(bc.capture_epoch)} + ${allow.epochIncrement})`);
    if (ac.capture_enabled !== bc.capture_enabled) p.push(`capture_enabled is ${String(ac.capture_enabled)}, was ${String(bc.capture_enabled)}`);
    if (ac.rule_version !== bc.rule_version) p.push("rule_version differs");
    if (!allow.controlUpdatedAt && ac.updated_at !== bc.updated_at) p.push("control.updated_at differs");
  }
  const bySite = (rows: Array<Record<string, unknown>>) => new Map(rows.map((r) => [String(r.site), r]));
  const bs = bySite(before.siteState);
  const as = bySite(after.siteState);
  for (const site of new Set([...bs.keys(), ...as.keys()])) {
    const b = bs.get(site);
    const a = as.get(site);
    if (!b || !a) {
      p.push(`site_state ${site} presence differs`);
      continue;
    }
    for (const f of new Set([...Object.keys(b), ...Object.keys(a)])) {
      const allowed = allow.sites.includes(site) && allow.siteFields.includes(f);
      if (!allowed && JSON.stringify(a[f]) !== JSON.stringify(b[f])) p.push(`site_state ${site}.${f} is ${JSON.stringify(a[f])}, was ${JSON.stringify(b[f])}`);
    }
    if (allow.sites.includes(site) && allow.siteFields.includes("lease_fence") && BigInt(String(a.lease_fence)) < BigInt(String(b.lease_fence))) p.push(`site_state ${site}.lease_fence went backwards`);
  }
  return p;
}
