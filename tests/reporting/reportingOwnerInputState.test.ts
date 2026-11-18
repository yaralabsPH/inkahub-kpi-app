/**
 * T15P-4c: the owner-input journal adapters in api/_lib/reporting-worker-state.ts.
 * Pure: the one piece rule, entries, request packing, decimal wire types and the
 * canonical event text. Real SQL: the adapters against the 0046 offline draft in
 * PGlite (synthetic, in-process; no hosted database), including inline and
 * pending pages, lost-response replay, stale writers, takeover and byte-exact
 * snapshot reconstruction.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { ProductionEvidenceEvent } from "../../src/lib/domain/productionCounts";
import { beginReportingRebuild, copyReportingSourcePage, freezeReportingRebuild } from "../../api/_lib/reporting-jobs";
import {
  checkpointOwnerInput, eventEntries, eventText, EVENT_TEXT_KEYS, loadOwnerInputHeader, lookupOwnerInputs, openOwnerInput, ownerInputVersion, packEntries, parseEventText,
  parseHandle, parseOwnerState, parseSeq, PIECE_LITERAL_BYTES, readOwnerOldStaff, reloadOwnerInput, REQUEST_BODY_BYTES, saveEnumeration, splitPieces, writeOwnerPage, type PieceEntry,
} from "../../api/_lib/reporting-worker-state";
import { MAX_RESPONSE_BYTES, responseBytes } from "../../api/_lib/production-reporting-reader";
import { ADMISSION_RESERVE_MS, ADMISSION_RPC_MS, admitDurableUnit, HEARTBEAT_MS, withRenewals, WORKER_BUDGET_MS, type AdmissionPath } from "../../api/_lib/production-reporting-worker";
import { audienceWork, ownerAudiences, ownerWorksFromInput, type OwnerInput } from "../../api/_lib/production-reporting-materialize";
import { reportingDb } from "./pg/harness";
import { pgRpc } from "./pg/rpc";

type Ev = ProductionEvidenceEvent;
const SITE = "au";
const W = "00000006-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const lit = (s: string) => Buffer.byteLength(JSON.stringify(s));
const ev = (id: string, o: Partial<Ev> = {}): Ev => ({
  id, location: SITE, staff_id: W, department: "framed", order_number: "OS-1", line_sku: "INKA-KAN0566-A4-FB", line_quantity: 1, event_type: "line_verified",
  created_at: "2026-10-01T00:00:00.000000Z", parent_event_id: null, cs_case_id: null, ...o,
});
const MEMBERS = (afterOrd: number | null) => ({ v: 1, step: "members", m: { afterOrd } });
/** Two backslash-heavy events: one admissible source response (<= 1 MiB envelope), ~2 MB once escaped for transport. */
function admissible(prefix: string, order: string): Ev[] {
  const events = [0, 1].map((i) => ev(`${prefix}-${i}`, { order_number: order, line_sku: "\\".repeat(250_000 - i) }));
  const envelope = events.map((e, i) => ({ owner_index: 0, event_id: e.id, image: { ...e, station_id: "s", note: "" }, n: i }));
  expect(responseBytes(envelope)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  expect(events.reduce((n, e) => n + Buffer.byteLength(eventText(e)), 0)).toBeLessThanOrEqual(1_048_576);
  return events;
}

describe("the one piece rule, entries and packing (pure)", () => {
  it("splits into maximal pieces by code point; the r4 backslash counterexample, control characters and 4-byte emoji", () => {
    for (const text of ["\\".repeat(400_221), "\u0001".repeat(70_000), "😀".repeat(60_000), "a", "x".repeat(PIECE_LITERAL_BYTES - 2), "x".repeat(PIECE_LITERAL_BYTES - 1)]) {
      const ps = splitPieces(text);
      expect(ps.join("")).toBe(text);
      ps.forEach((p, i) => {
        expect(lit(p)).toBeLessThanOrEqual(PIECE_LITERAL_BYTES);
        if (i < ps.length - 1) expect(lit(p + [...ps[i + 1]][0])).toBeGreaterThan(PIECE_LITERAL_BYTES); // maximal
        expect(/^[\udc00-\udfff]/.test(p)).toBe(false); // never splits a surrogate pair
      });
    }
    expect(splitPieces("x".repeat(PIECE_LITERAL_BYTES - 2))).toHaveLength(1);
    expect(splitPieces("x".repeat(PIECE_LITERAL_BYTES - 1))).toHaveLength(2);
    expect(splitPieces("\\".repeat(400_221)).length).toBe(Math.ceil((400_221 * 2) / (PIECE_LITERAL_BYTES - 2)));
    expect(() => splitPieces("")).toThrow(/empty/);
  });
  it("entries carry piece-zero metadata (bytes, sha-256, src_at, a boolean stream_candidate) and ordinals from fromOrd", () => {
    const a = ev("e1");
    const b = ev("e2", { line_sku: "\\".repeat(200_000) });
    const out = eventEntries([a, b], 7, (e) => e.id === "e1");
    expect(out[0]).toEqual([7, 0, eventText(a), { event_id: "e1", pieces: 1, text_bytes: Buffer.byteLength(eventText(a)), text_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), src_at: a.created_at, stream_candidate: true }]);
    const bs = out.filter((x) => x[0] === 8);
    expect(bs.length).toBeGreaterThan(1);
    expect((bs[0] as Extract<PieceEntry, { length: 4 }>)[3]).toMatchObject({ event_id: "e2", pieces: bs.length, stream_candidate: false });
    expect(bs.slice(1).every((x) => x.length === 3)).toBe(true);
    expect(bs.map((x) => x[2]).join("")).toBe(eventText(b));
    expect(Object.keys(JSON.parse(eventText(a)))).toEqual([...EVENT_TEXT_KEYS]);
    expect(() => eventEntries([a], 0, () => true)).toThrow(/ordinals/);
  });
  it("packs entries greedily into request bodies within the bound, in order", () => {
    const entries = eventEntries(Array.from({ length: 12 }, (_, i) => ev(`p${i}`, { line_sku: "y".repeat(150_000) })), 1, () => false);
    const groups = packEntries(entries, 100);
    expect(groups.flat()).toEqual(entries);
    for (const g of groups) expect(100 + Buffer.byteLength(JSON.stringify(g)) - 2).toBeLessThanOrEqual(REQUEST_BODY_BYTES);
    expect(groups.length).toBeGreaterThan(1);
    expect(packEntries([], 100)).toEqual([]);
  });
  it("decimal wire types stay text up to 2^63-1 and reject anything else", () => {
    expect(parseSeq("0")).toBe("0");
    expect(parseSeq("9007199254740993")).toBe("9007199254740993"); // above 2^53: never a Number
    expect(parseHandle("9223372036854775807")).toBe("9223372036854775807");
    for (const bad of ["9223372036854775808", "01", "-1", "1.0", "", " 1", 1, null]) expect(() => parseSeq(bad)).toThrow();
    expect(() => parseHandle("0")).toThrow(/range/);
  });
  it("parses only the canonical 11-key text bound to its id and site", () => {
    const t = eventText(ev("z1"));
    expect(parseEventText(t, SITE, "z1")).toEqual(ev("z1"));
    const o = JSON.parse(t);
    expect(() => parseEventText(JSON.stringify({ ...o, extra: 1 }), SITE, "z1")).toThrow(/11 keys/);
    const { id: _id, ...rest } = o;
    expect(() => parseEventText(JSON.stringify({ ...rest, id: "z1" }), SITE, "z1")).toThrow(/11 keys in order/);
    expect(() => parseEventText(t, "uk", "z1")).toThrow(/bound/);
    expect(() => parseEventText(t, SITE, "z2")).toThrow(/bound/);
    expect(() => parseEventText(t.replace('"id":', ' "id":'), SITE, "z1")).toThrow(/canonical/);
    expect(() => parseEventText("{", SITE, "z1")).toThrow(/not JSON/);
  });
});

