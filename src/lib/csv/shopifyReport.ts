import { parseCsv } from "./csv";
import { parseSku } from "@/lib/domain/skuRouting";

/**
 * Parser for Shopify weekly variant reports. Each report has three columns —
 * Variant name, Product name, Net quantity — and may be prefaced with a title
 * row and blank line that we skip past.
 *
 * Rules locked in with the user:
 *  - Bucket frames sold by `(size, colour)` from the variant string. Size is
 *    the leading A0–A4 token; colour is matched by name (Black / White /
 *    Natural) anywhere in the string, so orientation tokens like
 *    `(Landscape)` / `(Portrait)` and dimension fragments are ignored.
 *  - Multiply the row's Net quantity by a "set multiplier" parsed from the
 *    product name: `3x …` → 3, `Set of N` → N, plain "Set" with no number
 *    → 2, otherwise → 1.
 *  - Skip rows with Net quantity ≤ 0 (returns are ignored entirely; the
 *    footer total row is silently dropped because both variant and product
 *    name are blank).
 *  - Track orders per size separately so the importer can apply each
 *    size's contribution idempotently when the user re-runs the same file.
 */

const COLOUR_PATTERNS: Array<[RegExp, string]> = [
  [/natural/i, "Natural"],
  [/\bblack\b/i, "Black"],
  [/\bwhite\b/i, "White"],
];
const SIZE_RE = /\bA\d\b/i;
/** Headers for the original Framed Shopify weekly variant report. */
const HEADER_KEYS = ["variant name", "product name", "net quantity"] as const;
/** Headers for the Unframed "Total Last 7 Days" Shopify export. */
const UNFRAMED_HEADER_KEYS = ["variant name", "total orders", "net quantity"] as const;
/** Headers for the SKU-keyed "Total ALL Orders Last 7 Days" export. */
const SKU_HEADER_KEYS = ["sku", "total orders", "net quantity"] as const;

export interface ShopifyBucket {
  size: string;
  colour: string;
  orders: number;
  frames: number;
}

export interface ShopifyParseResult {
  buckets: ShopifyBucket[];
  /** Per-size totals — used as idempotency keys when writing WeeklyEntry. */
  ordersBySize: Record<string, number>;
  totalOrders: number;
  totalFrames: number;
  unparsedRows: { variant: string; productName: string; quantity: number }[];
  ignoredNegatives: number;
  /**
   * Per-SKU AUX sales (hooks, free prints, other aux) from SKU-based
   * imports. Downstream matching should look these up by product code
   * rather than by (size, colour). Undefined for non-SKU parses.
   */
  auxSales?: Array<{ sku: string; quantity: number }>;
  /**
   * Per-department contribution breakdown from SKU-based imports. Lets
   * the modal write two WeeklyEntry rows (framed + unframed) from a
   * single combined CSV. Undefined for non-SKU parses.
   */
  departments?: {
    framed: { ordersBySize: Record<string, number>; totalOrders: number; totalFrames: number };
    unframed: { ordersBySize: Record<string, number>; totalOrders: number; totalFrames: number };
  };
}

/**
 * Cheap header sniff so the Sales Entry importer can route to the right flow.
 * Accepts two Shopify export shapes:
 *   1. Weekly variant report — has a `Variant name, Product name, Net quantity` header.
 *   2. Agreement-lines export — no header at all, just three columns of data.
 *      Detected by looking at the first non-empty rows for a variant string
 *      that contains an A0–A4 size and a known colour name.
 */
export function looksLikeShopifyReport(text: string): boolean {
  const cleaned = text.replace(/^﻿/, "");
  const lc = cleaned.toLowerCase();
  if (HEADER_KEYS.every((k) => lc.includes(k))) return true;
  if (UNFRAMED_HEADER_KEYS.every((k) => lc.includes(k))) return true;
  if (SKU_HEADER_KEYS.every((k) => lc.includes(k))) return true;
  return looksLikeHeaderlessVariantCsv(cleaned);
}

