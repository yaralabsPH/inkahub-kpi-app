import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  applyPackaging,
  applyRequestId,
  classifyError,
  findPick,
  loadPackagingConfig,
  overridePackaging,
  retryPackaging,
  setPackagingMode,
  shipmentKeyFor,
  type ApplyArgs,
} from "../orderPackaging";

type Answer = { data: unknown; error: { message?: string; code?: string } | null };

/** Minimal fake of the bits of supabase-js this module uses. */
function fakeClient(opts: {
  rpc?: (fn: string, params: Record<string, unknown>) => Answer | Promise<Answer>;
  tables?: Record<string, Answer>;
}): { client: SupabaseClient; calls: Array<{ fn: string; params: Record<string, unknown> }> } {
  const calls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  const client = {
    rpc: async (fn: string, params: Record<string, unknown>) => {
      calls.push({ fn, params });
      if (!opts.rpc) throw new Error("no rpc");
      return opts.rpc(fn, params);
    },
    from: (table: string) => {
      const answer = opts.tables?.[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order"]) builder[m] = () => builder;
      builder.maybeSingle = async () => answer;
      builder.then = (resolve: (a: Answer) => unknown) => resolve(answer);
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const pick = {
  id: "pkp-1", location: "au", order_number: "F4T-1", packing_point: "dispatch", shipment_key: "orig",
  state: "auto", stock_state: "posted", rule_set_id: "prs-1", rule_set_version: 3,
  input_snapshot: {}, predicted: { "box-a": 1 }, target: { "box-a": 1 }, posted: { "box-a": 1 },
  revision: 1, source_event_id: "ev-1", staff_id: null, created_at: "2026-11-22T00:00:00Z", updated_at: "2026-11-22T00:00:00Z",
};

const args: ApplyArgs = {
  location: "au", requestId: applyRequestId("ev-1"), eventId: "ev-1", ruleSetId: "prs-1",
  resolved: true, predicted: { "box-a": 1 }, target: { "box-a": 1 }, snapshot: { note: "t" },
};

const validBody = {
  schema_version: 1,
  catalogue: [{ key: "A", product_id: "box-a", label: "Box A" }],
  rules: [],
  examples: [],
};

describe("classifyError", () => {
  it("maps packaging refusals to rejected with a friendly message", () => {
    expect(classifyError({ message: "packaging: forbidden_role", code: "P0001" })).toMatchObject({ outcome: "rejected", code: "forbidden_role" });
    expect(classifyError({ message: "packaging: not_in_catalogue: box-x", code: "P0001" })).toMatchObject({ outcome: "rejected", code: "not_in_catalogue" });
  });
  it("treats no-code and transient database errors as retryable", () => {
    expect(classifyError({ message: "TypeError: Failed to fetch" }).outcome).toBe("network_error");
    expect(classifyError({ message: "x", code: "57014" }).outcome).toBe("network_error");
    expect(classifyError({ message: "x", code: "40001" }).outcome).toBe("network_error");
    expect(classifyError({ message: "x", code: "08006" }).outcome).toBe("network_error");
  });
  it("treats a missing function or table as unavailable, not retryable", () => {
    expect(classifyError({ message: "Could not find the function", code: "PGRST202" })).toMatchObject({ outcome: "rejected", code: "unavailable" });
    expect(classifyError({ message: "relation does not exist", code: "42P01" })).toMatchObject({ outcome: "rejected", code: "unavailable" });
  });
  it("treats other database errors as a final refusal", () => {
    expect(classifyError({ message: "duplicate key", code: "23505" })).toMatchObject({ outcome: "rejected", code: "server_error" });
  });
});

describe("applyPackaging", () => {
  it("sends the expected parameters and parses an applied result", async () => {
    const { client, calls } = fakeClient({
      rpc: () => ({ data: { status: "applied", pick, deltas: { "box-a": 1 }, unposted: [], negative: [] }, error: null }),
    });
    const out = await applyPackaging(client, args);
    expect(out).toMatchObject({ outcome: "applied", replayed: false, deltas: { "box-a": 1 } });
    expect(calls).toEqual([{ fn: "packaging_apply", params: {
      p_location: "au", p_request_id: "apply:ev-1", p_event_id: "ev-1", p_rule_set_id: "prs-1",
      p_resolved: true, p_predicted: { "box-a": 1 }, p_target: { "box-a": 1 }, p_input_snapshot: { note: "t" },
    } }]);
  });
  it("parses replayed and already-applied results", async () => {
    const replay = fakeClient({ rpc: () => ({ data: { status: "applied", pick, deltas: {}, unposted: [], negative: [], replayed: true }, error: null }) });
    expect(await applyPackaging(replay.client, args)).toMatchObject({ outcome: "applied", replayed: true });
    const again = fakeClient({ rpc: () => ({ data: { status: "already_applied", pick }, error: null }) });
    expect(await applyPackaging(again.client, args)).toMatchObject({ outcome: "already_applied", pick: { id: "pkp-1" } });
  });
  it("reports short stock details", async () => {
    const { client } = fakeClient({
      rpc: () => ({ data: { status: "applied", pick: { ...pick, stock_state: "unposted", posted: {} }, deltas: {}, unposted: ["box-a"], negative: [] }, error: null }),
    });
    expect(await applyPackaging(client, args)).toMatchObject({ outcome: "applied", unposted: ["box-a"], pick: { stock_state: "unposted" } });
  });
  it("turns refusals, thrown errors and malformed answers into outcomes", async () => {
    const refused = fakeClient({ rpc: () => ({ data: null, error: { message: "packaging: event_not_found", code: "P0001" } }) });
    expect(await applyPackaging(refused.client, args)).toMatchObject({ outcome: "rejected", code: "event_not_found" });
    const thrown = fakeClient({ rpc: () => { throw new Error("offline"); } });
    expect(await applyPackaging(thrown.client, args)).toEqual({ outcome: "network_error", message: "offline" });
    const junk = fakeClient({ rpc: () => ({ data: { status: "applied", pick: { id: 1 } }, error: null }) });
    expect(await applyPackaging(junk.client, args)).toMatchObject({ outcome: "rejected", code: "malformed_response" });
    const odd = fakeClient({ rpc: () => ({ data: { status: "exploded", pick }, error: null }) });
    expect(await applyPackaging(odd.client, args)).toMatchObject({ outcome: "rejected", code: "malformed_response" });
  });
});

describe("overridePackaging / retryPackaging", () => {
  const o = { location: "au", requestId: "override:1234", pickId: "pkp-1", expectedRevision: 1, target: { "box-b": 1 }, reason: "Used a different box", staffId: null };
  it("parses overridden, unchanged and conflict", async () => {
    const ok = fakeClient({ rpc: () => ({ data: { status: "overridden", pick: { ...pick, revision: 2, state: "overridden" }, deltas: { "box-a": -1, "box-b": 1 }, unposted: [], negative: [] }, error: null }) });
    expect(await overridePackaging(ok.client, o)).toMatchObject({ outcome: "overridden", deltas: { "box-a": -1, "box-b": 1 }, pick: { revision: 2 } });
    expect(ok.calls[0]).toMatchObject({ fn: "packaging_override", params: { p_expected_revision: 1, p_reason: "Used a different box", p_staff_id: null } });
    const same = fakeClient({ rpc: () => ({ data: { status: "unchanged", pick }, error: null }) });
    expect(await overridePackaging(same.client, o)).toMatchObject({ outcome: "unchanged" });
    const stale = fakeClient({ rpc: () => ({ data: { status: "conflict", pick: { ...pick, revision: 5 } }, error: null }) });
    expect(await overridePackaging(stale.client, o)).toMatchObject({ outcome: "conflict", pick: { revision: 5 } });
  });
  it("parses a retry", async () => {
    const { client } = fakeClient({ rpc: () => ({ data: { status: "retried", pick, deltas: { "box-a": 1 }, unposted: [], negative: [] }, error: null }) });
    expect(await retryPackaging(client, { location: "au", requestId: "retry:12345", pickId: "pkp-1" })).toMatchObject({ outcome: "retried", deltas: { "box-a": 1 } });
  });
});

describe("loadPackagingConfig", () => {
  it("is scan with no settings row, on error, or when mode is scan", async () => {
    expect((await loadPackagingConfig(fakeClient({}).client, "au")).mode).toBe("scan");
    const missing = fakeClient({ tables: { packaging_settings: { data: null, error: { code: "42P01", message: "nope" } } } });
    expect(await loadPackagingConfig(missing.client, "au")).toMatchObject({ mode: "scan", warning: null });
    const scan = fakeClient({ tables: { packaging_settings: { data: { mode: "scan", mode_changed_at: "2026-11-01T00:00:00Z" }, error: null } } });
    expect(await loadPackagingConfig(scan.client, "au")).toMatchObject({ mode: "scan", warning: null, modeChangedAt: "2026-11-01T00:00:00Z" });
  });
  it("is auto with a valid active rule set", async () => {
    const { client } = fakeClient({ tables: {
      packaging_settings: { data: { mode: "auto", mode_changed_at: "2026-11-01T00:00:00Z" }, error: null },
      packaging_rule_sets: { data: { id: "prs-1", version: 3, body: validBody }, error: null },
    } });
    const cfg = await loadPackagingConfig(client, "au");
    expect(cfg).toMatchObject({ mode: "auto", warning: null, ruleSet: { id: "prs-1", version: 3 } });
    expect(cfg.ruleSet?.body.catalogue[0].product_id).toBe("box-a");
  });
  it("falls back to scan with a warning when auto cannot run", async () => {
    const settings = { data: { mode: "auto", mode_changed_at: "2026-11-01T00:00:00Z" }, error: null };
    const none = fakeClient({ tables: { packaging_settings: settings } });
    expect(await loadPackagingConfig(none.client, "au")).toMatchObject({ mode: "scan", ruleSet: null });
    expect((await loadPackagingConfig(none.client, "au")).warning).toMatch(/no active box rules/);
    const broken = fakeClient({ tables: { packaging_settings: settings, packaging_rule_sets: { data: { id: "prs-1", version: 3, body: { schema_version: 9 } }, error: null } } });
    expect((await loadPackagingConfig(broken.client, "au")).warning).toMatch(/could not be read/);
    const err = fakeClient({ tables: { packaging_settings: settings, packaging_rule_sets: { data: null, error: { message: "boom" } } } });
    expect(await loadPackagingConfig(err.client, "au")).toMatchObject({ mode: "scan" });
  });
});

describe("findPick / helpers", () => {
  const q = { location: "au", orderNumber: "F4T-1", packingPoint: "dispatch" as const, shipmentKey: "orig" };
  it("returns the pick, null when absent, undefined when unreadable", async () => {
    expect(await findPick(fakeClient({ tables: { packaging_picks: { data: pick, error: null } } }).client, q)).toMatchObject({ id: "pkp-1" });
    expect(await findPick(fakeClient({}).client, q)).toBeNull();
    expect(await findPick(fakeClient({ tables: { packaging_picks: { data: null, error: { message: "x" } } } }).client, q)).toBeUndefined();
    expect(await findPick(fakeClient({ tables: { packaging_picks: { data: { id: 5 }, error: null } } }).client, q)).toBeUndefined();
  });
  it("builds shipment keys and request ids", () => {
    expect(shipmentKeyFor(null)).toBe("orig");
    expect(shipmentKeyFor("")).toBe("orig");
    expect(shipmentKeyFor("case-9")).toBe("cs:case-9");
    expect(applyRequestId("ev-1")).toBe("apply:ev-1");
  });
  it("parses set-mode answers", async () => {
    const ok = fakeClient({ rpc: () => ({ data: { location: "au", mode: "auto" }, error: null }) });
    expect(await setPackagingMode(ok.client, { location: "au", mode: "auto" })).toEqual({ outcome: "ok", value: "auto" });
    const no = fakeClient({ rpc: () => ({ data: null, error: { message: "packaging: no_active_rule_set", code: "P0001" } }) });
    expect(await setPackagingMode(no.client, { location: "au", mode: "auto" })).toMatchObject({ outcome: "rejected", code: "no_active_rule_set" });
  });
});
