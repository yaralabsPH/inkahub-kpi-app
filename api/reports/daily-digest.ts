/**
 * Daily KPI digest for one location.
 *
 * GET /api/reports/daily-digest?location=au|us|uk
 *   Optional: &date=YYYY-MM-DD (production date at the site; default: the
 *                               site's current production date)
 *             &dry=1           (return xlsx to caller instead of emailing)
 *             &recipient=x@y   (override REPORT_RECIPIENT)
 *
 * Scheduled from vercel.json crons ~23:55 local per location.
 *
 * Every request (cron, manual rerun, download, diagnostics) must send
 * `Authorization: Bearer <CRON_SECRET>`. Vercel adds that header to
 * scheduled hits when CRON_SECRET is set; manual callers supply it
 * themselves. Anything else gets 401 before any other work. A cron-
 * identifying header or an app login is NOT authorization. GET only.
 *
 * Counts (F1) use the same code as the app: one production-evidence read
 * for the report day and the day before under one cutoff, the shared
 * reducer for Items/Orders/rework/coverage, and site production days that
 * start at 04:00 local. A full-site report needs the server credential
 * (SUPABASE_SERVICE_ROLE_KEY); without it the digest refuses rather than
 * reporting an RLS-limited view as complete.
 *
 * Sends via Resend using RESEND_API_KEY from env.
 */
import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import { z } from "zod";
import {
  prepareProductionEvidence,
  summarizeProduction,
  type CoverageIssueKind,
  type PreparedProductionEvidence,
  type ProductionSummary,
  type WorkType,
} from "../../src/lib/domain/productionCounts.js";
import {
  isProductionDate,
  productionDateAt,
  productionRange,
  shiftProductionDate,
  type ProductionRange,
  type ReportSite,
} from "../../src/lib/domain/productionPeriods.js";
import { loadProductionEvidence } from "../../src/lib/repository/supabase/productionEvidence.js";

interface VercelRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
}
interface VercelResponse {
  status(code: number): VercelResponse;
  json(body: unknown): void;
  send(body: string | Buffer): void;
  setHeader(name: string, value: string): void;
}

const LOCATION_LABELS: Record<string, string> = { au: "AU", uk: "UK", us: "US" };
const LOCATION_TZ: Record<string, string> = {
  au: "Australia/Sydney",
  uk: "Europe/London",
  us: "America/Chicago",
};
const DEPARTMENTS = ["a0_framed", "framed", "unframed", "dispatch"] as const;
type Department = typeof DEPARTMENTS[number];
const DEPT_LABELS: Record<Department, string> = {
  a0_framed: "A0 Framed",
  framed:    "Framed",
  unframed:  "Unframed",
  dispatch:  "Dispatch",
};
const ISSUE_LABELS: Record<CoverageIssueKind, string> = {
  invalid_event: "invalid saved events",
  unclassified_sku: "unrecognised SKUs",
  invalid_quantity: "missing or invalid quantities",
  unresolved_parent: "corrections that could not be matched",
  missing_completion_detail: "completions without line detail",
  ambiguous_repeat: "possible repeated scans",
};

interface StaffRow { user_id: string; display_name: string; }
interface ClockRow { id: string; staff_id: string | null; department: string | null; event_type: string; created_at: string; }

/** Evidence read limit: well inside the function's own time budget. */
const EVIDENCE_DEADLINE_MS = 25_000;
const PAGE_SIZE = 1000;

/* ============================================================
 * Small helpers
 * ============================================================ */

function formatDDMMYY(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return `${d}/${m}/${y.slice(2)}`;
}

function pct(now: number, prev: number): string {
  if (prev === 0) return now === 0 ? "0%" : "n/a";
  return ((now - prev) / prev * 100).toFixed(0) + "%";
}

/** Items can be null when an exact total would overflow: never print a rounded guess. */
function n(items: number | null): number | string {
  return items === null ? "too large" : items;
}

function localTime(ms: number | null, tz: string): string {
  return ms == null ? "" : new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });
}

function localStamp(iso: string, tz: string): string {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: tz });
}

type PageQuery = {
  range(from: number, to: number): PromiseLike<{ data: unknown; error: { message: string } | null; count?: number | null }>;
};

/**
 * Read every row of a query with a stable, unique order and an exact count.
 * Pages advance by the rows actually returned, so a server row cap smaller
 * than PAGE_SIZE still completes. Any page error, a non-array body, a missing
 * or changing count, an empty page before the count is reached, or more rows
 * than counted fails the report: a short page is never taken as "done".
 * The caller's query must request `{ count: "exact" }`.
 */
