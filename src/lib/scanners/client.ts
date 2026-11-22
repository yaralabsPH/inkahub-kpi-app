/**
 * F6 shared scanner stations: server calls and the delivery pipeline.
 *
 * Production is Supabase-only, so this talks to the RPCs from migration 0055
 * directly (not through Repository.ts). Every function takes its client or
 * transport so it is tested with fakes.
 *
 * Outcomes are typed: a Rejected answer is definite (the transaction rolled
 * back, nothing was saved); a NetworkError means "no definite answer" and the
 * same request is retried with the same id and payload.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { prepareFramingOrder, type CatalogueProduct, type OrderLookup, type PackagingSetup, type PreparedFraming } from "./order";
import { jobMode, LeaseLostError, type JobScope, type ScannerJob, type ScannerOutbox } from "./outbox";
import {
  isPreparedDispatch,
  prepareDispatchOrder,
  unresolvedSkus,
  withEvidence,
  type DispatchFramedLine,
  type DispatchPrepareResult,
  type FramerEvidence,
  type PreparedDispatch,
} from "./dispatch";
import { parseRuleSetBody } from "@/lib/domain/packaging/ruleSet";

export interface Rejected {
  outcome: "rejected";
  code: string;
  message: string;
}
export interface NetworkError {
  outcome: "network_error";
  message: string;
  /** The account's session has expired; retry after signing in again. */
  auth?: boolean;
}

const REJECTION_TEXT: Record<string, string> = {
  not_authenticated: "Signed out. Sign this station in again.",
  forbidden_location: "This account has no access to this site.",
  forbidden_role: "Only an owner, manager or kiosk account can run shared scanners.",
  invalid_input: "The scan data was not valid.",
  request_conflict: "This request id was already used for different data.",
  badge_inactive: "That badge is no longer active at this site.",
  person_not_at_site: "That person is not a member of this site.",
  open_case: "The order has an open replacement case. Use the classic station.",
  packaging_not_auto: "This site is not in automatic box mode. Use the classic station.",
  packaging_invalid: "The A0 packaging could not be recorded. Use the classic station.",
  packaging_unposted: "The A0 packaging could not be taken from stock. Nothing was saved. Use the classic station.",
  packaging_required: "Framed prints need their Dispatch box in the save. Nothing was saved. Use the classic dispatch station.",
  missing_stock_code: "A stock code is missing at this site. Nothing was saved. Use the classic station.",
  stock_floor: "Stock would go below zero and the database refused it. Nothing was saved.",
  unavailable: "Shared scanners are not set up on this database yet.",
  framer_missing: "A framed line has no framing record and nobody was chosen. Choose who framed it.",
  framer_inactive: "The person chosen as framer is no longer active at this site. Choose again.",
  evidence_overflow: "This order has too many framing records to check safely. Use the classic dispatch station.",
};

const TRANSIENT_SQLSTATE = /^(08|40|53|57)/;

export function classifyRpcError(error: { message?: string; code?: string; status?: number }): Rejected | NetworkError {
  const message = error.message ?? "";
  const code = error.code ?? "";
  const m = /scanner: ([a-z_]+)/.exec(message);
  // A request sent under a different account than the one that scanned it:
  // nothing ran. Keep the job for its own account; never block or drop it.
  if (m && m[1] === "caller_mismatch") {
    return { outcome: "network_error", message: "Signed in as a different account than the one that scanned this. Kept for that account.", auth: true };
  }
  if (m) return { outcome: "rejected", code: m[1], message: REJECTION_TEXT[m[1]] ?? message };
  const pkg = /packaging: ([a-z_]+)/.exec(message);
  if (pkg) return { outcome: "rejected", code: "packaging_invalid", message: `${REJECTION_TEXT.packaging_invalid} (${pkg[1]})` };
  if (code === "23514") return { outcome: "rejected", code: "stock_floor", message: REJECTION_TEXT.stock_floor };
  if (code === "PGRST202" || code === "PGRST205" || code === "42883" || code === "42P01") {
    return { outcome: "rejected", code: "unavailable", message: REJECTION_TEXT.unavailable };
  }
  if (code.startsWith("PGRST3") || error.status === 401) {
    return { outcome: "network_error", message: "Session expired. Sign in again; queued scans are kept.", auth: true };
  }
  if (code === "" || TRANSIENT_SQLSTATE.test(code)) return { outcome: "network_error", message: message || "No answer from the server." };
  return { outcome: "rejected", code: "server_error", message: message || "The server refused the request." };
}

