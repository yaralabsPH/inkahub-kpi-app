/**
 * F4 box-auto-pick: stock maths for a pick.
 *
 * A pick stores `target` (what should be consumed) and `posted` (what the
 * ledger already reflects), both as product id -> whole quantity. Stock only
 * ever moves by target - posted, so repeating a call moves nothing.
 *
 * The SQL routine packaging_reconcile_ in the F4 migration mirrors
 * packagingDeltas; this module is the reference and drives the UI preview.
 */
export type Quantities = Record<string, number>;

function clean(q: Quantities): Quantities {
  const out: Quantities = {};
  for (const [id, n] of Object.entries(q)) {
    if (typeof n === "number" && Number.isFinite(n) && n > 0) out[id] = Math.floor(n);
  }
  return out;
}

/** Collapse a package list to product id -> quantity (two keys may share a product). */
export function toQuantities(packages: Array<{ product_id: string; qty: number }>): Quantities {
  const out: Quantities = {};
  for (const p of packages) {
    if (!(p.qty > 0)) continue;
    out[p.product_id] = (out[p.product_id] ?? 0) + Math.floor(p.qty);
  }
  return out;
}

/**
 * Extra consumption needed per product: positive = take that many more from
 * stock, negative = give that many back. Products with no change are left
 * out. Keys are sorted, the same order the database locks product rows in.
 */
export function packagingDeltas(target: Quantities, posted: Quantities): Quantities {
  const t = clean(target);
  const p = clean(posted);
  const out: Quantities = {};
  for (const id of [...new Set([...Object.keys(t), ...Object.keys(p)])].sort()) {
    const d = (t[id] ?? 0) - (p[id] ?? 0);
    if (d !== 0) out[id] = d;
  }
  return out;
}

/** Apply consumption deltas to a posted map (what reconcile does once stock has moved). */
export function applyDeltas(posted: Quantities, deltas: Quantities): Quantities {
  const out = clean(posted);
  for (const [id, d] of Object.entries(deltas)) {
    const n = (out[id] ?? 0) + d;
    if (n > 0) out[id] = n;
    else delete out[id];
  }
  return out;
}

export function sameQuantities(a: Quantities, b: Quantities): boolean {
  return Object.keys(packagingDeltas(a, b)).length === 0;
}

/** True when the worker's final choice differs from what the rules predicted. */
export function isOverride(predicted: Quantities, target: Quantities): boolean {
  return !sameQuantities(predicted, target);
}
