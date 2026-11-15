/**
 * Task 14: materialize affected audiences, order identities and timing.
 *
 * Offline: an in-memory frozen view (memoryFrozenReader) behaves like the
 * 0040 bounded read RPCs over the frozen batch view. The ORACLE is the shared
 * Task 11 projector run once over a site's COMPLETE history per audience,
 * mapped to owner rows; the materializer must reproduce every affected owner's
 * rows exactly from its bounded dependency input, and its enumeration must
 * include every owner/audience whose oracle rows changed.
 */
import { describe, expect, it } from "vitest";
import {
  affectedOwners,
  buildOwnerInput,
  diffFrozenViews,
  materializeBatch,
  materializePartition,
  MAX_PARTITION_EVENTS,
  memoryFrozenReader,
  ownerKey,
  ownerOfEvent,
  ownerRows,
  PartitionTooLargeError,
  rowsByOwner,
  type FrozenReader,
  type Owner,
} from "../../api/_lib/production-reporting-materialize";
import { buildChunks, resultRowProblem, RESULT_TABLES, type ResultRows } from "../../api/_lib/reporting-stage";
import { canonicalJson, REPORTING_RULE_VERSION, sha256Hex, type ReportingAudience } from "../../src/lib/domain/productionReporting";
import { projectReportingPartition } from "../../src/lib/domain/productionReportingProjection";
import type { ProductionEvidenceEvent } from "../../src/lib/domain/productionCounts";
import { reducerDaily } from "../staging/reportingPublication";
import { exactInstant } from "../../src/lib/domain/productionCounts";

const SITE = "uk";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FB = "INKA-KAN0566-A4-FB"; // eligible framed stream line
const CUT = "2026-11-15T12:00:00.000000Z";

type Ev = ProductionEvidenceEvent;
function ev(id: string, type: string, order: string | null, staff: string, at: string, o: Partial<Ev> = {}): Ev {
  return { id, location: SITE, staff_id: staff, department: "framed", order_number: order, line_sku: type === "line_verified" ? FB : null, line_quantity: type === "line_verified" ? 1 : null, event_type: type, created_at: at, parent_event_id: null, cs_case_id: null, ...o };
}
const verify = (id: string, order: string, staff: string, at: string, o: Partial<Ev> = {}) => ev(id, "line_verified", order, staff, at, o);
const cancel = (id: string, parent: string, order: string | null, staff: string, at: string, o: Partial<Ev> = {}) => ev(id, "cancelled", order, staff, at, { parent_event_id: parent, ...o });
const complete = (id: string, order: string, staff: string, at: string, o: Partial<Ev> = {}) => ev(id, "completed", order, staff, at, o);

const audiencesOf = (events: readonly Ev[]): ReportingAudience[] => [{ kind: "site" }, ...[...new Set(events.map((e) => e.staff_id).filter((s): s is string => !!s))].sort().map((staffId) => ({ kind: "self" as const, staffId }))];
const audKey = (a: ReportingAudience) => (a.kind === "site" ? "site" : `self:${a.staffId}`);

/** The oracle: one projection over the COMPLETE site history per audience, mapped to owner rows. */
function oracle(events: readonly Ev[], audience: ReportingAudience, cutoff = CUT): Map<string, ResultRows> {
  const r = projectReportingPartition({ site: SITE, audience, ruleVersion: REPORTING_RULE_VERSION, sourceCutoffUtc: cutoff, events });
  return new Map([...rowsByOwner(r).entries()].map(([k, v]) => [k, v.rows]));
}
const rowsJson = (r: ResultRows | undefined) => canonicalJson(r ?? { event_facts: [], cancel_edges: [], order_occurrences: [], timing_facts: [], source_issue_facts: [] });

/** Refresh: materialize the change from `before` to `after`, and check exact parity + enumeration completeness against the oracle. */
async function refreshParity(before: Ev[], after: Ev[], opts: { prevCutoff?: string; cutoff?: string; maxPage?: number } = {}) {
  const cutoff = opts.cutoff ?? CUT;
  const prevCutoff = opts.prevCutoff ?? cutoff;
  const reader = memoryFrozenReader({ site: SITE, cutoff, kind: "refresh", view: after, changed: diffFrozenViews(before, after, prevCutoff, cutoff), maxPage: opts.maxPage });
  const out = await materializeBatch(reader);
  const byWork = new Map(out.works.map((w) => [`${w.desc.audienceKind}|${w.desc.audienceStaff ?? ""}|${ownerKey({ partitionKind: w.desc.partitionKind, partitionKey: w.desc.partitionKey })}`, w]));
  const problems: string[] = [];
  for (const aud of audiencesOf([...before, ...after])) {
    const oldO = oracle(before, aud, prevCutoff);
    const newO = oracle(after, aud, cutoff);
    for (const k of new Set([...oldO.keys(), ...newO.keys()])) {
      if (rowsJson(oldO.get(k)) === rowsJson(newO.get(k))) continue;
      const w = byWork.get(`${aud.kind}|${aud.kind === "self" ? aud.staffId : ""}|${k}`);
      if (!w) problems.push(`MISSING ${audKey(aud)} ${k.replace("\u0000", ":")}`);
    }
  }
  for (const w of out.works) {
    const aud: ReportingAudience = w.desc.audienceKind === "site" ? { kind: "site" } : { kind: "self", staffId: w.desc.audienceStaff! };
    const want = oracle(after, aud, cutoff).get(ownerKey({ partitionKind: w.desc.partitionKind, partitionKey: w.desc.partitionKey }));
    if (rowsJson(w.rows) !== rowsJson(want)) problems.push(`ROWS ${audKey(aud)} ${w.desc.partitionKind}:${w.desc.partitionKey}`);
  }
  return { out, problems, works: byWork };
}
const work = (r: Awaited<ReturnType<typeof refreshParity>>, aud: string, owner: string) => r.works.get(`${aud}|${owner}`);
const O = (k: string): string => ownerKey({ partitionKind: "order", partitionKey: k });
const E = (id: string): string => ownerKey({ partitionKind: "event", partitionKey: id });

