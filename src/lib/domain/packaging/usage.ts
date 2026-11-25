import { isPackingPoint, type PackingPoint } from "./contents";

/**
 * F4 box-auto-pick: reading packaging usage and problems back out.
 *
 * Packaging stock rows come from two writers:
 *   - the old scan path: one negative row per box ("prod:order_..." keys);
 *   - auto mode: negative rows when packaging is used and POSITIVE rows when
 *     a correction returns one ("pkg:..." keys).
 * Usage must therefore net the "pkg:" rows, or a corrected box counts twice.
 */

/**
 * PostgREST `or` filter for packaging usage: every negative row, plus the
 * positive rows written by packaging corrections. Other positive movements
 * (deliveries, stocktakes) stay out, exactly as before.
 */
export const PACKAGE_USAGE_ROWS_FILTER = 'delta.lt.0,source_id.like."pkg:%"';

/** How much one ledger row adds to usage (negative for a returned box). */
export function usageOf(row: { delta: number }): number {
  return -row.delta;
}

/** Net units used per product. Products that net to zero or less are left out. */
export function netUsageByProduct(rows: Array<{ product_id: string; delta: number }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.product_id, (out.get(r.product_id) ?? 0) + usageOf(r));
  for (const [id, n] of out) if (!(n > 0)) out.delete(id);
  return out;
}

/** product id -> label for every packaging item in any of the site's rule sets (newest first wins). */
export function catalogueProducts(ruleSetBodies: unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const body of ruleSetBodies) {
    const catalogue = (body as { catalogue?: unknown } | null)?.catalogue;
    if (!Array.isArray(catalogue)) continue;
    for (const item of catalogue) {
      const c = item as { product_id?: unknown; label?: unknown };
      if (typeof c.product_id === "string" && c.product_id && !out.has(c.product_id)) {
        out.set(c.product_id, typeof c.label === "string" && c.label ? c.label : c.product_id);
      }
    }
  }
  return out;
}

export interface CompletionEvent {
  id: string;
  order_number: string;
  department: string;
  event_type: string;
  created_at: string;
  cs_case_id?: string | null;
}

export interface PickKey {
  order_number: string;
  packing_point: string;
  shipment_key: string;
}

export interface MissingPick {
  order_number: string;
  packing_point: PackingPoint;
  shipment_key: string;
  /** The first completion of that shipment at that station. */
  completed_at: string;
  event_id: string;
}

const key = (order: string, point: string, shipment: string) => `${order}\u0000${point}\u0000${shipment}`;

/**
 * Completions at a packing station that have no packaging record, since the
 * site switched to auto mode. These are saves that never reached the server
 * (lost device, cleared browser) or that the server refused.
 *
 * `autoSince` is when the site entered auto mode; null (site is on scanning)
 * returns nothing, because scan-mode completions never create picks.
 */
export function completionsWithoutPick(
  events: CompletionEvent[],
  picks: PickKey[],
  autoSince: string | null,
): MissingPick[] {
  if (!autoSince) return [];
  const since = Date.parse(autoSince);
  if (Number.isNaN(since)) return [];
  const have = new Set(picks.map((p) => key(p.order_number, p.packing_point, p.shipment_key)));
  const first = new Map<string, MissingPick>();
  for (const e of events) {
    if (e.event_type !== "completed" && e.event_type !== "dispatched") continue;
    if (!isPackingPoint(e.department)) continue;
    const at = Date.parse(e.created_at);
    if (Number.isNaN(at) || at < since) continue;
    const shipment = e.cs_case_id ? `cs:${e.cs_case_id}` : "orig";
    const k = key(e.order_number, e.department, shipment);
    if (have.has(k)) continue;
    const seen = first.get(k);
    if (!seen || at < Date.parse(seen.completed_at)) {
      first.set(k, { order_number: e.order_number, packing_point: e.department, shipment_key: shipment, completed_at: e.created_at, event_id: e.id });
    }
  }
  return [...first.values()].sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at));
}
