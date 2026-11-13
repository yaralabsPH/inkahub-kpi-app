import { describe, expect, it } from "vitest";
import {
  checkClaimsEvidence,
  checkParityArtifact,
  checkPolicySet,
  claimsSource,
  compareSnapshots,
  jwtPayloadText,
  parityArtifactHash,
  policyHash,
  PRE_0036_SELECT_QUAL,
  READER_PROBES,
  redactSecrets,
  type ParityArtifact,
  type ParityRole,
  type ParitySnapshot,
  type PolicyRow,
} from "./itemCountingPolicyParity";
import { PARITY_CASES } from "./itemCountingParityCases";
import { parityArtifact, POST_POLICY_HASH } from "./gateTestFixtures";

const ISS = "https://ybrzhrgfrnvtcwymjdrq.supabase.co/auth/v1";
const NOW = 1_794_000_000;

// The post-0036 predicates exactly as pg prints them (checked on staging with pg_get_viewdef).
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
const prePolicies = () => [...writes(), pol("production_events_read", "SELECT", PRE_0036_SELECT_QUAL.production_events_read), pol("production_events_select", "SELECT", PRE_0036_SELECT_QUAL.production_events_select)];
const postPolicies = () => [...writes(), pol("production_events_read", "SELECT", POST_READ), pol("production_events_select", "SELECT", POST_SELECT)];

function session(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aud: "authenticated", exp: NOW + 3600, iat: NOW, iss: ISS, sub: "11111111-1111-4111-8111-111111111111",
    email: "owner@inka-staging.test", phone: "", app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: { email: "owner@inka-staging.test", email_verified: true, phone_verified: false, sub: "11111111-1111-4111-8111-111111111111" },
    role: "authenticated", aal: "aal1", amr: [{ method: "password", timestamp: NOW }],
    session_id: "5b1c2a3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", is_anonymous: false, ...over,
  };
}
const src = (over: Record<string, unknown> = {}) => claimsSource("owner", JSON.stringify(session(over)), { issuer: ISS, nowSec: NOW });

