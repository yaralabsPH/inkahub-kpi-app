/**
 * Presentation only: which REQUESTED stock adjustment an existing shipment
 * save/delete will ask the selected backend to make, so the confirm step can
 * show it. It never performs anything and claims no final balance (missing
 * products are skipped, and the repository reads the then-current row).
 *
 * The two adapters differ, so the backend is explicit:
 *  - Supabase (SupabaseRepo.upsertShipment): reverse when auto-apply is on,
 *    the previous status was Delivered AND it was applied, and the new status
 *    is not Delivered; credit when auto-apply is on and the new status is
 *    Delivered (apply_shipment_delivery is a no-op if already applied).
 *  - Dexie (DexieRepo.upsertShipment): reverse when auto-apply is on, the new
 *    status is not Delivered and the previous row carries an applied marker
 *    (whatever its status); credit when auto-apply is on, the new status is
 *    Delivered and there is no applied marker.
 *  - Delete (both): an applied shipment's lines are reversed.
 */
export type Backend = "supabase" | "dexie";

export interface ShipmentLike {
  status: string;
  inventory_applied_at: string | null;
  lines: ReadonlyArray<{ product_id: string; quantity: number }>;
}

export interface ShipmentStockChange {
  kind: "credit" | "reverse";
  lines: { productId: string; quantity: number }[];
}

const linesOf = (s: Pick<ShipmentLike, "lines">) =>
  s.lines.filter((l) => l.quantity > 0).map((l) => ({ productId: l.product_id, quantity: l.quantity }));

export function shipmentStatusStockChange(
  prev: ShipmentLike | null,
  next: Pick<ShipmentLike, "status" | "lines">,
  autoApply: boolean,
  backend: Backend,
): ShipmentStockChange | null {
  if (!autoApply) return null;
  const applied = !!prev?.inventory_applied_at;
  const reverses = backend === "supabase"
    ? applied && prev!.status === "Delivered" && next.status !== "Delivered"
    : applied && next.status !== "Delivered";
  if (reverses) return { kind: "reverse", lines: linesOf(prev!) };
  if (next.status === "Delivered" && !applied) return { kind: "credit", lines: linesOf(next) };
  return null;
}

export function shipmentDeleteStockChange(s: ShipmentLike): ShipmentStockChange | null {
  if (!s.inventory_applied_at) return null;
  return { kind: "reverse", lines: linesOf(s) };
}
