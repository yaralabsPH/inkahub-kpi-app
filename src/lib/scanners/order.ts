/**
 * F6 shared scanner stations: turn one looked-up order into the exact,
 * immutable framing payload the server commits, or a clear reason to use
 * the classic station instead.
 *
 * Strict by design (spec decision 5): it uses the existing SKU parser and
 * deduction router, never the fail-open isLineMyDept. Since
 * scanner-stations-tuning only framing lines count: other lines are ignored
 * silently, and a line that looks framed but cannot be identified sends the
 * whole order to the classic station.
 */
import {
  parseSku,
  routeShopifyLineToCatalogueLines,
  shouldDeductAtDept,
} from "@/lib/domain/skuRouting";
import { packagingLinesFromOrder } from "@/lib/domain/packaging/contents";
import { buildApplyPayload, predictPackaging } from "@/lib/domain/packaging/session";
import type { Quantities } from "@/lib/domain/packaging/reconcile";

export type FramingWorkType = "a0_framed" | "framed";

/**
 * Pieces one framed line stands for: a set print is its set count, anything
 * else is one. The local preview only; the server returns the saved pieces.
 * (F1 removed the old skuRouting KPI helpers; this keeps F6's exact rule.)
 */
export function framingPieceMultiplier(sku: string): number {
  const p = parseSku(sku);
  return p && p.type === "set_print" && typeof p.setCount === "number" && p.setCount > 0 ? p.setCount : 1;
}

/** The subset of the /api/shopify/order answer this module reads. */
export interface OrderLookup {
  found?: boolean;
  order_name?: string;
  cancelled_at?: string | null;
  tags?: string[];
  line_items?: Array<{ sku: string | null; title?: string | null; quantity: number; variant_title?: string | null }>;
  /** F6: true only when every line item was returned and the order matched exactly. */
  complete?: boolean;
  truncated?: boolean;
}

export interface CatalogueProduct {
  id: string;
  code: string;
}

export interface PackagingSetup {
  mode: "scan" | "auto";
  ruleSet: { id: string; version: number; body: Parameters<typeof predictPackaging>[0] } | null;
}

export interface FramingLine {
  sku: string;
  /** Raw ordered quantity (line_verified.line_quantity). */
  quantity: number;
  workType: FramingWorkType;
  /** quantity x set size, for display only. */
  pieces: number;
}

export interface FramingPackaging {
  ruleSetId: string;
  ruleSetVersion: number;
  resolved: true;
  predicted: Quantities;
  target: Quantities;
  snapshot: Record<string, unknown>;
}

export interface PreparedFraming {
  orderNumber: string;
  displayName: string;
  lines: FramingLine[];
  workTypes: FramingWorkType[];
  pieces: number;
  /** A0 terminal component deductions (catalogue code -> qty); empty without A0. */
  components: Array<{ code: string; qty: number }>;
  /** F4 packaging for the A0 parcel; null without A0. */
  packaging: FramingPackaging | null;
}

export type PrepareCode =
  | "not_found"
  | "incomplete_order"
  | "name_mismatch"
  | "cancelled"
  | "edit_warning"
  | "open_case"
  | "blank_sku"
  | "invalid_quantity"
  | "unknown_sku"
  | "canvas"
  | "unsupported_sku"
  | "too_many_lines"
  | "no_framing_lines"
  | "unroutable_component"
  | "missing_stock_code"
  | "packaging_not_auto"
  | "packaging_unresolved"
  | "suspicious_framing";

export type PrepareRefusal = { ok: false; code: PrepareCode; message: string };
export type PrepareResult = { ok: true; prepared: PreparedFraming } | PrepareRefusal;

/**
 * scanner-stations-tuning: what one order line means for shared Framing.
 *  - "framed": a valid current framed print (single or set, FB/FW/FN); it
 *    earns framing credit.
 *  - "ignored": anything else with no sign of framing (accessories, hooks,
 *    free prints, gift items, unframed, canvas, picture frames, unknown or
 *    blank SKUs). Silent: no credit, no warning.
 *  - "suspicious": looks like a framed print but is not a valid current
 *    framed SKU. The whole scan is refused so a typo never loses credit.
 * Title words are only ever a reason to refuse or ignore, never to credit.
 */
export type FramingLineClass =
  | { kind: "framed"; sku: string; workType: FramingWorkType }
  | { kind: "ignored" }
  | { kind: "suspicious"; label: string };

/** Non-framing product families decided by SKU prefix alone. */
const NON_FRAMING_PREFIX = /^INKA-(AUX|GC|PF)/;
/**
 * Explicit non-framing product categories, named in the line's title or
 * variant. Whole category phrases only: a promotional word on its own
 * ("free shipping", "gift wrapped") is not a category (review r1 M1).
 */
