/** F9 frame timing reference math (pure). */
import { describe, expect, it } from "vitest";
import { captureKey, computeFrameTiming, frameTimingCsv, validateWeights, type TimingStreamRow, type WeightSet } from "../../src/lib/domain/frameTimingReport";
import { csvCell } from "../../src/lib/domain/reportsOverview";

const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const RID = "0123456789abcdef0123456789abcdef";
const A1 = "INKA-ABC0001-A1-FB";
const A2 = "INKA-ABC0002-A2-FB";
const A3 = "INKA-ABC0003-A3-FN";
const SET3 = "INKA-S3WIL0049-A3-FN";
const UN = "INKA-HIG0207-A3-UN";
const CUT = "2026-11-20T23:00:00Z";
const t = (hm: string) => `2026-11-20T${hm}:00Z`;
let n = 0;
const v = (at: string, sku: string, pieces: number, over: Partial<TimingStreamRow> = {}): TimingStreamRow => ({
  id: `e${++n}`, staffId: W1, at: t(at), productionDate: "2026-11-20", kind: "verify", workType: "framed", sku, pieces, effective: true, rework: false, departmentId: null, stationId: null, ...over,
});
const SHARED = "shared:rcv-1:scn-1";
const clock = (at: string, kind: "clock_in" | "clock_out", over: Partial<TimingStreamRow> = {}): TimingStreamRow => ({
  id: `c${++n}`, staffId: W1, at: t(at), productionDate: "2026-11-20", kind, workType: null, sku: null, pieces: 0, effective: true, rework: false, departmentId: null, stationId: null, ...over,
});
const group = (b: ReturnType<typeof computeFrameTiming>, key: string, rework = false) => b.groups.find((g) => g.key === key && g.rework === rework)!;

describe("scan-gap measurement", () => {
  it("one shared capture with several lines is one gap, split by pieces (3 min over 2 and 1 pieces)", () => {
    expect(captureKey(`scn-${RID}-v01`, SHARED)).toBe(captureKey(`scn-${RID}-v02`, SHARED));
    expect(captureKey(`scn-${RID}-c-framed`, SHARED)).not.toBe(captureKey(`scn-${RID}-v01`, SHARED));
    const rows = [v("09:00", A3, 1), v("09:03", A3, 2, { id: `scn-${RID}-v01`, stationId: SHARED }), v("09:03", "INKA-ABC0009-A3-FB", 1, { id: `scn-${RID}-v02`, stationId: SHARED })];
    const b = computeFrameTiming(rows, null, CUT);
    expect(group(b, "A3-FN").timedPieces).toBe(2);
    expect(group(b, "A3-FN").measuredMinutes).toBeCloseTo(2);
    expect(group(b, "A3-FB").measuredMinutes).toBeCloseTo(1);
    expect(b.coverage.timedPieces).toBe(3); // the first capture is untimed; the shared lines never make a zero gap
  });
  it("review r1 #1: classic rows with scanner-like ids are separate captures (only the first 09:03 piece is timed, 3 min)", () => {
    const rows = [v("09:00", A3, 1, { stationId: "bench-2" }), v("09:03", A3, 1, { id: `scn-${RID}-v01`, stationId: "bench-2" }), v("09:03", A3, 1, { id: `scn-${RID}-v02`, stationId: "bench-2" })];
    const g = group(computeFrameTiming(rows, null, CUT), "A3-FN");
    expect(g.timedPieces).toBe(1);
    expect(g.measuredMinutes).toBeCloseTo(3);
    expect(captureKey(`scn-${RID}-v01`, null)).toBe(`evt:scn-${RID}-v01`);
  });
  it("the same request id on two different shared stations is two captures", () => {
    expect(captureKey(`scn-${RID}-v01`, SHARED)).not.toBe(captureKey(`scn-${RID}-v01`, "shared:rcv-2:scn-9"));
  });
  it("exactly 30 minutes is timed, 30 min + 1 s, zero and the first capture are not", () => {
    const b = computeFrameTiming([v("09:00", A3, 1), v("09:30", A3, 1), { ...v("09:30", A3, 1), at: "2026-11-20T10:00:01Z" }, v("10:30", A3, 1, { at: "2026-11-20T10:00:01Z" })], null, CUT);
    expect(group(b, "A3-FN").timedPieces).toBe(1);
    expect(group(b, "A3-FN").measuredMinutes).toBeCloseTo(30);
  });
  it("a worker's stream runs across scanners/stations; another worker never links in", () => {
    const b = computeFrameTiming([v("09:00", A3, 1, { id: `scn-${RID}-v01`, stationId: SHARED }), v("09:05", A3, 1), v("09:07", A3, 1, { staffId: W2 })], null, CUT);
    expect(group(b, "A3-FN").timedPieces).toBe(1);
    expect(group(b, "A3-FN").measuredMinutes).toBeCloseTo(5);
  });
  it("clock-in/out, an UN or accessory verification and a dispatch verification break the chain; a cancelled scan does not", () => {
    const rows = [
      v("09:00", A3, 1), clock("09:01", "clock_out"), clock("09:02", "clock_in"), v("09:04", A3, 1), // break: clock
      v("09:10", UN, 0, { workType: "unframed" }), v("09:12", A3, 1), // break: UN work in between
      v("09:20", A3, 1, { workType: "dispatch" }), v("09:22", A3, 1), // break: dispatch verification of a frame line
      v("09:25", A3, 1, { effective: false }), v("09:27", A3, 1), // a cancelled scan is ignored: 09:22 -> 09:27 = 5
    ];
    const b = computeFrameTiming(rows, null, CUT);
    const g = group(b, "A3-FN");
    expect(g.timedPieces).toBe(1);
    expect(g.measuredMinutes).toBeCloseTo(5);
    expect(g.pieces).toBe(5); // frame pieces: 09:00, 09:04, 09:12, 09:22, 09:27 (dispatch and cancelled are not framing)
  });
  it("no gap crosses the 04:00 production-day boundary", () => {
    const b = computeFrameTiming([v("03:50", A3, 1, { productionDate: "2026-11-19" }), v("04:05", A3, 1)], null, CUT);
    expect(b.coverage.timedPieces).toBe(0);
  });
  it("sets count their pieces; rework is a separate group; UN and manual attribution add no timing credit", () => {
    const b = computeFrameTiming([v("09:00", A3, 1), v("09:06", SET3, 3), v("09:09", A3, 1, { rework: true })], null, CUT);
    expect(group(b, "A3-FN").timedPieces).toBe(3);
    expect(group(b, "A3-FN").measuredAvg).toBeCloseTo(2); // 6 min over 3 set pieces
    expect(group(b, "A3-FN", true).measuredMinutes).toBeCloseTo(3);
    expect(b.groups.some((g) => g.key.endsWith("-UN"))).toBe(false);
  });
  it("filters never change adjacency: the filtered person/department keeps the gaps computed on the whole stream", () => {
    const rows = [v("09:00", A3, 1, { departmentId: "dA" }), v("09:05", A3, 1, { departmentId: "dB" })];
    const onlyB = computeFrameTiming(rows, null, CUT, { departmentId: "dB" });
    expect(group(onlyB, "A3-FN").measuredMinutes).toBeCloseTo(5);
    expect(computeFrameTiming(rows, null, CUT, { workType: "a0_framed" }).groups).toEqual([]);
  });
});

