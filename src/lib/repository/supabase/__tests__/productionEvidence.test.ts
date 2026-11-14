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
    expect(EVIDENCE_RPC).toBe("load_production_evidence_v2");
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

describe("envelope v2 validation", () => {
  const rows = () => [
    v1({ id: "a", staff_id: WORKER_A }),
    complete({ id: "b", staff_id: WORKER_B, created_at: t("09:05") }),
  ];
  type Env = Record<string, unknown> & { rows: unknown[][]; staffIds: unknown[]; skus: unknown[] };
  const editEnv = (edit: (e: Env) => unknown) => (e: Record<string, unknown>) => edit(e as Env);
  const editRow0 = (fn: (r: unknown[]) => unknown) => editEnv((e) => ({ ...e, rows: e.rows.map((r, j) => (j === 0 ? fn(r) : r)) }));
  const slot = (i: number, v: unknown) => editRow0((r) => Object.assign([...r], { [i]: v }));

  it("rejects a missing, null or non-object envelope", async () => {
    await expectKind(loadEdited(rows(), () => null), "incomplete");
    await expectKind(loadEdited(rows(), () => [1, 2]), "incomplete");
    await expectKind(loadEdited(rows(), () => "ok"), "incomplete");
  });

  it("rejects v1/unknown versions, missing or extra keys, completeness and wrong echoed scope", async () => {
    const cases: Array<[string, (e: Env) => unknown]> = [
      ["v1", (e) => ({ ...e, version: 1 })],
      ["v3", (e) => ({ ...e, version: 3 })],
      ["complete missing", (e) => { const { complete: _c, ...rest } = e; return rest; }],
      ["staffIds missing", (e) => { const { staffIds: _s, ...rest } = e; return rest; }],
      ["skus missing", (e) => { const { skus: _s, ...rest } = e; return rest; }],
      ["complete false", (e) => ({ ...e, complete: false })],
      ["extra field", (e) => ({ ...e, visibility: "site" })],
      ["site", (e) => ({ ...e, site: "au" })],
      ["start", (e) => ({ ...e, startUtc: UK_DAY_2.startUtc })],
      ["end", (e) => ({ ...e, endUtcExclusive: "2026-01-16T04:00:00.000001Z" })],
      ["cutoff", (e) => ({ ...e, asOfUtc: "2026-01-19T00:00:00.000Z" })],
      ["rows not a list", (e) => ({ ...e, rows: {} })],
      ["rowCount type", (e) => ({ ...e, rowCount: "2" })],
      ["rowCount unsafe", (e) => ({ ...e, rowCount: 2 ** 53 })],
      ["truncated rows", (e) => ({ ...e, rows: e.rows.slice(0, 1) })],
    ];
    for (const [name, edit] of cases) {
      await expect(loadEdited(rows(), editEnv(edit)), name).rejects.toMatchObject({ kind: "incomplete" });
    }
  });

  it("rejects malformed, duplicate or unused dictionary entries", async () => {
    const cases: Array<[string, (e: Env) => unknown]> = [
      ["staffIds not a list", (e) => ({ ...e, staffIds: "x" })],
      ["staff entry not text", (e) => ({ ...e, staffIds: [...e.staffIds.slice(0, -1), 7] })],
      ["sku entry null", (e) => ({ ...e, skus: [null] })],
      ["duplicate staff entry", (e) => ({ ...e, staffIds: [...e.staffIds, e.staffIds[0]] })],
      ["unused staff entry", (e) => ({ ...e, staffIds: [...e.staffIds, "33333333-3333-4333-8333-333333333333"] })],
      ["unused sku entry", (e) => ({ ...e, skus: [...e.skus, "INKA-UNUSED"] })],
      ["entries on an empty result", (e) => ({ ...e, rowCount: 0, rows: [] })],
      // Both copies used, so only the uniqueness rule can catch it.
      ["duplicate staff entry, both used", (e) => {
        const a = e.staffIds[e.rows[0][1] as number];
        return { ...e, staffIds: [a, a], rows: e.rows.map((r, j) => Object.assign([...r], { 1: j === 0 ? 0 : 1 })) };
      }],
    ];
    for (const [name, edit] of cases) {
      await expect(loadEdited(rows(), editEnv(edit)), name).rejects.toMatchObject({ kind: "incomplete" });
    }
  });

  it("rejects bad dictionary indexes: text, boolean, fraction, negative, out of range, unsafe", async () => {
    for (const [i, bad] of ["0", true, 0.5, -1, 99, 2 ** 53].entries()) {
      await expect(loadEdited(rows(), slot(1, bad)), `staff index ${i}`).rejects.toMatchObject({ kind: "incomplete" });
      await expect(loadEdited(rows(), slot(4, bad)), `sku index ${i}`).rejects.toMatchObject({ kind: "incomplete" });
    }
  });

  it("rejects ten-slot violations and badly typed slots", async () => {
    const edits: Array<(e: Record<string, unknown>) => unknown> = [
      editRow0((r) => r.slice(0, 9)),
      editRow0((r) => [...r, "extra"]),
      editRow0((r) => ({ id: r[0] })),
      slot(0, ""),
      slot(2, 7),
      slot(3, { n: 1 }),
      slot(5, "1"),
      slot(6, null),
      slot(7, "2026-01-15 nine o'clock"),
      slot(7, "2026-02-30T09:00:00Z"),
      slot(7, "2026-01-15T09:00:00.1234567Z"),
      slot(8, 5),
      slot(9, false),
    ];
    for (const [i, edit] of edits.entries()) {
      await expect(loadEdited(rows(), edit), `edit ${i}`).rejects.toMatchObject({ kind: "incomplete" });
    }
  });

  it("rejects rows after the cutoff and context unrelated to the window", async () => {
    const late = v1({ id: "late", created_at: t("09:00", "2026-01-21") });
    const stray = verify({ id: "stray", order_number: "9999", line_sku: SKU.unSingle, line_quantity: 1, created_at: t("09:00", "2026-01-14") });
    const strayCancel = ev({ id: "stray-cancel", event_type: "cancelled", parent_event_id: "nothing", created_at: t("09:00", "2026-01-17") });
    const wrongType = ev({ id: "start", event_type: "started", created_at: t("09:30") });
    // A v2 tuple reusing row 0's staff/SKU indexes, so only the time/family checks can catch it.
    const tup = (r: ProductionEvidenceEvent, base: unknown[]) =>
      [r.id, base[1], r.department, r.order_number, base[4], r.line_quantity, r.event_type, r.created_at, r.parent_event_id, r.cs_case_id];
    for (const extra of [late, stray, strayCancel, wrongType]) {
      const p = loadEdited(rows(), editEnv((e) => ({ ...e, rowCount: e.rows.length + 1, rows: [...e.rows, tup(extra, e.rows.find((x) => x[0] === "a")!)] })));
      await expect(p, extra.id).rejects.toMatchObject({ kind: "incomplete" });
    }
    const afterCutoff = v1({ id: "after-cutoff", created_at: t("11:00") });
    const p = loadEdited(rows(), editEnv((e) => ({ ...e, rowCount: e.rows.length + 1, rows: [...e.rows, tup(afterCutoff, e.rows.find((x) => x[0] === "a")!)] })), { asOfUtc: t("10:00") });
    await expect(p).rejects.toMatchObject({ kind: "incomplete", message: expect.stringContaining("after the cutoff") });
  });

  it("deduplicates identical rows but rejects conflicting payloads for one event as changed", async () => {
    const dup = await loadEdited(rows(), editEnv((e) => ({ ...e, rowCount: 3, rows: [...e.rows, e.rows[0]] })));
    expect(dup.events).toHaveLength(2);
    const conflict = loadEdited(rows(), editEnv((e) => ({ ...e, rowCount: 3, rows: [...e.rows, Object.assign([...e.rows[0]], { 5: 9 })] })));
    await expectKind(conflict, "changed");
    const sameInstant = loadEdited(rows(), editEnv((e) => {
      const r0 = e.rows[0];
      const iso = String(r0[7]);
      return { ...e, rowCount: 3, rows: [...e.rows, Object.assign([...r0], { 7: iso.replace(".000Z", "+00:00") })] };
    }));
    expect((await sameInstant).events).toHaveLength(2);
  });
});

