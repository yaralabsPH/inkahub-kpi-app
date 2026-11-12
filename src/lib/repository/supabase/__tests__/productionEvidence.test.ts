import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  EVIDENCE_RPC,
  instantMicros,
  loadProductionEvidence,
  ProductionReadError,
  productionVisibilityFor,
  type ProductionReadRequest,
} from "../productionEvidence";
import { prepareProductionEvidence, summarizeProduction, type ProductionEvidenceEvent } from "../../../domain/productionCounts";
import { cancel, CASE_1, CASE_2, complete, ev, resetIds, SKU, UK_DAY_1, UK_DAY_2, verify, WORKER_A, WORKER_B } from "../../../../../tests/fixtures/item-counting";
import { createFakeEventsDb, type FakeOptions } from "../../../../../tests/fixtures/fakeSupabaseEvents";

const AS_OF = "2026-01-20T00:00:00.000Z";
const req = (over: Partial<ProductionReadRequest> = {}): ProductionReadRequest => ({
  site: "uk",
  range: UK_DAY_1,
  asOfUtc: AS_OF,
  visibility: { kind: "site" },
  ...over,
});
const ids = (events: readonly ProductionEvidenceEvent[]) => events.map((e) => e.id).sort();
const t = (hhmm: string, day = "2026-01-15") => `${day}T${hhmm}:00.000Z`;
const v1 = (over: Partial<ProductionEvidenceEvent> = {}) =>
  verify({ line_sku: SKU.unSingle, line_quantity: 1, created_at: t("09:00"), ...over });

/** Load with a fake whose envelope is edited before it is returned. */
async function loadEdited(rows: ProductionEvidenceEvent[], edit: (env: Record<string, unknown>) => unknown, over: Partial<ProductionReadRequest> = {}) {
  const db = createFakeEventsDb(rows, { rawResponse: (env) => edit(env ? { ...env, rows: [...(env.rows as unknown[])] } : {}) });
  return loadProductionEvidence(db.client, req(over));
}
const expectKind = (p: Promise<unknown>, kind: string) => expect(p).rejects.toMatchObject({ kind });

beforeEach(() => resetIds());

describe("one RPC call", () => {
  it("calls load_production_evidence once with exactly the four request values", async () => {
    const db = createFakeEventsDb([v1()]);
    await loadProductionEvidence(db.client, req());
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].name).toBe(EVIDENCE_RPC);
    expect(db.calls[0].args).toEqual({
      p_site: "uk", p_start_utc: UK_DAY_1.startUtc, p_end_utc_exclusive: UK_DAY_1.endUtcExclusive, p_as_of_utc: AS_OF,
    });
  });

  it("never reads tables or pages, even for more than 100,000 rows behind a tiny server row cap", async () => {
    const start = Date.parse(UK_DAY_1.startUtc);
    const rows = Array.from({ length: 100_500 }, (_, i) =>
      ev({ id: `r${String(i).padStart(6, "0")}`, event_type: "line_verified", line_sku: SKU.unSingle, line_quantity: 1,
        order_number: `o${i % 997}`, created_at: new Date(start + Math.floor(i / 3) * 500).toISOString() }));
    const db = createFakeEventsDb(rows);
    const snap = await loadProductionEvidence(db.client, req({ pageSize: 1, batchSize: 1 }));
    expect(snap.events).toHaveLength(100_500);
    expect(db.calls).toHaveLength(1);
  });

  it("reads more than 1,000 rows with tied timestamps in (created_at, id) order", async () => {
    const rows = Array.from({ length: 1_200 }, (_, i) => v1({ id: `tie-${String(1199 - i).padStart(4, "0")}`, created_at: t(i < 600 ? "09:00" : "09:01") }));
    const db = createFakeEventsDb(rows);
    const snap = await loadProductionEvidence(db.client, req());
    expect(snap.events).toHaveLength(1_200);
    const order = snap.events.map((e) => `${e.created_at}|${e.id}`);
    expect(order).toEqual([...order].sort());
  });

  it("does not call the RPC for an invalid, pre-aborted or already expired request", async () => {
    const db = createFakeEventsDb([v1()]);
    const aborted = new AbortController();
    aborted.abort();
    await expectKind(loadProductionEvidence(db.client, req({ site: " " })), "failed");
    await expectKind(loadProductionEvidence(db.client, req({ range: { startUtc: UK_DAY_2.startUtc, endUtcExclusive: UK_DAY_1.startUtc } })), "failed");
    await expectKind(loadProductionEvidence(db.client, req({ asOfUtc: "not a time" })), "failed");
    await expectKind(loadProductionEvidence(db.client, req({ pageSize: 0 })), "failed");
    await expectKind(loadProductionEvidence(db.client, req({ signal: aborted.signal })), "aborted");
    await expectKind(loadProductionEvidence(db.client, req({ deadlineMs: 1, now: () => 2 })), "incomplete");
    expect(db.calls).toHaveLength(0);
  });
});

