import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CatalogueItem } from "@/lib/domain/packaging/ruleSet";
import { PackagingPanel, PackagingPendingNotice, type PackagingPanelProps, type SavedPickView } from "../PackagingPanel";

const noop = () => {};
const small: CatalogueItem = { key: "BOX-S", product_id: "p-s", label: "Small box" };
const large: CatalogueItem = { key: "BOX-L", product_id: "p-l", label: "Large box" };
const picked = (c: CatalogueItem, qty = 1) => ({ key: c.key, product_id: c.product_id, label: c.label, qty });

function html(over: Partial<PackagingPanelProps> = {}): string {
  return renderToStaticMarkup(
    <PackagingPanel
      variant="station"
      status="auto"
      chosen={[picked(small)]}
      predicted={[picked(small)]}
      reason={null}
      alternatives={[small, large]}
      pendingCount={0}
      onTap={noop}
      onAdd={noop}
      onAdjust={noop}
      onReset={noop}
      {...over}
    />,
  );
}

const saved = (over: Partial<SavedPickView> = {}): SavedPickView => ({
  packages: [picked(small)],
  state: "auto",
  stockState: "posted",
  editing: null,
  onStartChange: noop,
  onCancelChange: noop,
  onConfirm: noop,
  onRetry: noop,
  ...over,
});

describe("PackagingPanel before Complete", () => {
  it("shows the automatic pick with one-tap alternatives and no scan prompt", () => {
    const out = html();
    expect(out).toContain('data-packaging="auto"');
    expect(out).toContain(">AUTO<");
    expect(out).toContain("×1");
    expect(out).toContain("Small box");
    expect(out).toContain('aria-label="Use Large box"');
    expect(out).toContain('aria-label="One more Small box"');
    expect(out).toContain('aria-label="One fewer Small box"');
    expect(out).not.toMatch(/scan a box/i);
    expect(out).not.toContain("Back to suggested");
    expect(out).not.toContain("not saved yet");
  });

  it("shows a changed pick and the way back to the suggestion", () => {
    const out = html({ status: "changed", chosen: [picked(large, 2)] });
    expect(out).toContain(">CHANGED<");
    expect(out).toContain("×2");
    expect(out).toContain("Back to suggested (×1 Small box)");
  });

  it("flags an order with no rule and says Complete still works", () => {
    const out = html({ status: "flagged", chosen: [], predicted: [], reason: "No box rule covers every item." });
    expect(out).toContain('data-packaging="flagged"');
    expect(out).toContain(">FLAGGED<");
    expect(out).toContain("No box rule covers every item.");
    expect(out).toContain("You can still complete");
    expect(out).toContain('aria-label="Use Small box"');
  });

  it("offers to clear a manual choice when nothing was predicted", () => {
    const out = html({ status: "changed", chosen: [picked(large)], predicted: [] });
    expect(out).toContain("Clear my choice");
  });

  it("says so when this station packs nothing for the order", () => {
    const out = html({ chosen: [], predicted: [] });
    expect(out).toContain("Nothing to pack at this station");
    expect(out).toContain(">AUTO<");
  });

  it("shows saves that are still waiting", () => {
    expect(html({ pendingCount: 1 })).toContain("Packaging not saved yet for 1 order.");
    expect(html({ pendingCount: 3 })).toContain("Packaging not saved yet for 3 orders.");
  });

  it("renders the classic look with the same content", () => {
    const out = html({ variant: "classic" });
    expect(out).toContain("rounded-2xl");
    expect(out).not.toContain("st-panel");
    expect(out).toContain('aria-label="Use Large box"');
  });
});

describe("PackagingPanel for a saved pick", () => {
  it("shows the saved pick read-only with a Change box button", () => {
    const out = html({ saved: saved({ state: "overridden" }) });
    expect(out).toContain('data-packaging="saved"');
    expect(out).toContain(">SAVED<");
    expect(out).toContain("Chosen by a worker.");
    expect(out).toContain("completing again will not deduct again");
    expect(out).toContain("Change box");
    expect(out).not.toContain('aria-label="One more Small box"');
    expect(out).not.toContain('aria-label="Use Large box"');
  });

  it("explains flagged, scanned and short-stock picks", () => {
    expect(html({ saved: saved({ state: "unresolved", packages: [] }) })).toContain("No packaging recorded.");
    expect(html({ saved: saved({ state: "legacy_scan" }) })).toContain("Recorded from a box scan.");
    expect(html({ saved: saved({ stockState: "short" }) })).toContain("Stock for this packaging is short.");
    expect(html({ saved: saved() })).not.toContain("Stock for this packaging is short.");
  });

  it("while changing: editable rows, alternatives, reasons and cancel", () => {
    const out = html({ saved: saved({ editing: { draft: [picked(large)], busy: false, message: null, uncertain: false } }) });
    expect(out).toContain(">CHANGING<");
    expect(out).toContain('aria-label="Add one Small box"');
    expect(out).toContain("Large box");
    expect(out).toContain('aria-label="One more Large box"');
    expect(out).toContain('aria-label="Use Small box"');
    expect(out).toContain("Used a different box");
    expect(out).toContain("Needed an extra box");
    expect(out).toContain("Cancel");
    expect(out).not.toContain("Change box");
  });

  it("disables inputs while saving and shows a message such as a conflict", () => {
    const out = html({ saved: saved({ editing: { draft: [picked(large)], busy: true, message: "Changed on another device. Showing the latest.", uncertain: false } }) });
    expect(out).toContain("disabled");
    expect(out).toContain('role="alert"');
    expect(out).toContain("Changed on another device.");
  });

  it("review r1: after a lost answer offers only Retry, with editing and Cancel removed", () => {
    const out = html({ saved: saved({ editing: { draft: [picked(large)], busy: false, message: "No connection. The change may already be saved.", uncertain: true } }) });
    expect(out).toContain(">Retry<");
    expect(out).not.toContain("Used a different box");
    expect(out).not.toContain(">Cancel<");
    expect(out).not.toContain("Nothing was changed");
    // Every row/alternative button is disabled; only Retry is live.
    const enabled = out.match(/<button(?![^>]*disabled)[^>]*>/g) ?? [];
    expect(enabled).toHaveLength(1);
    expect(enabled[0]).not.toContain("aria-label");
  });
});

describe("review r1: adding a second packaging type", () => {
  it("offers an add action beside each one-tap alternative", () => {
    const out = html();
    expect(out).toContain('aria-label="Use Large box"');
    expect(out).toContain('aria-label="Add one Large box"');
    expect(out).toContain('aria-label="Add one Small box"');
  });
});

describe("PackagingPendingNotice", () => {
  it("renders only when something is waiting", () => {
    expect(renderToStaticMarkup(<PackagingPendingNotice variant="station" count={0} />)).toBe("");
    expect(renderToStaticMarkup(<PackagingPendingNotice variant="classic" count={2} />)).toContain("not saved yet for 2 orders");
  });
});
