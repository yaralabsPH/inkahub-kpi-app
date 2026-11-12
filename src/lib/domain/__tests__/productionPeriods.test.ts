import { afterEach, describe, expect, it } from "vitest";
import {
  isInProductionRange,
  isProductionDate,
  productionDateAt,
  productionDatesBetween,
  productionRange,
  productionWeekStart,
  ProductionPeriodError,
  shiftProductionDate,
  type ReportSite,
} from "../productionPeriods";

const HOURS = 3_600_000;
const span = (site: ReportSite, d: string) => {
  const r = productionRange(site, d, d);
  return (Date.parse(r.endUtcExclusive) - Date.parse(r.startUtc)) / HOURS;
};

describe("ordinary production days", () => {
  it("AU/UK/US day windows start and end at local 04:00", () => {
    expect(productionRange("au", "2026-06-10", "2026-06-10")).toEqual({
      site: "au",
      timeZone: "Australia/Sydney",
      firstDate: "2026-06-10",
      lastDate: "2026-06-10",
      startUtc: "2026-06-09T18:00:00.000Z",
      endUtcExclusive: "2026-06-10T18:00:00.000Z",
    });
    expect(productionRange("uk", "2026-01-15", "2026-01-15")).toMatchObject({
      startUtc: "2026-01-15T04:00:00.000Z",
      endUtcExclusive: "2026-01-16T04:00:00.000Z",
    });
    expect(productionRange("us", "2026-01-15", "2026-01-15")).toMatchObject({
      startUtc: "2026-01-15T10:00:00.000Z",
      endUtcExclusive: "2026-01-16T10:00:00.000Z",
    });
  });

  it("03:59:59 local belongs to the previous production date, 04:00 starts the new one", () => {
    // UK winter: local == UTC.
    expect(productionDateAt(new Date("2026-01-15T03:59:59.999Z"), "uk")).toBe("2026-01-14");
    expect(productionDateAt(new Date("2026-01-15T04:00:00.000Z"), "uk")).toBe("2026-01-15");
    // AU winter: UTC+10, so local 04:00 on the 15th is 18:00Z on the 14th.
    expect(productionDateAt(new Date("2026-06-14T17:59:59Z"), "au")).toBe("2026-06-14");
    expect(productionDateAt(new Date("2026-06-14T18:00:00Z"), "au")).toBe("2026-06-15");
    // US winter: UTC-6.
    expect(productionDateAt(new Date("2026-01-15T09:59:59Z"), "us")).toBe("2026-01-14");
    expect(productionDateAt(new Date("2026-01-15T10:00:00Z"), "us")).toBe("2026-01-15");
  });

  it("midnight to 04:00 local still counts as the previous production date", () => {
    expect(productionDateAt(new Date("2026-01-15T00:00:00Z"), "uk")).toBe("2026-01-14");
    expect(productionDateAt(new Date("2026-01-15T02:30:00Z"), "uk")).toBe("2026-01-14");
  });

  it("isInProductionRange is half-open", () => {
    const r = productionRange("uk", "2026-01-15", "2026-01-15");
    expect(isInProductionRange("2026-01-15T04:00:00Z", r)).toBe(true);
    expect(isInProductionRange("2026-01-16T03:59:59.999Z", r)).toBe(true);
    expect(isInProductionRange("2026-01-16T04:00:00Z", r)).toBe(false);
    expect(isInProductionRange("2026-01-15T03:59:59Z", r)).toBe(false);
    expect(isInProductionRange("not a date", r)).toBe(false);
  });
});

describe("DST transitions", () => {
  it("UK spring and autumn (plan examples)", () => {
    expect(productionRange("uk", "2026-03-28", "2026-03-28")).toMatchObject({
      startUtc: "2026-03-28T04:00:00.000Z",
      endUtcExclusive: "2026-03-29T03:00:00.000Z",
    });
    expect(productionRange("uk", "2026-10-24", "2026-10-24")).toMatchObject({
      startUtc: "2026-10-24T03:00:00.000Z",
      endUtcExclusive: "2026-10-25T04:00:00.000Z",
    });
    expect(span("uk", "2026-03-28")).toBe(23);
    expect(span("uk", "2026-10-24")).toBe(25);
  });

  it("AU autumn (DST ends 5 Apr) and spring (DST starts 4 Oct)", () => {
    expect(productionRange("au", "2026-04-04", "2026-04-04")).toMatchObject({
      startUtc: "2026-04-03T17:00:00.000Z",
      endUtcExclusive: "2026-04-04T18:00:00.000Z",
    });
    expect(productionRange("au", "2026-10-03", "2026-10-03")).toMatchObject({
      startUtc: "2026-10-02T18:00:00.000Z",
      endUtcExclusive: "2026-10-03T17:00:00.000Z",
    });
    expect(span("au", "2026-04-04")).toBe(25);
    expect(span("au", "2026-10-03")).toBe(23);
  });

  it("US spring (8 Mar) and autumn (1 Nov)", () => {
    expect(productionRange("us", "2026-03-07", "2026-03-07")).toMatchObject({
      startUtc: "2026-03-07T10:00:00.000Z",
      endUtcExclusive: "2026-03-08T09:00:00.000Z",
    });
    expect(productionRange("us", "2026-10-31", "2026-10-31")).toMatchObject({
      startUtc: "2026-10-31T09:00:00.000Z",
      endUtcExclusive: "2026-11-01T10:00:00.000Z",
    });
    expect(span("us", "2026-03-07")).toBe(23);
    expect(span("us", "2026-10-31")).toBe(25);
  });

  it("instants either side of a DST boundary map to the right production date", () => {
    expect(productionDateAt(new Date("2026-03-29T02:59:59Z"), "uk")).toBe("2026-03-28");
    expect(productionDateAt(new Date("2026-03-29T03:00:00Z"), "uk")).toBe("2026-03-29");
    expect(productionDateAt(new Date("2026-10-25T03:59:59Z"), "uk")).toBe("2026-10-24");
    expect(productionDateAt(new Date("2026-10-25T04:00:00Z"), "uk")).toBe("2026-10-25");
  });

  it("ordinary days at every site are exactly 24 hours", () => {
    for (const site of ["au", "uk", "us"] as const) expect(span(site, "2026-07-01")).toBe(24);
  });
});