describe("Task 14: owner mapping and the self filter", () => {
  it("an event's owner is its trimmed nonblank order, else its event id (as SQL owner_partition)", () => {
    expect(ownerOfEvent(verify("v1", "  RP-1 　", A, "2026-01-01T10:00:00Z"))).toEqual({ partitionKind: "order", partitionKey: "RP-1" });
    expect(ownerOfEvent(cancel("c1", "v1", "  ", A, "2026-01-01T10:00:00Z"))).toEqual({ partitionKind: "event", partitionKey: "c1" });
    expect(ownerOfEvent(cancel("c2", "v1", null, A, "2026-01-01T10:00:00Z"))).toEqual({ partitionKind: "event", partitionKey: "c2" });
  });

  it("materializePartition filters a self audience's rows BEFORE projection (another worker's context never reaches it)", () => {
    const events = [verify("v1", "RP-1", A, "2026-01-01T10:00:00Z"), cancel("c1", "v1", null, B, "2026-01-01T10:05:00Z")];
    const input = { site: SITE, audience: { kind: "site" } as ReportingAudience, ruleVersion: REPORTING_RULE_VERSION, sourceCutoffUtc: CUT, events };
    const self = materializePartition(input, { kind: "self", staffId: A });
    expect(self.audience).toEqual({ kind: "self", staffId: A });
    expect(self.facts.map((f) => f.id)).toEqual(["v1"]);
    expect(self.facts[0].cancelledBy).toEqual([]); // B's cancellation is hidden from A
    const site = materializePartition(input, { kind: "site" });
    expect(site.facts.find((f) => f.id === "v1")!.cancelledBy).toEqual(["c1"]);
  });

  it("every owner row is valid staged input (resultRowProblem) and chunkable", () => {
    const events = [verify("v1", "RP-1", A, "2026-01-01T10:00:00Z"), verify("v2", "RP-1", A, "2026-01-01T10:05:00Z"), complete("t1", "RP-1", A, "2026-01-01T10:10:00Z"), cancel("c1", "v2", null, A, "2026-01-01T10:06:00Z")];
    const r = materializePartition({ site: SITE, audience: { kind: "site" }, ruleVersion: REPORTING_RULE_VERSION, sourceCutoffUtc: CUT, events }, { kind: "site" });
    for (const { rows } of rowsByOwner(r).values()) {
      for (const t of RESULT_TABLES) for (const row of rows[t]) expect(resultRowProblem(t, row), `${t}`).toBeNull();
      expect(buildChunks(rows).length).toBeGreaterThan(0);
    }
    expect(ownerRows(r, { partitionKind: "order", partitionKey: "RP-404" })).toEqual({ event_facts: [], cancel_edges: [], order_occurrences: [], timing_facts: [], source_issue_facts: [] });
  });
});

