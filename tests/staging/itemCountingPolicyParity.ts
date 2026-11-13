/**
 * Policy parity for migration 0036 (item-counting Task 4, policy amendment).
 * Pure: canonical policy hashing, real-session claims checks, and comparing
 * a before/after visibility snapshot. The runner collects the snapshots
 * (`--policy-parity=before|after`) on staging only.
 *
 * Nothing here holds or logs a token or claim VALUE: only sizes, key/type
 * shapes, booleans and synthetic row identities.
 */
import { createHash } from "node:crypto";

/** One pg_policies row for public.production_events. */
export interface PolicyRow {
  schemaname: string;
  tablename: string;
  policyname: string;
  permissive: string;
  roles: string[];
  cmd: string;
  qual: string | null;
  with_check: string | null;
}

/** Canonical JSON of ALL production_events policies (sorted, ordered fields, roles sorted, NULL kept) and its SHA-256. */
export function policyHash(rows: readonly PolicyRow[]): { canonical: string; hash: string } {
  const canonical = JSON.stringify(
    [...rows]
      .sort((a, b) => `${a.schemaname}\u0000${a.tablename}\u0000${a.policyname}`.localeCompare(`${b.schemaname}\u0000${b.tablename}\u0000${b.policyname}`))
      .map((r) => [r.schemaname, r.tablename, r.policyname, r.permissive, [...r.roles].sort(), r.cmd, r.qual ?? null, r.with_check ?? null]),
  );
  return { canonical, hash: createHash("sha256").update(canonical, "utf8").digest("hex") };
}

/** Normalize a role list from pg (text[] arrives as string[] or "{public}"). */
export function rolesOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  const s = String(v ?? "");
  return s.replace(/^\{|\}$/g, "").split(",").filter(Boolean);
}

const SELECT_NAMES = ["production_events_read", "production_events_select"];
const ALL_NAMES = ["production_events_delete", "production_events_insert", "production_events_read", "production_events_select", "production_events_update"];

/** Whitespace collapsed and `public.` dropped (how names print depends on the reader's search_path). */
const compact = (s: string | null) => (s ?? "").replace(/\s+/g, " ").replace(/\bpublic\./g, "").trim();