async function rpc(client: SupabaseClient, fn: string, params: Record<string, unknown>): Promise<{ data: unknown } | Rejected | NetworkError> {
  try {
    const { data, error } = await client.rpc(fn, params);
    if (error) return classifyRpcError(error);
    return { data };
  } catch (e) {
    return { outcome: "network_error", message: e instanceof Error ? e.message : String(e) };
  }
}

function malformed(what: string): Rejected {
  return { outcome: "rejected", code: "malformed_response", message: `Unexpected answer from the server (${what}).` };
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Badge activation
// ---------------------------------------------------------------------------

export type ActivateOutcome =
  | {
      outcome: "activated"; personId: string; displayName: string; clockedIn: boolean;
      /** F7 dispatch activation: UTC ms of the next site 04:00 workday start. */
      workdayEndsAt?: number | null;
    }
  | { outcome: "unknown_badge" }
  | { outcome: "unusable_badge" }
  | Rejected
  | NetworkError;

const ActivateSchema = z.union([
  z.object({ status: z.literal("activated"), person_id: z.string().uuid(), display_name: z.string(), clocked_in: z.boolean() }),
  z.object({ status: z.literal("unknown_badge") }),
  z.object({ status: z.literal("unusable_badge") }),
]);

export async function activateBadge(
  client: SupabaseClient,
  a: { location: string; requestId: string; receiverId: string; scannerId: string; badge: string; expectedCaller: string },
): Promise<ActivateOutcome> {
  const res = await rpc(client, "scanner_activate_badge", {
    p_location: a.location,
    p_request_id: a.requestId,
    p_receiver_id: a.receiverId,
    p_scanner_id: a.scannerId,
    p_badge: a.badge,
    p_expected_caller: a.expectedCaller,
  });
  if ("outcome" in res) return res;
  const parsed = ActivateSchema.safeParse(res.data);
  if (!parsed.success) return malformed("activation");
  const d = parsed.data;
  if (d.status === "unknown_badge") return { outcome: "unknown_badge" };
  if (d.status === "unusable_badge") return { outcome: "unusable_badge" };
  return { outcome: "activated", personId: d.person_id, displayName: d.display_name, clockedIn: d.clocked_in };
}

const DispatchActivateSchema = z.union([
  z.object({
    status: z.literal("activated"), person_id: z.string().uuid(), display_name: z.string(), clocked_in: z.boolean(),
    workday_ends_at: z.string(),
  }),
  z.object({ status: z.literal("unknown_badge") }),
  z.object({ status: z.literal("unusable_badge") }),
]);

/**
 * F7: the dispatch badge sign-in. Same rules as F6 activation, but a new
 * clock-in is recorded as dispatch work, and the answer carries the end of
 * the site workday (the shift identity's latest end).
 */
export async function activateDispatchBadge(
  client: SupabaseClient,
  a: { location: string; requestId: string; receiverId: string; scannerId: string; badge: string; expectedCaller: string },
): Promise<ActivateOutcome> {
  const res = await rpc(client, "scanner_activate_dispatch", {
    p_location: a.location,
    p_request_id: a.requestId,
    p_receiver_id: a.receiverId,
    p_scanner_id: a.scannerId,
    p_badge: a.badge,
    p_expected_caller: a.expectedCaller,
  });
  if ("outcome" in res) return res;
  const parsed = DispatchActivateSchema.safeParse(res.data);
  if (!parsed.success) return malformed("activation");
  const d = parsed.data;
  if (d.status === "unknown_badge") return { outcome: "unknown_badge" };
  if (d.status === "unusable_badge") return { outcome: "unusable_badge" };
  const end = Date.parse(d.workday_ends_at);
  return {
    outcome: "activated", personId: d.person_id, displayName: d.display_name, clockedIn: d.clocked_in,
    workdayEndsAt: Number.isFinite(end) ? end : null,
  };
}

// ---------------------------------------------------------------------------
// F7: framing evidence and the attribution picker's people
// ---------------------------------------------------------------------------

export type EvidenceOutcome = { outcome: "ok"; evidence: FramerEvidence[] } | Rejected | NetworkError;

const EvidenceSchema = z.object({
  status: z.literal("ok"),
  lines: z.array(z.object({
    sku: z.string(),
    status: z.enum(["measured", "missing", "conflict"]),
    person_id: z.string().uuid().nullable(),
    display_name: z.string().nullable(),
    verified_event_id: z.string().nullable(),
    completed_event_id: z.string().nullable(),
  })).max(50),
});

export function evidenceLines(lines: readonly DispatchFramedLine[]): Array<{ sku: string; quantity: number; work_type: string }> {
  return lines.map((l) => ({ sku: l.sku, quantity: l.quantity, work_type: l.workType }));
}

/** The server's reading of who framed each SKU (the same reader the commit uses). */
export async function fetchFramerEvidence(
  client: SupabaseClient,
  a: { location: string; orderNumber: string; lines: readonly DispatchFramedLine[]; expectedCaller: string },
): Promise<EvidenceOutcome> {
  const res = await rpc(client, "scanner_dispatch_evidence", {
    p_location: a.location,
    p_order_number: a.orderNumber,
    p_lines: evidenceLines(a.lines),
    p_expected_caller: a.expectedCaller,
  });
  if ("outcome" in res) return res;
  const parsed = EvidenceSchema.safeParse(res.data);
  if (!parsed.success) return { outcome: "network_error", message: "Unreadable framing records answer; will ask again." };
  return {
    outcome: "ok",
    evidence: parsed.data.lines.map((l) => ({
      sku: l.sku, status: l.status, personId: l.person_id, displayName: l.display_name,
      verifiedEventId: l.verified_event_id, completedEventId: l.completed_event_id,
    })),
  };
}

export interface PickerPerson {
  personId: string;
  displayName: string;
}

const PeopleSchema = z.object({
  status: z.literal("ok"),
  people: z.array(z.object({ person_id: z.string().uuid(), display_name: z.string() })).max(500),
});

/** Active badge holders who are members of the site: ids and names only. */
export async function fetchDispatchPeople(client: SupabaseClient, location: string): Promise<{ outcome: "ok"; people: PickerPerson[] } | Rejected | NetworkError> {
  const res = await rpc(client, "scanner_dispatch_people", { p_location: location });
  if ("outcome" in res) return res;
  const parsed = PeopleSchema.safeParse(res.data);
  if (!parsed.success) return malformed("people");
  return { outcome: "ok", people: parsed.data.people.map((p) => ({ personId: p.person_id, displayName: p.display_name })) };
}

// ---------------------------------------------------------------------------
// Framing commit
// ---------------------------------------------------------------------------

export interface SavedAttribution {
  sku: string;
  source: "scan" | "manual";
  personId: string;
  displayName: string;
}

export interface SavedResult {
  pieces: number;
  eventIds: string[];
  negativeCodes: string[];
  replayed: boolean;
  /** F7 dispatch: who framed each framed SKU, as stored. */
  attributions?: SavedAttribution[];
}

export type CommitOutcome =
  | { outcome: "saved"; result: SavedResult }
  | { outcome: "already_recorded"; reason: string }
  | Rejected
  | NetworkError;

const CommitSchema = z.union([
  z.object({
    status: z.literal("saved"),
    pieces: z.number(),
    event_ids: z.array(z.string()),
    negative_codes: z.array(z.string()).default([]),
    replayed: z.boolean().optional(),
  }),
  z.object({ status: z.literal("already_recorded"), reason: z.string() }),
]);

/** The exact arguments for one job. Same job -> same arguments, always. */
export function commitParams(job: ScannerJob, prepared: PreparedFraming): Record<string, unknown> {
  return {
    p_location: job.location,
    p_request_id: job.requestId,
    p_receiver_id: job.receiverId,
    p_scanner_id: job.scannerId,
    p_staff_id: job.personId,
    p_badge: job.badge,
    p_order_number: prepared.orderNumber,
    p_scanned_at: job.scannedAt,
    p_expected_caller: job.callerId,
    p_lines: prepared.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, work_type: l.workType })),
    p_components: prepared.components,
    p_packaging: prepared.packaging
      ? {
          rule_set_id: prepared.packaging.ruleSetId,
          rule_set_version: prepared.packaging.ruleSetVersion,
          resolved: prepared.packaging.resolved,
          predicted: prepared.packaging.predicted,
          target: prepared.packaging.target,
          snapshot: prepared.packaging.snapshot,
        }
      : null,
  };
}