describe("Task 14: the plan's named regressions (exact oracle parity + complete enumeration)", () => {
  it("a late correction of a years-old verification repairs its ORIGINAL day/person, not the arrival day", async () => {
    const old = verify("v-old", "RP-OLD", A, "2023-03-01T10:00:00Z");
    const before = [old, verify("v-next", "RP-NEXT", A, "2023-03-01T10:20:00Z")];
    const after = [...before, cancel("c-late", "v-old", null, B, "2026-11-15T09:00:00Z")]; // arrives years later, blank order
    const r = await refreshParity(before, after);
    expect(r.problems).toEqual([]);
    const site = work(r, "site|", O("RP-OLD"))!;
    expect(site.rows.event_facts.find((f) => f.event_id === "v-old")).toMatchObject({ staff_id: A, production_date: "2023-03-01" });
    expect(site.rows.timing_facts.map((t) => t.event_id)).toEqual([]); // now cancelled: no timing observation
    // its stream successor (another order) is repaired too
    expect(work(r, "site|", O("RP-NEXT"))!.rows.timing_facts).toMatchObject([{ event_id: "v-next", prev_all_event_id: null }]);
    expect(work(r, "site|", E("c-late"))!.rows.cancel_edges).toMatchObject([{ cancel_event_id: "c-late", parent_event_id: "v-old", parent_role: "verification", pair: "valid" }]);
  });

  it("an event moving sites clears its old credit: empty replacements for the old owner's site AND old self audiences", async () => {
    const v = verify("v-move", "RP-M", A, "2026-11-15T08:00:00Z");
    const before = [v, complete("t-m", "RP-M2", B, "2026-11-15T08:10:00Z")];
    const after = [before[1]]; // v-move left this site (a tombstone here)
    const r = await refreshParity(before, after);
    expect(r.problems).toEqual([]);
    for (const aud of ["site|", `self|${A}`]) {
      const w = work(r, aud, O("RP-M"));
      expect(w, aud).toBeDefined();
      expect(rowsJson(w!.rows), aud).toBe(rowsJson(undefined)); // the old owner's rows are all closed
    }
  });

  it("a hidden worker cancellation stays hidden for the self audience", async () => {
    const before = [verify("v1", "RP-1", A, "2026-11-15T08:00:00Z"), verify("v2", "RP-2", A, "2026-11-15T08:10:00Z")];
    const after = [...before, cancel("cb", "v1", null, B, "2026-11-15T08:05:00Z")];
    const r = await refreshParity(before, after);
    expect(r.problems).toEqual([]);
    expect(work(r, "site|", O("RP-1"))!.rows.timing_facts).toEqual([]); // site: cancelled
    expect(work(r, "site|", O("RP-2"))!.rows.timing_facts).toMatchObject([{ event_id: "v2", prev_all_event_id: null }]);
    // self A: the cancellation is B's, so A's own view did not change (no work needed, or identical rows)
    const selfA1 = work(r, `self|${A}`, O("RP-1"));
    if (selfA1) expect(selfA1.rows.timing_facts).toMatchObject([{ event_id: "v1" }]);
    expect(work(r, `self|${B}`, E("cb"))!.rows.cancel_edges).toMatchObject([{ cancel_event_id: "cb", parent_role: null, pair: null }]); // B cannot see A's parent
  });

  it("a parent arriving later resolves ONLY authorized context", async () => {
    const c = cancel("c1", "p1", null, B, "2026-11-15T09:00:00Z");
    const before = [c];
    const after = [verify("p1", "RP-P", A, "2026-11-15T08:00:00Z"), c];
    const r = await refreshParity(before, after);
    expect(r.problems).toEqual([]);
    expect(work(r, "site|", E("c1"))!.rows.cancel_edges).toMatchObject([{ parent_event_id: "p1", parent_role: "verification", pair: "valid" }]);
    const selfB = work(r, `self|${B}`, E("c1"));
    if (selfB) expect(selfB.rows.cancel_edges).toMatchObject([{ parent_role: null }]); // B still cannot see A's parent
  });

  it("deleting a middle timing line updates its successor (in another order)", async () => {
    const before = [verify("l1", "RP-1", A, "2026-11-15T08:00:00Z"), verify("l2", "RP-2", A, "2026-11-15T08:10:00Z"), verify("l3", "RP-3", A, "2026-11-15T08:20:00Z")];
    const after = [before[0], before[2]];
    const r = await refreshParity(before, after);
    expect(r.problems).toEqual([]);
    expect(work(r, "site|", O("RP-3"))!.rows.timing_facts).toMatchObject([{ event_id: "l3", prev_all_event_id: "l1", prev_same_type_event_id: "l1" }]);
    expect(rowsJson(work(r, "site|", O("RP-2"))!.rows)).toBe(rowsJson(undefined));
  });

  it("rework (case) vs normal (null case) stay distinct identities and rows", async () => {
    const before = [verify("n1", "RP-1", A, "2026-11-15T08:00:00Z"), complete("tn", "RP-1", A, "2026-11-15T08:05:00Z")];
    const after = [...before, verify("r1", "RP-1", A, "2026-11-15T09:00:00Z", { cs_case_id: "CS-9" }), complete("tr", "RP-1", A, "2026-11-15T09:05:00Z", { cs_case_id: "CS-9" })];
    const r = await refreshParity(before, after);
    expect(r.problems).toEqual([]);
    const rows = work(r, "site|", O("RP-1"))!.rows;
    expect(rows.order_occurrences.map((o) => [o.terminal_event_id, o.case_id])).toEqual([["tn", null], ["tr", "CS-9"]]);
    expect(rows.event_facts.map((f) => [f.event_id, f.case_id])).toEqual([["n1", null], ["tn", null], ["r1", "CS-9"], ["tr", "CS-9"]]);
  });

  it("repeated materialization of the same frozen view gives identical descriptors, rows and chunk hashes (an identical staged replay is a no-op)", async () => {
    const before = [verify("v1", "RP-1", A, "2026-11-15T08:00:00Z")];
    const after = [...before, verify("v2", "RP-1", A, "2026-11-15T08:10:00Z"), cancel("c", "v1", null, B, "2026-11-15T08:20:00Z")];
    const mk = () => materializeBatch(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "refresh", view: after, changed: diffFrozenViews(before, after, CUT, CUT) }));
    const [x, y] = [await mk(), await mk()];
    const sig = (o: Awaited<ReturnType<typeof mk>>) => o.works.map((w) => [w.desc, buildChunks(w.rows).map((c) => c.chunkHash)]);
    expect(canonicalJson(sig(x))).toBe(canonicalJson(sig(y)));
  });

  it(`a ${MAX_PARTITION_EVENTS + 1}-row partition fails visibly (partition_too_large) and no work is returned`, async () => {
    const big: Ev[] = [];
    for (let i = 0; i <= MAX_PARTITION_EVENTS; i++) big.push(ev(`n${String(i).padStart(6, "0")}`, "note_added", "RP-BIG", A, "2026-11-15T08:00:00Z"));
    const reader = memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view: big, changed: [] });
    const err = await materializeBatch(reader).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PartitionTooLargeError);
    expect((err as PartitionTooLargeError).code).toBe("partition_too_large");
    expect((err as PartitionTooLargeError).owner).toEqual({ partitionKind: "order", partitionKey: "RP-BIG" });
    expect((err as PartitionTooLargeError).size).toBe(MAX_PARTITION_EVENTS + 1);
  });
});

