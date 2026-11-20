/**
 * Task 17 integration: the pure routing/adapter layer between the published
 * view controller and the Reports/Welcome pages.
 *
 *  - The raw-history path (useProductionEvidence) may activate ONLY after an
 *    explicit READ_MODE_LEGACY/SHADOW answer; while the summary is pending,
 *    shown, stale or failed, the raw range is null (no dual read).
 *  - Reports values are the summary's exact totals and whole-scope scalars,
 *    never sums of loaded pages; incomplete pages are labelled.
 *  - The status line shows the published cutoff with the 15/30/120-minute
 *    freshness rules and old-generation day coverage, never false zeroes.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { managementSource, publishedCsv, publishedCsvHeader, publishedCsvLines, publishedDetailList, publishedOrders, publishedStatusLine, rawRangeFor, reportViewFromSummary, welcomeFromSummary } from "../../src/lib/domain/productionPublishedView";
import type { PublishedState, PublishedStatus } from "../../src/lib/hooks/usePublishedProduction";
import { detailKey } from "../../src/lib/hooks/usePublishedProduction";
import { productionRange } from "../../src/lib/domain/productionPeriods";
import type { CountTotals, PublishedWelcomeView, SummaryResult } from "../../src/lib/domain/productionReporting";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";
const g = (items: number | null, orders: number, ri: number | null = 0, ro = 0): CountTotals => ({ normal: { items, orders }, rework: { items: ri, orders: ro } });
const cov = { issueCounts: { invalid_event: 0, unclassified_sku: 2, invalid_quantity: 0, unresolved_parent: 0, missing_completion_detail: 0, ambiguous_repeat: 0 }, notes: { expected_exclusion: 1, corrected_verification: 0, reversed_terminal: 0, excluded_only_completion: 0 }, visibility: { kind: "site" as const }, incomplete: true, issueRows: 2 };
const person = (staffId: string, orders: number) => ({ staffId, normal: { items: orders * 3, orders }, rework: { items: 0, orders: 0 }, daysWorked: 1, itemsPerDay: orders * 3, ordersPerDay: orders, timing: { durationMin: 10, timedWeight: 2, avgMinPerUnit: 5 } });
const RANGE = productionRange("uk", "2026-11-10", "2026-11-16");
function summary(o: Partial<SummaryResult> = {}): SummaryResult {
  return {
    meta: { site: "uk", generationId: "g1", ruleVersion: "item-counting-summary-v1", sourceCutoffUtc: "2026-11-16T09:00:00.000000Z", verifiedAtUtc: "2026-11-16T09:00:00.000000Z", publishedAtUtc: "2026-11-16T09:01:00.000000Z", freshUntilUtc: "2026-11-16T09:30:00.000000Z", expiresAtUtc: "", visibility: { kind: "site" }, state: "current" },
    totals: g(100, 7, 4, 1),
    byWorkType: [{ workType: "a0_framed", totals: g(0, 0) }, { workType: "framed", totals: g(60, 5) }, { workType: "unframed", totals: g(40, 3) }, { workType: "dispatch", totals: g(0, 6) }],
    dailyPage: { rows: Array.from({ length: 7 }, (_, i) => ({ productionDate: `2026-11-${10 + i}`, totals: g(i, 1) })), nextCursor: null, pageComplete: true, totalRows: 7 },
    coverage: cov,
    timing: { durationMin: 120, timedWeight: 30, avgMinPerUnit: 4 },
    peoplePage: { rows: [person(U1, 4), person(U2, 2)], nextCursor: "cur-people", pageComplete: true, totalRows: 3 },
    activeStaff: 3, staffDays: 9, avgOrdersPerStaffDay: 0.78, skuBoard: [{ sku: "A4 FB", weight: 3, durationMin: 12, avgMin: 4 }],
    ...o,
  } as SummaryResult;
}
const state = (status: PublishedStatus, s: SummaryResult | null = summary(), o: Partial<PublishedState> = {}): PublishedState => ({ status, identityKey: "k", summary: s, error: null, details: {}, ...o });
const NOW = Date.parse("2026-11-16T09:10:00.000Z");
const MIN = 60_000;

describe("Task 17: management data source (no raw history unless the site is explicitly legacy)", () => {
  const ALL: PublishedStatus[] = ["idle", "loading", "current", "stale", "error", "legacy"];
  it("only an explicit legacy answer selects the raw path; everything else is published or pending", () => {
    expect(Object.fromEntries(ALL.map((s) => [s, managementSource(s)]))).toEqual({ idle: "pending", loading: "pending", current: "published", stale: "published", error: "published", legacy: "legacy" });
  });
  it("the raw-history range is null for every non-legacy state (pending, shown, stale, failed)", () => {
    for (const s of ALL) expect([s, rawRangeFor(s, RANGE)]).toEqual([s, s === "legacy" ? RANGE : null]);
    expect(rawRangeFor("legacy", null)).toBeNull();
  });
  it("both pages route the raw hook and the raw CSV export through that decision (no dual read, no raw export in published mode)", () => {
    for (const page of ["src/pages/Reports.tsx", "src/pages/Welcome.tsx"]) {
      const src = readFileSync(page, "utf8");
      const calls = src.match(/useProductionEvidence\(\{[^}]*\}\)/g) ?? [];
      expect([page, calls.length]).toEqual([page, 1]);
      expect([page, calls[0]]).toEqual([page, expect.stringMatching(/range:\s*rawRangeFor\(/)]);
      expect([page, src.includes("usePublishedManagement(")]).toEqual([page, true]); // the published summary path is mounted
    }
    expect(readFileSync("src/lib/hooks/usePublishedManagement.ts", "utf8")).toMatch(/return usePublishedProduction\(identity, deps, o\.refreshKey\)/);
    const reports = readFileSync("src/pages/Reports.tsx", "utf8");
    const exportFn = reports.slice(reports.indexOf("const handleExport = useCallback("), reports.indexOf("}, [", reports.indexOf("const handleExport = useCallback(")));
    expect(exportFn).toMatch(/if \(source !== "legacy"/); // the raw note/station fetch never runs for a published site
  });
});

describe("Task 17: the Reports view from one published summary", () => {
  it("tiles and whole-scope values are the summary's exact fields, never sums of loaded pages", () => {
    const v = reportViewFromSummary(summary(), { staffId: null, details: {}, coveredThrough: "2026-11-16" });
    expect(v.summary).toEqual(g(100, 7, 4, 1));
    expect(v.dispatchedOrders).toBe(6); // byWorkType.dispatch normal Orders
    expect([v.activeStaff, v.staffDays, v.avgOrdersPerStaffDay]).toEqual([3, 9, 0.78]);
    expect(v.timing).toEqual({ durationMin: 120, timedWeight: 30, avgMinPerUnit: 4 });
    expect(v.skuBoard).toEqual([{ sku: "A4 FB", weight: 3, durationMin: 12, avgMin: 4 }]);
    expect(v.coverage).toEqual(cov);
    // the people page holds 2 of 3: totals still come from the summary, and the page says it is incomplete
    expect(v.leaderboard.map((p) => p.staffId)).toEqual([U1, U2]);
    expect(v.people).toEqual({ shown: 2, total: 3, complete: false });
    expect(v.leaderboard.reduce((n, p) => n + p.normal.orders, 0)).not.toBe(v.summary.normal.orders);
    expect([v.staffOrders, v.exportEvents]).toEqual([[], []]); // order/event detail is a later slice
  });
  it("loaded people pages are appended in order; the list is complete only when the last cursor is null", () => {
    const details = { [detailKey("people")]: { rows: [{ kind: "people" as const, row: person(U3, 1) }], nextCursor: null, totalRows: 3 } };
    const v = reportViewFromSummary(summary(), { staffId: null, details, coveredThrough: "2026-11-16" });
    expect(v.leaderboard.map((p) => p.staffId)).toEqual([U1, U2, U3]);
    expect(v.people).toEqual({ shown: 3, total: 3, complete: true });
  });
  it("the selected person's daily series is the summary's daily page; days the generation does not cover are left out, not zeroed", () => {
    const none = reportViewFromSummary(summary(), { staffId: null, details: {}, coveredThrough: "2026-11-16" });
    expect([none.personDaily, none.personTotals]).toEqual([null, null]);
    const v = reportViewFromSummary(summary(), { staffId: U1, details: {}, coveredThrough: "2026-11-14" });
    expect(v.personDaily!.map((d) => d.date)).toEqual(["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14"]);
    expect(v.personDaily![0]).toEqual({ date: "2026-11-10", normal: { items: 0, orders: 1 }, rework: { items: 0, orders: 0 } });
    expect(v.personTotals).toEqual(g(100, 7, 4, 1));
    expect(v.daily).toEqual({ shown: 7, total: 7, complete: true, unpublishedAfter: "2026-11-14" });
  });
  it("an incomplete daily page is labelled, never presented as complete", () => {
    const s = summary({ dailyPage: { rows: summary().dailyPage.rows.slice(0, 3), nextCursor: "cur-days", pageComplete: true, totalRows: 7 } });
    expect(reportViewFromSummary(s, { staffId: U1, details: {}, coveredThrough: "2026-11-16" }).daily).toEqual({ shown: 3, total: 7, complete: false, unpublishedAfter: null });
  });
});

describe("Task 17: published status line (cutoff, 15/30/120-minute freshness, old-generation coverage)", () => {
  const line = (s: PublishedState, now = NOW, range = RANGE) => publishedStatusLine(s, { site: "uk", range, nowMs: now });
  it("current within 30 minutes: counts as of the SOURCE CUTOFF; no delay warning", () => {
    const l = line(state("current"));
    expect(l.status).toBe("current");
    expect(l.snapshot).toEqual({ asOfUtc: "2026-11-16T09:00:00.000000Z", loadedAtUtc: "2026-11-16T09:00:00.000000Z" });
    expect(l.notes.join(" ")).not.toMatch(/delayed|out of date/i);
  });
  it("31 minutes since verification: 'Update delayed'; 121 minutes: 'Report out of date' (numbers stay, labelled)", () => {
    const v = Date.parse("2026-11-16T09:00:00.000Z");
    expect(line(state("stale"), v + 31 * MIN).notes.join(" ")).toMatch(/Update delayed/);
    expect(line(state("stale"), v + 121 * MIN).notes.join(" ")).toMatch(/Report out of date/);
    expect(line(state("stale"), v + 121 * MIN).status).toBe("current"); // shown with its warning, not as a failed refresh
    expect(line(state("current"), v + 16 * MIN).notes.join(" ")).toMatch(/refresh is due/i); // past the 15-minute refresh
    expect(line(state("current"), v + 14 * MIN).notes.join(" ")).not.toMatch(/refresh is due/i);
  });
  it("a failed refresh keeps the shown generation as stale with the error; a failed first load is an error with no numbers", () => {
    expect(line(state("stale", summary(), { error: "No published report" }))).toMatchObject({ status: "stale", error: "No published report" });
    expect(line(state("error", null, { error: "No membership for this site" }))).toMatchObject({ status: "error", error: "No membership for this site", snapshot: null });
    expect(line(state("loading", null))).toMatchObject({ status: "loading", snapshot: null });
  });
  it("days after the generation's covered production date are announced as not yet published (never as zero)", () => {
    // cutoff 2026-11-16T03:00Z is before the uk 04:00 rollover: it covers through 2026-11-15
    const s = summary({ meta: { ...summary().meta, sourceCutoffUtc: "2026-11-16T03:00:00.000000Z" } });
    const l = line(state("current", s));
    expect(l.coveredThrough).toBe("2026-11-15");
    expect(l.notes.join(" ")).toMatch(/after 2026-11-15 are not in this published report yet/);
    expect(line(state("current")).notes.join(" ")).not.toMatch(/not in this published report yet/);
  });
});

describe("Task 17: the Welcome view from the same summary", () => {
  const welcome: PublishedWelcomeView = {
    today: "2026-11-16", yesterday: "2026-11-15", todayTotals: { normal: { items: 5, orders: 2 }, rework: { items: 0, orders: 0 } },
    perDepartment: Object.fromEntries(["a0_framed", "framed", "unframed", "dispatch"].map((w) => [w, { normal: { items: 1, orders: 1 }, rework: { items: 0, orders: 0 }, topWorker: null, vsLastWeek: null, lastWeekDate: "2026-11-09", streak: 0 }])) as PublishedWelcomeView["perDepartment"],
    mostImproved: null, sparkline: [{ day: "2026-11-15", orders: 3 }], teamTotalYesterday: 3, todayCoverage: cov, coverage: cov,
  };
  it("consumes summary.welcome directly; today's figures are hidden (not zeroed) when the generation does not cover today", () => {
    const ok = welcomeFromSummary(summary({ welcome }), { site: "uk", nowMs: NOW });
    expect(ok).toEqual({ view: welcome, todayPublished: true, yesterdayPublished: true, coveredThrough: "2026-11-16" });
    const old = welcomeFromSummary(summary({ welcome, meta: { ...summary().meta, sourceCutoffUtc: "2026-11-16T03:00:00.000000Z" } }), { site: "uk", nowMs: NOW });
    expect(old).toMatchObject({ todayPublished: false, yesterdayPublished: true, coveredThrough: "2026-11-15" });
    expect(welcomeFromSummary(summary(), { site: "uk", nowMs: NOW })).toBeNull(); // a Reports summary carries no Welcome part
  });
});

describe("Task 17: published selected-staff orders and the published CSV", () => {
  const order = (n: number, o: Record<string, unknown> = {}) => ({ kind: "orders" as const, row: { key: `uk|O-${n}`, orderNumber: `O-${n}`, caseId: null, group: "normal" as const, firstAtUtc: "2026-11-16T09:00:00.123456Z", lastAtUtc: "2026-11-16T10:30:00.000000Z", workTypes: ["framed" as const, "dispatch" as const], verifiedLines: 2, items: null, completed: true, ...o } });
  it("orders: nothing until loaded; rows map onto the existing table (times, items incl. overflow null, completion, work types); completeness from the cursor", () => {
    expect(publishedOrders({})).toEqual({ started: false, rows: [], shown: 0, total: 0, complete: false });
    const rows = [order(1), order(2, { caseId: "C9", group: "rework", items: 4, completed: false })];
    const got = publishedOrders({ [detailKey("orders")]: { rows, nextCursor: "c1", totalRows: 5 } });
    expect(got).toMatchObject({ started: true, shown: 2, total: 5, complete: false });
    expect(got.rows[0]).toEqual({ key: "uk|O-1", orderNumber: "O-1", caseId: null, group: "normal", firstMs: Date.parse("2026-11-16T09:00:00.123Z"), lastMs: Date.parse("2026-11-16T10:30:00.000Z"), workTypes: ["framed", "dispatch"], verifiedLines: 2, items: null, completed: true });
    expect(got.rows[1]).toMatchObject({ caseId: "C9", items: 4, completed: false });
    expect(publishedOrders({ [detailKey("orders")]: { rows, nextCursor: null, totalRows: 2 } }).complete).toBe(true);
  });
  it("CSV: the legacy columns from raw-export rows (raw quantity, raw note/station, blank vs null), names from the caller's lookup", () => {
    const ev = (o: Record<string, unknown>) => ({ kind: "raw-export" as const, row: { id: "e1", staffId: U1, department: "framed", orderNumber: "O-1", sku: "SKU", quantity: 2, eventType: "line_verified", createdAtUtc: "2026-11-16T09:00:00.000001Z", parentEventId: null, caseId: null, note: "", stationId: null, ...o } });
    const csv = publishedCsv([ev({}), ev({ id: "e2", staffId: null, department: "dispatch", quantity: null, note: 'say "hi", then\nleave', stationId: "s-9", eventType: "dispatched" })], (id) => (id === U1 ? "Anna" : id));
    expect(csv.split("\r\n")).toEqual([
      "timestamp,staff_name,department,order_number,sku,quantity,event_type,station_id,note",
      "2026-11-16T09:00:00.000001Z,Anna,Framed,O-1,SKU,2,line_verified,,",
      '2026-11-16T09:00:00.000001Z,,Dispatch,O-1,SKU,,dispatched,s-9,"say ""hi"", then leave"',
    ]);
    expect(() => publishedCsv([{ kind: "orders", row: {} } as never], (id) => id)).toThrow(/raw-export/);
  });
  it("the published export path never queries production_events and never uses the raw fetchAllRows reader", () => {
    const src = readFileSync("src/pages/Reports.tsx", "utf8");
    const start = src.indexOf("const handlePublishedExport = useCallback(");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("}, [", start));
    expect(body).toMatch(/collectAll\("raw-export"/);
    expect(body).not.toMatch(/production_events|fetchAllRows|supabase\.from/);
    expect(src).toMatch(/source === "legacy" \? handleExport\(\) : handlePublishedExport\(\)/);
  });
});

describe("Task 17 review: loaded day pages extend the published daily series", () => {
  const day = (d: string, items: number) => ({ productionDate: d, totals: g(items, 1) });
  const firstPage = { rows: [day("2026-11-10", 1), day("2026-11-11", 2), day("2026-11-12", 3)], nextCursor: "cur-days", pageComplete: true, totalRows: 7 };
  it("day-detail rows follow the summary's first page in order; completeness comes from the LAST cursor", () => {
    const details = { [detailKey("days")]: { rows: [day("2026-11-13", 4), day("2026-11-14", 5)].map((row) => ({ kind: "days" as const, row })), nextCursor: "cur-2", totalRows: 7 } };
    const v = reportViewFromSummary(summary({ dailyPage: firstPage }), { staffId: U1, details, coveredThrough: "2026-11-16" });
    expect(v.personDaily!.map((d) => d.date)).toEqual(["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14"]);
    expect(v.daily).toEqual({ shown: 5, total: 7, complete: false, unpublishedAfter: null });
    const done = { [detailKey("days")]: { rows: ["2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"].map((d, i) => ({ kind: "days" as const, row: day(d, i) })), nextCursor: null, totalRows: 7 } };
    expect(reportViewFromSummary(summary({ dailyPage: firstPage }), { staffId: U1, details: done, coveredThrough: "2026-11-16" }).daily).toEqual({ shown: 7, total: 7, complete: true, unpublishedAfter: null });
  });
  it("every shown day (summary page and loaded pages) is filtered by the covered date; uncovered days are announced, not zeroed", () => {
    const details = { [detailKey("days")]: { rows: [day("2026-11-13", 4), day("2026-11-14", 5)].map((row) => ({ kind: "days" as const, row })), nextCursor: null, totalRows: 5 } };
    const v = reportViewFromSummary(summary({ dailyPage: { ...firstPage, totalRows: 5 } }), { staffId: U1, details, coveredThrough: "2026-11-13" });
    expect(v.personDaily!.map((d) => d.date)).toEqual(["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]);
    expect(v.daily.unpublishedAfter).toBe("2026-11-13");
    expect(v.personTotals).toEqual(g(100, 7, 4, 1)); // the summary's totals, never a sum of day rows
  });
});

describe("Task 17 review: coverage issues and timing observations are lazy published drill-downs", () => {
  const cov = (n: number) => ({ kind: "coverage" as const, row: { kind: "unclassified_sku" as const, eventId: `e${n}`, location: "uk", detail: n === 1 ? null : `SKU-${n}` } });
  const tim = (n: number) => ({ kind: "timing" as const, row: { eventId: `t${n}`, staffId: U1, workType: "framed" as const, orderNumber: `O-${n}`, sku: null, weight: 1, startedAtUtc: "2026-11-16T09:00:00.000001Z", completedAtUtc: "2026-11-16T09:10:00.000001Z", durationMin: 10 } });
  it("nothing until loaded; rows are the existing DTOs; complete only when the last cursor is null", () => {
    expect(publishedDetailList({}, "coverage")).toEqual({ started: false, rows: [], shown: 0, total: 0, complete: false });
    const c = publishedDetailList({ [detailKey("coverage")]: { rows: [cov(1), cov(2)], nextCursor: "c1", totalRows: 3 } }, "coverage");
    expect(c).toEqual({ started: true, rows: [cov(1).row, cov(2).row], shown: 2, total: 3, complete: false });
    const tl = publishedDetailList({ [detailKey("timing")]: { rows: [tim(1)], nextCursor: null, totalRows: 1 } }, "timing");
    expect(tl).toEqual({ started: true, rows: [tim(1).row], shown: 1, total: 1, complete: true });
    // a page of another kind under the key is never shown as this kind
    expect(publishedDetailList({ [detailKey("timing")]: { rows: [cov(1)], nextCursor: null, totalRows: 1 } } as never, "timing").rows).toEqual([]);
  });
  it("Reports: no effect requests any detail page; the drill-down buttons route to nextPage in the shown generation", () => {
    const src = readFileSync("src/pages/Reports.tsx", "utf8");
    let i = src.indexOf("useEffect(");
    while (i >= 0) {
      let depth = 0;
      let j = i + "useEffect".length;
      for (; j < src.length; j++) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")" && --depth === 0) break;
      }
      expect(src.slice(i, j + 1)).not.toMatch(/nextPage|collectAll/);
      i = src.indexOf("useEffect(", j);
    }
    for (const kind of ["days", "coverage", "timing", "orders", "people"]) expect([kind, src.includes(`onClick={() => pub.nextPage("${kind}")}`)]).toEqual([kind, true]);
    expect(src).toMatch(/Load more production days/);
    expect(src).toMatch(/Load coverage issues/);
    expect(src).toMatch(/Load timing observations/);
    expect(src).toMatch(/coverage\.issueRows > 0/); // coverage issues are offered only when there are some
  });
});

describe("Task 18: the published CSV is built incrementally, page by page", () => {
  const ev = (id: string, note: string) => ({ kind: "raw-export" as const, row: { id, staffId: null, department: "framed", orderNumber: "O-1", sku: null, quantity: 1, eventType: "line_verified", createdAtUtc: "2026-11-16T09:00:00.000001Z", parentEventId: null, caseId: null, note, stationId: null } });
  it("header + per-page lines joined equal the whole-file CSV (same columns, escaping and raw values)", () => {
    const p1 = [ev("e1", ""), ev("e2", 'a "b", c')];
    const p2 = [ev("e3", "x\ny")];
    const name = (id: string) => id;
    const streamed = [publishedCsvHeader(), ...publishedCsvLines(p1, name), ...publishedCsvLines(p2, name)].join("\r\n");
    expect(streamed).toBe(publishedCsv([...p1, ...p2], name));
    expect(publishedCsvLines([], name)).toEqual([]);
  });
  it("Reports streams the export page-chunked: ONE BlobPart per validated page, no per-row parts or whole-file join, Blob only after the collection resolved", () => {
    const src = readFileSync("src/pages/Reports.tsx", "utf8");
    const start = src.indexOf("const handlePublishedExport = useCallback(");
    const body = src.slice(start, src.indexOf("}, [", start));
    expect(body).toMatch(/const chunks: BlobPart\[\] = \[publishedCsvHeader\(\)\];/);
    expect(body).toMatch(/collectAll\("raw-export", \{\s*limit: 1000,\s*onPage: /);
    // each page becomes exactly one CRLF-led chunk
    expect(body).toMatch(/chunks\.push\(`\\r\\n\$\{publishedCsvLines\(rows, nameOf\)\.join\("\\r\\n"\)\}`\)/);
    expect(body).not.toMatch(/\.push\(\.\.\./); // never one part per row
    expect(body).not.toMatch(/(chunks|parts)\.join\(/); // never a whole-file string copy
    expect(body).toMatch(/new Blob\(chunks, /);
    expect(body.indexOf("await pub.collectAll(")).toBeLessThan(body.indexOf("new Blob("));
    expect(body).not.toMatch(/production_events|fetchAllRows|supabase\.from/);
  });
  it("the page chunks concatenate to exactly the whole-file CSV", () => {
    const ev = (id: string) => ({ kind: "raw-export" as const, row: { id, staffId: null, department: "framed", orderNumber: "O-1", sku: null, quantity: 1, eventType: "line_verified", createdAtUtc: "2026-11-16T09:00:00.000001Z", parentEventId: null, caseId: null, note: "", stationId: null } });
    const pages = [[ev("e1"), ev("e2")], [], [ev("e3")]];
    const name = (id: string) => id;
    const chunks = [publishedCsvHeader(), ...pages.filter((p) => p.length).map((p) => `\r\n${publishedCsvLines(p, name).join("\r\n")}`)];
    expect(chunks).toHaveLength(3); // header + one chunk per non-empty page
    expect(chunks.join("")).toBe(publishedCsv(pages.flat(), name));
  });
});
