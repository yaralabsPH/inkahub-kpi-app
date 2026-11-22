import { describe, expect, it } from "vitest";
import type { PackagingContents, PieceGroup } from "../contents";
import { evaluatePackaging, examplesAllowActivation, runExamples } from "../evaluate";
import { parseRuleSetBody, type PackagingRule, type RuleSetBody } from "../ruleSet";

// A made-up rule set for tests only. These are NOT Inka's real box rules.
const catalogue: RuleSetBody["catalogue"] = [
  { key: "BOX-S", product_id: "test-box-s", label: "Test box small" },
  { key: "BOX-L", product_id: "test-box-l", label: "Test box large" },
  { key: "BOX-XL", product_id: "test-box-xl", label: "Test box extra large", packing_points: ["a0_framed"] },
  { key: "TUBE", product_id: "test-tube", label: "Test tube", legacy_barcode: "+99=" },
];

const rules: PackagingRule[] = [
  { id: "r-a1-pair", packing_point: "dispatch", kinds: ["framed"], sizes: ["A1"], min_pieces: 2, max_pieces: 2,
    output: { mode: "fixed", packages: [{ key: "BOX-L", qty: 1 }] } },
  { id: "r-a1-one", packing_point: "dispatch", kinds: ["framed"], sizes: ["A1"], max_pieces: 1,
    output: { mode: "fixed", packages: [{ key: "BOX-S", qty: 1 }] } },
  { id: "r-small", packing_point: "dispatch", kinds: ["framed", "picture_frame"], sizes: ["A3", "A4"],
    output: { mode: "per_capacity", capacity: 3, package: "BOX-S" } },
  { id: "r-a0", packing_point: "a0_framed", kinds: ["framed"], sizes: ["A0"],
    output: { mode: "per_capacity", capacity: 2, package: "BOX-XL" } },
  { id: "r-tube-a0", packing_point: "unframed", kinds: ["unframed", "free_print", "accessory"], contains_sizes: ["A0"],
    output: { mode: "fixed", packages: [{ key: "TUBE", qty: 2 }] } },
  { id: "r-tube", packing_point: "unframed", kinds: ["unframed", "free_print"],
    output: { mode: "fixed", packages: [{ key: "TUBE", qty: 1 }] } },
];

const ruleSet: RuleSetBody = { schema_version: 1, catalogue, rules, examples: [] };

const contents = (...pieces: PieceGroup[]): PackagingContents => ({ pieces, unclassified: [] });
const qtys = (ev: ReturnType<typeof evaluatePackaging>) => Object.fromEntries(ev.packages.map((p) => [p.key, p.qty]));