describe("Task 14: dependency closure", () => {
  it("enumerates old/new owners, parents, inverse children, invalid-identity events, due future keys and timing successors", async () => {
    const before = [
      verify("v1", "RP-1", A, "2026-11-15T08:00:00Z"),
      verify("v2", "RP-2", A, "2026-11-15T08:10:00Z"),
      cancel("cx", "v1", null, B, "2026-11-15T08:30:00Z"),
      verify("fut", "RP-F", A, "2026-11-15T11:30:00Z"),
      ev(" ", "line_verified", "RP-W", C, "2026-11-15T08:40:00Z"),
    ];
    // v1 moves orders; a future line becomes due (the cutoff advanced); the whitespace-id row changes.
    const after = [{ ...before[0], order_number: "RP-1B" }, before[1], before[2], before[3], { ...before[4], line_quantity: 2 }];
    const r = await refreshParity(before, after, { prevCutoff: "2026-11-15T11:00:00Z", cutoff: CUT });
    expect(r.problems).toEqual([]);
    const reader = memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "refresh", view: after, changed: diffFrozenViews(before, after, "2026-11-15T11:00:00Z", CUT) });
    const a = await affectedOwners(reader);
    const keys = a.owners.map(ownerKey);
    for (const k of [O("RP-1"), O("RP-1B"), E("cx"), O("RP-2"), O("RP-F"), O("RP-W")]) expect(keys, k.replace("\u0000", ":")).toContain(k);
  });

  it("a member's input includes parents, inverse children, the stream predecessor walk and the candidates' own children", async () => {
    const events = [
      verify("p0", "RP-0", A, "2026-11-15T07:00:00Z"), // effective predecessor
      verify("p1", "RP-9", A, "2026-11-15T07:30:00Z"), // cancelled candidate (skipped by the walk)
      cancel("c-p1", "p1", null, B, "2026-11-15T07:40:00Z"),
      verify("v", "RP-1", A, "2026-11-15T08:00:00Z"),
      cancel("c-v", "v", null, B, "2026-11-15T08:01:00Z"),
      cancel("c-own", "x-parent", "RP-1", A, "2026-11-15T08:02:00Z"),
      verify("x-parent", "RP-1", A, "2026-11-15T07:59:00Z"),
      verify("unrelated", "RP-Z", B, "2026-11-15T07:50:00Z"),
    ];
    const reader = memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view: events, changed: [] });
    const input = await buildOwnerInput(reader, { partitionKind: "order", partitionKey: "RP-1" });
    expect(input.events.map((e) => e.id).sort()).toEqual(["c-own", "c-p1", "c-v", "p0", "p1", "v", "x-parent"]);
    expect(input.members.map((e) => e.id).sort()).toEqual(["c-own", "v", "x-parent"]);
  });

  it("rebuild enumerates every owner and every recorded staff audience, with exact parity", async () => {
    const events = [
      verify("v1", "RP-1", A, "2026-11-15T08:00:00Z"), complete("t1", "RP-1", A, "2026-11-15T08:05:00Z"),
      verify("v2", "RP-2", B, "2026-11-15T08:10:00Z"), cancel("c2", "v2", null, C, "2026-11-15T08:20:00Z"),
      ev("  ", "completed", null, C, "2026-11-15T08:30:00Z"),
    ];
    const out = await materializeBatch(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view: events, changed: [] }));
    const got = new Set(out.works.map((w) => `${w.desc.audienceKind}|${w.desc.audienceStaff ?? ""}|${ownerKey(w.desc)}`));
    for (const aud of audiencesOf(events)) {
      for (const [k, rows] of oracle(events, aud)) {
        const key = `${aud.kind}|${aud.kind === "self" ? aud.staffId : ""}|${k}`;
        expect(got.has(key), key).toBe(true);
        expect(rowsJson(out.works.find((w) => `${w.desc.audienceKind}|${w.desc.audienceStaff ?? ""}|${ownerKey(w.desc)}` === key)!.rows)).toBe(rowsJson(rows));
      }
    }
    expect(out.stats.owners).toBe(new Set(events.map((e) => ownerKey(ownerOfEvent(e)))).size);
  });

  it("descriptor input hash = SHA-256 of the canonical FrozenPartitionInput (site, audience, rule, cutoff, rows sorted by exact identity; self rows filtered)", async () => {
    const events = [verify("v1", "RP-1", A, "2026-11-15T08:00:00Z"), cancel("c1", "v1", "RP-1", B, "2026-11-15T08:10:00Z")];
    const out = await materializeBatch(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view: events, changed: [] }));
    const self = out.works.find((w) => w.desc.audienceKind === "self" && w.desc.audienceStaff === A)!;
    expect(self.desc.inputHash).toBe(sha256Hex(canonicalJson({ site: SITE, audience: { kind: "self", staffId: A }, ruleVersion: REPORTING_RULE_VERSION, sourceCutoffUtc: CUT, events: [events[0]] })));
    const site = out.works.find((w) => w.desc.audienceKind === "site")!;
    expect(site.desc.inputHash).toBe(sha256Hex(canonicalJson({ site: SITE, audience: { kind: "site" }, ruleVersion: REPORTING_RULE_VERSION, sourceCutoffUtc: CUT, events: [events[1], events[0]] })));
  });
});

describe("Task 14: exact stream walks (one-row pages, so nothing is over-read by a whole page)", () => {
  it("a SAME-TYPE predecessor beyond an effective other-type line is still found", async () => {
    const before = [verify("f0", "RP-0", A, "2026-11-15T07:00:00Z"), verify("u1", "RP-U", A, "2026-11-15T07:30:00Z", { department: "unframed", line_sku: "INKA-KAN0566-A4-UN" })];
    const after = [...before, verify("v", "RP-1", A, "2026-11-15T08:00:00Z")];
    const r = await refreshParity(before, after, { maxPage: 1 });
    expect(r.problems).toEqual([]);
    expect(work(r, "site|", O("RP-1"))!.rows.timing_facts).toMatchObject([{ event_id: "v", prev_all_event_id: "u1", prev_same_type_event_id: "f0" }]);
  });

  it("a cancelled nearest candidate is skipped; the walk stops below the EARLIEST member, not at it", async () => {
    const before = [verify("p0", "RP-0", A, "2026-11-15T07:00:00Z"), verify("p1", "RP-9", A, "2026-11-15T07:30:00Z"), cancel("c-p1", "p1", null, B, "2026-11-15T07:40:00Z")];
    const after = [...before, verify("v1", "RP-1", A, "2026-11-15T08:00:00Z"), verify("v2", "RP-1", A, "2026-11-15T08:10:00Z")];
    const r = await refreshParity(before, after, { maxPage: 1 });
    expect(r.problems).toEqual([]);
    expect(work(r, "site|", O("RP-1"))!.rows.timing_facts).toMatchObject([{ event_id: "v1", prev_all_event_id: "p0" }, { event_id: "v2", prev_all_event_id: "v1" }]);
  });

  it("a deleted line's SAME-TYPE successor beyond an effective other-type line is re-materialized", async () => {
    const before = [verify("x", "RP-X", A, "2026-11-15T07:00:00Z"), verify("u", "RP-U", A, "2026-11-15T07:30:00Z", { department: "unframed", line_sku: "INKA-KAN0566-A4-UN" }), verify("f", "RP-F", A, "2026-11-15T08:00:00Z")];
    const after = before.slice(1);
    const r = await refreshParity(before, after, { maxPage: 1 });
    expect(r.problems).toEqual([]);
    expect(work(r, "site|", O("RP-F"))!.rows.timing_facts).toMatchObject([{ event_id: "f", prev_all_event_id: "u", prev_same_type_event_id: null }]);
  });

  it("ties at the boundary instant are read whole (projector order decides, not page order)", async () => {
    const at = "2026-11-15T07:00:00.000001Z";
    const before = [verify("t-b", "RP-0", A, at), verify("t-a", "RP-9", A, at)];
    const after = [...before, verify("v", "RP-1", A, "2026-11-15T08:00:00Z")];
    const r = await refreshParity(before, after, { maxPage: 1 });
    expect(r.problems).toEqual([]);
    expect(work(r, "site|", O("RP-1"))!.rows.timing_facts).toMatchObject([{ event_id: "v", prev_all_event_id: "t-b" }]);
  });
});

