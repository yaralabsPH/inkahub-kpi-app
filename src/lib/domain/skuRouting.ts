/**
 * v6 Inka SKU parser + production-dept routing + friendly UI labels.
 *
 * Six product types in the v6 grammar (June 2026):
 *
 *   single_print     INKA-{MNEM}{ID}-{SIZE}-{VARIANT}     e.g. INKA-KAN0566-A4-FB
 *   set_print        INKA-S{N}{MNEM}{ID}-{SIZE}-{VARIANT} e.g. INKA-S3WIL0049-A2-FN
 *   picture_frame    INKA-PF{ID}-{SIZE}-{VARIANT}         e.g. INKA-PF0004-A0-PW
 *   gift_card        INKA-GC{ID}-{AMOUNT}                 e.g. INKA-GC0001-100
 *   aux_free_print   INKA-AUX-FP-{MNEM}-{SIZE}            e.g. INKA-AUX-FP-ESP-A2
 *   aux_other        INKA-AUX-{KEYWORD}                   e.g. INKA-AUX-HOOK
 *
 * MNEM is normally three letters; two-letter mnemonics exist in the
 * catalogue (NO0338 etc) so we accept 2-3.
 *
 * SIZE is A0-A4 or GW (Gallery Wall composite, used by 5/6-piece sets).
 *
 * VARIANT codes:
 *   UN unframed | FB framed black | FW framed white | FN framed natural
 *   SC stretched canvas
 *   PB picture frame only - black | PW white | PN natural
 */

export type ProductionDeptKey = "a0_framed" | "framed" | "unframed" | "dispatch";
export type LineProductionDept = Exclude<ProductionDeptKey, "dispatch">;

export type SkuType =
  | "single_print"
  | "set_print"
  | "picture_frame"
  | "gift_card"
  | "aux_free_print"
  | "aux_other";

export type SizeCode = "A0" | "A1" | "A2" | "A3" | "A4" | "GW";
export type VariantCode = "UN" | "FB" | "FW" | "FN" | "SC" | "PB" | "PW" | "PN";

export interface ParsedSku {
  raw: string;
  type: SkuType;
  mnemonic?: string;
  productId?: string;
  setCount?: number;
  size?: SizeCode;
  variant?: VariantCode;
  pfId?: string;
  gcId?: string;
  amount?: number;
  auxKeyword?: string;
}

const SIZE_RE = "A[0-4]|GW";
const PRINT_VAR_RE = "UN|FB|FW|FN|SC";
const PF_VAR_RE = "P[BWN]";

const RE_AUX_FP = new RegExp(`^INKA-AUX-FP-([A-Z]{2,3})-(${SIZE_RE})$`);
const RE_AUX_OTHER = /^INKA-AUX-([A-Z0-9]+)$/;
const RE_GC = /^INKA-GC(\d{4})-(\d+)$/;
const RE_PF = new RegExp(`^INKA-PF(\\d{4})-(${SIZE_RE})-(${PF_VAR_RE})$`);
const RE_SET = new RegExp(`^INKA-S(\\d)([A-Z]{2,3})(\\d{4})-(${SIZE_RE})-(${PRINT_VAR_RE})$`);
const RE_SINGLE = new RegExp(`^INKA-([A-Z]{2,3})(\\d{4})-(${SIZE_RE})-(${PRINT_VAR_RE})$`);