describe("evaluatePackaging", () => {
  it("applies a fixed-output rule", () => {
    const ev = evaluatePackaging(ruleSet, "dispatch", contents({ kind: "framed", size: "A1", pieces: 1 }));
    expect(ev.status).toBe("resolved");
    expect(ev.packages).toEqual([{ key: "BOX-S", product_id: "test-box-s", label: "Test box small", qty: 1 }]);
    expect(ev.firedRuleIds).toEqual(["r-a1-one"]);
  });

  it("respects priority order and piece-count ranges", () => {
    const ev = evaluatePackaging(ruleSet, "dispatch", contents({ kind: "framed", size: "A1", pieces: 2 }));
    expect(qtys(ev)).toEqual({ "BOX-L": 1 });
    expect(ev.firedRuleIds).toEqual(["r-a1-pair"]);
  });

  it("is unresolved when the count fits no rule", () => {
    const ev = evaluatePackaging(ruleSet, "dispatch", contents({ kind: "framed", size: "A1", pieces: 3 }));
    expect(ev.status).toBe("unresolved");
    expect(ev.packages).toEqual([]);
    expect(ev.unassigned).toEqual([{ kind: "framed", size: "A1", pieces: 3 }]);
    expect(ev.reason).toMatch(/No box rule/);
  });

  it("rounds capacity rules up", () => {
    const one = evaluatePackaging(ruleSet, "dispatch", contents({ kind: "framed", size: "A3", pieces: 3 }));
    expect(qtys(one)).toEqual({ "BOX-S": 1 });
    const two = evaluatePackaging(ruleSet, "dispatch", contents({ kind: "framed", size: "A3", pieces: 2 }, { kind: "picture_frame", size: "A4", pieces: 2 }));
    expect(qtys(two)).toEqual({ "BOX-S": 2 });
  });

  it("combines several rules on a mixed order and sums the same package", () => {
    const ev = evaluatePackaging(ruleSet, "dispatch", contents(
      { kind: "framed", size: "A1", pieces: 1 },
      { kind: "framed", size: "A4", pieces: 1 },
    ));
    expect(ev.status).toBe("resolved");
    expect(qtys(ev)).toEqual({ "BOX-S": 2 });
    expect(ev.firedRuleIds).toEqual(["r-a1-one", "r-small"]);
  });

  it("applies nothing when only part of the order matches (all or nothing)", () => {
    const ev = evaluatePackaging(ruleSet, "dispatch", contents(
      { kind: "framed", size: "A1", pieces: 1 },
      { kind: "framed", size: "A2", pieces: 1 },
    ));
    expect(ev.status).toBe("unresolved");
    expect(ev.packages).toEqual([]);
    expect(ev.firedRuleIds).toEqual(["r-a1-one"]);
    expect(ev.unassigned).toEqual([{ kind: "framed", size: "A2", pieces: 1 }]);
  });

  it("only uses rules for the given packing point", () => {
    const ev = evaluatePackaging(ruleSet, "a0_framed", contents({ kind: "framed", size: "A0", pieces: 3 }));
    expect(qtys(ev)).toEqual({ "BOX-XL": 2 });
    const wrong = evaluatePackaging(ruleSet, "dispatch", contents({ kind: "framed", size: "A0", pieces: 1 }));
    expect(wrong.status).toBe("unresolved");
  });

  it("honours contains-size and lets size-less rules take accessories", () => {
    const withA0 = evaluatePackaging(ruleSet, "unframed", contents(
      { kind: "unframed", size: "A3", pieces: 1 },
      { kind: "unframed", size: "A0", pieces: 1 },
      { kind: "accessory", size: null, pieces: 1 },
    ));
    expect(qtys(withA0)).toEqual({ TUBE: 2 });
    const without = evaluatePackaging(ruleSet, "unframed", contents({ kind: "unframed", size: "A3", pieces: 4 }));
    expect(qtys(without)).toEqual({ TUBE: 1 });
    // The plain tube rule does not take accessories, so this is left over.
    const leftover = evaluatePackaging(ruleSet, "unframed", contents(
      { kind: "unframed", size: "A3", pieces: 1 },
      { kind: "accessory", size: null, pieces: 1 },
    ));
    expect(leftover.status).toBe("unresolved");
  });

  it("does not let a sized rule take a size-less piece", () => {
    const ev = evaluatePackaging(ruleSet, "dispatch", contents({ kind: "framed", size: null, pieces: 1 }));
    expect(ev.status).toBe("unresolved");
  });

  it("resolves empty contents to no packaging", () => {
    const ev = evaluatePackaging(ruleSet, "dispatch", contents());
    expect(ev).toMatchObject({ status: "resolved", packages: [], firedRuleIds: [], reason: null });
  });

  it("is unresolved when a line could not be classified, even if rules cover the rest", () => {
    const ev = evaluatePackaging(ruleSet, "dispatch", {
      pieces: [{ kind: "framed", size: "A1", pieces: 1 }],
      unclassified: ["LEGACY-1"],
    });
    expect(ev.status).toBe("unresolved");
    expect(ev.packages).toEqual([]);
    expect(ev.unclassified).toEqual(["LEGACY-1"]);
    expect(ev.reason).toMatch(/recognised/);
  });

  it("is unresolved when a rule would need more than the per-pick limit", () => {
    const ev = evaluatePackaging(ruleSet, "dispatch", contents({ kind: "framed", size: "A4", pieces: 100 }));
    expect(ev.status).toBe("unresolved");
    expect(ev.reason).toMatch(/More than 20/);
  });

  it("is unresolved with an empty rule set", () => {
    const ev = evaluatePackaging({ schema_version: 1, catalogue: [], rules: [], examples: [] }, "dispatch",
      contents({ kind: "framed", size: "A1", pieces: 1 }));
    expect(ev.status).toBe("unresolved");
  });

  it("does not mutate its inputs and is deterministic", () => {
    const c = contents({ kind: "framed", size: "A1", pieces: 2 });
    const before = JSON.stringify([ruleSet, c]);
    const a = evaluatePackaging(ruleSet, "dispatch", c);
    const b = evaluatePackaging(ruleSet, "dispatch", c);
    expect(a).toEqual(b);
    expect(JSON.stringify([ruleSet, c])).toBe(before);
  });
});