describe("Task 14: exact input sets", () => {
  it("the predecessor walk consumes nothing beyond its stop (an older event is NOT in the input)", async () => {
    const events = [
      verify("p-old", "RP-8", A, "2026-11-15T06:00:00Z"), // beyond the effective predecessor: must stay out
      verify("p0", "RP-0", A, "2026-11-15T07:00:00Z"),
      verify("v", "RP-1", A, "2026-11-15T08:00:00Z"),
    ];
    for (const maxPage of [1, 2, 200]) {
      const reader = memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view: events, changed: [], maxPage });
      const input = await buildOwnerInput(reader, { partitionKind: "order", partitionKey: "RP-1" });
      expect(input.events.map((e) => e.id), `maxPage ${maxPage}`).toEqual(["p0", "v"]);
    }
  });

  it("a tie at the stop instant is read whole: bytewise (SQL) and UTF-16 (projector) order differ for non-BMP ids", async () => {
    const at = "2026-11-15T07:00:00.000001Z";
    // UTF-8 bytes: "\u{1F600}" (F0..) > "�" (EF..); UTF-16: "\u{1F600}" (D83D..) < "�". The projector's latest is "�".
    const before = [verify("\u{1F600}", "RP-0", A, at), verify("�", "RP-9", A, at)];
    const after = [...before, verify("v", "RP-1", A, "2026-11-15T08:00:00Z")];
    for (const maxPage of [1, 200]) {
      const r = await refreshParity(before, after, { maxPage });
      expect(r.problems, `maxPage ${maxPage}`).toEqual([]);
      expect(work(r, "site|", O("RP-1"))!.rows.timing_facts).toMatchObject([{ event_id: "v", prev_all_event_id: "�" }]);
    }
  });
});

describe("Task 14: daily-group mapping parity (the five arrays carry exactly what the SQL daily recompute needs)", () => {
  /** What 0038's daily recompute derives from staged facts + valid edges: effective verification lines and counted Items per day/person/work type/rework. */
  function dailyFromRows(rows: ResultRows[]): string[] {
    const facts = rows.flatMap((r) => r.event_facts);
    const edges = rows.flatMap((r) => r.cancel_edges);
    const created = new Map(facts.map((f) => [String(f.event_id), String(f.created_at)]));
    const micros = (t: string) => exactInstant(t) as bigint;
    const cancelled = new Set(edges.filter((e) => !e.is_self && e.pair === "valid" && e.parent_role === "verification" && created.has(String(e.cancel_event_id)) && micros(String(e.parent_created_at)) <= micros(created.get(String(e.cancel_event_id))!)).map((e) => String(e.parent_event_id)));
    const g = new Map<string, { items: number; lines: number }>();
    for (const f of facts) {
      if (f.role !== "verification" || cancelled.has(String(f.event_id))) continue;
      const k = [f.production_date, f.staff_id, f.work_type, f.case_id !== null].join("|");
      const x = g.get(k) ?? { items: 0, lines: 0 };
      x.lines++;
      if (f.item_status === "counted") x.items += Number(f.items);
      g.set(k, x);
    }
    return [...g.entries()].map(([k, x]) => `${k}|${x.items}|${x.lines}`).sort();
  }
  it("rebuild rows give the reducer's daily groups for the site and every self audience, across a 04:00 boundary and cancellations", async () => {
    const events: Ev[] = [
      verify("a1", "RP-1", A, "2026-11-15T02:59:00Z"), // UK 02:59 (GMT): before 04:00 -> previous production day
      verify("a2", "RP-1", A, "2026-11-15T04:01:00Z"),
      verify("b1", "RP-2", B, "2026-11-15T05:00:00Z", { cs_case_id: "CS-7" }),
      cancel("ca", "a2", null, B, "2026-11-15T05:30:00Z"), // B cancels A's line: site loses it, A's self view keeps it
      verify("a3", "RP-3", A, "2026-11-15T06:00:00Z", { line_quantity: 3 }),
      cancel("cs", "a3", "RP-3", A, "2026-11-15T05:00:00Z"), // earlier than its parent: not a valid cancellation of it
    ];
    const out = await materializeBatch(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view: events, changed: [] }));
    for (const staff of [null, A, B]) {
      const rows = out.works.filter((w) => (staff === null ? w.desc.audienceKind === "site" : w.desc.audienceStaff === staff)).map((w) => w.rows);
      expect(dailyFromRows(rows), String(staff)).toEqual(reducerDaily(SITE, events, CUT, staff));
    }
    expect(reducerDaily(SITE, events, CUT, null)).toContain(`2026-11-14|${A}|framed|false|1|1`);
  });
});