function looksLikeHeaderlessVariantCsv(cleaned: string): boolean {
  const rows = parseCsv(cleaned).filter((r) => r.some((c) => c.trim()));
  // Sample the first few rows — if any of them looks like (variant, product, qty),
  // assume the whole file is headerless variant data.
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const r = rows[i];
    if (r.length < 3) continue;
    const variant = (r[0] ?? "").trim();
    const qty = (r[2] ?? "").trim();
    const hasSize = SIZE_RE.test(variant);
    const hasColour = COLOUR_PATTERNS.some(([pat]) => pat.test(variant));
    const isQty = qty !== "" && /^-?\d+$/.test(qty);
    if (hasSize && hasColour && isQty) return true;
  }
  return false;
}

export function parseShopifyCsv(text: string): ShopifyParseResult {
  const cleaned = text.replace(/^﻿/, "");
  const rows = parseCsv(cleaned);

  // Detect format. Three shapes are supported:
  //   1. Framed weekly variant report — header `Variant name, Product name, Net quantity`.
  //      Net quantity = frames sold; product name carries set multipliers.
  //   2. Unframed "Total Last 7 Days" report — header `Variant name, Total orders, Net quantity`.
  //      Net quantity = prints sold; Total orders = order count for that variant.
  //   3. Headerless agreement-lines export — three columns of data, no header.
  let headerIdx = -1;
  let format: "framed" | "unframed" | "headerless" | "sku" = "headerless";
  for (let i = 0; i < rows.length; i++) {
    const lc = rows[i].map((c) => c.trim().toLowerCase());
    if (SKU_HEADER_KEYS.every((k) => lc.includes(k))) {
      headerIdx = i; format = "sku"; break;
    }
    if (HEADER_KEYS.every((k) => lc.includes(k))) {
      headerIdx = i; format = "framed"; break;
    }
    if (UNFRAMED_HEADER_KEYS.every((k) => lc.includes(k))) {
      headerIdx = i; format = "unframed"; break;
    }
  }
  // SKU-based export uses a completely different bucketing flow.
  if (format === "sku") return parseShopifyCsvBySku(rows, headerIdx);

  // Column indices for variant / product (or orders) / quantity.
  let vIdx: number; let pIdx: number; let oIdx: number; let qIdx: number; let dataStart: number;
  if (headerIdx >= 0) {
    const header = rows[headerIdx].map((c) => c.trim().toLowerCase());
    vIdx = header.indexOf("variant name");
    qIdx = header.indexOf("net quantity");
    pIdx = format === "framed" ? header.indexOf("product name") : -1;
    oIdx = format === "unframed" ? header.indexOf("total orders") : -1;
    dataStart = headerIdx + 1;
  } else {
    // Headerless: assume column order is variant, product, quantity.
    vIdx = 0; pIdx = 1; oIdx = -1; qIdx = 2;
    dataStart = 0;
  }

  const buckets: Record<string, ShopifyBucket> = {};
  const ordersBySize: Record<string, number> = {};
  const unparsedRows: { variant: string; productName: string; quantity: number }[] = [];
  let totalOrders = 0;
  let totalFrames = 0;
  let ignoredNegatives = 0;
  // Unframed reports include a footer row like `,351,530` — the de-duplicated
  // unique-order count for the whole report. Capture it; it's more accurate
  // than summing the per-row Total orders column (which double-counts orders
  // that contain more than one variant).
  let footerOrders: number | null = null;

  for (let i = dataStart; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const variant = (r[vIdx] ?? "").trim();
    const productName = pIdx >= 0 ? (r[pIdx] ?? "").trim() : "";
    const orderCountRaw = oIdx >= 0 ? (r[oIdx] ?? "").trim() : "";
    const qtyRaw = (r[qIdx] ?? "").trim();
    if (!variant && !productName && !orderCountRaw && !qtyRaw) continue;

    // Footer detection (unframed only): empty variant + numeric totals.
    if (!variant && format === "unframed" && orderCountRaw && qtyRaw) {
      const fo = Number(orderCountRaw);
      if (Number.isFinite(fo)) footerOrders = fo;
      continue;
    }

    const qty = Number(qtyRaw);
    if (!Number.isFinite(qty)) continue;
    if (qty < 0) { ignoredNegatives += 1; continue; }
    if (qty === 0) continue;

    const size = parseVariantSize(variant);
    let colour = parseVariantColour(variant);
    // Unframed prints don't carry a colour name in the variant string —
    // tag them as "Print" so they match the seeded A0-Unframed … SKUs.
    if (!colour && format === "unframed" && /unframed|print/i.test(variant)) {
      colour = "Print";
    }
    if (!size || !colour) {
      // Footer total rows have empty variant — drop silently.
      if (!variant) continue;
      unparsedRows.push({ variant, productName, quantity: qty });
      continue;
    }

    // For unframed: bucket.orders = Total orders column (count of orders),
    //               bucket.frames = Net quantity (count of prints sold).
    // For framed:   bucket.orders = Net quantity, bucket.frames = qty × set multiplier.
    let orders: number;
    let frames: number;
    if (format === "unframed") {
      const o = Number(orderCountRaw);
      orders = Number.isFinite(o) && o > 0 ? o : qty;
      frames = qty;
    } else {
      const setSize = parseSetMultiplier(productName);
      orders = qty;
      frames = qty * setSize;
    }

    totalOrders += orders;
    totalFrames += frames;
    ordersBySize[size] = (ordersBySize[size] ?? 0) + orders;
    const key = `${size}|${colour.toLowerCase()}`;
    if (!buckets[key]) buckets[key] = { size, colour, orders: 0, frames: 0 };
    buckets[key].orders += orders;
    buckets[key].frames += frames;
  }

  // For unframed: collapse per-size order counts into a single "Unframed"
  // key and use the footer's true unique-order count (avoids double-counting
  // orders that contained more than one variant). Per-SKU print counts in
  // `buckets` and `totalFrames` are unaffected.
  if (format === "unframed") {
    const trueTotal = footerOrders ?? Object.values(ordersBySize).reduce((a, b) => a + b, 0);
    for (const k of Object.keys(ordersBySize)) delete ordersBySize[k];
    ordersBySize["Unframed"] = trueTotal;
    totalOrders = trueTotal;
  }

  return {
    buckets: Object.values(buckets).sort(
      (a, b) => a.size.localeCompare(b.size) || a.colour.localeCompare(b.colour),
    ),
    ordersBySize,
    totalOrders,
    totalFrames,
    unparsedRows,
    ignoredNegatives,
  };
}