describe("window, site and cutoff", () => {
  it("returns every in-window count event for the site only, and nothing past the cutoff", async () => {
    const inside = verify({ line_sku: SKU.unSet2, line_quantity: 1, created_at: t("09:00") });
    const done = complete({ created_at: t("09:05") });
    const otherSite = verify({ location: "au", line_sku: SKU.unSet2, line_quantity: 1, created_at: t("09:00") });
    const nextDay = verify({ line_sku: SKU.unSet2, line_quantity: 1, created_at: t("09:00", "2026-01-16") });
    const clock = ev({ event_type: "clock_in", order_number: null, created_at: t("07:00") });
    const db = createFakeEventsDb([inside, done, otherSite, nextDay, clock]);
    const snap = await loadProductionEvidence(db.client, req());
    expect(ids(snap.events)).toEqual(ids([inside, done]));
    expect(snap.asOfUtc).toBe(AS_OF);
    expect(snap.range).toEqual(UK_DAY_1);
    expect(Object.isFrozen(snap.events)).toBe(true);
  });

  it("excludes rows created after the cutoff even inside the window", async () => {
    const before = v1({ created_at: t("09:00") });
    const after = v1({ created_at: t("12:00") });
    const db = createFakeEventsDb([before, after]);
    const snap = await loadProductionEvidence(db.client, req({ asOfUtc: t("10:00") }));
    expect(ids(snap.events)).toEqual([before.id]);
  });

  it("keeps microsecond boundaries exact for start, end and cutoff", async () => {
    const range = { startUtc: "2026-01-15T04:00:00.000Z", endUtcExclusive: "2026-01-16T04:00:00.000Z" };
    const atStart = v1({ created_at: "2026-01-15T04:00:00.000000+00:00" });
    const beforeStart = v1({ created_at: "2026-01-15T03:59:59.999999+00:00" });
    const lastInside = v1({ created_at: "2026-01-16T03:59:59.999999+00:00" });
    const atEnd = v1({ created_at: "2026-01-16T04:00:00+00:00" });
    const cutoffRow = v1({ created_at: "2026-01-15T10:00:00.000001+00:00" });
    const db = createFakeEventsDb([atStart, beforeStart, lastInside, atEnd, cutoffRow]);
    const snap = await loadProductionEvidence(db.client, req({ range }));
    expect(ids(snap.events)).toEqual(ids([atStart, lastInside, cutoffRow]));
    const cut = createFakeEventsDb([atStart, cutoffRow]);
    expect(ids((await loadProductionEvidence(cut.client, req({ range, asOfUtc: "2026-01-15T10:00:00.000Z" }))).events)).toEqual([atStart.id]);
  });

  it("returns every identity, parent, case and raw quantity field unchanged", async () => {
    const row = v1({ line_quantity: null, cs_case_id: CASE_1, staff_id: WORKER_B, order_number: `a"b\\c,(d)` });
    const db = createFakeEventsDb([row]);
    const snap = await loadProductionEvidence(db.client, req());
    expect(snap.events[0]).toEqual(row);
    const odd = createFakeEventsDb([v1({ line_quantity: -2 }), v1({ line_quantity: 1.5 })]);
    expect((await loadProductionEvidence(odd.client, req())).events.map((e) => e.line_quantity).sort()).toEqual([-2, 1.5]);
  });

  it("accepts the server echoing request times as an equivalent offset form", async () => {
    const db = createFakeEventsDb([v1()], { echo: (iso) => new Date(Date.parse(iso)).toISOString().replace(".000Z", "+00:00") });
    await expect(loadProductionEvidence(db.client, req())).resolves.toBeTruthy();
  });

  it("a fully authorized empty envelope is a valid empty snapshot", async () => {
    const db = createFakeEventsDb([]);
    const snap = await loadProductionEvidence(db.client, req());
    expect(snap.events).toEqual([]);
    expect(snap.visibility).toEqual({ kind: "site" });
  });
});