describe("policy hash and policy set", () => {
  it("hashes all policies canonically, independent of row and role order", () => {
    const a = policyHash(prePolicies());
    const shuffled = [...prePolicies()].reverse().map((r) => ({ ...r, roles: [...r.roles].reverse() }));
    expect(policyHash(shuffled).hash).toBe(a.hash);
    expect(policyHash(postPolicies()).hash).not.toBe(a.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    // NULL is preserved, not turned into "".
    const changed = prePolicies().map((r) => (r.policyname === "production_events_insert" ? { ...r, qual: "" } : r));
    expect(policyHash(changed).hash).not.toBe(a.hash);
  });

  it("accepts the recovered pre-0036 set and the reviewed post-0036 set", () => {
    expect(checkPolicySet(prePolicies(), "pre")).toEqual([]);
    expect(checkPolicySet(postPolicies(), "post")).toEqual([]);
    expect(checkPolicySet(postPolicies().map((r) => ({ ...r, qual: r.qual?.replace(/user_locations/, "public.user_locations") ?? null })), "post")).toEqual([]);
  });

  it("rejects missing, extra, restrictive, per-row or changed SELECT policies", () => {
    expect(checkPolicySet(postPolicies().slice(1), "post")[0]).toMatch(/policies are/);
    expect(checkPolicySet([...postPolicies(), pol("production_events_extra", "SELECT", "true")], "post")[0]).toMatch(/policies are/);
    const restrictive = postPolicies().map((r) => (r.policyname === "production_events_read" ? { ...r, permissive: "RESTRICTIVE" } : r));
    expect(checkPolicySet(restrictive, "post")).toContain("policy production_events_read is RESTRICTIVE, expected PERMISSIVE");
    const perRow = postPolicies().map((r) => (r.policyname === "production_events_select" ? { ...r, qual: PRE_0036_SELECT_QUAL.production_events_select } : r));
    expect(checkPolicySet(perRow, "post")).toContain("policy production_events_select still calls can_access_location per row");
    const bareUid = postPolicies().map((r) => (r.policyname === "production_events_read" ? { ...r, qual: r.qual!.replace("(staff_id = ( SELECT auth.uid() AS uid))", "(staff_id = auth.uid())") } : r));
    expect(checkPolicySet(bareUid, "post")).toContain("policy production_events_read calls auth.uid() per row");
    const lostRole = postPolicies().map((r) => (r.policyname === "production_events_select" ? { ...r, qual: r.qual!.replace(", 'kiosk'::text", "") } : r));
    expect(checkPolicySet(lostRole, "post").some((p) => p.includes("owner/manager/cs/kiosk"))).toBe(true);
    expect(checkPolicySet(postPolicies(), "pre").some((p) => p.includes("not the recovered pre-0036 predicate"))).toBe(true);
  });
});

describe("real-session claims", () => {
  it("accepts a real-shaped session and records only size and shape", () => {
    const s = src();
    expect(s.problems).toEqual([]);
    expect(s.bytes).toBeGreaterThan(500);
    expect(s.shape).toContain("app_metadata:object");
    expect(JSON.stringify(s)).not.toContain("owner@inka-staging.test");
  });

  it("rejects minimal, padded-minimal, incomplete or malformed claims", () => {
    const minimal = claimsSource("owner", JSON.stringify({ sub: "11111111-1111-4111-8111-111111111111", role: "authenticated" }), { issuer: ISS, nowSec: NOW });
    expect(minimal.problems.some((p) => p.includes("minimal claims are not allowed"))).toBe(true);
    const padded = claimsSource("owner", JSON.stringify({ sub: "11111111-1111-4111-8111-111111111111", role: "authenticated", pad: "x".repeat(700) }), { issuer: ISS, nowSec: NOW });
    expect(padded.problems).toContain("owner: claims lack session_id");
    expect(src({ amr: "password" }).problems).toContain("owner: claim amr is string, expected array");
    expect(src({ amr: [{ when: 1 }] }).problems).toContain("owner: claims amr is malformed");
    expect(src({ app_metadata: null }).problems).toContain("owner: claim app_metadata is null, expected object");
    expect(src({ iss: "https://lkboboagiikvozvbcpvg.supabase.co/auth/v1" }).problems).toContain("owner: claims issuer is not the staging project");
    expect(src({ role: "service_role" }).problems).toContain("owner: claims DB role is not authenticated");
    expect(src({ sub: "owner" }).problems).toContain("owner: claims subject is not a UUID");
    expect(src({ exp: NOW + 60 }).problems).toContain("owner: session expires too soon; sign in again");
    expect(claimsSource("owner", "not json", { issuer: ISS, nowSec: NOW }).problems).toContain("owner: claims are not JSON");
  });

  it("decodes a JWT payload exactly as sent", () => {
    const payload = JSON.stringify(session());
    const token = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(payload, "utf8").toString("base64url")}.sig`;
    expect(jwtPayloadText(token)).toBe(payload);
    expect(() => jwtPayloadText("nope")).toThrow(/not a JWT/);
  });

  it("checks SQL claims evidence against that role's session, without values", () => {
    const s = src();
    const ok = { claims_for: "owner", claims_bytes: s.bytes, claims_shape: s.shape, claims_db_role_ok: true, claims_aud_ok: true, claims_iss_ok: true, claims_unexpired: true, claims_subject_ok: true, legacy_overrides_empty: true };
    expect(checkClaimsEvidence(ok, s)).toEqual([]);
    expect(checkClaimsEvidence({ ...ok, claims_bytes: 74 }, s)[0]).toMatch(/SQL claims are 74 bytes but the session's are/);
    expect(checkClaimsEvidence({ ...ok, claims_subject_ok: false }, s)).toContain("owner: claims subject ok is not true");
    expect(checkClaimsEvidence({ ...ok, legacy_overrides_empty: false }, s)).toContain("owner: legacy overrides empty is not true");
    expect(checkClaimsEvidence(ok, undefined)).toEqual(["owner: no real session claims were supplied"]);
  });

  it("redacts tokens and claims JSON from report text", () => {
    const token = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(session())).toString("base64url")}.abcdefghijklmnop`;
    expect(redactSecrets(`error near ${token} here`)).toBe("error near [redacted token] here");
    expect(redactSecrets(`bad ${JSON.stringify(session())}`)).toBe("bad [redacted claims]");
  });
});

const SITE_ROWS: Record<string, string[]> = {
  au: ["au|a1", "au|a2", "au|a3"], uk: ["uk|u1", "uk|u2"], us: ["us|s1"], staging: ["staging|t1"],
};
function roleSnap(role: ParityRole, arrangement: "standard" | "owner-kiosk-without-uk") {
  const sites = role === "no-subject" ? [] : role === "owner" || role === "kiosk" ? (arrangement === "standard" ? ["au", "uk", "us"] : ["au", "us"]) : ["au"];
  const visible: Record<string, string[]> = {};
  for (const s of ["au", "uk", "us", "staging"]) visible[s] = sites.includes(s) ? [...SITE_ROWS[s]] : [];
  if (role === "staff") visible.au = ["au|a1"];
  const readers = Object.fromEntries(READER_PROBES.flatMap((pr) => ["au", "uk", "us", "staging"].map((st) => [`${pr}:${st}`, visible[st]])));
  return { profileRole: role === "no-subject" ? null : role, memberships: [...sites, "staging"].join(","), claimsBytes: 630, visible, readers, errors: [] };
}
function snap(mode: "before" | "after", arrangement: "standard" | "owner-kiosk-without-uk" = "standard"): ParitySnapshot {
  const policies = mode === "before" ? prePolicies() : postPolicies();
  const roles: ParitySnapshot["roles"] = {};
  for (const r of ["owner", "manager", "staff", "kiosk", "cs", "no-subject"] as const) roles[r] = roleSnap(r, arrangement);
  return {
    mode, arrangement, capturedAt: "t", revision: "r",
    catalog: { policies, policyHash: policyHash(policies).hash, other: { helpers: "h1", grants: "g1", v2: "f2" } },
    fixture: { au: "3:abc", uk: "2:def", us: "1:ghi", staging: "1:jkl" }, roles,
  };
}

