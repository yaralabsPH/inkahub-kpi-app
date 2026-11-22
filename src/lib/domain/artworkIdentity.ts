/**
 * F3 artwork thumbnails — canonical artwork identity (pure, no I/O).
 *
 * `artworkCodeFromSku` and `dropboxFilenamesForSku` in `skuRouting.ts` stay
 * the authority for the key and the expected component count/order; this
 * module only classifies the SKU and shapes their output. Size, frame and
 * quantity never enter the key.
 *
 * Imports use explicit `.js` extensions so `api/` can load this module as an
 * ES module on Vercel (see the Task 2 note in the plan's Implementation log).
 */

import { artworkCodeFromSku, dropboxFilenamesForSku, parseSku } from "./skuRouting.js";

export type ArtworkSkuType = "single_print" | "set_print" | "aux_free_print";

/** Parsed SKUs that deliberately have no artwork (explicit UI labels, no jobs). */
export type NonArtworkKind = "gift_card" | "frame_only" | "accessory";

/**
 * Why no artwork identity could be derived:
 *   blank          null/empty/whitespace
 *   legacy_unknown not a v6 `INKA-` SKU (legacy title strings etc.)
 *   malformed      `INKA-` prefix but not in the v6 grammar
 *   invalid_set    parses as a set with zero components (`S0…`)
 */
export type UnknownArtworkReason = "blank" | "legacy_unknown" | "malformed" | "invalid_set";

export interface ExpectedComponent {
  /** 1-based; component 01 is ordinal 1. */
  ordinal: number;
  /** Canonical source name without extension, e.g. `INKA-S3-WIL0049-01`. */
  stem: string;
  /** Every verified exact name form; `stem` first. Sets also accept `INKA-S3WIL0049-01`. */
  stems: readonly string[];
}

export interface ArtworkItem {
  kind: "artwork";
  code: string;
  skuType: ArtworkSkuType;
  components: ExpectedComponent[];
}

export type ArtworkDescriptor =
  | ArtworkItem
  | { kind: "non_artwork"; nonArtwork: NonArtworkKind }
  | { kind: "unknown"; reason: UnknownArtworkReason };

export function describeArtwork(sku: string | null | undefined): ArtworkDescriptor {
  const trimmed = (sku ?? "").trim();
  if (!trimmed) return { kind: "unknown", reason: "blank" };
  const p = parseSku(trimmed);
  if (!p) {
    return { kind: "unknown", reason: trimmed.toUpperCase().startsWith("INKA-") ? "malformed" : "legacy_unknown" };
  }
  switch (p.type) {
    case "gift_card":
      return { kind: "non_artwork", nonArtwork: "gift_card" };
    case "picture_frame":
      return { kind: "non_artwork", nonArtwork: "frame_only" };
    case "aux_other":
      return { kind: "non_artwork", nonArtwork: "accessory" };
    case "single_print":
    case "set_print":
    case "aux_free_print":
      break;
  }

  const code = artworkCodeFromSku(trimmed);
  const stems = dropboxFilenamesForSku(trimmed).map((name) => name.replace(/\.jpg$/, ""));
  if (!code) return { kind: "unknown", reason: "malformed" };
  if (stems.length === 0) return { kind: "unknown", reason: p.type === "set_print" ? "invalid_set" : "malformed" };

  const components = stems.map((stem, i): ExpectedComponent => {
    const ordinal = i + 1;
    if (p.type !== "set_print") return { ordinal, stem, stems: [stem] };
    // Verified in the Part 6 reference: set names with and without the `S{N}-` separator.
    const joined = `INKA-S${p.setCount}${p.mnemonic}${p.productId}-${String(ordinal).padStart(2, "0")}`;
    return { ordinal, stem, stems: joined === stem ? [stem] : [stem, joined] };
  });
  return { kind: "artwork", code, skuType: p.type, components };
}