async function readAll<T>(build: () => PageQuery, label: string): Promise<T[]> {
  const out: T[] = [];
  let total: number | null = null;
  for (let from = 0; ; ) {
    const { data, error, count } = await build().range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    if (!Array.isArray(data)) throw new Error(`${label}: incomplete read (no rows array)`);
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error(`${label}: incomplete read (no exact count)`);
    if (total === null) total = count;
    else if (count !== total) throw new Error(`${label}: rows changed while reading (${total} then ${count})`);
    out.push(...(data as T[]));
    if (out.length === total) return out;
    if (out.length > total || data.length === 0) throw new Error(`${label}: incomplete read (${out.length} of ${total} rows)`);
    from += data.length;
  }
}

/* ============================================================
 * Day projection (shared counting; no local count rules here)
 * ============================================================ */

interface PersonDay {
  staff_id: string;
  normal: { items: number | null; orders: number };
  rework: { items: number | null; orders: number };
  first_ts: number | null;
  last_ts: number | null;
  clock_in_ts: number | null;
  clock_out_ts: number | null;
}

interface DeptDay {
  summary: ProductionSummary;
  boxes: number;
  people: Map<string, PersonDay>;
}

interface DayReport {
  date: string;
  range: ProductionRange;
  summary: ProductionSummary;
  depts: Record<Department, DeptDay>;
  distinctStaff: Set<string>;
}

function projectDay(
  evidence: PreparedProductionEvidence,
  site: ReportSite,
  date: string,
  clocks: readonly ClockRow[],
): DayReport {
  const range = productionRange(site, date, date);
  const window = { startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive };
  const startMs = Date.parse(range.startUtc);
  const endMs = Date.parse(range.endUtcExclusive);
  const summary = summarizeProduction(evidence, { range: window });
  const distinctStaff = new Set<string>(Object.keys(summary.byPerson));
  const depts = {} as Record<Department, DeptDay>;
  for (const d of DEPARTMENTS) {
    const s = summarizeProduction(evidence, { range: window, workTypes: [d as WorkType] });
    const people = new Map<string, PersonDay>();
    const person = (id: string) => {
      let p = people.get(id);
      if (!p) {
        const g = s.byPerson[id];
        p = {
          staff_id: id,
          normal: g ? { items: g.normal.items, orders: g.normal.orders } : { items: 0, orders: 0 },
          rework: g ? { items: g.rework.items, orders: g.rework.orders } : { items: 0, orders: 0 },
          first_ts: null, last_ts: null, clock_in_ts: null, clock_out_ts: null,
        };
        people.set(id, p);
      }
      return p;
    };
    for (const id of Object.keys(s.byPerson)) person(id);
    // Shift span from this person's own completions here (fallback when no clock rows).
    for (const t of evidence.terminals) {
      if (t.reversed || t.workType !== d || t.ev.ms < startMs || t.ev.ms >= endMs || !t.ev.staff_id) continue;
      const p = person(t.ev.staff_id);
      if (p.first_ts == null || t.ev.ms < p.first_ts) p.first_ts = t.ev.ms;
      if (p.last_ts == null || t.ev.ms > p.last_ts) p.last_ts = t.ev.ms;
    }
    depts[d] = { summary: s, boxes: 0, people };
  }
  for (const c of clocks) {
    const ms = Date.parse(c.created_at);
    if (!c.staff_id || !Number.isFinite(ms) || ms < startMs || ms >= endMs) continue;
    if (!(DEPARTMENTS as readonly string[]).includes(c.department ?? "")) continue;
    distinctStaff.add(c.staff_id);
    const dept = depts[c.department as Department];
    let p = dept.people.get(c.staff_id);
    if (!p) {
      p = { staff_id: c.staff_id, normal: { items: 0, orders: 0 }, rework: { items: 0, orders: 0 }, first_ts: null, last_ts: null, clock_in_ts: null, clock_out_ts: null };
      dept.people.set(c.staff_id, p);
    }
    if (c.event_type === "clock_in") p.clock_in_ts = p.clock_in_ts == null ? ms : Math.min(p.clock_in_ts, ms);
    else if (c.event_type === "clock_out") p.clock_out_ts = p.clock_out_ts == null ? ms : Math.max(p.clock_out_ts, ms);
  }
  return { date, range, summary, depts, distinctStaff };
}

