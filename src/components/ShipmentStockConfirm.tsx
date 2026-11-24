import type { ConfirmOptions } from "@/components/ui/ConfirmDialog";
import type { ShipmentStockChange } from "@/lib/ui/shipmentStockChange";

/**
 * Confirm text for a shipment save/delete that will request a stock
 * adjustment. Worded as a request: the repository clamps stock at zero,
 * skips missing products and acts on the row as it is when the save runs.
 */
export function shipmentStockConfirm(
  change: ShipmentStockChange,
  po: string,
  what: string,
  codeOf: (productId: string) => string,
  confirmLabel?: string,
): ConfirmOptions {
  return {
    title: change.kind === "credit" ? `Add stock for ${po}?` : `Take back stock for ${po}?`,
    confirmLabel: confirmLabel ?? (change.kind === "credit" ? "Save and add stock" : "Save and take back stock"),
    danger: change.kind === "reverse",
    body: (
      <div className="space-y-2">
        <p>
          {change.kind === "credit"
            ? `${what} asks to add these units to stock now (auto-apply on delivery is on):`
            : `${what} asks to take back the units this shipment's delivery added:`}
        </p>
        {change.lines.length === 0 ? (
          <p className="text-hub-muted">No lines with a quantity.</p>
        ) : (
          <ul className="space-y-0.5 font-mono text-[12.5px]">
            {change.lines.map((l) => (
              <li key={l.productId}>
                {change.kind === "credit" ? "+" : "−"}{l.quantity} {codeOf(l.productId)}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-hub-muted">
          These are the requested amounts. Stock never goes below zero, and a SKU that no longer exists is skipped,
          so the recorded change can be smaller. Cancel leaves the shipment and stock as they are.
        </p>
      </div>
    ),
  };
}