describe("ranges, weeks and calendar steps", () => {
  it("a multi-day range ends at 04:00 after its final date (inclusive custom end)", () => {
    expect(productionRange("uk", "2026-01-01", "2026-01-07")).toMatchObject({
      startUtc: "2026-01-01T04:00:00.000Z",
      endUtcExclusive: "2026-01-08T04:00:00.000Z",
    });
  });

  it("ranges across a DST change convert each boundary independently", () => {
    const r = productionRange("uk", "2026-03-27", "2026-03-30");
    expect(r.startUtc).toBe("2026-03-27T04:00:00.000Z");
    expect(r.endUtcExclusive).toBe("2026-03-31T03:00:00.000Z");
  });

  it("Monday-start weeks", () => {
    expect(productionWeekStart("2026-11-12")).toBe("2026-11-09"); // Thursday
    expect(productionWeekStart("2026-11-09")).toBe("2026-11-09"); // Monday
    expect(productionWeekStart("2026-11-15")).toBe("2026-11-09"); // Sunday
    expect(productionWeekStart("2027-01-01")).toBe("2026-12-28"); // across year end
  });

  it("calendar steps cross month, year and leap days", () => {
    expect(shiftProductionDate("2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftProductionDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftProductionDate("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftProductionDate("2028-03-01", -1)).toBe("2028-02-29");
    expect(shiftProductionDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftProductionDate("2026-11-12", -7)).toBe("2026-11-05");
    expect(productionDatesBetween("2026-12-30", "2027-01-02")).toEqual([
      "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02",
    ]);
  });
});

describe("validation", () => {
  it("rejects invalid calendar input", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "2026-1-5", "20260105", "", "2026-02-29", null, 20260105]) {
      expect(isProductionDate(bad)).toBe(false);
      expect(() => productionRange("uk", bad as string, "2026-03-01")).toThrow(ProductionPeriodError);
    }
    expect(isProductionDate("2028-02-29")).toBe(true);
  });

  it("rejects reversed ranges", () => {
    expect(() => productionRange("uk", "2026-03-02", "2026-03-01")).toThrow(ProductionPeriodError);
    expect(() => productionDatesBetween("2026-03-02", "2026-03-01")).toThrow(ProductionPeriodError);
  });

  it("unsupported sites have no guessed timezone", () => {
    for (const site of ["default", "staging", "AU", "", undefined]) {
      expect(() => productionRange(site as ReportSite, "2026-03-01", "2026-03-01")).toThrow(ProductionPeriodError);
      expect(() => productionDateAt(new Date(), site as ReportSite)).toThrow(ProductionPeriodError);
    }
  });

  it("rejects invalid instants", () => {
    expect(() => productionDateAt(new Date("nope"), "uk")).toThrow(ProductionPeriodError);
  });
});

describe("host timezone independence", () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it("gives identical results under different host timezones", () => {
    const sample = () => ({
      r: (["au", "uk", "us"] as const).map((s) => productionRange(s, "2026-03-07", "2026-04-05")),
      d: (["au", "uk", "us"] as const).map((s) => productionDateAt(new Date("2026-03-29T02:59:59Z"), s)),
      w: productionWeekStart("2026-03-29"),
      x: shiftProductionDate("2026-03-28", 1),
    });
    process.env.TZ = "UTC";
    const base = sample();
    for (const tz of ["Pacific/Kiritimati", "America/Los_Angeles", "Asia/Kolkata", "Australia/Sydney"]) {
      process.env.TZ = tz;
      expect(sample(), tz).toEqual(base);
    }
  });
});
