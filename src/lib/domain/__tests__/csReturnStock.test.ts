import { describe, expect, it } from "vitest";
import {
  addStockDelta,
  csReturnDeleteMoves,
  planCsReturnStock,
  removeStockDelta,
  type CsReturnStockMove,
} from "../csReturnStock";
import type { CsReturnLine, CsReturnStatus } from "../schemas";

/**
 * Simulates Repository.adjustOnHand exactly as both backends implement it:
 * Dexie `Math.max(before - delta, 0)` and SQL adjust_on_hand
 * `GREATEST(v_before - p_delta, 0)` (0002_rpc.sql).
 */
function applyMoves(stock: Map<string, number>, moves: CsReturnStockMove[]) {
  for (const m of moves) {
    if (m.delta === 0) continue;
    const before = stock.get(m.productId) ?? 0;
    stock.set(m.productId, Math.max(before - m.delta, 0));
  }
}

/** Runs one save the way upsertCsReturn does and returns the persisted lines. */
function save(
  stock: Map<string, number>,
  prevLines: CsReturnLine[],
  status: CsReturnStatus,
  next: Array<Pick<CsReturnLine, "id" | "product_id" | "quantity" | "restock">>,
): CsReturnLine[] {
  const plan = planCsReturnStock(prevLines, status, next);
  applyMoves(stock, plan.reversals);
  applyMoves(stock, plan.credits);
  return next.map((l) => ({
    ...l,
    return_id: "r1",
    inventory_credited: plan.credited.get(l.id) ?? false,
  }));
}

const line = (over: Partial<CsReturnLine> = {}) => ({
  id: "l1",
  product_id: "p1",
  quantity: 3,
  restock: true,
  ...over,
});

describe("return restock stock movements", () => {
  it("uses adjustOnHand's subtract-positive convention", () => {
    expect(addStockDelta(3)).toBe(-3);
    expect(removeStockDelta(3)).toBe(3);
  });

  it("Received + Restock ADDS the quantity to stock", () => {
    const stock = new Map([["p1", 10]]);
    const saved = save(stock, [], "received", [line()]);
    expect(stock.get("p1")).toBe(13);
    expect(saved[0].inventory_credited).toBe(true);
  });

  it("RTS + Restock ADDS the quantity to stock", () => {
    const stock = new Map([["p1", 0]]);
    save(stock, [], "rts", [line({ quantity: 2 })]);
    expect(stock.get("p1")).toBe(2);
  });

  it("New, or Restock unticked, does not touch stock", () => {
    const stock = new Map([["p1", 10]]);
    expect(save(stock, [], "new", [line()])[0].inventory_credited).toBe(false);
    expect(save(stock, [], "received", [line({ restock: false })])[0].inventory_credited).toBe(false);
    expect(stock.get("p1")).toBe(10);
  });

  it("re-saving a received return is idempotent", () => {
    const stock = new Map([["p1", 10]]);
    let lines = save(stock, [], "received", [line()]);
    lines = save(stock, lines, "received", [line()]);
    save(stock, lines, "received", [line()]);
    expect(stock.get("p1")).toBe(13);
  });

  it("closing a restocked return KEEPS the stock", () => {
    const stock = new Map([["p1", 10]]);
    let lines = save(stock, [], "received", [line()]);
    lines = save(stock, lines, "closed", [line()]);
    expect(stock.get("p1")).toBe(13);
    expect(lines[0].inventory_credited).toBe(true);
    // and saving the closed return again stays put
    save(stock, lines, "closed", [line()]);
    expect(stock.get("p1")).toBe(13);
  });

  it("closing never creates a new credit", () => {
    const stock = new Map([["p1", 10]]);
    let lines = save(stock, [], "new", [line()]);
    lines = save(stock, lines, "closed", [line()]);
    expect(stock.get("p1")).toBe(10);
    expect(lines[0].inventory_credited).toBe(false);
  });

  it("moving back to New removes the restocked units", () => {
    const stock = new Map([["p1", 10]]);
    const lines = save(stock, [], "received", [line()]);
    save(stock, lines, "new", [line()]);
    expect(stock.get("p1")).toBe(10);
  });

  it("unticking Restock removes the restocked units", () => {
    const stock = new Map([["p1", 10]]);
    const lines = save(stock, [], "received", [line()]);
    save(stock, lines, "received", [line({ restock: false })]);
    expect(stock.get("p1")).toBe(10);
  });

  it("unticking Restock on a closed return removes the units", () => {
    const stock = new Map([["p1", 10]]);
    let lines = save(stock, [], "received", [line()]);
    lines = save(stock, lines, "closed", [line()]);
    save(stock, lines, "closed", [line({ restock: false })]);
    expect(stock.get("p1")).toBe(10);
  });

  it("editing the quantity nets to the new quantity", () => {
    const stock = new Map([["p1", 10]]);
    const lines = save(stock, [], "received", [line({ quantity: 3 })]);
    save(stock, lines, "received", [line({ quantity: 5 })]);
    expect(stock.get("p1")).toBe(15);
  });

  it("changing the product moves the credit to the new product", () => {
    const stock = new Map([["p1", 10], ["p2", 4]]);
    const lines = save(stock, [], "received", [line()]);
    save(stock, lines, "received", [line({ product_id: "p2" })]);
    expect(stock.get("p1")).toBe(10);
    expect(stock.get("p2")).toBe(7);
  });

  it("only restocked lines move; others are untouched", () => {
    const stock = new Map([["p1", 10], ["p2", 4]]);
    save(stock, [], "received", [line(), line({ id: "l2", product_id: "p2", restock: false })]);
    expect(stock.get("p1")).toBe(13);
    expect(stock.get("p2")).toBe(4);
  });

  it("deleting a restocked return removes the units it added", () => {
    const stock = new Map([["p1", 10]]);
    const lines = save(stock, [], "received", [line()]);
    applyMoves(stock, csReturnDeleteMoves(lines));
    expect(stock.get("p1")).toBe(10);
  });

  it("deleting a return that was never restocked does not touch stock", () => {
    const stock = new Map([["p1", 10]]);
    const lines = save(stock, [], "new", [line()]);
    expect(csReturnDeleteMoves(lines)).toEqual([]);
  });
});
