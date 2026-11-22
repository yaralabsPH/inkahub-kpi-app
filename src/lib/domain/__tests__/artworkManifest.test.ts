import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ArtworkAlias } from "../artworkAliases";
import { describeArtwork, type ArtworkItem } from "../artworkIdentity";
import {
  ARTWORK_RENDERER_VERSION,
  manifestPayload,
  resolveManifest,
  revisionDigest,
  type ArtworkManifest,
  type SourceFile,
} from "../artworkManifest";

// Node crypto is injected by tests/server only; the domain module never imports it.
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function item(sku: string): ArtworkItem {
  const d = describeArtwork(sku);
  if (d.kind !== "artwork") throw new Error(`${sku} is not artwork`);
  return d;
}

let n = 0;
function file(name: string, over: Partial<SourceFile> = {}): SourceFile {
  n += 1;
  return {
    fileId: `id:${name}`,
    path: `/inka hub/${name.toLowerCase()}`,
    name,
    rev: `rev${n.toString(16).padStart(4, "0")}`,
    contentHash: `hash-${name.toUpperCase().replace(/[^A-Z0-9]/g, "")}`,
    size: 1000 + n,
    deleted: false,
    observationEpoch: 7,
    ...over,
  };
}

const set3 = () => [
  file("INKA-S3-WIL0049-01.jpg"),
  file("INKA-S3-WIL0049-02.jpg"),
  file("INKA-S3-WIL0049-03.jpg"),
];

function complete(sku: string, files: SourceFile[], aliases: ArtworkAlias[] = []): ArtworkManifest {
  const r = resolveManifest(item(sku), files, aliases);
  if (r.status !== "complete") throw new Error(`expected complete, got ${JSON.stringify(r)}`);
  return r.manifest;
}