/** Boxes used from ledger, routed to the department slot by package code / mail tube id (unchanged rules). */
async function addBoxes(supabase: SupabaseClient, location: string, days: DayReport[], asOfUtc: string): Promise<void> {
  //   A0-Double, A0-Single           -> a0_framed
  //   A1-Single, A1-Double-Wide,
  //   NZ, A2-Double, A3-A4           -> dispatch
  //   Mail tubes (both sizes)        -> unframed
  const A0_CODES = new Set<string>(["A0-Double", "A0-Single"]);
  const DISPATCH_CODES = new Set<string>(["A1-Single", "A1-Double-Wide", "NZ", "A2-Double", "A3-A4"]);
  const TUBE_IDS = new Set<string>(["sku-xniriygn", "sku-2jiumpm4"]);
  const products = await supabase
    .from("products")
    .select("id, code")
    .eq("location", location)
    .in("code", Array.from(new Set([...A0_CODES, ...DISPATCH_CODES])));
  if (products.error) throw new Error(`products: ${products.error.message}`);
  if (!Array.isArray(products.data)) throw new Error("products: incomplete read (no rows array)");
  const codeById = new Map<string, string>();
  for (const p of products.data as Array<{ id: string; code: string }>) codeById.set(p.id, p.code);
  const allPackageIds = Array.from(new Set<string>([...codeById.keys(), ...TUBE_IDS]));

  const first = days.reduce((a, d) => (d.range.startUtc < a ? d.range.startUtc : a), days[0].range.startUtc);
  const last = days.reduce((a, d) => (d.range.endUtcExclusive > a ? d.range.endUtcExclusive : a), days[0].range.endUtcExclusive);
  const ledger = await readAll<{ id: string; product_id: string; delta: number; ts: string }>(
    () =>
      supabase
        .from("ledger")
        .select("id, product_id, delta, ts", { count: "exact" })
        .eq("location", location)
        .in("product_id", allPackageIds)
        .lt("delta", 0)
        .gte("ts", first)
        .lt("ts", last)
        .lte("ts", asOfUtc)
        .order("ts", { ascending: true })
        .order("id", { ascending: true }) as unknown as PageQuery,
    "ledger",
  );
  for (const r of ledger) {
    const ms = Date.parse(r.ts);
    const day = days.find((d) => ms >= Date.parse(d.range.startUtc) && ms < Date.parse(d.range.endUtcExclusive));
    if (!day) continue;
    const qty = Math.abs(r.delta);
    if (TUBE_IDS.has(r.product_id)) {
      day.depts.unframed.boxes += qty;
    } else {
      const code = codeById.get(r.product_id);
      if (!code) continue; // unrelated ledger movement, skip
      if (A0_CODES.has(code)) day.depts.a0_framed.boxes += qty;
      else if (DISPATCH_CODES.has(code)) day.depts.dispatch.boxes += qty;
    }
  }
}

/* ============================================================
 * Report labels and notes
 * ============================================================ */

interface ReportMeta {
  ymd: string;
  locLabel: string;
  tz: string;
  range: ProductionRange;
  asOfUtc: string;
  loadedAtUtc: string;
  generatedAtUtc: string;
  /** False while the production day is still open at the cutoff. */
  closed: boolean;
}

function windowLabel(m: ReportMeta): string {
  return `${m.ymd} 04:00 to ${shiftProductionDate(m.ymd, 1)} 04:00 ${m.tz} (UTC ${m.range.startUtc} to ${m.range.endUtcExclusive})`;
}

function statusLabel(m: ReportMeta): string {
  return m.closed ? "final (day closed before the cutoff)" : `as of ${localStamp(m.asOfUtc, m.tz)} (day not yet closed)`;
}

interface Note { severity: string; department: string; staff: string; note: string }

function reportNotes(today: DayReport, yesterday: DayReport, m: ReportMeta): Note[] {
  const notes: Note[] = [];
  if (!m.closed) notes.push({ severity: "info", department: "-", staff: "-", note: `Counts as of ${localStamp(m.asOfUtc, m.tz)}; the production day was still open.` });
  // Warnings for every day whose figures are published: the report day and the comparison day.
  for (const [day, label] of [[today, ""], [yesterday, ` on ${yesterday.date} (comparison day)`]] as const) {
    for (const [kind, count] of Object.entries(day.summary.coverage.issueCounts) as Array<[CoverageIssueKind, number]>) {
      if (count > 0) notes.push({ severity: "warning", department: "-", staff: "-", note: `${count} ${ISSUE_LABELS[kind]}${label}: totals may be incomplete.` });
    }
  }
  for (const d of DEPARTMENTS) {
    const s = today.depts[d].summary;
    const active = (s.normal.items ?? 0) > 0 || s.normal.orders > 0 || (s.rework.items ?? 0) > 0 || s.rework.orders > 0;
    if (!active) notes.push({ severity: "info", department: DEPT_LABELS[d], staff: "-", note: "Zero activity — rostering gap?" });
  }
  return notes;
}

