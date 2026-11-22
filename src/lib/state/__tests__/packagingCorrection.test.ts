import { describe, expect, it } from "vitest";
import type { RuleSetBody } from "@/lib/domain/packaging/ruleSet";
import type { PackagingPick } from "@/lib/repository/supabase/orderPackaging";
import { afterOverride, startCorrection } from "../packagingCorrection";

const ruleSet: RuleSetBody = {
  schema_version: 1,
  catalogue: [
    { key: "BOX-S", product_id: "p-s", label: "Small" },
    { key: "BOX-L", product_id: "p-l", label: "Large" },
  ],
  rules: [],
  examples: [],
};

const pick = (over: Partial<PackagingPick> = {}): PackagingPick => ({
  id: "pkp-1", location: "au", order_number: "F4T-1", packing_point: "dispatch", shipment_key: "orig",
  state: "auto", stock_state: "posted", rule_set_id: "prs-1", rule_set_version: 1,
  predicted: { "p-s": 1 }, target: { "p-s": 1 }, posted: { "p-s": 1 }, revision: 1,
  created_at: "2026-11-22T00:00:00Z", updated_at: "2026-11-22T00:00:00Z",
  ...over,
});
const posting = { deltas: {}, unposted: [], negative: [] };

describe("correcting a saved pick", () => {
  it("starts from what is saved", () => {
    const s = startCorrection(pick(), ruleSet, "override:1");
    expect(s.editing).toEqual({ draft: [{ key: "BOX-S", product_id: "p-s", label: "Small", qty: 1 }], busy: false, message: null, requestId: "override:1" });
  });

  it("success closes the editor and keeps the new pick", () => {
    const s = startCorrection(pick(), ruleSet, "override:1");
    const next = afterOverride(s, { outcome: "overridden", pick: pick({ revision: 2, state: "overridden", target: { "p-l": 1 } }), replayed: false, ...posting }, ruleSet, "override:2");
    expect(next.editing).toBeNull();
    expect(next.pick).toMatchObject({ revision: 2, target: { "p-l": 1 } });
  });

  it("a replayed success and an unchanged target close the editor too", () => {
    const s = startCorrection(pick(), ruleSet, "override:1");
    expect(afterOverride(s, { outcome: "overridden", pick: pick({ revision: 2 }), replayed: true, ...posting }, ruleSet, "x").editing).toBeNull();
    expect(afterOverride(s, { outcome: "unchanged", pick: pick() }, ruleSet, "x").editing).toBeNull();
  });

  it("a conflict shows the latest pick, restarts the draft from it and takes a new request id", () => {
    const s = startCorrection(pick(), ruleSet, "override:1");
    const next = afterOverride(s, { outcome: "conflict", pick: pick({ revision: 4, target: { "p-l": 2 } }) }, ruleSet, "override:2");
    expect(next.pick.revision).toBe(4);
    expect(next.editing).toMatchObject({ draft: [{ key: "BOX-L", qty: 2 }], busy: false, requestId: "override:2" });
    expect(next.editing?.message).toMatch(/another device/);
  });

  it("no connection keeps the draft and the SAME request id, so a retry replays", () => {
    const s = startCorrection(pick(), ruleSet, "override:1");
    const edited = { ...s, editing: { ...s.editing!, draft: [{ key: "BOX-L", product_id: "p-l", label: "Large", qty: 1 }], busy: true } };
    const next = afterOverride(edited, { outcome: "network_error", message: "offline" }, ruleSet, "override:2");
    expect(next.pick.revision).toBe(1);
    expect(next.editing).toMatchObject({ draft: [{ key: "BOX-L" }], busy: false, requestId: "override:1" });
    expect(next.editing?.message).toMatch(/Nothing was changed/);
  });

  it("a refusal shows the reason and keeps the draft", () => {
    const s = startCorrection(pick(), ruleSet, "override:1");
    const next = afterOverride(s, { outcome: "rejected", code: "not_in_catalogue", message: "That packaging item is not in the site's list." }, ruleSet, "override:2");
    expect(next.editing).toMatchObject({ busy: false, message: "That packaging item is not in the site's list.", requestId: "override:2" });
  });

  it("ignores an answer that arrives after the editor was closed", () => {
    const closed = { pick: pick(), editing: null };
    expect(afterOverride(closed, { outcome: "network_error", message: "x" }, ruleSet, "y")).toBe(closed);
  });
});
