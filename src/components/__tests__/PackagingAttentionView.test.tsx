import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PackagingPick } from "@/lib/repository/supabase/orderPackaging";
import { PackagingAttentionView, type AttentionViewProps } from "../PackagingAttentionCard";

const pick = (over: Partial<PackagingPick>): PackagingPick => ({
  id: "pkp-1", location: "au", order_number: "F4T-1", packing_point: "dispatch", shipment_key: "orig",
  state: "auto", stock_state: "posted", rule_set_id: "prs-1", rule_set_version: 1,
  predicted: {}, target: { "p-s": 2 }, posted: {}, revision: 1,
  created_at: "2026-11-22T00:00:00Z", updated_at: "2026-11-22T00:00:00Z", ...over,
});

function html(over: Partial<AttentionViewProps> = {}): string {
  return renderToStaticMarkup(
    <PackagingAttentionView picks={[]} missing={[]} labels={new Map([["p-s", "Small box"]])} truncated={false}
      busyPickId={null} message={null} onRetry={() => {}} {...over} />,
  );
}

describe("PackagingAttentionView", () => {
  it("says so when nothing needs attention", () => {
    expect(html()).toContain("Nothing needs attention in this range.");
  });

  it("lists a flagged order with no Retry button", () => {
    const out = html({ picks: [pick({ state: "unresolved", target: {} })] });
    expect(out).toContain('data-attention="flagged"');
    expect(out).toContain("#F4T-1 · Dispatch");
    expect(out).toContain("No box rule matched. Nothing was deducted.");
    expect(out).not.toContain("Retry");
  });

  it("lists short and not-yet-deducted stock with labels and a Retry button", () => {
    const out = html({ picks: [
      pick({ id: "a", stock_state: "short", packing_point: "a0_framed" }),
      pick({ id: "b", order_number: "F4T-2", stock_state: "unposted", shipment_key: "cs:c1" }),
    ] });
    expect(out).toContain('data-attention="short"');
    expect(out).toContain("#F4T-1 · A0 Framed");
    expect(out).toContain("Stock went below zero for: ×2 Small box.");
    expect(out).toContain('data-attention="unposted"');
    expect(out).toContain("#F4T-2 · Dispatch · replacement");
    expect(out).toContain("Not deducted yet, stock too low: ×2 Small box.");
    expect(out).toContain('aria-label="Retry stock for order F4T-2"');
  });

  it("lists completions with no packaging record", () => {
    const out = html({ missing: [{ order_number: "F4T-9", packing_point: "unframed", shipment_key: "orig", completed_at: "2026-11-22T10:00:00Z", event_id: "e1" }] });
    expect(out).toContain('data-attention="missing"');
    expect(out).toContain("#F4T-9 · Unframed");
    expect(out).toContain("Completed with no packaging record.");
  });

  it("shows the busy state, a message and the truncation note", () => {
    const out = html({ picks: [pick({ stock_state: "unposted" })], busyPickId: "pkp-1", message: "Still not enough stock for order #F4T-1.", truncated: true });
    expect(out).toContain("Retrying…");
    expect(out).toContain('role="alert"');
    expect(out).toContain("Showing the most recent rows only.");
  });

  it("falls back to the product id when a label is unknown", () => {
    expect(html({ picks: [pick({ stock_state: "short", target: { ghost: 1 } })] })).toContain("×1 ghost");
  });
});
