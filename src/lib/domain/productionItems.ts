/**
 * Production item counting (F1 / item-counting spec, section A).
 *
 * One pure classifier shared by Reports, Welcome, Production and the daily
 * digest. It answers "how many physical pieces of production work does this
 * saved line represent?" It is NOT an inventory rule: stock deduction keeps
 * using skuRouting.ts (routeShopifyLineToCatalogueLines / shouldDeductAtDept).
 *
 * Browser/server safe: no browser state, env vars or Supabase imports.
 * Imported by api/ with a relative path, so keep imports relative too.
 */

import {
  MAIL_TUBE_LARGE_PRODUCT_ID,
  MAIL_TUBE_SMALL_PRODUCT_ID,
  PACKAGE_TYPES,
  parseSku,
  type ParsedSku,
} from "./skuRouting";

export type EligibleReason = "single_print" | "set_print" | "picture_frame";

export type ExcludedReason =
  | "gift_card"
  | "free_print"
  | "accessory"
  | "packaging"
  | "canvas";

export type UnclassifiedReason =
  | "missing_sku"
  | "unrecognized_sku"
  | "invalid_set_count"
  | "unsupported_variant"
  | "unsupported_size";

export type ProductClassification =
  | { kind: "eligible"; reason: EligibleReason; pieces: number; sku: string }
  | { kind: "excluded"; reason: ExcludedReason; sku: string }
  | { kind: "unclassified"; reason: UnclassifiedReason; sku: string | null };

export type QuantityIssue =
  | "missing_quantity"
  | "non_integer_quantity"
  | "negative_quantity"
  | "unsafe_quantity"
  | "item_overflow";

export type ItemCount =
  | { status: "counted"; items: number; product: ProductClassification & { kind: "eligible" }; issues: [] }
  | { status: "excluded"; items: 0; product: ProductClassification & { kind: "excluded" }; issues: [] }
  | {
      status: "unclassified";
      items: 0;
      product: ProductClassification;
      /** Product reason (when the SKU is unclassified) and/or quantity issue. */
      issues: Array<UnclassifiedReason | QuantityIssue>;
    };

/** Set piece counts accepted for item credit (existing single-digit sets). */
export const MIN_SET_PIECES = 2;
export const MAX_SET_PIECES = 9;

const PRINT_ITEM_VARIANTS = new Set(["FB", "FW", "FN", "UN"]);
const FRAME_ONLY_VARIANTS = new Set(["PB", "PW", "PN"]);
const STANDARD_SIZES = new Set(["A0", "A1", "A2", "A3", "A4"]);

/** Current free-print form, e.g. INKA-AUXESP (no dash after AUX). */
const RE_AUX_FREE_PRINT_CURRENT = /^INKA-AUX[A-Z]{2,4}$/;

const PACKAGING_CODES = new Set<string>([
  ...PACKAGE_TYPES.map((p) => p.key.toUpperCase()),
  MAIL_TUBE_LARGE_PRODUCT_ID.toUpperCase(),
  MAIL_TUBE_SMALL_PRODUCT_ID.toUpperCase(),
]);

function normalizeSku(sku: unknown): string | null {
  if (typeof sku !== "string") return null;
  const s = sku.trim().toUpperCase();
  return s.length > 0 ? s : null;
}

function classifyParsed(p: ParsedSku, sku: string): ProductClassification {
  switch (p.type) {
    case "gift_card":
      return { kind: "excluded", reason: "gift_card", sku };
    case "aux_free_print":
      return { kind: "excluded", reason: "free_print", sku };
    case "aux_other":
      return { kind: "excluded", reason: "accessory", sku };
    case "picture_frame":
      if (!p.variant || !FRAME_ONLY_VARIANTS.has(p.variant)) {
        return { kind: "unclassified", reason: "unsupported_variant", sku };
      }
      if (!p.size || !STANDARD_SIZES.has(p.size)) {
        return { kind: "unclassified", reason: "unsupported_size", sku };
      }
      return { kind: "eligible", reason: "picture_frame", pieces: 1, sku };
    case "single_print":
    case "set_print": {
      if (p.variant === "SC") return { kind: "excluded", reason: "canvas", sku };
      if (!p.variant || !PRINT_ITEM_VARIANTS.has(p.variant)) {
        return { kind: "unclassified", reason: "unsupported_variant", sku };
      }
      if (p.type === "single_print") {
        // Gallery Wall is a set composite; a single GW print is not a known product.
        if (!p.size || !STANDARD_SIZES.has(p.size)) {
          return { kind: "unclassified", reason: "unsupported_size", sku };
        }
        return { kind: "eligible", reason: "single_print", pieces: 1, sku };
      }
      const n = p.setCount;
      if (typeof n !== "number" || !Number.isInteger(n) || n < MIN_SET_PIECES || n > MAX_SET_PIECES) {
        return { kind: "unclassified", reason: "invalid_set_count", sku };
      }
      if (!p.size || (p.size !== "GW" && !STANDARD_SIZES.has(p.size))) {
        return { kind: "unclassified", reason: "unsupported_size", sku };
      }
      return { kind: "eligible", reason: "set_print", pieces: n, sku };
    }
  }
}

/**
 * Classify a saved SKU, independent of quantity. An eligible SKU with a bad
 * quantity still qualifies an order (spec B); only its Items are uncountable.
 */
export function classifyProductionSku(sku: unknown): ProductClassification {
  const s = normalizeSku(sku);
  if (s === null) return { kind: "unclassified", reason: "missing_sku", sku: null };
  if (PACKAGING_CODES.has(s)) return { kind: "excluded", reason: "packaging", sku: s };
  if (RE_AUX_FREE_PRINT_CURRENT.test(s)) return { kind: "excluded", reason: "free_print", sku: s };
  const parsed = parseSku(s);
  if (parsed) return classifyParsed(parsed, s);
  // Malformed sets such as S10 never parse; report them as a set problem.
  if (/^INKA-S\d{2,}[A-Z]/.test(s)) return { kind: "unclassified", reason: "invalid_set_count", sku: s };
  return { kind: "unclassified", reason: "unrecognized_sku", sku: s };
}

function quantityIssue(quantity: unknown): QuantityIssue | null {
  if (quantity === null || quantity === undefined) return "missing_quantity";
  if (typeof quantity !== "number" || Number.isNaN(quantity)) return "non_integer_quantity";
  if (!Number.isFinite(quantity)) return "unsafe_quantity";
  if (!Number.isInteger(quantity)) return "non_integer_quantity";
  if (quantity < 0) return "negative_quantity";
  if (!Number.isSafeInteger(quantity)) return "unsafe_quantity";
  return null;
}

/**
 * Items contributed by one saved verified line. Never defaults a missing
 * quantity to one, never coerces strings, never clamps negatives.
 */
export function countProductionItems(sku: unknown, quantity: unknown): ItemCount {
  const product = classifyProductionSku(sku);
  const qIssue = quantityIssue(quantity);

  if (product.kind === "unclassified") {
    const issues: Array<UnclassifiedReason | QuantityIssue> = [product.reason];
    if (qIssue) issues.push(qIssue);
    return { status: "unclassified", items: 0, product, issues };
  }
  if (qIssue) {
    return { status: "unclassified", items: 0, product, issues: [qIssue] };
  }
  if (product.kind === "excluded") {
    return { status: "excluded", items: 0, product, issues: [] };
  }
  const items = (quantity as number) * product.pieces;
  if (!Number.isSafeInteger(items)) {
    return { status: "unclassified", items: 0, product, issues: ["item_overflow"] };
  }
  return { status: "counted", items, product, issues: [] };
}
