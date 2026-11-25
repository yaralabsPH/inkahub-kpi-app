import { describe, expect, it } from "vitest";
import {
  addStockDelta,
  csReturnDeleteMoves,
  CsReturnStockError,
  planCsReturnStock,
  removeStockDelta,
  type CsReturnStockMove,
} from "../csReturnStock";
import type { CsReturnLine, CsReturnStatus } from "../schemas";
import { onHandAfterAdjust } from "../stockAdjust";

/**
 * Applies moves with the same function DexieRepo.adjustOnHand uses; SQL
 * adjust_on_hand does the same arithmetic since 0063 (exact, no floor).
 */
function applyMoves(stock: Map<string, number>, moves: CsReturnStockMove[]) {
  for (const m of moves) {
    const before = stock.get(m.productId) ?? 0;
    stock.set(m.productId, onHandAfterAdjust(before, m.delta));
  }
}

type In = Pick<CsReturnLine, "id" | "product_id" | "quantity" | "restock">;

/** Runs one save the way upsertCsReturn does and returns the persisted lines. */
function save(stock: Map<string, number>, prev: CsReturnLine[], status: CsReturnStatus, next: In[]): CsReturnLine[] {
  const plan = planCsReturnStock(prev, status, next);
  applyMoves(stock, plan.moves);
  return next.map((l) => ({ ...l, return_id: "r1", inventory_credited: plan.credited.get(l.id) ?? false }));
}

const line = (over: Partial<In> = {}): In => ({ id: "l1", product_id: "p1", quantity: 3, restock: true, ...over });

describe("return restock: direction", () => {
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
});

describe("return restock: unchanged saves never move stock", () => {
  for (const status of ["received", "rts", "closed"] as const) {
    it(`unchanged ${status} save after the units were used keeps stock as is`, () => {
      const stock = new Map([["p1", 0]]);
      let lines = save(stock, [], "received", [line()]); // 0 → 3
      if (status !== "received") lines = save(stock, lines, status, [line()]);
      stock.set("p1", 1); // 2 units sold/used elsewhere
      const plan = planCsReturnStock(lines, status, [line()]);
      expect(plan.moves).toEqual([]);
      applyMoves(stock, plan.moves);
      expect(stock.get("p1")).toBe(1);
    });
  }

  it("repeated received saves add the units once", () => {
    const stock = new Map([["p1", 10]]);
    let lines = save(stock, [], "received", [line()]);
    lines = save(stock, lines, "received", [line()]);
    save(stock, lines, "received", [line()]);
    expect(stock.get("p1")).toBe(13);
  });

  it("RTS ↔ Received switches move nothing", () => {
    const stock = new Map([["p1", 10]]);
    let lines = save(stock, [], "received", [line()]);
    lines = save(stock, lines, "rts", [line()]);
    lines = save(stock, lines, "received", [line()]);
    expect(stock.get("p1")).toBe(13);
    expect(lines[0].inventory_credited).toBe(true);
  });
});

describe("return restock: closed", () => {
  it("closing a restocked return KEEPS the stock", () => {
    const stock = new Map([["p1", 10]]);
    let lines = save(stock, [], "received", [line()]);
    lines = save(stock, lines, "closed", [line()]);
    expect(stock.get("p1")).toBe(13);
    expect(lines[0].inventory_credited).toBe(true);
  });

  it("Closed → Received → Closed keeps one credit", () => {
    const stock = new Map([["p1", 10]]);
    let lines = save(stock, [], "received", [line()]);
    lines = save(stock, lines, "closed", [line()]);
    lines = save(stock, lines, "received", [line()]);
    lines = save(stock, lines, "closed", [line()]);
    expect(stock.get("p1")).toBe(13);
  });

  it("closing a never-restocked return adds nothing", () => {
    const stock = new Map([["p1", 10]]);
    let lines = save(stock, [], "new", [line()]);
    lines = save(stock, lines, "closed", [line()]);
    expect(stock.get("p1")).toBe(10);
    expect(lines[0].inventory_credited).toBe(false);
  });

  it("adding a new restock line while Closed adds nothing", () => {
    const stock = new Map([["p1", 10], ["p2", 5]]);
    let lines = save(stock, [], "received", [line()]);
    lines = save(stock, lines, "closed", [line(), line({ id: "l2", product_id: "p2" })]);
    expect(stock.get("p2")).toBe(5);
    expect(lines[1].inventory_credited).toBe(false);
  });

  it("rejects a quantity change on a restocked line while Closed", () => {
    const stock = new Map([["p1", 10]]);
    let lines = save(stock, [], "received", [line()]);
    lines = save(stock, lines, "closed", [line()]);
    expect(() => planCsReturnStock(lines, "closed", [line({ quantity: 5 })])).toThrow(CsReturnStockError);
    expect(() => planCsReturnStock(lines, "closed", [line({ quantity: 2 })])).toThrow(CsReturnStockError);
  });

  it("rejects a SKU change on a restocked line while Closed", () => {
    const stock = new Map([["p1", 10]]);
    let lines = save(stock, [], "received", [line()]);
    lines = save(stock, lines, "closed", [line()]);
    expect(() => planCsReturnStock(lines, "closed", [line({ product_id: "p2" })])).toThrow(CsReturnStockError);
  });

  it("unticking Restock while Closed removes the units; reticking does not re-add", () => {
    const stock = new Map([["p1", 10]]);
    let lines = save(stock, [], "received", [line()]);
    lines = save(stock, lines, "closed", [line()]);
    lines = save(stock, lines, "closed", [line({ restock: false })]);
    expect(stock.get("p1")).toBe(10);
    save(stock, lines, "closed", [line()]);
    expect(stock.get("p1")).toBe(10);
  });

  it("removing a restocked line while Closed removes its units", () => {
    const stock = new Map([["p1", 10]]);
    let lines = save(stock, [], "received", [line()]);
    lines = save(stock, lines, "closed", [line()]);
    save(stock, lines, "closed", []);
    expect(stock.get("p1")).toBe(10);
  });
});

