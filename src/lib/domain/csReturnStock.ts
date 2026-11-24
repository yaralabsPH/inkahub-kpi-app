import type { CsReturnLine, CsReturnStatus } from "./schemas";

/**
 * Stock movements for a customer return, shared by DexieRepo, SupabaseRepo
 * and the return modal's preview, so all three agree.
 *
 * Sign convention: `Repository.adjustOnHand` SUBTRACTS a positive delta
 * (Dexie `Math.max(before - delta, 0)`; SQL adjust_on_hand
 * `GREATEST(v_before - p_delta, 0)`). Adding stock is a NEGATIVE delta.
 *
 * Which lines count as restocked (credited):
 *  - Received / RTS: every line with Restock ticked.
 *  - Closed: only lines that were already credited and still have Restock
 *    ticked. Closing keeps stock already added and never adds new stock.
 *    Changing the product or quantity of a credited line while Closed is
 *    rejected (reopen to Received/RTS to correct it); unticking Restock or
 *    removing the line while Closed takes its units back out.
 *  - New: nothing.
 *
 * Movements are NET per product: the total previously credited per product
 * is compared with the total that should be credited now, and only the
 * difference moves. An unchanged save moves nothing, so the zero floor can
 * never turn a resave into extra stock.
 *
 * Insufficient stock: a removal (untick, status back to New, smaller
 * quantity, delete) is clamped at zero by adjustOnHand like every other
 * stock movement in the app; the ledger records the actual change.
 */

/** adjustOnHand delta that ADDS `quantity` units to stock. */
export const addStockDelta = (quantity: number) => -quantity;
/** adjustOnHand delta that REMOVES `quantity` units from stock. */
export const removeStockDelta = (quantity: number) => quantity;

export class CsReturnStockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsReturnStockError";
  }
}

export interface CsReturnStockMove {
  productId: string;
  /** Net units added (positive) or removed (negative) for this product. */
  change: number;
  /** Delta to pass to adjustOnHand (negative adds stock). */
  delta: number;
}

type PrevLine = Pick<CsReturnLine, "id" | "product_id" | "quantity" | "inventory_credited">;
type NextLine = Pick<CsReturnLine, "id" | "product_id" | "quantity" | "restock">;

export interface CsReturnStockPlan {
  /** Net per-product movements, sorted by product id. Zero changes omitted. */
  moves: CsReturnStockMove[];
  /** Line id → inventory_credited value to persist. */
  credited: Map<string, boolean>;
  /** Products credited after the save; each must exist before any move. */
  productIds: string[];
}

function validateLines(lines: readonly NextLine[]) {
  const seen = new Set<string>();
  for (const l of lines) {
    if (!l.id) throw new CsReturnStockError("A return line has no id.");
    if (seen.has(l.id)) throw new CsReturnStockError(`Return line ${l.id} appears twice.`);
    seen.add(l.id);
    if (!l.product_id) throw new CsReturnStockError("A return line has no SKU.");
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) {
      throw new CsReturnStockError("Return quantities must be whole numbers above zero.");
    }
  }
}

function netMoves(prev: Map<string, number>, next: Map<string, number>): CsReturnStockMove[] {
  const ids = [...new Set([...prev.keys(), ...next.keys()])].sort();
  const moves: CsReturnStockMove[] = [];
  for (const productId of ids) {
    const change = (next.get(productId) ?? 0) - (prev.get(productId) ?? 0);
    if (change !== 0) moves.push({ productId, change, delta: addStockDelta(change) });
  }
  return moves;
}

function creditedTotals(lines: readonly PrevLine[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) {
    if (l.inventory_credited) m.set(l.product_id, (m.get(l.product_id) ?? 0) + l.quantity);
  }
  return m;
}

export function planCsReturnStock(
  prevLines: readonly PrevLine[],
  status: CsReturnStatus,
  nextLines: readonly NextLine[],
): CsReturnStockPlan {
  validateLines(nextLines);
  const prevById = new Map(prevLines.map((l) => [l.id, l]));

  const credited = new Map<string, boolean>();
  const nextTotals = new Map<string, number>();
  for (const l of nextLines) {
    const prev = prevById.get(l.id);
    let will = false;
    if (l.restock && (status === "received" || status === "rts")) {
      will = true;
    } else if (l.restock && status === "closed" && prev?.inventory_credited) {
      if (prev.product_id !== l.product_id || prev.quantity !== l.quantity) {
        throw new CsReturnStockError(
          "This return is Closed and its restocked lines can't change SKU or quantity. " +
            "Move it back to Received to correct them.",
        );
      }
      will = true;
    }
    credited.set(l.id, will);
    if (will) nextTotals.set(l.product_id, (nextTotals.get(l.product_id) ?? 0) + l.quantity);
  }

  const moves = netMoves(creditedTotals(prevLines), nextTotals);
  const productIds = [...nextTotals.keys()].sort();
  return { moves, credited, productIds };
}

/** Net moves for deleting a return: remove every credited unit. */
export function csReturnDeleteMoves(prevLines: readonly PrevLine[]): CsReturnStockMove[] {
  return netMoves(creditedTotals(prevLines), new Map());
}
