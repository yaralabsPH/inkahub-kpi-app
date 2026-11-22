/**
 * F6 shared scanner stations: turn one looked-up order into the exact,
 * immutable framing payload the server commits, or a clear reason to use
 * the classic station instead.
 *
 * Strict by design (spec decision 5): it uses the existing SKU parser and
 * deduction router, never the fail-open isLineMyDept. Any line it cannot
 * classify with certainty sends the whole order to the classic station.
 */
import {
  kpiUnitMultiplier,
  parseSku,
  routeShopifyLineToCatalogueLines,
  shouldDeductAtDept,
} from "@/lib/domain/skuRouting";
import { packagingLinesFromOrder } from "@/lib/domain/packaging/contents";
import { buildApplyPayload, predictPackaging } from "@/lib/domain/packaging/session";
import type { Quantities } from "@/lib/domain/packaging/reconcile";

export type FramingWorkType = "a0_framed" | "framed";

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
  | "packaging_unresolved";

export type PrepareResult = { ok: true; prepared: PreparedFraming } | { ok: false; code: PrepareCode; message: string };

export const EDIT_WARNING_TAGS = ["Edit Order", "oe-staff-edit"] as const;
export const MAX_LINE_QUANTITY = 100;
export const MAX_ORDER_LINES = 50;

const CLASSIC = " Use the classic station for this order.";

function no(code: PrepareCode, message: string): PrepareResult {
  return { ok: false, code, message: message + CLASSIC };
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
  if (!lookup.found) return no("not_found", `Order #${n} was not found in Shopify.`);
  if (lookup.complete !== true || lookup.truncated === true) {
    return no("incomplete_order", `Shopify did not return the complete order #${n}.`);
  }
  if (lookup.order_name !== `#${n}`) return no("name_mismatch", `Shopify returned ${lookup.order_name ?? "another order"} for #${n}.`);
  if (lookup.cancelled_at) return no("cancelled", `Order #${n} is cancelled.`);
  const tags = lookup.tags ?? [];
  const edit = EDIT_WARNING_TAGS.find((t) => tags.includes(t));
  if (edit) return no("edit_warning", `Order #${n} has the "${edit}" tag and needs a manager check.`);
  if (ctx.openCase) return no("open_case", `Order #${n} has an open replacement case.`);

  const items = lookup.line_items ?? [];
  if (items.length > MAX_ORDER_LINES) return no("too_many_lines", `Order #${n} has more than ${MAX_ORDER_LINES} lines.`);

  const bySku = new Map<string, FramingLine>();
  const allLines: Array<{ sku: string; quantity: number }> = [];
  for (const it of items) {
    const sku = (it.sku ?? "").trim().toUpperCase();
    if (!sku) return no("blank_sku", `Order #${n} has a line without a SKU.`);
    const q = it.quantity;
    if (!Number.isInteger(q) || q < 1 || q > MAX_LINE_QUANTITY) {
      return no("invalid_quantity", `Line ${sku} has quantity ${String(q)}.`);
    }
    const p = parseSku(sku);
    if (!p) return no("unknown_sku", `Line ${sku} is not a current SKU.`);
    if (p.variant === "SC") return no("canvas", `Line ${sku} is stretched canvas.`);
    allLines.push({ sku, quantity: q });

    const isPrint = p.type === "single_print" || p.type === "set_print";
    if (isPrint && p.size === "GW" && p.type !== "set_print") return no("unsupported_sku", `Line ${sku} is not a supported gallery-wall SKU.`);
    const framed = isPrint && (p.variant === "FB" || p.variant === "FW" || p.variant === "FN");
    if (!framed) continue; // unframed, picture frame, gift card, accessory: no framing credit

    const workType: FramingWorkType = p.size === "A0" ? "a0_framed" : "framed";
    const hit = bySku.get(sku);
    const quantity = (hit?.quantity ?? 0) + q;
    if (quantity > MAX_LINE_QUANTITY) return no("invalid_quantity", `Line ${sku} has quantity ${quantity}.`);
    bySku.set(sku, { sku, quantity, workType, pieces: quantity * kpiUnitMultiplier(sku) });
  }

  const lines = [...bySku.values()].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  if (lines.length === 0) return no("no_framing_lines", `Order #${n} has no framed prints.`);
  const workTypes = (["a0_framed", "framed"] as const).filter((w) => lines.some((l) => l.workType === w));

  let components: Array<{ code: string; qty: number }> = [];
  let packaging: FramingPackaging | null = null;
  if (workTypes.includes("a0_framed")) {
    // The A0 bench is terminal: the same lines the classic A0 completion
    // deducts (A0 framed prints and accessories), nothing more.
    const byCode = new Map<string, number>();
    for (const l of allLines) {
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
    const prediction = predictPackaging(setup.ruleSet.body, "a0_framed", packagingLinesFromOrder(allLines), { replacement: false });
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