/** Pull the A0–A4 token out of a variant string. */
export function parseVariantSize(variant: string): string | null {
  const m = variant.match(SIZE_RE);
  return m ? m[0].toUpperCase() : null;
}

/** Match the colour by name anywhere in the variant — ignores orientation tokens. */
export function parseVariantColour(variant: string): string | null {
  for (const [pat, name] of COLOUR_PATTERNS) {
    if (pat.test(variant)) return name;
  }
  return null;
}

/**
 * Frames per order implied by the product name.
 *  - "3x Exhibitions by Gustav Klimt" → 3
 *  - "Matisse x Monet x Van Gogh Set of 3 Art Prints" → 3
 *  - "Bondi Rockpools | Set of 2 Art Prints" → 2
 *  - "Olive Coral + Nude Set by Matisse" → 2 (any "Set" with no number)
 *  - Anything else → 1.
 */
export function parseSetMultiplier(productName: string): number {
  if (!productName) return 1;
  const prefix = productName.match(/^\s*(\d+)\s*x\s/i);
  if (prefix) {
    const n = Number(prefix[1]);
    if (n >= 2 && n <= 12) return n;
  }
  const setN = productName.match(/\bset\s+of\s+(\d+)\b/i);
  if (setN) {
    const n = Number(setN[1]);
    if (n >= 2 && n <= 12) return n;
  }
  if (/\bset\b/i.test(productName)) return 2;
  return 1;
}

/**
 * Map a v6 SKU variant code to the colour string used by the existing
 * (size, colour) bucket + downstream product matching flow.
 *   FN, PN -> "Natural"
 *   FB, PB -> "Black"
 *   FW, PW -> "White"
 *   UN     -> "Print"  (matches existing unframed convention)
 *   SC     -> null    (stretched canvas not stocked)
 */
function variantToColour(variant: string | undefined): string | null {
  switch (variant) {
    case "FN":
    case "PN":
      return "Natural";
    case "FB":
    case "PB":
      return "Black";
    case "FW":
    case "PW":
      return "White";
    case "UN":
      return "Print";
    default:
      return null;
  }
}

/**
 * Parse the new "SKU, Total orders, Net quantity" export.
 * See install_shopify_sku_parser.ps1 for the locked-in rules.
 */