// ---------------------------------------------------------------------------
// T14R1: successor closure — only a line strictly AFTER the anchor (projector order) may stop the walk
// ---------------------------------------------------------------------------

describe("T14R1: the successor closure is complete", () => {
  const UN = { department: "unframed", line_sku: "INKA-KAN0566-A4-UN" } as const;
  const cases: Array<[string, Ev[], Ev[]]> = [
    ["an isolated middle insertion", [verify("prev", "RP-P", A, "2026-11-15T08:00:00Z"), verify("next", "RP-N", A, "2026-11-15T08:20:00Z")],
      [verify("prev", "RP-P", A, "2026-11-15T08:00:00Z"), verify("new", "RP-X", A, "2026-11-15T08:10:00Z"), verify("next", "RP-N", A, "2026-11-15T08:20:00Z")]],
    ["a removed cancellation of the middle line", [verify("prev", "RP-P", A, "2026-11-15T08:00:00Z"), verify("mid", "RP-M", A, "2026-11-15T08:10:00Z"), cancel("cx", "mid", null, B, "2026-11-15T08:15:00Z"), verify("next", "RP-N", A, "2026-11-15T08:20:00Z")],
      [verify("prev", "RP-P", A, "2026-11-15T08:00:00Z"), verify("mid", "RP-M", A, "2026-11-15T08:10:00Z"), verify("next", "RP-N", A, "2026-11-15T08:20:00Z")]],
    ["a middle line reassigned A -> B (B's later successor)", [verify("prev", "RP-P", A, "2026-11-15T08:00:00Z"), verify("mid", "RP-M", A, "2026-11-15T08:10:00Z"), verify("bnext", "RP-B", B, "2026-11-15T08:20:00Z"), verify("anext", "RP-A", A, "2026-11-15T08:30:00Z")],
      [verify("prev", "RP-P", A, "2026-11-15T08:00:00Z"), verify("mid", "RP-M", B, "2026-11-15T08:10:00Z"), verify("bnext", "RP-B", B, "2026-11-15T08:20:00Z"), verify("anext", "RP-A", A, "2026-11-15T08:30:00Z")]],
    ["a timestamp move past the next line", [verify("prev", "RP-P", A, "2026-11-15T08:00:00Z"), verify("mid", "RP-M", A, "2026-11-15T08:10:00Z"), verify("next", "RP-N", A, "2026-11-15T08:20:00Z"), verify("last", "RP-L", A, "2026-11-15T08:40:00Z")],
      [verify("prev", "RP-P", A, "2026-11-15T08:00:00Z"), verify("mid", "RP-M", A, "2026-11-15T08:30:00Z"), verify("next", "RP-N", A, "2026-11-15T08:20:00Z"), verify("last", "RP-L", A, "2026-11-15T08:40:00Z")]],
    ["a same-instant ASCII tie after the anchor", [verify("b", "RP-B", A, "2026-11-15T08:10:00.000001Z"), verify("next", "RP-N", A, "2026-11-15T08:20:00Z")],
      [verify("a", "RP-A", A, "2026-11-15T08:10:00.000001Z"), verify("b", "RP-B", A, "2026-11-15T08:10:00.000001Z"), verify("next", "RP-N", A, "2026-11-15T08:20:00Z")]],
    ["a same-instant non-BMP tie (bytewise after, UTF-16 before the anchor)", [verify("\u{1F600}", "RP-E", A, "2026-11-15T08:10:00.000001Z"), verify("next", "RP-N", A, "2026-11-15T08:20:00Z")],
      [verify("\u{1F600}", "RP-E", A, "2026-11-15T08:10:00.000001Z"), verify("�", "RP-F", A, "2026-11-15T08:10:00.000001Z"), verify("next", "RP-N", A, "2026-11-15T08:20:00Z")]],
    ["a same-type successor behind an inserted other-type line", [verify("f0", "RP-0", A, "2026-11-15T08:00:00Z"), verify("f2", "RP-2", A, "2026-11-15T08:30:00Z")],
      [verify("f0", "RP-0", A, "2026-11-15T08:00:00Z"), verify("u1", "RP-1", A, "2026-11-15T08:10:00Z", UN), verify("f2", "RP-2", A, "2026-11-15T08:30:00Z")]],
  ];
  for (const [name, before, after] of cases) {
    it(`${name}: complete enumeration and exact site/self parity at page caps 1, 2 and 200`, async () => {
      const hashes = new Set<string>();
      for (const maxPage of [1, 2, 200]) {
        const r = await refreshParity(before, after, { maxPage });
        expect(r.problems, `maxPage ${maxPage}`).toEqual([]);
        hashes.add(canonicalJson(r.out.works.map((w) => w.desc)));
      }
      expect(hashes.size).toBe(1); // page-size independent
    });
  }
});

// ---------------------------------------------------------------------------
// T14R2: member boundaries in the projector's order (UTF-16), transport stays bytewise
// ---------------------------------------------------------------------------

