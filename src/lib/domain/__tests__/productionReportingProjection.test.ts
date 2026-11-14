/**
 * Task 11 (item-counting amendment): reusable classified facts and range
 * semantics. The pure reference query over derived facts must give EXACTLY
 * the current reducer's answer on the v2 four-family snapshot for the same
 * window and scope, including issue/note scope, details and overflow.
 * Expected business values are written out explicitly; parity compares the
 * reference with the existing reducer, never with itself.
 */
import { describe, expect, it } from "vitest";
import {
  prepareProductionEvidence,
  ProductionEvidenceError,
  summarizeProduction,
  type ProductionEvidenceEvent,
  type ProductionScope,
  type ProductionSummary,
  type ProductionVisibility,
  type UtcWindow,
  type WorkType,
} from "../productionCounts";
import { frameTimingLines } from "../productionFrameTiming";
import { productionRange } from "../productionPeriods";
import { buildProductionReportView } from "../productionReportView";
import {
  canonicalJson,
  partitionHash,
  REPORTING_RULE_VERSION,
  sha256Hex,
  SKU_BOARD_MAX,
  toCountTotals,
  toCoverageCounts,
  toReportScalars,
  validateDetailRequest,
  validateSummaryRequest,
  type FrozenPartitionInput,
  type ReportingAudience,
} from "../productionReporting";
import {
  compareReportingProjection,
  projectReportingPartition,
  referenceSummary,
  referenceTimingLines,
} from "../productionReportingProjection";
import {
  ANNA,
  at,
  BEN,
  cancel,
  CASE_R,
  complete,
  CUTOFF,
  day,
  days,
  fourFamilySnapshot,
  history,
  OTHER_SITE,
  randomHistory,
  SITE,
  verify,
} from "../../../../tests/fixtures/reporting-history";

const SITE_VIS: ProductionVisibility = { kind: "site" };
const SELF_VIS: ProductionVisibility = { kind: "limited", reason: "own work only" };

function project(source: readonly ProductionEvidenceEvent[], audience: ReportingAudience = { kind: "site" }, site = SITE) {
  const input: FrozenPartitionInput = { site, audience, ruleVersion: REPORTING_RULE_VERSION, sourceCutoffUtc: CUTOFF, events: source.filter((e) => e.location === site) };
  return projectReportingPartition(input);
}

/** What the database returns to this audience (RLS), before any filter. */
function visibleTo(source: readonly ProductionEvidenceEvent[], audience: ReportingAudience): ProductionEvidenceEvent[] {
  return audience.kind === "site" ? [...source] : source.filter((e) => e.staff_id === audience.staffId);
}

function expected(source: readonly ProductionEvidenceEvent[], selection: UtcWindow, scope: ProductionScope, audience: ReportingAudience = { kind: "site" }, site = SITE): ProductionSummary {
  const vis = audience.kind === "site" ? SITE_VIS : SELF_VIS;
  return summarizeProduction(prepareProductionEvidence(fourFamilySnapshot(visibleTo(source, audience), selection, vis, site)), scope);
}

function actual(source: readonly ProductionEvidenceEvent[], selection: UtcWindow, scope: ProductionScope, audience: ReportingAudience = { kind: "site" }, site = SITE) {
  return referenceSummary(project(source, audience, site), { selection, scope, visibility: audience.kind === "site" ? SITE_VIS : SELF_VIS });
}

function expectParity(source: readonly ProductionEvidenceEvent[], selection: UtcWindow, scope: ProductionScope, audience: ReportingAudience = { kind: "site" }, site = SITE) {
  const diff = compareReportingProjection(expected(source, selection, scope, audience, site), actual(source, selection, scope, audience, site));
  expect(diff, `${JSON.stringify({ selection, scope, audience, site })}`).toEqual([]);
}

const SCOPES = (range: UtcWindow): ProductionScope[] => [
  { range },
  { range, staffIds: [ANNA] },
  { range, staffIds: [BEN] },
  { range, workTypes: ["framed"] },
  { range, workTypes: ["unframed"] },
  { range, staffIds: [ANNA], workTypes: ["framed"] },
];

