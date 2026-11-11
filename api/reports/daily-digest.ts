/**
 * Daily KPI digest for one location.
 *
 * GET /api/reports/daily-digest?location=au|us|uk
 *   Optional: &date=YYYY-MM-DD (target day, local TZ)
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
 * Sends via Resend using RESEND_API_KEY from env.
 */
import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import { z } from "zod";

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

interface EventRow {
  id: string;
  staff_id: string;
  department: string;
  order_number: string;
  line_sku: string | null;
  line_quantity: number | null;
  event_type: string;
  parent_event_id: string | null;
  created_at: string;
}
interface StaffRow { user_id: string; display_name: string; }

/* ============================================================
 * SKU helpers - trimmed copy of the client kpi rules so we can
 * run them on the server without importing browser code.
 * ============================================================ */
const RE_SET = /^INKA-S(\d)([A-Z]{2,3})(\d{4})-([A-Z0-9]+)-([A-Z]{2})$/;
const RE_SINGLE = /^INKA-([A-Z]{2,3})(\d{4})-([A-Z0-9]+)-([A-Z]{2})$/;
const RE_PF = /^INKA-PF(\d{4})-([A-Z0-9]+)-([A-Z]{2})$/;
const RE_AUX_FP_NEW = /^INKA-AUX([A-Z]{2,4})$/;
const RE_AUX_FP_LEGACY = /^INKA-AUX-FP-([A-Z]{2,3})-([A-Z0-9]+)$/;
const RE_AUX_OTHER = /^INKA-AUX-([A-Z0-9]+)$/;
const RE_GC = /^INKA-GC(\d{4})-(\d+)$/;

interface ParsedSku {
  type: "single_print" | "set_print" | "picture_frame" | "gift_card" | "aux_free_print" | "aux_other";
  variant?: string;
  setCount?: number;
}

function parseSku(rawSku: string | null | undefined): ParsedSku | null {
  if (!rawSku) return null;
  const sku = rawSku.trim().toUpperCase();
  if (!sku.startsWith("INKA-")) return null;
  let m: RegExpExecArray | null;
  m = RE_AUX_FP_NEW.exec(sku);   if (m) return { type: "aux_free_print" };
  m = RE_AUX_FP_LEGACY.exec(sku); if (m) return { type: "aux_free_print" };
  if (sku.startsWith("INKA-AUX-")) {
    m = RE_AUX_OTHER.exec(sku);
    if (m) return { type: "aux_other" };
  }
  m = RE_GC.exec(sku);     if (m) return { type: "gift_card" };
  m = RE_PF.exec(sku);     if (m) return { type: "picture_frame", variant: m[3] };
  m = RE_SET.exec(sku);    if (m) return { type: "set_print", variant: m[5], setCount: Number(m[1]) };
  m = RE_SINGLE.exec(sku); if (m) return { type: "single_print", variant: m[4] };
  return null;
}

function isKpiEligibleSku(sku: string | null | undefined): boolean {
  if (!sku) return false;
  const p = parseSku(sku);
  if (!p) return false;
  if (p.type === "gift_card" || p.type === "aux_other" || p.type === "aux_free_print") return false;
  if (p.type === "picture_frame") return true;
  return p.variant === "FN" || p.variant === "FB" || p.variant === "FW";
}

function kpiUnitMultiplier(sku: string | null | undefined): number {
  if (!sku) return 1;
  const p = parseSku(sku);
  if (p && p.type === "set_print" && typeof p.setCount === "number" && p.setCount > 0) return p.setCount;
  return 1;
}

/* ============================================================
 * Date + timezone helpers
 * ============================================================ */

/**
 * Given a Date and a timezone, return the local YYYY-MM-DD.
 */
function ymdInTz(d: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d); // en-CA gives YYYY-MM-DD
}

/**
 * Given YYYY-MM-DD (local) and tz, return the UTC ISO range
 * [startUtc, endUtc) for that local day.
 */