describe("T14R2: member boundaries use the projector's order", () => {
  it("members U+1F600 and U+FFFD at the same instant: the earliest is U+1F600; both predecessor kinds are found below it", async () => {
    const events = [
      verify("pf", "RP-0", A, "2026-11-15T07:40:00Z"), // same-type (framed) predecessor
      verify("pu", "RP-U", A, "2026-11-15T08:00:00Z", { department: "unframed", line_sku: "INKA-KAN0566-A4-UN" }), // any-type predecessor
      verify("\u{1F600}", "RP-1", A, "2026-11-15T08:10:00.000001Z"),
      verify("�", "RP-1", A, "2026-11-15T08:10:00.000001Z"),
    ];
    const sigs = new Set<string>();
    for (const maxPage of [1, 2, 200]) {
      const out = await materializeBatch(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view: events, changed: [], maxPage }));
      for (const aud of audiencesOf(events)) {
        for (const [k, rows] of oracle(events, aud)) {
          const w = out.works.find((x) => `${x.desc.audienceKind}|${x.desc.audienceStaff ?? ""}|${ownerKey(x.desc)}` === `${aud.kind}|${aud.kind === "self" ? aud.staffId : ""}|${k}`);
          expect(rowsJson(w?.rows), `${audKey(aud)} ${k} maxPage ${maxPage}`).toBe(rowsJson(rows));
        }
      }
      const rp1 = out.works.find((w) => w.desc.audienceKind === "site" && w.desc.partitionKey === "RP-1")!;
      expect(rp1.rows.timing_facts).toMatchObject([
        { event_id: "\u{1F600}", prev_all_event_id: "pu", prev_same_type_event_id: "pf" },
        { event_id: "�", prev_all_event_id: "\u{1F600}", prev_same_type_event_id: "\u{1F600}" },
      ]);
      sigs.add(canonicalJson(out.works.map((w) => w.desc)));
    }
    expect(sigs.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T14R3: budgets are enforced WHILE reading
// ---------------------------------------------------------------------------

/** Wrap a reader to count requests and rows actually handed to the materializer. */
function counted(r: FrozenReader) {
  const c = { stream: 0, streamRows: 0, children: 0, childRows: 0, members: 0, memberRows: 0 };
  const w: FrozenReader = {
    ...r,
    site: r.site, cutoff: r.cutoff, kind: r.kind,
    changedKeys: () => r.changedKeys(),
    owners: () => r.owners(),
    members: async (o, cap) => { c.members++; const m = await r.members(o, cap); for (const v of m.values()) c.memberRows += v.length; return m; },
    byIds: (ids) => r.byIds(ids),
    children: async function* (ids) { c.children++; for await (const k of r.children(ids)) { c.childRows++; yield k; } },
    stream: async (s, d, f, l) => { c.stream++; const p = await r.stream(s, d, f, l); c.streamRows += p.length; return p; },
    requests: () => r.requests(),
  };
  return { reader: w, c };
}

describe("T14R3: the 50,000 dependency budget is enforced while reading", () => {
  const LIMIT = MAX_PARTITION_EVENTS;
  const minute = (i: number) => new Date(Date.parse("2026-11-01T00:00:00Z") + i * 1000).toISOString().replace("Z", "000Z");

  it("a successor walk that would consume more than 50,000 distinct events fails visibly, attributed to its seed, and stops reading promptly", async () => {
    const view: Ev[] = [verify("seed", "RP-SEED", A, minute(0))];
    for (let i = 1; i <= LIMIT + 100; i++) view.push(verify(`u${String(i).padStart(6, "0")}`, `RP-U${i}`, A, minute(i), { department: "unframed", line_sku: "INKA-KAN0566-A4-UN" }));
    const changed = [{ id: "seed", before: null, after: view[0] }];
    for (const maxPage of [200, 37]) {
      const { reader, c } = counted(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "refresh", view, changed, maxPage }));
      const err = await affectedOwners(reader).then(() => null, (e: unknown) => e);
      expect(err, `maxPage ${maxPage}`).toBeInstanceOf(PartitionTooLargeError);
      expect((err as PartitionTooLargeError).owner).toEqual({ partitionKind: "order", partitionKey: "RP-SEED" });
      expect((err as PartitionTooLargeError).size).toBe(LIMIT + 1);
      expect(c.streamRows, `maxPage ${maxPage}`).toBeLessThanOrEqual(LIMIT + maxPage); // at most one page of lookahead past the proof
      expect(c.childRows).toBe(0);
    }
  }, 120_000);

  it("a member with 60,000 inverse children stops at the first event proving overflow (50,001 consumed), not after reading all", async () => {
    const view: Ev[] = [complete("t", "RP-1", A, minute(0))];
    for (let i = 1; i <= 60_000; i++) view.push(cancel(`c${String(i).padStart(6, "0")}`, "t", null, B, minute(i)));
    const { reader, c } = counted(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view, changed: [] }));
    const err = await buildOwnerInput(reader, { partitionKind: "order", partitionKey: "RP-1" }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PartitionTooLargeError);
    expect((err as PartitionTooLargeError).size).toBe(LIMIT + 1);
    expect(c.childRows).toBe(LIMIT); // 1 member + 50,000 children = 50,001 distinct: proven, nothing more consumed
  }, 120_000);

  it("a large unused candidate beyond the stopping point is never read: its 60,000 cancellations do not count or change the hash", async () => {
    const base = [verify("p0", "RP-0", A, minute(100)), verify("v", "RP-1", A, minute(200))];
    const beyond = verify("old", "RP-OLD", A, minute(50)); // beyond p0: never consumed
    const view: Ev[] = [...base, beyond];
    for (let i = 1; i <= 60_000; i++) view.push(cancel(`k${String(i).padStart(6, "0")}`, "old", null, B, minute(60)));
    const hashes = new Set<string>();
    for (const maxPage of [1, 3, 200]) {
      const { reader, c } = counted(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view, changed: [], maxPage }));
      const input = await buildOwnerInput(reader, { partitionKind: "order", partitionKey: "RP-1" });
      expect(input.events.map((e) => e.id)).toEqual(["p0", "v"]);
      expect(c.childRows, `maxPage ${maxPage}`).toBe(0);
      hashes.add(canonicalJson(input.events));
    }
    expect(hashes.size).toBe(1);
  }, 120_000);

  it("exactly 50,000 consumed events succeed at every page size: unconsumed lookahead beyond the stop is never charged", async () => {
    const view: Ev[] = [];
    for (let i = 0; i < 300; i++) view.push(ev(`old${String(i).padStart(3, "0")}`, "note_added", "RP-OLD", A, minute(i))); // lookahead only
    view.push(verify("p0", "RP-0", A, minute(1000))); // the effective predecessor: the stop
    for (let i = 0; i < LIMIT - 2; i++) view.push(ev(`n${String(i).padStart(6, "0")}`, "note_added", "RP-N", A, minute(2000 + i)));
    view.push(verify("v", "RP-1", A, minute(2000 + LIMIT)));
    for (const maxPage of [1, 200]) {
      const input = await buildOwnerInput(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view, changed: [], maxPage }), { partitionKind: "order", partitionKey: "RP-1" });
      expect(input.events, `maxPage ${maxPage}`).toHaveLength(LIMIT); // v + 49,998 notes + p0
    }
  }, 180_000);

  it("owners are read one at a time (no 100-owner prefetch), and a batch whose total exceeds 50,000 events across owners stays valid", async () => {
    const view: Ev[] = [];
    for (let o = 0; o < 60; o++) for (let i = 0; i < 900; i++) view.push(ev(`n${o}-${i}`, "note_added", `RP-${o}`, A, minute(o * 1000 + i)));
    const { reader, c } = counted(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view, changed: [] }));
    const out = await materializeBatch(reader);
    expect(out.stats.owners).toBe(60);
    expect(out.stats.totalInput).toBe(54_000);
    expect(c.members).toBe(60); // one owner per members read
    expect(c.memberRows).toBe(54_000); // never another owner's members
    expect(out.stats.peakInput).toBeLessThanOrEqual(900);
  }, 120_000);
});

