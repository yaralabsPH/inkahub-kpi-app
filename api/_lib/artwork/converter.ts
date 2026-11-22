/**
 * F3 artwork thumbnails — bounded converter (server-only).
 *
 * Every Sharp operation runs in a forked child (`converter-child.mjs`) with
 * native concurrency 1 and cache off. The parent:
 *   - checks source bytes on disk, then probes metadata in the child and
 *     applies the shared policy (src/lib/domain/artworkImagePolicy.ts)
 *     before any pixel decode;
 *   - kills (SIGKILL) and reaps the child at the conversion deadline;
 *   - refuses to start work once the invocation budget is spent;
 *   - keeps temporary files in one scratch directory per job, points the
 *     child's TMPDIR at it, caps its size and removes it on cleanup.
 *
 * Task 3 measures this on a real Vercel Preview; nothing here proves
 * memory headroom on its own.
 */

import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARTWORK_IMAGE_LIMITS,
  setCellLayout,
  validateArtworkImage,
  validateReducedOutput,
  type ArtworkImageLimits,
  type ArtworkImageMetadata,
  type ImagePolicyRejection,
} from "../../../src/lib/domain/artworkImagePolicy.js";

const CHILD_PATH = fileURLToPath(new URL("./converter-child.mjs", import.meta.url));

/** Background behind set cells (neutral light grey). */
export const SET_BACKGROUND = "#f2f2f2";

/** Do not start a child with less than this much budget left. */
const MIN_START_BUDGET_MS = 1_000;

export interface ReducedImage {
  bytes: Buffer;
  width: number;
  height: number;
  byteLength: number;
  /** SHA-256 of the JPEG bytes (not the source content hash). */
  sha256: string;
  /** JPEG quality used; 0 when unknown (e.g. a verified seed). */
  quality: number;
}

export type ConversionErrorCode =
  | "policy_rejected"
  | "decode_failed"
  | "output_too_large"
  | "timeout"
  | "child_crashed"
  | "budget_exhausted"
  | "scratch_exceeded"
  | "checksum_mismatch"
  | "invalid_output"
  | "invalid_set";

export class ArtworkConversionError extends Error {
  constructor(
    readonly code: ConversionErrorCode,
    message: string,
    readonly reason?: ImagePolicyRejection | string,
    readonly childPid?: number,
  ) {
    super(message);
    this.name = "ArtworkConversionError";
  }
}

export interface ScratchDir {
  path: string;
  maxBytes: number;
  /** Total bytes of files currently in the directory tree. */
  usage(): Promise<number>;
  cleanup(): Promise<void>;
}

export async function createScratchDir(opts: { maxBytes?: number } = {}): Promise<ScratchDir> {
  const path = await mkdtemp(join(tmpdir(), "f3-artwork-"));
  const maxBytes = opts.maxBytes ?? ARTWORK_IMAGE_LIMITS.maxScratchBytes;
  return {
    path,
    maxBytes,
    async usage() {
      let total = 0;
      const walk = async (dir: string) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) await walk(p);
          else if (entry.isFile()) total += (await stat(p)).size;
        }
      };
      await walk(path).catch(() => {});
      return total;
    },
    async cleanup() {
      await rm(path, { recursive: true, force: true });
    },
  };
}

export interface ConvertOptions {
  scratch: ScratchDir;
  limits?: Partial<ArtworkImageLimits>;
  /** Absolute epoch ms by which the whole invocation must finish. */
  deadlineAt?: number;
}

function resolveLimits(partial?: Partial<ArtworkImageLimits>): ArtworkImageLimits {
  return { ...ARTWORK_IMAGE_LIMITS, ...partial };
}

/** One forked child with a single deadline covering all its requests. */
class ChildSession {
  private child: ChildProcess;
  private exited: Promise<void>;
  private timer: ReturnType<typeof setTimeout>;
  private failure: ArtworkConversionError | null = null;
  private pending: { resolve: (v: any) => void; reject: (e: unknown) => void } | null = null;

