import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  addCatalogueItem,
  canManagePackagingRules,
  checkDraft,
  draftFrom,
  removeCatalogueItem,
  toggleCataloguePoint,
  updateCatalogueItem,
} from "@/lib/domain/packaging/editing";
import { emptyRuleSetBody, type RuleSetBody } from "@/lib/domain/packaging/ruleSet";
import type { RuleSetRow } from "@/lib/repository/supabase/orderPackaging";
import { PackagingRulesView, type DraftEditorState, type PackagingRulesViewProps } from "../PackagingRulesView";

const noop = () => {};
const products = [{ id: "p-s", code: "TEST-BOX-S" }, { id: "p-l", code: "TEST-BOX-L" }];
const known = new Set(products.map((p) => p.id));

// Synthetic rule set; not real box rules.
const body: RuleSetBody = {
  schema_version: 1,
  catalogue: [
    { key: "S", product_id: "p-s", label: "Small box", legacy_barcode: "+50=" },
    { key: "L", product_id: "p-l", label: "Large box", packing_points: ["dispatch"] },
  ],
  rules: [{ id: "r1", packing_point: "dispatch", kinds: ["framed"], sizes: ["A1"], max_pieces: 1, output: { mode: "fixed", packages: [{ key: "S", qty: 1 }] } }],
  examples: [{ id: "e1", packing_point: "dispatch", contents: [{ kind: "framed", size: "A1", pieces: 1 }], expect: [{ key: "S", qty: 1 }] }],
};

const row = (over: Partial<RuleSetRow>): RuleSetRow => ({
  id: "prs-1", location: "au", version: 1, status: "active", body, note: "First rules",
  created_at: "2026-11-22T00:00:00Z", activated_at: "2026-11-22T01:00:00Z", ...over,
});

const draftState = (b: RuleSetBody, over: Partial<DraftEditorState> = {}): DraftEditorState => ({
  id: "prs-2", basedOnVersion: null, body: b, note: "", dirty: false, check: checkDraft(b, known), ...over,
});

function html(over: Partial<PackagingRulesViewProps> = {}): string {
  return renderToStaticMarkup(
    <PackagingRulesView
      siteLabel="Australia" mode="scan" ruleSets={[]} products={products} draft={null} busy={false} message={null}
      onSetMode={noop} onNewDraft={noop} onOpenDraft={noop} onCloseDraft={noop} onChangeNote={noop}
      onAddItem={noop} onUpdateItem={noop} onRemoveItem={noop} onEditBody={noop} onSaveDraft={noop} onActivate={noop}
      {...over}
    />,
  );
}

/**
 * The opening tag of the button whose text contains `label`, with its class
 * attribute removed (Tailwind classes such as "disabled:opacity-50" would
 * otherwise look like the disabled attribute).
 */
function button(markup: string, label: string): string {
  const at = markup.indexOf(label);
  expect(at, `button "${label}" not found`).toBeGreaterThan(-1);
  return markup.slice(markup.lastIndexOf("<button", at), at).replace(/ class="[^"]*"/, "");
}

describe("who may manage packaging rules", () => {
  it("is owners and managers only", () => {
    expect(canManagePackagingRules("owner")).toBe(true);
    expect(canManagePackagingRules("manager")).toBe(true);
    for (const r of ["staff", "kiosk", "cs", "", null, undefined]) expect(canManagePackagingRules(r)).toBe(false);
  });
});

describe("mode switch", () => {
  it("cannot choose automatic while the site has no active rule set", () => {
    const out = html({ ruleSets: [row({ status: "draft", activated_at: null })] });
    expect(button(out, "Pick automatically")).toContain("disabled");
    expect(out).toContain("Needs an active rule set first.");
    expect(button(out, "Scan the box")).toContain('aria-pressed="true"');
  });

  it("offers automatic once a version is active and marks the current mode", () => {
    const scan = html({ ruleSets: [row({ version: 3 })] });
    expect(button(scan, "Pick automatically")).not.toContain("disabled");
    expect(scan).toContain("using rules version 3");
    const auto = html({ mode: "auto", ruleSets: [row({})] });
    expect(button(auto, "Pick automatically")).toContain('aria-pressed="true"');
    expect(button(auto, "Scan the box")).not.toContain("disabled");
  });
});

