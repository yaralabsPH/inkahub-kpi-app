/**
 * Shared fabricated evidence for the staging gate tests: real-session claims
 * sources, the post-0036 policy catalog, claims-evidence rows and a passing
 * parity artifact. Test-only; no database.
 */
import {
  claimsSource,
  compareSnapshots,
  parityArtifactHash,
  policyHash,
  PRE_0036_SELECT_QUAL,
  READER_PROBES,
  type ClaimsSource,
  type ParityArtifact,
  type ParityRole,
  type ParitySnapshot,
  type PolicyRow,
} from "./itemCountingPolicyParity";
import { STAGING_ISSUER } from "./generate-query-evidence";
import { ENCODING_VERSION, HARNESS_VERSION, V2_FUNCTION, type GateIdentity } from "./itemCountingEvidence";
import {
  CASE_METHOD,
  CASE_SPECS,
  caseMemberships,
  compareCase,
  fixtureHash,
  PARITY_CASES,
  STANDARD_MEMBERSHIPS,
  type CaseCollection,
  type CaseSide,
  type ParityCase,
} from "./itemCountingParityCases";

const NOW = Math.floor(Date.now() / 1000);

export function sessionClaims(role: string): Record<string, unknown> {
  const sub = { owner: "1", manager: "2", staff: "3", kiosk: "4", cs: "5" }[role] ?? "9";
  const id = `${sub.repeat(8)}-${sub.repeat(4)}-4${sub.repeat(3)}-8${sub.repeat(3)}-${sub.repeat(12)}`;
  return {
    aud: "authenticated", exp: NOW + 3600, iat: NOW, iss: STAGING_ISSUER, sub: id, email: `${role}@inka-staging.test`, phone: "",
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: { email: `${role}@inka-staging.test`, email_verified: true, phone_verified: false, sub: id },
    role: "authenticated", aal: "aal1", amr: [{ method: "password", timestamp: NOW }],
    session_id: "5b1c2a3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", is_anonymous: false,
  };
}

export function claimsSources(): Record<string, ClaimsSource> {
  const out: Record<string, ClaimsSource> = {};
  for (const role of ["owner", "manager", "staff", "kiosk", "cs"]) {
    out[role] = claimsSource(role, JSON.stringify(sessionClaims(role)), { issuer: STAGING_ISSUER, nowSec: NOW });
  }
  return out;
}

/** The claims evidence row 03 returns for a role switch, matching its session. */
export function claimsRow(role: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const s = claimsSources()[role];
  return {
    claims_for: role, claims_bytes: s.bytes, claims_shape: s.shape, claims_db_role_ok: true, claims_aud_ok: true, claims_iss_ok: true,
    claims_unexpired: true, claims_subject_ok: true, legacy_overrides_empty: true, profile_role: role,
    memberships: role === "owner" ? "au,staging,uk,us" : "au,staging", ...over,
  };
}

const POST_READ = "((location = ANY (ARRAY( SELECT ul.location\n   FROM user_locations ul\n  WHERE (ul.user_id = ( SELECT auth.uid() AS uid))))) AND ((staff_id = ( SELECT auth.uid() AS uid)) OR ( SELECT is_manager_or_higher() AS is_manager_or_higher)))";
const POST_SELECT = "((location = ANY (ARRAY( SELECT ul.location\n   FROM user_locations ul\n  WHERE (ul.user_id = ( SELECT auth.uid() AS uid))))) AND ((staff_id = ( SELECT auth.uid() AS uid)) OR (( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['owner'::text, 'manager'::text, 'cs'::text, 'kiosk'::text]))))";

const pol = (policyname: string, cmd: string, qual: string | null, with_check: string | null = null): PolicyRow => ({
  schemaname: "public", tablename: "production_events", policyname, permissive: "PERMISSIVE", roles: ["public"], cmd, qual, with_check,
});
const writes = () => [
  pol("production_events_delete", "DELETE", "(can_access_location(location) AND is_manager_or_higher())"),
  pol("production_events_insert", "INSERT", null, "(can_access_location(location) AND ((staff_id = auth.uid()) OR is_kiosk_or_higher()))"),
  pol("production_events_update", "UPDATE", "(can_access_location(location) AND is_manager_or_higher())"),
];
export const prePolicies = () => [...writes(), pol("production_events_read", "SELECT", PRE_0036_SELECT_QUAL.production_events_read), pol("production_events_select", "SELECT", PRE_0036_SELECT_QUAL.production_events_select)];
export const postPolicies = () => [...writes(), pol("production_events_read", "SELECT", POST_READ), pol("production_events_select", "SELECT", POST_SELECT)];

/** 03's policy_catalog result rows for the post-0036 set. */
export const policyCatalogRows = (rows: PolicyRow[] = postPolicies()) =>
  rows.map((r) => ({ policy_catalog: "production_events", ...r, roles: `{${r.roles.join(",")}}` }));

/** The non-policy catalog fingerprints (helpers, RLS flags, grants, role configs, v1/v2, user_locations policies). */
export const CATALOG_OTHER: Record<string, string> = Object.freeze({
  helpers: "h", rls_flags: "production_events=true/false", table_grants: "g", role_configs: "c", evidence_functions: "f", user_locations_policies: "u",
}) as Record<string, string>;