export function parseSku(rawSku: string | null | undefined): ParsedSku | null {
  if (!rawSku) return null;
  const sku = rawSku.trim().toUpperCase();
  if (!sku.startsWith("INKA-")) return null;

  let m = RE_AUX_FP.exec(sku);
  if (m) {
    return {
      raw: rawSku,
      type: "aux_free_print",
      mnemonic: m[1],
      size: m[2] as SizeCode,
    };
  }

  if (sku.startsWith("INKA-AUX-")) {
    m = RE_AUX_OTHER.exec(sku);
    if (m) {
      return { raw: rawSku, type: "aux_other", auxKeyword: m[1] };
    }
  }

  m = RE_GC.exec(sku);
  if (m) {
    return { raw: rawSku, type: "gift_card", gcId: m[1], amount: Number(m[2]) };
  }

  m = RE_PF.exec(sku);
  if (m) {
    return {
      raw: rawSku,
      type: "picture_frame",
      pfId: m[1],
      size: m[2] as SizeCode,
      variant: m[3] as VariantCode,
    };
  }

  m = RE_SET.exec(sku);
  if (m) {
    return {
      raw: rawSku,
      type: "set_print",
      setCount: Number(m[1]),
      mnemonic: m[2],
      productId: m[3],
      size: m[4] as SizeCode,
      variant: m[5] as VariantCode,
    };
  }

  m = RE_SINGLE.exec(sku);
  if (m) {
    return {
      raw: rawSku,
      type: "single_print",
      mnemonic: m[1],
      productId: m[2],
      size: m[3] as SizeCode,
      variant: m[4] as VariantCode,
    };
  }

  return null;
}

export function routeSkuToDepartment(sku: string | null | undefined): LineProductionDept | null {
  const p = parseSku(sku);
  if (!p) return null;
  if (p.type === "gift_card" || p.type === "picture_frame" || p.type === "aux_other") {
    return null;
  }
  if (p.type === "single_print" || p.type === "set_print" || p.type === "aux_free_print") {
    if (p.variant === "UN") return "unframed";
    if (p.variant === "SC") return null;
    if (p.size === "A0") return "a0_framed";
    return "framed";
  }
  return null;
}

export function isSkuProductionRelevant(sku: string | null | undefined): boolean {
  const p = parseSku(sku);
  if (!p) return true;
  return p.type === "single_print"
      || p.type === "set_print"
      || p.type === "aux_free_print";
}

export function skuTypeBadge(sku: string | null | undefined): string {
  const p = parseSku(sku);
  if (!p) return "LEGACY";
  if (p.variant === "SC") return "CANVAS";
  switch (p.type) {
    case "single_print":   return "PRINT";
    case "set_print":      return `SET (${p.setCount})`;
    case "picture_frame":  return "FRAME";
    case "gift_card":      return "GIFT";
    case "aux_free_print": return "FREE";
    case "aux_other":      return "AUX";
  }
  return "?";
}

export function artworkCodeFromSku(sku: string | null | undefined): string | null {
  const p = parseSku(sku);
  if (!p) return null;
  switch (p.type) {
    case "single_print": return `${p.mnemonic}${p.productId}`;
    case "set_print":    return `S${p.setCount}${p.mnemonic}${p.productId}`;
    case "aux_free_print": return p.mnemonic ?? null;
    default: return null;
  }
}

export function dropboxFilenamesForSku(sku: string | null | undefined): string[] {
  const p = parseSku(sku);
  if (!p) return [];
  switch (p.type) {
    case "single_print":
      return [`INKA-${p.mnemonic}${p.productId}.jpg`];
    case "set_print": {
      const out: string[] = [];
      const count = p.setCount ?? 0;
      for (let i = 1; i <= count; i++) {
        out.push(`INKA-S${count}-${p.mnemonic}${p.productId}-${String(i).padStart(2, "0")}.jpg`);
      }
      return out;
    }
    case "aux_free_print":
      return [`INKA-AUX-FP-${p.mnemonic}.jpg`];
    default: return [];
  }
}

export function isSkuAux(sku: string | null | undefined): boolean {
  const p = parseSku(sku);
  return p?.type === "aux_free_print" || p?.type === "aux_other";
}
export function isSkuGiftCard(sku: string | null | undefined): boolean {
  return parseSku(sku)?.type === "gift_card";
}
export function isSkuSet(sku: string | null | undefined): boolean {
  return parseSku(sku)?.type === "set_print";
}
export function isSkuPictureFrame(sku: string | null | undefined): boolean {
  return parseSku(sku)?.type === "picture_frame";
}
export function isSkuStretchedCanvas(sku: string | null | undefined): boolean {
  return parseSku(sku)?.variant === "SC";
}

export function isLineForStation(
  sku: string | null | undefined,
  stationDept: ProductionDeptKey,
): boolean {
  if (stationDept === "dispatch") return true;
  const lineDept = routeSkuToDepartment(sku);
  return lineDept === stationDept;
}

