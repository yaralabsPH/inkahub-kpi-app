import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_ALIAS_STEMS,
  LEGACY_ALIAS_CANDIDATES,
  approvedAliasesFor,
  isCandidateName,
  validateAliases,
  type ArtworkAlias,
} from "../artworkAliases";

const verified = { source: "test fixture", verifiedBy: "CJ", verifiedAt: "2026-11-22T00:00:00Z" };

describe("isCandidateName — exact grammar", () => {
  const stem = "INKA-KAN0566";

  it.each([
    "INKA-KAN0566",
    "INKA-KAN0566.jpg",
    "INKA-KAN0566.JPG",
    "INKA-KAN0566.jpeg",
    "INKA-KAN0566.png",
    "INKA-KAN0566.tif",
    "INKA-KAN0566.tiff",
    "INKA-KAN0566.webp",
    "inka-kan0566.jpg",
    "INKA-KAN0566.jpg.jpg",
    "INKA-KAN0566.PNG.png",
    "INKA-KAN0566_FIXED.jpg",
    "INKA-KAN0566_fixed",
    "INKA-KAN0566_A1.jpg",
    "INKA-KAN0566_5A3.jpg",
    "INKA-KAN0566_50X70.png",
    "INKA-KAN0566 (1).jpg",
    "INKA-KAN0566_A1_FIXED (12).tiff",
  ])("accepts %s", (name) => {
    expect(isCandidateName(name, stem)).toBe(true);
  });

  it.each([
    "INKA-KAN05661.jpg",
    "INKA-KAN0566A.jpg",
    "INKA-KAN056.jpg",
    "XINKA-KAN0566.jpg",
    "OLD INKA-KAN0566.jpg",
    "INKA-KAN0566.jpg.png",
    "INKA-KAN0566.jpg.jpg.jpg",
    "INKA-KAN0566.gif",
    "INKA-KAN0566.pdf",
    "INKA-KAN0566.psd",
    "INKA-KAN0566.",
    "INKA-KAN0566-copy.jpg",
    "INKA-KAN0566 copy.jpg",
    "INKA-KAN0566_A5.jpg",
    "INKA-KAN0566_FIXED_A1.jpg",
    "INKA-KAN0566 (123).jpg",
    "INKA-KAN0566.jpg ",
    "folder/INKA-KAN0566.jpg",
    "",
  ])("rejects near miss %j", (name) => {
    expect(isCandidateName(name, stem)).toBe(false);
  });

  it("requires the exact set ordinal", () => {
    expect(isCandidateName("INKA-S3-WIL0049-01.jpg", "INKA-S3-WIL0049-01")).toBe(true);
    expect(isCandidateName("INKA-S3-WIL0049-01_A2.jpg", "INKA-S3-WIL0049-01")).toBe(true);
    expect(isCandidateName("INKA-S3-WIL0049-1.jpg", "INKA-S3-WIL0049-01")).toBe(false);
    expect(isCandidateName("INKA-S3-WIL0049-010.jpg", "INKA-S3-WIL0049-01")).toBe(false);
    expect(isCandidateName("INKA-S3-WIL0049-02.jpg", "INKA-S3-WIL0049-01")).toBe(false);
    expect(isCandidateName("INKA-S3-WIL0049.jpg", "INKA-S3-WIL0049-01")).toBe(false);
  });

  it("treats the stem literally, not as a pattern", () => {
    expect(isCandidateName("INKAXKAN0566.jpg", "INKA.KAN0566")).toBe(false);
  });
});

describe("approved aliases", () => {
  const esp: ArtworkAlias = { code: "ESP", ordinal: 1, stem: "INKA-AUXESP", status: "approved", provenance: verified };

  it("returns only approved aliases for the exact code and ordinal", () => {
    const aliases: ArtworkAlias[] = [
      esp,
      { code: "MCO", ordinal: 1, stem: "INKA-AUXMCO", status: "unverified", provenance: { source: "index v1" } },
      { code: "ESP", ordinal: 2, stem: "INKA-AUXESP2", status: "approved", provenance: verified },
    ];
    expect(approvedAliasesFor("ESP", 1, aliases)).toEqual([esp]);
    expect(approvedAliasesFor("MCO", 1, aliases)).toEqual([]);
    expect(approvedAliasesFor("esp", 1, aliases)).toEqual([esp]);
  });

  it("accepts a well-formed approved alias list", () => {
    expect(validateAliases([esp])).toEqual({ ok: true });
    expect(validateAliases([])).toEqual({ ok: true });
  });

  it("never lets printed inserts AUXIMH/AUXMFL become a free-print alias", () => {
    expect(FORBIDDEN_ALIAS_STEMS).toEqual(expect.arrayContaining(["INKA-AUXIMH", "INKA-AUXMFL"]));
    for (const stem of ["INKA-AUXIMH", "inka-auxmfl"]) {
      const r = validateAliases([{ code: "IMH", ordinal: 1, stem, status: "approved", provenance: verified }]);
      expect(r.ok).toBe(false);
    }
    // Even unverified, a forbidden stem is a data error.
    expect(validateAliases([{ code: "IMH", ordinal: 1, stem: "INKA-AUXIMH", status: "unverified", provenance: { source: "x" } }]).ok).toBe(false);
  });

  it("rejects approval without provenance, bad ordinals and one stem bound to two targets", () => {
    expect(validateAliases([{ ...esp, provenance: { source: "index v1" } }]).ok).toBe(false);
    expect(validateAliases([{ ...esp, ordinal: 0 }]).ok).toBe(false);
    expect(validateAliases([{ ...esp, ordinal: 10 }]).ok).toBe(false);
    expect(validateAliases([{ ...esp, stem: "INKA AUX/ESP" }]).ok).toBe(false);
    expect(validateAliases([esp, { ...esp, code: "MCO" }]).ok).toBe(false);
    expect(validateAliases([esp, { ...esp, stem: "inka-auxesp" }]).ok).toBe(true); // same target, case-only duplicate
  });

  it("ships the legacy candidates from the index disabled until audited", () => {
    expect(LEGACY_ALIAS_CANDIDATES.length).toBeGreaterThan(0);
    expect(LEGACY_ALIAS_CANDIDATES.every((a) => a.status === "unverified")).toBe(true);
    expect(validateAliases(LEGACY_ALIAS_CANDIDATES)).toEqual({ ok: true });
    expect(approvedAliasesFor("ESP", 1, LEGACY_ALIAS_CANDIDATES)).toEqual([]);
  });
});
