import { parseSku, type SizeCode } from "@/lib/domain/skuRouting";

/**
 * F4 box-auto-pick: what has to be packed, and where.
 *
 * A packing point is the station where a parcel is physically packed. An
 * order can have more than one (A0 framed ships from the A0 bench, smaller
 * frames from Dispatch). See docs/specs/box-auto-pick.md, "Terms".
 */
export type PackingPoint = "a0_framed" | "dispatch" | "unframed";

export const PACKING_POINTS: PackingPoint[] = ["a0_framed", "dispatch", "unframed"];

export type PieceKind = "framed" | "unframed" | "picture_frame" | "free_print" | "accessory";

export const PIECE_KINDS: PieceKind[] = ["framed", "unframed", "picture_frame", "free_print", "accessory"];

export const PIECE_SIZES: SizeCode[] = ["A0", "A1", "A2", "A3", "A4", "GW"];

export interface PieceGroup {
  kind: PieceKind;
  /** null for accessories, which have no print size. */
  size: SizeCode | null;
  pieces: number;
}

export interface PackagingContents {
  pieces: PieceGroup[];
  /** SKUs we could not classify (unknown format, canvas). They make a pick unresolved. */
  unclassified: string[];
}

export interface PackagingLineInput {
  sku: string | null | undefined;
  quantity: number | null | undefined;
}

/**
 * Every line of a fetched order, as packaging input. Unlike the station's
 * display/routing list this keeps blank-SKU lines: they are physical items
 * the rules cannot classify, so the pick must stay unresolved, not guessed.
 */
export function packagingLinesFromOrder(
  items: ReadonlyArray<{ sku?: string | null; quantity?: number | null }>,
): PackagingLineInput[] {
  return items.map((it) => ({ sku: it.sku ?? null, quantity: typeof it.quantity === "number" && it.quantity > 0 ? it.quantity : 1 }));
}

export function isPackingPoint(value: string): value is PackingPoint {
  return (PACKING_POINTS as string[]).includes(value);
}

function emptyContents(): PackagingContents {
  return { pieces: [], unclassified: [] };
}

function addPieces(c: PackagingContents, kind: PieceKind, size: SizeCode | null, pieces: number): void {
  if (pieces <= 0) return;
  const hit = c.pieces.find((g) => g.kind === kind && g.size === size);
  if (hit) hit.pieces += pieces;
  else c.pieces.push({ kind, size, pieces });
}

function wholeQuantity(q: number | null | undefined): number {
  return typeof q === "number" && Number.isFinite(q) && q > 0 ? Math.floor(q) : 1;
}

/**
 * Split an order's lines into the parcels that get packed, keyed by packing
 * point. Only packing points with something to pack appear in the result.
 *
 * - A0 framed prints and A0 picture frames are packed at A0 Framed.
 * - Other framed prints and picture frames are packed at Dispatch.
 * - Unframed prints, free prints, accessories and unclassifiable lines travel
 *   with a framed parcel when the order has one (Dispatch first, else A0
 *   Framed). With no framed parcel they are packed at Unframed when the
 *   order has any unframed or free print, else at Dispatch.
 * - Gift cards are never packed.
 *
 * Set SKUs count setCount pieces per unit (2 x S2 = 4 pieces).
 */
export function packingPointsForOrder(lines: PackagingLineInput[]): Map<PackingPoint, PackagingContents> {
  const fixed = new Map<PackingPoint, PackagingContents>();
  const travellers = emptyContents();
  let hasFlat = false;

  const at = (point: PackingPoint): PackagingContents => {
    let c = fixed.get(point);
    if (!c) {
      c = emptyContents();
      fixed.set(point, c);
    }
    return c;
  };

  for (const line of lines) {
    const raw = (line.sku ?? "").trim();
    const qty = wholeQuantity(line.quantity);
    const p = parseSku(raw);
    if (!p) {
      travellers.unclassified.push(raw || "(no SKU)");
      continue;
    }
    if (p.type === "gift_card") continue;

    if (p.type === "single_print" || p.type === "set_print") {
      const pieces = qty * (p.type === "set_print" && p.setCount && p.setCount > 0 ? p.setCount : 1);
      if (p.variant === "SC" || !p.size) {
        travellers.unclassified.push(raw);
      } else if (p.variant === "UN") {
        hasFlat = true;
        addPieces(travellers, "unframed", p.size, pieces);
      } else {
        addPieces(at(p.size === "A0" ? "a0_framed" : "dispatch"), "framed", p.size, pieces);
      }
      continue;
    }
    if (p.type === "picture_frame") {
      if (!p.size) travellers.unclassified.push(raw);
      else addPieces(at(p.size === "A0" ? "a0_framed" : "dispatch"), "picture_frame", p.size, qty);
      continue;
    }
    if (p.type === "aux_free_print") {
      hasFlat = true;
      addPieces(travellers, "free_print", p.size ?? null, qty);
      continue;
    }
    // aux_other
    addPieces(travellers, "accessory", null, qty);
  }

  if (travellers.pieces.length > 0 || travellers.unclassified.length > 0) {
    const carrier: PackingPoint = fixed.has("dispatch")
      ? "dispatch"
      : fixed.has("a0_framed")
        ? "a0_framed"
        : hasFlat
          ? "unframed"
          : "dispatch";
    const c = at(carrier);
    for (const g of travellers.pieces) addPieces(c, g.kind, g.size, g.pieces);
    c.unclassified.push(...travellers.unclassified);
  }
  return fixed;
}

/** Contents for one packing point; empty when the order packs nothing there. */
export function packagingContents(lines: PackagingLineInput[], point: PackingPoint): PackagingContents {
  return packingPointsForOrder(lines).get(point) ?? emptyContents();
}

export function totalPieces(c: PackagingContents): number {
  return c.pieces.reduce((s, g) => s + g.pieces, 0);
}
