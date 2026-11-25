import { beforeEach, describe, expect, it } from "vitest";
import { EVIDENCE_RPC, ProductionReadError, type ProductionReadRequest } from "@/lib/repository/supabase/productionEvidence";
import type { ProductionEvidenceEvent } from "@/lib/domain/productionCounts";
import { productionRange } from "@/lib/domain/productionPeriods";
import { loadScannerWallEvidence, WALL_MAX_ROWS } from "../wallTotalsClient";
import { ev, resetIds, SKU, UK_DAY_1, verify } from "../../../../tests/fixtures/item-counting";
import { createFakeEventsDb } from "../../../../tests/fixtures/fakeSupabaseEvents";

const AS_OF = "2026-01-20T00:00:00.000Z";
const req = (over: Partial<ProductionReadRequest> = {}): ProductionReadRequest => ({
  site: "uk", range: UK_DAY_1, asOfUtc: AS_OF, visibility: { kind: "site" }, ...over,
});
const many = (n: number): ProductionEvidenceEvent[] => {
  const start = Date.parse(UK_DAY_1.startUtc);
  return Array.from({ length: n }, (_, i) => ev({
    id: `r${String(i).padStart(6, "0")}`, event_type: "line_verified", line_sku: SKU.framedSingle, line_quantity: 1,
    department: "framed", order_number: `o${i % 500}`, created_at: new Date(start + i * 1000).toISOString(),
  }));
};

beforeEach(() => resetIds());

describe("loadScannerWallEvidence", () => {
  it("makes one call to the existing evidence RPC with the site day and cutoff, on the caller's client", async () => {
    const db = createFakeEventsDb([verify({ line_sku: SKU.framedSingle, line_quantity: 1, department: "framed", created_at: "2026-01-15T09:00:00.000Z" })]);
    const snap = await loadScannerWallEvidence(db.client, req());
    expect(db.calls).toEqual([{ name: EVIDENCE_RPC, args: {
      p_site: "uk", p_start_utc: UK_DAY_1.startUtc, p_end_utc_exclusive: UK_DAY_1.endUtcExclusive, p_as_of_utc: AS_OF,
    } }].map((c) => expect.objectContaining(c)));
    expect(snap.events).toHaveLength(1);
    expect(snap.range).toEqual(UK_DAY_1);
  });

  it("a complete empty day is a snapshot with no events, not a failure", async () => {
    const snap = await loadScannerWallEvidence(createFakeEventsDb([]).client, req());
    expect(snap.events).toEqual([]);
  });

  it(`allows ${WALL_MAX_ROWS} rows and refuses ${WALL_MAX_ROWS + 1}, even when rowCount lies`, async () => {
    const ok = await loadScannerWallEvidence(createFakeEventsDb(many(WALL_MAX_ROWS)).client, req());
    expect(ok.events).toHaveLength(WALL_MAX_ROWS);
    await expect(loadScannerWallEvidence(createFakeEventsDb(many(WALL_MAX_ROWS + 1)).client, req()))
      .rejects.toMatchObject({ kind: "incomplete" });
    const lying = createFakeEventsDb(many(WALL_MAX_ROWS + 1), { rawResponse: (env) => ({ ...env, rowCount: 3 }) });
    await expect(loadScannerWallEvidence(lying.client, req())).rejects.toBeInstanceOf(ProductionReadError);
  });

  it("invalid or incomplete envelopes are refused by the existing strict decoder", async () => {
    const db = createFakeEventsDb([], { rawResponse: () => ({ nope: true }) });
    await expect(loadScannerWallEvidence(db.client, req())).rejects.toBeInstanceOf(ProductionReadError);
  });

  it("timeout and abort are reported, never a partial result", async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(loadScannerWallEvidence(createFakeEventsDb([]).client, req({ signal: aborted.signal }))).rejects.toMatchObject({ kind: "aborted" });
    await expect(loadScannerWallEvidence(createFakeEventsDb([]).client, req({ deadlineMs: 1, now: () => 2 }))).rejects.toMatchObject({ kind: "incomplete" });
  });

  it("the site day runs 04:00 to 04:00 local, across a daylight-saving change", () => {
    // Sydney clocks go forward at 02:00 on 4 Oct 2026, inside the production day of 3 Oct.
    const au = productionRange("au", "2026-10-03", "2026-10-03");
    expect(au.startUtc).toBe("2026-10-02T18:00:00.000Z"); // 04:00 AEST
    expect(au.endUtcExclusive).toBe("2026-10-03T17:00:00.000Z"); // 04:00 AEDT next morning: a 23-hour day
  });
});
