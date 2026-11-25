import { describe, expect, it } from "vitest";
import { checkDraft } from "../editing";
import { runExamples } from "../evaluate";
import {
  addExample,
  addRule,
  describeGroup,
  describePackages,
  exampleFromSimulation,
  exampleIssues,
  isEditableBody,
  moveRule,
  optionalCount,
  removeExample,
  removeRule,
  requiredCount,
  ruleIssues,
  simulate,
  splitDraftProblems,
  toggled,
  updateExample,
  updateRule,
  withKind,
  withOutputMode,
} from "../ruleEditing";
import { emptyRuleSetBody, parseRuleSetBody, type RuleSetBody } from "../ruleSet";

// Synthetic rule set; not real box rules.
const body: RuleSetBody = {
  schema_version: 1,
  catalogue: [
    { key: "S", product_id: "p-s", label: "Small box" },
    { key: "L", product_id: "p-l", label: "Large box" },
    { key: "T", product_id: "p-t", label: "Tube" },
  ],
  rules: [
    { id: "r1", label: "One frame", packing_point: "dispatch", kinds: ["framed"], max_pieces: 1, output: { mode: "fixed", packages: [{ key: "S", qty: 1 }] } },
    { id: "r2", packing_point: "dispatch", kinds: ["framed"], min_pieces: 2, max_pieces: 2, output: { mode: "fixed", packages: [{ key: "L", qty: 1 }] } },
    { id: "r3", packing_point: "unframed", kinds: ["unframed"], output: { mode: "per_capacity", capacity: 5, package: "T" } },
  ],
  examples: [{ id: "e1", packing_point: "dispatch", contents: [{ kind: "framed", size: "A1", pieces: 1 }], expect: [{ key: "S", qty: 1 }] }],
};
const known = new Set(["p-s", "p-l", "p-t"]);

describe("rule list", () => {
  it("adds a valid rule at the bottom with a fresh id", () => {
    const b = addRule(body, "a0_framed");
    expect(b.rules).toHaveLength(4);
    expect(b.rules[3]).toMatchObject({ id: "r4", packing_point: "a0_framed", output: { mode: "fixed", packages: [{ key: "S", qty: 1 }] } });
    expect(parseRuleSetBody(b).ok).toBe(true);
    expect(addRule(removeRule(body, 1), "dispatch").rules.map((r) => r.id)).toEqual(["r1", "r3", "r2"]);
  });

  it("a rule added before any packaging item exists asks for one", () => {
    const b = addRule(emptyRuleSetBody(), "dispatch");
    expect(ruleIssues(b, 0)).toEqual(["Choose a packaging item."]);
    expect(checkDraft(b, known).problems.length).toBeGreaterThan(0);
  });

  it("moves rules and ignores moves off either end", () => {
    expect(moveRule(body, 0, 1).rules.map((r) => r.id)).toEqual(["r2", "r1", "r3"]);
    expect(moveRule(body, 2, -1).rules.map((r) => r.id)).toEqual(["r1", "r3", "r2"]);
    expect(moveRule(body, 0, -1)).toBe(body);
    expect(moveRule(body, 2, 1)).toBe(body);
  });

  it("order is priority: moving a rule changes what an order gets", () => {
    const greedy: RuleSetBody = { ...body, rules: [...body.rules, { id: "r9", packing_point: "dispatch", kinds: ["framed"], output: { mode: "fixed", packages: [{ key: "L", qty: 2 }] } }] };
    expect(runExamples(greedy)[0].pass).toBe(true);
    const first = moveRule(moveRule(moveRule(greedy, 3, -1), 2, -1), 1, -1);
    expect(first.rules[0].id).toBe("r9");
    expect(runExamples(first)[0].pass).toBe(false);
  });

  it("edits a rule and drops emptied optional fields", () => {
    const b = updateRule(body, 0, { label: "", sizes: [], contains_sizes: [], max_pieces: undefined });
    expect(b.rules[0]).toEqual({ id: "r1", packing_point: "dispatch", kinds: ["framed"], output: body.rules[0].output });
    expect(Object.keys(b.rules[0])).not.toContain("label");
    expect(b.rules[1]).toBe(body.rules[1]);
  });

  it("switches output mode keeping the package", () => {
    expect(withOutputMode(body.rules[0], "per_capacity", "T")).toEqual({ mode: "per_capacity", capacity: 1, package: "S" });
    expect(withOutputMode(body.rules[2], "fixed", "S")).toEqual({ mode: "fixed", packages: [{ key: "T", qty: 1 }] });
    expect(withOutputMode(body.rules[0], "fixed", "T")).toBe(body.rules[0].output);
  });

  it("ticks values in standard order and reads number boxes", () => {
    expect(toggled(["A3"], "A1", ["A0", "A1", "A2", "A3"])).toEqual(["A1", "A3"]);
    expect(toggled(["A1", "A3"], "A1", ["A0", "A1", "A2", "A3"])).toEqual(["A3"]);
    expect(toggled(undefined, "A0", ["A0", "A1"])).toEqual(["A0"]);
    expect(optionalCount("")).toBeUndefined();
    expect(optionalCount(" 3 ")).toBe(3);
    expect(optionalCount("abc")).toBeUndefined();
    expect(requiredCount("")).toBe(0);
  });
});

