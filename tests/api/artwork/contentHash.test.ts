import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BoundedDownloadError,
  DROPBOX_BLOCK_SIZE,
  DropboxContentHasher,
  dropboxContentHash,
  streamToFileWithHash,
} from "../../../api/_lib/artwork/contentHash.js";

/** Independent reference: SHA-256 over the concatenated SHA-256 of each 4 MiB block. */
function reference(bytes: Buffer): string {
  const blocks: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += DROPBOX_BLOCK_SIZE) {
    blocks.push(createHash("sha256").update(bytes.subarray(i, i + DROPBOX_BLOCK_SIZE)).digest());
  }
  return createHash("sha256").update(Buffer.concat(blocks)).digest("hex");
}

function bytesOf(length: number): Buffer {
  const b = Buffer.alloc(length);
  for (let i = 0; i < length; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

async function* chunked(buf: Buffer, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

describe("Dropbox content hash", () => {
  it("matches the empty-input value (SHA-256 of nothing)", () => {
    expect(dropboxContentHash(Buffer.alloc(0))).toBe(createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
  });

  it("matches the reference for one byte, one exact block and block boundaries", () => {
    for (const n of [1, DROPBOX_BLOCK_SIZE - 1, DROPBOX_BLOCK_SIZE, DROPBOX_BLOCK_SIZE + 1, 2 * DROPBOX_BLOCK_SIZE + 17]) {
      const b = bytesOf(n);
      expect(dropboxContentHash(b)).toBe(reference(b));
    }
  });

  it("gives the same digest however the stream is chunked", () => {
    const b = bytesOf(DROPBOX_BLOCK_SIZE * 2 + 5);
    for (const chunk of [1_000_003, DROPBOX_BLOCK_SIZE, 7 * 1024 * 1024]) {
      const h = new DropboxContentHasher();
      for (let i = 0; i < b.length; i += chunk) h.update(b.subarray(i, i + chunk));
      expect(h.digest()).toBe(reference(b));
    }
  });

  it("refuses to update after digest", () => {
    const h = new DropboxContentHasher();
    h.digest();
    expect(() => h.update(Buffer.from("x"))).toThrow();
  });
});

describe("streamToFileWithHash", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "f3-hash-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the bytes and returns their size and content hash", async () => {
    const b = bytesOf(DROPBOX_BLOCK_SIZE + 123);
    const dest = join(dir, "a.bin");
    const r = await streamToFileWithHash(chunked(b, 65536), dest, { maxBytes: 10_000_000, deadlineMs: 5_000 });
    expect(r).toEqual({ bytes: b.length, contentHash: reference(b) });
    expect(Buffer.compare(await readFile(dest), b)).toBe(0);
  });

  it("stops at the byte cap even when a header claimed less, and removes the partial file", async () => {
    const dest = join(dir, "big.bin");
    const err = await streamToFileWithHash(chunked(bytesOf(300_000), 10_000), dest, {
      maxBytes: 100_000,
      deadlineMs: 5_000,
      expectedBytes: 50_000,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BoundedDownloadError);
    expect(err.code).toBe("too_large");
    await expect(stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a body whose length differs from the declared length", async () => {
    const dest = join(dir, "short.bin");
    const err = await streamToFileWithHash(chunked(bytesOf(1_000), 100), dest, {
      maxBytes: 100_000,
      deadlineMs: 5_000,
      expectedBytes: 2_000,
    }).catch((e) => e);
    expect(err).toMatchObject({ code: "size_mismatch" });
    await expect(stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails a stalled stream at the deadline", async () => {
    async function* stalls(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("partial");
      await new Promise(() => {}); // never resolves
    }
    const dest = join(dir, "stall.bin");
    const started = Date.now();
    const err = await streamToFileWithHash(stalls(), dest, { maxBytes: 1_000, deadlineMs: 150 }).catch((e) => e);
    expect(err).toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honours an abort signal", async () => {
    const ctl = new AbortController();
    async function* slow(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("a");
      ctl.abort();
      yield Buffer.from("b");
    }
    const err = await streamToFileWithHash(slow(), join(dir, "abort.bin"), {
      maxBytes: 1_000,
      deadlineMs: 5_000,
      signal: ctl.signal,
    }).catch((e) => e);
    expect(err).toMatchObject({ code: "aborted" });
  });

  it("propagates a source error as interrupted and cleans up", async () => {
    async function* breaks(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("abc");
      throw new Error("socket hang up");
    }
    const dest = join(dir, "broken.bin");
    const err = await streamToFileWithHash(breaks(), dest, { maxBytes: 1_000, deadlineMs: 5_000 }).catch((e) => e);
    expect(err).toMatchObject({ code: "interrupted" });
    await expect(stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never overwrites an existing file", async () => {
    const dest = join(dir, "exists.bin");
    await streamToFileWithHash(chunked(Buffer.from("one"), 10), dest, { maxBytes: 100, deadlineMs: 5_000 });
    const err = await streamToFileWithHash(chunked(Buffer.from("two"), 10), dest, { maxBytes: 100, deadlineMs: 5_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((await readFile(dest)).toString()).toBe("one");
  });
});
