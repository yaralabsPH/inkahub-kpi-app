// F3 artwork thumbnails — Sharp worker child process.
//
// Forked by converter.ts so a runaway decode can be killed (SIGKILL) and its
// native memory released with the process. It does no policy: the parent
// validates probe metadata against src/lib/domain/artworkImagePolicy.ts and
// only then asks for a conversion. Hard ceilings (pixel limit, output size)
// are still passed in and enforced here as a second line.
//
// Protocol (IPC, JSON): parent sends one request at a time; child answers
// { ok: true, ... } or { ok: false, code, message }.
//   { op: "probe", path, maxPixels }
//   { op: "convert", path, outputPath, maxPixels, maxSide, maxBytes, qualities }
//   { op: "compose", cells:[{path,x,y,width,height}], canvas:{width,height,background}, outputPath, maxBytes, qualities }
//   { op: "exit" }

import { writeFile } from "node:fs/promises";
import sharp from "sharp";

sharp.concurrency(1);
sharp.cache(false);

/** @param {unknown} e */
function classify(e) {
  const message = e instanceof Error ? e.message : String(e);
  if (/pixel limit/i.test(message)) return { code: "too_many_pixels", message };
  return { code: "decode_failed", message };
}

/** @param {Record<string, unknown>} msg */
function reply(msg) {
  if (process.send) process.send(msg);
}

/**
 * Encode raw 8-bit pixels as JPEG, stepping down quality until it fits.
 * @param {Buffer} data
 * @param {{ width: number, height: number, channels: 1 | 2 | 3 | 4 }} raw
 * @param {number[]} qualities
 * @param {number} maxBytes
 */
async function encodeWithinBudget(data, raw, qualities, maxBytes) {
  for (const quality of qualities) {
    const jpeg = await sharp(data, { raw }).jpeg({ quality, chromaSubsampling: "4:2:0" }).toBuffer();
    if (jpeg.length <= maxBytes) return { jpeg, quality };
  }
  return null;
}

/** @param {any} req */
async function handle(req) {
  if (req.op === "probe") {
    const m = await sharp(req.path, { limitInputPixels: req.maxPixels, failOn: "warning" }).metadata();
    return {
      ok: true,
      meta: { format: m.format, width: m.width, height: m.height, pages: m.pages, channels: m.channels, depth: m.depth, size: m.size },
    };
  }

  if (req.op === "convert") {
    const { data, info } = await sharp(req.path, { limitInputPixels: req.maxPixels, failOn: "warning", sequentialRead: true })
      .rotate()
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .resize(req.maxSide, req.maxSide, { fit: "inside", withoutEnlargement: true, fastShrinkOnLoad: true })
      .raw({ depth: "uchar" })
      .toBuffer({ resolveWithObject: true });
    const raw = { width: info.width, height: info.height, channels: info.channels };
    const out = await encodeWithinBudget(data, raw, req.qualities, req.maxBytes);
    if (!out) return { ok: false, code: "output_too_large", message: `still over ${req.maxBytes} bytes at quality ${req.qualities.at(-1)}` };
    await writeFile(req.outputPath, out.jpeg, { flag: "wx" });
    return { ok: true, width: info.width, height: info.height, quality: out.quality, bytes: out.jpeg.length };
  }

  if (req.op === "compose") {
    /** @type {{ input: Buffer, left: number, top: number }[]} */
    const layers = [];
    for (const cell of req.cells) {
      const { data, info } = await sharp(cell.path, { failOn: "warning" })
        .resize(cell.width, cell.height, { fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer({ resolveWithObject: true });
      layers.push({
        input: data,
        left: cell.x + Math.floor((cell.width - info.width) / 2),
        top: cell.y + Math.floor((cell.height - info.height) / 2),
      });
    }
    const { width, height, background } = req.canvas;
    const { data, info } = await sharp({ create: { width, height, channels: 3, background } })
      .composite(layers)
      .raw({ depth: "uchar" })
      .toBuffer({ resolveWithObject: true });
    const raw = { width: info.width, height: info.height, channels: info.channels };
    const out = await encodeWithinBudget(data, raw, req.qualities, req.maxBytes);
    if (!out) return { ok: false, code: "output_too_large", message: `set still over ${req.maxBytes} bytes at quality ${req.qualities.at(-1)}` };
    await writeFile(req.outputPath, out.jpeg, { flag: "wx" });
    return { ok: true, width: info.width, height: info.height, quality: out.quality, bytes: out.jpeg.length };
  }

  return { ok: false, code: "bad_request", message: `unknown op ${String(req.op)}` };
}

process.on("message", (/** @type {any} */ req) => {
  if (req && req.op === "exit") {
    process.exit(0);
  }
  handle(req).then(reply, (e) => reply({ ok: false, ...classify(e) }));
});

process.on("disconnect", () => process.exit(0));
