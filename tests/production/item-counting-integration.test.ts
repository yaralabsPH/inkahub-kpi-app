/**
 * F1 x F4–F7 integration seams. Event rows are written exactly as the F6
 * shared framing scanner (0055 step 9) and the F7 shared dispatch scanner
 * (0056 step 10) insert them, then counted by F1's one shared reducer.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prepareProductionEvidence, summarizeProduction, type ProductionEvidenceEvent } from "../../src/lib/domain/productionCounts";
import { publishedCsvHeader, publishedCsvLines } from "../../src/lib/domain/productionPublishedView";
import { ATTRIBUTION_CSV_HEADERS, attributableEventIds, attributionCsvCells, groupByEvent, type FramerAttribution } from "../../src/lib/scanners/attribution";
import { framingPieceMultiplier } from "../../src/lib/scanners/order";
import type { PublishedDetailRow } from "../../src/lib/domain/productionReporting";

const FRAMER = "11111111-1111-4111-8111-111111111111";
const DISPATCHER = "22222222-2222-4222-8222-222222222222";
const RANGE = { startUtc: "2026-11-20T04:00:00.000Z", endUtcExclusive: "2026-11-21T04:00:00.000Z" };
const AS_OF = "2026-11-20T20:00:00.000Z";
const SCAN_AT = "2026-11-20T09:30:00.000Z";
const RID = "0f0e0d0c0b0a49088776655443322110";
const STATION = "shared:rcv-1:scn-1";

const base = (over: Partial<ProductionEvidenceEvent>): ProductionEvidenceEvent => ({
  id: "x",
  location: "uk",
  staff_id: FRAMER,
  department: "framed",
  order_number: "5001",
  line_sku: null,
  line_quantity: null,
  event_type: "line_verified",
  created_at: SCAN_AT,
  parent_event_id: null,
  cs_case_id: null,
  ...over,
});

/** 0055 step 9: one line_verified per line (v01..), then one completed per work type, ALL at the scan time. */
function sharedFramingScan(lines: Array<{ sku: string; quantity: number; workType: "framed" | "a0_framed" }>, order = "5001"): ProductionEvidenceEvent[] {
  const verifies = lines.map((l, i) =>
    base({ id: `scn-${RID}-v${String(i + 1).padStart(2, "0")}`, department: l.workType, order_number: order, line_sku: l.sku, line_quantity: l.quantity }),
  );
  const workTypes = [...new Set(lines.map((l) => l.workType))].sort();
  const completes = workTypes.map((wt) =>
    base({
      id: `scn-${RID}-c-${wt}`,
      department: wt,
      order_number: order,
      event_type: "completed",
      line_quantity: lines.filter((l) => l.workType === wt).reduce((s, l) => s + l.quantity, 0),
    }),
  );
  return [...verifies, ...completes];
}

/** 0056 step 10: the whole-order dispatched row, no per-line verifications. */
const sharedDispatch = (order: string, items: number): ProductionEvidenceEvent =>
  base({ id: `dsp-${RID}-d`, staff_id: DISPATCHER, department: "dispatch", order_number: order, event_type: "dispatched", line_quantity: items, created_at: "2026-11-20T15:00:00.000Z" });

const summarize = (events: ProductionEvidenceEvent[], staffIds?: string[]) =>
  summarizeProduction(
    prepareProductionEvidence({ events, range: RANGE, asOfUtc: AS_OF, loadedAtUtc: AS_OF, visibility: { kind: "site" } }),
    { range: RANGE, ...(staffIds ? { staffIds } : {}) },
  );

