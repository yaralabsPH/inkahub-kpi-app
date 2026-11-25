import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SharedScannerSetup } from "../SharedScannerStation";

const noop = () => {};
const render = (mode: "framing" | "dispatch") =>
  renderToStaticMarkup(
    <SharedScannerSetup current={{ enabled: true, receiverId: "rcv-1", label: "Wall", scannerIds: ["S1", "S2", "S3"], mode }} onSave={noop} onCancel={noop} />,
  );

describe("SharedScannerSetup (scanner-stations-tuning)", () => {
  it("Framing shows the 15-minute timeout and the badge x3 sign-out guidance", () => {
    const html = render("framing");
    expect(html).toContain("Framing (badge, then orders; 15 minutes)");
    expect(html).toContain('data-testid="signout-guidance"');
    expect(html).toContain("scan your own badge 3 more times on it, at least one second apart. You stay clocked in.");
  });

  it("Dispatch keeps its once-per-shift wording and has no gesture guidance", () => {
    const html = render("dispatch");
    expect(html).toContain("Dispatch (badge once per shift, then order slips)");
    expect(html).not.toContain('data-testid="signout-guidance"');
  });
});