describe("context families", () => {
  it("loads before-window qualification lines, before-window parents and after-window corrections", async () => {
    // Order 1001: verified the day before, completed today by B.
    const early = verify({ staff_id: WORKER_A, line_sku: SKU.unSet2, line_quantity: 1, created_at: t("09:00", "2026-01-14") });
    const done = complete({ staff_id: WORKER_B, created_at: t("09:00") });
    // Today's cancellation of yesterday's verification of order 2002.
    const old = verify({ order_number: "2002", line_sku: SKU.unSingle, line_quantity: 1, created_at: t("10:00", "2026-01-14") });
    const undoOld = cancel(old, { created_at: t("10:00") });
    // Today's verification of order 3003, undone tomorrow.
    const today = verify({ order_number: "3003", line_sku: SKU.unSingle, line_quantity: 3, created_at: t("11:00") });
    const undoTomorrow = cancel(today, { staff_id: WORKER_B, created_at: t("09:00", "2026-01-16") });
    // Noise that must not be loaded.
    const unrelatedEarly = verify({ order_number: "9999", line_sku: SKU.unSingle, line_quantity: 1, created_at: t("11:00", "2026-01-14") });
    const unrelatedLaterCancel = cancel(unrelatedEarly, { created_at: t("10:00", "2026-01-16") });
    const db = createFakeEventsDb([early, done, old, undoOld, today, undoTomorrow, unrelatedEarly, unrelatedLaterCancel]);
    const snap = await loadProductionEvidence(db.client, req());
    expect(ids(snap.events)).toEqual(ids([early, done, old, undoOld, today, undoTomorrow]));

    const prepared = prepareProductionEvidence(snap);
    const day = summarizeProduction(prepared, { range: UK_DAY_1 });
    expect(day.normal.orders).toBe(1); // qualified by A's earlier line
    expect(day.normal.items).toBe(0); // 3003 undone tomorrow; 2002 belongs to yesterday
    expect(day.coverage.issueCounts.missing_completion_detail).toBe(0);
    expect(day.coverage.issueCounts.unresolved_parent).toBe(0);
    expect(summarizeProduction(prepared, { range: UK_DAY_1, staffIds: [WORKER_B] }).normal.orders).toBe(1);
  });

  it("keeps distant parents of any type, duplicate terminals and separate CS cases", async () => {
    const distant = complete({ order_number: "4004", created_at: t("09:00", "2025-12-01") });
    const undoDistant = cancel(distant, { created_at: t("08:00") });
    const line = v1({ order_number: "5005", line_sku: SKU.unSet2, created_at: t("09:00") });
    const doneOnce = complete({ order_number: "5005", created_at: t("09:10") });
    const doneAgain = complete({ order_number: "5005", created_at: t("09:11") });
    const reworkA = v1({ order_number: "6006", cs_case_id: CASE_1, created_at: t("10:00") });
    const reworkB = v1({ order_number: "6006", cs_case_id: CASE_2, created_at: t("10:01") });
    const db = createFakeEventsDb([distant, undoDistant, line, doneOnce, doneAgain, reworkA, reworkB]);
    const snap = await loadProductionEvidence(db.client, req());
    expect(ids(snap.events)).toEqual(ids([distant, undoDistant, line, doneOnce, doneAgain, reworkA, reworkB]));
    const day = summarizeProduction(prepareProductionEvidence(snap), { range: UK_DAY_1 });
    expect(day.normal.items).toBe(2); // one UN set of 2
    expect(day.normal.orders).toBe(1); // 5005 once despite two terminals
    expect(day.rework.items).toBe(2); // two separate CS cases
  });

  it("staff get only their own window and context rows, and stay labelled limited", async () => {
    const mine = v1({ staff_id: WORKER_A, created_at: t("09:00") });
    const theirs = v1({ staff_id: WORKER_B, created_at: t("09:01") });
    const theirEarly = verify({ staff_id: WORKER_B, order_number: "7007", line_sku: SKU.unSingle, line_quantity: 1, created_at: t("09:00", "2026-01-14") });
    const myDone = complete({ staff_id: WORKER_A, order_number: "7007", created_at: t("09:30") });
    const visibility = productionVisibilityFor("staff", true);
    const db = createFakeEventsDb([mine, theirs, theirEarly, myDone], { visible: (r) => r.staff_id === WORKER_A });
    const snap = await loadProductionEvidence(db.client, req({ visibility }));
    expect(ids(snap.events)).toEqual(ids([mine, myDone]));
    expect(snap.visibility.kind).toBe("limited");
    const empty = createFakeEventsDb([theirs], { visible: () => false });
    const none = await loadProductionEvidence(empty.client, req({ visibility }));
    expect(none.events).toEqual([]);
    expect(none.visibility.kind).toBe("limited");
  });
});