  constructor(scratchPath: string, timeoutMs: number) {
    this.child = fork(CHILD_PATH, [], {
      execArgv: [],
      serialization: "json",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, TMPDIR: scratchPath, TEMP: scratchPath, TMP: scratchPath, VIPS_CONCURRENCY: "1" },
    });
    this.exited = new Promise((resolve) => this.child.once("exit", () => resolve()));
    this.child.once("exit", (code, signal) => {
      if (this.pending) {
        const err =
          this.failure ??
          new ArtworkConversionError("child_crashed", `converter exited (code ${code}, signal ${signal}) before replying`, undefined, this.child.pid);
        this.pending.reject(err);
        this.pending = null;
      }
    });
    this.child.on("message", (msg) => {
      const p = this.pending;
      this.pending = null;
      p?.resolve(msg);
    });
    this.timer = setTimeout(() => {
      this.failure = new ArtworkConversionError("timeout", `conversion exceeded ${timeoutMs} ms`, undefined, this.child.pid);
      this.child.kill("SIGKILL");
    }, timeoutMs);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  request<T = any>(msg: Record<string, unknown>): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<T>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.child.send(msg, (err) => {
        if (err && this.pending) {
          this.pending = null;
          reject(this.failure ?? new ArtworkConversionError("child_crashed", `could not reach converter: ${err.message}`, undefined, this.child.pid));
        }
      });
    });
  }

  /** Stop the child and wait until the OS has reaped it. */
  async close(): Promise<void> {
    clearTimeout(this.timer);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
    }
    await this.exited;
  }
}

function budgetMs(limits: ArtworkImageLimits, deadlineAt: number | undefined): number {
  const remaining = (deadlineAt ?? Number.POSITIVE_INFINITY) - Date.now();
  if (remaining < MIN_START_BUDGET_MS) {
    throw new ArtworkConversionError("budget_exhausted", `only ${Math.max(0, remaining)} ms left in this invocation`);
  }
  return Math.min(limits.conversionTimeoutMs, remaining);
}

function failFromChild(r: { code?: string; message?: string }, pid?: number): ArtworkConversionError {
  if (r.code === "too_many_pixels") {
    return new ArtworkConversionError("policy_rejected", r.message ?? "pixel limit", "too_many_pixels", pid);
  }
  if (r.code === "output_too_large") return new ArtworkConversionError("output_too_large", r.message ?? "output too large", undefined, pid);
  return new ArtworkConversionError("decode_failed", r.message ?? "decode failed", r.code, pid);
}

async function assertScratch(scratch: ScratchDir): Promise<void> {
  const used = await scratch.usage();
  if (used > scratch.maxBytes) {
    throw new ArtworkConversionError("scratch_exceeded", `scratch holds ${used} bytes, cap ${scratch.maxBytes}`);
  }
}

/** Read the child's output file, remove it, and check it against the output policy. */
async function takeOutput(
  path: string,
  r: { width?: number; height?: number; quality?: number },
  limits: ArtworkImageLimits,
  pid: number | undefined,
): Promise<ReducedImage> {
  const bytes = await readFile(path);
  await unlink(path).catch(() => {});
  const width = r.width ?? 0;
  const height = r.height ?? 0;
  const check = validateReducedOutput({ format: "jpeg", width, height, bytes: bytes.length }, limits);
  if (!check.ok) throw new ArtworkConversionError("invalid_output", check.detail, check.reason, pid);
  return {
    bytes,
    width,
    height,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    quality: r.quality ?? 0,
  };
}

function outPath(scratch: ScratchDir): string {
  return join(scratch.path, `out-${randomBytes(8).toString("hex")}.jpg`);
}

/** Reduce one original (single artwork or one set component) to a thumbnail JPEG. */
export async function convertComponent(inputPath: string, opts: ConvertOptions): Promise<ReducedImage> {
  const limits = resolveLimits(opts.limits);
  const timeoutMs = budgetMs(limits, opts.deadlineAt);

  const { size } = await stat(inputPath);
  const bytesCheck = validateArtworkImage({ format: "jpeg", width: 1, height: 1, channels: 3, size }, limits);
  if (!bytesCheck.ok && bytesCheck.reason === "too_many_bytes") {
    throw new ArtworkConversionError("policy_rejected", bytesCheck.detail, "too_many_bytes");
  }
  await assertScratch(opts.scratch);

  const session = new ChildSession(opts.scratch.path, timeoutMs);
  try {
    const probe = await session.request<{ ok: boolean; meta?: ArtworkImageMetadata; code?: string; message?: string }>({
      op: "probe",
      path: inputPath,
      maxPixels: limits.maxSourcePixels,
    });
    if (!probe.ok || !probe.meta) throw failFromChild(probe, session.pid);

    const verdict = validateArtworkImage({ ...probe.meta, size }, limits);
    if (!verdict.ok) throw new ArtworkConversionError("policy_rejected", verdict.detail, verdict.reason, session.pid);

    const output = outPath(opts.scratch);
    const r = await session.request<{ ok: boolean; width?: number; height?: number; quality?: number; code?: string; message?: string }>({
      op: "convert",
      path: inputPath,
      outputPath: output,
      maxPixels: limits.maxSourcePixels,
      maxSide: limits.maxOutputSide,
      maxBytes: limits.maxOutputBytes,
      qualities: [...limits.jpegQualities],
    });
    if (!r.ok) throw failFromChild(r, session.pid);
    await assertScratch(opts.scratch);
    return await takeOutput(output, r, limits, session.pid);
  } finally {
    await session.close();
  }
}

