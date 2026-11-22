import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApplyArgs } from "@/lib/repository/supabase/orderPackaging";
import { createPackagingOutbox } from "../packagingOutbox";
import { drainPackagingOutbox, submitPackagingApply } from "../packagingSubmit";

type Answer = { data: unknown; error: { message?: string; code?: string } | null };

function fakeClient(answer: () => Answer): { client: SupabaseClient; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    rpc: async (_fn: string, params: Record<string, unknown>) => {
      calls.push(params);
      return answer();
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const pick = {
  id: "pkp-1", location: "au", order_number: "F4T-1", packing_point: "dispatch", shipment_key: "orig",
  state: "auto", stock_state: "posted", rule_set_id: "prs-1", rule_set_version: 1,
  predicted: { "box-a": 1 }, target: { "box-a": 1 }, posted: { "box-a": 1 }, revision: 1,
  created_at: "2026-11-22T00:00:00Z", updated_at: "2026-11-22T00:00:00Z",
};
const applied: Answer = { data: { status: "applied", pick, deltas: { "box-a": 1 }, unposted: [], negative: [] }, error: null };
const offline: Answer = { data: null, error: { message: "Failed to fetch" } };

const args: ApplyArgs = {
  location: "au", requestId: "apply:ev-1", eventId: "ev-1", ruleSetId: "prs-1",
  resolved: true, predicted: { "box-a": 1 }, target: { "box-a": 1 }, snapshot: null,
};

describe("submitPackagingApply", () => {
  it("saves with exactly one call and queues nothing", async () => {
    const { client, calls } = fakeClient(() => applied);
    const outbox = createPackagingOutbox(null);
    const res = await submitPackagingApply(client, outbox, args, "F4T-1");
    expect(res).toMatchObject({ kind: "saved", alreadyApplied: false, stockIssue: false });
    expect(calls).toHaveLength(1);
    expect(outbox.pendingCount()).toBe(0);
  });

  it("treats an existing pick as saved", async () => {
    const { client } = fakeClient(() => ({ data: { status: "already_applied", pick }, error: null }));
    expect(await submitPackagingApply(client, createPackagingOutbox(null), args, "F4T-1")).toMatchObject({ kind: "saved", alreadyApplied: true });
  });

  it("reports a stock issue without failing", async () => {
    const { client } = fakeClient(() => ({ data: { status: "applied", pick: { ...pick, stock_state: "short" }, deltas: { "box-a": 1 }, unposted: [], negative: ["box-a"] }, error: null }));
    expect(await submitPackagingApply(client, createPackagingOutbox(null), args, "F4T-1")).toMatchObject({ kind: "saved", stockIssue: true });
  });

  it("queues on no answer, with the same request id", async () => {
    const { client } = fakeClient(() => offline);
    const outbox = createPackagingOutbox(null);
    expect(await submitPackagingApply(client, outbox, args, "F4T-1")).toEqual({ kind: "queued" });
    expect(outbox.list().map((e) => [e.args.requestId, e.orderNumber])).toEqual([["apply:ev-1", "F4T-1"]]);
  });

  it("fails loudly when the device cannot keep the request", async () => {
    const { client } = fakeClient(() => offline);
    const storage = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    const res = await submitPackagingApply(client, createPackagingOutbox(storage), args, "F4T-1");
    expect(res.kind).toBe("failed");
    expect(res.kind === "failed" && res.message).toMatch(/#F4T-1 could not be saved or kept/);
  });

  it("does not queue a refusal", async () => {
    const { client } = fakeClient(() => ({ data: null, error: { message: "packaging: forbidden_role", code: "P0001" } }));
    const outbox = createPackagingOutbox(null);
    const res = await submitPackagingApply(client, outbox, args, "F4T-1");
    expect(res.kind).toBe("failed");
    expect(res.kind === "failed" && res.message).toMatch(/#F4T-1 was not recorded: This account is not allowed/);
    expect(outbox.pendingCount()).toBe(0);
  });
});

describe("drainPackagingOutbox", () => {
  it("resends queued requests unchanged and clears them on any definitive answer", async () => {
    const outbox = createPackagingOutbox(null);
    outbox.enqueue({ args, orderNumber: "F4T-1" });
    outbox.enqueue({ args: { ...args, requestId: "apply:ev-2", eventId: "ev-2" }, orderNumber: "F4T-2" });

    const down = fakeClient(() => offline);
    expect(await drainPackagingOutbox(down.client, outbox)).toBe(0);
    expect(outbox.pendingCount()).toBe(2);

    let n = 0;
    const up = fakeClient(() => (n++ === 0 ? applied : { data: null, error: { message: "packaging: event_not_found", code: "P0001" } }));
    expect(await drainPackagingOutbox(up.client, outbox)).toBe(2);
    expect(outbox.pendingCount()).toBe(0);
    expect(up.calls.map((c) => c.p_request_id)).toEqual(["apply:ev-1", "apply:ev-2"]);
  });
});