describe("rule validation", () => {
  it("a good rule has no issues", () => {
    for (let i = 0; i < body.rules.length; i++) expect(ruleIssues(body, i)).toEqual([]);
  });

  it("names each mistake in plain words", () => {
    const bad = updateRule(body, 0, {
      kinds: [], min_pieces: 3, max_pieces: 2, sizes: ["A1"], contains_sizes: ["A2"],
      output: { mode: "fixed", packages: [{ key: "S", qty: 0 }, { key: "S", qty: 1 }, { key: "GONE", qty: 1 }, { key: "", qty: 21 }] },
    });
    expect(ruleIssues(bad, 0)).toEqual([
      "Tick at least one kind of item.",
      "The lowest piece count is larger than the highest.",
      '"Only when the parcel includes" names a size this rule does not take.',
      "Quantity must be 1 to 20.",
      "The same packaging item is listed twice.",
      'Packaging item "GONE" is no longer in the list above.',
      "Choose a packaging item.",
    ]);
    expect(checkDraft(bad, known).problems.length).toBeGreaterThan(0);
  });

  it("checks piece counts, an empty package list, capacity and duplicate ids", () => {
    expect(ruleIssues(updateRule(body, 0, { min_pieces: 0 }), 0)).toContain("Piece counts must be whole numbers of 1 or more.");
    expect(ruleIssues(updateRule(body, 0, { max_pieces: 1.5 }), 0)).toContain("Piece counts must be whole numbers of 1 or more.");
    expect(ruleIssues(updateRule(body, 0, { output: { mode: "fixed", packages: [] } }), 0)).toEqual(["Add at least one packaging item."]);
    expect(ruleIssues(updateRule(body, 2, { output: { mode: "per_capacity", capacity: 0, package: "" } }), 2)).toEqual([
      "Choose a packaging item.",
      "Pieces per package must be 1 to 500.",
    ]);
    const dup = updateRule(body, 1, { id: "r1" });
    expect(ruleIssues(dup, 0)[0]).toMatch(/same id/);
    expect(ruleIssues(dup, 2)).toEqual([]);
  });

  it("falls back to the schema for anything else", () => {
    const long = updateRule(body, 0, { label: "x".repeat(121) });
    expect(ruleIssues(long, 0)).toHaveLength(1);
    expect(ruleIssues(long, 0)[0]).toMatch(/^label: /);
  });

  it("every rule the checks pass also passes the saved-draft check", () => {
    expect(body.rules.every((_, i) => ruleIssues(body, i).length === 0)).toBe(true);
    expect(parseRuleSetBody(body).ok).toBe(true);
  });
});