describe("before/after parity", () => {
  it("passes identical row sets with only the two SELECT predicates changed", () => {
    expect(compareSnapshots(snap("before"), snap("after"), "now").problems).toEqual([]);
    expect(compareSnapshots(snap("before", "owner-kiosk-without-uk"), snap("after", "owner-kiosk-without-uk"), "now").problems).toEqual([]);
  });

  it("fails on the same count but different ids", () => {
    const a = snap("after");
    a.roles.manager!.visible.au = ["au|a1", "au|a2", "au|zz"];
    const p = compareSnapshots(snap("before"), a, "now").problems;
    expect(p).toContain("manager at au: 1 rows visible only before (e.g. au|a3), 1 only after (e.g. au|zz)");
  });

  it("fails when data, a write policy, a helper/grant or memberships changed", () => {
    const a = snap("after");
    a.fixture.au = "4:zzz";
    a.catalog.policies = a.catalog.policies.map((r) => (r.policyname === "production_events_update" ? { ...r, qual: "true" } : r));
    a.catalog.other.grants = "g2";
    a.roles.cs!.memberships = "au,uk,staging";
    const p = compareSnapshots(snap("before"), a, "now").problems;
    expect(p).toContain("saved event data changed between before and after (fixture fingerprint differs); parity is invalid");
    expect(p).toContain("policy production_events_update changed; only the two SELECT policies may change");
    expect(p).toContain("catalog item grants changed between before and after");
    expect(p.some((x) => x.includes("cs: memberships differ"))).toBe(true);
  });

  it("fails when a direct reader's replay differs or is missing", () => {
    const a = snap("after");
    a.roles.kiosk!.readers!["currently-clocked-in:au"] = ["au|a1", "au|zz"];
    delete a.roles.cs!.readers!["welcome-team:au"];
    const p = compareSnapshots(snap("before"), a, "now").problems;
    expect(p.some((x) => x.startsWith("kiosk reader currently-clocked-in:au:"))).toBe(true);
    expect(p).toContain("after/standard: cs reader welcome-team at au was not replayed");
  });

  it("fails on a missing role/site, a wrong arrangement, a leak without membership or a no-subject session seeing rows", () => {
    const a = snap("after");
    delete a.roles.kiosk;
    delete a.roles.owner!.visible.us;
    a.roles["no-subject"]!.visible.au = ["au|a1"];
    a.roles.manager!.visible.uk = ["uk|u1"];
    const p = compareSnapshots(snap("before"), a, "now").problems;
    expect(p).toContain("after/standard: role kiosk was not captured");
    expect(p).toContain("after/standard: owner at us was not read");
    expect(p).toContain("after/standard: a session with no subject saw 1 rows");
    expect(p).toContain("after/standard: manager saw 1 rows at uk without membership");
    const wrong = snap("before", "owner-kiosk-without-uk");
    wrong.roles.owner = roleSnap("owner", "standard");
    expect(compareSnapshots(wrong, snap("after", "owner-kiosk-without-uk"), "now").problems.some((x) => x.includes("owner is a member of au,uk,us, expected au,us"))).toBe(true);
  });

  it("the old two-arrangement history alone no longer certifies parity (review r1 M6)", () => {
    const post = snap("after").catalog.policyHash;
    const legacy: ParityArtifact = {
      snapshots: [snap("before")],
      comparisons: [compareSnapshots(snap("before"), snap("after"), "t1"), compareSnapshots(snap("before", "owner-kiosk-without-uk"), snap("after", "owner-kiosk-without-uk"), "t2")],
    };
    expect(legacy.comparisons.every((c) => c.problems.length === 0)).toBe(true);
    expect(checkParityArtifact(legacy, post)).toEqual(["four-case policy parity has not been run (run --policy-parity=cases)"]);
    expect(checkParityArtifact(null, post)[0]).toMatch(/has not been run/);
  });
});

