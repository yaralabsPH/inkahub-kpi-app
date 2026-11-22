import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { activateBadge, classifyRpcError, commitFraming, fetchOrderLookup } from "../client";
import type { ScannerJob } from "../outbox";
import type { PreparedFraming } from "../order";

function fakeClient(answer: { data?: unknown; error?: unknown } | Error): { client: SupabaseClient; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  const client = {
    rpc: async (fn: string, params: unknown) => {
      calls.push([fn, params]);
      if (answer instanceof Error) throw answer;
      return { data: answer.data ?? null, error: answer.error ?? null };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe("classifyRpcError", () => {
  it("separates definite refusals from unknown outcomes", () => {
    expect(classifyRpcError({ message: "scanner: badge_inactive", code: "P0001" })).toMatchObject({ outcome: "rejected", code: "badge_inactive" });
    expect(classifyRpcError({ message: "packaging: not_in_catalogue: p1", code: "P0001" })).toMatchObject({ outcome: "rejected", code: "packaging_invalid" });
    expect(classifyRpcError({ message: "new row violates check", code: "23514" })).toMatchObject({ outcome: "rejected", code: "stock_floor" });
    expect(classifyRpcError({ message: "function not found", code: "PGRST202" })).toMatchObject({ outcome: "rejected", code: "unavailable" });
    expect(classifyRpcError({ message: "JWT expired", code: "PGRST301" })).toMatchObject({ outcome: "network_error", auth: true });
    expect(classifyRpcError({ message: "deadlock", code: "40P01" })).toMatchObject({ outcome: "network_error" });
    expect(classifyRpcError({ message: "Failed to fetch" })).toMatchObject({ outcome: "network_error" });
  });
});

describe("rpc wrappers", () => {
  it("activation: activated, unknown badge, and a thrown fetch is an unknown outcome", async () => {
    const pid = "11111111-1111-4111-8111-111111111111";
    const ok = fakeClient({ data: { status: "activated", person_id: pid, display_name: "Alice", clocked_in: true } });
    const args = { location: "au", requestId: "r", receiverId: "wall-1", scannerId: "S1", badge: "AAAA0001" };
    expect(await activateBadge(ok.client, args)).toEqual({ outcome: "activated", personId: pid, displayName: "Alice", clockedIn: true });
    expect(ok.calls[0]).toEqual(["scanner_activate_badge", { p_location: "au", p_request_id: "r", p_receiver_id: "wall-1", p_scanner_id: "S1", p_badge: "AAAA0001" }]);
    expect(await activateBadge(fakeClient({ data: { status: "unknown_badge" } }).client, args)).toEqual({ outcome: "unknown_badge" });
    expect(await activateBadge(fakeClient(new Error("offline")).client, args)).toMatchObject({ outcome: "network_error" });
  });

  it("commit: an unreadable answer is retried (unknown outcome), never treated as saved", async () => {
    const job = { location: "au", requestId: "r", receiverId: "w", scannerId: "S1", personId: "p", badge: "B", scannedAt: "2026-11-22T00:00:00.000Z" } as ScannerJob;
    const prepared: PreparedFraming = { orderNumber: "10190203", displayName: "#10190203", lines: [{ sku: "INKA-ABC0001-A2-FB", quantity: 1, workType: "framed", pieces: 1 }], workTypes: ["framed"], pieces: 1, components: [], packaging: null };
    expect(await commitFraming(fakeClient({ data: { status: "weird" } }).client, job, prepared)).toMatchObject({ outcome: "network_error" });
    const saved = fakeClient({ data: { status: "saved", pieces: 1, event_ids: ["a", "b"], negative_codes: [], replayed: true } });
    expect(await commitFraming(saved.client, job, prepared)).toEqual({ outcome: "saved", result: { pieces: 1, eventIds: ["a", "b"], negativeCodes: [], replayed: true } });
    expect(saved.calls[0][1]).toMatchObject({ p_lines: [{ sku: "INKA-ABC0001-A2-FB", quantity: 1, work_type: "framed" }], p_packaging: null, p_scanned_at: "2026-11-22T00:00:00.000Z" });
  });
});

describe("fetchOrderLookup", () => {
  const res = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("404 is a definite not-found; 401, 5xx and thrown fetch are retryable", async () => {
    expect(await fetchOrderLookup(res(404, { found: false }), "t", "10190203")).toEqual({ kind: "ok", lookup: { found: false } });
    expect(await fetchOrderLookup(res(401), "t", "10190203")).toMatchObject({ kind: "network", auth: true });
    expect(await fetchOrderLookup(res(502), "t", "10190203")).toMatchObject({ kind: "network" });
    expect(await fetchOrderLookup((async () => { throw new Error("down"); }) as unknown as typeof fetch, "t", "1")).toMatchObject({ kind: "network" });
    expect(await fetchOrderLookup(res(200), null, "1")).toMatchObject({ kind: "network", auth: true });
  });
});
