/**
 * F3 artwork thumbnails — Dropbox content hash and bounded streaming download.
 *
 * Server-only. `content_hash` is Dropbox's file fingerprint: SHA-256 of the
 * concatenated SHA-256 digests of each 4 MiB block
 * (https://www.dropbox.com/developers/reference/content-hash). We compute it
 * while streaming an original to temporary disk, so a revision can be
 * verified without holding the whole file in memory.
 *
 * The byte cap counts bytes actually received; a Content-Length header is
 * only an `expectedBytes` cross-check and is never trusted as the limit.
 */

import { createHash, type Hash } from "node:crypto";
import { open, unlink } from "node:fs/promises";

export const DROPBOX_BLOCK_SIZE = 4 * 1024 * 1024;

export class DropboxContentHasher {
  private blockHashes: Buffer[] = [];
  private block: Hash = createHash("sha256");
  private blockFill = 0;
  private done = false;

  update(chunk: Uint8Array): this {
    if (this.done) throw new Error("DropboxContentHasher: update after digest");
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(DROPBOX_BLOCK_SIZE - this.blockFill, chunk.length - offset);
      this.block.update(chunk.subarray(offset, offset + take));
      this.blockFill += take;
      offset += take;
      if (this.blockFill === DROPBOX_BLOCK_SIZE) {
        this.blockHashes.push(this.block.digest());
        this.block = createHash("sha256");
        this.blockFill = 0;
      }
    }
    return this;
  }

  /** Hex digest. A trailing partial block counts; an empty input hashes nothing. */
  digest(): string {
    if (this.done) throw new Error("DropboxContentHasher: digest called twice");
    this.done = true;
    if (this.blockFill > 0) this.blockHashes.push(this.block.digest());
    return createHash("sha256").update(Buffer.concat(this.blockHashes)).digest("hex");
  }
}

export function dropboxContentHash(bytes: Uint8Array): string {
  return new DropboxContentHasher().update(bytes).digest();
}

export type BoundedDownloadErrorCode = "too_large" | "size_mismatch" | "timeout" | "aborted" | "interrupted";

export class BoundedDownloadError extends Error {
  constructor(
    readonly code: BoundedDownloadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BoundedDownloadError";
  }
}

export interface StreamToFileOptions {
  /** Hard cap on bytes received; exceeding it aborts and deletes the file. */
  maxBytes: number;
  /** Whole-transfer deadline in ms; a stalled stream fails at this point. */
  deadlineMs: number;
  /** Declared length (e.g. Content-Length or Dropbox `size`); a mismatch fails. */
  expectedBytes?: number;
  signal?: AbortSignal;
}

/**
 * Stream `source` to a new file at `destPath` (never overwrites), hashing as
 * it goes. On any failure the partial file is removed and a
 * BoundedDownloadError is thrown. The source is closed best-effort.
 */
export async function streamToFileWithHash(
  source: AsyncIterable<Uint8Array>,
  destPath: string,
  opts: StreamToFileOptions,
): Promise<{ bytes: number; contentHash: string }> {
  const file = await open(destPath, "wx"); // fails if the path exists
  const hasher = new DropboxContentHasher();
  const iterator = source[Symbol.asyncIterator]();
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new BoundedDownloadError("timeout", `download exceeded ${opts.deadlineMs} ms`)),
      opts.deadlineMs,
    );
    if (opts.signal) {
      onAbort = () => reject(new BoundedDownloadError("aborted", "download aborted"));
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  stop.catch(() => {}); // handled through Promise.race below

  try {
    for (;;) {
      let step: IteratorResult<Uint8Array>;
      try {
        step = await Promise.race([iterator.next(), stop]);
      } catch (e) {
        if (e instanceof BoundedDownloadError) throw e;
        throw new BoundedDownloadError("interrupted", `source stream failed: ${(e as Error)?.message ?? e}`);
      }
      if (step.done) break;
      const chunk = step.value;
      bytes += chunk.length;
      if (bytes > opts.maxBytes) {
        throw new BoundedDownloadError("too_large", `received more than ${opts.maxBytes} bytes`);
      }
      hasher.update(chunk);
      await Promise.race([file.write(chunk), stop]);
    }
    if (opts.signal?.aborted) throw new BoundedDownloadError("aborted", "download aborted");
    if (opts.expectedBytes !== undefined && bytes !== opts.expectedBytes) {
      throw new BoundedDownloadError("size_mismatch", `received ${bytes} bytes, expected ${opts.expectedBytes}`);
    }
    await file.close();
    return { bytes, contentHash: hasher.digest() };
  } catch (e) {
    // Best-effort close of the source; an async generator suspended on a
    // pending await cannot be forced, so do not wait for it.
    void Promise.resolve(iterator.return?.()).catch(() => {});
    await file.close().catch(() => {});
    await unlink(destPath).catch(() => {});
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
  }
}