describe("Max-method estimates", () => {
  const W: WeightSet = { version: 3, weights: { A1: 2, A2: 1, A3: 1 } };
  it("spec example: 450 min shift -> 405 productive, 60 measured, 345 split 230/115 by weight", () => {
    const rows = [
      clock("08:00", "clock_in"),
      v("08:10", A1, 1), // first capture: unmeasured
      v("08:25", A3, 1), v("08:40", A3, 1), v("08:55", A3, 1), v("09:10", A3, 1), // 4 gaps of 15 = 60 measured
      v("12:00", A2, 1), // gap > 30 min: unmeasured
      clock("15:30", "clock_out"), // 450 minutes
    ];
    const b = computeFrameTiming(rows, W, CUT);
    expect(group(b, "A3-FN").measuredMinutes).toBeCloseTo(60);
    expect(group(b, "A3-FN").estimatedPieces).toBe(0);
    expect(group(b, "A1-FB").estimatedMinutes).toBeCloseTo(230);
    expect(group(b, "A2-FB").estimatedMinutes).toBeCloseTo(115);
    expect(group(b, "A1-FB").measuredAvg).toBeNull(); // never blended
    expect(b.coverage.shifts).toBe(1);
  });
  it("a 225-minute shift has 202.5 productive minutes; attendance above 450 is capped", () => {
    const short = computeFrameTiming([clock("08:00", "clock_in"), v("09:00", A2, 1), clock("11:45", "clock_out")], W, CUT);
    expect(group(short, "A2-FB").estimatedMinutes).toBeCloseTo(202.5);
    const long = computeFrameTiming([clock("06:00", "clock_in"), v("09:00", A2, 1), clock("20:00", "clock_out")], W, CUT);
    expect(group(long, "A2-FB").estimatedMinutes).toBeCloseTo(405);
  });
  it("measured minutes are never allocated again; a fully measured shift gets no estimate", () => {
    const b = computeFrameTiming([clock("08:00", "clock_in"), v("08:10", A3, 1), v("08:20", A3, 1), clock("08:30", "clock_out")], W, CUT);
    const g = group(b, "A3-FN");
    expect(g.measuredMinutes).toBeCloseTo(10);
    expect(g.estimatedMinutes).toBeCloseTo(17); // 30*0.9 = 27 - 10 measured, only to the unmeasured first piece
    expect(g.estimatedPieces).toBe(1);
  });
  it("a missing weight makes the whole shift's allocation unavailable (no partial denominator)", () => {
    const b = computeFrameTiming([clock("08:00", "clock_in"), v("09:00", A1, 1), v("10:00", "INKA-ABC0004-A0-FB", 1, { workType: "a0_framed" }), clock("12:00", "clock_out")], W, CUT);
    expect(group(b, "A1-FB").estimatedPieces).toBe(0);
    expect(group(b, "A1-FB").unavailablePieces).toBe(1);
    expect(b.coverage.missingWeightSizes).toEqual(["A0"]);
    expect(b.coverage.missingWeightPieces).toBe(2);
  });
  it("no attendance, an unclosed or cross-day shift, or a clock after the cutoff gives no estimate", () => {
    const none = computeFrameTiming([v("09:00", A1, 1)], W, CUT);
    expect(none.coverage.noAttendancePieces).toBe(1);
    const open = computeFrameTiming([clock("08:00", "clock_in"), v("09:00", A1, 1)], W, CUT);
    expect(open.coverage.malformedAttendanceDays).toBe(1);
    expect(open.coverage.estimatedPieces).toBe(0);
    const late = computeFrameTiming([clock("08:00", "clock_in"), v("09:00", A1, 1), clock("23:30", "clock_out")], W, CUT);
    expect(late.coverage.estimatedPieces).toBe(0);
    const noWeights = computeFrameTiming([clock("08:00", "clock_in"), v("09:00", A1, 1), clock("10:00", "clock_out")], null, CUT);
    expect(noWeights.coverage.missingWeightPieces).toBe(1);
  });
  it("estimates are computed on the full shift before filters", () => {
    const rows = [clock("08:00", "clock_in"), v("09:00", A1, 1, { departmentId: "dA" }), v("10:00", A2, 1, { departmentId: "dB" }), clock("13:00", "clock_out")];
    const all = computeFrameTiming(rows, W, CUT);
    const onlyB = computeFrameTiming(rows, W, CUT, { departmentId: "dB" });
    expect(group(onlyB, "A2-FB").estimatedMinutes).toBeCloseTo(group(all, "A2-FB").estimatedMinutes);
    expect(group(all, "A2-FB").estimatedMinutes).toBeCloseTo(90); // 300*0.9 = 270 split 2:1
  });
});

