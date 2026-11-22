import { describe, expect, it } from "vitest";
import {
  ARTWORK_IMAGE_LIMITS,
  setCellLayout,
  validateArtworkImage,
  validateReducedOutput,
} from "../artworkImagePolicy";

const ok = { format: "jpeg", width: 4000, height: 6000, channels: 3, depth: "uchar", pages: 1 };

describe("validateArtworkImage", () => {
  it("accepts each supported format by decoded content", () => {
    for (const format of ["jpeg", "png", "webp", "tiff", "JPEG"]) {
      expect(validateArtworkImage({ ...ok, format }).ok).toBe(true);
    }
  });

  it("rejects untested formats, including ones Sharp can decode", () => {
    for (const format of ["gif", "svg", "heif", "raw", "", undefined]) {
      const r = validateArtworkImage({ ...ok, format });
      expect(r).toMatchObject({ ok: false, reason: "unsupported_format" });
    }
  });

  it("enforces the 300 MP pixel ceiling with no JPEG exception", () => {
    expect(validateArtworkImage({ ...ok, width: 15000, height: 20000 }).ok).toBe(true); // exactly 300 MP
    expect(validateArtworkImage({ ...ok, width: 15000, height: 20001 })).toMatchObject({ ok: false, reason: "too_many_pixels" });
    expect(validateArtworkImage({ ...ok, width: 20000, height: 25000 })).toMatchObject({ ok: false, reason: "too_many_pixels" }); // 500 MP JPEG
  });

  it("enforces the 150 MB source ceiling when size is known", () => {
    expect(validateArtworkImage({ ...ok, size: 150_000_000 }).ok).toBe(true);
    expect(validateArtworkImage({ ...ok, size: 150_000_001 })).toMatchObject({ ok: false, reason: "too_many_bytes" });
    expect(validateArtworkImage({ ...ok, size: Number.NaN })).toMatchObject({ ok: false, reason: "too_many_bytes" });
  });

  it("rejects missing, zero, fractional and unsafe dimensions", () => {
    for (const [width, height] of [[0, 10], [10, undefined], [1.5, 10], [-4, 10], [Number.MAX_SAFE_INTEGER + 1, 1]]) {
      expect(validateArtworkImage({ ...ok, width, height })).toMatchObject({ ok: false, reason: "invalid_dimensions" });
    }
  });

  it("rejects multipage TIFFs and animations", () => {
    expect(validateArtworkImage({ ...ok, format: "tiff", pages: 3 })).toMatchObject({ ok: false, reason: "multipage_or_animated" });
    expect(validateArtworkImage({ ...ok, format: "webp", pages: 12 })).toMatchObject({ ok: false, reason: "multipage_or_animated" });
    expect(validateArtworkImage({ ...ok, pages: undefined }).ok).toBe(true);
  });

  it("accepts 8- and 16-bit samples and estimates decode size from depth", () => {
    const eight = validateArtworkImage({ ...ok, channels: 4, depth: "uchar" });
    const sixteen = validateArtworkImage({ ...ok, channels: 4, depth: "ushort" });
    expect(eight.ok && eight.estimatedDecodeBytes).toBe(4000 * 6000 * 4);
    expect(sixteen.ok && sixteen.estimatedDecodeBytes).toBe(4000 * 6000 * 4 * 2);
  });

  it("rejects float/32-bit depths and odd channel counts", () => {
    for (const depth of ["float", "double", "uint", "complex"]) {
      expect(validateArtworkImage({ ...ok, depth })).toMatchObject({ ok: false, reason: "unsupported_depth" });
    }
    for (const channels of [0, 5, undefined]) {
      expect(validateArtworkImage({ ...ok, channels })).toMatchObject({ ok: false, reason: "unsupported_channels" });
    }
  });
});

describe("validateReducedOutput", () => {
  it("accepts a JPEG within 400 px and 75,000 bytes", () => {
    expect(validateReducedOutput({ format: "jpeg", width: 267, height: 400, bytes: 75_000 }).ok).toBe(true);
  });

  it("rejects non-JPEG, oversize, overweight and empty output", () => {
    expect(validateReducedOutput({ format: "png", width: 100, height: 100, bytes: 100 })).toMatchObject({ reason: "not_jpeg" });
    expect(validateReducedOutput({ format: "jpeg", width: 401, height: 100, bytes: 100 })).toMatchObject({ reason: "too_large_dimensions" });
    expect(validateReducedOutput({ format: "jpeg", width: 100, height: 100, bytes: 75_001 })).toMatchObject({ reason: "too_many_bytes" });
    expect(validateReducedOutput({ format: "jpeg", width: 100, height: 100, bytes: 0 })).toMatchObject({ reason: "too_many_bytes" });
    expect(validateReducedOutput({ format: "jpeg", width: 0, height: 100, bytes: 10 })).toMatchObject({ reason: "invalid_dimensions" });
  });
});

describe("setCellLayout", () => {
  it("gives a single artwork the whole canvas", () => {
    expect(setCellLayout(1).cells).toEqual([{ index: 0, x: 0, y: 0, width: 400, height: 400 }]);
  });

  it("lays out components row-major in equal cells inside 400 × 400", () => {
    for (let n = 1; n <= ARTWORK_IMAGE_LIMITS.maxSetComponents; n++) {
      const layout = setCellLayout(n);
      expect(layout.cells).toHaveLength(n);
      const first = layout.cells[0];
      for (const c of layout.cells) {
        expect(c.width).toBe(first.width);
        expect(c.height).toBe(first.height);
        expect(c.x + c.width).toBeLessThanOrEqual(400);
        expect(c.y + c.height).toBeLessThanOrEqual(400);
      }
      // row-major: indices increase left-to-right, then top-to-bottom
      for (let i = 1; i < n; i++) {
        const a = layout.cells[i - 1];
        const b = layout.cells[i];
        expect(b.y > a.y || (b.y === a.y && b.x > a.x)).toBe(true);
      }
    }
  });

  it("uses 2×1 for pairs, 2×2 for three, 3×2 for six, 3×3 for nine", () => {
    expect([setCellLayout(2).columns, setCellLayout(2).rows]).toEqual([2, 1]);
    expect([setCellLayout(3).columns, setCellLayout(3).rows]).toEqual([2, 2]);
    expect([setCellLayout(6).columns, setCellLayout(6).rows]).toEqual([3, 2]);
    expect([setCellLayout(9).columns, setCellLayout(9).rows]).toEqual([3, 3]);
  });

  it("keeps cells from overlapping", () => {
    const { cells } = setCellLayout(9);
    for (const a of cells) {
      for (const b of cells) {
        if (a === b) continue;
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    }
  });

  it("rejects zero, negative, fractional and oversized sets", () => {
    for (const n of [0, -1, 2.5, 10, Number.NaN]) {
      expect(() => setCellLayout(n)).toThrow(RangeError);
    }
  });
});
