import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OrderLineDisplay } from "../OrderLineDisplay";
import {
  getOrderLinePresentation,
  type OrderLinePresentation,
} from "../orderLinePresentation";

// Expectations are written by hand from the v6 SKU grammar in
// src/lib/domain/skuRouting.ts, not computed from the helper.
describe("getOrderLinePresentation", () => {
  const cases: Array<[string, string | null, OrderLinePresentation]> = [
    [
      "INKA-KAN0566-A4-FB",
      "A4 / Framed Print (Black) / Portrait",
      {
        kind: "print",
        sizeLabel: "A4 (21 x 30 cm)",
        styleLabel: "Framed",
        colourLabel: "Black",
        colourTone: "black",
        fallbackDescription: null,
      },
    ],
    [
      "INKA-KAN0566-A3-FW",
      null,
      {
        kind: "print",
        sizeLabel: "A3 (30 x 42 cm)",
        styleLabel: "Framed",
        colourLabel: "White",
        colourTone: "white",
        fallbackDescription: null,
      },
    ],
    [
      "INKA-S3WIL0049-A2-FN",
      null,
      {
        kind: "print",
        sizeLabel: "A2 (42 x 60 cm)",
        styleLabel: "Framed",
        colourLabel: "Natural Timber",
        colourTone: "natural",
        fallbackDescription: null,
      },
    ],
    [
      "INKA-S2BON0064-A1-UN",
      null,
      {
        kind: "print",
        sizeLabel: "A1 (60 x 84 cm)",
        styleLabel: "Unframed",
        colourLabel: "No frame",
        colourTone: "unframed",
        fallbackDescription: null,
      },
    ],
    [
      "INKA-KAN0566-A0-SC",
      null,
      {
        kind: "print",
        sizeLabel: "A0 (84 x 119 cm)",
        styleLabel: "Unframed",
        colourLabel: "Stretched canvas",
        colourTone: "canvas",
        fallbackDescription: null,
      },
    ],
    [
      "INKA-PF0004-A0-PB",
      null,
      {
        kind: "picture_frame",
        sizeLabel: "A0 (84 x 119 cm)",
        styleLabel: "Frame only",
        colourLabel: "Black",
        colourTone: "black",
        fallbackDescription: null,
      },
    ],
    [
      "INKA-PF0004-A2-PW",
      null,
      {
        kind: "picture_frame",
        sizeLabel: "A2 (42 x 60 cm)",
        styleLabel: "Frame only",
        colourLabel: "White",
        colourTone: "white",
        fallbackDescription: null,
      },
    ],
    [
      "INKA-PF0004-A4-PN",
      null,
      {
        kind: "picture_frame",
        sizeLabel: "A4 (21 x 30 cm)",
        styleLabel: "Frame only",
        colourLabel: "Natural Timber",
        colourTone: "natural",
        fallbackDescription: null,
      },
    ],
    [
      "OLD-SKU-123",
      "A4 21x30 cm / Framed Print (Black)",
      {
        kind: "unknown",
        sizeLabel: null,
        styleLabel: null,
        colourLabel: "Unknown style",
        colourTone: "unknown",
        fallbackDescription: "A4 21x30 cm / Framed Print (Black)",
      },
    ],
    [
      "OLD-SKU-123",
      null,
      {
        kind: "unknown",
        sizeLabel: null,
        styleLabel: null,
        colourLabel: "Unknown style",
        colourTone: "unknown",
        fallbackDescription: "OLD-SKU-123",
      },
    ],
    [
      "INKA-GC0001-100",
      null,
      {
        kind: "other",
        sizeLabel: null,
        styleLabel: null,
        colourLabel: "Unknown style",
        colourTone: "unknown",
        fallbackDescription: "Gift Card - $100",
      },
    ],
  ];

  it.each(cases)("%s (%s)", (sku, variantTitle, expected) => {
    expect(getOrderLinePresentation(sku, variantTitle)).toEqual(expected);
  });
});

