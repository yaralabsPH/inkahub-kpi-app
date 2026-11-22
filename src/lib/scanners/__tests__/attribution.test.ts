import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ATTRIBUTION_BATCH,
  ATTRIBUTION_CSV_HEADERS,
  attributableEventIds,
  attributionCsvCells,
  csvSafeText,
  fetchAttributionsForEvents,
  groupByEvent,
  type FramerAttribution,
} from "../attribution";

const row = (over: Partial<FramerAttribution>): FramerAttribution => ({
  dispatch_event_id: "dsp-a-d", order_number: "10190203", sku: "INKA-ABC0001-A2-FB", source: "scan",
  display_name: "Alice", person_id: "p1", recorded_at: "2026-11-22T09:00:00Z", dispatcher_id: "d1", ...over,
});

/**
 * A fake PostgREST builder: records each .in() batch, its ordering and the
 * requested .range(); answers like PostgREST (slice of the ordered rows),
 * but never more than `cap` rows per response (Supabase's max-rows).
 */
function fakeClient(
  answer: (ids: string[]) => { data: unknown; error: { code?: string; message: string } | null },
  cap = Number.POSITIVE_INFINITY,
) {
  const calls: Array<{ location: string; ids: string[]; order: string[]; from: number; to: number }> = [];
  const client = {
    from: (table: string) => {
      expect(table).toBe("dispatch_framer_attributions");
      let location = "";
      let ids: string[] = [];
      const order: string[] = [];
      const b = {
        select: () => b,
        eq: (_c: string, v: string) => { location = v; return b; },
        in: (_c: string, v: string[]) => { ids = v; return b; },
        order: (c: string) => { order.push(c); return b; },
        range: async (from: number, to: number) => {
          calls.push({ location, ids, order: [...order], from, to });
          const a = answer(ids);
          if (a.error || !Array.isArray(a.data)) return a;
          const sorted = [...(a.data as FramerAttribution[])].sort((x, y) =>
            x.dispatch_event_id < y.dispatch_event_id ? -1 : x.dispatch_event_id > y.dispatch_event_id ? 1 : x.sku < y.sku ? -1 : x.sku > y.sku ? 1 : 0);
          return { data: sorted.slice(from, Math.min(to + 1, from + cap)), error: null };
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe("framer attribution for Reports", () => {
  it("only shared-scanner dispatch events are looked up", () => {
    expect(attributableEventIds([
      { id: "dsp-a-d", event_type: "dispatched" },
      { id: "dsp-a-d", event_type: "dispatched" },
      { id: "evt-classic", event_type: "dispatched" },
      { id: "dsp-x-ci", event_type: "clock_in" },
      { id: "scn-1-v01", event_type: "line_verified" },
    ])).toEqual(["dsp-a-d"]);
  });

  it("batches by event id within the site", async () => {
    const ids = Array.from({ length: ATTRIBUTION_BATCH + 5 }, (_, i) => `dsp-${i}-d`);
    const { client, calls } = fakeClient((batch) => ({ data: batch.slice(0, 1).map((id) => row({ dispatch_event_id: id })), error: null }));
    const r = await fetchAttributionsForEvents(client, "au", ids);
    expect(calls.map((c) => [c.location, c.ids.length])).toEqual([["au", ATTRIBUTION_BATCH], ["au", 5]]);
    expect(r.ok && r.rows.length).toBe(2);
  });

  it("pages deterministically within a batch: more rows than one response returns are all read", async () => {
    // 200 dispatches x 25 framed SKUs = 5000 rows in ONE id batch; the server caps a response at 1000.
    const ids = Array.from({ length: ATTRIBUTION_BATCH }, (_, i) => `dsp-${String(i).padStart(3, "0")}-d`);
    const all = ids.flatMap((id) => Array.from({ length: 25 }, (_, k) => row({ dispatch_event_id: id, sku: `INKA-ABC${String(k).padStart(4, "0")}-A2-FB` })));
    const { client, calls } = fakeClient(() => ({ data: all, error: null }), 1000);
    const r = await fetchAttributionsForEvents(client, "au", ids);
    expect(r.ok && r.rows.length).toBe(5000);
    expect(r.ok && new Set(r.rows.map((x) => `${x.dispatch_event_id}|${x.sku}`)).size).toBe(5000);
    expect(calls.every((c) => c.order.join(",") === "dispatch_event_id,sku")).toBe(true);
    expect(calls.map((c) => c.from)).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
    // Every row of a dispatch event lands in its CSV cell.
    expect(attributionCsvCells("dsp-199-d", groupByEvent(r.ok ? r.rows : []))[1].split("; ")).toHaveLength(25);
  });

  it("a database without 0056 answers none; any other error is reported, not hidden", async () => {

    expect(await fetchAttributionsForEvents(fakeClient(() => ({ data: null, error: { code: "PGRST205", message: "no table" } })).client, "au", ["dsp-1-d"]))
      .toEqual({ ok: true, rows: [] });
    expect(await fetchAttributionsForEvents(fakeClient(() => ({ data: null, error: { code: "57014", message: "timeout" } })).client, "au", ["dsp-1-d"]))
      .toEqual({ ok: false, message: "timeout" });
  });

  it("CSV: two appended columns; manual is explicit; other rows stay empty", () => {
    expect(ATTRIBUTION_CSV_HEADERS).toEqual(["framed_by", "framer_evidence"]);
    const byEvent = groupByEvent([
      row({ sku: "INKA-ABC0002-A3-FW", source: "manual", display_name: "Bob" }),
      row({}),
      row({ dispatch_event_id: "dsp-b-d", display_name: "Cy" }),
    ]);
    expect(attributionCsvCells("dsp-a-d", byEvent)).toEqual(["Alice; Bob", "INKA-ABC0001-A2-FB: scan; INKA-ABC0002-A3-FW: manual"]);
    expect(attributionCsvCells("evt-classic", byEvent)).toEqual(["", ""]);
    expect(attributionCsvCells("dsp-c-d", byEvent, true)).toEqual(["unavailable", "unavailable"]);
    expect(attributionCsvCells("evt-classic", byEvent, true)).toEqual(["", ""]);
  });

  it("names that a spreadsheet would run as a formula are neutralised", () => {
    for (const bad of ["=HYPERLINK(\"x\")", "+1", "-2", "@SUM(A1)", "\tx", "\rx"]) expect(csvSafeText(bad)).toBe(`'${bad}`);
    expect(csvSafeText("Alice O'Neil")).toBe("Alice O'Neil");
    const byEvent = groupByEvent([row({ display_name: "=cmd|' /C calc'!A0" })]);
    expect(attributionCsvCells("dsp-a-d", byEvent)[0]).toBe("'=cmd|' /C calc'!A0");
  });
});