describe("encoding v2 decoding and exactness", () => {
  it("decodes indexes back to the saved values, including index 0, the last index, reuse and empty strings", async () => {
    const staff = [WORKER_A, WORKER_B, "33333333-3333-4333-8333-333333333333"];
    const events = [
      v1({ id: "r1", staff_id: staff[0], line_sku: "" }),
      v1({ id: "r2", staff_id: staff[1], line_sku: SKU.unSet2, created_at: t("09:01") }),
      v1({ id: "r3", staff_id: staff[2], line_sku: SKU.unSet2, created_at: t("09:02") }),
      v1({ id: "r4", staff_id: staff[0], line_sku: null, created_at: t("09:03"), department: "" }),
      ev({ id: "r5", event_type: "line_verified", staff_id: null, line_sku: null, created_at: t("09:04") }),
    ];
    for (const order of ["reverse", "asis"] as const) {
      const db = createFakeEventsDb(events, { order });
      const snap = await loadProductionEvidence(db.client, req());
      expect(snap.events).toEqual(events);
    }
  });

  it("decodes the same evidence from shuffled dictionaries with remapped indexes", async () => {
    const events = [v1({ id: "a", staff_id: WORKER_A, line_sku: SKU.unSingle }), v1({ id: "b", staff_id: WORKER_B, line_sku: SKU.unSet2, created_at: t("09:01") })];
    const swap = editEnvAll((e) => {
      const rows = (e.rows as unknown[][]).map((r) => Object.assign([...r], {
        1: r[1] === null ? null : 1 - (r[1] as number),
        4: r[4] === null ? null : 1 - (r[4] as number),
      }));
      return { ...e, staffIds: [...(e.staffIds as unknown[])].reverse(), skus: [...(e.skus as unknown[])].reverse(), rows };
    });
    expect((await loadEdited(events, swap)).events).toEqual(events);
  });

  it("accepts all-null dictionaries and an empty result", async () => {
    const nulls = [ev({ id: "n1", event_type: "line_verified", staff_id: null, line_sku: null, created_at: t("09:00") })];
    const db = createFakeEventsDb(nulls);
    expect((await loadProductionEvidence(db.client, req())).events).toEqual(nulls);
    const empty = createFakeEventsDb([]);
    expect((await loadProductionEvidence(empty.client, req())).events).toEqual([]);
  });

  it("sorts once by exact instant, then id, whatever order the server sends", async () => {
    // Reversed ids one microsecond apart: time wins over id.
    const later = v1({ id: "a", created_at: "2026-01-15T09:00:00.000002+00:00" });
    const earlier = v1({ id: "z", created_at: "2026-01-15T09:00:00.000001+00:00" });
    // Same instant written two ways: id breaks the tie.
    const tieB = v1({ id: "b", created_at: "2026-01-15T10:00:00Z" });
    const tieA = v1({ id: "a2", created_at: "2026-01-15T20:00:00+10:00" });
    for (const order of ["reverse", "asis"] as const) {
      const db = createFakeEventsDb([later, earlier, tieB, tieA], { order });
      expect((await loadProductionEvidence(db.client, req())).events.map((e) => e.id)).toEqual(["z", "a", "a2", "b"]);
    }
  });

  it("keeps start, end and cutoff exact to the microsecond on both sides, including non-zero request microseconds", async () => {
    const range = { startUtc: "2026-01-15T04:00:00.000500Z", endUtcExclusive: "2026-01-16T04:00:00.000500Z" };
    const asOfUtc = "2026-01-16T04:00:00.000500Z";
    const mk = (id: string, at: string) => v1({ id, created_at: at });
    const rows = [
      mk("start-1", "2026-01-15T04:00:00.000499+00:00"), mk("start", "2026-01-15T04:00:00.0005Z"), mk("start+1", "2026-01-15T14:00:00.000501+10:00"),
      mk("end-1", "2026-01-16T04:00:00.000499Z"), mk("end", "2026-01-16T04:00:00.000500Z"), mk("end+1", "2026-01-16T04:00:00.000501Z"),
    ];
    const db = createFakeEventsDb(rows);
    const snap = await loadProductionEvidence(db.client, req({ range, asOfUtc }));
    expect(ids(snap.events)).toEqual(["end-1", "start", "start+1"].sort());
    const cut = createFakeEventsDb(rows);
    const snap2 = await loadProductionEvidence(cut.client, req({ range, asOfUtc: "2026-01-15T14:00:00.000501+10:00" }));
    expect(ids(snap2.events)).toEqual(["start", "start+1"].sort());
  });

  it("every decoded row takes its site from the envelope; the fake never leaks another site's rows or dictionary entries", async () => {
    const mine = v1({ id: "uk1", staff_id: WORKER_A, line_sku: SKU.unSingle });
    const other = v1({ id: "au1", location: "au", staff_id: WORKER_B, line_sku: SKU.unSet2 });
    const otherEarly = verify({ id: "au0", location: "au", order_number: "1001", staff_id: WORKER_B, line_sku: SKU.fnSet3, line_quantity: 1, created_at: t("09:00", "2026-01-14") });
    const done = complete({ id: "uk2", order_number: "1001", staff_id: WORKER_A, created_at: t("09:30") });
    let seen: Record<string, unknown> | null = null;
    const db = createFakeEventsDb([mine, other, otherEarly, done], { rawResponse: (e) => (seen = e) });
    const snap = await loadProductionEvidence(db.client, req());
    expect(snap.events.every((e) => e.location === "uk")).toBe(true);
    expect(ids(snap.events)).toEqual(["uk1", "uk2"]);
    expect(seen!.staffIds).toEqual([WORKER_A]);
    expect(seen!.skus).toEqual([SKU.unSingle]);
  });

  it("staff dictionaries never disclose other workers", async () => {
    const mine = v1({ id: "m", staff_id: WORKER_A });
    const theirs = v1({ id: "t", staff_id: WORKER_B, created_at: t("09:01") });
    let seen: Record<string, unknown> | null = null;
    const db = createFakeEventsDb([mine, theirs], { visible: (r) => r.staff_id === WORKER_A, rawResponse: (e) => (seen = e) });
    await loadProductionEvidence(db.client, req({ visibility: productionVisibilityFor("staff", true) }));
    expect(seen!.staffIds).toEqual([WORKER_A]);
  });
});

/** Edit helper for a whole envelope (shared with the shuffled-dictionary test). */
function editEnvAll(edit: (e: Record<string, unknown>) => unknown) {
  return (e: Record<string, unknown>) => edit(e);
}

describe("failures, abort and deadline", () => {
  it("an RPC error (including a missing function) fails visibly", async () => {
    const db = createFakeEventsDb([v1()], { beforeResponse: () => ({ error: { message: "function public.load_production_evidence_v2 does not exist" } }) });
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