describe("reference query over classified facts = current reducer on the v2 four-family snapshot", () => {
  const source = history();
  const windows: Array<[string, UtcWindow]> = [
    ...[5, 11, 12, 13, 14, 15, 16].map((d) => [`day ${d}`, day(d)] as [string, UtcWindow]),
    ["days 11–12", days(11, 12)],
    ["days 12–13", days(12, 13)],
    ["days 5–14", days(5, 14)],
    ["days 12–17", days(12, 17)],
    ["custom window with microsecond edges", { startUtc: "2026-01-14T09:15:00.000000Z", endUtcExclusive: "2026-01-14T10:00:00.000400Z" }],
    ["custom window after the tie", { startUtc: "2026-01-14T10:00:00.000500Z", endUtcExclusive: "2026-01-15T11:45:00.000Z" }],
  ];
  for (const [name, w] of windows) {
    it(`site audience · ${name} · every supported scope`, () => {
      for (const scope of SCOPES(w)) expectParity(source, w, scope);
    });
    it(`self audience (Anna and Ben) · ${name}`, () => {
      for (const staffId of [ANNA, BEN]) for (const scope of SCOPES(w)) expectParity(source, w, scope, { kind: "self", staffId });
    });
  }

  it("day scopes inside a multi-day loaded selection (Reports per-day series)", () => {
    for (const d of [12, 13, 14, 15]) for (const scope of SCOPES(day(d))) expectParity(source, days(12, 15), scope);
  });

  it("frame timing lines match for every supported work-type selection and range", () => {
    for (const w of [day(14), day(15), days(12, 15), { startUtc: "2026-01-15T04:05:00.000Z", endUtcExclusive: "2026-01-15T12:00:00.000Z" }]) {
      for (const workTypes of [undefined, ["framed"], ["unframed"], ["a0_framed"], ["dispatch"]] as Array<WorkType[] | undefined>) {
        for (const staffIds of [undefined, [ANNA], [BEN]]) {
          const scope: ProductionScope = { range: w, ...(workTypes ? { workTypes } : {}), ...(staffIds ? { staffIds } : {}) };
          const want = frameTimingLines(prepareProductionEvidence(fourFamilySnapshot(source, w)), scope);
          expect(referenceTimingLines(project(source), { selection: w, scope })).toEqual(want);
        }
      }
    }
  });

  it("randomized windows over randomized histories, both audiences and both sites", () => {
    let s = 99;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 0x100000000);
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const src = randomHistory(seed);
      for (let i = 0; i < 12; i++) {
        const a = Date.UTC(2026, 0, 9) + Math.floor(rnd() * 9 * 86_400_000);
        const b = a + 1 + Math.floor(rnd() * 4 * 86_400_000);
        const micros = (x: number) => new Date(x).toISOString().replace("Z", `${String(Math.floor(rnd() * 3) * 250).padStart(3, "0")}Z`);
        const w = { startUtc: micros(a), endUtcExclusive: micros(b) };
        const scope: ProductionScope = { range: w, ...(rnd() < 0.3 ? { staffIds: [ANNA] } : {}), ...(rnd() < 0.3 ? { workTypes: ["framed" as WorkType] } : {}) };
        for (const site of [SITE, OTHER_SITE]) {
          expectParity(src, w, scope, { kind: "site" }, site);
          expectParity(src, w, scope, { kind: "self", staffId: ANNA }, site);
        }
      }
    }
  });
});

