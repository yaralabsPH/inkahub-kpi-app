import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { checkDraft } from "@/lib/domain/packaging/editing";
import { updateExample, updateRule } from "@/lib/domain/packaging/ruleEditing";
import { emptyRuleSetBody, type RuleSetBody } from "@/lib/domain/packaging/ruleSet";
import { PackagingRulesView, type DraftEditorState } from "../PackagingRulesView";
import { RuleEditor } from "../RuleEditor";
import { ExamplesTable, RuleSimulatorView, type RuleSimulatorViewProps } from "../RuleSimulator";

const noop = () => {};
const products = [{ id: "p-s", code: "TEST-BOX-S" }, { id: "p-l", code: "TEST-BOX-L" }];
const known = new Set(products.map((p) => p.id));

// Synthetic rule set; not real box rules.
const body: RuleSetBody = {
  schema_version: 1,
  catalogue: [
    { key: "S", product_id: "p-s", label: "Small box" },
    { key: "L", product_id: "p-l", label: "Large box" },
  ],
  rules: [
    { id: "r1", label: "One frame", packing_point: "dispatch", kinds: ["framed"], max_pieces: 1, output: { mode: "fixed", packages: [{ key: "S", qty: 1 }] } },
    { id: "r2", packing_point: "unframed", kinds: ["unframed"], sizes: ["A3", "A4"], output: { mode: "per_capacity", capacity: 5, package: "L" } },
  ],
  examples: [
    { id: "e1", label: "Single A1", packing_point: "dispatch", contents: [{ kind: "framed", size: "A1", pieces: 1 }], expect: [{ key: "S", qty: 1 }] },
    { id: "e2", packing_point: "dispatch", contents: [{ kind: "framed", size: "A1", pieces: 4 }], expect: "unresolved" },
  ],
};

/** Opening tag of the element whose text or attribute contains `label`, without its class attribute. */
function tag(markup: string, label: string, element = "button"): string {
  const at = markup.indexOf(label);
  expect(at, `"${label}" not found`).toBeGreaterThan(-1);
  const start = markup.lastIndexOf(`<${element}`, at);
  return markup.slice(start, markup.indexOf(">", at) + 1).replace(/ class="[^"]*"/, "");
}

describe("RuleEditor", () => {
  const html = (b: RuleSetBody, busy = false) => renderToStaticMarkup(<RuleEditor body={b} busy={busy} onChange={noop} />);

  it("lists the rules in order with their settings", () => {
    const out = html(body);
    expect(out.indexOf('data-rule="r1"')).toBeLessThan(out.indexOf('data-rule="r2"'));
    expect(out).toContain('value="One frame"');
    expect(out).toContain('aria-label="Highest piece count for rule 1"');
    expect(out).toContain('aria-label="Pieces per package for rule 2"');
    expect(out).toContain("for every");
    expect(out).not.toContain("data-rule-issues");
    expect(out).toContain("Add a Dispatch rule");
    expect(out).toContain("Add a A0 Framed rule");
  });

  it("cannot move the first rule up or the last rule down", () => {
    const out = html(body);
    expect(tag(out, 'aria-label="Move rule 1 up"')).toContain("disabled");
    expect(tag(out, 'aria-label="Move rule 1 down"')).not.toContain("disabled");
    expect(tag(out, 'aria-label="Move rule 2 down"')).toContain("disabled");
    expect(tag(out, 'aria-label="Move rule 2 up"')).not.toContain("disabled");
  });

  it("shows what is wrong next to the rule that is wrong", () => {
    const bad = updateRule(body, 0, { kinds: [], min_pieces: 3, max_pieces: 2, output: { mode: "fixed", packages: [{ key: "GONE", qty: 0 }] } });
    const out = html(bad);
    expect(out).toContain('data-rule-issues="r1"');
    expect(out).not.toContain('data-rule-issues="r2"');
    expect(out).toContain("Tick at least one kind of item.");
    expect(out).toContain("The lowest piece count is larger than the highest.");
    expect(out).toContain("Missing item (GONE)");
    expect(out).toContain("Quantity must be 1 to 20.");
  });

  it("explains the empty state and locks while saving", () => {
    expect(html(emptyRuleSetBody())).toContain("No rules yet.");
    expect(tag(html(body, true), 'aria-label="Delete rule 1"')).toContain("disabled");
  });
});

