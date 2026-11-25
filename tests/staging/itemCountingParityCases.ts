/**
 * Four-case policy parity after staging 0036 (Task 4 M6 amendment).
 *
 * Pure checks for the `--policy-parity=cases` collection: one rolled-back
 * REPEATABLE READ transaction reads each case's identities under installed
 * 0036 and under the exact pre-0036 SELECT policies restored inside a nested
 * savepoint ("in-transaction policy restore"), then fresh statements after
 * ROLLBACK confirm memberships, catalog and fixture came back. The checker
 * re-derives everything from the stored evidence (row sets, reader rows,
 * catalog rows, read environment, identities) instead of trusting summaries.
 * Nothing here holds a token or claim value.
 */
import { createHash } from "node:crypto";
import {
  checkPolicySet,
  PARITY_SITES,
  policyHash,
  READER_PROBES,
  type ClaimsSource,
  type ParityRole,
  type PolicyRow,
  type RoleSnapshot,
} from "./itemCountingPolicyParity";

export const PARITY_CASES = ["baseline", "manager-all-sites", "owner-denied-uk", "kiosk-denied-uk"] as const;
export type ParityCase = (typeof PARITY_CASES)[number];
export const CASE_METHOD = "in-transaction policy restore" as const;
export const CASE_USERS = ["owner", "manager", "staff", "kiosk", "cs"] as const;
export type CaseUser = (typeof CASE_USERS)[number];
/** Fixed cutoff for every parity read (same as the performance gate). */
export const CASE_CUTOFF = "2026-11-12T00:00:00.000Z";
/** The authenticated role's catalog statement_timeout, in ms, required after every role switch. */
export const CASE_TIMEOUT_MS = 8000;

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

/** The original pre-0036 catalog the restore must reproduce and the invariants must keep. */
export interface BaselineCatalog {
  policyHash: string;
  /** Helpers, RLS flags, grants, role configs, v1/v2 definitions/ACLs, user_locations policies. */
  other: Record<string, string>;
  revision: string;
  capturedAt: string;
}

export interface CaseSide {
  policies: PolicyRow[];
  policyHash: string;
  /** Other catalog fingerprints (helpers, grants, RLS flags, role configs, v1/v2, user_locations policies). */
  other: Record<string, string>;
  roles: Partial<Record<ParityRole, RoleSnapshot>>;
  /** Staff only: visible rows whose saved worker is not the staff user (must be 0). Kept for the report. */
  staffForeignRows?: number | null;
}

export interface CaseEvidence {
  case: ParityCase;
  /** The collection and fixture this case was read in (cases cannot be mixed across collections). */
  collectionId?: string;
  fixtureHash?: string;
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

export interface CaseRestoration {
  checkedAt: string;
  passed: boolean;
  problems: string[];
  /** Fresh reads after ROLLBACK (absent when the check could not run). */
  memberships?: Record<string, string[]>;
  catalog?: { policyHash: string; other: Record<string, string> };
  fixtureHash?: string;
}

export interface CaseCollection {
  collectionId: string;
  capturedAt: string;
  /** Set when the collection finished (rolled back and restoration checked); absent while pending. */
  finishedAt?: string;
  revision: string;
  method: typeof CASE_METHOD;
  cutoff: string;
  bounds: string[];
  /** Privileged per-site fingerprint: "count:md5". */
  fixture: Record<string, string>;
  fixtureHash: string;
  /** Pre-0036 policy hash the restore must reproduce (from the original before baseline). */
  baselinePolicyHash: string;
  /** The original baseline catalog this collection was checked against. */
  baseline?: BaselineCatalog | null;
  /** Installed (post-0036) policy hash at collection. */
  installedPolicyHash: string;
  /** Installed catalog's other fingerprints at the start (must equal the baseline's). */
  installedOther?: Record<string, string>;
  /** Synthetic test-user ids (session subjects) per user. */
  users?: Record<string, string>;
  /** Signed-in session claims sizes per user (values are never kept). */
  claimsBytes?: Record<string, number>;
  /** Memberships at the start (must be standard). */
  startMemberships: Record<string, string[]>;
  /** Privileged rows per site saved by someone other than the staff user. */
  staffOtherWorkerRows: Record<string, number>;
  cases: CaseEvidence[];
  comparisons: CaseComparison[];
  /** Fresh check after ROLLBACK. */
  restoration: CaseRestoration | null;
  /** Collection-level failures (errors, rollback problems, cancellation, claims and final validation). */
  problems: string[];
}

export function fixtureHash(fixture: Record<string, string>): string {
  const canonical = JSON.stringify(Object.keys(fixture).sort().map((k) => [k, fixture[k]]));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Parse a PostgreSQL statement_timeout setting ("8s", "8000ms", "8000", "1min") into ms. */
export function timeoutMs(setting: string | null | undefined): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|min|h)?\s*$/.exec(String(setting ?? ""));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  return Math.round(n * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "min" ? 60_000 : 3_600_000));
}