describe("four-case in-transaction parity (review r1 M6)", () => {
  const post = POST_POLICY_HASH;

  it("passes all four cases with restoration, against the original pre-0036 baseline", () => {
    expect(checkParityArtifact(parityArtifact(), post)).toEqual([]);
    expect(PARITY_CASES).toEqual(["baseline", "manager-all-sites", "owner-denied-uk", "kiosk-denied-uk"]);
  });

  it("rejects a missing or duplicated case", () => {
    const art = parityArtifact();
    art.cases!.cases = art.cases!.cases.filter((c) => c.case !== "kiosk-denied-uk");
    expect(checkParityArtifact(art, post)).toContain("parity case kiosk-denied-uk is missing");
    const dup = parityArtifact();
    dup.cases!.cases.push(dup.cases!.cases[1]);
    expect(checkParityArtifact(dup, post)).toContain("parity case manager-all-sites is duplicated");
  });

  it("rejects the same count with different ids, and reader-result mismatches", () => {
    const art = parityArtifact();
    art.cases!.cases[0].after.roles.manager!.visible.au = ["au|other-1"];
    const r = parityArtifact();
    r.cases!.cases[0].after.roles.kiosk!.readers!["welcome-team:uk"] = ["uk|zz"];
    expect(checkParityArtifact(art, post).some((x) => x.includes("manager at au: 1 rows only under pre-0036"))).toBe(true);
    expect(checkParityArtifact(r, post).some((x) => x.includes("kiosk reader welcome-team:uk"))).toBe(true);
  });

  it("requires exact memberships including staging", () => {
    const art = parityArtifact();
    art.cases!.cases[0].memberships.manager = ["au"];
    expect(checkParityArtifact(art, post)).toContain("parity case baseline: baseline: manager memberships are au, expected au,staging");
    const start = parityArtifact();
    start.cases!.startMemberships.cs = ["au", "staging", "uk"];
    expect(checkParityArtifact(start, post).some((x) => x.startsWith("parity did not start from standard memberships (cs"))).toBe(true);
  });

  it("requires positive coverage and real denials", () => {
    const noUk = parityArtifact();
    noUk.cases!.cases[1].after.roles.manager!.visible.uk = [];
    noUk.cases!.cases[1].before.roles.manager!.visible.uk = [];
    expect(checkParityArtifact(noUk, post).some((x) => x.includes("manager saw no uk rows with uk membership"))).toBe(true);
    const leak = parityArtifact();
    leak.cases!.cases[2].after.roles.owner!.visible.uk = ["uk|x"];
    leak.cases!.cases[2].before.roles.owner!.visible.uk = ["uk|x"];
    expect(checkParityArtifact(leak, post).some((x) => x.includes("owner saw 1 uk rows without uk membership"))).toBe(true);
    const staff = parityArtifact();
    staff.cases!.cases[0].after.staffForeignRows = 2;
    expect(checkParityArtifact(staff, post).some((x) => x.includes("staff saw 2 rows saved by other workers"))).toBe(true);
    const proof = parityArtifact();
    proof.cases!.staffOtherWorkerRows = {};
    expect(checkParityArtifact(proof, post).some((x) => x.includes("exclusion is not proven"))).toBe(true);
  });

  it("rejects a mixed fixture/baseline, the wrong restored hash and different installed policies", () => {
    const fx = parityArtifact();
    fx.cases!.comparisons[2].fixtureHash = "other";
    expect(checkParityArtifact(fx, post)).toContain("parity case owner-denied-uk belongs to a different collection, fixture or baseline");
    const restored = parityArtifact();
    restored.cases!.baselinePolicyHash = "x".repeat(64);
    expect(checkParityArtifact(restored, post)).toContain("the restored pre-0036 hash is not the original pre-0036 baseline hash");
    expect(checkParityArtifact(parityArtifact(), "otherhash")).toContain("four-case parity was collected under different installed policies; run it again");
    const noBaseline = parityArtifact();
    noBaseline.snapshots = [];
    expect(checkParityArtifact(noBaseline, post)[0]).toMatch(/original pre-0036 baseline snapshot is missing/);
  });

  it("rejects a missing or failed restoration and a stored summary that disagrees with its evidence", () => {
    const none = parityArtifact();
    none.cases!.restoration = null;
    expect(checkParityArtifact(none, post)).toContain("the post-rollback restoration check is missing");
    const failed = parityArtifact();
    failed.cases!.restoration = { checkedAt: "t", passed: false, problems: ["owner lacks uk"] };
    expect(checkParityArtifact(failed, post)).toContain("the post-rollback restoration check failed: owner lacks uk");
    const lying = parityArtifact();
    lying.cases!.comparisons[0].counts["owner:au"] = 999;
    expect(checkParityArtifact(lying, post)).toContain("parity case baseline: the stored comparison does not match its evidence");
  });

  it("the phase identity hash covers the restoration result", () => {
    const a = parityArtifact();
    const b = parityArtifact();
    b.cases!.restoration = { checkedAt: "t2", passed: true, problems: [] };
    expect(parityArtifactHash(a)).not.toBe(parityArtifactHash(b));
  });
});