const NON_FRAMING_CATEGORY = new RegExp(
  "\\b(" + [
    "hooks?", "hanging (kit|hooks?|wire)",
    "gift (bag|box|card|certificate|voucher)s?", "vouchers?",
    "free (print|sample|poster)s?", "samples?",
    "unframed", "canvas(es)?", "stretched canvas",
    "picture frames?", "frame only", "frames? only",
  ].join("|") + ")\\b",
  "i",
);
const FRAMED_SUFFIX = /-(FB|FW|FN)$/;
/** An INKA single or set artwork stem, whatever follows it. */
const ARTWORK_STEM = /^INKA-(S\d)?[A-Z]{2,3}\d{4}(-|$)/;
const FRAMED_WORD = /\bframed\b/i;
/** Longest line description put into a refusal message (review r1 S1). */
export const FRAMING_LABEL_MAX = 80;

function lineLabel(sku: string, title: string, variant: string): string {
  const raw = sku || title || variant || "a line without a SKU";
  return raw.length > FRAMING_LABEL_MAX ? `${raw.slice(0, FRAMING_LABEL_MAX - 1)}…` : raw;
}

export function classifyFramingLine(line: {
  sku: string | null;
  title?: string | null;
  variant_title?: string | null;
}): FramingLineClass {
  const sku = (line.sku ?? "").trim().toUpperCase();
  const title = (line.title ?? "").trim();
  const variant = (line.variant_title ?? "").trim();
  const words = `${title} ${variant}`;
  const label = lineLabel(sku, title, variant);

  // 1. A SKU the parser knows decides by itself.
  const p = sku ? parseSku(sku) : null;
  if (p) {
    const isPrint = p.type === "single_print" || p.type === "set_print";
    if (!isPrint) return { kind: "ignored" }; // picture frame, gift card, free print, accessory
    if (p.variant === "UN" || p.variant === "SC") return { kind: "ignored" }; // unframed, canvas
    // 2. A valid current framed print.
    if (p.size === "GW" && p.type !== "set_print") return { kind: "suspicious", label }; // single GW is not supported
    return { kind: "framed", sku, workType: p.size === "A0" ? "a0_framed" : "framed" };
  }
  if (sku && NON_FRAMING_PREFIX.test(sku)) return { kind: "ignored" }; // e.g. INKA-AUXMFL

  // 3. A SKU shaped like a framed print that does not parse is a typo, not
  //    an accessory, whatever its title says: refuse rather than lose credit.
  if (sku && (FRAMED_SUFFIX.test(sku) || ARTWORK_STEM.test(sku))) return { kind: "suspicious", label };

  // 4. An explicit non-framing category outranks the word "framed"
  //    ("Hook for framed prints"), for blank and unknown SKUs alike.
  if (NON_FRAMING_CATEGORY.test(words)) return { kind: "ignored" };

  // 5. Otherwise the word "framed" means a framed print we cannot identify.
  if (FRAMED_WORD.test(words)) return { kind: "suspicious", label };

  // 4. No sign of framing: not this bench's work.
  return { kind: "ignored" };
}

export const EDIT_WARNING_TAGS = ["Edit Order", "oe-staff-edit"] as const;
export const MAX_LINE_QUANTITY = 100;
export const MAX_ORDER_LINES = 50;

const CLASSIC = " Use the classic station for this order.";

export function no(code: PrepareCode, message: string): PrepareRefusal {
  return { ok: false, code, message: message + CLASSIC };
}

/**
 * Whole-order checks shared by framing and dispatch (F7): found, complete,
 * exact, not cancelled, no edit tag, no open replacement case, bounded.
 * Returns the refusal, or null when the order may be prepared.
 */
export function orderHeaderProblem(
  lookup: OrderLookup,
  n: string,
  openCase: boolean,
): PrepareRefusal | null {
  if (!lookup.found) return no("not_found", `Order #${n} was not found in Shopify.`);
  if (lookup.complete !== true || lookup.truncated === true) {
    return no("incomplete_order", `Shopify did not return the complete order #${n}.`);
  }
  if (lookup.order_name !== `#${n}`) {
    return no("name_mismatch", `Shopify returned ${lookup.order_name ?? "another order"} for #${n}.`);
  }
  if (lookup.cancelled_at) return no("cancelled", `Order #${n} is cancelled.`);
  const tags = lookup.tags ?? [];
  const edit = EDIT_WARNING_TAGS.find((t) => tags.includes(t));
  if (edit) return no("edit_warning", `Order #${n} has the "${edit}" tag and needs a manager check.`);
  if (openCase) return no("open_case", `Order #${n} has an open replacement case.`);
  if ((lookup.line_items ?? []).length > MAX_ORDER_LINES) {
    return no("too_many_lines", `Order #${n} has more than ${MAX_ORDER_LINES} lines.`);
  }
  return null;
}