describe("journal adapters over the real 0046 draft (PGlite)", () => {
  let db: PGlite;
  let batch = "";
  let fence = 0;
  const c = () => pgRpc(db);
  const O = (k: string) => ({ partitionKind: "order" as const, partitionKey: k });
  beforeAll(async () => {
    db = await reportingDb();
    await db.query("insert into auth.users (id, email) values ($1, 'os@x')", [W]);
    for (let i = 0; i < 4; i++) {
      await db.query(
        `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, parent_event_id)
         values ('au', $1, $2, 'framed', $3, 'INKA-KAN0566-A4-FB', 1, 'line_verified', 's', '', '2026-10-01T00:00:00Z', null)`,
        [`os-${i}`, W, `OS-${i}`],
      );
    }
    expect((await c().rpc("set_reporting_capture", { p_enabled: true })).error).toBeNull();
    expect((await c().rpc("set_reporting_site_mode", { p_site: SITE, p_read_mode: null, p_processor_enabled: true })).error).toBeNull();
    const r = await beginReportingRebuild(c(), SITE);
    batch = r.batchId;
    fence = r.leaseFence;
    let after: string | null = null;
    for (let i = 0; i < 100; i++) {
      const p = await copyReportingSourcePage(c(), batch, fence, after);
      if (p.complete) break;
      after = p.nextAfterEventId;
    }
    await freezeReportingRebuild(c(), batch, fence);
    const owners = [0, 1, 2, 3].map((i) => ({ owner: O(`OS-${i}`), oldStaff: i === 3 ? [W, "00000007-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] : [] }));
    const last: ["order", string] = ["order", "OS-3"];
    await saveEnumeration(c(), batch, fence, null, { kind: "rebuild", after: last }, owners, false);
    await saveEnumeration(c(), batch, fence, { kind: "rebuild", after: last }, { kind: "rebuild", after: last, end: true }, [], true);
    await db.query("update reporting_private.batches set lease_expires_at = now() + interval '1 hour' where batch_id = $1", [batch]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("version, open (idempotent), lookup in request order and old-staff pages", async () => {
    expect(await ownerInputVersion(c())).toBe(1);
    const a = await openOwnerInput(c(), batch, fence, O("OS-0"), "plan");
    expect(a).toMatchObject({ created: true, phase: "reading", seq: "0", reloadCalls: 2, heavyProven: false, pendingEvents: 0 });
    expect(await openOwnerInput(c(), batch, fence, O("OS-0"), "plan")).toMatchObject({ handle: a.handle, created: false });
    const l = await lookupOwnerInputs(c(), batch, fence, [O("OS-1"), O("OS-0"), O("OS-3")]);
    expect(l.map((x) => x.journal?.handle ?? null)).toEqual([null, a.handle, null]);
    expect(l.map((x) => x.oldStaffCount)).toEqual([0, 0, 2]);
    expect(await readOwnerOldStaff(c(), batch, fence, O("OS-3"), null, 1)).toEqual([W]);
    expect(await readOwnerOldStaff(c(), batch, fence, O("OS-3"), W, 1)).toEqual(["00000007-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
    expect(await readOwnerOldStaff(c(), batch, fence, O("OS-3"), "00000007-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toEqual([]);
    await expect(lookupOwnerInputs(c(), batch, fence, [])).rejects.toThrow(/1\.\.100/);
  });

  it("an inline page, an identical replay after a lost response, a stale writer, then a byte-exact reload", async () => {
    const h = (await openOwnerInput(c(), batch, fence, O("OS-1"), "plan")).handle;
    const events = [ev("os-1", { order_number: "OS-1" }), ev("os-1b", { order_number: "OS-1", event_type: "cancelled", parent_event_id: "os-1", line_sku: "😀\u0001\\\"" })];
    const entries = eventEntries(events, 1, (e) => e.id === "os-1");
    const w = await writeOwnerPage(c(), batch, fence, h, "0", entries, [MEMBERS(2)]);
    expect(w.calls).toBe(1);
    expect(w.result).toMatchObject({ seq: "1", eventCount: 2, pendingEvents: 0, replay: false, heavy: false });
    // the same process lost the response: the identical payload replays without a write
    const again = await checkpointOwnerInput(c(), batch, fence, h, "0", { kind: "page", pieces: entries, steps: [MEMBERS(2)] });
    expect(again).toMatchObject({ seq: "1", replay: true });
    await expect(checkpointOwnerInput(c(), batch, fence, h, "0", { kind: "page", pieces: [], steps: [MEMBERS(1)] })).rejects.toThrow(/owner_input_conflict/);
    const r = await reloadOwnerInput(c(), batch, fence, h, SITE);
    expect(r.events.map((x) => x.ord)).toEqual([1, 2]);
    expect(r.events.map((x) => x.ev)).toEqual(events);
    expect(r.calls).toBe(r.header.reloadCalls);
    expect(r.header).toMatchObject({ seq: "1", eventCount: 2, state: MEMBERS(2) });
  });

  it("a large page goes as pending piece calls then one page call; reload is byte-exact across load pages", async () => {
    const h = (await openOwnerInput(c(), batch, fence, O("OS-2"), "plan")).handle;
    // An admissible source response (its envelope fits 1 MiB) whose transport expansion still needs several calls.
    const events = admissible("big", "OS-2");
    const entries = eventEntries(events, 1, () => false);
    // the old fixture (about 2.16 MB of reduced text) can never be one source page: it is refused, not stored
    const oversized = Array.from({ length: 6 }, (_, i) => ev(`over-${i}`, { order_number: "OS-2", line_sku: (i % 2 ? "\\" : "é").repeat(180_000 + i) }));
    await expect(writeOwnerPage(c(), batch, fence, h, "0", eventEntries(oversized, 1, () => false), [MEMBERS(6)])).rejects.toThrow(/exceed 1048576 text bytes/);
    await checkpointOwnerInput(c(), batch, fence, h, (await loadOwnerInputHeader(c(), batch, fence, h)).seq, { kind: "discard_pending" });
    const seq0 = (await loadOwnerInputHeader(c(), batch, fence, h)).seq;
    const w = await writeOwnerPage(c(), batch, fence, h, seq0, entries, [MEMBERS(2)]);
    expect(w.calls).toBeGreaterThan(2);
    expect(w.result).toMatchObject({ seq: String(Number(seq0) + w.calls), eventCount: 2, pendingEvents: 0, pendingPieces: 0, heavy: false });
    const r = await reloadOwnerInput(c(), batch, fence, h, SITE);
    expect(r.events.map((x) => x.ev)).toEqual(events);
    expect(r.calls).toBe(r.header.reloadCalls);
    expect(r.header.reloadCalls).toBeGreaterThan(3); // more than one load page
  });

  it("takeover between pending calls: the new process reads the header, discards pending and rewrites the page", async () => {
    const h = (await openOwnerInput(c(), batch, fence, O("OS-3"), "plan")).handle;
    const events = admissible("tk", "OS-3");
    const entries = eventEntries(events, 1, () => false);
    const groups = packEntries(entries, 30);
    expect(groups.length).toBeGreaterThan(1);
    const first = await checkpointOwnerInput(c(), batch, fence, h, "0", { kind: "pieces", pieces: groups[0] });
    expect(first.pendingEvents).toBeGreaterThan(0);
    // a new process: it never re-sends the unpersisted payload; it adopts the committed seq and discards pending
    const hd = await loadOwnerInputHeader(c(), batch, fence, h);
    expect(hd).toMatchObject({ seq: "1", eventCount: 0, pendingEvents: first.pendingEvents });
    const d = await checkpointOwnerInput(c(), batch, fence, h, hd.seq, { kind: "discard_pending" });
    expect(d).toMatchObject({ seq: "2", pendingEvents: 0, pendingPieces: 0 });
    const w = await writeOwnerPage(c(), batch, fence, h, d.seq, entries, [MEMBERS(2)]);
    expect(w.result.eventCount).toBe(2);
    expect((await reloadOwnerInput(c(), batch, fence, h, SITE)).events.map((x) => x.ev)).toEqual(events);
  });

  it("a numeric-looking string id ('123') checkpoints and reloads byte-exactly (review r2 Must-fix 2 control)", async () => {
    const h = (await openOwnerInput(c(), batch, fence, O("OS-0"), "plan")).handle;
    const hd = await loadOwnerInputHeader(c(), batch, fence, h);
    const e = ev("123", { order_number: "OS-0" });
    const w = await writeOwnerPage(c(), batch, fence, h, hd.seq, eventEntries([e], hd.eventCount + 1, () => false), [MEMBERS(hd.eventCount + 1)]);
    expect(w.result.eventCount).toBe(hd.eventCount + 1);
    const r = await reloadOwnerInput(c(), batch, fence, h, SITE);
    expect(r.events.at(-1)!.ev).toEqual(e);
    expect(typeof r.events.at(-1)!.ev.id).toBe("string");
  });

  it("reload rejects a tampered committed piece and a wrong event count (evidence is verified, never repaired)", async () => {
    const h = (await openOwnerInput(c(), batch, fence, O("OS-1"), "plan")).handle;
    await db.exec("begin");
    try {
      await db.query("update reporting_private.owner_input_pieces set piece = replace(piece, 'os-1b', 'os-1c') where handle = $1::bigint and ord = 2", [h]);
      await expect(reloadOwnerInput(c(), batch, fence, h, SITE)).rejects.toThrow(/length\/digest/);
    } finally {
      await db.exec("rollback");
    }
    await db.exec("begin");
    try {
      await db.query("delete from reporting_private.owner_input_pieces where handle = $1::bigint and ord = 2", [h]);
      await db.query("delete from reporting_private.owner_input_events where handle = $1::bigint and ord = 2", [h]);
      await expect(reloadOwnerInput(c(), batch, fence, h, SITE)).rejects.toThrow(/header says 2/);
    } finally {
      await db.exec("rollback");
    }
    expect((await reloadOwnerInput(c(), batch, fence, h, SITE)).events).toHaveLength(2);
  });

  it("parseOwnerState accepts and rejects exactly what the SQL shape check does", async () => {
    const W0 = { worker: 0, cursorOrd: null, stopAt: null, need: ["*", "framed"], line: null };
    const good: unknown[] = [
      MEMBERS(null), MEMBERS(3), { v: 1, step: "parents", p: { group: 0, afterOrd: null } }, { v: 1, step: "children", c: { group: 2, afterOrd: 9 } },
      { v: 1, step: "walk", w: W0 }, { v: 1, step: "walk", w: { ...W0, cursorOrd: 4, stopAt: "1790000000000000", need: [] } },
      { v: 1, step: "walk", w: { ...W0, line: { ord: 3, afterKidOrd: null, phase: "kids", effective: null } } },
      { v: 1, step: "walk", w: { ...W0, line: { ord: 3, afterKidOrd: 5, phase: "done", effective: false } } }, { v: 1, step: "done" },
    ];
    const bad: unknown[] = [
      null, [], { v: 2, step: "done" }, { v: 1, step: "nope" }, { v: 1, step: "done", x: 1 }, { v: 1, step: "members", m: { afterOrd: -1 } }, { v: 1, step: "members", m: { afterOrd: 1.5 } },
      { v: 1, step: "members", m: { afterOrd: "1" } }, { v: 1, step: "members", m: {} }, { v: 1, step: "parents", p: { group: 0 } }, { v: 1, step: "parents", c: { group: 0, afterOrd: null } },
      { v: 1, step: "walk", w: { ...W0, need: ["bad"] } }, { v: 1, step: "walk", w: { ...W0, stopAt: 12 } }, { v: 1, step: "walk", w: { ...W0, stopAt: "1e3" } },
      { v: 1, step: "walk", w: { ...W0, line: { ord: 3, afterKidOrd: null, phase: "kids", effective: true } } },
      { v: 1, step: "walk", w: { ...W0, line: { ord: 3, afterKidOrd: null, phase: "done", effective: null } } }, { v: 1, step: "walk", w: { ...W0, extra: 1 } },
      { v: 1, step: "walk", w: { ...W0, line: { ord: 3, afterKidOrd: null, phase: null, effective: null } } }, { v: 1, step: "walk", w: { ...W0, line: { ord: 3, afterKidOrd: null, phase: null, effective: true } } },
      { v: 1, step: "walk", w: { ...W0, worker: null } }, { v: 1, step: "children", c: { group: null, afterOrd: null } }, { v: 1, step: null }, { v: null, step: "done" },
      { v: 1, step: "members", m: { afterOrd: 1_000_000_000 } },
    ];
    const sql = async (s: unknown) => {
      try {
        await db.query("select reporting_private.oi_check_shape($1::jsonb)", [JSON.stringify(s)]);
        return true;
      } catch {
        return false;
      }
    };
    const ts = (s: unknown) => {
      try {
        parseOwnerState(s);
        return true;
      } catch {
        return false;
      }
    };
    for (const s of good) {
      expect(ts(s), JSON.stringify(s)).toBe(true);
      expect(await sql(s), JSON.stringify(s)).toBe(true);
      expect(parseOwnerState(s)).toEqual(s);
    }
    for (const s of bad) expect([ts(s), await sql(s)], JSON.stringify(s)).toEqual([false, false]);
  });

  it("a reload pinned to an old seq is refused as a snapshot change", async () => {
    const h = (await openOwnerInput(c(), batch, fence, O("OS-1"), "plan")).handle;
    const r = await pgRpc(db).rpc("load_reporting_owner_input_events", { p_batch: batch, p_fence: fence, p_handle: h, p_seq: "0", p_after_ord: 0, p_after_piece: -1 });
    expect(r.error?.message).toMatch(/owner_input_snapshot/);
  });
});

describe("strict reload rows (Must-fix 5): metadata only on piece 0, a lone all-null eof", () => {
  const BIG_SEQ = "9007199254740993"; // above 2^53: must be sent unchanged on every load call
  const BATCH = "11111111-1111-4111-8111-111111111111";
  const events = [ev("r1"), ev("r2", { line_sku: "\\".repeat(200_000) })];
  type Row = Record<string, unknown>;
  function loaderRows(): Row[] {
    return eventEntries(events, 1, () => false).map((e) => {
      const m = e.length === 4 ? e[3] : null;
      return { ord: e[0], piece_no: e[1], pieces: m?.pieces ?? null, event_id: m?.event_id ?? null, text_bytes: m?.text_bytes ?? null, text_sha256: m?.text_sha256 ?? null, piece: e[2], eof: false };
    });
  }
  const EOF: Row = { ord: null, piece_no: null, pieces: null, event_id: null, text_bytes: null, text_sha256: null, piece: null, eof: true };
  /** A fake client serving the loader shape one row per page (fragmented), then `eof`. */
  function fake(rows: Row[], eof: Row = EOF) {
    const seqs: unknown[] = [];
    const client = {
      rpc: async (fn: string, a: Record<string, unknown>) => {
        if (fn === "load_reporting_owner_input_header")
          return { data: [{ phase: "reading", purpose: "plan", seq: BIG_SEQ, state: MEMBERS(2), members_count: null, event_count: 2, pending_events: 0, pending_pieces: 0, audiences: null, hashes_done: 0, input_hashes: [], reload_calls: rows.length + 2, provisional_reload_calls: rows.length + 2, heavy_proven: false }], error: null };
        if (fn === "load_reporting_owner_input_events") {
          seqs.push(a.p_seq);
          const after = [a.p_after_ord as number, a.p_after_piece as number];
          const next = rows.find((r) => (r.ord as number) > after[0] || ((r.ord as number) === after[0] && (r.piece_no as number) > after[1]));
          return { data: [next ?? eof], error: null };
        }
        throw new Error(`unexpected ${fn}`);
      },
    };
    return { client, seqs };
  }
  it("a valid fragmented journal reloads, with the >2^53 seq sent unchanged on every load call", async () => {
    const f = fake(loaderRows());
    const r = await reloadOwnerInput(f.client, BATCH, 1, "1", SITE);
    expect(r.events.map((x) => x.ev)).toEqual(events);
    expect(f.seqs.length).toBe(loaderRows().length + 1);
    expect(f.seqs.every((s) => s === BIG_SEQ)).toBe(true);
  });
  it("rejects metadata on a continuation piece, each field independently, including omission", async () => {
    const cont = loaderRows().findIndex((r) => r.piece_no === 1);
    expect(cont).toBeGreaterThan(0);
    for (const [k, v] of [["pieces", 2], ["event_id", "r2"], ["text_bytes", 5], ["text_sha256", "a".repeat(64)]] as const) {
      const rows = loaderRows();
      rows[cont] = { ...rows[cont], [k]: v };
      await expect(reloadOwnerInput(fake(rows).client, BATCH, 1, "1", SITE), k).rejects.toThrow(/piece-zero metadata/);
      const omitted = loaderRows();
      delete omitted[cont][k];
      await expect(reloadOwnerInput(fake(omitted).client, BATCH, 1, "1", SITE), `omit ${k}`).rejects.toThrow(/missing a field|piece-zero metadata/);
    }
  });
  it("rejects an eof row carrying any data or missing any field", async () => {
    for (const k of ["ord", "piece_no", "pieces", "event_id", "text_bytes", "text_sha256", "piece"]) {
      await expect(reloadOwnerInput(fake(loaderRows(), { ...EOF, [k]: k === "event_id" || k === "piece" || k === "text_sha256" ? "x" : 1 }).client, BATCH, 1, "1", SITE), k).rejects.toThrow(/eof row carries data/);
      const { [k]: _gone, ...missing } = EOF;
      await expect(reloadOwnerInput(fake(loaderRows(), missing).client, BATCH, 1, "1", SITE), `omit ${k}`).rejects.toThrow(/eof row carries data/);
    }
  });
  it("still rejects a wrong digest, truncation and a misplaced eof", async () => {
    const bad = loaderRows();
    bad[0] = { ...bad[0], text_sha256: "0".repeat(64) };
    await expect(reloadOwnerInput(fake(bad).client, BATCH, 1, "1", SITE)).rejects.toThrow(/length\/digest/);
    const cut = loaderRows().slice(0, -1);
    await expect(reloadOwnerInput(fake(cut).client, BATCH, 1, "1", SITE)).rejects.toThrow(/missing pieces/);
    const f = fake(loaderRows());
    const inner = f.client.rpc;
    let n = 0;
    f.client.rpc = async (fn, a) => {
      const r = await inner(fn, a);
      if (fn === "load_reporting_owner_input_events" && ++n === 2) return { data: [...(r.data as Row[]), EOF], error: null };
      return r;
    };
    await expect(reloadOwnerInput(f.client, BATCH, 1, "1", SITE)).rejects.toThrow(/misplaced eof/);
  });
});

// ---- T15P-4d step 2: phase-specific cumulative admission and the per-audience seam ----
const FIXED = 5; // version, status, acquire, progress, owner list
const path = (prereqRpcs: number, prereqCpu: number, unitRpcs: number, unitCpu: number, paid = false): AdmissionPath => ({
  prerequisites: { rpcs: prereqRpcs, cpuMs: prereqCpu }, unit: { rpcs: unitRpcs, cpuMs: unitCpu }, prerequisitesPaid: paid,
});

describe("cumulative admission to the next durable boundary", () => {
  it("renewals are charged to a fixed point, plus the reserve", () => {
    expect(withRenewals(0)).toBe(ADMISSION_RESERVE_MS);
    expect(withRenewals(29_999)).toBe(29_999 + ADMISSION_RESERVE_MS);
    expect(withRenewals(30_000)).toBe(30_000 + ADMISSION_RPC_MS + ADMISSION_RESERVE_MS);
    expect(withRenewals(59_500)).toBe(59_500 + 2 * ADMISSION_RPC_MS + ADMISSION_RESERVE_MS); // the first renewal pushes past 60 s
    for (const w of [0, 1_000, 29_000, 119_999, 200_000]) {
      const t = withRenewals(w) - ADMISSION_RESERVE_MS;
      expect(Math.floor(t / HEARTBEAT_MS)).toBe((t - w) / ADMISSION_RPC_MS); // exactly the renewals due over the whole span
    }
  });

  it("nonzero reconstruction CPU: a unit that fits without it but not with it is a visible capacity failure, not pending forever", () => {
    // 1 lookup + 120 reload calls + 5 fixed, one 1-call unit, 0 CPU: fits
    expect(admitDurableUnit(path(FIXED + 1 + 120, 0, 1, 0), WORKER_BUDGET_MS).verdict).toBe("run");
    // the same with 120 s of reload parse/reassembly/digest CPU: the fresh path no longer fits -> capacity
    // (127 RPCs + 120 s = 247 s before renewals and the reserve)
    const v = admitDurableUnit(path(FIXED + 1 + 120, 120_000, 1, 0), WORKER_BUDGET_MS);
    expect(v.verdict).toBe("capacity");
  });

  it("stage preparation that fits alone but not with its first upload is capacity (preparation alone is not progress)", () => {
    const prereq = { rpcs: FIXED + 1 + 20, cpu: 150_000 };
    // preparation + discovery only (wrongly treated as the unit) would fit...
    expect(admitDurableUnit(path(prereq.rpcs, prereq.cpu, 2, 40_000), WORKER_BUDGET_MS).verdict).toBe("run");
    // ...but the unit must include the first missing upload (one RPC plus its serialization)
    expect(admitDurableUnit(path(prereq.rpcs, prereq.cpu, 2 + 1, 40_000 + 45_000), WORKER_BUDGET_MS).verdict).toBe("capacity");
  });

  it("hash checkpoint overhead and an unfinished multi-call page are part of their units", () => {
    const prereq = FIXED + 1 + 60;
    // 100 hashes worth 160 s CPU fit; the checkpoint RPC is charged too
    const fits = path(prereq, 0, 1, 160_000);
    expect(admitDurableUnit(fits, WORKER_BUDGET_MS).verdict).toBe("run");
    // a source page needing 6 pieces calls + 1 page call, near the ceiling
    const page = path(prereq, 100_000, 1 + 6 + 1, 50_000); // 66 + 8 RPCs + 150 s = 224 s, + 7 renewals + reserve = 233 s
    expect(admitDurableUnit(page, WORKER_BUDGET_MS).verdict).toBe("run");
    expect(admitDurableUnit(path(prereq, 100_000, 1 + 6 + 1, 75_000), WORKER_BUDGET_MS).verdict).toBe("capacity");
  });

  it("fits fresh but not now -> pending; and a FRESH uninterrupted invocation then always admits it (no pending forever)", () => {
    for (const [pr, pc, ur, uc] of [[FIXED + 1 + 10, 5_000, 3, 20_000], [FIXED + 1 + 110, 90_000, 8, 10_000], [FIXED, 0, 1, 1]] as const) {
      const p = path(pr, pc, ur, uc);
      const fresh = admitDurableUnit(p, WORKER_BUDGET_MS);
      expect(fresh.verdict).toBe("run");
      // late in an invocation that already holds the prerequisites, with too little time left
      const late = admitDurableUnit({ ...p, prerequisitesPaid: true }, withRenewals(ur * ADMISSION_RPC_MS + uc) - 1);
      expect(late.verdict).toBe("pending");
      // the next fresh invocation (budget minus nothing spent yet) is admitted by construction
      expect(admitDurableUnit(p, WORKER_BUDGET_MS).verdict).toBe("run");
    }
  });

  it("paid prerequisites are not charged twice", () => {
    const p = path(FIXED + 1 + 100, 50_000, 2, 1_000);
    const need = withRenewals(2 * ADMISSION_RPC_MS + 1_000);
    expect(admitDurableUnit({ ...p, prerequisitesPaid: true }, need).verdict).toBe("run");
    expect(admitDurableUnit({ ...p, prerequisitesPaid: false }, need).verdict).toBe("pending");
  });
});

describe("admission inputs are validated at runtime (NaN, Infinity, negative, fractional are refused, never admitted)", () => {
  const ok = path(FIXED, 1_000, 1, 1_000);
  const BAD_NUMBERS = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.5];
  it("withRenewals refuses non-finite and negative work (NaN would never reach its fixed point)", () => {
    for (const v of BAD_NUMBERS) expect(() => withRenewals(v), String(v)).toThrow(/workMs must be a finite non-negative number/);
    expect(withRenewals(0.5)).toBe(0.5 + ADMISSION_RESERVE_MS); // fractional milliseconds are a valid duration
  });
  it("RPC counts must be non-negative safe integers (NaN, Infinity, negative, fractional, unsafe)", () => {
    for (const v of [...BAD_NUMBERS, 1.5, 0.1, 2 ** 53, Number.MAX_VALUE]) {
      expect(() => admitDurableUnit({ ...ok, unit: { rpcs: v, cpuMs: 0 } }, WORKER_BUDGET_MS), `unit.rpcs ${v}`).toThrow(/unit\.rpcs must be a non-negative safe integer/);
      expect(() => admitDurableUnit({ ...ok, prerequisites: { rpcs: v, cpuMs: 0 } }, WORKER_BUDGET_MS), `prerequisites.rpcs ${v}`).toThrow(/prerequisites\.rpcs must be a non-negative safe integer/);
    }
  });
  it("CPU estimates, remainingMs and budgetMs must be finite and non-negative; the budget must be usable after the reserve", () => {
    for (const v of BAD_NUMBERS) {
      expect(() => admitDurableUnit({ ...ok, unit: { rpcs: 1, cpuMs: v } }, WORKER_BUDGET_MS), `unit.cpuMs ${v}`).toThrow(/unit\.cpuMs must be a finite non-negative number/);
      expect(() => admitDurableUnit({ ...ok, prerequisites: { rpcs: 1, cpuMs: v } }, WORKER_BUDGET_MS), `prerequisites.cpuMs ${v}`).toThrow(/prerequisites\.cpuMs must be a finite non-negative number/);
      expect(() => admitDurableUnit(ok, v), `remainingMs ${v}`).toThrow(/remainingMs must be a finite non-negative number/);
      expect(() => admitDurableUnit(ok, WORKER_BUDGET_MS, v), `budgetMs ${v}`).toThrow(/budgetMs must be a finite non-negative number/);
    }
    for (const b of [0, ADMISSION_RESERVE_MS]) expect(() => admitDurableUnit(ok, WORKER_BUDGET_MS, b), `budgetMs ${b}`).toThrow(/usable budget/);
    expect(() => admitDurableUnit({ ...ok, prerequisitesPaid: "yes" as unknown as boolean }, WORKER_BUDGET_MS)).toThrow(/path is malformed/);
    expect(() => admitDurableUnit({ ...ok, unit: null as unknown as AdmissionPath["unit"] }, WORKER_BUDGET_MS)).toThrow(/unit is missing/);
    // fractional CPU milliseconds are valid and still admitted by the same arithmetic
    expect(admitDurableUnit({ ...ok, unit: { rpcs: 1, cpuMs: 0.25 } }, WORKER_BUDGET_MS).verdict).toBe("run");
  });
});

describe("the bounded per-audience seam", () => {
  const ev = (id: string, staff: string | null) => ({ id, location: "au", staff_id: staff, department: "framed", order_number: "O-1", line_sku: "INKA-KAN0566-A4-FB", line_quantity: 1, event_type: "line_verified", created_at: "2026-10-01T00:00:00.000000Z", parent_event_id: null, cs_case_id: null });
  const A = "00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "00000002-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const OLD = "00000003-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const owner = { partitionKind: "order" as const, partitionKey: "O-1" };
  const reader = { site: "au", cutoff: "2026-10-02T00:00:00.000000Z" } as const;
  it("audiences are site, then member and old-staff selves bytewise; one audience is computed on demand and equals the eager list", () => {
    const input: OwnerInput = { owner, members: [ev("e2", B), ev("e1", A)], events: [ev("e1", A), ev("e2", B)] };
    expect(ownerAudiences(input, [OLD, A])).toEqual([{ kind: "site" }, { kind: "self", staffId: A }, { kind: "self", staffId: B }, { kind: "self", staffId: OLD }]);
    const eager = ownerWorksFromInput(reader as never, owner, input, [OLD]);
    const lazy = ownerAudiences(input, [OLD]).map((a) => audienceWork(reader, owner, input, a));
    expect(lazy).toEqual(eager);
    // an empty replacement keeps its old-self audiences
    const empty: OwnerInput = { owner, members: [], events: [] };
    expect(ownerAudiences(empty, [OLD])).toEqual([{ kind: "site" }, { kind: "self", staffId: OLD }]);
    expect(audienceWork(reader, owner, empty, { kind: "self", staffId: OLD }).inputRows).toBe(0);
  });
});
