/**
 * F3 artwork thumbnails — exact source-name grammar and approved aliases
 * (pure, no I/O).
 *
 * A source file is a candidate for a component only when its name is one of
 * the component's exact stems followed by the observed suffix forms below.
 * The grammar mirrors the Part 6 reference validator (`validate-order.js`):
 *
 *   STEM [_SIZE] [_FIXED] [" (n)"] [.EXT [.EXT repeated once]]
 *
 *   _SIZE   _A0…_A4, _5A1/_5A3 or _{w}X{h} (one library file serves every size)
 *   " (n)"  a one- or two-digit copy marker
 *   .EXT    jpg/jpeg/png/tif/tiff/webp; extensionless is allowed
 *
 * No substring, prefix or fuzzy matching. The grammar never chooses between
 * two different live contents — that is a conflict for the resolver.
 * Anything else (legacy free-print names, size-labelled free prints) needs an
 * explicit alias with provenance, approved after an audit.
 */

import { ARTWORK_IMAGE_LIMITS } from "./artworkImagePolicy.js";

const SIZE_SUFFIX = "(?:_(?:A[0-4]|5A[13]|\\d{1,3}X\\d{1,3}))?";
const FIXED_SUFFIX = "(?:_FIXED)?";
const COPY_SUFFIX = "(?: \\(\\d{1,2}\\))?";
const EXTENSION = "(?:\\.(JPE?G|PNG|TIFF?|WEBP)(?:\\.\\1)?)?";

/** Stems are upper-case letters, digits and hyphens only. */
const STEM_RE = /^[A-Z0-9-]+$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Is `name` (a file's basename) an exact candidate for `stem`? Case-insensitive. */
export function isCandidateName(name: string, stem: string): boolean {
  const pattern = new RegExp(`^${escapeRegExp(stem.toUpperCase())}${SIZE_SUFFIX}${FIXED_SUFFIX}${COPY_SUFFIX}${EXTENSION}$`);
  return pattern.test(name.toUpperCase());
}

export interface AliasProvenance {
  /** Where the alias came from, e.g. "packing-preview-index-v1" or an audit note. */
  source: string;
  note?: string;
  /** Required for an approved alias. */
  verifiedBy?: string;
  /** ISO timestamp; required for an approved alias. */
  verifiedAt?: string;
}

/**
 * An explicit extra stem for one component of one canonical artwork. Only
 * `approved` aliases are used; `unverified` ones are recorded so they can be
 * audited but never resolve anything.
 */
export interface ArtworkAlias {
  code: string;
  ordinal: number;
  stem: string;
  status: "approved" | "unverified";
  provenance: AliasProvenance;
}

/** Printed inserts with their own exact-name rules: never a free-print alias. */
export const FORBIDDEN_ALIAS_STEMS: readonly string[] = ["INKA-AUXIMH", "INKA-AUXMFL"];

/**
 * Legacy names seen in the Part 6 index that look like candidates for
 * free-print codes. Disabled until CJ audits each against the intended artwork.
 */
export const LEGACY_ALIAS_CANDIDATES: readonly ArtworkAlias[] = [
  { code: "ESP", ordinal: 1, stem: "INKA-AUXESP", status: "unverified", provenance: { source: "packing-preview-index-v1" } },
  { code: "MCO", ordinal: 1, stem: "INKA-AUXMCO", status: "unverified", provenance: { source: "packing-preview-index-v1" } },
  { code: "MCO", ordinal: 1, stem: "INKA-AUX-FP-MCO-A2", status: "unverified", provenance: { source: "packing-preview-index-v1" } },
];

export function validateAliases(aliases: readonly ArtworkAlias[]): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const targets = new Map<string, string>();
  for (const a of aliases) {
    const stem = a.stem.toUpperCase();
    const label = `alias ${a.stem} → ${a.code}#${a.ordinal}`;
    if (!STEM_RE.test(stem)) problems.push(`${label}: stem must be letters, digits and hyphens`);
    if (FORBIDDEN_ALIAS_STEMS.includes(stem)) problems.push(`${label}: ${stem} is a printed insert, not artwork`);
    if (!a.code.trim()) problems.push(`${label}: empty code`);
    if (!Number.isInteger(a.ordinal) || a.ordinal < 1 || a.ordinal > ARTWORK_IMAGE_LIMITS.maxSetComponents) {
      problems.push(`${label}: ordinal must be 1..${ARTWORK_IMAGE_LIMITS.maxSetComponents}`);
    }
    if (a.status === "approved" && (!a.provenance.verifiedBy || !a.provenance.verifiedAt)) {
      problems.push(`${label}: approval needs verifiedBy and verifiedAt`);
    }
    const target = `${a.code.toUpperCase()}#${a.ordinal}`;
    const prior = targets.get(stem);
    if (prior !== undefined && prior !== target) problems.push(`${label}: stem already bound to ${prior}`);
    targets.set(stem, prior ?? target);
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/** Approved aliases for one component. Callers validate the list first. */
export function approvedAliasesFor(code: string, ordinal: number, aliases: readonly ArtworkAlias[]): ArtworkAlias[] {
  const wanted = code.toUpperCase();
  return aliases.filter((a) => a.status === "approved" && a.ordinal === ordinal && a.code.toUpperCase() === wanted);
}