export async function commitFraming(client: SupabaseClient, job: ScannerJob, prepared: PreparedFraming): Promise<CommitOutcome> {
  const res = await rpc(client, "scanner_commit_framing", commitParams(job, prepared));
  if ("outcome" in res) return res;
  const parsed = CommitSchema.safeParse(res.data);
  if (!parsed.success) return { outcome: "network_error", message: "Unreadable answer from the server; will ask again." };
  const d = parsed.data;
  if (d.status === "already_recorded") return { outcome: "already_recorded", reason: d.reason };
  return { outcome: "saved", result: { pieces: d.pieces, eventIds: d.event_ids, negativeCodes: d.negative_codes, replayed: d.replayed ?? false } };
}

// ---------------------------------------------------------------------------
// F7: dispatch commit
// ---------------------------------------------------------------------------

const DispatchSchema = z.union([
  z.object({
    status: z.literal("saved"),
    items: z.number(),
    event_ids: z.array(z.string()),
    negative_codes: z.array(z.string()).default([]),
    attributions: z.array(z.object({
      sku: z.string(), source: z.enum(["scan", "manual"]), person_id: z.string().uuid(), display_name: z.string(),
    })).default([]),
    replayed: z.boolean().optional(),
  }),
  z.object({ status: z.literal("already_recorded"), reason: z.string() }),
]);