describe("envelope validation", () => {
  const rows = () => [v1({ id: "a" }), complete({ id: "b", created_at: t("09:05") })];

  it("rejects a missing, null or non-object envelope", async () => {
    await expectKind(loadEdited(rows(), () => null), "incomplete");
    await expectKind(loadEdited(rows(), () => [1, 2]), "incomplete");
    await expectKind(loadEdited(rows(), () => "ok"), "incomplete");
  });

  it("rejects wrong version, completeness, fields and echoed scope", async () => {
    const cases: Array<[string, (e: Record<string, unknown>) => unknown]> = [
      ["version", (e) => ({ ...e, version: 2 })],
      ["complete missing", (e) => { const { complete: _c, ...rest } = e; return rest; }],
      ["complete false", (e) => ({ ...e, complete: false })],
      ["extra field", (e) => ({ ...e, visibility: "site" })],
      ["site", (e) => ({ ...e, site: "au" })],
      ["start", (e) => ({ ...e, startUtc: UK_DAY_2.startUtc })],
      ["end", (e) => ({ ...e, endUtcExclusive: "2026-01-16T04:00:00.000001Z" })],
      ["cutoff", (e) => ({ ...e, asOfUtc: "2026-01-19T00:00:00.000Z" })],
      ["rows not a list", (e) => ({ ...e, rows: {} })],
      ["rowCount type", (e) => ({ ...e, rowCount: "2" })],
      ["truncated rows", (e) => ({ ...e, rows: (e.rows as unknown[]).slice(0, 1) })],
    ];
    for (const [name, edit] of cases) {
      await expect(loadEdited(rows(), edit), name).rejects.toMatchObject({ kind: "incomplete" });
    }
  });

  it("rejects short, long or badly typed tuples", async () => {
    const edits: Array<(r: unknown[]) => unknown> = [
      (r) => r.slice(0, 10),
      (r) => [...r, "extra"],
      (r) => ({ id: r[0] }),
      (r) => Object.assign([...r], { 0: "" }),
      (r) => Object.assign([...r], { 1: null }),
      (r) => Object.assign([...r], { 3: 7 }),
      (r) => Object.assign([...r], { 4: { n: 1 } }),
      (r) => Object.assign([...r], { 6: "1" }),
      (r) => Object.assign([...r], { 7: null }),
      (r) => Object.assign([...r], { 8: "2026-01-15 nine o'clock" }),
      (r) => Object.assign([...r], { 8: "2026-02-30T09:00:00Z" }),
    ];
    for (const [i, edit] of edits.entries()) {
      const p = loadEdited(rows(), (e) => ({ ...e, rows: (e.rows as unknown[][]).map((r, j) => (j === 0 ? edit(r) : r)) }));
      await expect(p, `edit ${i}`).rejects.toMatchObject({ kind: "incomplete" });
    }
  });

  it("rejects another site's row in any family", async () => {
    const early = verify({ order_number: "1001", line_sku: SKU.unSingle, line_quantity: 1, created_at: t("09:00", "2026-01-14") });
    const done = complete({ order_number: "1001", created_at: t("09:00") });
    for (const victim of [0, 1]) {
      const p = loadEdited([early, done], (e) => ({
        ...e, rows: (e.rows as unknown[][]).map((r, j) => (j === victim ? Object.assign([...r], { 1: "au" }) : r)),
      }));
      await expectKind(p, "incomplete");
    }
  });

  it("rejects rows after the cutoff and context unrelated to the window", async () => {
    const late = v1({ id: "late", created_at: t("09:00", "2026-01-21") });
    const stray = verify({ id: "stray", order_number: "9999", line_sku: SKU.unSingle, line_quantity: 1, created_at: t("09:00", "2026-01-14") });
    const strayCancel = ev({ id: "stray-cancel", event_type: "cancelled", parent_event_id: "nothing", created_at: t("09:00", "2026-01-17") });
    const wrongType = ev({ id: "start", event_type: "started", created_at: t("09:30") });
    const tup = (r: ProductionEvidenceEvent) => [r.id, r.location, r.staff_id, r.department, r.order_number, r.line_sku, r.line_quantity, r.event_type, r.created_at, r.parent_event_id, r.cs_case_id];
    for (const extra of [late, stray, strayCancel, wrongType]) {
      const p = loadEdited(rows(), (e) => ({ ...e, rowCount: (e.rowCount as number) + 1, rows: [...(e.rows as unknown[]), tup(extra)] }));
      await expect(p, extra.id).rejects.toMatchObject({ kind: "incomplete" });
    }
    // Inside the window but after a mid-window cutoff: only the cutoff check can catch it.
    const afterCutoff = v1({ id: "after-cutoff", created_at: t("11:00") });
    const p = loadEdited(rows(), (e) => ({ ...e, rowCount: (e.rowCount as number) + 1, rows: [...(e.rows as unknown[]), tup(afterCutoff)] }), { asOfUtc: t("10:00") });
    await expect(p).rejects.toMatchObject({ kind: "incomplete", message: expect.stringContaining("after the cutoff") });
  });

  it("deduplicates identical rows but rejects conflicting payloads for one event as changed", async () => {
    const dup = await loadEdited(rows(), (e) => ({ ...e, rowCount: 3, rows: [...(e.rows as unknown[]), (e.rows as unknown[])[0]] }));
    expect(dup.events).toHaveLength(2);
    const conflict = loadEdited(rows(), (e) => {
      const first = (e.rows as unknown[][])[0];
      return { ...e, rowCount: 3, rows: [...(e.rows as unknown[]), Object.assign([...first], { 6: 9 })] };
    });
    await expectKind(conflict, "changed");
  });
});

