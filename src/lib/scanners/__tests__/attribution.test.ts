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

/** A fake PostgREST builder that records each .in() batch. */
function fakeClient(answer: (ids: string[]) => { data: unknown; error: { code?: string; message: string } | null }) {
  const calls: Array<{ location: string; ids: string[] }> = [];
  const client = {
    from: (table: string) => {
      expect(table).toBe("dispatch_framer_attributions");
      let location = "";
      const b = {
        select: () => b,
        eq: (_c: string, v: string) => { location = v; return b; },
        in: async (_c: string, ids: string[]) => { calls.push({ location, ids }); return answer(ids); },
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