/** The exact arguments for one dispatch job. Same job -> same arguments, always. */
export function dispatchParams(job: ScannerJob, prepared: PreparedDispatch): Record<string, unknown> {
  return {
    p_location: job.location,
    p_request_id: job.requestId,
    p_receiver_id: job.receiverId,
    p_scanner_id: job.scannerId,
    p_staff_id: job.personId,
    p_badge: job.badge,
    p_order_number: prepared.orderNumber,
    p_scanned_at: job.scannedAt,
    p_items: prepared.items,
    p_lines: evidenceLines(prepared.framed),
    p_components: prepared.components,
    p_packaging: prepared.packaging
      ? {
          rule_set_id: prepared.packaging.ruleSetId,
          rule_set_version: prepared.packaging.ruleSetVersion,
          resolved: prepared.packaging.resolved,
          predicted: prepared.packaging.predicted,
          target: prepared.packaging.target,
          snapshot: prepared.packaging.snapshot,
        }
      : null,
    p_choices: prepared.choices.map((c) => ({ sku: c.sku, person_id: c.personId })),
    p_expected_caller: job.callerId,
  };
}

export async function commitDispatch(client: SupabaseClient, job: ScannerJob, prepared: PreparedDispatch): Promise<CommitOutcome> {
  const res = await rpc(client, "scanner_commit_dispatch", dispatchParams(job, prepared));
  if ("outcome" in res) return res;
  const parsed = DispatchSchema.safeParse(res.data);
  if (!parsed.success) return { outcome: "network_error", message: "Unreadable answer from the server; will ask again." };
  const d = parsed.data;
  if (d.status === "already_recorded") return { outcome: "already_recorded", reason: d.reason };
  return {
    outcome: "saved",
    result: {
      pieces: d.items, eventIds: d.event_ids, negativeCodes: d.negative_codes, replayed: d.replayed ?? false,
      attributions: d.attributions.map((a) => ({ sku: a.sku, source: a.source, personId: a.person_id, displayName: a.display_name })),
    },
  };
}

// ---------------------------------------------------------------------------
// Receiver heartbeat (tiny health row)
// ---------------------------------------------------------------------------

export async function sendHeartbeat(
  client: SupabaseClient,
  a: { location: string; receiverId: string; label: string; lastScanAt: string | null; queueCount: number; blockedCount: number },
): Promise<{ outcome: "ok" } | Rejected | NetworkError> {
  const res = await rpc(client, "scanner_heartbeat", {
    p_location: a.location,
    p_receiver_id: a.receiverId,
    p_label: a.label,
    p_last_scan_at: a.lastScanAt,
    p_queue_count: a.queueCount,
    p_blocked_count: a.blockedCount,
  });
  if ("outcome" in res) return res;
  return { outcome: "ok" };
}

