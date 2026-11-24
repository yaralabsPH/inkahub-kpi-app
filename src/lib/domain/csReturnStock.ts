import type { CsReturnLine, CsReturnStatus } from "./schemas";

/**
 * Stock movements for a customer return, shared by DexieRepo and
 * SupabaseRepo so both backends move stock the same way.
 *
 * Sign convention: `Repository.adjustOnHand` SUBTRACTS a positive delta
 * (Dexie: `next = before - delta`; Supabase `adjust_on_hand`:
 * `after = before - p_delta`). A restock must ADD stock, so its delta is
 * `-quantity`; undoing a restock removes stock, so its delta is `+quantity`.
 *
 * Rules (per line):
 *  - Received / RTS + Restock ticked → the line is credited (stock added).
 *  - Closed keeps a credit that was already applied (closing a received
 *    return must not take the stock back out) but never creates a new one.
 *  - New, or Restock unticked → no credit; an earlier credit is reversed.
 *
 * Saves use reverse-all-then-reapply: every previously credited line is
 * reversed, then every line that should be credited now is credited, so
 * quantity or product edits net out correctly.
 */

/** adjustOnHand delta that ADDS `quantity` units to stock. */
export const addStockDelta = (quantity: number) => -quantity;
/** adjustOnHand delta that REMOVES `quantity` units from stock. */
export const removeStockDelta = (quantity: number) => quantity;

export interface CsReturnStockMove {
  lineId: string;
  productId: string;
  /** Delta to pass to adjustOnHand (negative adds stock). */
  delta: number;
}

type PrevLine = Pick<CsReturnLine, "id" | "product_id" | "quantity" | "inventory_credited">;
type NextLine = Pick<CsReturnLine, "id" | "product_id" | "quantity" | "restock">;

export function csReturnLineShouldCredit(
  status: CsReturnStatus,
  line: Pick<CsReturnLine, "id" | "restock">,
  prevLines: readonly PrevLine[],
): boolean {
  if (!line.restock) return false;
  if (status === "received" || status === "rts") return true;
  if (status === "closed") {
    return prevLines.some((p) => p.id === line.id && p.inventory_credited);
  }
  return false;
}

export interface CsReturnStockPlan {
  /** Undo every earlier credit (each removes stock). */
  reversals: CsReturnStockMove[];
  /** Credits to apply now (each adds stock). */
  credits: CsReturnStockMove[];
  /** Line id → inventory_credited value to persist. */
  credited: Map<string, boolean>;
}

export function planCsReturnStock(
  prevLines: readonly PrevLine[],
  status: CsReturnStatus,
  nextLines: readonly NextLine[],
): CsReturnStockPlan {
  const reversals = prevLines
    .filter((l) => l.inventory_credited)
    .map((l) => ({ lineId: l.id, productId: l.product_id, delta: removeStockDelta(l.quantity) }));
  const credits: CsReturnStockMove[] = [];
  const credited = new Map<string, boolean>();
  for (const l of nextLines) {
    const will = csReturnLineShouldCredit(status, l, prevLines);
    credited.set(l.id, will);
    if (will) credits.push({ lineId: l.id, productId: l.product_id, delta: addStockDelta(l.quantity) });
  }
  return { reversals, credits, credited };
}

/** Moves for deleting a return: undo every credited line (removes stock). */
export function csReturnDeleteMoves(prevLines: readonly PrevLine[]): CsReturnStockMove[] {
  return prevLines
    .filter((l) => l.inventory_credited)
    .map((l) => ({ lineId: l.id, productId: l.product_id, delta: removeStockDelta(l.quantity) }));
}