describe("OrderLineDisplay", () => {
  function render(props: Partial<Parameters<typeof OrderLineDisplay>[0]> = {}) {
    return renderToStaticMarkup(
      <OrderLineDisplay
        title="Kanagawa Great Wave"
        sku="INKA-KAN0566-A4-FB"
        quantity={1}
        variantTitle="A4 / Framed Print (Black) / Portrait"
        orientation="portrait"
        isMine
        badges={<span>SINGLE</span>}
        actions={<button type="button">Verify</button>}
        {...props}
      />,
    );
  }

  it("shows title, bold size, framed state and labelled colour block", () => {
    const html = render();
    expect(html).toContain("Kanagawa Great Wave");
    expect(html).toMatch(/<[^>]*font-bold[^>]*>A4 \(21 x 30 cm\)</);
    expect(html).toContain(">Framed<");
    expect(html).toContain("Frame colour: Black");
    expect(html).toContain(">Black<");
  });

  it("shows quantity, orientation, SKU, badges and the existing controls", () => {
    const html = render({ quantity: 2 });
    expect(html).toContain("x2");
    expect(html).toContain("Portrait");
    expect(html).toContain("INKA-KAN0566-A4-FB");
    expect(html).toContain("SINGLE");
    expect(html).toContain(">Verify</button>");
  });

  it("renders a non-interactive artwork placeholder with no image request", () => {
    const html = render();
    expect(html).toContain("Artwork image coming soon");
    expect(html).not.toContain("<img");
  });

  it("wraps long titles instead of truncating them", () => {
    const html = render({ title: "A very long product title ".repeat(6) });
    expect(html).toContain("break-words");
    expect(html).not.toContain("truncate");
  });

  it("labels unframed prints without a frame colour", () => {
    const html = render({ sku: "INKA-S2BON0064-A1-UN", variantTitle: null });
    expect(html).toContain(">Unframed<");
    expect(html).toContain("Style: No frame");
    expect(html).not.toContain(">Framed<");
  });

  it("shows picture-frame colour without calling it a print", () => {
    const html = render({ title: "Picture frame", sku: "INKA-PF0004-A2-PW", variantTitle: null });
    expect(html).toContain(">Frame only<");
    expect(html).toContain("Frame colour: White");
    expect(html).not.toMatch(/print/i);
  });

  // Only real frame colours are announced as "Frame colour"; neutral
  // blocks are announced as a style so nothing implies a frame.
  const labelCases: Array<[string, string, string | null, string]> = [
    ["framed black", "INKA-KAN0566-A4-FB", null, "Frame colour: Black"],
    ["framed white", "INKA-KAN0566-A3-FW", null, "Frame colour: White"],
    ["framed natural", "INKA-S3WIL0049-A2-FN", null, "Frame colour: Natural Timber"],
    ["frame-only black", "INKA-PF0004-A0-PB", null, "Frame colour: Black"],
    ["frame-only white", "INKA-PF0004-A2-PW", null, "Frame colour: White"],
    ["frame-only natural", "INKA-PF0004-A4-PN", null, "Frame colour: Natural Timber"],
    ["unframed", "INKA-S2BON0064-A1-UN", null, "Style: No frame"],
    ["canvas", "INKA-KAN0566-A0-SC", null, "Style: Stretched canvas"],
    ["unknown", "OLD-SKU-123", "A4 21x30 cm / Framed Print (Black)", "Style: Unknown"],
    ["gift card", "INKA-GC0001-100", null, "Style: Unknown"],
    ["AUX", "INKA-AUX-HOOK", null, "Style: Unknown"],
  ];

  it.each(labelCases)("announces the %s block (%s)", (_name, sku, variantTitle, label) => {
    const html = render({ sku, variantTitle, orientation: null });
    expect(html).toContain('aria-label="' + label + '"');
    if (label.startsWith("Style:")) expect(html).not.toContain("Frame colour:");
  });

  it("keeps the Shopify description for unknown SKUs and does not guess a colour", () => {
    const html = render({
      sku: "OLD-SKU-123",
      variantTitle: "A4 21x30 cm / Framed Print (Black)",
      orientation: null,
    });
    expect(html).toContain("A4 21x30 cm / Framed Print (Black)");
    expect(html).toContain("Unknown style");
    expect(html).not.toContain("Frame colour: Black");
  });
});
