/**
 * F3 artwork thumbnails — image policy (pure, no I/O).
 *
 * One rule set shared by generated thumbnails and verified Part 6 seeds:
 * which originals we accept, what a finished thumbnail must look like, and
 * how a set composite is laid out. The server converter
 * (`api/_lib/artwork/converter.ts`) enforces these numbers; this module only
 * decides.
 *
 * Deliberately NOT inherited from the Part 6 reference script: unlimited
 * metadata decoding and its 500 MP JPEG exception.
 */

export const ARTWORK_IMAGE_LIMITS = {
  /** Largest original we will download/convert, in bytes. */
  maxSourceBytes: 150_000_000,
  /** Largest original in decoded pixels (width × height), any format. */
  maxSourcePixels: 300_000_000,
  /** Finished thumbnail: longest side, pixels. */
  maxOutputSide: 400,
  /** Finished thumbnail: JPEG size, bytes. */
  maxOutputBytes: 75_000,
  /** JPEG quality ladder; fail if the last step is still too big. */
  jpegQualities: [78, 65, 50] as readonly number[],
  /** One conversion (decode + reduce) in the child process. */
  conversionTimeoutMs: 45_000,
  /** Whole worker invocation. */
  invocationBudgetMs: 90_000,
  /** Streaming download of one original. */
  downloadTimeoutMs: 30_000,
  /** Temporary disk per active original. */
  maxScratchBytes: 200_000_000,
  /** Set SKUs carry a single digit (`S2`…`S9`). */
  maxSetComponents: 9,
} as const;

export type ArtworkImageLimits = {
  maxSourceBytes: number;
  maxSourcePixels: number;
  maxOutputSide: number;
  maxOutputBytes: number;
  jpegQualities: readonly number[];
  conversionTimeoutMs: number;
  invocationBudgetMs: number;
  downloadTimeoutMs: number;
  maxScratchBytes: number;
  maxSetComponents: number;
};

/** Decoded formats we have tested. Detection is by content, not extension. */
export const SUPPORTED_SOURCE_FORMATS = ["jpeg", "png", "webp", "tiff"] as const;
export type SupportedSourceFormat = (typeof SUPPORTED_SOURCE_FORMATS)[number];

/** Sample depths accepted: 8-bit and 16-bit integer. */
const SUPPORTED_DEPTHS: Record<string, number> = { uchar: 1, ushort: 2 };

/** Subset of image metadata the policy needs (shape of Sharp's metadata()). */
export interface ArtworkImageMetadata {
  format?: string;
  width?: number;
  height?: number;
  /** Page/frame count; >1 means multipage TIFF or animation. */
  pages?: number;
  channels?: number;
  depth?: string;
  /** Source size in bytes, when known. */
  size?: number;
}

export type ImagePolicyRejection =
  | "unsupported_format"
  | "invalid_dimensions"
  | "too_many_pixels"
  | "too_many_bytes"
  | "multipage_or_animated"
  | "unsupported_channels"
  | "unsupported_depth";

export type ImagePolicyResult =
  | {
      ok: true;
      format: SupportedSourceFormat;
      width: number;
      height: number;
      pixels: number;
      /** Rough decoded-buffer size (pixels × channels × bytes/sample), for logs and benchmarks. */
      estimatedDecodeBytes: number;
    }
  | { ok: false; reason: ImagePolicyRejection; detail: string };

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0;
}