/* ============================================================
 * xlsx build
 * ============================================================ */
function buildXlsx(payload: { meta: ReportMeta; today: DayReport; yesterday: DayReport; staffNames: Map<string, string> }): Uint8Array {
  const { meta, today, yesterday, staffNames } = payload;
  const { ymd, locLabel, tz } = meta;
  const T = today.summary, Y = yesterday.summary;
  const staffToday = today.distinctStaff.size;
  const staffYesterday = yesterday.distinctStaff.size;
  const perStaffToday = staffToday > 0 && T.normal.items !== null ? T.normal.items / staffToday : 0;
  const perStaffYesterday = staffYesterday > 0 && Y.normal.items !== null ? Y.normal.items / staffYesterday : 0;
  const notes = reportNotes(today, yesterday, meta);

  // Sheet 1 - Summary. orders_total is distinct completed orders across work types
  // (not a sum of departments); items_total is work processed across work types.
  const summarySheet = XLSX.utils.aoa_to_sheet([
    ["date", "location", "orders_total", "items_total", "orders_yesterday", "items_yesterday", "staff_on_shift", "staff_yesterday", "items_per_staff", "items_per_staff_yesterday", "notes",
      "rework_orders", "rework_items", "rework_orders_yesterday", "rework_items_yesterday", "coverage_issues", "coverage_issues_yesterday", "status", "timezone", "production_window", "window_start_utc", "window_end_utc", "as_of_utc", "loaded_at_utc", "generated_at_utc"],
    [
      ymd, locLabel,
      T.normal.orders, n(T.normal.items),
      Y.normal.orders, n(Y.normal.items),
      staffToday, staffYesterday,
      Number(perStaffToday.toFixed(1)), Number(perStaffYesterday.toFixed(1)),
      notes.map((x) => x.note).join(" | "),
      T.rework.orders, n(T.rework.items), Y.rework.orders, n(Y.rework.items),
      T.coverage.issues.length, Y.coverage.issues.length, statusLabel(meta), tz, windowLabel(meta),
      meta.range.startUtc, meta.range.endUtcExclusive, meta.asOfUtc, meta.loadedAtUtc, meta.generatedAtUtc,
    ],
  ]);

  // Sheet 2 - Departments (per work type; Orders here overlap across departments).
  const deptRows: Array<Array<string | number>> = [
    ["date", "location", "department", "orders", "items", "orders_yesterday", "items_yesterday", "delta_pct_orders", "delta_pct_items", "staff_on_shift", "boxes_used", "rework_orders", "rework_items"],
  ];
  for (const d of DEPARTMENTS) {
    const t = today.depts[d], y = yesterday.depts[d];
    deptRows.push([
      ymd, locLabel, DEPT_LABELS[d],
      t.summary.normal.orders, n(t.summary.normal.items),
      y.summary.normal.orders, n(y.summary.normal.items),
      pct(t.summary.normal.orders, y.summary.normal.orders),
      t.summary.normal.items !== null && y.summary.normal.items !== null ? pct(t.summary.normal.items, y.summary.normal.items) : "n/a",
      t.people.size, t.boxes,
      t.summary.rework.orders, n(t.summary.rework.items),
    ]);
  }
  const deptSheet = XLSX.utils.aoa_to_sheet(deptRows);

  // Sheet 3 - Staff (hours from clock rows, else first/last completion, within the production day).
  const staffRows: Array<Array<string | number>> = [
    ["date", "location", "department", "staff_name", "orders", "items", "hours_worked", "items_per_hour", "shift_start", "shift_end", "rework_orders", "rework_items"],
  ];
  for (const d of DEPARTMENTS) {
    const sorted = Array.from(today.depts[d].people.values()).sort(
      (a, b) => b.normal.orders - a.normal.orders || (b.normal.items ?? 0) - (a.normal.items ?? 0) || (a.staff_id < b.staff_id ? -1 : 1),
    );
    for (const s of sorted) {
      const name = staffNames.get(s.staff_id) ?? `User ${s.staff_id.slice(0, 8)}`;
      const startTs = s.clock_in_ts ?? s.first_ts;
      const endTs = s.clock_out_ts ?? s.last_ts;
      const hours = startTs != null && endTs != null ? Math.max(0, (endTs - startTs) / 3600000) : 0;
      const itemsPerHour = hours > 0 && s.normal.items !== null ? s.normal.items / hours : 0;
      staffRows.push([
        ymd, locLabel, DEPT_LABELS[d], name,
        s.normal.orders, n(s.normal.items),
        Number(hours.toFixed(2)),
        Number(itemsPerHour.toFixed(2)),
        localTime(startTs, tz),
        localTime(endTs, tz),
        s.rework.orders, n(s.rework.items),
      ]);
    }
  }
  const staffSheet = XLSX.utils.aoa_to_sheet(staffRows);

  // Sheet 4 - Notes
  const noteRows: Array<Array<string>> = [["date", "location", "severity", "department", "staff", "note"]];
  for (const x of notes) noteRows.push([ymd, locLabel, x.severity, x.department, x.staff, x.note]);
  const notesSheet = XLSX.utils.aoa_to_sheet(noteRows);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");
  XLSX.utils.book_append_sheet(wb, deptSheet, "Departments");
  XLSX.utils.book_append_sheet(wb, staffSheet, "Staff");
  XLSX.utils.book_append_sheet(wb, notesSheet, "Notes");

  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new Uint8Array(buf);
}

