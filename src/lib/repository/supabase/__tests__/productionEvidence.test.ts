import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadProductionEvidence,
  ProductionReadError,
  productionVisibilityFor,
  quotePostgrestValue,
  type ProductionReadRequest,
} from "../productionEvidence";
import { prepareProductionEvidence, summarizeProduction, type ProductionEvidenceEvent } from "../../../domain/productionCounts";
import { cancel, complete, ev, resetIds, SKU, UK_DAY_1, UK_DAY_2, verify, WORKER_A, WORKER_B } from "../../../../../tests/fixtures/item-counting";
import { createFakeEventsDb } from "../../../../../tests/fixtures/fakeSupabaseEvents";

const AS_OF = "2026-01-20T00:00:00.000Z";
const req = (over: Partial<ProductionReadRequest> = {}): ProductionReadRequest => ({
  site: "uk",
  range: UK_DAY_1,
  asOfUtc: AS_OF,
  visibility: { kind: "site" },
  ...over,
});
const ids = (events: readonly ProductionEvidenceEvent[]) => events.map((e) => e.id).sort();

beforeEach(() => resetIds());

describe("window, site and cutoff", () => {
  it("reads every in-window count event for the site only, and nothing past the cutoff", async () => {
    const inside = verify({ line_sku: SKU.unSet2, line_quantity: 1, created_at: "2026-01-15T09:00:00.000Z" });
    const done = complete({ created_at: "2026-01-15T09:05:00.000Z" });
    const otherSite = verify({ location: "au", line_sku: SKU.unSet2, line_quantity: 1, created_at: "2026-01-15T09:00:00.000Z" });
    const nextDay = verify({ line_sku: SKU.unSet2, line_quantity: 1, created_at: "2026-01-16T09:00:00.000Z" });
    const clock = ev({ event_type: "clock_in", order_number: null, created_at: "2026-01-15T07:00:00.000Z" });
    const db = createFakeEventsDb([inside, done, otherSite, nextDay, clock]);
    const snap = await loadProductionEvidence(db.client, req());
    expect(ids(snap.events)).toEqual(ids([inside, done]));
    for (const c of db.calls) {
      expect(c.filters).toContain("location=eq.uk");
      expect(c.filters).toContain(`created_at=lte.${AS_OF}`);
    }
    expect(snap.asOfUtc).toBe(AS_OF);
    expect(snap.range).toEqual(UK_DAY_1);
  });

  it("excludes rows created after the cutoff even inside the window", async () => {
    const before = verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-15T09:00:00.000Z" });
    const after = verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-15T12:00:00.000Z" });
    const db = createFakeEventsDb([before, after]);
    const snap = await loadProductionEvidence(db.client, req({ asOfUtc: "2026-01-15T10:00:00.000Z" }));
    expect(ids(snap.events)).toEqual([before.id]);
  });

  it("selects every identity, parent, case and raw quantity column", async () => {
    const db = createFakeEventsDb([verify({ line_sku: SKU.unSingle, line_quantity: null, created_at: "2026-01-15T09:00:00.000Z" })]);
    const snap = await loadProductionEvidence(db.client, req());
    for (const col of ["id", "location", "staff_id", "department", "order_number", "line_sku", "line_quantity", "event_type", "created_at", "parent_event_id", "cs_case_id"]) {
      expect(db.calls[0].columns).toContain(col);
    }
    expect(snap.events[0].line_quantity).toBeNull();
  });

  it("rejects a row from another site (RLS or filter failure) instead of mixing sites", async () => {
    const db = createFakeEventsDb([verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-15T09:00:00.000Z" })]);
    const leaky = {
      from: (t: string) => {
        const real = db.client.from(t);
        return {
          select: (c: string) => {
            const q = real.select(c) as { eq: (col: string, v: string) => unknown };
            const origEq = q.eq.bind(q);
            q.eq = (col: string, v: string) => (col === "location" ? q : origEq(col, v));
            return q;
          },
        };
      },
    };
    db.mutate((rows) => rows.push(verify({ location: "au", line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-15T09:01:00.000Z" })));
    await expect(loadProductionEvidence(leaky, req())).rejects.toMatchObject({ kind: "incomplete" });
  });
});

describe("pagination", () => {
  it("keeps paging past a small server cap until an empty page", async () => {
    const events = Array.from({ length: 23 }, (_, i) =>
      verify({ line_sku: SKU.unSingle, line_quantity: 1, order_number: `o${i}`, created_at: `2026-01-15T10:${String(i).padStart(2, "0")}:00.000Z` }),
    );
    const db = createFakeEventsDb(events, { serverCap: 4 });
    const snap = await loadProductionEvidence(db.client, req({ pageSize: 500 }));
    expect(snap.events).toHaveLength(23);
  });

  it("handles tied timestamps across page boundaries without skipping or repeating", async () => {
    const t = "2026-01-15T10:00:00.000Z";
    const events = Array.from({ length: 17 }, (_, i) =>
      verify({ id: `tie-${String(i).padStart(2, "0")}`, line_sku: SKU.unSingle, line_quantity: 1, order_number: `o${i}`, created_at: t }),
    );
    const db = createFakeEventsDb(events, { serverCap: 3 });
    const snap = await loadProductionEvidence(db.client, req({ pageSize: 3 }));
    expect(ids(snap.events)).toEqual(ids(events));
  });

  it("escapes punctuation in ids and order numbers", async () => {
    const odd = verify({ id: 'a,b"c\\d)', order_number: '#10,01 "x"', line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-15T10:00:00.000Z" });
    const odd2 = verify({ id: 'a,b"c\\d)z', order_number: '#10,01 "x"', line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-15T10:00:00.000Z" });
    const t = complete({ order_number: '#10,01 "x"', created_at: "2026-01-15T10:05:00.000Z" });
    const early = verify({ order_number: '#10,01 "x"', line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-14T10:00:00.000Z" });
    const db = createFakeEventsDb([odd, odd2, t, early], { serverCap: 1 });
    const snap = await loadProductionEvidence(db.client, req({ pageSize: 1 }));
    expect(ids(snap.events)).toEqual(ids([odd, odd2, t, early]));
    expect(quotePostgrestValue('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it("reads more than 1,000 rows", async () => {
    const events = Array.from({ length: 1_234 }, (_, i) =>
      verify({ line_sku: SKU.unSingle, line_quantity: 1, order_number: `o${i}`, created_at: new Date(Date.parse("2026-01-15T05:00:00Z") + i * 1000).toISOString() }),
    );
    const db = createFakeEventsDb(events, { serverCap: 1000 });
    const snap = await loadProductionEvidence(db.client, req());
    expect(snap.events).toHaveLength(1_234);
  });

  it("reads more than 100,000 rows (no 100-page ceiling)", async () => {
    const start = Date.parse("2026-01-15T04:00:00Z");
    const events: ProductionEvidenceEvent[] = new Array(100_500);
    for (let i = 0; i < events.length; i++) {
      events[i] = {
        id: `bulk-${String(i).padStart(6, "0")}`,
        location: "uk",
        staff_id: i % 2 ? WORKER_A : WORKER_B,
        department: "unframed",
        order_number: `b${i}`,
        line_sku: SKU.unSingle,
        line_quantity: 1,
        event_type: "line_verified",
        created_at: new Date(start + Math.floor(i / 3) * 1000).toISOString(),
        parent_event_id: null,
        cs_case_id: null,
      };
    }
    const db = createFakeEventsDb(events, { serverCap: 1000 });
    const snap = await loadProductionEvidence(db.client, req({ range: { startUtc: UK_DAY_1.startUtc, endUtcExclusive: UK_DAY_2.endUtcExclusive } }));
    expect(snap.events).toHaveLength(100_500);
    const summary = summarizeProduction(prepareProductionEvidence(snap), { range: { startUtc: UK_DAY_1.startUtc, endUtcExclusive: UK_DAY_2.endUtcExclusive } });
    expect(summary.normal.items).toBe(100_500);
  }, 60_000);

  it("rejects a cursor that does not advance (server ignores ordering)", async () => {
    const events = Array.from({ length: 6 }, (_, i) =>
      verify({ line_sku: SKU.unSingle, line_quantity: 1, order_number: `o${i}`, created_at: `2026-01-15T10:0${i}:00.000Z` }),
    );
    const db = createFakeEventsDb(events, { serverCap: 2, honorOrder: false });
    await expect(loadProductionEvidence(db.client, req())).rejects.toMatchObject({ kind: "incomplete" });
  });
});

describe("context", () => {
  it("loads before-window qualification lines, before-window parents and after-window corrections", async () => {
    // Order 1001: verified the day before, completed today by B.
    const early = verify({ staff_id: WORKER_A, line_sku: SKU.unSet2, line_quantity: 1, created_at: "2026-01-14T09:00:00.000Z" });
    const done = complete({ staff_id: WORKER_B, created_at: "2026-01-15T09:00:00.000Z" });
    // Today's cancellation of yesterday's verification of order 2002.
    const old = verify({ order_number: "2002", line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-14T10:00:00.000Z" });
    const undoOld = cancel(old, { created_at: "2026-01-15T10:00:00.000Z" });
    // Today's verification of order 3003, undone tomorrow.
    const today = verify({ order_number: "3003", line_sku: SKU.unSingle, line_quantity: 3, created_at: "2026-01-15T11:00:00.000Z" });
    const undoTomorrow = cancel(today, { staff_id: WORKER_B, created_at: "2026-01-16T09:00:00.000Z" });
    // Noise that must not be loaded.
    const unrelatedEarly = verify({ order_number: "9999", line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-14T11:00:00.000Z" });
    const unrelatedLaterCancel = cancel(unrelatedEarly, { created_at: "2026-01-16T10:00:00.000Z" });
    const db = createFakeEventsDb([early, done, old, undoOld, today, undoTomorrow, unrelatedEarly, unrelatedLaterCancel], { serverCap: 2 });
    const snap = await loadProductionEvidence(db.client, req({ batchSize: 1 }));
    expect(ids(snap.events)).toEqual(ids([early, done, old, undoOld, today, undoTomorrow]));

    const prepared = prepareProductionEvidence(snap);
    const day = summarizeProduction(prepared, { range: UK_DAY_1 });
    expect(day.normal.orders).toBe(1); // qualified by A's earlier line
    expect(day.normal.items).toBe(0); // 3003 undone tomorrow; 2002 belongs to yesterday
    expect(day.coverage.issueCounts.missing_completion_detail).toBe(0);
    expect(day.coverage.issueCounts.unresolved_parent).toBe(0);
    // A person filter applied after loading still sees B's correction of A... and the order is B's.
    expect(summarizeProduction(prepared, { range: UK_DAY_1, staffIds: [WORKER_B] }).normal.orders).toBe(1);
  });

  it("batches context requests", async () => {
    const events: ProductionEvidenceEvent[] = [];
    for (let i = 0; i < 250; i++) {
      events.push(complete({ order_number: `o${i}`, created_at: new Date(Date.parse("2026-01-15T05:00:00Z") + i * 60_000).toISOString() }));
    }
    const db = createFakeEventsDb(events);
    await loadProductionEvidence(db.client, req());
    const contextCalls = db.calls.filter((c) => c.filters.some((f) => f.startsWith("order_number=in.")));
    // 250 orders / 100 per batch = 3 batches per pass, two passes.
    expect(contextCalls).toHaveLength(6);
  });
});

describe("failures and consistency", () => {
  it("a failed later page rejects rather than returning partial data", async () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      verify({ line_sku: SKU.unSingle, line_quantity: 1, order_number: `o${i}`, created_at: `2026-01-15T10:0${i}:00.000Z` }),
    );
    const db = createFakeEventsDb(events, { serverCap: 2, beforeResponse: ({ call }) => (call === 2 ? { error: { message: "boom" } } : undefined) });
    await expect(loadProductionEvidence(db.client, req())).rejects.toMatchObject({ kind: "failed" });
  });

  it("a denied context read (RLS error on the context query) rejects", async () => {
    const db = createFakeEventsDb([complete({ created_at: "2026-01-15T09:00:00.000Z" })], {
      beforeResponse: ({ filters }) => (filters.some((f) => f.startsWith("order_number=in.")) ? { error: { message: "permission denied" } } : undefined),
    });
    await expect(loadProductionEvidence(db.client, req())).rejects.toMatchObject({ kind: "failed" });
  });

  it("thrown transport errors reject as failed", async () => {
    const db = createFakeEventsDb([], { beforeResponse: () => { throw new Error("network"); } });
    await expect(loadProductionEvidence(db.client, req())).rejects.toMatchObject({ kind: "failed" });
  });

  it("empty authorized evidence is a valid empty snapshot", async () => {
    const db = createFakeEventsDb([]);
    const snap = await loadProductionEvidence(db.client, req());
    expect(snap.events).toEqual([]);
    expect(snap.visibility).toEqual({ kind: "site" });
  });

  it("future inserts after the cutoff do not change the result", async () => {
    const v = verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-15T09:00:00.000Z" });
    let inserted = false;
    const db = createFakeEventsDb([v], {
      beforeResponse: () => {
        if (inserted) return;
        inserted = true;
        db.mutate((rows) => rows.push(verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-21T09:00:00.000Z" })));
      },
    });
    const snap = await loadProductionEvidence(db.client, req());
    expect(ids(snap.events)).toEqual([v.id]);
  });

  it("a backdated insert during the read is detected and the load retried once", async () => {
    const v = verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-15T09:00:00.000Z" });
    let calls = 0;
    const db = createFakeEventsDb([v], {
      beforeResponse: () => {
        calls++;
        if (calls === 3) db.mutate((rows) => rows.push(verify({ id: "backdated", line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-15T08:00:00.000Z" })));
      },
    });
    const snap = await loadProductionEvidence(db.client, req());
    expect(ids(snap.events)).toEqual(["backdated", v.id].sort());
  });

  it("data that keeps changing is reported as changed", async () => {
    let n = 0;
    const db = createFakeEventsDb([], {
      beforeResponse: ({ filters }) => {
        if (filters.some((f) => f.startsWith("or="))) return; // only on a query's first page, so paging ends
        n++;
        db.mutate((rows) => rows.push(verify({ id: `churn-${String(n).padStart(3, "0")}`, line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-15T08:00:00.000Z" })));
      },
    });
    await expect(loadProductionEvidence(db.client, req())).rejects.toMatchObject({ kind: "changed" });
  });

  it("a backdated delete or edit during the read is detected", async () => {
    const v = verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-15T09:00:00.000Z" });
    const w = verify({ order_number: "2", line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-15T09:30:00.000Z" });
    let calls = 0;
    const db = createFakeEventsDb([v, w], {
      beforeResponse: () => {
        calls++;
        if (calls === 4) db.mutate((rows) => { rows.find((r) => r.id === w.id)!.line_quantity = 5; });
      },
    });
    const snap = await loadProductionEvidence(db.client, req());
    // The retried, stable read carries the edited value.
    expect(snap.events.find((e) => e.id === w.id)?.line_quantity).toBe(5);
  });

  it("an aborted read rejects as aborted", async () => {
    const controller = new AbortController();
    const db = createFakeEventsDb([verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-15T09:00:00.000Z" })], {
      beforeResponse: () => controller.abort(),
    });
    await expect(loadProductionEvidence(db.client, req({ signal: controller.signal }))).rejects.toMatchObject({ kind: "aborted" });
  });

  it("a deadline rejects as incomplete", async () => {
    let t = 0;
    const db = createFakeEventsDb([verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: "2026-01-15T09:00:00.000Z" })]);
    await expect(loadProductionEvidence(db.client, req({ now: () => (t += 1000), deadlineMs: 1500 }))).rejects.toMatchObject({ kind: "incomplete" });
  });

  it("invalid requests are rejected before any read", async () => {
    const db = createFakeEventsDb([]);
    await expect(loadProductionEvidence(db.client, req({ site: "" }))).rejects.toBeInstanceOf(ProductionReadError);
    await expect(loadProductionEvidence(db.client, req({ asOfUtc: "nope" }))).rejects.toBeInstanceOf(ProductionReadError);
    await expect(loadProductionEvidence(db.client, req({ range: { startUtc: UK_DAY_2.startUtc, endUtcExclusive: UK_DAY_1.startUtc } }))).rejects.toBeInstanceOf(ProductionReadError);
    expect(db.calls).toHaveLength(0);
  });
});

describe("visibility and module boundaries", () => {
  it("only site-wide roles with site membership get full visibility", () => {
    for (const role of ["owner", "manager", "cs", "kiosk"]) expect(productionVisibilityFor(role, true)).toEqual({ kind: "site" });
    expect(productionVisibilityFor("staff", true).kind).toBe("limited");
    expect(productionVisibilityFor(null, true).kind).toBe("limited");
    expect(productionVisibilityFor("owner", false).kind).toBe("limited");
  });

  it("the shared reader never builds a client or reads env/browser state", () => {
    const code = (rel: string) =>
      readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const forbidden = /getSupabase|createClient|import\.meta\.env|process\.env|\bwindow\.[A-Za-z_]|localStorage|from "@\//;
    for (const rel of ["../productionEvidence.ts", "../../../domain/productionCounts.ts", "../../../domain/productionItems.ts", "../../../domain/productionPeriods.ts"]) {
      expect(code(rel), rel).not.toMatch(forbidden);
    }
  });
});
