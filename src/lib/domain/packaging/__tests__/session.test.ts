import { describe, expect, it } from "vitest";
import type { RuleSetBody } from "../ruleSet";
import {
  addPackage,
  adjustPackage,
  alternativesFor,
  buildApplyPayload,
  packageFromLegacyBarcode,
  pickedFromQuantities,
  pickStatus,
  predictPackaging,
  REPLACEMENT_REASON,
  stationPackingPoint,
  tapPackage,
} from "../session";

// Synthetic rule set; not real box rules.
const ruleSet: RuleSetBody = {
  schema_version: 1,
  catalogue: [
    { key: "BOX-S", product_id: "p-s", label: "Small", legacy_barcode: "+50=", packing_points: ["dispatch"] },
    { key: "BOX-L", product_id: "p-l", label: "Large", legacy_barcode: "+51=", packing_points: ["dispatch"] },
    { key: "BOX-XL", product_id: "p-xl", label: "Extra large", legacy_barcode: "+48=", packing_points: ["a0_framed"] },
    { key: "TUBE", product_id: "p-t", label: "Tube" },
  ],
  rules: [
    { id: "one-a1", packing_point: "dispatch", kinds: ["framed"], sizes: ["A1"], max_pieces: 1, output: { mode: "fixed", packages: [{ key: "BOX-S", qty: 1 }] } },
  ],
  examples: [],
};
const [S, L, , T] = ruleSet.catalogue;
const A1 = "INKA-ABC0001-A1-FB";
const A2 = "INKA-ABC0002-A2-FB";

describe("stationPackingPoint", () => {
  it("maps packing stations and nothing else", () => {
    expect(stationPackingPoint("dispatch")).toBe("dispatch");
    expect(stationPackingPoint("a0_framed")).toBe("a0_framed");
    expect(stationPackingPoint("unframed")).toBe("unframed");
    expect(stationPackingPoint("framed")).toBeNull();
    expect(stationPackingPoint("")).toBeNull();
  });
});

describe("predictPackaging", () => {
  it("predicts from the order lines for this packing point", () => {
    const p = predictPackaging(ruleSet, "dispatch", [{ sku: A1, quantity: 1 }], { replacement: false });
    expect(p.evaluation.status).toBe("resolved");
    expect(p.evaluation.packages).toEqual([{ key: "BOX-S", product_id: "p-s", label: "Small", qty: 1 }]);
    expect(pickStatus(p, p.evaluation.packages)).toBe("auto");
  });

  it("flags an order no rule covers", () => {
    const p = predictPackaging(ruleSet, "dispatch", [{ sku: A2, quantity: 1 }], { replacement: false });
    expect(p.evaluation.status).toBe("unresolved");
    expect(pickStatus(p, [])).toBe("flagged");
    expect(pickStatus(p, tapPackage([], L))).toBe("changed");
  });

  it("resolves to nothing when this station packs none of the order", () => {
    const p = predictPackaging(ruleSet, "unframed", [{ sku: A1, quantity: 1 }], { replacement: false });
    expect(p.evaluation).toMatchObject({ status: "resolved", packages: [] });
  });

  it("never predicts for replacement work", () => {
    const p = predictPackaging(ruleSet, "dispatch", [{ sku: A1, quantity: 1 }], { replacement: true });
    expect(p.evaluation).toMatchObject({ status: "unresolved", packages: [], reason: REPLACEMENT_REASON });
    expect(pickStatus(p, [])).toBe("flagged");
  });
});