// ---------------------------------------------------------------------------
// Friendly labels - human-readable size + variant text for UI display.
// ---------------------------------------------------------------------------

const SIZE_FRIENDLY: Record<SizeCode, string> = {
  A0: "A0 (84 x 119 cm)",
  A1: "A1 (60 x 84 cm)",
  A2: "A2 (42 x 60 cm)",
  A3: "A3 (30 x 42 cm)",
  A4: "A4 (21 x 30 cm)",
  GW: "Gallery Wall",
};

const VARIANT_FRIENDLY: Record<VariantCode, string> = {
  UN: "Unframed Print",
  FB: "Framed - Black",
  FW: "Framed - White",
  FN: "Framed - Natural Timber",
  SC: "Stretched Canvas",
  PB: "Black",
  PW: "White",
  PN: "Natural Timber",
};

export function friendlySize(size: SizeCode | undefined): string {
  if (!size) return "";
  return SIZE_FRIENDLY[size] ?? size;
}

export function friendlyVariant(variant: VariantCode | undefined): string {
  if (!variant) return "";
  return VARIANT_FRIENDLY[variant] ?? variant;
}

/**
 * One-line description of what the line actually IS. Type-adaptive.
 */
export function describeSku(
  rawSku: string | null | undefined,
  fallback?: string | null,
): string {
  const p = parseSku(rawSku);
  if (!p) {
    // Legacy v3 / malformed SKUs: prefer the caller's fallback (typically
    // Shopify's variantTitle like "A4 21x30 cm / Framed Print (Black)").
    return (fallback && fallback.trim().length > 0) ? fallback : (rawSku ?? "");
  }
  switch (p.type) {
    case "single_print":
      return `${friendlySize(p.size)} - ${friendlyVariant(p.variant)}`;
    case "set_print":
      return `Set of ${p.setCount} - ${friendlySize(p.size)} - ${friendlyVariant(p.variant)}`;
    case "picture_frame":
      return `Picture Frame Only - ${friendlySize(p.size)} - ${friendlyVariant(p.variant)}`;
    case "gift_card":
      return `Gift Card - $${p.amount}`;
    case "aux_free_print":
      return `Free Print - ${friendlySize(p.size)} - ${p.mnemonic ?? ""}`;
    case "aux_other":
      return `Accessory - ${p.auxKeyword ?? ""}`;
  }
  return rawSku ?? "";
}

// ---------------------------------------------------------------------------
// Phase 6 - verifiability + colour-coded variant chip
// ---------------------------------------------------------------------------

/**
 * Can this line be ticked off by a worker at the kiosk?
 *   - Gift cards: never
 *   - AUX free prints + framed station: not here (handled elsewhere)
 *   - Everything else: yes, anywhere
 */
export function isSkuVerifiable(
  sku: string | null | undefined,
  _stationDept?: ProductionDeptKey,
): boolean {
  const p = parseSku(sku);
  if (!p) return true; // legacy / unknown - default to verifiable
  // Gift cards are the only universally-non-verifiable type. Station-
  // specific "this line is my work" routing now lives in isLineMyDept.
  return p.type !== "gift_card";
}

/**
 * Tailwind classes for a pill that VISUALLY matches the frame colour.
 * Black background for FB/PB, white for FW/PW, amber-800 (natural wood)
 * for FN/PN. WCAG AA contrast checked.
 */
export function variantChipClass(variant: VariantCode | undefined): string {
  const base = "inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide whitespace-nowrap";
  switch (variant) {
    case "FB":
    case "PB":
      return base + " bg-slate-950 text-white";
    case "FW":
    case "PW":
      return base + " bg-white text-slate-900 ring-1 ring-slate-400 dark:ring-slate-500";
    case "FN":
    case "PN":
      return base + " bg-amber-800 text-amber-50";
    case "SC":
      return base + " bg-stone-300 text-stone-900 ring-1 ring-stone-400 dark:bg-stone-700 dark:text-stone-100 dark:ring-stone-600";
    case "UN":
      return base + " bg-slate-100 text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700";
    default:
      return base + " bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
  }
}