// ---------------------------------------------------------------------------
// Order lookup (Shopify, through our API) and open cases
// ---------------------------------------------------------------------------

export type LookupOutcome = { kind: "ok"; lookup: OrderLookup } | { kind: "network"; message: string; auth?: boolean };

export async function fetchOrderLookup(
  fetchFn: typeof fetch,
  token: string | null,
  orderNumber: string,
): Promise<LookupOutcome> {
  if (!token) return { kind: "network", message: "Signed out. Sign in again; queued scans are kept.", auth: true };
  try {
    const res = await fetchFn(`/api/shopify/order?order_number=${encodeURIComponent(orderNumber)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return { kind: "ok", lookup: { found: false } };
    if (res.status === 401) return { kind: "network", message: "Session expired. Sign in again; queued scans are kept.", auth: true };
    if (!res.ok) return { kind: "network", message: `Order lookup failed (HTTP ${res.status}).` };
    return { kind: "ok", lookup: (await res.json()) as OrderLookup };
  } catch (e) {
    return { kind: "network", message: `Couldn't reach the order lookup: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export const OPEN_CASE_STATUSES = ["new", "query", "approved"] as const;

export async function hasOpenCase(client: SupabaseClient, location: string, orderNumber: string): Promise<boolean | "network"> {
  try {
    const { data, error } = await client
      .from("cs_cases")
      .select("id")
      .eq("location", location)
      .eq("order_number", orderNumber)
      .in("status", [...OPEN_CASE_STATUSES])
      .limit(1);
    if (error) return "network";
    return (data ?? []).length > 0;
  } catch {
    return "network";
  }
}

// ---------------------------------------------------------------------------
// Box rules for A0 jobs (scanner-specific; F4's loadPackagingConfig is unchanged)
// ---------------------------------------------------------------------------

/**
 * Only A0 jobs need this. Transport failures are "network" (the job waits);
 * a definite answer is returned as a setup: scan mode, no active rule set or
 * unreadable rules all come back as "no usable rules", so the A0 order is
 * blocked with a classic-station reason instead of stalling the queue.
 */
export async function loadScannerPackaging(client: SupabaseClient, location: string): Promise<PackagingSetup | "network"> {
  const missingTable = (code?: string) => code === "PGRST205" || code === "42P01";
  try {
    const settings = await client.from("packaging_settings").select("mode").eq("location", location).maybeSingle();
    if (settings.error) return missingTable(settings.error.code) ? { mode: "scan", ruleSet: null } : "network";
    if ((settings.data as { mode?: string } | null)?.mode !== "auto") return { mode: "scan", ruleSet: null };
    const active = await client
      .from("packaging_rule_sets")
      .select("id, version, body")
      .eq("location", location)
      .eq("status", "active")
      .maybeSingle();
    if (active.error) return "network";
    if (!active.data) return { mode: "auto", ruleSet: null };
    const rs = active.data as { id: string; version: number; body: unknown };
    const parsed = parseRuleSetBody(rs.body);
    if (!parsed.ok) return { mode: "auto", ruleSet: null };
    return { mode: "auto", ruleSet: { id: rs.id, version: rs.version, body: parsed.body } };
  } catch {
    return "network";
  }
}

// ---------------------------------------------------------------------------
// Delivery: one job at a time
// ---------------------------------------------------------------------------

export interface DeliveryDeps {
  outbox: ScannerOutbox;
  scope: JobScope;
  owner: string;
  lookupOrder(orderNumber: string): Promise<LookupOutcome>;
  openCase(orderNumber: string): Promise<boolean | "network">;
  /** null while the catalogue is still loading. */
  products(): readonly CatalogueProduct[] | null;
  /** Called only for orders with A0 framed lines. */
  packaging(): Promise<PackagingSetup | "network">;
  commit(job: ScannerJob, prepared: PreparedFraming): Promise<CommitOutcome>;
  /** F7: the server's framing evidence for a dispatch job's framed lines. */
  evidence?(orderNumber: string, lines: readonly DispatchFramedLine[]): Promise<EvidenceOutcome>;
  /** F7: the dispatch commit. */
  commitDispatch?(job: ScannerJob, prepared: PreparedDispatch): Promise<CommitOutcome>;
  /** False once the station was closed or its account/site changed: start nothing new. */
  active?(): boolean;
}

export type DeliveryReport =
  | { kind: "saved"; job: ScannerJob; result: SavedResult }
  | { kind: "already_recorded"; job: ScannerJob; reason: string }
  /** `uncertain`: an earlier attempt may still have saved it (do not re-record). */
  | { kind: "blocked"; job: ScannerJob; code: string; message: string; uncertain: boolean }
  | { kind: "waiting"; job: ScannerJob; message: string; auth: boolean }
  /** F7: a dispatch job is waiting for the dispatcher to choose who framed it (nothing sent). */
  | { kind: "needs_choice"; job: ScannerJob; message: string }
  /** Another claim owns the job now, or the station stopped: nothing changed. */
  | { kind: "superseded"; job: ScannerJob };

/**
 * Take the next job in this exact scope and move it one step as far as it
 * can go. Returns null when nothing is ready. Never throws for network or
 * server problems (they become reports); storage failures do throw.
 */
export async function processNext(d: DeliveryDeps): Promise<DeliveryReport | null> {
  const active = () => d.active?.() ?? true;
  if (!active()) return null;
  const claimed = await d.outbox.claimNext(d.scope, d.owner);
  if (!claimed) return null;
  let job: ScannerJob = claimed;
  const lease = claimed.leaseOwner ?? "";

  // Every finalizer is fenced by the lease: when the outbox ignored a stale
  // claim, report "superseded" (another claim owns the truth), never the
  // stale claim's own failure.
  const superseded = (): DeliveryReport => ({ kind: "superseded", job });
  const wait = async (message: string, auth = false): Promise<DeliveryReport> => {
    if (!(await d.outbox.retryLater(job.requestId, lease, message))) return superseded();
    return { kind: "waiting", job, message, auth };
  };
  const stopped = async (): Promise<DeliveryReport> => {
    await d.outbox.retryLater(job.requestId, lease, "Station closed or account changed.");
    return superseded();
  };

  // The job's own mode, captured at scan time (F6 jobs have none: framing).
  const mode = jobMode(job);

  try {
    if (job.status === "queued" && mode === "dispatch") {
      const products = d.products();
      if (!products) return wait("Product catalogue still loading.");
      const [lookup, openCase] = await Promise.all([d.lookupOrder(job.orderNumber), d.openCase(job.orderNumber)]);
      if (!active()) return stopped();
      if (lookup.kind === "network") return wait(lookup.message, lookup.auth ?? false);
      if (openCase === "network") return wait("Couldn't check replacement cases.");
      const ctx = { orderNumber: job.orderNumber, openCase, products, packaging: null as PackagingSetup | null };
      let prep: DispatchPrepareResult = prepareDispatchOrder(lookup.lookup, ctx);
      if (!prep.ok && prep.code === "packaging_not_auto") {
        const packaging = await d.packaging();
        if (!active()) return stopped();
        if (packaging === "network") return wait("Couldn't load the box rules.");
        prep = prepareDispatchOrder(lookup.lookup, { ...ctx, packaging });
      }
      if (!prep.ok) {
        if (!(await d.outbox.markBlocked(job.requestId, lease, { code: prep.code, message: prep.message, stage: "prepare" }))) return superseded();
        return { kind: "blocked", job, code: prep.code, message: prep.message, uncertain: job.uncertain };
      }
      let draft = prep.prepared;
      if (draft.framed.length > 0) {
        if (!d.evidence) return wait("Framing records are not available on this station.");
        const ev = await d.evidence(job.orderNumber, draft.framed);
        if (!active()) return stopped();
        if (ev.outcome === "network_error") return wait(ev.message, ev.auth ?? false);
        if (ev.outcome === "rejected") {
          if (!(await d.outbox.markBlocked(job.requestId, lease, { code: ev.code, message: ev.message, stage: "prepare" }))) return superseded();
          return { kind: "blocked", job, code: ev.code, message: ev.message, uncertain: job.uncertain };
        }
        const withEv = withEvidence(draft, ev.evidence);
        if (!withEv) return wait("Unreadable framing records answer; will ask again.");
        draft = withEv;
        if (unresolvedSkus(draft).length > 0) {
          // Definitely pre-commit: park the unsent draft until someone chooses.
          const message = `#${job.orderNumber}: framing scan missing. Choose who framed it.`;
          if (!(await d.outbox.awaitChoice(job.requestId, lease, draft, { code: "framer_missing", message, stage: "prepare" }))) return superseded();
          return { kind: "needs_choice", job, message };
        }
      }
      job = await d.outbox.setPrepared(job.requestId, lease, draft);
    }

    if (job.status === "queued") {
      const products = d.products();
      if (!products) return wait("Product catalogue still loading.");
      const [lookup, openCase] = await Promise.all([d.lookupOrder(job.orderNumber), d.openCase(job.orderNumber)]);
      if (!active()) return stopped();
      if (lookup.kind === "network") return wait(lookup.message, lookup.auth ?? false);
      if (openCase === "network") return wait("Couldn't check replacement cases.");
      const ctx = { orderNumber: job.orderNumber, openCase, products, packaging: null as PackagingSetup | null };
      let prep = prepareFramingOrder(lookup.lookup, ctx);
      // Box rules matter only for A0 framed work (the only reason for this code).
      if (!prep.ok && prep.code === "packaging_not_auto") {
        const packaging = await d.packaging();
        if (!active()) return stopped();
        if (packaging === "network") return wait("Couldn't load the box rules.");
        prep = prepareFramingOrder(lookup.lookup, { ...ctx, packaging });
      }
      if (!prep.ok) {
        if (!(await d.outbox.markBlocked(job.requestId, lease, { code: prep.code, message: prep.message, stage: "prepare" }))) return superseded();
        return { kind: "blocked", job, code: prep.code, message: prep.message, uncertain: job.uncertain };
      }
      // Persist the exact payload BEFORE anything is sent.
      job = await d.outbox.setPrepared(job.requestId, lease, prep.prepared);
    }

    const prepared = job.prepared;
    if (!prepared) return wait("Scan has no prepared payload.");
    if (isPreparedDispatch(prepared) !== (mode === "dispatch")) return wait("Stored scan does not match its mode.");
    if (mode === "dispatch" && !d.commitDispatch) return wait("Dispatch saving is not available on this station.");
    if (!active()) return stopped();
    const before = { attempts: job.attempts, uncertain: job.uncertain, priorUnknown: job.priorUnknown ?? false };
    job = await d.outbox.markAttempt(job.requestId, lease);
    // The station may have stopped while the attempt was being recorded.
    // Nothing was sent: undo the attempt (no invented unknown outcome), keep
    // the exact payload and earlier uncertainty, release the claim.
    if (!active()) {
      await d.outbox.releaseUnsent(job.requestId, lease, before);
      return superseded();
    }
  } catch (e) {
    if (e instanceof LeaseLostError) return superseded();
    throw e;
  }
  const prepared = job.prepared!;
  // The exact stored payload for the job's own mode; never re-derived here.
  const res = isPreparedDispatch(prepared) ? await d.commitDispatch!(job, prepared) : await d.commit(job, prepared);
  switch (res.outcome) {
    case "saved":
      await d.outbox.markDone(job.requestId, {
        kind: "saved",
        message: mode === "dispatch" ? `${job.displayName}: #${job.orderNumber} dispatched` : `${job.displayName}: #${job.orderNumber} saved`,
        pieces: res.result.pieces,
        warnings: res.result.negativeCodes.length ? [`Stock now below zero: ${res.result.negativeCodes.join(", ")}`] : [],
      });
      return { kind: "saved", job, result: res.result };
    case "already_recorded":
      await d.outbox.markDone(job.requestId, {
        kind: "already_recorded",
        message: mode === "dispatch"
          ? `#${job.orderNumber} was already dispatched. Nothing more was saved.`
          : `#${job.orderNumber} already has framing work recorded. No extra credit. Check it on the classic station.`,
        pieces: 0,
        warnings: [res.reason],
      });
      return { kind: "already_recorded", job, reason: res.reason };
    case "rejected": {
      if (!(await d.outbox.markBlocked(job.requestId, lease, { code: res.code, message: res.message, stage: "commit" }))) return superseded();
      // An earlier unanswered attempt may have saved it: say so, don't invite re-recording.
      return { kind: "blocked", job, code: res.code, message: res.message, uncertain: job.priorUnknown ?? false };
    }
    case "network_error":
      // Unknown outcome: keep the job exactly as is and ask again later.
      return wait(res.message, res.auth ?? false);
  }
}