describe("failures, abort and deadline", () => {
  it("an RPC error (including a missing function) fails visibly", async () => {
    const db = createFakeEventsDb([v1()], { beforeResponse: () => ({ error: { message: "function public.load_production_evidence does not exist" } }) });
    await expect(loadProductionEvidence(db.client, req())).rejects.toMatchObject({ kind: "failed", message: expect.stringContaining("does not exist") });
  });

  it("a thrown transport or body error fails", async () => {
    const db = createFakeEventsDb([v1()], { beforeResponse: () => { throw new Error("socket hang up"); } });
    await expectKind(loadProductionEvidence(db.client, req()), "failed");
  });

  it("aborting while the call is pending rejects as aborted and aborts the request", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const db = createFakeEventsDb([v1()], { hold });
    const ac = new AbortController();
    const p = loadProductionEvidence(db.client, req({ signal: ac.signal }));
    await Promise.resolve();
    ac.abort();
    await expectKind(p, "aborted");
    expect(db.calls[0].aborted).toBe(true);
    release();
  });

  it("an uncooperative pending client is still cut off by the deadline", async () => {
    const never = { rpc: () => ({ then: () => undefined }) };
    const p = loadProductionEvidence(never, req({ deadlineMs: Date.now() + 20 }));
    await expectKind(p, "incomplete");
  });

  it("a deadline passing during decoding rejects as incomplete", async () => {
    let clock = 0;
    const db = createFakeEventsDb([v1()], { rawResponse: (e) => { clock = 100; return e; } });
    await expectKind(loadProductionEvidence(db.client, req({ deadlineMs: 50, now: () => clock })), "incomplete");
  });
});