// ---------------------------------------------------------------------------
// Shopify line item -> catalogue component line(s) router.
// Used by the CS Cases "Add" button to turn a customer-facing variant SKU
// into the actual replaceable stock items.
// ---------------------------------------------------------------------------

export interface RoutedCatalogueLine {
  /** Catalogue product code (e.g. "A1N"). */
  code: string;
  /** Total quantity for this catalogue code. */
  qty: number;
}

/** Per-variant mapping from v6 variant -> catalogue colour-name suffix. */
function componentColourName(variant: VariantCode | undefined): string | null {
  switch (variant) {
    case "UN": return "Unframed";
    case "FB":
    case "PB": return "Black";
    case "FW":
    case "PW": return "White";
    case "FN":
    case "PN": return "Natural";
    case "SC": return null; // canvas not yet stocked
    default: return null;
  }
}

/**
 * Decompose a Shopify SKU + ordered quantity into the catalogue components
 * needed for a replacement. Empty array = nothing to replace.
 *
 * Set quantity is multiplied: ordering 1x INKA-S3WIL0049-A2-FN means we
 * need 3 frame kits (A2N x 3) to replace it.
 *
 * Gallery Wall (GW) is currently hard-coded as a 6-piece configuration
 * (4x A2 + 2x A3) per business rule. Other GW set counts return an
 * empty-with-error signal via the returned `notes` field on the result.
 */
export interface ShopifyLineRoute {
  lines: RoutedCatalogueLine[];
  /** Reason the router couldn't add anything (when lines is empty). */
  reason?: string;
}

export function routeShopifyLineToCatalogueLines(
  sku: string | null | undefined,
  shopifyQty: number,
): ShopifyLineRoute {
  if (!sku) return { lines: [], reason: "Shopify line has no SKU." };
  const qty = Number.isFinite(shopifyQty) && shopifyQty > 0 ? shopifyQty : 1;
  const p = parseSku(sku);
  if (!p) {
    return { lines: [], reason: `Cannot parse "${sku}" - legacy or unrecognised SKU, add manually below.` };
  }

  if (p.type === "gift_card") {
    return { lines: [], reason: `Gift cards don't need a physical replacement.` };
  }

  if (p.type === "aux_other") {
    // AUX accessories (e.g. INKA-AUX-HOOK) pass through as the literal code.
    return { lines: [{ code: sku.trim().toUpperCase(), qty }] };
  }

  if (p.type === "aux_free_print") {
    // Free prints are paper at the matching size.
    if (!p.size || p.size === "GW") {
      return { lines: [], reason: `Unsupported size on free print "${sku}".` };
    }
    return { lines: [{ code: `${p.size}-Unframed`, qty }] };
  }

  // Single, set, or picture-frame-only.
  const colour = componentColourName(p.variant);
  if (!colour) {
    if (p.variant === "SC") {
      return { lines: [], reason: `Stretched Canvas (SC) is not yet stocked - add manually below.` };
    }
    return { lines: [], reason: `Unknown variant "${p.variant}" on "${sku}".` };
  }

  // Gallery Wall decomposition (sets only).
  if (p.size === "GW") {
    if (p.type !== "set_print") {
      return { lines: [], reason: `Gallery Wall size only valid for set prints.` };
    }
    if (p.setCount === 6) {
      // 6-piece GW = 4x A2 + 2x A3 (business rule)
      return {
        lines: [
          { code: `A2-${colour}`, qty: qty * 4 },
          { code: `A3-${colour}`, qty: qty * 2 },
        ],
      };
    }
    return {
      lines: [],
      reason: `Gallery Wall mix for S${p.setCount} not configured yet - add manually below.`,
    };
  }

  // Standard size A0-A4.
  if (!p.size) {
    return { lines: [], reason: `Missing size on "${sku}".` };
  }
  const code = `${p.size}-${colour}`;
  if (p.type === "set_print") {
    const n = p.setCount ?? 1;
    return { lines: [{ code, qty: qty * n }] };
  }
  // single_print or picture_frame
  return { lines: [{ code, qty }] };
}

