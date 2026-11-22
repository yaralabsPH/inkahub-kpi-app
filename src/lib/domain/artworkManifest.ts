/**
 * F3 artwork thumbnails — ordered source manifests and revision digests
 * (pure, no I/O).
 *
 * `resolveManifest` binds every expected component of one canonical artwork
 * to exactly one current source file, or explains why it cannot. The
 * revision digest identifies the exact ordered `(ordinal, file_id, rev,
 * content_hash)` set plus renderer version. `rev` and `content_hash` are
 * identities, never freshness clocks: nothing here orders or chooses by them.
 *
 * SHA-256 is injected (Node crypto on the server, tests); this module must
 * stay importable by the browser.
 */

import { approvedAliasesFor, isCandidateName, validateAliases, type AliasProvenance, type ArtworkAlias } from "./artworkAliases.js";
import type { ArtworkItem } from "./artworkIdentity.js";

/** Bump when render output for the same sources changes (size, quality ladder, layout…). */
export const ARTWORK_RENDERER_VERSION = "f3-r1";

/** Payload format version; part of the digest input. */
export const ARTWORK_MANIFEST_FORMAT_VERSION = 1;

/** Current observation of one file under the configured source root. */
export interface SourceFile {
  /** Dropbox file ID (`id:…`). */
  fileId: string;
  /** Normalised (lower-case) path. */
  path: string;
  /** Original file name as stored. */
  name: string;
  rev: string;
  /** Dropbox content hash of the bytes. */
  contentHash: string;
  size: number;
  deleted: boolean;
  /** Source-index observation generation that saw this state. */
  observationEpoch: number;
}

export interface ManifestComponent extends SourceFile {
  ordinal: number;
  /** The exact stem the name matched. */
  matchedStem: string;
  via: "canonical" | "alias";
  aliasProvenance?: AliasProvenance;
  /** Other current paths with identical content; the selected path is recorded above. */
  duplicatePaths: string[];
}

export interface ArtworkManifest {
  code: string;
  components: ManifestComponent[];
}

export interface ComponentConflict {
  ordinal: number;
  /**
   * distinct_contents: two or more different live contents match one component.
   * shared_source: one file ID matches more than one component.
   */
  reason: "distinct_contents" | "shared_source";
  candidates: Array<{ fileId: string; path: string; contentHash: string }>;
}

export type ManifestResolution =
  | { status: "complete"; manifest: ArtworkManifest }
  | { status: "missing"; code: string; missingOrdinals: number[] }
  | { status: "ambiguous"; code: string; conflicts: ComponentConflict[]; missingOrdinals: number[] };

function compareCodepoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Candidate {
  file: SourceFile;
  stem: string;
  via: "canonical" | "alias";
  alias?: ArtworkAlias;
}

/**
 * Resolve the complete current manifest for one artwork. Ambiguity wins over
 * missing: a conflict needs review and should not wait for more files.
 * Throws for an invalid alias list (a data error, not a resolution outcome).
 */