describe("range semantics, with explicit expected values", () => {
  const source = history();
  const keys = (sel: UtcWindow, scope: ProductionScope = { range: sel }) => actual(source, sel, scope).normal.orderKeys;

  it("four Items before completion, one Order after it (order 5001)", () => {
    const s = actual(source, day(12), { range: day(12), workTypes: ["unframed"] });
    expect(s.byWorkType.unframed.normal).toEqual({ items: 4, orders: 1, orderKeys: ["uk|unframed|5001"] });
  });

  it("an order worked on two days by two workers is ONE range Order but one Order on each day (order 5002)", () => {
    expect(keys(day(12))).toContain("uk|5002");
    expect(keys(day(13))).toContain("uk|5002");
    expect(keys(days(12, 13)).filter((k) => k === "uk|5002")).toHaveLength(1);
    const range = actual(source, days(12, 13), { range: days(12, 13) });
    expect(range.byPerson[ANNA].normal.orderKeys).toContain("uk|5002");
    expect(range.byPerson[BEN].normal.orderKeys).toContain("uk|5002");
  });

  it("two work types are counted per work type and once overall (order 5003)", () => {
    const s = actual(source, day(13), { range: day(13) });
    expect(s.byWorkType.framed.normal.orderKeys).toContain("uk|framed|5003");
    expect(s.byWorkType.unframed.normal.orderKeys).toContain("uk|unframed|5003");
    expect(s.byWorkType.dispatch.normal.orderKeys).toEqual(["uk|dispatch|5003"]);
    expect(s.normal.orderKeys.filter((k) => k === "uk|5003")).toHaveLength(1);
  });

  it("a rework case is a separate Order next to the normal one, and another site's same number never mixes in", () => {
    const s = actual(source, day(14), { range: day(14) });
    expect(s.normal.orderKeys).toContain("uk|5004");
    expect(s.rework).toEqual({ items: 1, orders: 1, orderKeys: [`uk|5004|case:${CASE_R}`] });
    expect(s.normal.orderKeys.some((k) => k.startsWith("au|"))).toBe(false);
    const au = actual(source, day(14), { range: day(14) }, { kind: "site" }, OTHER_SITE);
    expect(au.normal).toEqual({ items: 1, orders: 1, orderKeys: ["au|5004"] });
  });

  it("a cancellation after the selected day still removes that day's credit (order 5006, later family)", () => {
    const s = actual(source, day(15), { range: day(15) });
    expect(s.orders.find((o) => o.orderNumber === "5006")).toMatchObject({ items: 0, completed: true });
    expect(s.coverage.notes.corrected_verification).toBe(1);
  });

  it("an orphan parent arriving later: inside the window it is 'later', after it 'not found' (order 5007)", () => {
    const issues = actual(source, day(15), { range: day(15) }).coverage.issues.filter((i) => i.kind === "unresolved_parent");
    expect(issues.map((i) => i.detail).sort()).toEqual(["parent is later than cancellation", "parent not found"]);
    const wide = actual(source, days(15, 16), { range: days(15, 16) }).coverage.issues.filter((i) => i.kind === "unresolved_parent");
    expect(wide.map((i) => i.detail)).toEqual(["parent is later than cancellation", "parent is later than cancellation"]);
  });

  it("a repeat outside the selected four families does NOT create an ambiguity warning (order 5009)", () => {
    const repeat = (sel: UtcWindow) => actual(source, sel, { range: day(14) }).coverage.issues.filter((i) => i.kind === "ambiguous_repeat");
    expect(repeat(day(14)).map((i) => i.detail)).toEqual(["2 verifications of the same line", "2 verifications of the same line"]);
    expect(repeat(days(5, 14)).map((i) => i.detail)).toEqual(["3 verifications of the same line", "3 verifications of the same line"]);
  });

  it("qualification uses the v2 families: a whitespace-variant order before the window is not context (order 5010)", () => {
    expect(keys(day(12))).not.toContain("uk|5010");
    expect(actual(source, day(12), { range: day(12) }).coverage.notes.excluded_only_completion).toBe(1);
    expect(keys(days(11, 12))).toContain("uk|5010");
  });

  it("hidden other-worker context: Ben's cancellation of Anna's line is invisible to Anna's self audience (order 5008)", () => {
    const site = actual(source, day(14), { range: day(14), staffIds: [ANNA] });
    const self = actual(source, day(14), { range: day(14), staffIds: [ANNA] }, { kind: "self", staffId: ANNA });
    expect(site.orders.find((o) => o.orderNumber === "5008")?.items).toBe(0);
    expect(self.orders.find((o) => o.orderNumber === "5008")?.items).toBe(1);
    expect(self.coverage.visibility).toEqual(SELF_VIS);
    expect(self.coverage.incomplete).toBe(true);
  });

  it("invalid identities are reported and never credited", () => {
    const s = actual(source, day(12), { range: day(12) });
    const invalid = s.coverage.issues.filter((i) => i.kind === "invalid_event").map((i) => i.detail);
    expect(invalid.filter((d) => d === "verification without work type, person or order")).toHaveLength(3);
    expect(invalid.filter((d) => d === "terminal without valid work type, person or order")).toHaveLength(1);
    expect(s.coverage.issueCounts.unclassified_sku).toBe(1);
  });

  it("microsecond ties: lines at the completion's exact instant qualify it; ids order equal instants (order 5012)", () => {
    const s = actual(source, day(14), { range: day(14) });
    expect(s.orders.find((o) => o.orderNumber === "5012")).toMatchObject({ items: 5, completed: true, missingDetail: false });
  });

  it("the first timing observation in a range has zero gap when its predecessor is outside it (order 5013)", () => {
    const lines = referenceTimingLines(project(source), { selection: day(15), scope: { range: day(15), staffIds: [ANNA] } });
    const first = lines.find((l) => l.orderNumber === "5013")!;
    expect(first).toMatchObject({ durationMin: 0, startedAtMs: first.completedAtMs });
    const wide = referenceTimingLines(project(source), { selection: days(14, 15), scope: { range: days(14, 15), staffIds: [ANNA] } });
    expect(wide.find((l) => l.eventId === first.eventId)!.durationMin).toBe(20);
  });

  it("T11-1: a predecessor saved microseconds before the selection start (same millisecond) is not in the stream", () => {
    const p = verify({ id: "t11-p", order_number: "5200", created_at: "2026-01-14T10:00:00.000100Z" });
    const n = verify({ id: "t11-n", order_number: "5201", created_at: at(14, "10:10") });
    const sel = { startUtc: "2026-01-14T10:00:00.000500Z", endUtcExclusive: day(14).endUtcExclusive };
    const scope: ProductionScope = { range: sel };
    const want = frameTimingLines(prepareProductionEvidence(fourFamilySnapshot([p, n], sel)), scope);
    expect(want.map((l) => [l.eventId, l.durationMin])).toEqual([["t11-n", 0]]);
    expect(referenceTimingLines(project([p, n]), { selection: sel, scope })).toEqual(want);
  });

  it("T11-1: the same-millisecond predecessor IS in the stream when it is selected context evidence", () => {
    const p = verify({ id: "t11-q", order_number: "5201", created_at: "2026-01-14T10:00:00.000100Z" });
    const n = verify({ id: "t11-m", order_number: "5201", created_at: at(14, "10:10") });
    const c = complete({ order_number: "5201", created_at: at(14, "10:20") });
    const sel = { startUtc: "2026-01-14T10:00:00.000500Z", endUtcExclusive: day(14).endUtcExclusive };
    const scope: ProductionScope = { range: sel };
    const want = frameTimingLines(prepareProductionEvidence(fourFamilySnapshot([p, n, c], sel)), scope);
    expect(want.map((l) => [l.eventId, l.durationMin])).toEqual([["t11-q", 0], ["t11-m", 10]]);
    expect(referenceTimingLines(project([p, n, c]), { selection: sel, scope })).toEqual(want);
  });

  it("Items overflow is null (never a coerced number) and marks coverage incomplete", () => {
    const big = Number.MAX_SAFE_INTEGER - 5;
    const src = [verify({ order_number: "9001", line_quantity: big, created_at: at(12, "09:00") }), verify({ order_number: "9002", line_quantity: big, created_at: at(12, "09:01") })];
    expectParity(src, day(12), { range: day(12) });
    const s = actual(src, day(12), { range: day(12) });
    expect(s.normal.items).toBeNull();
    expect(s.coverage.incomplete).toBe(true);
    expect(() => toCountTotals({ normal: { items: 1.5, orders: 0 }, rework: { items: 0, orders: 0 } })).toThrow(RangeError);
    expect(toCountTotals(s)).toEqual({ normal: { items: null, orders: 0 }, rework: { items: 0, orders: 0 } });
  });
});