export function prepareFramingOrder(
  lookup: OrderLookup,
  ctx: {
    orderNumber: string;
    openCase: boolean;
    products: readonly CatalogueProduct[];
    packaging: PackagingSetup | null;
  },
): PrepareResult {
  const n = ctx.orderNumber;
  const header = orderHeaderProblem(lookup, n, ctx.openCase);
  if (header) return header;

  const items = lookup.line_items ?? [];

  // scanner-stations-tuning: only framing lines count. Everything else is
  // ignored silently (no credit, no quantity check, no stock, no box); a
  // line that looks framed but is not a valid framed SKU refuses the scan.
  const bySku = new Map<string, FramingLine>();
  const framingLines: Array<{ sku: string; quantity: number }> = [];
  for (const it of items) {
    const c = classifyFramingLine(it);
    if (c.kind === "ignored") continue;
    if (c.kind === "suspicious") {
      return {
        ok: false,
        code: "suspicious_framing",
        message: `This order has a framed print we couldn't identify: ${c.label}. Nothing was saved. Ask a manager to check it on the classic station.`,
      };
    }
    const sku = c.sku;
    const q = it.quantity;
    if (!Number.isInteger(q) || q < 1 || q > MAX_LINE_QUANTITY) {
      return no("invalid_quantity", `Line ${sku} has quantity ${String(q)}.`);
    }
    framingLines.push({ sku, quantity: q });
    const hit = bySku.get(sku);
    const quantity = (hit?.quantity ?? 0) + q;
    if (quantity > MAX_LINE_QUANTITY) return no("invalid_quantity", `Line ${sku} has quantity ${quantity}.`);
    bySku.set(sku, { sku, quantity, workType: c.workType, pieces: quantity * framingPieceMultiplier(sku) });
  }

  const lines = [...bySku.values()].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  if (lines.length === 0) {
    return { ok: false, code: "no_framing_lines", message: "Nothing to frame on this order. Nothing was saved." };
  }
  const workTypes = (["a0_framed", "framed"] as const).filter((w) => lines.some((l) => l.workType === w));

  let components: Array<{ code: string; qty: number }> = [];
  let packaging: FramingPackaging | null = null;
  if (workTypes.includes("a0_framed")) {
    // The A0 bench is terminal. Its components and box come from the
    // framing lines only (CJ, 2026-11-25: accessories and canvas are
    // ignored here, A0 orders included).
    const byCode = new Map<string, number>();
    for (const l of framingLines) {
      if (!shouldDeductAtDept(l.sku, "a0_framed", "completed")) continue;
      const route = routeShopifyLineToCatalogueLines(l.sku, l.quantity);
      if (route.lines.length === 0) return no("unroutable_component", `No stock components for ${l.sku}: ${route.reason ?? "unknown"}.`);
      for (const c of route.lines) byCode.set(c.code, (byCode.get(c.code) ?? 0) + c.qty);
    }
    for (const code of byCode.keys()) {
      const known = ctx.products.some((p) => p.id === code || p.code.trim().toLowerCase() === code.toLowerCase());
      if (!known) return no("missing_stock_code", `Stock code ${code} is not in this site's catalogue.`);
    }
    components = [...byCode.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([code, qty]) => ({ code, qty }));

    const setup = ctx.packaging;
    if (!setup || setup.mode !== "auto" || !setup.ruleSet) {
      return no("packaging_not_auto", `A0 order #${n} needs automatic box rules at this site.`);
    }
    const prediction = predictPackaging(setup.ruleSet.body, "a0_framed", packagingLinesFromOrder(framingLines), { replacement: false });
    const ev = prediction.evaluation;
    if (ev.status !== "resolved" || ev.packages.length === 0) {
      return no("packaging_unresolved", `The box rules could not pick the A0 packaging for #${n}${ev.reason ? ` (${ev.reason})` : ""}.`);
    }
    const payload = buildApplyPayload({ ruleSet: setup.ruleSet, prediction, chosen: ev.packages });
    packaging = {
      ruleSetId: payload.ruleSetId,
      ruleSetVersion: setup.ruleSet.version,
      resolved: true,
      predicted: payload.predicted,
      target: payload.target,
      snapshot: payload.snapshot,
    };
  }

  const prepared: PreparedFraming = {
    orderNumber: n,
    displayName: `#${n}`,
    lines,
    workTypes: [...workTypes],
    pieces: lines.reduce((s, l) => s + l.pieces, 0),
    components,
    packaging,
  };
  // Deep copy so the persisted payload shares nothing with live objects.
  return { ok: true, prepared: JSON.parse(JSON.stringify(prepared)) as PreparedFraming };
}