/** Decide whether an original may be converted. */
export function validateArtworkImage(
  meta: ArtworkImageMetadata,
  limits: Pick<ArtworkImageLimits, "maxSourceBytes" | "maxSourcePixels"> = ARTWORK_IMAGE_LIMITS,
): ImagePolicyResult {
  const format = (meta.format ?? "").toLowerCase();
  if (!(SUPPORTED_SOURCE_FORMATS as readonly string[]).includes(format)) {
    return { ok: false, reason: "unsupported_format", detail: `format "${format || "unknown"}" is not supported` };
  }
  if (meta.size !== undefined && (!Number.isFinite(meta.size) || meta.size > limits.maxSourceBytes)) {
    return { ok: false, reason: "too_many_bytes", detail: `${meta.size} bytes exceeds ${limits.maxSourceBytes}` };
  }
  if (!isPositiveInt(meta.width) || !isPositiveInt(meta.height)) {
    return { ok: false, reason: "invalid_dimensions", detail: `width ${meta.width} × height ${meta.height}` };
  }
  const pixels = meta.width * meta.height;
  if (!Number.isSafeInteger(pixels) || pixels > limits.maxSourcePixels) {
    return { ok: false, reason: "too_many_pixels", detail: `${pixels} pixels exceeds ${limits.maxSourcePixels}` };
  }
  if (meta.pages !== undefined && meta.pages !== 1) {
    return { ok: false, reason: "multipage_or_animated", detail: `${meta.pages} pages/frames` };
  }
  const channels = meta.channels ?? 0;
  if (!Number.isInteger(channels) || channels < 1 || channels > 4) {
    return { ok: false, reason: "unsupported_channels", detail: `${meta.channels} channels` };
  }
  const bytesPerSample = SUPPORTED_DEPTHS[meta.depth ?? "uchar"];
  if (!bytesPerSample) {
    return { ok: false, reason: "unsupported_depth", detail: `sample depth "${meta.depth}"` };
  }
  return {
    ok: true,
    format: format as SupportedSourceFormat,
    width: meta.width,
    height: meta.height,
    pixels,
    estimatedDecodeBytes: pixels * channels * bytesPerSample,
  };
}

export type ReducedOutputRejection = "not_jpeg" | "too_large_dimensions" | "too_many_bytes" | "invalid_dimensions";

/** Check a finished thumbnail (generated or a Part 6 seed) against the output rules. */
export function validateReducedOutput(
  meta: { format?: string; width?: number; height?: number; bytes: number },
  limits: Pick<ArtworkImageLimits, "maxOutputSide" | "maxOutputBytes"> = ARTWORK_IMAGE_LIMITS,
): { ok: true } | { ok: false; reason: ReducedOutputRejection; detail: string } {
  if ((meta.format ?? "").toLowerCase() !== "jpeg") {
    return { ok: false, reason: "not_jpeg", detail: `format "${meta.format}"` };
  }
  if (!isPositiveInt(meta.width) || !isPositiveInt(meta.height)) {
    return { ok: false, reason: "invalid_dimensions", detail: `width ${meta.width} × height ${meta.height}` };
  }
  if (meta.width > limits.maxOutputSide || meta.height > limits.maxOutputSide) {
    return { ok: false, reason: "too_large_dimensions", detail: `${meta.width}×${meta.height} exceeds ${limits.maxOutputSide}` };
  }
  if (!Number.isFinite(meta.bytes) || meta.bytes <= 0 || meta.bytes > limits.maxOutputBytes) {
    return { ok: false, reason: "too_many_bytes", detail: `${meta.bytes} bytes exceeds ${limits.maxOutputBytes}` };
  }
  return { ok: true };
}

export interface Cell {
  /** 0-based component position (component 01 is index 0). */
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SetLayout {
  canvasWidth: number;
  canvasHeight: number;
  columns: number;
  rows: number;
  gap: number;
  cells: Cell[];
}

/** Gap between composite cells, pixels. */
export const SET_CELL_GAP = 4;

/**
 * Equal-cell, row-major grid for a set composite on a square canvas.
 * Every component gets a cell; nothing is cropped (the converter fits each
 * reduced component inside its cell). Throws for an invalid component count
 * — a set with zero or too many pieces is a resolution error, not a layout.
 */
export function setCellLayout(
  count: number,
  side: number = ARTWORK_IMAGE_LIMITS.maxOutputSide,
  maxComponents: number = ARTWORK_IMAGE_LIMITS.maxSetComponents,
): SetLayout {
  if (!Number.isInteger(count) || count < 1 || count > maxComponents) {
    throw new RangeError(`set component count must be an integer 1..${maxComponents}, got ${count}`);
  }
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const gap = count === 1 ? 0 : SET_CELL_GAP;
  const width = Math.floor((side - gap * (columns - 1)) / columns);
  const height = Math.floor((side - gap * (rows - 1)) / rows);
  const cells: Cell[] = [];
  for (let index = 0; index < count; index++) {
    const col = index % columns;
    const row = Math.floor(index / columns);
    cells.push({ index, x: col * (width + gap), y: row * (height + gap), width, height });
  }
  return { canvasWidth: side, canvasHeight: side, columns, rows, gap, cells };
}