describe("source updates and deletes re-project to the reducer's answer", () => {
  it("deleting a cancellation returns the credit; moving a line changes its day; deleting a parent makes it 'not found'", () => {
    const base = history();
    const noCancel = base.filter((e) => !(e.event_type === "cancelled" && e.order_number === "5006"));
    expect(actual(noCancel, day(15), { range: day(15) }).orders.find((o) => o.orderNumber === "5006")?.items).toBe(1);
    expectParity(noCancel, day(15), { range: day(15) });

    const moved = base.map((e) => (e.order_number === "5001" && e.event_type === "line_verified" ? { ...e, created_at: at(13, "09:00") } : e));
    for (const w of [day(12), day(13), days(12, 13)]) expectParity(moved, w, { range: w });
    expect(actual(moved, day(12), { range: day(12) }).byWorkType.unframed.normal.items).toBe(0);

    const noParent = base.filter((e) => !(e.order_number === "5008" && e.event_type === "line_verified" && e.staff_id === ANNA));
    const issues = actual(noParent, day(14), { range: day(14) }).coverage.issues.filter((i) => i.kind === "unresolved_parent");
    expect(issues.map((i) => i.detail)).toEqual(["parent not found"]);
    expectParity(noParent, day(14), { range: day(14) });
  });

  it("a conflicting duplicate payload fails the partition, like the reducer", () => {
    const v = verify({ id: "dup", order_number: "5100", created_at: at(12, "09:00") });
    expect(() => project([v, { ...v, line_quantity: 7 }])).toThrow(ProductionEvidenceError);
    expect(project([v, { ...v }]).facts.filter((f) => f.id === "dup")).toHaveLength(1);
  });
});