describe("F6 shared framing scanner rows through the F1 reducer", () => {
  const SET3 = "INKA-S3WIL0049-A3-FN";
  const SINGLE = "INKA-ABC0001-A2-FB";
  const A0 = "INKA-ABC0001-A0-FB";

  it("one scan with several lines at the same instant credits every piece once (completion id sorts before the verifies)", () => {
    const s = summarize(sharedFramingScan([
      { sku: SINGLE, quantity: 2, workType: "framed" },
      { sku: SET3, quantity: 1, workType: "framed" },
    ]));
    expect(s.byWorkType.framed.normal.items).toBe(2 + 3);
    expect(s.byWorkType.framed.normal.orders).toBe(1);
    expect(s.byPerson[FRAMER].normal.items).toBe(5);
    expect(s.byPerson[FRAMER].normal.orders).toBe(1);
  });

  it("A0 and framed lines in one scan: one order per work type, overall one order, no double pieces", () => {
    const s = summarize(sharedFramingScan([
      { sku: A0, quantity: 1, workType: "a0_framed" },
      { sku: SINGLE, quantity: 1, workType: "framed" },
    ]));
    expect(s.byWorkType.a0_framed.normal.items).toBe(1);
    expect(s.byWorkType.framed.normal.items).toBe(1);
    expect(s.byWorkType.a0_framed.normal.orders).toBe(1);
    expect(s.byWorkType.framed.normal.orders).toBe(1);
    expect(s.normal.items).toBe(2);
    expect(s.normal.orders).toBe(1);
  });

  it("the local scanner preview multiplier agrees with F1's credited pieces for a set", () => {
    const s = summarize(sharedFramingScan([{ sku: SET3, quantity: 2, workType: "framed" }]));
    expect(s.byWorkType.framed.normal.items).toBe(2 * framingPieceMultiplier(SET3));
    expect(framingPieceMultiplier(SINGLE)).toBe(1);
  });
});

describe("F7 shared dispatch: no manufactured framing credit, missing line evidence stays explicit", () => {
  it("a shared-scanner dispatch credits the dispatcher's order only; the framer named in an attribution gets nothing from it", () => {
    const s = summarize([sharedDispatch("5002", 3)]);
    expect(s.byWorkType.dispatch.normal.orders).toBe(1);
    expect(s.byWorkType.framed.normal.items).toBe(0);
    expect(s.byWorkType.framed.normal.orders).toBe(0);
    expect(s.byWorkType.a0_framed.normal.orders).toBe(0);
    expect(s.byPerson[FRAMER]).toBeUndefined();
    // Dispatch saved no per-line scans: its items are not invented from line_quantity.
    expect(s.byWorkType.dispatch.normal.items).toBe(0);
    const order = s.orders.find((o) => o.orderNumber === "5002");
    expect(order?.completedWorkTypes).toEqual(["dispatch"]);
    expect(order?.missingDetail).toBe(true);
  });

  it("framing then a shared dispatch of the same order: framing credit is the scan's, never repeated by dispatch", () => {
    const s = summarize([...sharedFramingScan([{ sku: "INKA-ABC0001-A2-FB", quantity: 2, workType: "framed" }], "5003"), sharedDispatch("5003", 2)]);
    expect(s.byPerson[FRAMER].normal.items).toBe(2);
    expect(s.byPerson[FRAMER].normal.orders).toBe(1);
    expect(s.byPerson[DISPATCHER].normal.items).toBe(0);
    expect(s.byPerson[DISPATCHER].normal.orders).toBe(1);
  });
});

