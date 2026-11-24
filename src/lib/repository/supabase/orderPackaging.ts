import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { PackingPoint } from "@/lib/domain/packaging/contents";
import type { Quantities } from "@/lib/domain/packaging/reconcile";
import { parseRuleSetBody, type RuleSetBody } from "@/lib/domain/packaging/ruleSet";

/**
 * F4 box-auto-pick: the only place the app talks to the packaging tables and
 * functions (migration 0047). Production is Supabase-only, so this does not
 * go through Repository.ts.
 *
 * Every function takes the client so it can be tested with a fake.
 */

export type PackagingMode = "scan" | "auto";

const QuantitiesSchema = z.record(z.number());

const PickSchema = z.object({
  id: z.string(),
  location: z.string(),
  order_number: z.string(),
  packing_point: z.enum(["a0_framed", "dispatch", "unframed"]),
  shipment_key: z.string(),
  state: z.enum(["auto", "overridden", "unresolved", "legacy_scan"]),
  stock_state: z.enum(["posted", "short", "unposted"]),
  rule_set_id: z.string().nullable(),
  rule_set_version: z.number().nullable(),
  input_snapshot: z.unknown().optional(),
  predicted: QuantitiesSchema,
  target: QuantitiesSchema,
  posted: QuantitiesSchema,
  revision: z.number(),
  source_event_id: z.string().nullable().optional(),
  staff_id: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type PackagingPick = z.infer<typeof PickSchema>;

const RuleSetRowSchema = z.object({
  id: z.string(),
  location: z.string(),
  version: z.number(),
  status: z.enum(["draft", "active", "retired"]),
  body: z.unknown(),
  note: z.string(),
  created_by: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  activated_by: z.string().nullable().optional(),
  activated_at: z.string().nullable().optional(),
});
export type RuleSetRow = z.infer<typeof RuleSetRowSchema>;

export interface ActiveRuleSet {
  id: string;
  version: number;
  body: RuleSetBody;
}

export interface PackagingConfig {
  /** Effective mode. Falls back to "scan" whenever auto cannot run safely. */
  mode: PackagingMode;
  ruleSet: ActiveRuleSet | null;
  /** When the site last changed mode (ISO), or null with no settings row. */
  modeChangedAt: string | null;
  /** Set when the site asked for auto but the app had to fall back to scan. */
  warning: string | null;
}

export const SCAN_CONFIG: PackagingConfig = { mode: "scan", ruleSet: null, modeChangedAt: null, warning: null };

interface RpcError {
  message?: string;
  code?: string;
}

/** Server said no, with a reason. Retrying the same request will not help. */
export interface Rejected {
  outcome: "rejected";
  code: string;
  message: string;
}
/** No definitive answer (offline, timeout, transient database error). Safe to retry with the same request id. */
export interface NetworkError {
  outcome: "network_error";
  message: string;
}

const REJECTION_TEXT: Record<string, string> = {
  not_authenticated: "You are signed out. Sign in again.",
  forbidden_location: "This account has no access to this site.",
  forbidden_role: "This account is not allowed to do that.",
  event_not_found: "The completion was not found.",
  event_not_terminal: "That event is not a completion.",
  not_a_packing_point: "This station does not pack parcels.",
  rule_set_not_found: "The box rules changed. Reload the order.",
  not_in_catalogue: "That packaging item is not in the site's list.",
  unknown_product: "That packaging item no longer exists in stock.",
  invalid_quantities: "Packaging quantities must be whole numbers from 1 to 20.",
  reason_required: "Give a reason for the change.",
  pick_not_found: "The packaging record was not found.",
  not_a_draft: "Only a draft can be edited or activated.",
  no_examples: "Add at least one example before activating.",
  no_active_rule_set: "Activate a rule set before switching to automatic.",
  invalid_rule_set: "The rule set is not valid.",
  invalid_mode: "Unknown mode.",
  unavailable: "Packaging is not set up on this database yet.",
};

/** Transient Postgres classes: connection, transaction rollback, resources, operator intervention. */
const TRANSIENT_SQLSTATE = /^(08|40|53|57)/;

/**
 * A sign-in problem is not an answer about the request: the session expired
 * or the person is signed out, and signing in again can complete it. Treat it
 * like "no answer" so the queued request is kept, not discarded.
 */
function isSessionProblem(error: RpcError): boolean {
  const code = error.code ?? "";
  const message = error.message ?? "";
  return code === "PGRST301" || code === "PGRST302" || /jwt (is )?expired|invalid jwt|packaging: not_authenticated/i.test(message);
}

export function classifyError(error: RpcError): Rejected | NetworkError {
  const message = error.message ?? "";
  if (isSessionProblem(error)) {
    return { outcome: "network_error", message: "You are signed out or your session expired. Sign in again; this will be sent then." };
  }
  const m = /packaging: ([a-z_]+)/.exec(message);
  if (m) {
    const code = m[1];
    return { outcome: "rejected", code, message: REJECTION_TEXT[code] ?? message };
  }
  const code = error.code ?? "";
  // Function or table missing: migration not applied on this database.
  if (code === "PGRST202" || code === "PGRST205" || code === "42883" || code === "42P01") {
    return { outcome: "rejected", code: "unavailable", message: REJECTION_TEXT.unavailable };
  }
  if (code === "" || TRANSIENT_SQLSTATE.test(code)) {
    return { outcome: "network_error", message: message || "No answer from the server." };
  }
  return { outcome: "rejected", code: "server_error", message: message || "The server refused the request." };
}

function malformed(what: string): Rejected {
  return { outcome: "rejected", code: "malformed_response", message: `Unexpected answer from the server (${what}).` };
}

async function callRpc(
  client: SupabaseClient,
  fn: string,
  params: Record<string, unknown>,
): Promise<{ data: unknown } | Rejected | NetworkError> {
  try {
    const { data, error } = await client.rpc(fn, params);
    if (error) return classifyError(error);
    return { data };
  } catch (e) {
    return { outcome: "network_error", message: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Site mode + active rule set. Never throws: any problem reading or parsing
 * resolves to scan mode (the old, known-good behaviour), with a warning when
 * the site had asked for auto.
 */
export async function loadPackagingConfig(client: SupabaseClient, location: string): Promise<PackagingConfig> {
  try {
    const settings = await client
      .from("packaging_settings")
      .select("mode, mode_changed_at")
      .eq("location", location)
      .maybeSingle();
    if (settings.error || !settings.data) return SCAN_CONFIG;
    const row = settings.data as { mode?: string; mode_changed_at?: string };
    const modeChangedAt = row.mode_changed_at ?? null;
    if (row.mode !== "auto") return { ...SCAN_CONFIG, modeChangedAt };

    const fallback = (warning: string): PackagingConfig => ({ mode: "scan", ruleSet: null, modeChangedAt, warning });

    const active = await client
      .from("packaging_rule_sets")
      .select("id, version, body")
      .eq("location", location)
      .eq("status", "active")
      .maybeSingle();
    if (active.error) return fallback("Could not load the box rules. Scan the box as before.");
    if (!active.data) return fallback("This site has no active box rules. Scan the box as before.");
    const rs = active.data as { id: string; version: number; body: unknown };
    const parsed = parseRuleSetBody(rs.body);
    if (!parsed.ok) return fallback("The box rules could not be read. Scan the box as before.");
    return { mode: "auto", ruleSet: { id: rs.id, version: rs.version, body: parsed.body }, modeChangedAt, warning: null };
  } catch {
    return SCAN_CONFIG;
  }
}

// ---------------------------------------------------------------------------
// Apply / override / retry
// ---------------------------------------------------------------------------

export interface ApplyArgs {
  location: string;
  requestId: string;
  eventId: string;
  ruleSetId: string;
  resolved: boolean;
  predicted: Quantities;
  target: Quantities;
  snapshot: unknown;
}

export interface PostingInfo {
  deltas: Quantities;
  unposted: string[];
  negative: string[];
}

export type ApplyOutcome =
  | ({ outcome: "applied"; pick: PackagingPick; replayed: boolean } & PostingInfo)
  | { outcome: "already_applied"; pick: PackagingPick }
  | Rejected
  | NetworkError;

export type OverrideOutcome =
  | ({ outcome: "overridden"; pick: PackagingPick; replayed: boolean } & PostingInfo)
  | { outcome: "unchanged"; pick: PackagingPick }
  | { outcome: "conflict"; pick: PackagingPick }
  | Rejected
  | NetworkError;

export type RetryOutcome = ({ outcome: "retried"; pick: PackagingPick } & PostingInfo) | Rejected | NetworkError;

const PostingSchema = z.object({
  deltas: QuantitiesSchema.default({}),
  unposted: z.array(z.string()).default([]),
  negative: z.array(z.string()).default([]),
});

const ResultSchema = z
  .object({ status: z.string(), pick: PickSchema, replayed: z.boolean().optional() })
  .and(PostingSchema);

/** Request id for the apply that follows a completion event: one per event, so retries replay. */
export function applyRequestId(eventId: string): string {
  return `apply:${eventId}`;
}

export function newRequestId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${rand}`;
}

export async function applyPackaging(client: SupabaseClient, a: ApplyArgs): Promise<ApplyOutcome> {
  const res = await callRpc(client, "packaging_apply", {
    p_location: a.location,
    p_request_id: a.requestId,
    p_event_id: a.eventId,
    p_rule_set_id: a.ruleSetId,
    p_resolved: a.resolved,
    p_predicted: a.predicted,
    p_target: a.target,
    p_input_snapshot: a.snapshot ?? null,
  });
  if ("outcome" in res) return res;
  const parsed = ResultSchema.safeParse(res.data);
  if (!parsed.success) return malformed("apply");
  const { status, pick, replayed, deltas, unposted, negative } = parsed.data;
  if (status === "applied") return { outcome: "applied", pick, replayed: replayed === true, deltas, unposted, negative };
  if (status === "already_applied") return { outcome: "already_applied", pick };
  return malformed(`apply status ${status}`);
}

export interface OverrideArgs {
  location: string;
  requestId: string;
  pickId: string;
  expectedRevision: number;
  target: Quantities;
  reason: string;
  staffId: string | null;
}

export async function overridePackaging(client: SupabaseClient, a: OverrideArgs): Promise<OverrideOutcome> {
  const res = await callRpc(client, "packaging_override", {
    p_location: a.location,
    p_request_id: a.requestId,
    p_pick_id: a.pickId,
    p_expected_revision: a.expectedRevision,
    p_target: a.target,
    p_reason: a.reason,
    p_staff_id: a.staffId,
  });
  if ("outcome" in res) return res;
  const parsed = ResultSchema.safeParse(res.data);
  if (!parsed.success) return malformed("override");
  const { status, pick, replayed, deltas, unposted, negative } = parsed.data;
  if (status === "overridden") return { outcome: "overridden", pick, replayed: replayed === true, deltas, unposted, negative };
  if (status === "unchanged") return { outcome: "unchanged", pick };
  if (status === "conflict") return { outcome: "conflict", pick };
  return malformed(`override status ${status}`);
}

export async function retryPackaging(
  client: SupabaseClient,
  a: { location: string; requestId: string; pickId: string },
): Promise<RetryOutcome> {
  const res = await callRpc(client, "packaging_retry", {
    p_location: a.location,
    p_request_id: a.requestId,
    p_pick_id: a.pickId,
  });
  if ("outcome" in res) return res;
  const parsed = ResultSchema.safeParse(res.data);
  if (!parsed.success || parsed.data.status !== "retried") return malformed("retry");
  const { pick, deltas, unposted, negative } = parsed.data;
  return { outcome: "retried", pick, deltas, unposted, negative };
}

/** The existing pick for a shipment, or null. Returns undefined when it could not be read. */
export async function findPick(
  client: SupabaseClient,
  a: { location: string; orderNumber: string; packingPoint: PackingPoint; shipmentKey: string },
): Promise<PackagingPick | null | undefined> {
  try {
    const { data, error } = await client
      .from("packaging_picks")
      .select("*")
      .eq("location", a.location)
      .eq("order_number", a.orderNumber)
      .eq("packing_point", a.packingPoint)
      .eq("shipment_key", a.shipmentKey)
      .maybeSingle();
    if (error) return undefined;
    if (!data) return null;
    const parsed = PickSchema.safeParse(data);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function shipmentKeyFor(csCaseId: string | null | undefined): string {
  return csCaseId ? `cs:${csCaseId}` : "orig";
}

export function parsePick(row: unknown): PackagingPick | null {
  const parsed = PickSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Rules and mode (Settings)
// ---------------------------------------------------------------------------

export type Saved<T> = { outcome: "ok"; value: T } | Rejected | NetworkError;

export async function listRuleSets(client: SupabaseClient, location: string): Promise<Saved<RuleSetRow[]>> {
  try {
    const { data, error } = await client
      .from("packaging_rule_sets")
      .select("*")
      .eq("location", location)
      .order("version", { ascending: false });
    if (error) return classifyError(error);
    const rows: RuleSetRow[] = [];
    for (const r of (data ?? []) as unknown[]) {
      const parsed = RuleSetRowSchema.safeParse(r);
      if (parsed.success) rows.push(parsed.data);
    }
    return { outcome: "ok", value: rows };
  } catch (e) {
    return { outcome: "network_error", message: e instanceof Error ? e.message : String(e) };
  }
}

async function ruleSetRpc(client: SupabaseClient, fn: string, params: Record<string, unknown>): Promise<Saved<RuleSetRow>> {
  const res = await callRpc(client, fn, params);
  if ("outcome" in res) return res;
  const parsed = RuleSetRowSchema.safeParse(res.data);
  return parsed.success ? { outcome: "ok", value: parsed.data } : malformed(fn);
}

export function saveRuleSet(
  client: SupabaseClient,
  a: { location: string; id: string | null; body: RuleSetBody; note: string },
): Promise<Saved<RuleSetRow>> {
  return ruleSetRpc(client, "packaging_save_rule_set", { p_location: a.location, p_id: a.id, p_body: a.body, p_note: a.note });
}

export function activateRuleSet(client: SupabaseClient, a: { location: string; id: string }): Promise<Saved<RuleSetRow>> {
  return ruleSetRpc(client, "packaging_activate_rule_set", { p_location: a.location, p_id: a.id });
}

export async function setPackagingMode(
  client: SupabaseClient,
  a: { location: string; mode: PackagingMode },
): Promise<Saved<PackagingMode>> {
  const res = await callRpc(client, "packaging_set_mode", { p_location: a.location, p_mode: a.mode });
  if ("outcome" in res) return res;
  const mode = (res.data as { mode?: string } | null)?.mode;
  return mode === "scan" || mode === "auto" ? { outcome: "ok", value: mode } : malformed("set mode");
}