/* ============================================================
 * Email body (plaintext + simple HTML)
 * ============================================================ */
function buildBodyText(payload: { meta: ReportMeta; today: DayReport; yesterday: DayReport; staffNames: Map<string, string> }): { text: string; html: string } {
  const { meta, today, yesterday, staffNames } = payload;
  const { ymd, locLabel } = meta;
  const displayDate = new Date(ymd + "T00:00:00Z").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  const T = today.summary, Y = yesterday.summary;
  const ot = T.normal.orders, oy = Y.normal.orders;
  const it = T.normal.items, iy = Y.normal.items;
  const st = today.distinctStaff.size, sy = yesterday.distinctStaff.size;
  const perT = st > 0 && it !== null ? it / st : 0;
  const perY = sy > 0 && iy !== null ? iy / sy : 0;
  const itemsPct = it !== null && iy !== null ? pct(it, iy) : "n/a";

  const lines: string[] = [];
  lines.push(`Inka Arthouse — Daily KPI Report — ${locLabel} — ${displayDate}`);
  lines.push(`Production day: ${windowLabel(meta)}`);
  lines.push(`Status: ${statusLabel(meta)}`);
  lines.push(`Cutoff (as of): ${localStamp(meta.asOfUtc, meta.tz)} (${meta.asOfUtc}); later corrections appear on a re-run.`);
  lines.push("");
  lines.push(`Orders completed    ${String(ot).padStart(6)}   (${pct(ot, oy)} vs ${oy} yesterday; each order once across departments)`);
  lines.push(`Items processed     ${String(n(it)).padStart(6)}   (${itemsPct} vs ${n(iy)} yesterday; work across all departments)`);
  lines.push(`CS / rework         ${String(T.rework.orders).padStart(6)}   orders, ${n(T.rework.items)} items (counted separately)`);
  lines.push(`Staff on shift      ${String(st).padStart(6)}   (${st - sy >= 0 ? "+" : ""}${st - sy} vs yesterday)`);
  lines.push(`Items / staff-day   ${perT.toFixed(1).padStart(6)}   (${pct(Math.round(perT * 10), Math.round(perY * 10))} normalised)`);
  for (const [summary, when] of [[T, "today"], [Y, `yesterday (${yesterday.date})`]] as const) {
    const issues = (Object.entries(summary.coverage.issueCounts) as Array<[CoverageIssueKind, number]>).filter(([, c]) => c > 0);
    if (issues.length) lines.push(`Data warnings ${when}: ${issues.map(([k, c]) => `${c} ${ISSUE_LABELS[k]}`).join(", ")}; totals may be incomplete.`);
  }
  lines.push("");
  lines.push("Per department (Orders overlap across departments)");
  for (const d of DEPARTMENTS) {
    const t = today.depts[d].summary, y = yesterday.depts[d].summary;
    const active = (t.normal.items ?? 0) > 0 || t.normal.orders > 0 || (t.rework.items ?? 0) > 0 || t.rework.orders > 0;
    if (!active) {
      lines.push(`  ${DEPT_LABELS[d]}: no activity`);
    } else {
      const rework = t.rework.orders > 0 || (t.rework.items ?? 0) > 0 ? `; rework ${t.rework.orders}/${n(t.rework.items)}` : "";
      lines.push(`  ${DEPT_LABELS[d]}: ${t.normal.orders} orders / ${n(t.normal.items)} items   (^ from ${y.normal.orders}/${n(y.normal.items)})${rework}`);
    }
  }
  lines.push("");
  lines.push("Top performers per department (top 3)");
  for (const d of DEPARTMENTS) {
    lines.push(`  ${DEPT_LABELS[d]}:`);
    const staffArr = Array.from(today.depts[d].people.values())
      .map((s) => ({
        name: staffNames.get(s.staff_id) ?? `User ${s.staff_id.slice(0, 8)}`,
        orders: s.normal.orders,
        items: s.normal.items,
      }))
      .filter((s) => s.orders > 0 || (s.items ?? 0) > 0)
      .sort((a, b) => (b.orders - a.orders) || ((b.items ?? 0) - (a.items ?? 0)) || a.name.localeCompare(b.name));
    if (staffArr.length === 0) {
      lines.push(`    -- no activity --`);
      continue;
    }
    const top = staffArr.slice(0, 3);
    for (let i = 0; i < top.length; i++) {
      const p = top[i];
      lines.push(`    ${i + 1}. ${p.name.padEnd(12)}   ${p.orders} orders / ${n(p.items)} items`);
    }
  }
  lines.push("");
  lines.push(`See attached ${locLabel}-KPI-${ymd}.xlsx for full staff-level detail.`);
  lines.push(`Loaded ${localStamp(meta.loadedAtUtc, meta.tz)}; generated ${localStamp(meta.generatedAtUtc, meta.tz)}.`);
  lines.push("");
  lines.push("Sent from Inka Arthouse Hub | https://inka-arthouse-hub.vercel.app/reports");

  const text = lines.join("\n");
  // Rough HTML - Gmail renders <pre> nicely and keeps monospace alignment.
  const html = `<pre style="font-family: SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.5;">${lines.map((l) => l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")).join("\n")}</pre>`;
  return { text, html };
}

