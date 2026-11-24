import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApplyArgs } from "@/lib/repository/supabase/orderPackaging";
import type { RuleSetBody } from "@/lib/domain/packaging/ruleSet";
import { capturePackaging, predictPackaging, tapPackage, type PackagingCapture } from "@/lib/domain/packaging/session";
import { createPackagingOutbox } from "../packagingOutbox";
import { drainPackagingOutbox, submitPackagingApply } from "../packagingSubmit";

type Answer = { data: unknown; error: { message?: string; code?: string } | null };

function fakeClient(answer: () => Answer, userId: string | null = "u-1"): { client: SupabaseClient; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    rpc: async (_fn: string, params: Record<string, unknown>) => {
      calls.push(params);
      return answer();
    },
    auth: { getSession: async () => ({ data: { session: userId ? { user: { id: userId } } : null } }) },
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
const expired: Answer = { data: null, error: { message: "JWT expired", code: "PGRST301" } };

/** A working device store, so a request really is kept across reloads. */
function deviceStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

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
    const outbox = createPackagingOutbox(deviceStorage());
    expect(await submitPackagingApply(client, outbox, args, "F4T-1")).toEqual({ kind: "queued" });
    expect(outbox.list().map((e) => [e.args.requestId, e.orderNumber])).toEqual([["apply:ev-1", "F4T-1"]]);
  });

  it("fails loudly when the device cannot keep the request", async () => {
    const { client } = fakeClient(() => offline);
    const storage = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    const res = await submitPackagingApply(client, createPackagingOutbox(storage), args, "F4T-1");
    expect(res.kind).toBe("failed");
    expect(res.kind === "failed" && res.message).toMatch(/#F4T-1 was not confirmed and could not be kept on this device/);
  });

  it("without device storage, an unanswered request is reported as not safely kept (never 'queued')", async () => {
    const { client } = fakeClient(() => offline);
    const res = await submitPackagingApply(client, createPackagingOutbox(null), args, "F4T-1");
    expect(res.kind).toBe("failed");
  });

  it("stores the request BEFORE the first send, so closing the page mid-send loses nothing", async () => {
    const storage = deviceStorage();
    const outbox = createPackagingOutbox(storage);
    let seenDuringSend = -1;
    const { client } = fakeClient(() => {
      seenDuringSend = createPackagingOutbox(storage).pendingCount(); // a fresh page reading the same device
      return applied;
    });
    await submitPackagingApply(client, outbox, args, "F4T-1");
    expect(seenDuringSend).toBe(1);
    expect(outbox.pendingCount()).toBe(0); // settled, so removed
  });

  it("an expired session keeps the request; signing in again sends the SAME request id once", async () => {
    const storage = deviceStorage();
    const outbox = createPackagingOutbox(storage);
    const down = fakeClient(() => expired);
    expect(await submitPackagingApply(down.client, outbox, args, "F4T-1")).toEqual({ kind: "queued" });
    expect(await drainPackagingOutbox(down.client, outbox, { location: "au" })).toBe(0);
    expect(outbox.pendingCount()).toBe(1);
    const up = fakeClient(() => applied);
    expect(await drainPackagingOutbox(up.client, outbox, { location: "au" })).toBe(1);
    expect(up.calls.map((c) => c.p_request_id)).toEqual(["apply:ev-1"]);
    expect(outbox.pendingCount()).toBe(0);
  });

  it("another account signing in cannot send or discard the request", async () => {
    const outbox = createPackagingOutbox(deviceStorage());
    await submitPackagingApply(fakeClient(() => offline, "u-1").client, outbox, args, "F4T-1");
    const other = fakeClient(() => ({ data: null, error: { message: "packaging: forbidden_role", code: "P0001" } }), "u-2");
    expect(await drainPackagingOutbox(other.client, outbox, { location: "au" })).toBe(0);
    expect(other.calls).toHaveLength(0);
    expect(outbox.pendingCount()).toBe(1);
  });

  it("nothing is sent when the signed-in account is unknown", async () => {
    const outbox = createPackagingOutbox(deviceStorage());
    await submitPackagingApply(fakeClient(() => offline, "u-1").client, outbox, args, "F4T-1");
    const anon = fakeClient(() => applied, null);
    expect(await drainPackagingOutbox(anon.client, outbox, { location: "au" })).toBe(0);
    expect(anon.calls).toHaveLength(0);
    expect(outbox.pendingCount()).toBe(1);
  });

  it("a settled refusal for the right account moves to the rejected list with its reason", async () => {
    const outbox = createPackagingOutbox(deviceStorage());
    await submitPackagingApply(fakeClient(() => offline, "u-1").client, outbox, args, "F4T-1");
    const refuse = fakeClient(() => ({ data: null, error: { message: "packaging: event_not_found", code: "P0001" } }), "u-1");
    expect(await drainPackagingOutbox(refuse.client, outbox, { location: "au" })).toBe(1);
    expect(outbox.pendingCount()).toBe(0);
    expect(outbox.listRejected().map((e) => e.reason)).toEqual(["The completion was not found."]);
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
    const outbox = createPackagingOutbox(deviceStorage());
    outbox.enqueue({ args, orderNumber: "F4T-1", userId: "u-1" });
    outbox.enqueue({ args: { ...args, requestId: "apply:ev-2", eventId: "ev-2" }, orderNumber: "F4T-2", userId: "u-1" });

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

// Review r1: Complete captures the packaging before any await, then submits
// that capture with the saved event id, whatever the station shows by then.
describe("review r1: completion while the order on screen changes", () => {
  const rules: RuleSetBody = {
    schema_version: 1,
    catalogue: [
      { key: "BOX-S", product_id: "p-s", label: "Small", packing_points: ["dispatch"] },
      { key: "BOX-L", product_id: "p-l", label: "Large", packing_points: ["dispatch"] },
    ],
    rules: [
      { id: "a1", packing_point: "dispatch", kinds: ["framed"], sizes: ["A1"], max_pieces: 1, output: { mode: "fixed", packages: [{ key: "BOX-S", qty: 1 }] } },
      { id: "a2", packing_point: "dispatch", kinds: ["framed"], sizes: ["A2"], max_pieces: 1, output: { mode: "fixed", packages: [{ key: "BOX-L", qty: 1 }] } },
    ],
    examples: [],
  };
  const ruleSet = { id: "prs-1", version: 2 };
  const view = (sku: string) => {
    const prediction = predictPackaging(rules, "dispatch", [{ sku, quantity: 1 }], { replacement: false });
    return { prediction, chosen: prediction.evaluation.packages };
  };
  const later = <T,>(value: T) => new Promise<T>((r) => setTimeout(() => r(value), 5));

  /** The Complete flow's order of operations, with the live view read through a ref. */
  async function complete(live: { current: ReturnType<typeof view> | null; order: string | null }, onAwait: () => void) {
    const captured: PackagingCapture | null =
      live.current && live.order ? capturePackaging({ orderNumber: live.order, ruleSet, ...live.current }) : null;
    const eventId = await later("ev-A"); // insertEvent
    onAwait();
    await later(null); // component deduction
    return { captured, eventId };
  }

  it("records A's box when B is loaded during A's save", async () => {
    const live = { current: view("INKA-ABC0001-A1-FB"), order: "A" as string | null };
    const { captured, eventId } = await complete(live, () => {
      live.current!.chosen.push({ key: "BOX-L", product_id: "p-l", label: "Large", qty: 9 }); // same arrays mutated
      live.current = view("INKA-ABC0002-A2-FB");
      live.order = "B";
    });
    expect(captured).not.toBeNull();
    const { client, calls } = fakeClient(() => applied);
    const outbox = createPackagingOutbox(null);
    await submitPackagingApply(client, outbox, { location: "au", requestId: `apply:${eventId}`, eventId, ...captured!.payload }, captured!.orderNumber);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ p_event_id: "ev-A", p_target: { "p-s": 1 } });
    expect(captured!.orderNumber).toBe("A");
  });

  it("still records A when the screen is cleared during A's save, and keeps A's manual change", async () => {
    const a = view("INKA-ABC0001-A1-FB");
    const live = { current: { ...a, chosen: tapPackage(a.chosen, rules.catalogue[1]) }, order: "A" as string | null };
    const { captured } = await complete(live as { current: ReturnType<typeof view> | null; order: string | null }, () => {
      (live as { current: unknown }).current = null;
      live.order = null;
    });
    expect(captured?.payload).toMatchObject({ resolved: true, predicted: { "p-s": 1 }, target: { "p-l": 1 } });
    // Offline: the queued entry is A's, under A's event id.
    const outbox = createPackagingOutbox(null);
    await submitPackagingApply(fakeClient(() => offline).client, outbox, { location: "au", requestId: "apply:ev-A", eventId: "ev-A", ...captured!.payload }, captured!.orderNumber);
    expect(outbox.list().map((e) => [e.orderNumber, e.args.target])).toEqual([["A", { "p-l": 1 }]]);
  });

  it("a capture cannot be changed afterwards", () => {
    const captured = capturePackaging({ orderNumber: "A", ruleSet, ...view("INKA-ABC0001-A1-FB") });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.payload)).toBe(true);
  });
});