describe("Task 14: randomized source/derived parity (oracle over the complete history)", () => {
  /** Deterministic generator: orders, blank-order cancellations, cross-order cancellations, staff changes, deletions, moves. */
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  }
  function history(seed: number, n: number): Ev[] {
    const r = rng(seed);
    const staff = [A, B, C];
    const out: Ev[] = [];
    let t = Date.parse("2026-11-14T06:00:00Z");
    for (let i = 0; i < n; i++) {
      t += Math.floor(r() * 9) * 60_000; // ties happen (0-minute steps)
      const at = new Date(t).toISOString().replace("Z", "000Z");
      const who = staff[Math.floor(r() * 3)];
      const order = `RP-${Math.floor(r() * 6)}`;
      const roll = r();
      if (roll < 0.55) out.push(verify(`e${i}`, order, who, at, { department: r() < 0.8 ? "framed" : "unframed", line_sku: r() < 0.85 ? FB : "INKA-KAN0566-A4-UN", cs_case_id: r() < 0.1 ? "CS-1" : null }));
      else if (roll < 0.75 && out.length) {
        const p = out[Math.floor(r() * out.length)];
        out.push(cancel(`e${i}`, p.id, r() < 0.5 ? null : p.order_number, who, at, { department: p.department }));
      } else if (roll < 0.9) out.push(complete(`e${i}`, order, who, at));
      else out.push(ev(`e${i}`, "note_added", order, who, at));
    }
    return out;
  }
  for (const seed of [1, 7, 42, 99, 2026]) {
    it(`seed ${seed}: random edits (insert/delete/update/restaff/reorder) materialize exactly and completely`, async () => {
      const r = rng(seed * 31);
      const before = history(seed, 70);
      const after = before.filter(() => r() > 0.1).map((e) => {
        const x = r();
        if (x < 0.08) return { ...e, staff_id: [A, B, C][Math.floor(r() * 3)] };
        if (x < 0.14) return { ...e, order_number: r() < 0.3 ? null : `RP-${Math.floor(r() * 6)}` };
        if (x < 0.18) return { ...e, line_quantity: 2 };
        return e;
      });
      for (let k = 0; k < 5; k++) after.push(cancel(`z${k}`, before[Math.floor(r() * before.length)].id, null, [A, B, C][k % 3], `2026-11-15T0${k}:00:00.000000Z`));
      const res = await refreshParity(before, after);
      expect(res.problems).toEqual([]);
      expect(res.out.stats.maxInput).toBeLessThanOrEqual(after.length);
      // The same with one- and two-row stream pages (as byte-capped pages can be): the walks' stop logic is exact.
      for (const maxPage of [1, 2]) expect((await refreshParity(before, after, { maxPage })).problems, `maxPage ${maxPage}`).toEqual([]);
    });
  }
});

describe("Task 14: fan-out and memory are recorded", () => {
  it("stats report owners, works, max/total input rows and reader requests", async () => {
    const events: Ev[] = [];
    for (let i = 0; i < 300; i++) events.push(verify(`v${i}`, `RP-${i % 50}`, [A, B, C][i % 3], new Date(Date.parse("2026-11-15T06:00:00Z") + i * 60_000).toISOString()));
    const before = events.slice(0, 290);
    const heap0 = process.memoryUsage().heapUsed;
    const res = await refreshParity(before, events);
    const heapDelta = process.memoryUsage().heapUsed - heap0;
    expect(res.problems).toEqual([]);
    const s = res.out.stats;
    expect(s.owners).toBeGreaterThan(0);
    expect(s.works).toBe(res.out.works.length);
    expect(s.maxInput).toBeGreaterThan(0);
    expect(s.totalInput).toBeGreaterThanOrEqual(s.maxInput);
    expect(s.requests).toBeGreaterThan(0);
    console.info(`[task14 fan-out] owners=${s.owners} works=${s.works} maxInput=${s.maxInput} totalInput=${s.totalInput} requests=${s.requests} heapDeltaKiB=${Math.round(heapDelta / 1024)}`);
    // Refresh does not read the whole site history: 10 new lines touch at most their owners, predecessors and successors.
    expect(s.owners).toBeLessThan(50);
  });
});

void (null as unknown as Owner);
