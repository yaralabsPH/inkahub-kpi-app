/**
 * Four-case policy parity after staging 0036 (Task 4 M6 amendment).
 *
 * Pure checks for the `--policy-parity=cases` collection: one rolled-back
 * REPEATABLE READ transaction reads each case's identities under installed
 * 0036 and under the exact pre-0036 SELECT policies restored inside a nested
 * savepoint ("in-transaction policy restore"), then a fresh statement after
 * ROLLBACK confirms the standard memberships came back. Nothing here holds a
 * token or claim value.
 */
import { createHash } from "node:crypto";
import {
  checkPolicySet,
  PARITY_SITES,
  READER_PROBES,
  type ParityRole,
  type PolicyRow,
  type RoleSnapshot,
} from "./itemCountingPolicyParity";

export const PARITY_CASES = ["baseline", "manager-all-sites", "owner-denied-uk", "kiosk-denied-uk"] as const;
export type ParityCase = (typeof PARITY_CASES)[number];
export const CASE_METHOD = "in-transaction policy restore" as const;
export const CASE_USERS = ["owner", "manager", "staff", "kiosk", "cs"] as const;
export type CaseUser = (typeof CASE_USERS)[number];

/** Standard memberships, exactly, including the `staging` site. */
export const STANDARD_MEMBERSHIPS: Readonly<Record<CaseUser, readonly string[]>> = Object.freeze({
  owner: ["au", "staging", "uk", "us"],
  kiosk: ["au", "staging", "uk", "us"],
  manager: ["au", "staging"],
  staff: ["au", "staging"],
  cs: ["au", "staging"],
});

export interface CaseSpec {
  /** Identities read in this case. */
  roles: readonly ParityRole[];
  /** The single transaction-local membership change (none for the baseline). */
  change: { user: CaseUser; add: readonly string[]; remove: readonly string[] } | null;
}

export const CASE_SPECS: Readonly<Record<ParityCase, CaseSpec>> = Object.freeze({
  baseline: { roles: ["owner", "manager", "staff", "kiosk", "cs", "no-subject"], change: null },
  "manager-all-sites": { roles: ["manager"], change: { user: "manager", add: ["uk", "us"], remove: [] } },
  "owner-denied-uk": { roles: ["owner"], change: { user: "owner", add: [], remove: ["uk"] } },
  "kiosk-denied-uk": { roles: ["kiosk"], change: { user: "kiosk", add: [], remove: ["uk"] } },
});

/** Expected complete five-user arrangement for a case. */
export function caseMemberships(c: ParityCase): Record<CaseUser, string[]> {
  const out = Object.fromEntries(CASE_USERS.map((u) => [u, [...STANDARD_MEMBERSHIPS[u]]])) as Record<CaseUser, string[]>;
  const ch = CASE_SPECS[c].change;
  if (ch) out[ch.user] = [...new Set([...out[ch.user].filter((s) => !ch.remove.includes(s)), ...ch.add])].sort();
  return out;
}

export interface CaseSide {
  policies: PolicyRow[];
  policyHash: string;
  /** Other catalog fingerprints (helpers, grants, RLS flags, role configs, v1/v2, user_locations policies). */
  other: Record<string, string>;
  roles: Partial<Record<ParityRole, RoleSnapshot>>;
  /** Staff only: visible rows whose saved worker is not the staff user (must be 0). */
  staffForeignRows?: number | null;
}

export interface CaseEvidence {
  case: ParityCase;
  /** All five users' memberships as postgres inside the case. */
  memberships: Record<string, string[]>;
  before: CaseSide;
  after: CaseSide;
}

export interface CaseComparison {
  case: ParityCase;
  collectionId: string;
  fixtureHash: string;
  baselineRef: string;
  method: typeof CASE_METHOD;
  beforeHash: string;
  afterHash: string;
  problems: string[];
  counts: Record<string, number>;
}