/* ============================================================
 * Request authorization
 * ============================================================ */

/**
 * True only when the server has a nonblank CRON_SECRET and the request
 * carries exactly one Authorization header whose whole value is
 * `Bearer <CRON_SECRET>`. The configured secret is never trimmed or
 * otherwise normalized for the comparison; trimming is only used to
 * detect a blank (unconfigured) secret.
 */
function isAuthorized(headers: VercelRequest["headers"], secret: string | undefined): boolean {
  if (typeof secret !== "string" || secret.trim() === "") return false;
  if (!headers || typeof headers !== "object") return false;
  const keys = Object.keys(headers).filter((k) => k.toLowerCase() === "authorization");
  if (keys.length !== 1) return false;
  const value = headers[keys[0]];
  if (typeof value !== "string") return false;
  const got = Buffer.from(value, "utf-8");
  const want = Buffer.from(`Bearer ${secret}`, "utf-8");
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

/* ============================================================
 * Recipient policy
 * ============================================================ */
const emailSchema = z.string().email();

/**
 * Trimmed, lowercased single email address, or null. Rejects lists
 * (commas/semicolons), display-name forms (<>, quotes, parens), any
 * embedded whitespace and control characters, then applies zod's email
 * check.
 */
function normalizeEmail(value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  if (/[\s\x00-\x1f\x7f,;<>"()]/.test(v)) return null;
  if (!emailSchema.safeParse(v).success) return null;
  return v.toLowerCase();
}

type RecipientError = { status: 400 | 403 | 500; message: string };

/**
 * Validates an explicit `recipient` override against
 * REPORT_RECIPIENT_ALLOWLIST (comma-separated individual addresses,
 * exact case-insensitive match). No override -> {}. Never falls back to
 * the default recipient on failure.
 */
function resolveRecipientOverride(
  raw: string | string[] | undefined,
  allowlist: string | undefined,
): { recipient?: string; error?: RecipientError } {
  if (raw === undefined) return {};
  if (typeof raw !== "string") return { error: { status: 400, message: "Invalid recipient" } };
  const recipient = normalizeEmail(raw);
  if (!recipient) return { error: { status: 400, message: "Invalid recipient" } };

  const entries = (allowlist ?? "").split(",").map((e) => e.trim()).filter((e) => e !== "");
  const allowed = new Set<string>();
  for (const entry of entries) {
    const n = normalizeEmail(entry);
    if (!n) return { error: { status: 500, message: "Recipient configuration error" } };
    allowed.add(n);
  }
  if (!allowed.has(recipient)) return { error: { status: 403, message: "Recipient not allowed" } };
  return { recipient };
}

/* ============================================================
 * Handler
 * ============================================================ */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Applies to every response below, including early returns and errors.
  res.setHeader("Cache-Control", "no-store");
  try {
    // Authenticate before looking at the method, query or anything else.
    if (!isAuthorized(req.headers, process.env.CRON_SECRET)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    // Validate any explicit override before diagnostics or report work.
    const override = resolveRecipientOverride(req.query.recipient, process.env.REPORT_RECIPIENT_ALLOWLIST);
    if (override.error) {
      res.status(override.error.status).json({ error: override.error.message });
      return;
    }

    // Diagnostic: report which env vars are visible to the function
    // without exposing values. Trigger with ?envcheck=1.
    if (req.query.rolecheck) {
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
      const url = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
      // Decode JWT payload (middle segment).
      let payload: unknown = null;
      let payloadErr: string | null = null;
      try {
        const parts = key.split(".");
        if (parts.length >= 2) {
          const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
          const pad = b64 + "=".repeat((4 - b64.length % 4) % 4);
          payload = JSON.parse(Buffer.from(pad, "base64").toString("utf-8"));
        }
      } catch (e) {
        payloadErr = e instanceof Error ? e.message : String(e);
      }
      // Raw fetch to Supabase REST bypassing supabase-js.
      let rawStatus: number | null = null;
      let rawBody: string | null = null;
      try {
        const r = await fetch(
          `${url}/rest/v1/production_events?select=id&limit=1`,
          {
            headers: {
              "apikey": key,
              "Authorization": `Bearer ${key}`,
            },
          },
        );
        rawStatus = r.status;
        rawBody = (await r.text()).slice(0, 200);
      } catch (e) {
        rawBody = `fetch threw: ${e instanceof Error ? e.message : String(e)}`;
      }
      res.status(200).json({
        jwt_payload: payload,
        jwt_payload_error: payloadErr,
        raw_fetch_status: rawStatus,
        raw_fetch_body: rawBody,
        url_prefix: url ? url.slice(0, 40) : "MISSING",
      });
      return;
    }
    if (req.query.envcheck) {
      const mask = (v: string | undefined) => v ? `${v.slice(0, 5)}... (len ${v.length})` : "MISSING";
      res.status(200).json({
        RESEND_API_KEY: mask(process.env.RESEND_API_KEY),
        REPORT_RECIPIENT: process.env.REPORT_RECIPIENT ?? "MISSING",
        FROM_EMAIL: process.env.FROM_EMAIL ?? "(default)",
        VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL ? "PRESENT" : "MISSING",
        SUPABASE_URL: process.env.SUPABASE_URL ? "PRESENT" : "MISSING",
        SUPABASE_SERVICE_ROLE_KEY: mask(process.env.SUPABASE_SERVICE_ROLE_KEY),
        VITE_SUPABASE_ANON_KEY: mask(process.env.VITE_SUPABASE_ANON_KEY),
        note: "Key used for Supabase client: SUPABASE_SERVICE_ROLE_KEY (if present) else VITE_SUPABASE_ANON_KEY.",
      });
      return;
    }
    const locRaw = req.query.location;
    const location = (Array.isArray(locRaw) ? locRaw[0] : locRaw) ?? "au";
    if (!LOCATION_TZ[location]) {
      res.status(400).json({ error: `Unknown location "${location}"` });
      return;
    }
    const site = location as ReportSite;
    const tz = LOCATION_TZ[location];
    const locLabel = LOCATION_LABELS[location];

    // Target day: a validated production date, or the site's current
    // production date. Production days start at 04:00 local, so a
    // scheduled ~23:55 run that Vercel delays past midnight (up to 03:59)
    // still closes the right day. Invalid or repeated dates are rejected
    // before any report read.
    const dateOverride = req.query.date;
    let ymd: string;
    if (dateOverride === undefined) {
      ymd = productionDateAt(new Date(), site);
    } else if (typeof dateOverride === "string" && isProductionDate(dateOverride)) {
      ymd = dateOverride;
    } else {
      res.status(400).json({ error: "Invalid date" });
      return;
    }
    const yYmd = shiftProductionDate(ymd, -1);

    // Full-site counts need the server credential. The anon key would return
    // only what RLS lets an anonymous caller see (nothing), which must never
    // be reported as a complete site.
    const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl) {
      res.status(500).json({ error: "Supabase env vars missing" });
      return;
    }
    if (!supabaseKey) {
      res.status(500).json({ error: "Full-site report needs SUPABASE_SERVICE_ROLE_KEY" });
      return;
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    // One cutoff for every read in this report.
    const asOfUtc = new Date().toISOString();
    const todayRange = productionRange(site, ymd, ymd);
    const bothDays = productionRange(site, yYmd, ymd);
    const snapshot = await loadProductionEvidence(supabase, {
      site,
      range: { startUtc: bothDays.startUtc, endUtcExclusive: bothDays.endUtcExclusive },
      asOfUtc,
      visibility: { kind: "site" },
      deadlineMs: Date.now() + EVIDENCE_DEADLINE_MS,
    });
    const evidence = prepareProductionEvidence(snapshot);

    // Clock rows drive hours only (not counts); same window and cutoff, paged.
    const clocks = await readAll<ClockRow>(
      () =>
        supabase
          .from("production_events")
          .select("id, staff_id, department, event_type, created_at", { count: "exact" })
          .eq("location", location)
          .in("event_type", ["clock_in", "clock_out"])
          .gte("created_at", bothDays.startUtc)
          .lt("created_at", bothDays.endUtcExclusive)
          .lte("created_at", asOfUtc)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true }) as unknown as PageQuery,
      "production_events (clock)",
    );

    const today = projectDay(evidence, site, ymd, clocks);
    const yesterday = projectDay(evidence, site, yYmd, clocks);
    await addBoxes(supabase, location, [today, yesterday], asOfUtc);

    // Staff names for anyone who appeared. A failed lookup fails the report;
    // a person with no name row falls back to their saved id.
    const allStaffIds = Array.from(new Set<string>([...today.distinctStaff, ...yesterday.distinctStaff])).sort();
    const staffNames = new Map<string, string>();
    if (allStaffIds.length > 0) {
      const staffRows = await readAll<StaffRow>(
        () =>
          supabase
            .from("staff_barcodes")
            .select("user_id, display_name, barcode", { count: "exact" })
            .eq("location", location)
            .in("user_id", allStaffIds)
            .order("user_id", { ascending: true })
            .order("barcode", { ascending: true }) as unknown as PageQuery,
        "staff_barcodes",
      );
      for (const r of staffRows) if (!staffNames.has(r.user_id)) staffNames.set(r.user_id, r.display_name);
    }

    const meta: ReportMeta = {
      ymd,
      locLabel,
      tz,
      range: todayRange,
      asOfUtc,
      loadedAtUtc: snapshot.loadedAtUtc,
      generatedAtUtc: new Date().toISOString(),
      closed: Date.parse(asOfUtc) >= Date.parse(todayRange.endUtcExclusive),
    };

    // Skip sending only when there is truly nothing to report: no normal
    // or rework Items/Orders and no data warnings. Cron/preview/manual runs
    // pass ?force=1 to override.
    const T = today.summary;
    const noActivity =
      T.normal.orders === 0 && (T.normal.items ?? 0) === 0 &&
      T.rework.orders === 0 && (T.rework.items ?? 0) === 0 &&
      T.coverage.issues.length === 0;
    const forceSend = req.query.force === "1" || req.query.force === "true";
    if (noActivity && !forceSend && !req.query.dry) {
      res.status(200).json({
        ok: true,
        skipped: "no activity",
        location,
        ymd,
        note: "Zero orders and zero items across all departments; email suppressed. Pass ?force=1 to send anyway.",
      });
      return;
    }

    const xlsxBytes = buildXlsx({ meta, today, yesterday, staffNames });
    const filename = `${locLabel}-KPI-${ymd}.xlsx`;

    const dry = req.query.dry;
    if (dry) {
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.status(200).send(Buffer.from(xlsxBytes));
      return;
    }

    // Destination: a validated override, else the configured default.
    // There is no hardcoded fallback address.
    let recipient = override.recipient;
    if (!recipient) {
      const configured = (process.env.REPORT_RECIPIENT ?? "").trim();
      if (!normalizeEmail(configured)) {
        res.status(500).json({ error: "Recipient configuration error" });
        return;
      }
      recipient = configured;
    }

    const bodies = buildBodyText({ meta, today, yesterday, staffNames });
    const subject = `${locLabel}-${formatDDMMYY(ymd)}-Daily KPI Report`;
    const from = process.env.FROM_EMAIL || "onboarding@resend.dev";
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) {
      res.status(500).json({ error: "RESEND_API_KEY not configured" });
      return;
    }

    const b64 = Buffer.from(xlsxBytes).toString("base64");
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [recipient],
        subject,
        text: bodies.text,
        html: bodies.html,
        attachments: [{ filename, content: b64 }],
      }),
    });
    if (!resendRes.ok) {
      const detail = await resendRes.text();
      res.status(502).json({ error: `Resend send failed`, status: resendRes.status, detail: detail.slice(0, 400) });
      return;
    }

    res.status(200).json({
      ok: true,
      subject,
      recipient,
      ymd,
      location,
      as_of_utc: asOfUtc,
      counts: {
        orders_today: T.normal.orders,
        items_today: T.normal.items,
        staff_today: today.distinctStaff.size,
        rework_orders_today: T.rework.orders,
        rework_items_today: T.rework.items,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