describe("choosing packages", () => {
  it("one tap replaces an empty or single-line pick", () => {
    expect(tapPackage([], L)).toEqual([{ key: "BOX-L", product_id: "p-l", label: "Large", qty: 1 }]);
    expect(tapPackage([{ key: "BOX-S", product_id: "p-s", label: "Small", qty: 3 }], L)).toEqual([{ key: "BOX-L", product_id: "p-l", label: "Large", qty: 1 }]);
  });

  it("a tap on a multi-line pick adds one", () => {
    const two = addPackage(tapPackage([], S), L);
    expect(tapPackage(two, L).map((p) => [p.key, p.qty])).toEqual([["BOX-S", 1], ["BOX-L", 2]]);
    expect(tapPackage(two, T).map((p) => p.key)).toEqual(["BOX-S", "BOX-L", "TUBE"]);
  });

  it("adjusts quantities, removes at zero, and respects the limits", () => {
    let pick = tapPackage([], S);
    pick = adjustPackage(pick, "BOX-S", 1);
    expect(pick[0].qty).toBe(2);
    expect(adjustPackage(pick, "BOX-S", 100)[0].qty).toBe(20);
    expect(adjustPackage(pick, "BOX-S", -2)).toEqual([]);
    expect(adjustPackage(pick, "NOPE", 1)).toEqual(pick);
    let many = pick;
    for (let i = 0; i < 30; i++) many = addPackage(many, { key: `K${i}`, product_id: `p${i}`, label: `L${i}` });
    expect(many).toHaveLength(10);
    let full = tapPackage([], S);
    for (let i = 0; i < 30; i++) full = addPackage(full, S);
    expect(full[0].qty).toBe(20);
  });

  it("offers only the items allowed at the packing point", () => {
    expect(alternativesFor(ruleSet, "dispatch").map((c) => c.key)).toEqual(["BOX-S", "BOX-L", "TUBE"]);
    expect(alternativesFor(ruleSet, "a0_framed").map((c) => c.key)).toEqual(["BOX-XL", "TUBE"]);
  });

  it("maps legacy barcodes for this packing point only", () => {
    expect(packageFromLegacyBarcode(ruleSet, "+51=", "dispatch")?.key).toBe("BOX-L");
    expect(packageFromLegacyBarcode(ruleSet, "+48=", "dispatch")).toBeNull();
    expect(packageFromLegacyBarcode(ruleSet, "+99=", "dispatch")).toBeNull();
  });

  it("labels a saved pick from the catalogue, falling back to the product id", () => {
    expect(pickedFromQuantities(ruleSet, { "p-l": 2, gone: 1, zero: 0 })).toEqual([
      { key: "BOX-L", product_id: "p-l", label: "Large", qty: 2 },
      { key: "gone", product_id: "gone", label: "gone", qty: 1 },
    ]);
    expect(pickedFromQuantities(null, { "p-l": 1 })[0].label).toBe("p-l");
  });
});

describe("buildApplyPayload", () => {
  it("sends prediction and choice as product quantities, with a snapshot", () => {
    const prediction = predictPackaging(ruleSet, "dispatch", [{ sku: A1, quantity: 1 }], { replacement: false });
    const auto = buildApplyPayload({ ruleSet: { id: "prs-1", version: 4 }, prediction, chosen: prediction.evaluation.packages });
    expect(auto).toMatchObject({ ruleSetId: "prs-1", resolved: true, predicted: { "p-s": 1 }, target: { "p-s": 1 } });
    expect(auto.snapshot).toMatchObject({
      rule_set_version: 4, packing_point: "dispatch", fired_rule_ids: ["one-a1"],
      contents: [{ kind: "framed", size: "A1", pieces: 1 }],
      chosen: [{ key: "BOX-S", label: "Small", qty: 1 }],
    });

    const changed = buildApplyPayload({ ruleSet: { id: "prs-1", version: 4 }, prediction, chosen: tapPackage(prediction.evaluation.packages, L) });
    expect(changed).toMatchObject({ resolved: true, predicted: { "p-s": 1 }, target: { "p-l": 1 } });
  });

  it("marks an unresolved pick with an empty target", () => {
    const prediction = predictPackaging(ruleSet, "dispatch", [{ sku: A2, quantity: 1 }], { replacement: false });
    const payload = buildApplyPayload({ ruleSet: { id: "prs-1", version: 4 }, prediction, chosen: [] });
    expect(payload).toMatchObject({ resolved: false, predicted: {}, target: {} });
    expect(payload.snapshot.reason).toMatch(/No box rule/);
  });
});