describe("return restock: edits and removals", () => {
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

  it("quantity edits move only the difference", () => {
    const stock = new Map([["p1", 10]]);
    let lines = save(stock, [], "received", [line({ quantity: 3 })]);
    lines = save(stock, lines, "received", [line({ quantity: 5 })]);
    expect(stock.get("p1")).toBe(15);
    stock.set("p1", 1); // most units used since
    save(stock, lines, "received", [line({ quantity: 4 })]);
    expect(stock.get("p1")).toBe(0); // net −1, not reverse 5 / re-add 4
  });

  it("changing the product moves the credit to the new product", () => {
    const stock = new Map([["p1", 10], ["p2", 4]]);
    const lines = save(stock, [], "received", [line()]);
    save(stock, lines, "received", [line({ product_id: "p2" })]);
    expect(stock.get("p1")).toBe(10);
    expect(stock.get("p2")).toBe(7);
  });

  it("two lines for the same SKU net together", () => {
    const stock = new Map([["p1", 10]]);
    let lines = save(stock, [], "received", [line(), line({ id: "l2", quantity: 2 })]);
    expect(stock.get("p1")).toBe(15);
    const plan = planCsReturnStock(lines, "received", [line({ quantity: 2 }), line({ id: "l2", quantity: 3 })]);
    expect(plan.moves).toEqual([]);
    lines = save(stock, lines, "received", [line({ id: "l2", quantity: 2 })]);
    expect(stock.get("p1")).toBe(12);
  });

  it("only restocked lines move; others are untouched", () => {
    const stock = new Map([["p1", 10], ["p2", 4]]);
    save(stock, [], "received", [line(), line({ id: "l2", product_id: "p2", restock: false })]);
    expect(stock.get("p1")).toBe(13);
    expect(stock.get("p2")).toBe(4);
  });

  it("removal after the units were used is exact and can go below zero", () => {
    const stock = new Map([["p1", 0]]);
    const lines = save(stock, [], "received", [line()]);
    stock.set("p1", 1);
    save(stock, lines, "new", [line()]);
    expect(stock.get("p1")).toBe(-2);
  });

  it("restock onto negative stock adds exactly, and undo restores it (live case: −12)", () => {
    const stock = new Map([["p1", -12]]);
    const lines = save(stock, [], "received", [line({ quantity: 1 })]);
    expect(stock.get("p1")).toBe(-11);
    applyMoves(stock, csReturnDeleteMoves(lines));
    expect(stock.get("p1")).toBe(-12);
  });
});

describe("return restock: delete", () => {
  it("deleting a restocked return removes the units it added", () => {
    const stock = new Map([["p1", 10]]);
    const lines = save(stock, [], "received", [line(), line({ id: "l2", quantity: 2 })]);
    expect(csReturnDeleteMoves(lines)).toEqual([{ productId: "p1", change: -5, delta: 5 }]);
    applyMoves(stock, csReturnDeleteMoves(lines));
    expect(stock.get("p1")).toBe(10);
  });

  it("deleting a return that was never restocked does not touch stock", () => {
    const stock = new Map([["p1", 10]]);
    expect(csReturnDeleteMoves(save(stock, [], "new", [line()]))).toEqual([]);
  });
});

describe("return restock: input checks happen before any move", () => {
  it("rejects duplicate line ids", () => {
    expect(() => planCsReturnStock([], "received", [line(), line()])).toThrow(/twice/);
  });

  it("rejects zero, negative or fractional quantities", () => {
    for (const q of [0, -1, 1.5, Number.NaN]) {
      expect(() => planCsReturnStock([], "received", [line({ quantity: q })])).toThrow(CsReturnStockError);
    }
  });

  it("rejects a line without a SKU", () => {
    expect(() => planCsReturnStock([], "received", [line({ product_id: "" })])).toThrow(/SKU/);
  });

  it("lists every incoming line's SKU (restocked or not) so the adapters can check they exist", () => {
    const plan = planCsReturnStock([], "received", [line({ product_id: "p2" }), line({ id: "l2", restock: false })]);
    expect(plan.productIds).toEqual(["p1", "p2"]);
  });
});