describe("mutations that must be caught", () => {
  const source = history();

  it("summing daily Orders instead of a range union", () => {
    const want = expected(source, days(12, 13), { range: days(12, 13) });
    const daily = [day(12), day(13)].map((d) => actual(source, days(12, 13), { range: d }));
    const summed = { ...actual(source, days(12, 13), { range: days(12, 13) }) };
    summed.normal = { ...summed.normal, orders: daily[0].normal.orders + daily[1].normal.orders };
    expect(compareReportingProjection(want, summed).map((d) => d.path)).toContain("normal.orders");
  });

  it("dropping the case from facts", () => {
    const r = project(source);
    const mutated = { ...r, facts: r.facts.map((f) => ({ ...f, caseId: null })) };
    const diff = compareReportingProjection(expected(source, day(14), { range: day(14) }), referenceSummary(mutated, { selection: day(14), scope: { range: day(14) }, visibility: SITE_VIS }));
    expect(diff.length).toBeGreaterThan(0);
  });

  it("dropping the site (another site's rows projected into this one)", () => {
    const merged = source.map((e) => (e.location === OTHER_SITE ? { ...e, location: SITE, id: `x-${e.id}` } : e));
    const diff = compareReportingProjection(expected(source, day(14), { range: day(14) }), actual(merged, day(14), { range: day(14) }));
    expect(diff.length).toBeGreaterThan(0);
  });

  it("changing hidden-parent visibility: deriving self results from site facts plus a staff filter", () => {
    const self: ReportingAudience = { kind: "self", staffId: ANNA };
    const scope = { range: day(14), staffIds: [ANNA] };
    const want = expected(source, day(14), scope, self);
    const fromSite = referenceSummary(project(source), { selection: day(14), scope, visibility: SELF_VIS });
    expect(compareReportingProjection(want, fromSite).length).toBeGreaterThan(0);
    expect(compareReportingProjection(want, actual(source, day(14), scope, self))).toEqual([]);
  });

  it("persisting one all-history ambiguity answer instead of the selected families", () => {
    const want = expected(source, day(14), { range: day(14) });
    const wide = actual(source, days(5, 14), { range: day(14) });
    expect(compareReportingProjection(want, wide).some((d) => d.path.startsWith("coverage.issues"))).toBe(true);
  });
});