describe("examples", () => {
  it("adds, edits and removes examples", () => {
    let b = addExample(body, "unframed");
    expect(b.examples[1]).toEqual({ id: "e2", packing_point: "unframed", contents: [{ kind: "framed", size: "A1", pieces: 1 }], expect: "unresolved" });
    b = updateExample(b, 1, { label: "Six prints", contents: [{ kind: "unframed", size: "A3", pieces: 6 }], expect: [{ key: "T", qty: 2 }] });
    expect(runExamples(b).map((r) => r.pass)).toEqual([true, true]);
    expect(updateExample(b, 1, { label: "" }).examples[1]).not.toHaveProperty("label");
    expect(removeExample(b, 0).examples.map((e) => e.id)).toEqual(["e2"]);
  });

  it("a failing example blocks activation until it is fixed", () => {
    const failing = updateExample(body, 0, { expect: [{ key: "L", qty: 1 }] });
    expect(exampleIssues(failing, 0)).toEqual([]);
    const check = checkDraft(failing, known);
    expect(check.problems).toEqual([]);
    expect(check.canActivate).toBe(false);
    expect(check.activationHint).toBe("Every example must pass before activating.");
    expect(checkDraft(updateExample(failing, 0, { expect: [{ key: "S", qty: 1 }] }), known).canActivate).toBe(true);
  });

  it("no examples blocks activation", () => {
    expect(checkDraft(removeExample(body, 0), known)).toMatchObject({ canActivate: false, activationHint: "Add at least one example before activating." });
  });

  it("names example mistakes", () => {
    const bad = updateExample(body, 0, { contents: [{ kind: "framed", size: null, pieces: 0 }], expect: [{ key: "GONE", qty: 1 }] });
    expect(exampleIssues(bad, 0)).toEqual([
      "Pieces must be a whole number of 1 or more.",
      "Choose a size.",
      'Packaging item "GONE" is no longer in the list above.',
    ]);
    expect(exampleIssues(updateExample(body, 0, { contents: [] }), 0)).toEqual(["Add at least one item to the parcel."]);
  });

  it("accessories carry no size; other kinds get one", () => {
    expect(withKind({ kind: "framed", size: "A2", pieces: 1 }, "accessory")).toEqual({ kind: "accessory", size: null, pieces: 1 });
    expect(withKind({ kind: "accessory", size: null, pieces: 2 }, "unframed")).toEqual({ kind: "unframed", size: "A1", pieces: 2 });
    expect(withKind({ kind: "framed", size: "A3", pieces: 1 }, "unframed").size).toBe("A3");
  });
});