/**
 * Map a catalogue product's `colour` text -> v6 VariantCode, for cases
 * where we want to render a colour-coded variant chip but only have the
 * catalogue row (no source Shopify SKU to parse). Returns undefined for
 * unrecognised colours; caller can fall back to plain text.
 */
export function catalogueColourToVariant(
  colour: string | null | undefined,
): VariantCode | undefined {
  const c = (colour ?? "").trim().toLowerCase();
  if (c === "natural" || c === "natural timber") return "FN";
  if (c === "black") return "FB";
  if (c === "white") return "FW";
  if (c === "unframed") return "UN";
  return undefined;
}

/**
 * Detect portrait vs landscape from a Shopify variantTitle string.
 * Currently only meaningful for sizes that offer the choice (A0 mostly).
 * Returns null when the string doesn't mention either orientation.
 */
export function detectOrientation(
  s: string | null | undefined,
): "portrait" | "landscape" | null {
  if (!s) return null;
  const t = s.toLowerCase();
  if (t.includes("portrait")) return "portrait";
  if (t.includes("landscape")) return "landscape";
  return null;
}

/**
 * Per-station routing: should this line be highlighted as the worker's
 * "directly actioned" item? Drives the green-tinted background on the
 * Production kiosk. Verifiability is separate (gift cards excluded;
 * everything else is verifiable so workers can still tick other-dept
 * lines if needed).
 *
 *   dispatch    : everything except gift cards (last stage, packs all)
 *   framed      : everything except A0 framed (framed dept handles mixed
 *                 orders end-to-end - bundles unframed lines etc.)
 *   a0_framed   : A0 framed prints / picture frames + AUX
 *   unframed    : unframed prints + AUX
 *
 * Returns true when the line is the current station's direct work.
 */
export function isLineMyDept(
  sku: string | null | undefined,
  stationDept: ProductionDeptKey,
): boolean {
  const p = parseSku(sku);
  if (!p) return true; // legacy / unknown - default to mine (fail-open)
  if (p.type === "gift_card") return false;

  if (stationDept === "dispatch") return true;

  // Helper: is this a print SKU at A0 size with a frame variant?
  const isA0Framed =
    (p.type === "single_print" || p.type === "set_print") &&
    p.size === "A0" &&
    p.variant !== "UN";
  const isA0PictureFrame = p.type === "picture_frame" && p.size === "A0";

  if (stationDept === "a0_framed") {
    if (isA0Framed || isA0PictureFrame) return true;
    if (p.type === "aux_free_print" || p.type === "aux_other") return true;
    return false;
  }

  if (stationDept === "unframed") {
    if ((p.type === "single_print" || p.type === "set_print") && p.variant === "UN") return true;
    if (p.type === "aux_free_print" || p.type === "aux_other") return true;
    return false;
  }

  if (stationDept === "framed") {
    // Everything except A0 framed (incl. unframed lines in mixed orders).
    if (isA0Framed || isA0PictureFrame) return false;
    return true;
  }

  return false;
}

/**
 * Phase A: should this line trigger inventory deduction at the given
 * station + event_type? Implements the "last-touch dept" rules:
 *
 *   Single/set framed (A1-A4)  -> dispatch  'dispatched'
 *   Single/set framed A0       -> a0_framed 'completed'
 *   Single/set unframed        -> unframed  'completed'
 *   Picture frame              -> dispatch  'dispatched'
 *   AUX free print             -> unframed  'completed'
 *   AUX accessory              -> a0_framed 'completed' (A0 terminal) OR dispatch 'dispatched'
 *   Gift card                  -> never
 *   Stretched canvas (SC)      -> never (workflow not yet defined)
 *   Unparseable / unknown      -> never (server can't decompose anyway)
 */
