import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseRepo } from "../SupabaseRepo";
import type { CsReturn, CsReturnLine, CsReturnStatus } from "@/lib/domain";

/**
 * Drives the real SupabaseRepo return code against an in-memory client.
 * `adjust_on_hand` mirrors 0002_rpc.sql: after = GREATEST(before - p_delta, 0),
 * and the ledger records the actual change.
 */
type Row = Record<string, any>;

class FakeDb {
  tables: Record<string, Row[]> = { products: [], cs_returns: [], cs_return_lines: [], ledger: [] };
  failRead: string | null = null;
  rpcCalls: { p_product_id: string; p_delta: number }[] = [];

  onHand(id: string) {
    return this.tables.products.find((p) => p.id === id)?.current_on_hand;
  }

  client(): SupabaseClient {
    const db = this;
    return {
      from: (table: string) => new FakeQuery(db, table),
      rpc: async (name: string, args: Row) => {
        if (name !== "adjust_on_hand") throw new Error(`unexpected rpc ${name}`);
        db.rpcCalls.push({ p_product_id: args.p_product_id, p_delta: args.p_delta });
        const p = db.tables.products.find((x) => x.location === args.p_location && x.id === args.p_product_id);
        if (!p) return { data: null, error: { message: "product not found" } };
        const before = p.current_on_hand;
        p.current_on_hand = Math.max(before - args.p_delta, 0);
        db.tables.ledger.push({ product_id: p.id, delta: p.current_on_hand - before, reason: args.p_reason });
        return { data: null, error: null };
      },
    } as unknown as SupabaseClient;
  }
}

class FakeQuery {
  private filters: ((r: Row) => boolean)[] = [];
  private op: "select" | "delete" | "upsert" | "insert" = "select";
  private payload: Row[] = [];
  private single = false;
  constructor(private db: FakeDb, private table: string) {}
  select() { return this; }
  eq(k: string, v: unknown) { this.filters.push((r) => r[k] === v); return this; }
  in(k: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[k])); return this; }
  maybeSingle() { this.single = true; return this; }
  delete() { this.op = "delete"; return this; }
  upsert(row: Row) { this.op = "upsert"; this.payload = [row]; return this; }
  insert(rows: Row[]) { this.op = "insert"; this.payload = rows; return this; }
  then(resolve: (v: unknown) => void) {
    const rows = this.db.tables[this.table];
    const match = (r: Row) => this.filters.every((f) => f(r));
    if (this.op === "select") {
      if (this.db.failRead === this.table) return resolve({ data: null, error: { message: "network down" } });
      const found = rows.filter(match).map((r) => ({ ...r }));
      return resolve({ data: this.single ? found[0] ?? null : found, error: null });
    }
    if (this.op === "delete") {
      this.db.tables[this.table] = rows.filter((r) => !match(r));
      return resolve({ data: null, error: null });
    }
    if (this.op === "upsert") {
      const row = this.payload[0];
      const i = rows.findIndex((r) => r.location === row.location && r.id === row.id);
      if (i >= 0) rows[i] = { ...row }; else rows.push({ ...row });
      return resolve({ data: null, error: null });
    }
    rows.push(...this.payload.map((r) => ({ ...r })));
    return resolve({ data: null, error: null });
  }
}

const LOC = "au";

function setup(stock: Record<string, number>) {
  const db = new FakeDb();
  for (const [id, n] of Object.entries(stock)) db.tables.products.push({ location: LOC, id, current_on_hand: n });
  const repo = new SupabaseRepo(db.client(), LOC as never);
  return { db, repo };
}

const ret = (status: CsReturnStatus): CsReturn => ({
  id: "r1",
  created_at: "2026-11-25T00:00:00.000Z",
  created_by_user_id: null,
  status,
  order_number: "1001",
  shopify_order_url: null,
  customer_name: null,
  customer_email: null,
  expected_return_date: null,
  refund_expected: true,
  refund_received: false,
  notes: "",
  received_at: null,
  closed_at: null,
  updated_at: "2026-11-25T00:00:00.000Z",
} as CsReturn);