describe("versions", () => {
  it("lists versions; only drafts are editable, others can seed a new draft", () => {
    const out = html({ ruleSets: [row({ id: "d", version: 3, status: "draft", activated_at: null }), row({ id: "a", version: 2 }), row({ id: "r", version: 1, status: "retired" })] });
    expect(out).toContain("Edit draft");
    expect(out).toContain("New draft from v2");
    expect(out).toContain("New draft from v1");
    expect(out).not.toContain("New draft from v3");
    expect(out).toContain("Active and retired versions never change.");
  });

  it("explains the empty state", () => {
    expect(html()).toContain("No rule sets yet.");
  });
});

describe("draft editor", () => {
  it("shows the packaging items with their stock item, barcode and stations", () => {
    const out = html({ draft: draftState(body) });
    expect(out).toContain('value="Small box"');
    expect(out).toContain('value="+50="');
    expect(out).toContain("TEST-BOX-L");
    expect(out).toContain("1 rule · 1 example · all examples pass");
    expect(button(out, "Activate this version")).not.toContain("disabled");
    expect(button(out, "Save draft")).toContain("disabled"); // nothing to save
  });

  it("an unsaved draft must be saved before it can be activated", () => {
    const out = html({ draft: draftState(body, { dirty: true }) });
    expect(out).toContain("not saved");
    expect(button(out, "Save draft")).not.toContain("disabled");
    expect(button(out, "Activate this version")).toContain("disabled");
    expect(out).toContain("Save the draft before activating.");
  });

  it("blocks activation without examples or with a failing example", () => {
    const none = html({ draft: draftState({ ...body, examples: [] }) });
    expect(button(none, "Activate this version")).toContain("disabled");
    expect(none).toContain("Add at least one example before activating.");
    const failing = { ...body, examples: [{ ...body.examples[0], expect: [{ key: "L", qty: 1 }] }] };
    const out = html({ draft: draftState(failing) });
    expect(button(out, "Activate this version")).toContain("disabled");
    expect(out).toContain("1 failing");
    expect(out).toContain("Every example must pass before activating.");
  });

  it("lists problems and blocks saving", () => {
    const broken = { ...body, catalogue: [{ ...body.catalogue[0], product_id: "gone" }, body.catalogue[1]] };
    const out = html({ draft: draftState(broken, { dirty: true }) });
    expect(out).toContain("does not exist at this site");
    expect(out).toContain("Missing stock item (gone)");
    expect(button(out, "Save draft")).toContain("disabled");
  });
});

describe("draft helpers", () => {
  it("a draft made from a version is an independent copy", () => {
    const d = draftFrom(body);
    expect(d).toEqual(body);
    d.catalogue[0].label = "changed";
    expect(body.catalogue[0].label).toBe("Small box");
  });

  it("adds items with unique keys taken from the stock code", () => {
    let b = addCatalogueItem(emptyRuleSetBody(), { id: "p-s", code: "TEST-BOX-S" });
    b = addCatalogueItem(b, { id: "p-s", code: "TEST-BOX-S" });
    expect(b.catalogue.map((c) => c.key)).toEqual(["TEST-BOX-S", "TEST-BOX-S-2"]);
    expect(b.catalogue[0]).toMatchObject({ product_id: "p-s", label: "TEST-BOX-S" });
  });

  it("renaming a key keeps rules and examples pointing at the item", () => {
    const b = updateCatalogueItem(body, 0, { key: "SMALL" });
    expect(b.rules[0].output).toEqual({ mode: "fixed", packages: [{ key: "SMALL", qty: 1 }] });
    expect(b.examples[0].expect).toEqual([{ key: "SMALL", qty: 1 }]);
    expect(checkDraft(b, known).problems).toEqual([]);
  });

  it("clearing the barcode or ticking every station stores no restriction", () => {
    expect(updateCatalogueItem(body, 0, { legacy_barcode: undefined }).catalogue[0]).not.toHaveProperty("legacy_barcode");
    expect(toggleCataloguePoint(body.catalogue[1], "a0_framed")).toEqual(["a0_framed", "dispatch"]);
    expect(toggleCataloguePoint({ ...body.catalogue[1], packing_points: ["a0_framed", "dispatch"] }, "unframed")).toBeUndefined();
    expect(toggleCataloguePoint(body.catalogue[0], "dispatch")).toEqual(["a0_framed", "unframed"]);
    expect(toggleCataloguePoint(body.catalogue[1], "dispatch")).toBeUndefined();
  });

  it("removing an item that a rule uses is reported as a problem", () => {
    const b = removeCatalogueItem(body, 0);
    expect(checkDraft(b, known).problems.join(" ")).toMatch(/"S" is not in the catalogue/);
  });
});
