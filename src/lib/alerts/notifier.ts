import type { ForecastResult } from "@/lib/forecasting";
import type { IncomingShipment, Product } from "@/lib/domain";
import { todayIso } from "@/lib/utils/dates";

/**
 * Alert types that can fire. Stubs only — wire to real email/webhook from
 * a backend when one exists. The UI shows transitions in the bell badge.
 */
export type AlertKind = "critical" | "oos" | "shipment_slipped";

export interface AlertPayload {
  kind: AlertKind;
  productId?: string;
  productCode?: string;
  shipmentId?: string;
  poNumber?: string;
  message: string;
  emittedAt: string;
}

/**
 * Stable identifier for the *logical* alert (kind + the entity it concerns)
 * — independent of when it was emitted. Used to track read-state and the
 * first-seen timestamp across re-detections, so a SKU staying critical
 * keeps the same id (and the same "first alerted on" date) day after day.
 */
export function alertKey(a: AlertPayload): string {
  return `${a.kind}:${a.productId ?? a.shipmentId ?? "?"}`;
}

/** No-op stubs — replace with fetch() to a backend or webhook when available. */
export async function notifyEmail(payload: AlertPayload): Promise<void> {
  // eslint-disable-next-line no-console
  console.info("[notifyEmail stub]", payload);
}
export async function notifyWebhook(payload: AlertPayload): Promise<void> {
  // eslint-disable-next-line no-console
  console.info("[notifyWebhook stub]", payload);
}

/**
 * Detect the alerts that should fire given current forecasts and shipments.
 * Pure function — caller decides where to hand the payloads.
 */
export function detectAlerts(
  products: Product[],
  forecasts: ForecastResult[],
  shipments: IncomingShipment[],
): AlertPayload[] {
  const today = todayIso();
  const out: AlertPayload[] = [];

  for (const r of forecasts) {
    const p = products.find((x) => x.id === r.productId);
    if (!p) continue;
    if (r.status === "OOS") {
      out.push({
        kind: "oos",
        productId: p.id,
        productCode: p.code,
        message: `${p.code} is out of stock.`,
        emittedAt: today,
      });
    } else if (r.status === "Critical") {
      out.push({
        kind: "critical",
        productId: p.id,
        productCode: p.code,
        message: `${p.code} has ${r.weeksUntilOosCurrent ?? 0} week(s) of cover left.`,
        emittedAt: today,
      });
    }
  }

  for (const s of shipments) {
    if (s.status === "Cancelled" || s.status === "Delivered" || s.status === "On hold" || s.status === "Back-Ordered") continue;
    if (!s.actual_arrival_date && s.expected_arrival_date < today) {
      out.push({
        kind: "shipment_slipped",
        shipmentId: s.id,
        poNumber: s.po_number,
        productId: s.product_id,
        message: `Shipment ${s.po_number} expected ${s.expected_arrival_date} hasn't been logged as arrived.`,
        emittedAt: today,
      });
    }
  }

  return out;
}