export function resolveManifest(
  descriptor: ArtworkItem,
  currentFiles: readonly SourceFile[],
  approvedAliases: readonly ArtworkAlias[] = [],
): ManifestResolution {
  const check = validateAliases(approvedAliases);
  if (!check.ok) throw new RangeError(`invalid artwork alias list: ${check.problems.join("; ")}`);

  // An alias must not borrow another component's canonical name, or component
  // 01's file could also "fill" component 02.
  const canonicalOrdinal = new Map<string, number>();
  for (const expected of descriptor.components) {
    for (const stem of expected.stems) canonicalOrdinal.set(stem.toUpperCase(), expected.ordinal);
  }
  for (const expected of descriptor.components) {
    for (const a of approvedAliasesFor(descriptor.code, expected.ordinal, approvedAliases)) {
      const owner = canonicalOrdinal.get(a.stem.toUpperCase());
      if (owner !== undefined && owner !== expected.ordinal) {
        throw new RangeError(`invalid artwork alias list: alias ${a.stem} → ${descriptor.code}#${expected.ordinal} is the canonical name of ordinal ${owner}`);
      }
    }
  }

  const live = currentFiles.filter((f) => !f.deleted);
  const candidatesByOrdinal = descriptor.components.map((expected) => {
    const candidates: Candidate[] = [];
    for (const file of live) {
      const stem = expected.stems.find((s) => isCandidateName(file.name, s));
      if (stem) {
        candidates.push({ file, stem, via: "canonical" });
        continue;
      }
      const alias = approvedAliasesFor(descriptor.code, expected.ordinal, approvedAliases).find((a) => isCandidateName(file.name, a.stem));
      if (alias) candidates.push({ file, stem: alias.stem.toUpperCase(), via: "alias", alias });
    }
    return candidates;
  });

  // One source file can never stand in for two components.
  const ordinalsByFileId = new Map<string, Set<number>>();
  descriptor.components.forEach((expected, i) => {
    for (const c of candidatesByOrdinal[i]) {
      const set = ordinalsByFileId.get(c.file.fileId) ?? new Set<number>();
      set.add(expected.ordinal);
      ordinalsByFileId.set(c.file.fileId, set);
    }
  });

  const components: ManifestComponent[] = [];
  const conflicts: ComponentConflict[] = [];
  const missingOrdinals: number[] = [];

  for (const [i, expected] of descriptor.components.entries()) {
    const candidates = candidatesByOrdinal[i];
    const shared = candidates.filter((c) => (ordinalsByFileId.get(c.file.fileId)?.size ?? 0) > 1);
    if (shared.length > 0) {
      conflicts.push({
        ordinal: expected.ordinal,
        reason: "shared_source",
        candidates: shared
          .map((c) => ({ fileId: c.file.fileId, path: c.file.path, contentHash: c.file.contentHash }))
          .sort((a, b) => compareCodepoints(a.path, b.path)),
      });
      continue;
    }

    if (candidates.length === 0) {
      missingOrdinals.push(expected.ordinal);
      continue;
    }

    const hashes = [...new Set(candidates.map((c) => c.file.contentHash))];
    if (hashes.length > 1) {
      conflicts.push({
        ordinal: expected.ordinal,
        reason: "distinct_contents",
        candidates: candidates
          .map((c) => ({ fileId: c.file.fileId, path: c.file.path, contentHash: c.file.contentHash }))
          .sort((a, b) => compareCodepoints(a.path, b.path)),
      });
      continue;
    }

    // Same content under several paths: canonical names first, then normalised path.
    candidates.sort(
      (a, b) => (a.via === b.via ? 0 : a.via === "canonical" ? -1 : 1) || compareCodepoints(a.file.path, b.file.path),
    );
    const [selected, ...others] = candidates;
    components.push({
      ...selected.file,
      ordinal: expected.ordinal,
      matchedStem: selected.stem,
      via: selected.via,
      ...(selected.alias ? { aliasProvenance: selected.alias.provenance } : {}),
      duplicatePaths: others.map((c) => c.file.path),
    });
  }

  if (conflicts.length > 0) return { status: "ambiguous", code: descriptor.code, conflicts, missingOrdinals };
  if (missingOrdinals.length > 0) return { status: "missing", code: descriptor.code, missingOrdinals };
  return { status: "complete", manifest: { code: descriptor.code, components } };
}

function requireText(value: string, field: string, ordinal: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RangeError(`manifest component ${ordinal}: ${field} must be a non-empty string`);
  }
  return value;
}

/**
 * The exact digest input: a versioned JSON object with fixed key order and
 * components as `[ordinal, file_id, rev, content_hash]` sorted by ordinal.
 * Requires every ordinal 1…N exactly once and no deleted component.
 */
export function manifestPayload(manifest: ArtworkManifest, rendererVersion: string): string {
  if (typeof rendererVersion !== "string" || rendererVersion.length === 0) {
    throw new RangeError("renderer version must be a non-empty string");
  }
  const ordered = [...manifest.components].sort((a, b) => a.ordinal - b.ordinal);
  if (ordered.length === 0) throw new RangeError("manifest must contain ordinal 1");
  const tuples = ordered.map((c, i) => {
    if (c.ordinal !== i + 1) throw new RangeError(`manifest must contain each ordinal 1..${ordered.length} exactly once`);
    if (c.deleted) throw new RangeError(`manifest component ${c.ordinal} is deleted`);
    return [
      c.ordinal,
      requireText(c.fileId, "fileId", c.ordinal),
      requireText(c.rev, "rev", c.ordinal),
      requireText(c.contentHash, "contentHash", c.ordinal),
    ] as const;
  });
  return JSON.stringify({
    format: "inka-f3-artwork-manifest",
    version: ARTWORK_MANIFEST_FORMAT_VERSION,
    renderer: rendererVersion,
    components: tuples,
  });
}

/** Synchronous SHA-256 over bytes, returning lower-case hex. */
export type Sha256Hex = (bytes: Uint8Array) => string;

/** Revision identity: SHA-256 of the UTF-8 bytes of `manifestPayload`. */
export function revisionDigest(manifest: ArtworkManifest, rendererVersion: string, sha256: Sha256Hex): string {
  const digest = sha256(new TextEncoder().encode(manifestPayload(manifest, rendererVersion)));
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new RangeError("injected hash did not return lower-case SHA-256 hex");
  return digest;
}
