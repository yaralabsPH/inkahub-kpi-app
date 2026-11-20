/**
 * F2 order-display: turns a line's SKU into the labels the Production
 * order card shows (size, framed state, frame colour). Pure - derives
 * everything from the shared v6 parser and never guesses for SKUs the
 * parser does not understand.
 */
import { describeSku, friendlySize, parseSku } from "@/lib/domain/skuRouting";

export type OrderLineKind = "print" | "picture_frame" | "other" | "unknown";
export type OrderLineColourTone =
  | "black"
  | "white"
  | "natural"
  | "unframed"
  | "canvas"
  | "unknown";

export interface OrderLinePresentation {
  kind: OrderLineKind;
  sizeLabel: string | null;
  /** "Framed" | "Unframed" | "Frame only", or null when not known. */
  styleLabel: string | null;
  colourLabel: string;
  colourTone: OrderLineColourTone;
  /** Shopify / describeSku text, shown only when the SKU has no variant. */
  fallbackDescription: string | null;
}

const UNKNOWN_COLOUR = { colourLabel: "Unknown style", colourTone: "unknown" } as const;

export function getOrderLinePresentation(
  sku: string,
  variantTitle: string | null,
): OrderLinePresentation {
  const p = parseSku(sku);
  if (!p) {
    return {
      kind: "unknown",
      sizeLabel: null,
      styleLabel: null,
      ...UNKNOWN_COLOUR,
      fallbackDescription: variantTitle ?? describeSku(sku),
    };
  }

  const sizeLabel = p.size ? friendlySize(p.size) : null;
  switch (p.variant) {
    case "FB":
      return variantLine("print", sizeLabel, "Framed", "Black", "black");
    case "FW":
      return variantLine("print", sizeLabel, "Framed", "White", "white");
    case "FN":
      return variantLine("print", sizeLabel, "Framed", "Natural Timber", "natural");
    case "UN":
      return variantLine("print", sizeLabel, "Unframed", "No frame", "unframed");
    case "SC":
      return variantLine("print", sizeLabel, "Unframed", "Stretched canvas", "canvas");
    case "PB":
      return variantLine("picture_frame", sizeLabel, "Frame only", "Black", "black");
    case "PW":
      return variantLine("picture_frame", sizeLabel, "Frame only", "White", "white");
    case "PN":
      return variantLine("picture_frame", sizeLabel, "Frame only", "Natural Timber", "natural");
    default:
      // Gift cards and AUX lines: parsed, but no frame variant to show.
      return {
        kind: "other",
        sizeLabel,
        styleLabel: null,
        ...UNKNOWN_COLOUR,
        fallbackDescription: variantTitle ?? describeSku(sku),
      };
  }
}

function variantLine(
  kind: OrderLineKind,
  sizeLabel: string | null,
  styleLabel: string,
  colourLabel: string,
  colourTone: OrderLineColourTone,
): OrderLinePresentation {
  return { kind, sizeLabel, styleLabel, colourLabel, colourTone, fallbackDescription: null };
}
