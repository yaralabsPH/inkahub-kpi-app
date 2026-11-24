/**
 * What an existing shipment save/delete WILL do to stock, for the confirm
 * step only. It mirrors the repositories' rules (SupabaseRepo/DexieRepo
 * upsertShipment and delete_shipment_atomic) and never performs anything.
 *
 *  - Credit: auto-apply on, new status Delivered, not applied yet.
 *  - Reverse: auto-apply on, leaving a Delivered that was applied.
 *  - Delete: an applied shipment is always reversed when deleted.
 */
export interface ShipmentLike {
  status: string;
  inventory_applied_at: string | null;
  lines: ReadonlyArray<{ product_id: string; quantity: number }>;
}

export interface ShipmentStockChange {
  kind: "credit" | "reverse";
  lines: { productId: string; quantity: number }[];
}

const linesOf = (s: ShipmentLike) =>
  s.lines.filter((l) => l.quantity > 0).map((l) => ({ productId: l.product_id, quantity: l.quantity }));

export function shipmentStatusStockChange(
  prev: ShipmentLike | null,
  next: Pick<ShipmentLike, "status" | "lines">,
  autoApply: boolean,
): ShipmentStockChange | null {
  if (!autoApply) return null;
  const wasApplied = !!prev && prev.status === "Delivered" && !!prev.inventory_applied_at;
  if (wasApplied && next.status !== "Delivered") return { kind: "reverse", lines: linesOf(prev) };
  if (next.status === "Delivered" && !prev?.inventory_applied_at) {
    return { kind: "credit", lines: linesOf({ status: next.status, inventory_applied_at: null, lines: next.lines }) };
  }
  return null;
}

export function shipmentDeleteStockChange(s: ShipmentLike): ShipmentStockChange | null {
  if (!s.inventory_applied_at) return null;
  return { kind: "reverse", lines: linesOf(s) };
}