describe("ExamplesTable", () => {
  const html = (b: RuleSetBody, ready = true) => renderToStaticMarkup(<ExamplesTable body={b} ready={ready} busy={false} onChange={noop} />);

  it("shows each example passing, including one that should be flagged", () => {
    const out = html(body);
    expect(out).toContain('data-example="e1" data-result="pass"');
    expect(out).toContain('data-example="e2" data-result="pass"');
    expect(out).toContain('value="Single A1"');
    expect(tag(out, 'aria-label="example 2 should be flagged"', "input")).toContain("checked");
    expect(tag(out, 'aria-label="example 1 should be flagged"', "input")).not.toContain("checked");
  });

  it("shows a failing example with what the rules gave and what was expected", () => {
    const out = html(updateExample(body, 0, { expect: [{ key: "L", qty: 1 }] }));
    expect(out).toContain('data-example="e1" data-result="fail"');
    expect(out).toContain("Fails. The rules give: ×1 Small box. Expected: ×1 Large box.");
    expect(out).toContain('data-example="e2" data-result="pass"');
  });

  it("shows example mistakes and no result until they are fixed", () => {
    const out = html(updateExample(body, 0, { contents: [{ kind: "framed", size: "A1", pieces: 0 }] }));
    expect(out).toContain('data-example-issues="e1"');
    expect(out).toContain("Pieces must be a whole number of 1 or more.");
    expect(out).toContain('data-example="e1" data-result="none"');
  });

  it("shows no results while the draft has other problems", () => {
    const out = html(body, false);
    expect(out).toContain('data-result="none"');
    expect(out).not.toContain("Passes.");
    expect(out).toContain("Fix the marked problems to see the result.");
  });

  it("explains the empty state", () => {
    expect(html(emptyRuleSetBody())).toContain("No examples yet. At least one is needed to activate.");
  });
});

describe("RuleSimulatorView", () => {
  const html = (over: Partial<RuleSimulatorViewProps> = {}) =>
    renderToStaticMarkup(
      <RuleSimulatorView body={body} ready busy={false} point="dispatch" contents={[{ kind: "framed", size: "A1", pieces: 1 }]}
        onPoint={noop} onContents={noop} onSaveExample={noop} {...over} />,
    );

  it("shows the packages and the rule that fired", () => {
    const out = html();
    expect(out).toContain('data-sim="resolved"');
    expect(out).toContain("×1 Small box");
    expect(out).toContain("Rules that fired: Rule 1 (One frame).");
    expect(out).toContain("Keep this as an example");
  });

  it("uses the per-capacity rule, rounding up", () => {
    const out = html({ point: "unframed", contents: [{ kind: "unframed", size: "A3", pieces: 4 }, { kind: "unframed", size: "A4", pieces: 2 }] });
    expect(out).toContain("×2 Large box");
    expect(out).toContain("Rules that fired: Rule 2.");
  });

  it("shows a flagged parcel with what no rule covered", () => {
    const out = html({ contents: [{ kind: "framed", size: "A1", pieces: 1 }, { kind: "accessory", size: null, pieces: 2 }] });
    expect(out).toContain('data-sim="unresolved"');
    expect(out).toContain("Flagged, nothing deducted.");
    expect(out).toContain("No box rule covers every item.");
    expect(out).toContain("Not covered by any rule: 2 × Accessory.");
    expect(out).not.toContain("Small box</div>");
  });

  it("asks for a parcel, and waits while the draft has problems", () => {
    expect(html({ contents: [] })).toContain("Add at least one item with a piece count.");
    const blocked = html({ ready: false });
    expect(blocked).toContain("Fix the marked problems to try a parcel.");
    expect(blocked).not.toContain("data-sim=");
  });
});

describe("draft editor with rules and examples", () => {
  const draft = (b: RuleSetBody, over: Partial<DraftEditorState> = {}): DraftEditorState => ({
    id: "prs-2", basedOnVersion: null, body: b, note: "", dirty: false, check: checkDraft(b, known), ...over,
  });
  const html = (d: DraftEditorState) =>
    renderToStaticMarkup(
      <PackagingRulesView siteLabel="Australia" mode="scan" ruleSets={[]} products={products} draft={d} busy={false} message={null}
        onSetMode={noop} onNewDraft={noop} onOpenDraft={noop} onCloseDraft={noop} onChangeNote={noop} onAddItem={noop}
        onUpdateItem={noop} onRemoveItem={noop} onEditBody={noop} onSaveDraft={noop} onActivate={noop} />,
    );

  it("shows the rules, examples and simulator inside the draft", () => {
    const out = html(draft(body));
    for (const s of ["rules", "examples", "simulator"]) expect(out).toContain(`data-section="${s}"`);
    expect(out).toContain("2 rules · 2 examples · all examples pass");
    expect(tag(out, "Activate this version")).not.toContain("disabled");
  });

  it("a failing example blocks activation and is marked", () => {
    const out = html(draft(updateExample(body, 0, { expect: [{ key: "L", qty: 1 }] })));
    expect(out).toContain('data-example="e1" data-result="fail"');
    expect(tag(out, "Activate this version")).toContain("disabled");
    expect(out).toContain("Every example must pass before activating.");
  });

  it("a rule mistake blocks saving and points at the marked rule", () => {
    const out = html(draft(updateRule(body, 0, { kinds: [] }), { dirty: true }));
    expect(tag(out, "Save draft")).toContain("disabled");
    expect(out).toContain("Some rules or examples need fixing. They are marked in red above.");
    expect(out).not.toContain("rules.0.kinds");
    expect(out).toContain("Tick at least one kind of item.");
  });
});