const sameList = (a: readonly string[] | undefined, b: readonly string[]) => [...(a ?? [])].sort().join(",") === [...b].sort().join(",");
const sameRecord = (a: Record<string, string> | undefined, b: Record<string, string> | undefined) => JSON.stringify(sortKeys(a ?? {})) === JSON.stringify(sortKeys(b ?? {}));
function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}
function otherDiff(got: Record<string, string> | undefined, want: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(got ?? {}), ...Object.keys(want)]);
  return [...keys].sort().filter((k) => (got ?? {})[k] !== want[k]);
}

/** Problems with one side of one case on its own. */
export function checkCaseSide(coll: CaseCollection, ev: CaseEvidence, which: "before" | "after"): string[] {
  const out: string[] = [];
  const at = `${ev.case}/${which === "before" ? "restored pre-0036" : "installed 0036"}`;
  const side = ev[which];
  out.push(...checkPolicySet(side.policies, which === "before" ? "pre" : "post").map((p) => `${at}: ${p}`));
  const recomputed = policyHash(side.policies).hash;
  if (recomputed !== side.policyHash) out.push(`${at}: the stored policy hash does not match its catalog rows`);
  const wantHash = which === "before" ? coll.baselinePolicyHash : coll.installedPolicyHash;
  if (recomputed !== wantHash) out.push(`${at}: policy hash ${recomputed.slice(0, 12)} is not the expected ${wantHash.slice(0, 12)}`);
  if (coll.baseline) {
    const drift = otherDiff(side.other, coll.baseline.other);
    if (drift.length) out.push(`${at}: catalog ${drift.join(", ")} differ from the original pre-0036 baseline`);
  } else out.push(`${at}: no original baseline catalog to check helpers, grants, RLS flags and role settings against`);
  const want = caseMemberships(ev.case);
  for (const u of CASE_USERS) {
    if (!sameList(ev.memberships[u], want[u])) out.push(`${ev.case}: ${u} memberships are ${(ev.memberships[u] ?? []).join(",") || "none"}, expected ${want[u].join(",")}`);
  }
  for (const role of CASE_SPECS[ev.case].roles) {
    const r = side.roles[role];
    if (!r) {
      out.push(`${at}: ${role} was not read`);
      continue;
    }
    for (const e of r.errors) out.push(`${at}: ${role}: ${e}`);
    // Exact read environment after the role switch.
    const env = r.env;
    if (!env) out.push(`${at}: ${role} read environment was not recorded`);
    else {
      if (env.user !== "authenticated") out.push(`${at}: ${role} read as ${env.user}, not authenticated`);
      if (env.rowSecurity !== "on") out.push(`${at}: ${role} read with row_security ${env.rowSecurity}`);
      if (env.bypass !== false) out.push(`${at}: ${role} read without verified bypass-RLS off`);
      if (env.timeoutMs !== CASE_TIMEOUT_MS) out.push(`${at}: ${role} read with statement_timeout ${env.timeoutMs ?? "unknown"} ms, expected ${CASE_TIMEOUT_MS}`);
    }
    for (const site of PARITY_SITES) if (!r.visible[site]) out.push(`${at}: ${role} at ${site} was not read`);
    for (const probe of READER_PROBES) for (const site of PARITY_SITES) if (!r.readers?.[`${probe}:${site}`]) out.push(`${at}: ${role} reader ${probe} at ${site} was not replayed`);
    for (const site of PARITY_SITES) if (typeof r.foreign?.[site] !== "number") out.push(`${at}: ${role} other-worker rows at ${site} were not counted`);
    const n = (site: string) => r.visible[site]?.length ?? 0;
    const foreign = (site: string) => r.foreign?.[site] ?? 0;
    if (role === "no-subject") {
      if (r.subject !== null) out.push(`${at}: the no-subject session has a subject`);
      for (const site of PARITY_SITES) if (n(site) !== 0) out.push(`${at}: the no-subject session saw ${n(site)} rows at ${site}`);
      continue;
    }
    // Identity: the session's subject is the collection's synthetic test user, with the signed-in claims size.
    if (!coll.users?.[role] || r.subject !== coll.users[role]) out.push(`${at}: ${role} was not read as the collection's ${role} test user`);
    const bytes = coll.claimsBytes?.[role];
    if (!bytes || r.claimsBytes !== bytes) out.push(`${at}: ${role} SQL claims size ${r.claimsBytes ?? "unknown"} differs from the signed-in session's ${bytes ?? "unknown"}`);
    if (r.profileRole !== role) out.push(`${at}: the ${role} test user has profile role ${r.profileRole ?? "none"}`);
    const member = want[role as CaseUser];
    if (!sameList(r.memberships.split(",").filter(Boolean), member)) out.push(`${at}: ${role} session memberships ${r.memberships || "none"} differ from ${member.join(",")}`);
    for (const site of PARITY_SITES) {
      if (!member.includes(site) && n(site) !== 0) out.push(`${at}: ${role} saw ${n(site)} rows at ${site} without membership`);
      // Positive coverage at EVERY member site, including `staging`.
      if (member.includes(site) && n(site) === 0) out.push(`${at}: ${role} saw no rows at member site ${site}`);
    }
    if (role === "staff") {
      for (const site of PARITY_SITES) if (foreign(site) !== 0) out.push(`${at}: staff saw ${foreign(site)} rows saved by other workers at ${site}`);
      for (const site of member) {
        if ((coll.staffOtherWorkerRows[site] ?? 0) === 0) out.push(`${at}: no other-worker rows at ${site}, so staff's exclusion there is not proven`);
      }
    } else {
      // Self/other-worker probes: a site-wide role must see other workers' rows at each member site.
      for (const site of member) if (foreign(site) === 0) out.push(`${at}: ${role} saw no other workers' rows at member site ${site}`);
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
    if (Number((coll.fixture.uk ?? "0:").split(":")[0]) === 0) out.push(`${at}: uk has no saved events, so the denial is not proven`);
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
    if (rb.subject !== ra.subject) problems.push(`${ev.case}: ${role} was read as different subjects on the two sides`);
    for (const site of PARITY_SITES) {
      const d = diffSorted(rb.visible[site] ?? [], ra.visible[site] ?? []);
      counts[`${role}:${site}`] = (ra.visible[site] ?? []).length;
      if (d.onlyA || d.onlyB) problems.push(`${ev.case}: ${role} at ${site}: ${d.onlyA} rows only under pre-0036 (e.g. ${d.sampleA.join(" ")}), ${d.onlyB} only under 0036 (e.g. ${d.sampleB.join(" ")})`);
      if ((rb.foreign?.[site] ?? null) !== (ra.foreign?.[site] ?? null)) problems.push(`${ev.case}: ${role} other-worker rows at ${site} differ between the two sides`);
    }
    for (const key of new Set([...Object.keys(rb.readers ?? {}), ...Object.keys(ra.readers ?? {})])) {
      const xb = rb.readers?.[key] ?? [];
      const xa = ra.readers?.[key] ?? [];
      // Exact returned rows, fields and order (not just the id set).
      if (JSON.stringify(xb) !== JSON.stringify(xa)) {
        const d = diffSorted(xb, xa);
        problems.push(`${ev.case}: ${role} reader ${key}: ${d.onlyA} rows only under pre-0036, ${d.onlyB} only under 0036${d.onlyA || d.onlyB ? "" : " (same rows, different order)"}`);
      }
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

function boundsProblems(bounds: readonly string[]): string[] {
  if (bounds.length < 3) return ["parity month bounds are missing"];
  if (bounds[0] !== "-infinity" || bounds[bounds.length - 1] !== "infinity") return ["parity month bounds do not cover all history (open ends)"];
  const inner = bounds.slice(1, -1).map((b) => Date.parse(b));
  if (inner.some((t) => Number.isNaN(t)) || inner.some((t, i) => i > 0 && t <= inner[i - 1])) return ["parity month bounds are not increasing dates"];
  return [];
}

/**
 * Is the four-case parity complete for the installed policies? Re-derives
 * every comparison from the stored evidence instead of trusting a summary.
 */
export function checkCaseCollection(coll: CaseCollection | null | undefined, currentPolicyHash: string | null, original: BaselineCatalog | null): string[] {
  if (!coll) return ["four-case policy parity has not been run (run --policy-parity=cases)"];
  const out: string[] = [...coll.problems];
  if (!coll.finishedAt) out.push("the four-case collection did not finish");
  if (coll.method !== CASE_METHOD) out.push(`parity collection method is ${String(coll.method)}, expected ${CASE_METHOD}`);
  if (coll.cutoff !== CASE_CUTOFF) out.push(`parity cutoff is ${coll.cutoff || "missing"}, expected ${CASE_CUTOFF}`);
  out.push(...boundsProblems(coll.bounds ?? []));
  if (coll.fixtureHash !== fixtureHash(coll.fixture)) out.push("parity fixture hash does not match its fingerprint");
  if (!original) out.push("the original pre-0036 baseline snapshot is missing; the restore has no authority to match");
  else {
    if (coll.baselinePolicyHash !== original.policyHash) out.push("the restored pre-0036 hash is not the original pre-0036 baseline hash");
    if (!coll.baseline || coll.baseline.policyHash !== original.policyHash || !sameRecord(coll.baseline.other, original.other)) out.push("the collection was not checked against the original pre-0036 baseline catalog");
    const drift = otherDiff(coll.installedOther, original.other);
    if (drift.length) out.push(`installed catalog ${drift.join(", ")} differ from the original pre-0036 baseline`);
  }
  if (!currentPolicyHash || coll.installedPolicyHash !== currentPolicyHash) out.push("four-case parity was collected under different installed policies; run it again");
  for (const u of CASE_USERS) {
    if (!sameList(coll.startMemberships[u], STANDARD_MEMBERSHIPS[u])) out.push(`parity did not start from standard memberships (${u}: ${(coll.startMemberships[u] ?? []).join(",") || "none"})`);
    if (!coll.users?.[u]) out.push(`the ${u} test user's identity is not recorded`);
    if (!coll.claimsBytes?.[u]) out.push(`the ${u} session's claims evidence is not recorded`);
  }
  if (coll.users && new Set(CASE_USERS.map((u) => coll.users![u])).size !== CASE_USERS.length) out.push("the five test users are not distinct");
  for (const c of PARITY_CASES) {
    const evs = coll.cases.filter((x) => x.case === c);
    const cmps = coll.comparisons.filter((x) => x.case === c);
    if (evs.length !== 1 || cmps.length !== 1) {
      out.push(`parity case ${c} is ${evs.length === 0 ? "missing" : "duplicated"}`);
      continue;
    }
    if (evs[0].collectionId !== coll.collectionId || evs[0].fixtureHash !== coll.fixtureHash) out.push(`parity case ${c} evidence was read in a different collection or fixture`);
    const fresh = compareCase(coll, evs[0]);
    for (const p of fresh.problems) out.push(`parity case ${c}: ${p}`);
    const stored = cmps[0];
    if (stored.collectionId !== coll.collectionId || stored.fixtureHash !== coll.fixtureHash || stored.baselineRef !== coll.baselinePolicyHash) out.push(`parity case ${c} belongs to a different collection, fixture or baseline`);
    if (stored.problems.length || JSON.stringify(stored.counts) !== JSON.stringify(fresh.counts)) out.push(`parity case ${c}: the stored comparison does not match its evidence`);
  }
  const rest = coll.restoration;
  if (!rest) out.push("the post-rollback restoration check is missing");
  else if (!rest.passed) out.push(`the post-rollback restoration check failed: ${rest.problems[0] ?? "unknown"}`);
  else {
    if (rest.problems.length) out.push(`the post-rollback restoration check says passed but reports: ${rest.problems[0]}`);
    for (const u of CASE_USERS) if (!sameList(rest.memberships?.[u], STANDARD_MEMBERSHIPS[u])) out.push(`the restoration check did not record standard memberships for ${u}`);
    if (!rest.catalog || rest.catalog.policyHash !== coll.installedPolicyHash) out.push("the restoration check did not record the installed policies");
    else if (original && otherDiff(rest.catalog.other, original.other).length) out.push("the restoration check found catalog drift from the original pre-0036 baseline");
    if (rest.fixtureHash !== coll.fixtureHash) out.push("the restoration check did not record the same fixture");
  }
  return [...new Set(out)];
}

/** JSON with object keys sorted at every level (stable across runs and writers). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? sortKeys(v as Record<string, unknown>) : v));
}

/**
 * Hash of the COMPLETE acceptance evidence (every row set, reader row,
 * catalog, environment, identity, scope, problems and the restoration), so a
 * phase record identifies exactly the artifact it relied on.
 */
export function caseCollectionHash(coll: CaseCollection): string {
  return createHash("sha256").update(canonicalJson(coll), "utf8").digest("hex");
}

/**
 * `--policy-parity=cases` collects all four cases in one invocation; it must
 * not be combined with setup/seed/cleanup, performance/manager-phase flags or
 * a single-case/legacy arrangement selector. Returns the reasons to refuse.
 */
export function casesModeArgProblems(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (a === "--policy-parity=cases") continue;
    const flag = a.split("=")[0];
    if (flag === "--policy-parity") out.push(`${a} cannot be combined with --policy-parity=cases`);
    else if (flag === "--arrangement" || flag === "--parity-case") out.push(`${flag} selects a single/legacy arrangement; --policy-parity=cases collects all four cases`);
    else if (flag === "--measure-only" || flag === "--manager-phase") out.push(`${flag} is a performance flag; parity collection times nothing and records no phase`);
    else if (flag === "--write-compat") out.push("--write-compat is a separate rehearsal; run it on its own");
    else out.push(`${a} is not allowed with --policy-parity=cases (no setup, seeding or cleanup)`);
  }
  return out;
}

/** Everything that keeps a `--policy-parity=cases` collection from passing (the full artifact check). */
export function caseParityProblems(baseline: BaselineCatalog | null, coll: CaseCollection | null): string[] {
  if (!coll) return ["the four-case collection did not run"];
  return checkCaseCollection(coll, coll.installedPolicyHash || null, baseline);
}

const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");

/** The `--policy-parity=cases` report; ends with exactly one STATUS line. */
export function caseParityMarkdown(input: {
  coll: CaseCollection | null;
  problems: string[];
  lines: string[];
  claimsSources: Record<string, ClaimsSource>;
  revision: string;
  project: string;
  finishedAt: string;
  /** Unfinished (progress) report: always FAILED. */
  inProgress?: string;
}): { markdown: string; status: string } {
  const { coll } = input;
  const problems = input.inProgress ? [input.inProgress, ...input.problems] : input.problems;
  const status = problems.length ? `STATUS: FAILED – ${cell(problems[0])}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}` : "STATUS: COMPLETE";
  const table = coll
    ? [
        "| Case | Identities | Policies restored pre-0036 → installed 0036 | Rows seen (0036) | Result |",
        "|---|---|---|---|---|",
        ...PARITY_CASES.map((k) => {
          const cmp = coll.comparisons.find((x) => x.case === k);
          if (!cmp) return `| ${k} | ${CASE_SPECS[k].roles.join(", ")} | – | – | not collected |`;
          const rows = Object.entries(cmp.counts).filter(([, n]) => n > 0).map(([key, n]) => `${key} ${n.toLocaleString("en")}`).join("; ") || "none";
          return `| ${k} | ${CASE_SPECS[k].roles.join(", ")} | ${cmp.beforeHash.slice(0, 12)} → ${cmp.afterHash.slice(0, 12)} | ${rows} | ${cmp.problems.length ? `FAILED: ${cell(cmp.problems[0])}` : "identical"} |`;
        }),
        "",
        `- collection ${coll.collectionId} · fixture ${coll.fixtureHash || "not read"} · pre-0036 baseline ${coll.baselinePolicyHash || "missing"} · installed ${coll.installedPolicyHash || "not read"}`,
        `- evidence hash (recorded with manager phases): ${coll.finishedAt ? caseCollectionHash(coll) : "pending"}`,
        `- restoration: ${coll.restoration ? `${coll.restoration.passed ? "passed" : `FAILED (${cell(coll.restoration.problems[0] ?? "unknown")})`} at ${coll.restoration.checkedAt}` : "not checked"}`,
      ]
    : ["- No collection."];
  const markdown = [
    "# item-counting · four-case policy parity (0036, M6)",
    "",
    `- project: ${input.project} (staging) · code revision: ${input.revision} · ${input.inProgress ? `updated: ${input.finishedAt} (in progress)` : `finished: ${input.finishedAt}`}`,
    `- method: ${CASE_METHOD} — one REPEATABLE READ transaction that always ends in ROLLBACK; "before" is the exact pre-0036 SELECT policy text restored in a nested savepoint, not a historical capture`,
    "- every read is `authenticated` with RLS on, real-session claims and the catalog 8 s statement_timeout; claim values are never recorded",
    "", "## Cases", "", ...table,
    "", "## Log", "", ...input.lines.map((l) => `- ${l}`),
    "", "## Real-session claims (sizes only)", "", ...Object.entries(input.claimsSources).map(([r, c]) => `- ${r}: ${c.bytes} bytes`),
    "", "## Checks", "",
    ...(problems.length ? problems.map((p) => `- MISSING/WRONG: ${p}`) : ["- All four cases identical under restored pre-0036 and installed 0036, with positive coverage at every member site, real denials, exact reader rows and a passed fresh restoration check."]),
    "", status, "",
  ].join("\n");
  return { markdown, status };
}