function localDayRangeUtc(ymd: string, tz: string): { start: string; end: string } {
  // Build a Date at 00:00 local by parsing "YYYY-MM-DDT00:00:00" as tz.
  // Trick: use Intl to compute offset and construct via UTC.
  const [y, m, d] = ymd.split("-").map(Number);
  // We need midnight local in UTC. Approach: assume UTC, then shift.
  // Use a reference Date at UTC midnight of ymd, then determine tz offset.
  const utcMidnight = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const localWall = ymdInTz(utcMidnight, tz);
  // If localWall != ymd, offset is non-zero. Compute delta and shift.
  const localWallDate = new Date(Date.UTC(
    Number(localWall.slice(0, 4)),
    Number(localWall.slice(5, 7)) - 1,
    Number(localWall.slice(8, 10)),
    0, 0, 0,
  ));
  const deltaMs = utcMidnight.getTime() - localWallDate.getTime();
  const startUtc = new Date(utcMidnight.getTime() + deltaMs);
  const endUtc = new Date(startUtc.getTime() + 24 * 3600 * 1000);
  return { start: startUtc.toISOString(), end: endUtc.toISOString() };
}

function ymdShift(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function formatDDMMYY(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return `${d}/${m}/${y.slice(2)}`;
}

function pct(now: number, prev: number): string {
  if (prev === 0) return now === 0 ? "0%" : "n/a";
  return ((now - prev) / prev * 100).toFixed(0) + "%";
}

/* ============================================================
 * Aggregation
 * ============================================================ */
interface DeptTotals {
  orders: Set<string>;
  items: number;
  boxes: number;
  staff: Map<string, StaffTotals>;
}
interface StaffTotals {
  staff_id: string;
  orders: Set<string>;
  items: number;
  first_ts: number | null;
  last_ts: number | null;
  clock_in_ts: number | null;
  clock_out_ts: number | null;
}

function newDeptTotals(): DeptTotals {
  return { orders: new Set(), items: 0, boxes: 0, staff: new Map() };
}

function ensureStaff(dept: DeptTotals, staff_id: string): StaffTotals {
  let s = dept.staff.get(staff_id);
  if (!s) {
    s = { staff_id, orders: new Set(), items: 0, first_ts: null, last_ts: null, clock_in_ts: null, clock_out_ts: null };
    dept.staff.set(staff_id, s);
  }
  return s;
}

async function aggregateDay(
  supabase: SupabaseClient,
  location: string,
  ymd: string,
  tz: string,
): Promise<{ depts: Record<Department, DeptTotals>; distinctStaff: Set<string> }> {
  const { start, end } = localDayRangeUtc(ymd, tz);
  const depts: Record<Department, DeptTotals> = {
    a0_framed: newDeptTotals(),
    framed:    newDeptTotals(),
    unframed:  newDeptTotals(),
    dispatch:  newDeptTotals(),
  };
  const distinctStaff = new Set<string>();

  // production_events for the window.
  const { data: eventRows, error: evErr } = await supabase
    .from("production_events")
    .select("id, staff_id, department, order_number, line_sku, line_quantity, event_type, parent_event_id, created_at")
    .eq("location", location)
    .gte("created_at", start)
    .lt("created_at", end);
  if (evErr) throw new Error(`production_events: ${evErr.message}`);

  const events = (eventRows ?? []) as EventRow[];

  // Cancelled parents to skip.
  const cancelledIds = new Set<string>();
  for (const ev of events) {
    if (ev.event_type === "cancelled" && ev.parent_event_id) cancelledIds.add(ev.parent_event_id);
  }

  for (const ev of events) {
    if (!(DEPARTMENTS as readonly string[]).includes(ev.department)) continue;
    const dept = depts[ev.department as Department];
    const ts = new Date(ev.created_at).getTime();

    if (ev.event_type === "clock_in" || ev.event_type === "clock_out") {
      distinctStaff.add(ev.staff_id);
      const s = ensureStaff(dept, ev.staff_id);
      if (ev.event_type === "clock_in") s.clock_in_ts = s.clock_in_ts == null ? ts : Math.min(s.clock_in_ts, ts);
      else                              s.clock_out_ts = s.clock_out_ts == null ? ts : Math.max(s.clock_out_ts, ts);
      continue;
    }

    // Orders (completions per dept)
    if (ev.event_type === "completed" || ev.event_type === "dispatched") {
      dept.orders.add(ev.order_number);
      const s = ensureStaff(dept, ev.staff_id);
      s.orders.add(ev.order_number);
      distinctStaff.add(ev.staff_id);
      if (s.first_ts == null || ts < s.first_ts) s.first_ts = ts;
      if (s.last_ts == null || ts > s.last_ts) s.last_ts = ts;
    }

    // Items (line_verified with KPI eligibility)
    if (ev.event_type === "line_verified" && !cancelledIds.has(ev.id)) {
      if (!isKpiEligibleSku(ev.line_sku)) continue;
      const mult = kpiUnitMultiplier(ev.line_sku);
      const qty = (ev.line_quantity ?? 1) * mult;
      dept.items += qty;
      const s = ensureStaff(dept, ev.staff_id);
      s.items += qty;
      distinctStaff.add(ev.staff_id);
    }
  }

  // Boxes used from ledger, routed to the correct dept slot based on
  // known package product codes / mail tube IDs.
  //   A0-Double, A0-Single           -> a0_framed
  //   A1-Single, A1-Double-Wide,
  //   NZ, A2-Double, A3-A4           -> dispatch
  //   Mail tubes (both sizes)        -> unframed
  const A0_CODES = new Set<string>(["A0-Double", "A0-Single"]);
  const DISPATCH_CODES = new Set<string>(["A1-Single", "A1-Double-Wide", "NZ", "A2-Double", "A3-A4"]);
  const TUBE_IDS = new Set<string>(["sku-xniriygn", "sku-2jiumpm4"]);
  const packageProductIdsAndCodes = await supabase
    .from("products")
    .select("id, code")
    .eq("location", location)
    .in("code", Array.from(new Set([...A0_CODES, ...DISPATCH_CODES])));
  const codeById = new Map<string, string>();
  for (const p of (packageProductIdsAndCodes.data ?? []) as Array<{ id: string; code: string }>) {
    codeById.set(p.id, p.code);
  }
  const allPackageIds = new Set<string>([...codeById.keys(), ...TUBE_IDS]);

  const { data: ledgerRows } = await supabase
    .from("ledger")
    .select("product_id, delta")
    .eq("location", location)
    .in("product_id", Array.from(allPackageIds))
    .lt("delta", 0)
    .gte("ts", start)
    .lt("ts", end);

  for (const r of (ledgerRows ?? []) as Array<{ product_id: string; delta: number }>) {
    const qty = Math.abs(r.delta);
    if (TUBE_IDS.has(r.product_id)) {
      depts.unframed.boxes += qty;
    } else {
      const code = codeById.get(r.product_id);
      if (!code) continue; // unrelated ledger movement, skip
      if (A0_CODES.has(code)) depts.a0_framed.boxes += qty;
      else if (DISPATCH_CODES.has(code)) depts.dispatch.boxes += qty;
      // Any other code is not a package - drop it (shouldn't happen given the .in() filter).
    }
  }

  return { depts, distinctStaff };
}

/* ============================================================
 * xlsx build
 * ============================================================ */
function buildXlsx(payload: {
  ymd: string;
  location: string;
  locLabel: string;
  today: { depts: Record<Department, DeptTotals>; distinctStaff: Set<string> };
  yesterday: { depts: Record<Department, DeptTotals>; distinctStaff: Set<string> };
  staffNames: Map<string, string>;
}): Uint8Array {
  const { ymd, locLabel, today, yesterday, staffNames } = payload;
  const yYmd = ymdShift(ymd, -1);

  // Totals across depts
  const totOrders = (t: typeof today) =>
    DEPARTMENTS.reduce((s, d) => s + t.depts[d].orders.size, 0);
  const totItems = (t: typeof today) =>
    DEPARTMENTS.reduce((s, d) => s + t.depts[d].items, 0);
  const ordersToday = totOrders(today);
  const ordersYesterday = totOrders(yesterday);
  const itemsToday = totItems(today);
  const itemsYesterday = totItems(yesterday);
  const staffToday = today.distinctStaff.size;
  const staffYesterday = yesterday.distinctStaff.size;
  const perStaffToday = staffToday > 0 ? itemsToday / staffToday : 0;
  const perStaffYesterday = staffYesterday > 0 ? itemsYesterday / staffYesterday : 0;

  const notes: Array<{ severity: string; department: string; staff: string; note: string }> = [];
  for (const d of DEPARTMENTS) {
    if (today.depts[d].orders.size === 0 && today.depts[d].items === 0) {
      notes.push({ severity: "info", department: DEPT_LABELS[d], staff: "-", note: "Zero activity â€” rostering gap?" });
    }
  }

  // Sheet 1 - Summary
  const summarySheet = XLSX.utils.aoa_to_sheet([
    ["date", "location", "orders_total", "items_total", "orders_yesterday", "items_yesterday", "staff_on_shift", "staff_yesterday", "items_per_staff", "items_per_staff_yesterday", "notes"],
    [
      ymd, locLabel,
      ordersToday, itemsToday,
      ordersYesterday, itemsYesterday,
      staffToday, staffYesterday,
      Number(perStaffToday.toFixed(1)), Number(perStaffYesterday.toFixed(1)),
      notes.map((n) => n.note).join(" | "),
    ],
  ]);

  // Sheet 2 - Departments
  const deptRows: Array<Array<string | number>> = [
    ["date", "location", "department", "orders", "items", "orders_yesterday", "items_yesterday", "delta_pct_orders", "delta_pct_items", "staff_on_shift", "boxes_used"],
  ];
  for (const d of DEPARTMENTS) {
    const t = today.depts[d];
    const y = yesterday.depts[d];
    deptRows.push([
      ymd, locLabel, DEPT_LABELS[d],
      t.orders.size, t.items,
      y.orders.size, y.items,
      pct(t.orders.size, y.orders.size),
      pct(t.items, y.items),
      t.staff.size, t.boxes,
    ]);
  }
  const deptSheet = XLSX.utils.aoa_to_sheet(deptRows);

  // Sheet 3 - Staff
  const staffRows: Array<Array<string | number>> = [
    ["date", "location", "department", "staff_name", "orders", "items", "hours_worked", "items_per_hour", "shift_start", "shift_end"],
  ];
  for (const d of DEPARTMENTS) {
    const t = today.depts[d];
    const sortedStaff = Array.from(t.staff.values()).sort((a, b) => b.orders.size - a.orders.size);
    for (const s of sortedStaff) {
      const name = staffNames.get(s.staff_id) ?? `User ${s.staff_id.slice(0, 8)}`;
      const startTs = s.clock_in_ts ?? s.first_ts;
      const endTs   = s.clock_out_ts ?? s.last_ts;
      const hours = startTs != null && endTs != null ? Math.max(0, (endTs - startTs) / 3600000) : 0;
      const itemsPerHour = hours > 0 ? s.items / hours : 0;
      const fmt = (ts: number | null) => ts == null ? "" : new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      staffRows.push([
        ymd, locLabel, DEPT_LABELS[d], name,
        s.orders.size, s.items,
        Number(hours.toFixed(2)),
        Number(itemsPerHour.toFixed(2)),
        fmt(startTs),
        fmt(endTs),
      ]);
    }
  }
  const staffSheet = XLSX.utils.aoa_to_sheet(staffRows);

  // Sheet 4 - Notes
  const noteRows: Array<Array<string>> = [["date", "location", "severity", "department", "staff", "note"]];
  for (const n of notes) noteRows.push([ymd, locLabel, n.severity, n.department, n.staff, n.note]);
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
function buildBodyText(payload: {
  ymd: string;
  locLabel: string;
  today: { depts: Record<Department, DeptTotals>; distinctStaff: Set<string> };
  yesterday: { depts: Record<Department, DeptTotals>; distinctStaff: Set<string> };
  staffNames: Map<string, string>;
}): { text: string; html: string } {
  const { ymd, locLabel, today, yesterday, staffNames } = payload;
  const displayDate = new Date(ymd + "T00:00:00Z").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const totOrders = (t: typeof today) => DEPARTMENTS.reduce((s, d) => s + t.depts[d].orders.size, 0);
  const totItems = (t: typeof today) => DEPARTMENTS.reduce((s, d) => s + t.depts[d].items, 0);
  const ot = totOrders(today), oy = totOrders(yesterday);
  const it = totItems(today), iy = totItems(yesterday);
  const st = today.distinctStaff.size, sy = yesterday.distinctStaff.size;
  const perT = st > 0 ? it / st : 0;
  const perY = sy > 0 ? iy / sy : 0;

  const lines: string[] = [];
  lines.push(`Inka Arthouse â€” Daily KPI Report â€” ${locLabel} â€” ${displayDate}`);
  lines.push("");
  lines.push(`Orders dispatched   ${String(ot).padStart(6)}   (${pct(ot, oy)} vs ${oy} yesterday)`);
  lines.push(`Items verified      ${String(it).padStart(6)}   (${pct(it, iy)} vs ${iy} yesterday)`);
  lines.push(`Staff on shift      ${String(st).padStart(6)}   (${st - sy >= 0 ? "+" : ""}${st - sy} vs yesterday)`);
  lines.push(`Items / staff-day   ${perT.toFixed(1).padStart(6)}   (${pct(Math.round(perT * 10), Math.round(perY * 10))} normalised)`);
  lines.push("");
  lines.push("Per department");
  for (const d of DEPARTMENTS) {
    const t = today.depts[d], y = yesterday.depts[d];
    if (t.orders.size === 0 && t.items === 0) {
      lines.push(`  ${DEPT_LABELS[d]}: no activity`);
    } else {
      lines.push(`  ${DEPT_LABELS[d]}: ${t.orders.size} orders / ${t.items} items   (^ from ${y.orders.size}/${y.items})`);
    }
  }
  lines.push("");
  lines.push("Top performers per department (top 3)");
  for (const d of DEPARTMENTS) {
    lines.push(`  ${DEPT_LABELS[d]}:`);
    const staffArr = Array.from(today.depts[d].staff.values())
      .map((s) => ({
        name: staffNames.get(s.staff_id) ?? `User ${s.staff_id.slice(0, 8)}`,
        orders: s.orders.size,
        items: s.items,
      }))
      .filter((s) => s.orders > 0 || s.items > 0)
      .sort((a, b) => (b.orders - a.orders) || (b.items - a.items));
    if (staffArr.length === 0) {
      lines.push(`    -- no activity --`);
      continue;
    }
    const top = staffArr.slice(0, 3);
    for (let i = 0; i < top.length; i++) {
      const p = top[i];
      lines.push(`    ${i + 1}. ${p.name.padEnd(12)}   ${p.orders} orders / ${p.items} items`);
    }
  }
  lines.push("");
  lines.push(`See attached ${locLabel}-KPI-${ymd}.xlsx for full staff-level detail.`);
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
    const tz = LOCATION_TZ[location];
    const locLabel = LOCATION_LABELS[location];

    // Target day: the local day we are closing out. Vercel cron can
    // jitter by up to an hour, so a scheduled 22:55 local run may
    // actually fire at 00:30 local the following day. Rule: if the
    // local hour is < 4, treat as previous day. Any fire between 20:00
    // and 03:59 local reports the correct closed day.
    const dateOverride = req.query.date;
    let ymd: string;
    if (typeof dateOverride === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateOverride)) {
      ymd = dateOverride;
    } else {
      const now = new Date();
      const localYmd = ymdInTz(now, tz);
      const localHourStr = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour: "numeric", hour12: false,
      }).format(now);
      const localHour = Number(localHourStr);
      ymd = localHour < 4 ? ymdShift(localYmd, -1) : localYmd;
    }
    const yYmd = ymdShift(ymd, -1);

    // Supabase client using service-role or anon+RLS. For read-only cron
    // access, VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY is cleanest.
    const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) {
      res.status(500).json({ error: "Supabase env vars missing" });
      return;
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    const [today, yesterday] = await Promise.all([
      aggregateDay(supabase, location, ymd, tz),
      aggregateDay(supabase, location, yYmd, tz),
    ]);

    // Resolve staff names for anyone who appeared.
    const allStaffIds = new Set<string>([...today.distinctStaff, ...yesterday.distinctStaff]);
    const staffNames = new Map<string, string>();
    if (allStaffIds.size > 0) {
      const { data: staffRows } = await supabase
        .from("staff_barcodes")
        .select("user_id, display_name")
        .eq("location", location)
        .in("user_id", Array.from(allStaffIds));
      for (const r of (staffRows ?? []) as StaffRow[]) staffNames.set(r.user_id, r.display_name);
    }

    // Skip sending if the location had zero activity across every
    // department. Cron/preview/manual runs pass ?force=1 to override.
    const totalOrdersToday = DEPARTMENTS.reduce((s, d) => s + today.depts[d].orders.size, 0);
    const totalItemsToday = DEPARTMENTS.reduce((s, d) => s + today.depts[d].items, 0);
    const noActivity = totalOrdersToday === 0 && totalItemsToday === 0;
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

    const xlsxBytes = buildXlsx({ ymd, location, locLabel, today, yesterday, staffNames });
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

    const bodies = buildBodyText({ ymd, locLabel, today, yesterday, staffNames });
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
      counts: {
        orders_today: DEPARTMENTS.reduce((s, d) => s + today.depts[d].orders.size, 0),
        items_today: DEPARTMENTS.reduce((s, d) => s + today.depts[d].items, 0),
        staff_today: today.distinctStaff.size,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}