describe("one statement snapshot", () => {
  it("a load keeps its snapshot; the next refresh sees later backdated changes; future rows stay out", async () => {
    const a = v1({ id: "a", created_at: t("09:00") });
    const b = v1({ id: "b", created_at: t("09:10") });
    const db = createFakeEventsDb([a, b], {
      allowRepeatCalls: true,
      afterSnapshot: (fake) => {
        if (fake.calls.length !== 1) return;
        fake.mutate((rows) => {
          rows.push(v1({ id: "backdated", created_at: t("08:00") }));
          rows.push(v1({ id: "future", created_at: t("09:00", "2026-01-25") }));
          rows.splice(rows.findIndex((r) => r.id === "b"), 1);
          rows[rows.findIndex((r) => r.id === "a")] = { ...a, line_quantity: 2 };
        });
      },
    });
    const first = await loadProductionEvidence(db.client, req());
    expect(db.calls).toHaveLength(1);
    expect(first.events.map((e) => [e.id, e.line_quantity])).toEqual([["a", 1], ["b", 1]]);
    const next = await loadProductionEvidence(db.client, req());
    expect(next.events.map((e) => [e.id, e.line_quantity])).toEqual([["backdated", 1], ["a", 2]]);
  });
});

describe("helpers, visibility and module boundaries", () => {
  it("parses exact instants with microseconds and offsets", () => {
    expect(instantMicros("2026-01-15T04:00:00Z")).toBe(instantMicros("2026-01-15T14:00:00+10:00"));
    expect(instantMicros("2026-01-15T04:00:00.000001+00:00")! - instantMicros("2026-01-15T04:00:00Z")!).toBe(1n);
    for (const badText of ["2026-01-15", "2026-13-01T00:00:00Z", "2026-01-15T24:00:00Z", "x", 5]) expect(instantMicros(badText)).toBeNull();
  });

  it("only site-wide roles with site membership get full visibility", () => {
    for (const role of ["owner", "manager", "cs", "kiosk"]) expect(productionVisibilityFor(role, true)).toEqual({ kind: "site" });
    expect(productionVisibilityFor("staff", true).kind).toBe("limited");
    expect(productionVisibilityFor(null, true).kind).toBe("limited");
    expect(productionVisibilityFor("owner", false).kind).toBe("limited");
  });

  it("the shared reader never builds a client, reads tables or reads env/browser state", () => {
    const code = (rel: string) =>
      readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const forbidden = /getSupabase|createClient|import\.meta\.env|process\.env|\bwindow\.[A-Za-z_]|localStorage|from "@\//;
    for (const rel of ["../productionEvidence.ts", "../../../domain/productionCounts.ts", "../../../domain/productionItems.ts", "../../../domain/productionPeriods.ts"]) {
      expect(code(rel), rel).not.toMatch(forbidden);
    }
    expect(code("../productionEvidence.ts")).not.toMatch(/\.from\(/);
  });

  it("the error type is exported for callers", () => {
    expect(new ProductionReadError("failed", "x")).toBeInstanceOf(Error);
  });
});

// Keep the type of fake options referenced so the harness contract stays checked.
export type _FakeOptions = FakeOptions;