export interface CaseCollection {
  collectionId: string;
  capturedAt: string;
  revision: string;
  method: typeof CASE_METHOD;
  cutoff: string;
  bounds: string[];
  /** Privileged per-site fingerprint: "count:md5". */
  fixture: Record<string, string>;
  fixtureHash: string;
  /** Pre-0036 policy hash the restore must reproduce (from the original before baseline). */
  baselinePolicyHash: string;
  /** Installed (post-0036) policy hash at collection. */
  installedPolicyHash: string;
  /** Memberships at the start (must be standard). */
  startMemberships: Record<string, string[]>;
  /** Privileged rows per site saved by someone other than the staff user. */
  staffOtherWorkerRows: Record<string, number>;
  cases: CaseEvidence[];
  comparisons: CaseComparison[];
  /** Fresh check after ROLLBACK. */
  restoration: { checkedAt: string; passed: boolean; problems: string[] } | null;
  /** Collection-level failures (errors, rollback problems). */
  problems: string[];
}

export function fixtureHash(fixture: Record<string, string>): string {
  const canonical = JSON.stringify(Object.keys(fixture).sort().map((k) => [k, fixture[k]]));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

const rowsAt = (fixture: Record<string, string>, site: string) => Number((fixture[site] ?? "0:").split(":")[0]) || 0;
const sameList = (a: readonly string[] | undefined, b: readonly string[]) => [...(a ?? [])].sort().join(",") === [...b].sort().join(",");

/** Problems with one side of one case on its own. */
export function checkCaseSide(coll: CaseCollection, ev: CaseEvidence, which: "before" | "after"): string[] {
  const out: string[] = [];
  const at = `${ev.case}/${which === "before" ? "restored pre-0036" : "installed 0036"}`;
  const side = ev[which];
  out.push(...checkPolicySet(side.policies, which === "before" ? "pre" : "post").map((p) => `${at}: ${p}`));
  const wantHash = which === "before" ? coll.baselinePolicyHash : coll.installedPolicyHash;
  if (side.policyHash !== wantHash) out.push(`${at}: policy hash ${side.policyHash.slice(0, 12)} is not the expected ${wantHash.slice(0, 12)}`);
  const want = caseMemberships(ev.case);
  for (const u of CASE_USERS) {
    if (!sameList(ev.memberships[u], want[u])) out.push(`${ev.case}: ${u} memberships are ${(ev.memberships[u] ?? []).join(",") || "none"}, expected ${want[u].join(",")}`);
  }
  const populated = (site: string) => rowsAt(coll.fixture, site) > 0;
  for (const role of CASE_SPECS[ev.case].roles) {
    const r = side.roles[role];
    if (!r) {
      out.push(`${at}: ${role} was not read`);
      continue;
    }
    for (const e of r.errors) out.push(`${at}: ${role}: ${e}`);
    for (const site of PARITY_SITES) if (!r.visible[site]) out.push(`${at}: ${role} at ${site} was not read`);
    for (const probe of READER_PROBES) for (const site of PARITY_SITES) if (!r.readers?.[`${probe}:${site}`]) out.push(`${at}: ${role} reader ${probe} at ${site} was not replayed`);
    const n = (site: string) => r.visible[site]?.length ?? 0;
    if (role === "no-subject") {
      for (const site of PARITY_SITES) if (n(site) !== 0) out.push(`${at}: the no-subject session saw ${n(site)} rows at ${site}`);
      continue;
    }
    if (r.profileRole !== role) out.push(`${at}: the ${role} test user has profile role ${r.profileRole ?? "none"}`);
    const member = want[role as CaseUser];
    if (!sameList(r.memberships.split(",").filter(Boolean), member)) out.push(`${at}: ${role} session memberships ${r.memberships || "none"} differ from ${member.join(",")}`);
    for (const site of PARITY_SITES) {
      if (!member.includes(site) && n(site) !== 0) out.push(`${at}: ${role} saw ${n(site)} rows at ${site} without membership`);
      // Positive coverage at every populated member site (the staging site has no saved events).
      if (member.includes(site) && populated(site) && n(site) === 0) out.push(`${at}: ${role} saw no rows at member site ${site}`);
    }
    if (role === "staff") {
      if (side.staffForeignRows !== 0) out.push(`${at}: staff saw ${side.staffForeignRows ?? "unknown"} rows saved by other workers`);
      const others = member.reduce((sum, site) => sum + (coll.staffOtherWorkerRows[site] ?? 0), 0);
      if (others === 0) out.push(`${at}: no other-worker rows at staff's sites, so exclusion is not proven`);
    }
  }
  if (ev.case === "manager-all-sites") {
    const m = side.roles.manager;
    for (const site of ["uk", "us"]) if ((m?.visible[site]?.length ?? 0) === 0) out.push(`${at}: manager saw no ${site} rows with ${site} membership`);
  }
  if (ev.case === "owner-denied-uk" || ev.case === "kiosk-denied-uk") {
    const who = ev.case === "owner-denied-uk" ? "owner" : "kiosk";
    const r = side.roles[who];
    if ((r?.visible.uk?.length ?? -1) !== 0) out.push(`${at}: ${who} saw ${r?.visible.uk?.length ?? "unread"} uk rows without uk membership`);
    if ((r?.visible.au?.length ?? 0) === 0) out.push(`${at}: ${who} saw no au rows`);
    if (!populated("uk")) out.push(`${at}: uk has no saved events, so the denial is not proven`);
  }
  return out;
}

function diffSorted(a: readonly string[], b: readonly string[]) {
  const sb = new Set(b);
  const sa = new Set(a);
  const onlyA = a.filter((x) => !sb.has(x));
  const onlyB = b.filter((x) => !sa.has(x));
  return { onlyA: onlyA.length, onlyB: onlyB.length, sampleA: onlyA.slice(0, 3), sampleB: onlyB.slice(0, 3) };
}

const SELECT_POLICIES = new Set(["production_events_read", "production_events_select"]);

/** Compare one case's restored pre-0036 side with its installed 0036 side. */
export function compareCase(coll: CaseCollection, ev: CaseEvidence): CaseComparison {
  const problems = [...checkCaseSide(coll, ev, "before"), ...checkCaseSide(coll, ev, "after")];
  const b = new Map(ev.before.policies.map((r) => [r.policyname, r]));
  const a = new Map(ev.after.policies.map((r) => [r.policyname, r]));
  for (const name of new Set([...b.keys(), ...a.keys()])) {
    if (!SELECT_POLICIES.has(name) && JSON.stringify(b.get(name)) !== JSON.stringify(a.get(name))) problems.push(`${ev.case}: policy ${name} differs between the two sides`);
  }
  for (const k of new Set([...Object.keys(ev.before.other), ...Object.keys(ev.after.other)])) {
    if (ev.before.other[k] !== ev.after.other[k]) problems.push(`${ev.case}: catalog item ${k} differs between the two sides`);
  }
  const counts: Record<string, number> = {};
  for (const role of CASE_SPECS[ev.case].roles) {
    const rb = ev.before.roles[role];
    const ra = ev.after.roles[role];
    if (!rb || !ra) continue;
    if (rb.memberships !== ra.memberships) problems.push(`${ev.case}: ${role} memberships differ between the two sides`);
    for (const site of PARITY_SITES) {
      const d = diffSorted(rb.visible[site] ?? [], ra.visible[site] ?? []);
      counts[`${role}:${site}`] = (ra.visible[site] ?? []).length;
      if (d.onlyA || d.onlyB) problems.push(`${ev.case}: ${role} at ${site}: ${d.onlyA} rows only under pre-0036 (e.g. ${d.sampleA.join(" ")}), ${d.onlyB} only under 0036 (e.g. ${d.sampleB.join(" ")})`);
    }
    for (const key of new Set([...Object.keys(rb.readers ?? {}), ...Object.keys(ra.readers ?? {})])) {
      const d = diffSorted(rb.readers?.[key] ?? [], ra.readers?.[key] ?? []);
      if (d.onlyA || d.onlyB) problems.push(`${ev.case}: ${role} reader ${key}: ${d.onlyA} ids only under pre-0036, ${d.onlyB} only under 0036`);
    }
  }
  return {
    case: ev.case,
    collectionId: coll.collectionId,
    fixtureHash: coll.fixtureHash,
    baselineRef: coll.baselinePolicyHash,
    method: CASE_METHOD,
    beforeHash: ev.before.policyHash,
    afterHash: ev.after.policyHash,
    problems,
    counts,
  };
}

/**
 * Is the four-case parity complete for the installed policies? Re-derives
 * every comparison from the stored evidence instead of trusting a summary.
 */
export function checkCaseCollection(coll: CaseCollection | null | undefined, currentPolicyHash: string | null, originalBaselineHash: string | null): string[] {
  if (!coll) return ["four-case policy parity has not been run (run --policy-parity=cases)"];
  const out: string[] = [...coll.problems];
  if (coll.method !== CASE_METHOD) out.push(`parity collection method is ${String(coll.method)}, expected ${CASE_METHOD}`);
  if (coll.fixtureHash !== fixtureHash(coll.fixture)) out.push("parity fixture hash does not match its fingerprint");
  if (!originalBaselineHash) out.push("the original pre-0036 baseline snapshot is missing; the restore has no authority to match");
  else if (coll.baselinePolicyHash !== originalBaselineHash) out.push("the restored pre-0036 hash is not the original pre-0036 baseline hash");
  if (!currentPolicyHash || coll.installedPolicyHash !== currentPolicyHash) out.push("four-case parity was collected under different installed policies; run it again");
  for (const u of CASE_USERS) {
    if (!sameList(coll.startMemberships[u], STANDARD_MEMBERSHIPS[u])) out.push(`parity did not start from standard memberships (${u}: ${(coll.startMemberships[u] ?? []).join(",") || "none"})`);
  }
  for (const c of PARITY_CASES) {
    const evs = coll.cases.filter((x) => x.case === c);
    const cmps = coll.comparisons.filter((x) => x.case === c);
    if (evs.length !== 1 || cmps.length !== 1) {
      out.push(`parity case ${c} is ${evs.length === 0 ? "missing" : "duplicated"}`);
      continue;
    }
    const fresh = compareCase(coll, evs[0]);
    for (const p of fresh.problems) out.push(`parity case ${c}: ${p}`);
    const stored = cmps[0];
    if (stored.collectionId !== coll.collectionId || stored.fixtureHash !== coll.fixtureHash || stored.baselineRef !== coll.baselinePolicyHash) out.push(`parity case ${c} belongs to a different collection, fixture or baseline`);
    if (stored.problems.length || JSON.stringify(stored.counts) !== JSON.stringify(fresh.counts)) out.push(`parity case ${c}: the stored comparison does not match its evidence`);
  }
  if (!coll.restoration) out.push("the post-rollback restoration check is missing");
  else if (!coll.restoration.passed) out.push(`the post-rollback restoration check failed: ${coll.restoration.problems[0] ?? "unknown"}`);
  return out;
}

/** Hash of the case evidence summary (comparisons + restoration + identity), recorded with each manager phase. */
export function caseCollectionHash(coll: CaseCollection): string {
  const body = {
    collectionId: coll.collectionId, method: coll.method, fixtureHash: coll.fixtureHash,
    baselinePolicyHash: coll.baselinePolicyHash, installedPolicyHash: coll.installedPolicyHash,
    comparisons: coll.comparisons, restoration: coll.restoration,
  };
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
}
