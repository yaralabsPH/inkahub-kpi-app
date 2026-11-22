/**
 * Native converter tests. Fixtures are generated at test time with Sharp
 * (small synthetic images); no artwork originals are committed. Large
 * worst-case fixtures belong to the staging Preview gate (Task 3), see
 * tests/artwork/fixtures/README.md.
 */
import { createHash, randomBytes } from "node:crypto";
import { copyFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArtworkConversionError,
  composeSet,
  convertComponent,
  createScratchDir,
  verifyReducedImage,
  type ReducedImage,
  type ScratchDir,
} from "../../../api/_lib/artwork/converter.js";

const SLOW = 60_000;

let scratch: ScratchDir;
beforeEach(async () => {
  scratch = await createScratchDir();
});
afterEach(async () => {
  await scratch.cleanup();
});

async function solid(name: string, width: number, height: number, rgb: [number, number, number], fmt: "jpeg" | "png" | "webp" | "tiff" = "png"): Promise<string> {
  const path = join(scratch.path, name);
  await sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
    .toFormat(fmt)
    .toFile(path);
  return path;
}

async function noise(name: string, width: number, height: number): Promise<string> {
  const path = join(scratch.path, name);
  await sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toFile(path);
  return path;
}

async function decode(img: ReducedImage) {
  const meta = await sharp(img.bytes).metadata();
  const { data, info } = await sharp(img.bytes).raw().toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => {
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  return { meta, px };
}

function near(actual: number[], expected: number[], tolerance = 24) {
  for (let i = 0; i < 3; i++) expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(tolerance);
}

function codeOf(e: unknown): string | undefined {
  return e instanceof ArtworkConversionError ? e.code : undefined;
}

describe("convertComponent", () => {
  it("reduces each supported format to a ≤400 px, ≤75 KB JPEG keeping aspect ratio", async () => {
    for (const fmt of ["jpeg", "png", "webp", "tiff"] as const) {
      const src = await solid(`wide.${fmt}`, 1600, 800, [200, 30, 30], fmt);
      const out = await convertComponent(src, { scratch });
      expect([out.width, out.height]).toEqual([400, 200]);
      expect(out.byteLength).toBe(out.bytes.length);
      expect(out.byteLength).toBeLessThanOrEqual(75_000);
      expect(out.sha256).toBe(createHash("sha256").update(out.bytes).digest("hex"));
      const { meta, px } = await decode(out);
      expect(meta.format).toBe("jpeg");
      near(px(200, 100), [200, 30, 30]);
    }
  }, SLOW);

  it("never enlarges a small original", async () => {
    const out = await convertComponent(await solid("small.png", 120, 90, [10, 120, 10]), { scratch });
    expect([out.width, out.height]).toEqual([120, 90]);
  }, SLOW);

  it("decodes extensionless files by content, not name", async () => {
    const jpg = await solid("x.jpeg", 800, 1200, [20, 20, 160], "jpeg");
    const bare = join(scratch.path, "INKA-TEST0001");
    await copyFile(jpg, bare);
    const out = await convertComponent(bare, { scratch });
    expect([out.width, out.height]).toEqual([267, 400]);
  }, SLOW);

  it("applies EXIF orientation", async () => {
    const path = join(scratch.path, "rotated.jpg");
    await sharp({ create: { width: 300, height: 100, channels: 3, background: "#808080" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(path);
    const out = await convertComponent(path, { scratch });
    expect([out.width, out.height]).toEqual([100, 300]);
  }, SLOW);

  it("flattens transparency onto white", async () => {
    const path = join(scratch.path, "alpha.png");
    await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toFile(path);
    const { px } = await decode(await convertComponent(path, { scratch }));
    near(px(100, 100), [255, 255, 255], 4);
  }, SLOW);

  // Sharp cannot write 16-bit TIFF, so a real 16-bit TIFF is part of the
  // Task 3 fixture suite (tests/artwork/fixtures/README.md), not this test.
  it("converts a 16-bit PNG original", async () => {
    const width = 600;
    const height = 400;
    const samples = new Uint16Array(width * height * 3).fill(40000);
    const path = join(scratch.path, "deep.png");
    await sharp(samples, { raw: { width, height, channels: 3 } }).toColourspace("rgb16").png().toFile(path);
    expect((await sharp(path).metadata()).depth).toBe("ushort");
    const out = await convertComponent(path, { scratch });
    expect([out.width, out.height]).toEqual([400, 267]);
    const { px } = await decode(out);
    near(px(200, 130), [156, 156, 156], 6); // 40000/65535 × 255 ≈ 156
  }, SLOW);

  it("keeps high-entropy art within the byte cap or fails loudly — never over", async () => {
    const src = await noise("noise.png", 1200, 1200);
    try {
      const out = await convertComponent(src, { scratch });
      expect(out.byteLength).toBeLessThanOrEqual(75_000);
      expect(out.quality).toBeLessThanOrEqual(78);
    } catch (e) {
      expect(codeOf(e)).toBe("output_too_large");
    }
  }, SLOW);

  it("fails when even the lowest quality is too big", async () => {
    const src = await noise("noise2.png", 800, 800);
    const err = await convertComponent(src, { scratch, limits: { maxOutputBytes: 5_000 } }).catch((e) => e);
    expect(codeOf(err)).toBe("output_too_large");
  }, SLOW);

  it("rejects originals over the pixel ceiling before conversion", async () => {
    const src = await solid("pixels.png", 200, 200, [1, 2, 3]);
    const err = await convertComponent(src, { scratch, limits: { maxSourcePixels: 39_999 } }).catch((e) => e);
    expect(codeOf(err)).toBe("policy_rejected");
    expect(err.reason).toBe("too_many_pixels");
  }, SLOW);

  it("rejects originals over the byte ceiling without decoding", async () => {
    const src = await solid("bytes.png", 200, 200, [1, 2, 3]);
    const { size } = await stat(src);
    const err = await convertComponent(src, { scratch, limits: { maxSourceBytes: size - 1 } }).catch((e) => e);
    expect(codeOf(err)).toBe("policy_rejected");
    expect(err.reason).toBe("too_many_bytes");
  }, SLOW);

  it("rejects decodable but untested formats (SVG, GIF)", async () => {
    const svg = join(scratch.path, "art.svg");
    await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    const gif = join(scratch.path, "art.gif");
    await sharp({ create: { width: 10, height: 10, channels: 3, background: "#000" } }).gif().toFile(gif);
    for (const p of [svg, gif]) {
      const err = await convertComponent(p, { scratch }).catch((e) => e);
      expect(codeOf(err)).toBe("policy_rejected");
      expect(err.reason).toBe("unsupported_format");
    }
  }, SLOW);

  it("rejects animated originals", async () => {
    const frame = (c: string) => sharp({ create: { width: 50, height: 50, channels: 3, background: c } }).png().toBuffer();
    const path = join(scratch.path, "anim.webp");
    await sharp([await frame("#f00"), await frame("#0f0"), await frame("#00f")], { join: { animated: true } }).webp().toFile(path);
    const err = await convertComponent(path, { scratch }).catch((e) => e);
    expect(codeOf(err)).toBe("policy_rejected");
    expect(err.reason).toBe("multipage_or_animated");
  }, SLOW);

  it("reports corrupt and truncated input as decode failures", async () => {
    const junk = join(scratch.path, "INKA-JUNK0001");
    await writeFile(junk, randomBytes(4096));
    const full = await sharp({ create: { width: 400, height: 400, channels: 3, background: "#123456" } }).jpeg().toBuffer();
    const cut = join(scratch.path, "cut.jpg");
    await writeFile(cut, full.subarray(0, Math.floor(full.length / 2)));
    for (const p of [junk, cut]) {
      expect(codeOf(await convertComponent(p, { scratch }).catch((e) => e))).toBe("decode_failed");
    }
  }, SLOW);

  it("kills and reaps the child at the conversion deadline", async () => {
    const src = await noise("slow.png", 2500, 2500);
    const err = await convertComponent(src, { scratch, limits: { conversionTimeoutMs: 30 } }).catch((e) => e);
    expect(codeOf(err)).toBe("timeout");
    expect(typeof err.childPid).toBe("number");
    expect(() => process.kill(err.childPid, 0)).toThrow(); // ESRCH: process is gone
  }, SLOW);

  it("refuses to start when the invocation budget is spent", async () => {
    const src = await solid("late.png", 10, 10, [0, 0, 0]);
    const err = await convertComponent(src, { scratch, deadlineAt: Date.now() + 100 }).catch((e) => e);
    expect(codeOf(err)).toBe("budget_exhausted");
  });

  it("fails when scratch use exceeds its cap", async () => {
    const tight = await createScratchDir({ maxBytes: 1_000 });
    try {
      const src = join(tight.path, "in.png");
      await sharp({ create: { width: 300, height: 300, channels: 3, background: "#abcdef" } }).png({ compressionLevel: 0 }).toFile(src);
      expect(codeOf(await convertComponent(src, { scratch: tight }).catch((e) => e))).toBe("scratch_exceeded");
    } finally {
      await tight.cleanup();
    }
  }, SLOW);
});

describe("composeSet", () => {
  const colours: [number, number, number][] = [
    [220, 20, 20], [20, 180, 20], [20, 20, 220],
    [220, 220, 20], [20, 220, 220], [220, 20, 220],
    [120, 60, 0], [0, 0, 0], [255, 255, 255],
  ];

  async function components(n: number): Promise<ReducedImage[]> {
    const out: ReducedImage[] = [];
    for (let i = 0; i < n; i++) {
      out.push(await convertComponent(await solid(`c${i}.png`, 300, 400, colours[i]), { scratch }));
    }
    return out;
  }

  for (const [n, cols, rows] of [[6, 3, 2], [9, 3, 3]] as const) {
    it(`composes ${n} components row-major on one ≤400 px canvas`, async () => {
      const set = await composeSet(await components(n), { scratch });
      expect([set.width, set.height]).toEqual([400, 400]);
      expect(set.byteLength).toBeLessThanOrEqual(75_000);
      const { px } = await decode(set);
      const cellW = (400 - 4 * (cols - 1)) / cols;
      const cellH = (400 - 4 * (rows - 1)) / rows;
      for (let i = 0; i < n; i++) {
        const cx = Math.floor((i % cols) * (cellW + 4) + cellW / 2);
        const cy = Math.floor(Math.floor(i / cols) * (cellH + 4) + cellH / 2);
        near(px(cx, cy), colours[i], 30);
      }
    }, SLOW);
  }

  it("rejects an empty or oversized set", async () => {
    expect(codeOf(await composeSet([], { scratch }).catch((e) => e))).toBe("invalid_set");
    const one = (await components(1))[0];
    expect(codeOf(await composeSet(Array(10).fill(one), { scratch }).catch((e) => e))).toBe("invalid_set");
  }, SLOW);
});

describe("verifyReducedImage", () => {
  it("accepts matching bytes and rejects a wrong checksum or non-JPEG output", async () => {
    const good = await convertComponent(await solid("v.png", 500, 500, [9, 9, 9]), { scratch });
    const again = await verifyReducedImage(good.bytes, good.sha256, { scratch });
    expect([again.width, again.height, again.sha256]).toEqual([good.width, good.height, good.sha256]);

    expect(codeOf(await verifyReducedImage(good.bytes, "0".repeat(64), { scratch }).catch((e) => e))).toBe("checksum_mismatch");

    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#000" } }).png().toBuffer();
    const pngSha = createHash("sha256").update(png).digest("hex");
    expect(codeOf(await verifyReducedImage(png, pngSha, { scratch }).catch((e) => e))).toBe("invalid_output");
  }, SLOW);
});

describe("createScratchDir", () => {
  it("removes everything on cleanup", async () => {
    const s = await createScratchDir();
    await convertComponent(await (async () => {
      const p = join(s.path, "a.png");
      await sharp({ create: { width: 50, height: 50, channels: 3, background: "#fff" } }).png().toFile(p);
      return p;
    })(), { scratch: s });
    expect((await readdir(s.path)).length).toBeGreaterThan(0);
    await s.cleanup();
    await expect(stat(s.path)).rejects.toMatchObject({ code: "ENOENT" });
  }, SLOW);
});