export function shouldDeductAtDept(
  sku: string | null | undefined,
  stationDept: ProductionDeptKey,
  eventType: "completed" | "dispatched",
): boolean {
  const p = parseSku(sku);
  if (!p) return false;
  if (p.type === "gift_card") return false;

  if (p.type === "single_print" || p.type === "set_print") {
    if (p.variant === "SC") return false; // canvas workflow not defined
    if (p.variant === "UN") {
      return stationDept === "unframed" && eventType === "completed";
    }
    if (p.size === "A0") {
      return stationDept === "a0_framed" && eventType === "completed";
    }
    return stationDept === "dispatch" && eventType === "dispatched";
  }

  if (p.type === "picture_frame") {
    return stationDept === "dispatch" && eventType === "dispatched";
  }

  if (p.type === "aux_free_print") {
    return stationDept === "unframed" && eventType === "completed";
  }

  if (p.type === "aux_other") {
    // A0 framer is terminal (packs + ships from A0 station, no dispatch
    // handoff). Non-A0 orders are terminal at dispatch. Accessories
    // deduct at whichever terminal the order goes through. The migration
    // 0031 order-based idempotency prevents double-deducting when a mixed
    // order touches both terminals.
    if (stationDept === "dispatch" && eventType === "dispatched") return true;
    if (stationDept === "a0_framed" && eventType === "completed") return true;
    return false;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Package-type catalogue for the A0 Framed + Dispatch shipping benches.
// Each entry has the catalogue code to deduct from stock, a label for UI
// display, and the keyboard shortcut the barcode emits when scanned.
// ---------------------------------------------------------------------------

export interface PackageType {
  /** Catalogue product code - must exist in products.code for deduction. */
  key: string;
  /** Display label shown on the kiosk. */
  label: string;
  /** Single-character key pressed with Ctrl when the barcode is scanned (legacy / unused). */
  shortcut: string;
  /** Scanner-emitted pattern when the box barcode is scanned (e.g. "+48="). */
  barcode: string;
  /** Stations that can select this package type. */
  availableAt: ProductionDeptKey[];
}

export const PACKAGE_TYPES: PackageType[] = [
  { key: "A0-Double",      label: "A0 Double",      shortcut: "0", barcode: "+48=", availableAt: ["a0_framed"] },
  { key: "A0-Single",      label: "A0 Single",      shortcut: "1", barcode: "+49=", availableAt: ["a0_framed"] },
  { key: "A1-Single",      label: "A1 Single",      shortcut: "2", barcode: "+50=", availableAt: ["dispatch"] },
  { key: "A1-Double-Wide", label: "A1 Double Wide", shortcut: "3", barcode: "+51=", availableAt: ["dispatch"] },
  { key: "NZ",             label: "NZ",             shortcut: "4", barcode: "+52=", availableAt: ["dispatch"] },
  { key: "A2-Double",      label: "A2 Double",      shortcut: "6", barcode: "+54=", availableAt: ["dispatch"] },
  { key: "A3-A4",          label: "A3/A4",          shortcut: "7", barcode: "+55=", availableAt: ["dispatch"] },
];

/**
 * Find the package type a given keyboard shortcut maps to at this station.
 * Returns null if the key is invalid or unavailable at the station.
 */
export function packageFromShortcut(
  key: string,
  stationDept: ProductionDeptKey,
): PackageType | null {
  return (
    PACKAGE_TYPES.find(
      (p) => p.shortcut === key && p.availableAt.includes(stationDept),
    ) ?? null
  );
}

/**
 * Find the package type a scanned box barcode maps to at this station.
 * Pattern: "+NN=" (e.g. "+48=" -> A0 Double). Returns null if the
 * barcode doesn't match any known package or the package isn't allowed
 * at this dept.
 */
export function packageFromBarcode(
  barcode: string,
  stationDept: ProductionDeptKey,
): PackageType | null {
  return (
    PACKAGE_TYPES.find(
      (p) => p.barcode === barcode && p.availableAt.includes(stationDept),
    ) ?? null
  );
}

/**
 * Mail tube product IDs - referenced directly by id because the kiosk
 * auto-assigns these (no barcode scanning) and we want to be tolerant of
 * whatever code field they carry.
 */
export const MAIL_TUBE_LARGE_PRODUCT_ID = "sku-xniriygn"; // 90mm x 990mm - for A0 unframed
export const MAIL_TUBE_SMALL_PRODUCT_ID = "sku-2jiumpm4"; // 60mm x 660mm - for A4-A1 unframed

export const MAIL_TUBE_LABELS: Record<string, string> = {
  [MAIL_TUBE_LARGE_PRODUCT_ID]: "Mail Tube 90mm x 990mm",
  [MAIL_TUBE_SMALL_PRODUCT_ID]: "Mail Tube 60mm x 660mm",
};

/**
 * For an Unframed-station order, return the mail tube product id to
 * auto-assign as the packaging. Returns null when there are no unframed
 * lines (in which case nothing ships from this bench).
 */
export function autoMailTubeForUnframedOrder(
  skus: Array<string | null | undefined>,
): string | null {
  let hasUnframed = false;
  let hasA0Unframed = false;
  for (const sku of skus) {
    const p = parseSku(sku);
    if (!p) continue;
    if ((p.type === "single_print" || p.type === "set_print") && p.variant === "UN") {
      hasUnframed = true;
      if (p.size === "A0") hasA0Unframed = true;
    }
    if (p.type === "aux_free_print" && p.size === "A0") {
      hasUnframed = true;
      hasA0Unframed = true;
    }
    if (p.type === "aux_free_print" && p.size !== "A0") {
      hasUnframed = true;
    }
  }
  if (!hasUnframed) return null;
  return hasA0Unframed ? MAIL_TUBE_LARGE_PRODUCT_ID : MAIL_TUBE_SMALL_PRODUCT_ID;
}

/**
 * Does this station require packaging selection before the order can be
 * completed? A0 framed + Dispatch require scanned packages. Unframed gets
 * an auto-assigned tube (counts as set). Framed never closes the order
 * directly (handed off to dispatch).
 */
export function stationRequiresPackages(stationDept: ProductionDeptKey): boolean {
  return stationDept === "a0_framed" || stationDept === "dispatch";
}

// ---------------------------------------------------------------------------
// KPI eligibility helpers
// ---------------------------------------------------------------------------

/**
 * Items KPI eligibility (narrow). Frames + picture frames only.
 *   Includes: single_print / set_print with variant FN, FB, FW
 *             picture_frame (always PN, PB, PW)
 *   Excludes: UN variant (unframed prints - tracked via orders, not items)
 *             aux_other (hooks), aux_free_print, gift_card, SC variant
 */
export function isKpiEligibleSku(sku: string | null | undefined): boolean {
  if (!sku) return false;
  const p = parseSku(sku);
  if (!p) return false;
  if (p.type === "gift_card" || p.type === "aux_other" || p.type === "aux_free_print") return false;
  if (p.type === "picture_frame") return true;
  // Items KPI excludes UN - unframed dept tracks orders, not items.
  return p.variant === "FN" || p.variant === "FB" || p.variant === "FW";
}

/**
 * Orders KPI eligibility (broad). Items + unframed prints.
 * Hooks, gift cards, free prints still excluded.
 */
export function isKpiOrderSku(sku: string | null | undefined): boolean {
  if (!sku) return false;
  const p = parseSku(sku);
  // Fail OPEN for unparseable SKUs - legacy title-format strings baked
  // into historical Shopify line items pre-v6 migration. They represent
  // real production work and should count toward order throughput.
  // isKpiEligibleSku stays strict so legacy SKUs do NOT inflate items.
  if (!p) return true;
  if (p.type === "gift_card" || p.type === "aux_other" || p.type === "aux_free_print") return false;
  if (p.type === "picture_frame") return true;
  return p.variant === "FN" || p.variant === "FB" || p.variant === "FW" || p.variant === "UN";
}

/**
 * For set prints, return the piece count (2, 3, 5, or 6) so one verified
 * line counts as N production units. Returns 1 for non-set SKUs.
 */
export function kpiUnitMultiplier(sku: string | null | undefined): number {
  if (!sku) return 1;
  const p = parseSku(sku);
  if (!p) return 1;
  if (p.type === "set_print" && typeof p.setCount === "number" && p.setCount > 0) {
    return p.setCount;
  }
  return 1;
}