describe("partition result contract", () => {
  it("records rule version, cutoff and audience; clock rows are not facts; future rows wait until due", () => {
    const r = project(history());
    expect(r.ruleVersion).toBe(REPORTING_RULE_VERSION);
    expect(r.sourceCutoffUtc).toBe(CUTOFF);
    expect(r.facts.some((f) => f.eventType === "clock_in")).toBe(false);
    expect(r.futureEventIds).toHaveLength(1);
    expect(r.facts.some((f) => f.orderKey === "5014")).toBe(false);
  });

  it("self audience is built only from that worker's saved rows, before any classification", () => {
    const r = project(history(), { kind: "self", staffId: ANNA });
    expect(r.facts.every((f) => f.staffId === ANNA)).toBe(true);
    expect(r.edges.every((e) => r.facts.some((f) => f.id === e.cancelId))).toBe(true);
  });

  it("rejects another site's rows, an unknown rule version and an inexact cutoff", () => {
    const v = verify({ location: OTHER_SITE, created_at: at(12, "09:00") });
    expect(() => projectReportingPartition({ site: SITE, audience: { kind: "site" }, ruleVersion: REPORTING_RULE_VERSION, sourceCutoffUtc: CUTOFF, events: [v] })).toThrow(RangeError);
    expect(() => projectReportingPartition({ site: SITE, audience: { kind: "site" }, ruleVersion: "v0", sourceCutoffUtc: CUTOFF, events: [] })).toThrow(RangeError);
    expect(() => projectReportingPartition({ site: SITE, audience: { kind: "site" }, ruleVersion: REPORTING_RULE_VERSION, sourceCutoffUtc: "soon", events: [] })).toThrow(RangeError);
  });

  it("hash is order-independent, verifiable and changes with any fact", () => {
    const src = history();
    const a = project(src);
    const b = project([...src].reverse());
    expect(a.hash).toBe(b.hash);
    const { hash, ...rest } = a;
    expect(partitionHash(rest)).toBe(hash);
    const changed = project(src.map((e, i) => (i === 0 ? { ...e, line_quantity: 3 } : e)));
    expect(changed.hash).not.toBe(a.hash);
  });

  it("sha256 and canonical JSON are standard and key-order independent", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(canonicalJson({ b: 1, a: [1, { d: null, c: "x" }] })).toBe('{"a":[1,{"c":"x","d":null}],"b":1}');
  });
});