export function parseShopifyCsvBySku(
  rows: string[][],
  headerIdx: number,
): ShopifyParseResult {
  const header = rows[headerIdx].map((c) => c.trim().toLowerCase());
  const sIdx = header.indexOf("sku");
  const qIdx = header.indexOf("net quantity");

  const buckets: Record<string, ShopifyBucket> = {};
  const framedOrdersBySize: Record<string, number> = {};
  const unparsedRows: { variant: string; productName: string; quantity: number }[] = [];
  const auxSales: Array<{ sku: string; quantity: number }> = [];
  let framedTotalOrders = 0;
  let framedTotalFrames = 0;
  let unframedTotalOrders = 0;
  let unframedTotalFrames = 0;
  let ignoredNegatives = 0;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const sku = (r[sIdx] ?? "").trim();
    const qtyRaw = (r[qIdx] ?? "").trim();

    // Rule: blank SKU -> skip. Catches footer / summary rows silently.
    if (!sku) continue;

    const qty = Number(qtyRaw);
    if (!Number.isFinite(qty)) continue;
    if (qty < 0) { ignoredNegatives += 1; continue; }
    if (qty === 0) continue;

    const p = parseSku(sku);

    // Legacy / unparseable SKU. Pass through as unparsed.
    if (!p) {
      unparsedRows.push({ variant: sku, productName: "", quantity: qty });
      continue;
    }

    if (p.type === "gift_card") continue;

    // AUX SKUs - SKU-keyed matching in the modal. No dept attribution
    // here since AUX products are catalogued directly by SKU code, not
    // by (size, colour), and don't feed the WeeklyEntry summary tiles.
    if (p.type === "aux_other" || p.type === "aux_free_print") {
      auxSales.push({ sku: sku.toUpperCase(), quantity: qty });
      continue;
    }

    // Framed / PF / print / set SKUs - bucket by (size, colour) and
    // attribute to a department based on variant.
    const size = p.size ?? "";
    const colour = variantToColour(p.variant);
    if (!size || !colour) {
      unparsedRows.push({ variant: sku, productName: "", quantity: qty });
      continue;
    }

    const setSize = p.type === "set_print" && typeof p.setCount === "number" && p.setCount > 0
      ? p.setCount
      : 1;

    // Rule: always drive off Net quantity per SKU. Frames = qty * setCount.
    const orders = qty;
    const frames = qty * setSize;

    const key = `${size}|${colour.toLowerCase()}`;
    if (!buckets[key]) buckets[key] = { size, colour, orders: 0, frames: 0 };
    buckets[key].orders += orders;
    buckets[key].frames += frames;

    // Department split: UN variant = unframed side; everything else
    // (FN/FB/FW + PN/PB/PW picture-frame variants) = framed side.
    if (p.variant === "UN") {
      unframedTotalOrders += orders;
      unframedTotalFrames += frames;
    } else {
      framedTotalOrders += orders;
      framedTotalFrames += frames;
      framedOrdersBySize[size] = (framedOrdersBySize[size] ?? 0) + orders;
    }
  }

  // Unframed WeeklyEntry convention: single "Unframed" bucket key with
  // the true total (matches the existing unframed parser output shape).
  const unframedOrdersBySize: Record<string, number> = {};
  if (unframedTotalOrders > 0) {
    unframedOrdersBySize["Unframed"] = unframedTotalOrders;
  }

  return {
    buckets: Object.values(buckets).sort(
      (a, b) => a.size.localeCompare(b.size) || a.colour.localeCompare(b.colour),
    ),
    // Top-level fields kept for backward compat with any other caller.
    // The framed side wins here since size-keyed shape matches the
    // framed parser. Downstream code that needs unframed contributions
    // should read the `departments` field instead.
    ordersBySize: framedOrdersBySize,
    totalOrders: framedTotalOrders + unframedTotalOrders,
    totalFrames: framedTotalFrames + unframedTotalFrames,
    unparsedRows,
    ignoredNegatives,
    auxSales,
    departments: {
      framed: {
        ordersBySize: framedOrdersBySize,
        totalOrders: framedTotalOrders,
        totalFrames: framedTotalFrames,
      },
      unframed: {
        ordersBySize: unframedOrdersBySize,
        totalOrders: unframedTotalOrders,
        totalFrames: unframedTotalFrames,
      },
    },
  };
}