describe("review r1 follow-ups", () => {
  it("shift/clock/weight diagnostics are scoped to the selected person; timing stays whole-stream", () => {
    const rows = [clock("08:00", "clock_in"), v("09:00", A1, 1), clock("12:00", "clock_out"), v("09:00", A3, 1, { staffId: W2 })]; // W2: no clock pair, no A3 weight
    const W: WeightSet = { version: 1, weights: { A1: 2 } };
    const all = computeFrameTiming(rows, W, CUT);
    expect(all.coverage.shifts).toBe(1);
    const onlyW1 = computeFrameTiming(rows, W, CUT, { staffId: W1 });
    expect(onlyW1.coverage).toMatchObject({ shifts: 1, malformedAttendanceDays: 0, missingWeightSizes: [], noAttendancePieces: 0 });
    const onlyW2 = computeFrameTiming(rows, W, CUT, { staffId: W2 });
    expect(onlyW2.coverage).toMatchObject({ shifts: 0, noAttendancePieces: 1 });
  });
  it("an empty (cleared) version makes every estimate unavailable and says so in the CSV", () => {
    const b = computeFrameTiming([clock("08:00", "clock_in"), v("09:00", A1, 1), clock("12:00", "clock_out")], { version: 5, weights: {} }, CUT);
    expect(b.coverage.estimatedPieces).toBe(0);
    expect(b.coverage.missingWeightPieces).toBe(1);
    expect(frameTimingCsv(b, { site: "au", firstDate: "x", lastDate: "x", generationId: "g", sourceCutoffUtc: CUT, filters: "" }, csvCell)).toContain("version 5 is empty");
    expect(validateWeights({}, { allowEmpty: true })).toEqual({});
    expect(() => validateWeights({})).toThrow();
  });
});

describe("weights and CSV", () => {
  it("weights: known sizes only, positive finite, bounded, at least one", () => {
    expect(validateWeights({ A1: 2, GW: 0.5 })).toEqual({ A1: 2, GW: 0.5 });
    for (const bad of [{}, { A9: 1 }, { A1: 0 }, { A1: -1 }, { A1: Number.NaN }, { A1: Infinity }, { A1: 1001 }, { A1: "2" }, [], null]) expect(() => validateWeights(bad)).toThrow();
  });
  it("CSV labels both methods and the weights version, and escapes formula cells", () => {
    const b = computeFrameTiming([v("09:00", A3, 1), v("09:05", A3, 1)], { version: 4, weights: { A3: 1 } }, CUT);
    const csv = frameTimingCsv(b, { site: "au", firstDate: "2026-11-20", lastDate: "2026-11-20", generationId: "g", sourceCutoffUtc: CUT, filters: "=evil" }, csvCell);
    expect(csv).toContain("scan gap");
    expect(csv).toContain("size weights version 4");
    expect(csv).toContain("filters,'=evil");
    expect(csv).toContain("A3-FN,normal,2,1,5,5,1,0,0,,1");
    const none = frameTimingCsv(computeFrameTiming([], null, CUT), { site: "au", firstDate: "x", lastDate: "x", generationId: "g", sourceCutoffUtc: CUT, filters: "" }, csvCell);
    expect(none).toContain("unavailable (no size weights");
  });
});