describe("DTO mapping and request validation", () => {
  it("coverage counts map every current field and the issue row count", () => {
    const s = expected(history(), day(12), { range: day(12) });
    const c = toCoverageCounts(s.coverage);
    expect(c).toEqual({ issueCounts: s.coverage.issueCounts, notes: s.coverage.notes, visibility: s.coverage.visibility, incomplete: s.coverage.incomplete, issueRows: s.coverage.issues.length });
  });

  it("T11-2: whole-scope Reports values (activeStaff, staffDays, average, top-20 slowest variants) map exactly", () => {
    const range = productionRange("uk", "2026-01-12", "2026-01-15");
    const evidence = prepareProductionEvidence(fourFamilySnapshot(history(), { startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive }));
    for (const staffId of [null, ANNA]) {
      const view = buildProductionReportView(evidence, { range, staffId });
      const s = toReportScalars(view);
      expect(s).toEqual({ activeStaff: view.activeStaff, staffDays: view.staffDays, avgOrdersPerStaffDay: view.avgOrdersPerStaffDay, skuBoard: view.skuBoard });
      expect(s.activeStaff).toBeGreaterThan(0);
      expect(s.staffDays).toBeGreaterThan(0);
      expect(s.skuBoard.length).toBeGreaterThan(0);
    }
    const all = buildProductionReportView(evidence, { range });
    expect(toReportScalars(all).activeStaff).toBe(3);
    const row = { sku: "A4-FB", weight: 1, durationMin: 2, avgMin: 2 };
    expect(toReportScalars({ ...all, skuBoard: Array.from({ length: SKU_BOARD_MAX }, () => row) }).skuBoard).toHaveLength(SKU_BOARD_MAX);
    expect(() => toReportScalars({ ...all, skuBoard: Array.from({ length: SKU_BOARD_MAX + 1 }, () => row) })).toThrow(RangeError);
    expect(() => toReportScalars({ ...all, avgOrdersPerStaffDay: Number.NaN })).toThrow(RangeError);
    expect(() => toReportScalars({ ...all, staffDays: 1.5 })).toThrow(RangeError);
  });

  it("T11-3: malformed optional detail and summary selectors are rejected, valid ones accepted", () => {
    const base = { site: "uk" as const, generationId: "g1", kind: "orders" as const, firstDate: "2026-01-01", lastDate: "2026-01-01" };
    for (const bad of [{ staffId: { unexpected: true } }, { orderNumber: [] }, { cursor: 42 }, { cursor: "" }, { cursor: "  " }, { staffId: "" }, { orderNumber: null }, { staffId: 7 }]) {
      expect(() => validateDetailRequest({ ...base, ...(bad as object) } as never), JSON.stringify(bad)).toThrow(/invalid/);
    }
    expect(validateDetailRequest({ ...base, staffId: ANNA, orderNumber: "5001", cursor: "opaque" })).toMatchObject({ staffId: ANNA, orderNumber: "5001", cursor: "opaque", limit: 200 });
    for (const bad of [{ staffId: [] }, { generationId: 3 }, { staffId: " " }]) {
      expect(() => validateSummaryRequest({ site: "uk", firstDate: "2026-01-01", lastDate: "2026-01-02", view: "reports", ...(bad as object) } as never)).toThrow(/invalid/);
    }
    expect(() => validateDetailRequest({ ...base, limit: "10" as never })).toThrow();
  });

  it("summary and detail requests are validated with explicit bounds", () => {
    expect(() => validateSummaryRequest({ site: "fr" as never, firstDate: "2026-01-01", lastDate: "2026-01-02", view: "reports" })).toThrow();
    expect(() => validateSummaryRequest({ site: "uk", firstDate: "2026-01-03", lastDate: "2026-01-02", view: "reports" })).toThrow();
    expect(() => validateSummaryRequest({ site: "uk", firstDate: "2026-02-30", lastDate: "2026-03-02", view: "reports" })).toThrow();
    expect(validateSummaryRequest({ site: "uk", firstDate: "2021-01-01", lastDate: "2026-01-02", view: "welcome" }).view).toBe("welcome");
    expect(validateDetailRequest({ site: "uk", generationId: "g1", kind: "orders", firstDate: "2026-01-01", lastDate: "2026-01-01" }).limit).toBe(200);
    expect(() => validateDetailRequest({ site: "uk", generationId: "g1", kind: "orders", firstDate: "2026-01-01", lastDate: "2026-01-01", limit: 1001 })).toThrow();
    expect(() => validateDetailRequest({ site: "uk", generationId: "", kind: "orders", firstDate: "2026-01-01", lastDate: "2026-01-01" })).toThrow();
    expect(() => validateDetailRequest({ site: "uk", generationId: "g1", kind: "everything" as never, firstDate: "2026-01-01", lastDate: "2026-01-01" })).toThrow();
  });
});

// Keep the dispatch fixture import used (dispatch rows are part of history()).
void complete;
void cancel;
