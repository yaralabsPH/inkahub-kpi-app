/**
 * Loader + counter integration for the Production bench (F1 Task 7).
 *
 * The page saves an event (insert) and then asks for an authoritative refresh.
 * These tests drive the same read path the page uses (loadProductionEvidence →
 * prepareProductionEvidence → buildProductionCounterView) against the in-memory
 * evidence RPC, with spies on every client call: a refresh or retry must only
 * read — never insert, never call the deduction RPC — and a failed save adds
 * no evidence. They do not prove the pre-existing deduction RPC is
 * concurrency-safe; that stays a staging smoke check.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { prepareProductionEvidence, type ProductionEvidenceEvent } from "../../src/lib/domain/productionCounts";
import { buildProductionCounterView, type CounterScope } from "../../src/lib/domain/productionCounterView";
import { productionRange } from "../../src/lib/domain/productionPeriods";
import { loadProductionEvidence, ProductionReadError } from "../../src/lib/repository/supabase/productionEvidence";
import { createFakeEventsDb, type FakeOptions } from "../fixtures/fakeSupabaseEvents";
import { SKU, complete, resetIds, verify } from "../fixtures/item-counting";

const SCOPE: CounterScope = { site: "uk", date: "2026-01-16", staffId: "11111111-1111-4111-8111-111111111111", workType: "unframed" };
const RANGE = productionRange("uk", "2026-01-16", "2026-01-16");

function spiedDb(initial: ProductionEvidenceEvent[], opts: FakeOptions = {}) {
  const db = createFakeEventsDb(initial, { allowRepeatCalls: true, ...opts });
  const calls: string[] = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push(`rpc:${name}`);
      return db.client.rpc(name, args);
    },
    from(table: string) {
      calls.push(`from:${table}`);
      return db.client.from(table);
    },
  };
  return { db, client, calls };
}

async function refreshCounter(client: { rpc(name: string, args: Record<string, unknown>): unknown }, asOfUtc: string) {
  const snapshot = await loadProductionEvidence(client, {
    site: SCOPE.site,
    range: { startUtc: RANGE.startUtc, endUtcExclusive: RANGE.endUtcExclusive },
    asOfUtc,
    visibility: { kind: "site" },
  });
  return buildProductionCounterView(prepareProductionEvidence(snapshot), SCOPE);
}

/** What the page's insertEvent does: the row exists only when the write succeeded. */
function save(db: ReturnType<typeof spiedDb>["db"], row: ProductionEvidenceEvent, ok: boolean): boolean {
  if (!ok) return false;
  db.mutate((rows) => rows.push(row));
  return true;
}

beforeEach(() => resetIds());

describe("Production counter refresh after a saved action", () => {
  it("verify → refresh shows 4 Items; complete → refresh shows 1 Order; reads only", async () => {
    const { db, client, calls } = spiedDb([]);
    expect((await refreshCounter(client, "2026-01-16T09:00:00.000Z")).normal).toEqual({ items: 0, orders: 0 });

    save(db, verify({ line_sku: SKU.unSet2, line_quantity: 2, created_at: "2026-01-16T09:01:00.000Z" }), true);
    expect((await refreshCounter(client, "2026-01-16T09:02:00.000Z")).normal).toEqual({ items: 4, orders: 0 });

    save(db, complete({ created_at: "2026-01-16T09:05:00.000Z" }), true);
    const after = await refreshCounter(client, "2026-01-16T09:06:00.000Z");
    expect(after.normal).toEqual({ items: 4, orders: 1 });

    // Retry / reload of the same scope: identical values, still reads only.
    expect((await refreshCounter(client, "2026-01-16T09:07:00.000Z")).normal).toEqual(after.normal);
    expect(calls.every((c) => c === "rpc:load_production_evidence_v2")).toBe(true);
    expect(calls).toHaveLength(4);
    expect(db.rows).toHaveLength(2);
  });

  it("a failed save adds no evidence and no count", async () => {
    const { db, client } = spiedDb([verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-16T08:00:00.000Z" })]);
    const before = await refreshCounter(client, "2026-01-16T09:00:00.000Z");
    expect(save(db, verify({ line_sku: SKU.unSet2, line_quantity: 2, created_at: "2026-01-16T09:01:00.000Z" }), false)).toBe(false);
    expect((await refreshCounter(client, "2026-01-16T09:02:00.000Z")).normal).toEqual(before.normal);
    expect(db.rows).toHaveLength(1);
  });

  it("a failed KPI read rejects (no zero) while the saved action stays saved", async () => {
    let fail = true;
    const { db, client } = spiedDb([], { beforeResponse: () => (fail ? { error: { message: "network down" } } : undefined) });
    save(db, verify({ line_sku: SKU.unSet2, line_quantity: 2, created_at: "2026-01-16T09:01:00.000Z" }), true);
    await expect(refreshCounter(client, "2026-01-16T09:02:00.000Z")).rejects.toBeInstanceOf(ProductionReadError);
    expect(db.rows).toHaveLength(1);
    fail = false;
    expect((await refreshCounter(client, "2026-01-16T09:03:00.000Z")).normal.items).toBe(4);
  });

  it("the fixed cutoff excludes a save that lands after the refresh started", async () => {
    const { db, client } = spiedDb([]);
    save(db, verify({ line_sku: SKU.unSet2, line_quantity: 2, created_at: "2026-01-16T09:05:00.000Z" }), true);
    expect((await refreshCounter(client, "2026-01-16T09:04:00.000Z")).normal.items).toBe(0);
    expect((await refreshCounter(client, "2026-01-16T09:06:00.000Z")).normal.items).toBe(4);
  });
});