/**
 * Compose already-reduced components (in component order 01..N) into one
 * set thumbnail. Never called with a partial set: the caller resolves every
 * component first; an empty or oversized list is rejected here.
 */
export async function composeSet(ordered: ReducedImage[], opts: ConvertOptions): Promise<ReducedImage> {
  const limits = resolveLimits(opts.limits);
  let layout;
  try {
    layout = setCellLayout(ordered.length, limits.maxOutputSide, limits.maxSetComponents);
  } catch (e) {
    throw new ArtworkConversionError("invalid_set", (e as Error).message);
  }
  const timeoutMs = budgetMs(limits, opts.deadlineAt);

  const paths: string[] = [];
  for (const [i, part] of ordered.entries()) {
    const p = join(opts.scratch.path, `part-${i}-${randomBytes(4).toString("hex")}.jpg`);
    await writeFile(p, part.bytes, { flag: "wx" });
    paths.push(p);
  }
  await assertScratch(opts.scratch);

  const session = new ChildSession(opts.scratch.path, timeoutMs);
  try {
    const output = outPath(opts.scratch);
    const r = await session.request<{ ok: boolean; width?: number; height?: number; quality?: number; code?: string; message?: string }>({
      op: "compose",
      cells: layout.cells.map((c) => ({ path: paths[c.index], x: c.x, y: c.y, width: c.width, height: c.height })),
      canvas: { width: layout.canvasWidth, height: layout.canvasHeight, background: SET_BACKGROUND },
      outputPath: output,
      maxBytes: limits.maxOutputBytes,
      qualities: [...limits.jpegQualities],
    });
    if (!r.ok) throw failFromChild(r, session.pid);
    return await takeOutput(output, r, limits, session.pid);
  } finally {
    await session.close();
    await Promise.all(paths.map((p) => unlink(p).catch(() => {})));
  }
}

/**
 * Check stored or reused thumbnail bytes (e.g. an existing object or a Part 6
 * seed) against an expected SHA-256 and the output policy.
 */
export async function verifyReducedImage(bytes: Buffer, expectedSha256: string, opts: ConvertOptions): Promise<ReducedImage> {
  const limits = resolveLimits(opts.limits);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expectedSha256.toLowerCase()) {
    throw new ArtworkConversionError("checksum_mismatch", `expected ${expectedSha256}, got ${sha256}`);
  }
  const timeoutMs = budgetMs(limits, opts.deadlineAt);
  const p = join(opts.scratch.path, `verify-${randomBytes(8).toString("hex")}`);
  await writeFile(p, bytes, { flag: "wx" });
  const session = new ChildSession(opts.scratch.path, timeoutMs);
  try {
    const probe = await session.request<{ ok: boolean; meta?: ArtworkImageMetadata; code?: string; message?: string }>({
      op: "probe",
      path: p,
      maxPixels: limits.maxOutputSide * limits.maxOutputSide,
    });
    if (!probe.ok || !probe.meta) throw new ArtworkConversionError("invalid_output", probe.message ?? "unreadable thumbnail", probe.code, session.pid);
    const meta = probe.meta;
    const check = validateReducedOutput({ format: meta.format, width: meta.width, height: meta.height, bytes: bytes.length }, limits);
    if (!check.ok) throw new ArtworkConversionError("invalid_output", check.detail, check.reason, session.pid);
    return { bytes, width: meta.width ?? 0, height: meta.height ?? 0, byteLength: bytes.length, sha256, quality: 0 };
  } finally {
    await session.close();
    await unlink(p).catch(() => {});
  }
}