describe("F7 framer columns ride alongside F1's published raw CSV", () => {
  const raw = (id: string, eventType: string): PublishedDetailRow => ({
    kind: "raw-export",
    row: { id, staffId: DISPATCHER, department: "dispatch", orderNumber: "5002", sku: null, quantity: 3, eventType, createdAtUtc: "2026-11-20T15:00:00.000000Z", parentEventId: null, caseId: null, note: "Shared scanner dispatch", stationId: STATION },
  });
  const attr = (sku: string, name: string, source: "scan" | "manual"): FramerAttribution =>
    ({ dispatch_event_id: `dsp-${RID}-d`, sku, display_name: name, source }) as FramerAttribution;

  it("header and every row gain exactly framed_by / framer_evidence; manual attribution is labelled manual", () => {
    const rows = [raw(`dsp-${RID}-d`, "dispatched"), raw("classic-1", "dispatched")];
    const byEvent = groupByEvent([attr("INKA-ABC0001-A2-FB", "=Ana", "manual"), attr("INKA-ABC0001-A0-FB", "Ben", "scan")]);
    expect(attributableEventIds(rows.map((r) => ({ id: (r.row as { id: string }).id, event_type: (r.row as { eventType: string }).eventType })))).toEqual([`dsp-${RID}-d`]);
    const header = publishedCsvHeader(ATTRIBUTION_CSV_HEADERS).split(",");
    expect(header.slice(-2)).toEqual(["framed_by", "framer_evidence"]);
    expect(header).toHaveLength(11);
    const lines = publishedCsvLines(rows, () => "Dee", (id) => attributionCsvCells(id, byEvent));
    const cells = lines.map((l) => l.split(","));
    expect(cells[0]).toHaveLength(11);
    expect(cells[0].slice(-2)).toEqual(["Ben; '=Ana", "INKA-ABC0001-A0-FB: scan; INKA-ABC0001-A2-FB: manual"]);
    expect(cells[1].slice(-2)).toEqual(["", ""]); // classic rows: empty, row count unchanged
    expect(lines).toHaveLength(2);
  });

  it("an unavailable attribution read marks shared rows 'unavailable', never blank-as-none", () => {
    const [line] = publishedCsvLines([raw(`dsp-${RID}-d`, "dispatched")], () => "Dee", (id) => attributionCsvCells(id, new Map(), true));
    expect(line.split(",").slice(-2)).toEqual(["unavailable", "unavailable"]);
  });

  it("without extra cells the F1 export is unchanged (9 columns)", () => {
    expect(publishedCsvHeader().split(",")).toHaveLength(9);
    expect(publishedCsvLines([raw("classic-1", "dispatched")], () => "Dee")[0].split(",")).toHaveLength(9);
  });
});

describe("merged pages keep F4–F7 wiring (source seams)", () => {
  const reports = readFileSync("src/pages/Reports.tsx", "utf8");
  const production = readFileSync("src/pages/Production.tsx", "utf8");

  it("Reports keeps the F4 packaging cards and F7 attribution in the legacy export and order lookup", () => {
    expect(reports).toMatch(/<PackageUsageCard[\s\S]*?<PackagingAttentionCard [\s\S]*?<PackageHistoryCard \/>/);
    const legacy = reports.slice(reports.indexOf("const handleExport = useCallback("), reports.indexOf("const handlePublishedExport = useCallback("));
    expect(legacy).toMatch(/"station_id", "note", \.\.\.ATTRIBUTION_CSV_HEADERS,/);
    expect(legacy).toMatch(/\.\.\.attributionCsvCells\(e\.id, byEvent, !attr\.ok\)/);
    expect(reports).toMatch(/fetchAttributionsForOrder\(supabaseRef\.current, location, searched\)/);
  });

  it("both packaging cards read F4 correction rows, not only negative deltas", () => {
    for (const f of ["src/components/PackageUsageCard.tsx", "src/components/PackageHistoryCard.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect(src).toMatch(/\.or\(PACKAGE_USAGE_ROWS_FILTER\)/);
      expect(src).not.toMatch(/\.lt\("delta", 0\)/);
    }
  });

  it("classic completion keeps F4 packaging (auto mode once via packaging_apply) and refreshes F1's counter without a local increment", () => {
    const body = production.slice(production.indexOf("const handleCompleteOrder = useCallback("), production.indexOf("Scrap the entire order."));
    expect(body).toMatch(/if \(packagingMode !== "auto"\) \{\s*for \(const \[pkgKey, qty\] of packages\.entries\(\)\)/);
    expect(body).toMatch(/if \(packagingCapture\) void packaging\.applyAfterEvent\(inserted, packagingCapture\);/);
    expect(body).toMatch(/refreshCounter\(\);/);
    expect(production).not.toMatch(/setTodayCount|setTodayLineUnits/);
    expect(production).toMatch(/todayCount=\{counter \? counter\.normal\.orders : null\}/);
  });
});