describe("examples", () => {
  const withExamples = (examples: RuleSetBody["examples"]): RuleSetBody => ({ ...ruleSet, examples });

  it("passes matching examples regardless of package order", () => {
    const rs = withExamples([
      { id: "e1", packing_point: "dispatch", contents: [{ kind: "framed", size: "A1", pieces: 2 }], expect: [{ key: "BOX-L", qty: 1 }] },
      { id: "e2", packing_point: "dispatch", contents: [{ kind: "framed", size: "A2", pieces: 1 }], expect: "unresolved" },
    ]);
    expect(runExamples(rs).map((r) => r.pass)).toEqual([true, true]);
    expect(examplesAllowActivation(rs)).toBe(true);
  });

  it("fails on wrong quantity, wrong package, or unexpected unresolved", () => {
    const rs = withExamples([
      { id: "e1", packing_point: "dispatch", contents: [{ kind: "framed", size: "A1", pieces: 2 }], expect: [{ key: "BOX-L", qty: 2 }] },
      { id: "e2", packing_point: "dispatch", contents: [{ kind: "framed", size: "A1", pieces: 1 }], expect: [{ key: "BOX-L", qty: 1 }] },
      { id: "e3", packing_point: "dispatch", contents: [{ kind: "framed", size: "A2", pieces: 1 }], expect: [{ key: "BOX-S", qty: 1 }] },
      { id: "e4", packing_point: "dispatch", contents: [{ kind: "framed", size: "A1", pieces: 1 }], expect: "unresolved" },
    ]);
    const results = runExamples(rs);
    expect(results.map((r) => r.pass)).toEqual([false, false, false, false]);
    expect(results[2].actual).toBe("unresolved");
    expect(examplesAllowActivation(rs)).toBe(false);
  });

  it("does not allow activation with no examples", () => {
    expect(examplesAllowActivation(ruleSet)).toBe(false);
  });
});

describe("parseRuleSetBody", () => {
  it("accepts a valid rule set", () => {
    expect(parseRuleSetBody(JSON.parse(JSON.stringify(ruleSet)))).toEqual({ ok: true, body: ruleSet });
  });

  it("rejects the wrong shape", () => {
    expect(parseRuleSetBody(null).ok).toBe(false);
    expect(parseRuleSetBody({ schema_version: 2, catalogue: [], rules: [], examples: [] }).ok).toBe(false);
    expect(parseRuleSetBody({ ...ruleSet, rules: [{ ...rules[0], kinds: [] }] }).ok).toBe(false);
    expect(parseRuleSetBody({ ...ruleSet, rules: [{ ...rules[3], output: { mode: "per_capacity", capacity: 0, package: "BOX-XL" } }] }).ok).toBe(false);
  });

  it("reports structural problems", () => {
    const bad: RuleSetBody = {
      schema_version: 1,
      catalogue: [...catalogue, { key: "BOX-S", product_id: "x", label: "Dup" }, { key: "T2", product_id: "y", label: "T2", legacy_barcode: "+99=" }],
      rules: [
        rules[0],
        { ...rules[0], min_pieces: 5, max_pieces: 2 },
        { id: "r-missing", packing_point: "dispatch", kinds: ["framed"], output: { mode: "per_capacity", capacity: 1, package: "NOPE" } },
        { id: "r-contains", packing_point: "dispatch", kinds: ["framed"], sizes: ["A1"], contains_sizes: ["A0"],
          output: { mode: "fixed", packages: [{ key: "BOX-S", qty: 1 }, { key: "BOX-S", qty: 1 }] } },
      ],
      examples: [
        { id: "e", packing_point: "dispatch", contents: [{ kind: "framed", size: "A1", pieces: 1 }], expect: [{ key: "GHOST", qty: 1 }] },
        { id: "e", packing_point: "dispatch", contents: [{ kind: "framed", size: "A1", pieces: 1 }], expect: "unresolved" },
      ],
    };
    const res = parseRuleSetBody(bad);
    expect(res.ok).toBe(false);
    const text = res.ok ? "" : res.problems.join("\n");
    expect(text).toMatch(/"BOX-S" is listed twice/);
    expect(text).toMatch(/Barcode "\+99="/);
    expect(text).toMatch(/Rule id "r-a1-pair" is used twice/);
    expect(text).toMatch(/minimum pieces is larger/);
    expect(text).toMatch(/"NOPE" is not in the catalogue/);
    expect(text).toMatch(/names a size the rule does not take/);
    expect(text).toMatch(/Example id "e" is used twice/);
    expect(text).toMatch(/"GHOST" is not in the catalogue/);
  });
});