function snap(mode: "before" | "after", arrangement: "standard" | "owner-kiosk-without-uk"): ParitySnapshot {
  const policies = mode === "before" ? prePolicies() : postPolicies();
  const roles: ParitySnapshot["roles"] = {};
  for (const role of ["owner", "manager", "staff", "kiosk", "cs", "no-subject"] as ParityRole[]) {
    const sites = role === "no-subject" ? [] : role === "owner" || role === "kiosk" ? (arrangement === "standard" ? ["au", "uk", "us"] : ["au", "us"]) : ["au"];
    const visible: Record<string, string[]> = {};
    for (const s of ["au", "uk", "us", "staging"]) visible[s] = sites.includes(s) ? [`${s}|1`] : [];
    const readers = Object.fromEntries(READER_PROBES.flatMap((pr) => ["au", "uk", "us", "staging"].map((st) => [`${pr}:${st}`, visible[st]])));
    roles[role] = { profileRole: role === "no-subject" ? null : role, memberships: [...sites, "staging"].join(","), claimsBytes: 630, visible, readers, errors: [] };
  }
  return { mode, arrangement, capturedAt: "t", revision: "r", catalog: { policies, policyHash: policyHash(policies).hash, other: { ...CATALOG_OTHER } }, fixture: { au: "1:x" }, roles };
}

/** The pre-M6 history only (two arrangements): must NOT certify parity any more. */
export function legacyParityArtifact(): ParityArtifact {
  return {
    snapshots: [snap("before", "standard")],
    comparisons: (["standard", "owner-kiosk-without-uk"] as const).map((a) => compareSnapshots(snap("before", a), snap("after", a), "t")),
  };
}

const SITES = ["au", "uk", "us", "staging"] as const;
export const subjectOf = (role: string) => String(sessionClaims(role).sub);

/** One case side whose row sets satisfy every coverage rule for that case. */
export function caseSide(kase: ParityCase, which: "before" | "after"): CaseSide {
  const policies = which === "before" ? prePolicies() : postPolicies();
  const want = caseMemberships(kase);
  const bytes = claimsSources();
  const roles: CaseSide["roles"] = {};
  for (const role of CASE_SPECS[kase].roles) {
    const member: string[] = role === "no-subject" ? [] : want[role as keyof typeof want];
    const visible: Record<string, string[]> = {};
    const foreign: Record<string, number> = {};
    for (const st of SITES) {
      const own = member.includes(st) ? [`${st}|${role}-1`] : [];
      const others = member.includes(st) && role !== "staff" ? [`${st}|other-1`] : [];
      visible[st] = [...own, ...others].sort();
      foreign[st] = others.length;
    }
    const readers = Object.fromEntries(READER_PROBES.flatMap((pr) => SITES.map((st) => [`${pr}:${st}`, visible[st].map((k) => JSON.stringify({ k }))])));
    roles[role] = {
      profileRole: role === "no-subject" ? null : role, memberships: member.join(","), claimsBytes: role === "no-subject" ? 60 : bytes[role].bytes, visible, readers, errors: [],
      subject: role === "no-subject" ? null : subjectOf(role), env: { user: "authenticated", rowSecurity: "on", timeoutMs: 8000, bypass: false }, foreign,
    };
  }
  return { policies, policyHash: policyHash(policies).hash, other: { ...CATALOG_OTHER }, roles, staffForeignRows: CASE_SPECS[kase].roles.includes("staff") ? 0 : null };
}

/** A passing four-case collection under the post-0036 policies. */
export function caseCollection(): CaseCollection {
  const fixture = { au: "5:a", staging: "2:s", uk: "5:b", us: "5:c" };
  const users = Object.fromEntries(["owner", "manager", "staff", "kiosk", "cs"].map((u) => [u, subjectOf(u)]));
  const standard = () => Object.fromEntries(Object.entries(STANDARD_MEMBERSHIPS).map(([k, v]) => [k, [...v]]));
  const coll: CaseCollection = {
    collectionId: "c1", capturedAt: "t", finishedAt: "t2", revision: "r", method: CASE_METHOD, cutoff: "2026-11-12T00:00:00.000Z",
    bounds: ["-infinity", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "infinity"],
    fixture, fixtureHash: fixtureHash(fixture), baselinePolicyHash: policyHash(prePolicies()).hash,
    baseline: { policyHash: policyHash(prePolicies()).hash, other: { ...CATALOG_OTHER }, revision: "r", capturedAt: "t" },
    installedPolicyHash: policyHash(postPolicies()).hash, installedOther: { ...CATALOG_OTHER },
    users, claimsBytes: Object.fromEntries(Object.entries(claimsSources()).map(([r, c]) => [r, c.bytes])),
    startMemberships: standard(),
    staffOtherWorkerRows: { au: 3, staging: 1 },
    cases: PARITY_CASES.map((k) => ({ case: k, collectionId: "c1", fixtureHash: fixtureHash(fixture), memberships: caseMemberships(k), before: caseSide(k, "before"), after: caseSide(k, "after") })),
    comparisons: [],
    restoration: { checkedAt: "t", passed: true, problems: [], memberships: standard(), catalog: { policyHash: policyHash(postPolicies()).hash, other: { ...CATALOG_OTHER } }, fixtureHash: fixtureHash(fixture) },
    problems: [],
  };
  coll.comparisons = coll.cases.map((e) => compareCase(coll, e));
  return coll;
}

/** A passing parity artifact under the post-0036 policies (four cases + baseline history). */
export function parityArtifact(): ParityArtifact {
  return { ...legacyParityArtifact(), cases: caseCollection() };
}

export const POST_POLICY_HASH = policyHash(postPolicies()).hash;

/** The gate identity matching fn md5 + these fixtures. */
export function gateIdentity(fnDefinitionMd5: string): GateIdentity {
  return {
    fnName: V2_FUNCTION, fnDefinitionMd5, encodingVersion: ENCODING_VERSION, harnessVersion: HARNESS_VERSION,
    policyHash: POST_POLICY_HASH, parityHash: parityArtifactHash(parityArtifact()),
  };
}