describe("resolveManifest", () => {
  it("resolves a single print to a one-component manifest with full source identity", () => {
    const f = file("INKA-KAN0566.jpg");
    const m = complete("INKA-KAN0566-A4-FB", [f, file("INKA-KAN0567.jpg")]);
    expect(m.code).toBe("KAN0566");
    expect(m.components).toEqual([
      {
        ordinal: 1,
        fileId: f.fileId,
        path: f.path,
        name: f.name,
        rev: f.rev,
        contentHash: f.contentHash,
        size: f.size,
        deleted: false,
        observationEpoch: 7,
        matchedStem: "INKA-KAN0566",
        via: "canonical",
        duplicatePaths: [],
      },
    ]);
  });

  it("orders set components 01…N regardless of input order", () => {
    const m = complete("INKA-S3WIL0049-A2-FN", set3().reverse());
    expect(m.components.map((c) => [c.ordinal, c.name])).toEqual([
      [1, "INKA-S3-WIL0049-01.jpg"],
      [2, "INKA-S3-WIL0049-02.jpg"],
      [3, "INKA-S3-WIL0049-03.jpg"],
    ]);
  });

  it("accepts the no-separator set form and mixed observed variants", () => {
    const m = complete("INKA-S2ABC0001-A3-FW", [file("INKA-S2ABC0001-01_A3.png"), file("inka-s2-abc0001-02_FIXED")]);
    expect(m.components.map((c) => c.matchedStem)).toEqual(["INKA-S2ABC0001-01", "INKA-S2-ABC0001-02"]);
  });

  it("covers a GW six-piece and nine-piece set", () => {
    const six = Array.from({ length: 6 }, (_, i) => file(`INKA-S6-MON0012-0${i + 1}.jpg`));
    expect(complete("INKA-S6MON0012-GW-FB", six).components).toHaveLength(6);
    const nine = Array.from({ length: 9 }, (_, i) => file(`INKA-S9-XYZ0002-0${i + 1}.tif`));
    expect(complete("INKA-S9XYZ0002-A4-UN", nine).components.map((c) => c.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("reports one missing set component instead of a partial manifest", () => {
    const [a, , c] = set3();
    expect(resolveManifest(item("INKA-S3WIL0049-A2-FN"), [a, c])).toEqual({
      status: "missing",
      code: "S3WIL0049",
      missingOrdinals: [2],
    });
  });

  it("ignores deleted files", () => {
    const files = set3();
    files[0] = { ...files[0], deleted: true };
    expect(resolveManifest(item("INKA-S3WIL0049-A2-FN"), files)).toMatchObject({ status: "missing", missingOrdinals: [1] });
  });

  it("reports an empty library as missing for a product that arrived before its file", () => {
    expect(resolveManifest(item("INKA-KAN0566-A4-FB"), [])).toEqual({ status: "missing", code: "KAN0566", missingOrdinals: [1] });
  });

  it("treats two distinct live contents for one component as a conflict, whatever their rev/hash order", () => {
    const a = file("INKA-KAN0566.jpg", { contentHash: "aaaa", rev: "0001" });
    const b = file("INKA-KAN0566_FIXED.jpg", { contentHash: "ffff", rev: "ffff" });
    for (const files of [[a, b], [b, a]]) {
      const r = resolveManifest(item("INKA-KAN0566-A4-FB"), files);
      expect(r).toMatchObject({ status: "ambiguous", code: "KAN0566", missingOrdinals: [] });
      if (r.status !== "ambiguous") throw new Error("unreachable");
      expect(r.conflicts).toEqual([
        {
          ordinal: 1,
          reason: "distinct_contents",
          candidates: [
            { fileId: a.fileId, path: a.path, contentHash: "aaaa" },
            { fileId: b.fileId, path: b.path, contentHash: "ffff" },
          ],
        },
      ]);
    }
  });

  it("raises a conflict when size-labelled sources contain different artwork", () => {
    const r = resolveManifest(item("INKA-KAN0566-A1-FB"), [
      file("INKA-KAN0566_A1.jpg", { contentHash: "one" }),
      file("INKA-KAN0566_A4.jpg", { contentHash: "two" }),
    ]);
    expect(r.status).toBe("ambiguous");
  });

  it("reports ambiguity before missing components, listing both", () => {
    const r = resolveManifest(item("INKA-S3WIL0049-A2-FN"), [
      file("INKA-S3-WIL0049-01.jpg", { contentHash: "x" }),
      file("INKA-S3WIL0049-01.jpg", { contentHash: "y" }),
      file("INKA-S3-WIL0049-03.jpg"),
    ]);
    expect(r).toMatchObject({ status: "ambiguous", missingOrdinals: [2] });
  });

  it("selects one deterministic, recorded path for same-content duplicates", () => {
    const hash = "same";
    const a = file("INKA-KAN0566.jpg", { contentHash: hash, path: "/inka hub/new_skus_single_files/inka-kan0566.jpg" });
    const b = file("INKA-KAN0566 (1).jpg", { contentHash: hash, path: "/inka hub/archive/inka-kan0566 (1).jpg" });
    const first = complete("INKA-KAN0566-A4-FB", [a, b]);
    const second = complete("INKA-KAN0566-A4-FB", [b, a]);
    expect(first).toEqual(second);
    expect(first.components[0].path).toBe(b.path); // codepoint order of normalised path
    expect(first.components[0].duplicatePaths).toEqual([a.path]);
  });

  it("prefers a canonical-name duplicate over an alias with the same content", () => {
    const aliases: ArtworkAlias[] = [
      { code: "ESP", ordinal: 1, stem: "INKA-AUXESP", status: "approved", provenance: { source: "t", verifiedBy: "CJ", verifiedAt: "2026-11-22" } },
    ];
    const canonical = file("INKA-AUX-FP-ESP.jpg", { contentHash: "h", path: "/inka hub/z/inka-aux-fp-esp.jpg" });
    const alias = file("INKA-AUXESP.jpg", { contentHash: "h", path: "/inka hub/a/inka-auxesp.jpg" });
    const m = complete("INKA-AUX-FP-ESP-A2", [alias, canonical], aliases);
    expect(m.components[0]).toMatchObject({ fileId: canonical.fileId, via: "canonical", duplicatePaths: [alias.path] });
  });

  it("uses only approved aliases, with provenance recorded, and never a substring match", () => {
    const legacy = file("INKA-AUXESP.jpg");
    const near = [file("INKA-AUXESPX.jpg"), file("INKA-AUX-FP-ESPRESSO.jpg"), file("INKA-AUXIMH.jpg")];
    const sku = "INKA-AUX-FP-ESP-A2";

    expect(resolveManifest(item(sku), [legacy, ...near]).status).toBe("missing");
    const unverified: ArtworkAlias[] = [{ code: "ESP", ordinal: 1, stem: "INKA-AUXESP", status: "unverified", provenance: { source: "index v1" } }];
    expect(resolveManifest(item(sku), [legacy, ...near], unverified).status).toBe("missing");

    const provenance = { source: "audit 2026-11", verifiedBy: "CJ", verifiedAt: "2026-11-22" };
    const approved: ArtworkAlias[] = [{ code: "ESP", ordinal: 1, stem: "INKA-AUXESP", status: "approved", provenance }];
    const m = complete(sku, [legacy, ...near], approved);
    expect(m.components[0]).toMatchObject({ fileId: legacy.fileId, via: "alias", matchedStem: "INKA-AUXESP", aliasProvenance: provenance });
  });

  it("rejects an invalid alias list rather than resolving with it", () => {
    const bad: ArtworkAlias[] = [{ code: "ESP", ordinal: 1, stem: "INKA-AUXIMH", status: "approved", provenance: { source: "t", verifiedBy: "CJ", verifiedAt: "2026-11-22" } }];
    expect(() => resolveManifest(item("INKA-AUX-FP-ESP-A2"), [], bad)).toThrow(/alias/i);
  });

  it("does not let one file stand in for two set components", () => {
    const provenance = { source: "t", verifiedBy: "CJ", verifiedAt: "2026-11-22" };
    const shared = file("INKA-WIL0049-SHEET.jpg");
    const aliases: ArtworkAlias[] = [
      { code: "S2WIL0049", ordinal: 1, stem: "INKA-WIL0049-SHEET", status: "approved", provenance },
      { code: "S2WIL0049", ordinal: 2, stem: "INKA-WIL0049-SHEET", status: "approved", provenance },
    ];
    // validateAliases rejects one stem bound to two targets, so this cannot be configured.
    expect(() => resolveManifest(item("INKA-S2WIL0049-A2-FN"), [shared], aliases)).toThrow(/alias/i);
  });
});

describe("manifestPayload / revisionDigest", () => {
  const golden: ArtworkManifest = {
    code: "S2ABC0001",
    components: [
      { ordinal: 1, fileId: "id:AAA", path: "/inka hub/inka-s2-abc0001-01.jpg", name: "INKA-S2-ABC0001-01.jpg", rev: "015f1", contentHash: "c1", size: 10, deleted: false, observationEpoch: 1, matchedStem: "INKA-S2-ABC0001-01", via: "canonical", duplicatePaths: [] },
      { ordinal: 2, fileId: "id:BBB", path: "/inka hub/inka-s2-abc0001-02.jpg", name: "INKA-S2-ABC0001-02.jpg", rev: "015f2", contentHash: "c2", size: 20, deleted: false, observationEpoch: 1, matchedStem: "INKA-S2-ABC0001-02", via: "canonical", duplicatePaths: [] },
    ],
  };
  const expectedPayload = '{"format":"inka-f3-artwork-manifest","version":1,"renderer":"f3-r1","components":[[1,"id:AAA","015f1","c1"],[2,"id:BBB","015f2","c2"]]}';

  it("serialises a fixed, versioned, ordinal-ordered payload", () => {
    expect(manifestPayload(golden, "f3-r1")).toBe(expectedPayload);
    const shuffled = { ...golden, components: [...golden.components].reverse() };
    expect(manifestPayload(shuffled, "f3-r1")).toBe(expectedPayload);
  });

  it("matches a hand-derived golden SHA-256 over UTF-8 bytes", () => {
    const golden_hex = "88ebb281880c494b4b426ef9849b5bfe0b84b1dc3045538f58f1f2504ddd8131";
    expect(createHash("sha256").update(expectedPayload, "utf8").digest("hex")).toBe(golden_hex);
    expect(revisionDigest(golden, "f3-r1", sha256)).toBe(golden_hex);
  });

  it("is stable despite input arrival order and ignores non-identity metadata", () => {
    const files = set3();
    const a = complete("INKA-S3WIL0049-A2-FN", files);
    const b = complete("INKA-S3WIL0049-A2-FN", [files[2], files[0], files[1]].map((f) => ({ ...f, observationEpoch: 99, size: 1 })));
    expect(revisionDigest(a, ARTWORK_RENDERER_VERSION, sha256)).toBe(revisionDigest(b, ARTWORK_RENDERER_VERSION, sha256));
  });

  it("changes when only component 02 is replaced, or any id/rev/hash/renderer changes", () => {
    const files = set3();
    const base = revisionDigest(complete("INKA-S3WIL0049-A2-FN", files), ARTWORK_RENDERER_VERSION, sha256);
    const digests = new Set([base]);
    const replace = (i: number, over: Partial<SourceFile>) =>
      revisionDigest(complete("INKA-S3WIL0049-A2-FN", files.map((f, j) => (j === i ? { ...f, ...over } : f))), ARTWORK_RENDERER_VERSION, sha256);

    const component02 = replace(1, { rev: "new-rev", contentHash: "new-bytes" });
    digests.add(component02);
    digests.add(replace(1, { rev: "only-rev" }));
    digests.add(replace(1, { contentHash: "only-hash" }));
    digests.add(replace(0, { fileId: "id:moved" }));
    digests.add(revisionDigest(complete("INKA-S3WIL0049-A2-FN", files), "f3-r2", sha256));
    expect(digests.size).toBe(6);
  });

  it("refuses a manifest that does not contain every ordinal 1…N exactly once", () => {
    const [one, two] = golden.components;
    expect(() => manifestPayload({ ...golden, components: [one, one] }, "f3-r1")).toThrow(/ordinal/);
    expect(() => manifestPayload({ ...golden, components: [two] }, "f3-r1")).toThrow(/ordinal/);
    expect(() => manifestPayload({ ...golden, components: [] }, "f3-r1")).toThrow(/ordinal/);
    expect(() => manifestPayload({ ...golden, components: [{ ...one, deleted: true }, two] }, "f3-r1")).toThrow(/deleted/);
    expect(() => manifestPayload({ ...golden, components: [{ ...one, rev: "" }, two] }, "f3-r1")).toThrow(/rev/);
    expect(() => manifestPayload(golden, "")).toThrow(/renderer/);
  });

  it("rejects an injected hash function that does not return SHA-256 hex", () => {
    expect(() => revisionDigest(golden, "f3-r1", () => "not-a-digest")).toThrow(/SHA-256/);
  });
});