/** Is this the reviewed post-0036 SELECT predicate (membership array + init-plans, no per-row helper)? */
export function isPost0036Select(row: PolicyRow): string[] {
  const out: string[] = [];
  const q = compact(row.qual);
  const at = `policy ${row.policyname}`;
  if (row.cmd !== "SELECT") out.push(`${at} is ${row.cmd}, expected SELECT`);
  if (row.permissive !== "PERMISSIVE") out.push(`${at} is ${row.permissive}, expected PERMISSIVE`);
  if (rolesOf(row.roles).join(",") !== "public") out.push(`${at} applies to ${rolesOf(row.roles).join(",")}, expected public`);
  if (/can_access_location\(/.test(q)) out.push(`${at} still calls can_access_location per row`);
  if (!/location = ANY \(ARRAY\( SELECT ul\.location FROM user_locations ul WHERE \(ul\.user_id = \( SELECT auth\.uid\(\) AS uid\)\)\)\)/.test(q)) {
    out.push(`${at} does not use the once-per-statement membership array`);
  }
  if (!/staff_id = \( SELECT auth\.uid\(\) AS uid\)/.test(q)) out.push(`${at} does not compare staff_id to an init-plan auth.uid()`);
  // With every init-plan form removed, no helper call may remain (it would run per row).
  const bare = q
    .replace(/\( SELECT auth\.uid\(\) AS uid\)/g, "")
    .replace(/\( SELECT is_manager_or_higher\(\) AS is_manager_or_higher\)/g, "")
    .replace(/\( SELECT current_user_role\(\) AS current_user_role\)/g, "");
  for (const fn of ["auth.uid()", "is_manager_or_higher()", "current_user_role()"]) {
    if (bare.includes(fn)) out.push(`${at} calls ${fn} per row`);
  }
  if (row.policyname === "production_events_read" && !/\( SELECT is_manager_or_higher\(\) AS is_manager_or_higher\)/.test(q)) {
    out.push(`${at} does not use an init-plan is_manager_or_higher()`);
  }
  if (row.policyname === "production_events_select") {
    if (!/\( SELECT current_user_role\(\) AS current_user_role\) = ANY \(ARRAY\['owner'::text, 'manager'::text, 'cs'::text, 'kiosk'::text\]\)/.test(q)) {
      out.push(`${at} does not use an init-plan current_user_role() with owner/manager/cs/kiosk`);
    }
  }
  return out;
}

/** The pre-0036 SELECT predicates as recovered from 0012/0033 (and as found on staging). */
export const PRE_0036_SELECT_QUAL: Record<string, string> = {
  production_events_read: "(can_access_location(location) AND ((staff_id = auth.uid()) OR is_manager_or_higher()))",
  production_events_select:
    "(can_access_location(location) AND ((staff_id = auth.uid()) OR (current_user_role() = ANY (ARRAY['owner'::text, 'manager'::text, 'cs'::text, 'kiosk'::text]))))",
};

/** Check the policy set is exactly the five expected policies, in the pre- or post-0036 form. */
export function checkPolicySet(rows: readonly PolicyRow[], expect: "pre" | "post"): string[] {
  const out: string[] = [];
  const names = rows.map((r) => r.policyname).sort();
  if (names.join(",") !== ALL_NAMES.join(",")) out.push(`production_events policies are ${names.join(", ") || "none"}, expected ${ALL_NAMES.join(", ")}`);
  for (const r of rows.filter((x) => SELECT_NAMES.includes(x.policyname))) {
    if (expect === "post") out.push(...isPost0036Select(r));
    else if (compact(r.qual) !== compact(PRE_0036_SELECT_QUAL[r.policyname])) out.push(`policy ${r.policyname} is not the recovered pre-0036 predicate`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Real-session claims

export const REQUIRED_CLAIM_KEYS = [
  "aal", "amr", "app_metadata", "aud", "email", "exp", "iat", "is_anonymous", "iss", "phone", "role", "session_id", "sub", "user_metadata",
] as const;
const CLAIM_TYPES: Record<string, string> = {
  aal: "string", amr: "array", app_metadata: "object", aud: "string", email: "string", exp: "number", iat: "number",
  is_anonymous: "boolean", iss: "string", phone: "string", role: "string", session_id: "string", sub: "string", user_metadata: "object",
};
/** Explicit guard against minimal {sub, role} claims; real sessions are about 630 bytes. */
export const MIN_CLAIMS_BYTES = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What we keep about a session's claims: sizes and shapes, never values. */
export interface ClaimsSource {
  role: string;
  bytes: number;
  /** "key:type,…" sorted, like the SQL evidence. */
  shape: string;
  problems: string[];
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Decode a JWT payload exactly as sent (base64url → UTF-8 JSON text). */
export function jwtPayloadText(token: string): string {
  const part = token.split(".")[1];
  if (!part) throw new Error("access token is not a JWT");
  return Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** Validate a real session's claims text for `role` (the app role whose test user signed in). */
export function claimsSource(role: string, text: string, opts: { issuer: string; nowSec: number; marginSec?: number }): ClaimsSource {
  const problems: string[] = [];
  let j: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) j = parsed as Record<string, unknown>;
    else problems.push(`${role}: claims are not a JSON object`);
  } catch {
    problems.push(`${role}: claims are not JSON`);
  }
  const bytes = Buffer.byteLength(text, "utf8");
  const shape = Object.keys(j).sort().map((k) => `${k}:${jsonType(j[k])}`).join(",");
  for (const k of REQUIRED_CLAIM_KEYS) {
    if (!(k in j)) problems.push(`${role}: claims lack ${k}`);
    else if (jsonType(j[k]) !== CLAIM_TYPES[k]) problems.push(`${role}: claim ${k} is ${jsonType(j[k])}, expected ${CLAIM_TYPES[k]}`);
  }
  if (bytes < MIN_CLAIMS_BYTES) problems.push(`${role}: claims are ${bytes} bytes; minimal claims are not allowed (need a real session, at least ${MIN_CLAIMS_BYTES})`);
  if (j.role !== undefined && j.role !== "authenticated") problems.push(`${role}: claims DB role is not authenticated`);
  if (j.aud !== undefined && j.aud !== "authenticated") problems.push(`${role}: claims audience is not authenticated`);
  if (j.iss !== undefined && j.iss !== opts.issuer) problems.push(`${role}: claims issuer is not the staging project`);
  if (j.sub !== undefined && !UUID.test(String(j.sub))) problems.push(`${role}: claims subject is not a UUID`);
  if (j.session_id !== undefined && !UUID.test(String(j.session_id))) problems.push(`${role}: claims session_id is not a UUID`);
  if (typeof j.exp === "number" && j.exp <= opts.nowSec + (opts.marginSec ?? 300)) problems.push(`${role}: session expires too soon; sign in again`);
  if (typeof j.iat === "number" && typeof j.exp === "number" && j.iat >= j.exp) problems.push(`${role}: claims iat is not before exp`);
  if (Array.isArray(j.amr) && !j.amr.every((a) => typeof a === "object" && a !== null && "method" in a)) problems.push(`${role}: claims amr is malformed`);
  return { role, bytes, shape, problems };
}

/** SQL claims evidence for one role switch, checked against that role's real session. */
export function checkClaimsEvidence(row: Record<string, unknown>, source: ClaimsSource | undefined): string[] {
  const who = String(row.claims_for);
  const out: string[] = [];
  if (!source) return [`${who}: no real session claims were supplied`];
  out.push(...source.problems);
  if (Number(row.claims_bytes) !== source.bytes) out.push(`${who}: SQL claims are ${String(row.claims_bytes)} bytes but the session's are ${source.bytes}`);
  if (String(row.claims_shape) !== source.shape) out.push(`${who}: SQL claims shape differs from the session's`);
  for (const k of ["claims_db_role_ok", "claims_aud_ok", "claims_iss_ok", "claims_unexpired", "claims_subject_ok", "legacy_overrides_empty"]) {
    if (row[k] !== true && row[k] !== "t" && row[k] !== "true") out.push(`${who}: ${k.replace(/_/g, " ")} is not true`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Visibility snapshots and comparison

export const PARITY_ROLES = ["owner", "manager", "staff", "kiosk", "cs", "no-subject"] as const;
export type ParityRole = (typeof PARITY_ROLES)[number];
export const PARITY_SITES = ["au", "uk", "us", "staging"] as const;
/** Membership arrangements captured before and after: the standard one, and owner/kiosk without uk (cross-site denial for all-site roles). */
export const ARRANGEMENTS = ["standard", "owner-kiosk-without-uk"] as const;
export type Arrangement = (typeof ARRANGEMENTS)[number];

export interface RoleSnapshot {
  /** Profile role and memberships seen as postgres for the session's subject (no claim values). */
  profileRole: string | null;
  memberships: string;
  claimsBytes: number | null;
  /** Sorted "location|id" keys visible as `authenticated` with RLS on, per site. */
  visible: Record<string, string[]>;
  /** Sorted ids returned by each direct app reader's filters, per "reader:site" (see READER_PROBES). */
  readers?: Record<string, string[]>;
  errors: string[];
}

/** Direct app readers of production_events, replayed with their own filters at the fixed cutoff. */
export const READER_PROBES = [
  "currently-clocked-in", "daily-timesheet", "labour-hours-today", "live-order-completions", "package-history",
  "recent-activity", "production-verified-lines", "production-counters", "reports-event-stream", "reports-order-search", "welcome-team",
] as const;

export interface CatalogSnapshot {
  policies: PolicyRow[];
  policyHash: string;
  /** md5 of helper definitions, RLS flags, table grants, role configs, v1/v2 definitions/ACLs. */
  other: Record<string, string>;
}

export interface ParitySnapshot {
  mode: "before" | "after";
  arrangement: Arrangement;
  capturedAt: string;
  revision: string;
  catalog: CatalogSnapshot;
  /** Privileged (non-RLS) fingerprint of all saved events: count and md5 per site. */
  fixture: Record<string, string>;
  roles: Partial<Record<ParityRole, RoleSnapshot>>;
}

export interface ParityComparison {
  arrangement: Arrangement;
  comparedAt: string;
  beforeHash: string;
  afterHash: string;
  problems: string[];
  /** Per role/site: rows before and after (equal sets when no problems). */
  counts: Record<string, number>;
}

export interface ParityArtifact {
  snapshots: ParitySnapshot[];
  comparisons: ParityComparison[];
}

/** Expected memberships per arrangement (the app's site list, excluding the "staging" site). */
const EXPECTED_SITES: Record<Arrangement, Record<string, string[]>> = {
  standard: { owner: ["au", "uk", "us"], kiosk: ["au", "uk", "us"], manager: ["au"], staff: ["au"], cs: ["au"] },
  "owner-kiosk-without-uk": { owner: ["au", "us"], kiosk: ["au", "us"], manager: ["au"], staff: ["au"], cs: ["au"] },
};

/** Problems with one snapshot on its own (complete, right memberships, no errors). */
export function checkSnapshot(s: ParitySnapshot): string[] {
  const out: string[] = [];
  const at = `${s.mode}/${s.arrangement}`;
  out.push(...checkPolicySet(s.catalog.policies, s.mode === "before" ? "pre" : "post").map((p) => `${at}: ${p}`));
  for (const role of PARITY_ROLES) {
    const r = s.roles[role];
    if (!r) {
      out.push(`${at}: role ${role} was not captured`);
      continue;
    }
    for (const e of r.errors) out.push(`${at}: ${role}: ${e}`);
    for (const site of PARITY_SITES) if (!r.visible[site]) out.push(`${at}: ${role} at ${site} was not read`);
    for (const probe of READER_PROBES) {
      for (const site of PARITY_SITES) if (!r.readers?.[`${probe}:${site}`]) out.push(`${at}: ${role} reader ${probe} at ${site} was not replayed`);
    }
    if (role === "no-subject") {
      const seen = Object.values(r.visible).reduce((n, xs) => n + xs.length, 0);
      if (seen !== 0) out.push(`${at}: a session with no subject saw ${seen} rows`);
      continue;
    }
    if (r.profileRole !== role) out.push(`${at}: the ${role} test user has profile role ${r.profileRole ?? "none"}`);
    const want = EXPECTED_SITES[s.arrangement][role];
    const have = r.memberships.split(",").filter((x) => x && x !== "staging").sort();
    if (have.join(",") !== want.join(",")) out.push(`${at}: ${role} is a member of ${have.join(",") || "nothing"}, expected ${want.join(",")} for this arrangement`);
    // Denial: no rows at a site the role is not a member of.
    for (const site of ["au", "uk", "us"]) {
      if (!want.includes(site) && (r.visible[site]?.length ?? 0) !== 0) out.push(`${at}: ${role} saw ${r.visible[site].length} rows at ${site} without membership`);
    }
  }
  return out;
}

function diffSorted(a: readonly string[], b: readonly string[]): { onlyA: number; onlyB: number; sampleA: string[]; sampleB: string[] } {
  const sb = new Set(b);
  const sa = new Set(a);
  const onlyA = a.filter((x) => !sb.has(x));
  const onlyB = b.filter((x) => !sa.has(x));
  return { onlyA: onlyA.length, onlyB: onlyB.length, sampleA: onlyA.slice(0, 3), sampleB: onlyB.slice(0, 3) };
}

/** Compare before and after for one arrangement: only the two SELECT predicates may change; every role/site row set must be identical. */
export function compareSnapshots(before: ParitySnapshot, after: ParitySnapshot, comparedAt: string): ParityComparison {
  const problems: string[] = [];
  if (before.arrangement !== after.arrangement) problems.push("before and after are different arrangements");
  if (before.mode !== "before" || after.mode !== "after") problems.push("snapshots are not a before/after pair");
  problems.push(...checkSnapshot(before), ...checkSnapshot(after));
  if (JSON.stringify(before.fixture) !== JSON.stringify(after.fixture)) problems.push("saved event data changed between before and after (fixture fingerprint differs); parity is invalid");
  // Non-SELECT policies and everything else in the catalog must be identical.
  const byName = (rows: PolicyRow[]) => new Map(rows.map((r) => [r.policyname, r]));
  const b = byName(before.catalog.policies);
  const a = byName(after.catalog.policies);
  for (const name of ALL_NAMES.filter((n) => !SELECT_NAMES.includes(n))) {
    if (JSON.stringify(b.get(name)) !== JSON.stringify(a.get(name))) problems.push(`policy ${name} changed; only the two SELECT policies may change`);
  }
  for (const k of new Set([...Object.keys(before.catalog.other), ...Object.keys(after.catalog.other)])) {
    if (before.catalog.other[k] !== after.catalog.other[k]) problems.push(`catalog item ${k} changed between before and after`);
  }
  const counts: Record<string, number> = {};
  for (const role of PARITY_ROLES) {
    const rb = before.roles[role];
    const ra = after.roles[role];
    if (!rb || !ra) continue;
    if (rb.memberships !== ra.memberships) problems.push(`${role}: memberships differ between before (${rb.memberships}) and after (${ra.memberships})`);
    for (const site of PARITY_SITES) {
      const xb = rb.visible[site] ?? [];
      const xa = ra.visible[site] ?? [];
      counts[`${role}:${site}`] = xa.length;
      const d = diffSorted(xb, xa);
      if (d.onlyA || d.onlyB) {
        problems.push(`${role} at ${site}: ${d.onlyA} rows visible only before (e.g. ${d.sampleA.join(" ")}), ${d.onlyB} only after (e.g. ${d.sampleB.join(" ")})`);
      }
    }
    for (const key of new Set([...Object.keys(rb.readers ?? {}), ...Object.keys(ra.readers ?? {})])) {
      const d = diffSorted(rb.readers?.[key] ?? [], ra.readers?.[key] ?? []);
      if (d.onlyA || d.onlyB) problems.push(`${role} reader ${key}: ${d.onlyA} ids only before, ${d.onlyB} only after`);
    }
  }
  return { arrangement: after.arrangement, comparedAt, beforeHash: before.catalog.policyHash, afterHash: after.catalog.policyHash, problems, counts };
}

/** Is parity complete for the current policies? Both arrangements compared cleanly, latest after-hash = current hash. */
export function checkParityArtifact(art: ParityArtifact | null, currentPolicyHash: string | null): string[] {
  if (!art) return ["policy parity has not been run (run --policy-parity=before, apply 0036, then --policy-parity=after)"];
  const out: string[] = [];
  for (const arrangement of ARRANGEMENTS) {
    const c = [...art.comparisons].reverse().find((x) => x.arrangement === arrangement);
    if (!c) out.push(`policy parity for arrangement ${arrangement} is not complete`);
    else if (c.problems.length) out.push(`policy parity for ${arrangement} failed: ${c.problems[0]}`);
    else if (!currentPolicyHash || c.afterHash !== currentPolicyHash) out.push(`policy parity for ${arrangement} was captured under different policies; run it again`);
  }
  return out;
}

/** Stable hash of the artifact's comparisons, recorded with each manager phase. */
export function parityArtifactHash(art: ParityArtifact): string {
  return createHash("sha256").update(JSON.stringify(art.comparisons), "utf8").digest("hex");
}

/** Redact anything that looks like a JWT or claims JSON from text that may reach a report. */
export function redactSecrets(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted token]")
    .replace(/\{[^{}]*"(?:sub|session_id|email)"\s*:[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, "[redacted claims]");
}