const line = (over: Partial<CsReturnLine> = {}): CsReturnLine => ({
  id: "l1", return_id: "r1", product_id: "p1", quantity: 3, restock: true, inventory_credited: false, ...over,
} as CsReturnLine);

describe("SupabaseRepo returns: stock through adjust_on_hand", () => {
  it("Received + Restock adds stock (negative p_delta) and flags the line", async () => {
    const { db, repo } = setup({ p1: 10 });
    await repo.upsertCsReturn(ret("received"), [line()]);
    expect(db.rpcCalls).toEqual([{ p_product_id: "p1", p_delta: -3 }]);
    expect(db.onHand("p1")).toBe(13);
    expect(db.tables.ledger).toEqual([{ product_id: "p1", delta: 3, reason: "return" }]);
    expect(db.tables.cs_return_lines[0].inventory_credited).toBe(true);
  });

  it("an unchanged resave after the units were used makes no stock call", async () => {
    const { db, repo } = setup({ p1: 0 });
    await repo.upsertCsReturn(ret("received"), [line()]);
    db.tables.products[0].current_on_hand = 1;
    db.rpcCalls = [];
    await repo.upsertCsReturn(ret("received"), [line()]);
    await repo.upsertCsReturn(ret("closed"), [line()]);
    expect(db.rpcCalls).toEqual([]);
    expect(db.onHand("p1")).toBe(1);
    expect(db.tables.cs_return_lines[0].inventory_credited).toBe(true);
  });

  it("a closed quantity edit is rejected before any stock call", async () => {
    const { db, repo } = setup({ p1: 10 });
    await repo.upsertCsReturn(ret("received"), [line()]);
    await repo.upsertCsReturn(ret("closed"), [line()]);
    db.rpcCalls = [];
    await expect(repo.upsertCsReturn(ret("closed"), [line({ quantity: 5 })])).rejects.toThrow(/Closed/);
    expect(db.rpcCalls).toEqual([]);
    expect(db.onHand("p1")).toBe(13);
  });

  it("delete removes the restocked units (positive p_delta)", async () => {
    const { db, repo } = setup({ p1: 10 });
    await repo.upsertCsReturn(ret("received"), [line()]);
    await repo.deleteCsReturn("r1");
    expect(db.rpcCalls.at(-1)).toEqual({ p_product_id: "p1", p_delta: 3 });
    expect(db.onHand("p1")).toBe(10);
    expect(db.tables.cs_returns).toEqual([]);
  });

  it("a failed read of the saved lines stops the save before any stock call", async () => {
    const { db, repo } = setup({ p1: 10 });
    await repo.upsertCsReturn(ret("received"), [line()]);
    db.rpcCalls = [];
    db.failRead = "cs_return_lines";
    await expect(repo.upsertCsReturn(ret("received"), [line()])).rejects.toBeTruthy();
    await expect(repo.deleteCsReturn("r1")).rejects.toBeTruthy();
    expect(db.rpcCalls).toEqual([]);
    expect(db.onHand("p1")).toBe(13);
  });

  it("a missing SKU is rejected before any stock call", async () => {
    const { db, repo } = setup({ p1: 10 });
    await expect(repo.upsertCsReturn(ret("received"), [line({ product_id: "gone" })])).rejects.toThrow(/no longer exists/);
    expect(db.rpcCalls).toEqual([]);
    expect(db.tables.cs_returns).toEqual([]);
  });

  it("a line id owned by another return is rejected before any stock call", async () => {
    const { db, repo } = setup({ p1: 10 });
    db.tables.cs_return_lines.push({ location: LOC, ...line({ return_id: "other" }) });
    await expect(repo.upsertCsReturn(ret("received"), [line()])).rejects.toThrow(/another return/);
    expect(db.rpcCalls).toEqual([]);
  });
});
