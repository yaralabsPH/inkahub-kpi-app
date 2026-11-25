/**
 * Reads the answer of the `deduct_inventory_for_event` RPC (migrations 0025,
 * 0026, 0031). The RPC lists stock codes it could not find in
 * `missing_codes` and carries on with the rest. Until now the page only
 * logged that to the console, so a missing stock item (for example a frame
 * item named differently) silently took nothing off stock.
 */

/** Stock codes the RPC could not find; empty when none or the shape is unknown. */
export function missingStockCodes(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const raw = (result as { missing_codes?: unknown }).missing_codes;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const c of raw) {
    if (typeof c === "string" && c.trim()) seen.add(c.trim());
  }
  return [...seen];
}

/** One plain sentence for the station, or null when nothing is missing. */
export function missingStockMessage(result: unknown): string | null {
  const codes = missingStockCodes(result);
  if (codes.length === 0) return null;
  return `Order saved, but stock was NOT taken off for: ${codes.join(", ")}. Tell a manager: the stock item is missing or named differently.`;
}
