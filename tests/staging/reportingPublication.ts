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
export type PublicationMode = "rehearse-migration" | "check-installed" | "interleavings";
export interface Db {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

// ---------------------------------------------------------------------------
// Arguments and the migration body
// ---------------------------------------------------------------------------

export function parsePublicationArgs(argv: readonly string[]): { mode: PublicationMode | null; sites: [Site, Site] | null; maxPages: number; problems: string[] } {
  const problems: string[] = [];
  const modes = argv.filter((a) => ["--rehearse-migration", "--check-installed", "--interleavings"].includes(a));
  const sitesArg = argv.find((a) => a.startsWith("--sites="));
  const pagesArg = argv.find((a) => a.startsWith("--max-pages="));
  const unknown = argv.filter((a) => a.startsWith("--") && !modes.includes(a) && a !== sitesArg && a !== pagesArg);
  if (modes.length !== 1) problems.push("choose exactly one of --rehearse-migration, --check-installed, --interleavings");
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
  const label = (i: number) => (st[i]?.label ?? "").trim().toUpperCase();
  if (label(0) !== "BEGIN" || label(st.length - 1) !== "COMMIT") throw new Error("0038 must be one BEGIN … COMMIT transaction");
  const inner = st.slice(1, -1);
  for (const s of inner) {
    const code = s.text.replace(/--[^\n]*/g, " ").trim();
    if (/^(BEGIN|COMMIT|ROLLBACK|END|START\s+TRANSACTION|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/i.test(code)) throw new Error(`0038 contains transaction control inside its body: ${code.slice(0, 40)}`);
  }
  return inner.map((s) => s.text);
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
}

export function newPublicationReport(mode: PublicationMode, sites: [Site, Site], revision: string, startedAt: string, draftSha256: string): PublicationReport {
  return { mode, sites, revision, startedAt, draftSha256, statementsApplied: null, settings: "", catalogProblems: [], observations: [], cleanup: [], errors: [], finishedAt: "", restorationVerified: null, restoration: null, restorationProblems: [] };
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
    ...(r.restorationProblems.length ? ["## Restoration problems", ...r.restorationProblems.map((p) => `- ${p}`), ""] : []),
    publicationStatus(r),
  ];
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Flow helpers
// ---------------------------------------------------------------------------

export interface FlowCtx {
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
  ];
}
const FIXTURE_IDS = (rows: Array<Record<string, unknown>>) => rows.map((x) => String(x.id));

async function insertFixtures(c: Db, site: Site, rows: Array<Record<string, unknown>>): Promise<void> {
  for (const x of rows) {
    await c.query(
      `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id)
       values ($1, $2, $3::uuid, $4, $5, $6, $7, $8, 'rp-station', 'publication rehearsal', $9::timestamptz, null, $10)`,
      [site, x.id, x.staff_id, x.department, x.order_number, x.line_sku, x.line_quantity, x.event_type, x.created_at, x.parent_event_id],
    );
  }
}

/** Frozen images (candidate or batch view) of the given ids, as evidence events. */
async function frozenEvents(c: Db, batch: string, ids: string[]): Promise<ProductionEvidenceEvent[]> {
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

interface Planned {
  desc: WorkDescriptor;
  rows: ResultRows;
}
function plannedFor(site: Site, events: ProductionEvidenceEvent[], cutoff: string, staff: string, keep: (o: Owner) => boolean, empties: Owner[] = []): Planned[] {
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
export async function rpc(c: Db, ctx: Pick<FlowCtx, "as">, sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  await ctx.as(c, true);
  const rows = (await c.query(sql, params)).rows;
  await ctx.as(c, false);
  return rows;
}

async function planAll(c: Db, ctx: FlowCtx, batch: string, fence: number, descs: WorkDescriptor[]): Promise<void> {
  for (let i = 0; i < descs.length; i += 300) await rpc(c, ctx, "select * from public.plan_reporting_work($1, $2, $3::jsonb)", [batch, fence, JSON.stringify(descs.slice(i, i + 300))]);
}

async function claimAll(c: Db, ctx: FlowCtx, batch: string, fence: number): Promise<{ calls: Array<{ rows: number; bytes: number }>; ids: Map<string, string> }> {
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

async function stageAll(c: Db, ctx: FlowCtx, batch: string, fence: number, planned: Planned[], ids: Map<string, string>): Promise<void> {
  const entries = planned.flatMap((p) => buildChunks(p.rows).map((chunk) => ({ partition: ids.get(dkey(p.desc))!, chunk })));
  for (const req of packStageRequests(entries)) await rpc(c, ctx, "select * from public.stage_reporting_results($1, $2, $3::jsonb)", [batch, fence, JSON.stringify(req)]);
}

async function copyAll(c: Db, ctx: FlowCtx, batch: string, fence: number): Promise<{ pages: number; rows: number }> {
  let after: string | null = null;
  for (let page = 1; page <= ctx.maxPages; page++) {
    const [r] = await rpc(c, ctx, "select * from public.copy_reporting_source_page($1, $2, $3)", [batch, fence, after]);
    if (r.complete) return { pages: Number(r.pages), rows: Number(r.total_rows) };
    after = String(r.next_after_event_id);
  }
  throw new Error(`the site needs more than ${ctx.maxPages} copy pages (raise --max-pages after checking its size)`);
}

async function publish(c: Db, ctx: FlowCtx, batch: string, fence: number) {
  const [r] = await rpc(c, ctx, "select * from public.publish_reporting_batch($1, $2)", [batch, fence]);
  return r;
}

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
  const cand = Number((await c.query("select count(*)::int as n from reporting_private.source_candidate where batch_id = $1", [batchA])).rows[0].n);
  expectEqual(ctx, "P2d", "mirror and current versions equal the frozen candidate; no ownerless fact", k1, { mirror: cand, versions: cand, ownerless: 0 });
  expectEqual(ctx, "P2e", "the whitespace-id row is a current source issue, not a fact", (await c.query("select (select count(*) from reporting_private.source_issue_facts where site = $1 and event_id = $2 and valid_to_seq is null)::int as issues, (select count(*) from reporting_private.event_facts where site = $1 and event_id = $2)::int as facts", [A, WS_ID])).rows[0], { issues: 2, facts: 0 });
  const p1b = await step(c, ctx, "P3", "lost-response replay of the same publication", () => publish(c, ctx, batchA, fenceA), (r) => `generation ${r.generation_seq}, replay ${r.replay}`);
  expectEqual(ctx, "P3a", "replay returns the same generation and writes nothing", { g: p1b.generation_id, replay: p1b.replay, k: await counts(c, A) }, { g: p1.generation_id, replay: true, k: k1 });
  await refused(c, ctx, "P3b", "replay under another fence", /published under another fence/, () => publish(c, ctx, batchA, fenceA + 1));

  // --- Refresh A: update, delete, insert, move; takeover --------------------
  await step(c, ctx, "F1", "source changes at A: update rp-v1, delete rp-x1, insert rp-v6, move rp-m1 to B", async () => {
    await c.query("update public.production_events set line_quantity = 3 where location = $1 and id = 'rp-v1'", [A]);
    await c.query("delete from public.production_events where location = $1 and id = 'rp-x1'", [A]);
    await insertFixtures(c, A, [{ ...fx[0], id: "rp-v6", line_quantity: 1, created_at: "2026-01-12T13:00:00Z" }]);
    await c.query("update public.production_events set location = $2 where location = $1 and id = 'rp-m1'", [A, B]);
  });
  const [rf] = await step(c, ctx, "F2", `begin refresh of ${A} (one-statement freeze)`, () => rpc(c, ctx, "select * from public.begin_reporting_batch($1)", [A]), (r) => `${r[0].change_count} changes, ${r[0].event_count} events`);
  const batchR = String(rf.batch_id);
  let fenceR = Number(rf.lease_fence);
  const cutoffR = new Date(String(rf.source_cutoff)).toISOString();
  const frozenR = await frozenEvents(c, batchR, [...ids, "rp-v6"]);
  const plannedR = plannedFor(A, frozenR, cutoffR, ctx.staff, (o) => o.partitionKey === "RP-1", [{ partitionKind: "event", partitionKey: "rp-x1" }, { partitionKind: "order", partitionKey: "RP-M" }]);
  await step(c, ctx, "F3", `plan, seal and claim ${plannedR.length} works (RP-1, empty rp-x1 and RP-M)`, async () => {
    await planAll(c, ctx, batchR, fenceR, plannedR.map((p) => p.desc));
    await rpc(c, ctx, "select * from public.seal_reporting_work($1, $2, $3, $4)", [batchR, fenceR, plannedR.length, reportingManifestHash(plannedR.map((p) => p.desc))]);
    await claimAll(c, ctx, batchR, fenceR);
  });
  await step(c, ctx, "F4", "the lease expires (fixture time shift inside the transaction)", async () => {
    await c.query("update reporting_private.batches set lease_expires_at = now() - interval '1 second' where batch_id = $1", [batchR]);
    await c.query("update reporting_private.site_state set lease_expires_at = now() - interval '1 second' where site = $1", [A]);
  });
  const oldFence = fenceR;
  const [rs] = await step(c, ctx, "F5", "another worker takes over (resume: fence + 1, leased work back to pending)", () => rpc(c, ctx, "select * from public.resume_reporting_batch($1, $2)", [batchR, fenceR]), (r) => `fence ${r[0].lease_fence}, returned ${r[0].returned_work}`);
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

  await run("I2", "an uncommitted source write is invisible to a concurrent freeze and stays pending", "the freeze does not include it", async () =>
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

  await run("I4", "two sites publish concurrently (shared acknowledgement pass) without deadlock", "both publications complete", async () =>
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
      // The victim is deliberately killed: its connection errors are this observation's evidence, not cleanup failures.
      const victim = await ctx.open();
      const victimErrors: string[] = [];
      (victim as unknown as { on?: (ev: string, fn: (e: unknown) => void) => void }).on?.("error", (e) => victimErrors.push(msgOf(e, ctx.redact)));
      let killed: unknown = null;
      try {
        await victim.query("begin");
        await zeroWorkRebuild(victim, ctx, A);
        killed = (await mon.query("select pg_catalog.pg_terminate_backend($1) as k", [await pidOf(victim)])).rows[0].k;
        await ctx.sleep(300);
      } finally {
        await victim.end().catch((e) => victimErrors.push(`end: ${msgOf(e, ctx.redact)}`));
      }
      const after = (await mon.query(q, [A])).rows[0];
      return { ok: killed === true && JSON.stringify(after) === JSON.stringify(before), result: `terminated=${String(killed)}; before ${JSON.stringify(before)}, after ${JSON.stringify(after)}; victim: ${victimErrors.join("; ") || "no error event"}` };
    }, cleanupFailures));
}

// ---------------------------------------------------------------------------
// Baseline snapshot for the fresh restoration audit
// ---------------------------------------------------------------------------

export const BASELINE_SQL = `select json_build_object(
  'control', (select json_build_object('epoch', capture_epoch, 'enabled', capture_enabled, 'rule', rule_version) from reporting_private.control where singleton),
  'sites', (select json_agg(json_build_object('s', site, 'proc', processor_enabled, 'mode', read_mode, 'gen', active_generation_id, 'batch', active_batch_id, 'fence', lease_fence) order by site) from reporting_private.site_state),
  'rows', json_build_object(
    'changes', (select count(*) from reporting_private.changes), 'batches', (select count(*) from reporting_private.batches),
    'generations', (select count(*) from reporting_private.generations), 'event_facts', (select count(*) from reporting_private.event_facts),
    'daily', (select count(*) from reporting_private.daily_totals), 'mirror', (select count(*) from reporting_private.source_current)),
  'fixtures', (select count(*) from public.production_events where id like 'rp-%' or id = repeat(' ', 37)),
  'source', (select json_agg(json_build_object('site', location, 'n', n, 'ids', h) order by location)
               from (select location, count(*) as n, md5(string_agg(id, ',' order by id)) as h from public.production_events where location in ('au', 'uk', 'us') group by location) s)
) as j`;