describe("simulator", () => {
  it("shows packages and the rule that fired", () => {
    const one = simulate(body, "dispatch", [{ kind: "framed", size: "A1", pieces: 1 }]);
    expect(one.evaluation.status).toBe("resolved");
    expect(one.evaluation.packages).toEqual([{ key: "S", product_id: "p-s", label: "Small box", qty: 1 }]);
    expect(one.fired).toEqual([{ id: "r1", position: 1, label: "One frame" }]);

    const two = simulate(body, "dispatch", [{ kind: "framed", size: "A1", pieces: 1 }, { kind: "framed", size: "A3", pieces: 1 }]);
    expect(two.evaluation.packages.map((p) => `${p.key}x${p.qty}`)).toEqual(["Lx1"]);
    expect(two.fired).toEqual([{ id: "r2", position: 2, label: null }]);

    expect(simulate(body, "unframed", [{ kind: "unframed", size: "A3", pieces: 11 }]).evaluation.packages[0]).toMatchObject({ key: "T", qty: 3 });
  });

  it("flags a parcel no rule covers and lists what was left", () => {
    const three = simulate(body, "dispatch", [{ kind: "framed", size: "A1", pieces: 3 }]);
    expect(three.evaluation).toMatchObject({ status: "unresolved", packages: [], reason: "No box rule covers every item." });
    expect(three.evaluation.unassigned).toEqual([{ kind: "framed", size: "A1", pieces: 3 }]);

    // A partial match is flagged too, and deducts nothing.
    const mixed = simulate(body, "dispatch", [{ kind: "framed", size: "A1", pieces: 1 }, { kind: "accessory", size: null, pieces: 1 }]);
    expect(mixed.evaluation.status).toBe("unresolved");
    expect(mixed.evaluation.packages).toEqual([]);
    expect(mixed.fired.map((f) => f.id)).toEqual(["r1"]);
    expect(mixed.evaluation.unassigned).toEqual([{ kind: "accessory", size: null, pieces: 1 }]);
  });

  it("ignores rows with no pieces", () => {
    const sim = simulate(body, "dispatch", [{ kind: "framed", size: "A1", pieces: 1 }, { kind: "framed", size: "A2", pieces: 0 }]);
    expect(sim.evaluation.packages.map((p) => p.key)).toEqual(["S"]);
  });

  it("keeps a simulated parcel as a passing example", () => {
    const b = exampleFromSimulation(body, "dispatch", [{ kind: "framed", size: "A2", pieces: 2 }, { kind: "framed", size: "A1", pieces: 0 }]);
    expect(b.examples[1]).toEqual({ id: "e2", packing_point: "dispatch", contents: [{ kind: "framed", size: "A2", pieces: 2 }], expect: [{ key: "L", qty: 1 }] });
    const flagged = exampleFromSimulation(b, "dispatch", [{ kind: "framed", size: "A1", pieces: 3 }]);
    expect(flagged.examples[2].expect).toBe("unresolved");
    expect(runExamples(flagged).every((r) => r.pass)).toBe(true);
    expect(exampleFromSimulation(body, "dispatch", [])).toBe(body);
  });

  it("describes parcels and packages", () => {
    expect(describeGroup({ kind: "framed", size: "A1", pieces: 2 })).toBe("2 × A1 Framed print");
    expect(describeGroup({ kind: "accessory", size: null, pieces: 1 })).toBe("1 × Accessory");
    expect(describePackages([{ key: "S", qty: 2 }, { key: "ZZ", qty: 1 }], body)).toBe("×2 Small box, ×1 ZZ");
    expect(describePackages([], body)).toBe("No packaging");
    expect(describePackages("unresolved", body)).toBe("Flagged (no automatic pick)");
  });
});

describe("draft problems and stored drafts", () => {
  it("separates problems shown next to a rule or example from the rest", () => {
    const split = splitDraftProblems([
      "rules.0.kinds: Array must contain at least 1 element(s)",
      'Rule "One frame": minimum pieces is larger than maximum pieces.',
      "Example e1: packaging item \"X\" is not in the catalogue.",
      "examples.2.contents: Required",
      'Packaging item "S" is listed twice.',
    ]);
    expect(split).toEqual({ general: ['Packaging item "S" is listed twice.'], markedBelow: 4 });
  });

  it("only opens stored drafts the editor can draw", () => {
    expect(isEditableBody(body)).toBe(true);
    expect(isEditableBody(emptyRuleSetBody())).toBe(true);
    expect(isEditableBody(addRule(emptyRuleSetBody(), "dispatch"))).toBe(true); // invalid but drawable
    expect(isEditableBody(null)).toBe(false);
    expect(isEditableBody({ schema_version: 1, catalogue: [], rules: [] })).toBe(false);
    expect(isEditableBody({ ...body, rules: [{ id: "r", kinds: ["framed"] }] })).toBe(false);
    expect(isEditableBody({ ...body, rules: [{ id: "r", kinds: ["framed"], output: { mode: "other" } }] })).toBe(false);
    expect(isEditableBody({ ...body, examples: [{ id: "e", contents: [], expect: "maybe" }] })).toBe(false);
  });
});
