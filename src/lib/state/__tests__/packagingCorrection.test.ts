import { describe, expect, it } from "vitest";
import type { RuleSetBody } from "@/lib/domain/packaging/ruleSet";
import type { PackagingPick } from "@/lib/repository/supabase/orderPackaging";
import { afterOverride, beginCorrectionSubmit, cancelCorrection, editCorrectionDraft, startCorrection } from "../packagingCorrection";

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
    expect(s.editing).toEqual({
      draft: [{ key: "BOX-S", product_id: "p-s", label: "Small", qty: 1 }],
      busy: false, message: null, requestId: "override:1", submitted: null, uncertain: false,
    });
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
    expect(next.editing).toMatchObject({ draft: [{ key: "BOX-L" }], busy: false, requestId: "override:1", uncertain: true });
    expect(next.editing?.message).toMatch(/may already be saved/);
    expect(next.editing?.message).not.toMatch(/Nothing was changed/);
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

// Review r1: a save whose answer was lost may have committed on the server.
describe("review r1: uncertain correction saves", () => {
  const large = { key: "BOX-L", product_id: "p-l", label: "Large", qty: 1 };
  const small = { key: "BOX-S", product_id: "p-s", label: "Small", qty: 1 };

  function sentThenLost() {
    let s = startCorrection(pick(), ruleSet, "override:1");
    s = editCorrectionDraft(s, () => [large]);
    const first = beginCorrectionSubmit(s, "Used a different box", "staff-a")!;
    expect(first.request).toEqual({ requestId: "override:1", expectedRevision: 1, target: { "p-l": 1 }, reason: "Used a different box", staffId: "staff-a" });
    // The server committed it, but the response never arrived.
    return { request: first.request, state: afterOverride(first.state, { outcome: "network_error", message: "offline" }, ruleSet, "override:2") };
  }

  it("freezes the draft and the editor while the outcome is unknown", () => {
    const { state } = sentThenLost();
    expect(state.editing).toMatchObject({ uncertain: true, busy: false, draft: [large] });
    expect(editCorrectionDraft(state, () => [small])).toBe(state);
    expect(cancelCorrection(state)).toBe(state);
  });

  it("a retry resends exactly the first request, even if another reason or worker is used", () => {
    const { request, state } = sentThenLost();
    const retry = beginCorrectionSubmit(state, "Box was damaged", "staff-b")!;
    expect(retry.request).toEqual(request);
    // The server replays the committed change: the editor closes on the new pick.
    const done = afterOverride(retry.state, { outcome: "overridden", pick: pick({ revision: 2, state: "overridden", target: { "p-l": 1 } }), replayed: true, deltas: {}, unposted: [], negative: [] }, ruleSet, "override:3");
    expect(done).toMatchObject({ editing: null, pick: { revision: 2, target: { "p-l": 1 } } });
  });

  it("does not send twice while a save is in flight", () => {
    const s = startCorrection(pick(), ruleSet, "override:1");
    const first = beginCorrectionSubmit(s, "Used a different box", null)!;
    expect(beginCorrectionSubmit(first.state, "Used a different box", null)).toBeNull();
    expect(editCorrectionDraft(first.state, () => [small])).toBe(first.state);
  });

  it("after the retry resolves, a fresh correction uses a fresh id and the current revision", () => {
    const { state } = sentThenLost();
    const retry = beginCorrectionSubmit(state, "x", null)!;
    const resolved = afterOverride(retry.state, { outcome: "overridden", pick: pick({ revision: 2, target: { "p-l": 1 } }), replayed: true, deltas: {}, unposted: [], negative: [] }, ruleSet, "override:3");
    let fresh = startCorrection(resolved.pick, ruleSet, "override:4");
    fresh = editCorrectionDraft(fresh, () => [small]);
    expect(beginCorrectionSubmit(fresh, "Recorded by mistake", "staff-a")!.request).toEqual({
      requestId: "override:4", expectedRevision: 2, target: { "p-s": 1 }, reason: "Recorded by mistake", staffId: "staff-a",
    });
  });

  it("a conflict answer to the retry unfreezes with the latest pick and a new id", () => {
    const { state } = sentThenLost();
    const retry = beginCorrectionSubmit(state, "x", null)!;
    const next = afterOverride(retry.state, { outcome: "conflict", pick: pick({ revision: 3, target: { "p-s": 2 } }) }, ruleSet, "override:5");
    expect(next.editing).toMatchObject({ uncertain: false, submitted: null, requestId: "override:5", draft: [{ key: "BOX-S", qty: 2 }] });
    expect(beginCorrectionSubmit(next, "Needed an extra box", null)!.request).toMatchObject({ requestId: "override:5", expectedRevision: 3 });
  });

  it("losing the retry's answer too keeps the same frozen request", () => {
    const { request, state } = sentThenLost();
    const retry = beginCorrectionSubmit(state, "x", null)!;
    const lostAgain = afterOverride(retry.state, { outcome: "network_error", message: "offline" }, ruleSet, "override:6");
    expect(beginCorrectionSubmit(lostAgain, "y", "z")!.request).toEqual(request);
  });
});
