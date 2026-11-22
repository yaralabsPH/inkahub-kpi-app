import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  StationOrderScreen,
  type StationOrderScreenProps,
  type StationScreenLine,
} from "../StationOrderScreen";

const noop = () => {};

function line(sku: string, over: Partial<StationScreenLine> = {}): StationScreenLine {
  return { key: sku, sku, title: `Title ${sku}`, quantity: 1, variantTitle: null, belongsToThisDept: true, ...over };
}

function props(over: Partial<StationOrderScreenProps> = {}): StationOrderScreenProps {
  return {
    departmentLabel: "Framed",
    locationCode: "au",
    locationLabel: "Australia",
    staff: { user_id: "u1", display_name: "Staging Staff" },
    todayCount: 3,
    todayItems: 7,
    order: null,
    verified: new Map(),
    staffNames: new Map([["u1", "Staging Staff"]]),
    scanBuffer: "",
    error: null,
    activeCase: null,
    packages: null,
    onVerify: noop,
    onUnverify: noop,
    onCompleteOrder: noop,
    onScrapOrder: noop,
    onClearOrder: noop,
    onManualOrderSubmit: noop,
    onRemovePackage: noop,
    onClearPackages: noop,
    onClockOut: noop,
    onSignOut: noop,
    onOpenSettings: noop,
    backHref: "/returns",
    ...over,
  };
}

const SIX = [
  line("INKA-DIV0147-A2-FN", { title: "Diving Woman Art Print" }),
  line("INKA-GOL0312-A1-FB", { title: "Golden Hour Coastline Art Print", quantity: 2 }),
  line("INKA-FER0089-A4-FW", { title: "Botanical Fern Study Art Print" }),
  line("INKA-HIG0207-A3-UN", { title: "Highland Cow Art Print" }),
  line("INKA-BLU0048-A3-UN", { title: "Blue Japanese Woodblock Pattern Art Print" }),
  line("INKA-ARC0221-A2-UN", { title: "Abstract Arches Art Print" }),
];

function order(lines: StationScreenLine[]) {
  return { number: "10250798", displayName: "#10250798", totalLines: lines.length, lines };
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("StationOrderScreen - waiting for an order", () => {
  it("shows the idle sidebar, scan zone, manual lookup and clock out", () => {
    const html = renderToStaticMarkup(<StationOrderScreen {...props()} />);
    expect(html).toContain("IDLE");
    expect(html).toContain("Scan the packing slip");
    expect(html).toContain("Open order");
    expect(html).toContain("Clock out");
    expect(html).toContain("Orders today <b>3</b>");
    expect(html).toContain("Staging Staff");
  });
});

describe("StationOrderScreen - working on an order", () => {
  it("renders two groups with one card per line and one current card", () => {
    const html = renderToStaticMarkup(<StationOrderScreen {...props({ order: order(SIX) })} />);
    expect(html).toContain("TO FRAME");
    expect(html).toContain("PACK FLAT");
    expect(html).not.toContain("FOR REFERENCE");
    expect(count(html, "<article")).toBe(6);
    expect(count(html, "is-current")).toBe(1);
    expect(html).toContain("CURRENT");
    expect(html).toContain(">of 6 checked<");
    expect(html).toContain("3 to frame · 3 pack flat");
    expect(html).toContain("7 pieces");
  });

  it("asks for each piece of a multi-quantity line", () => {
    const html = renderToStaticMarkup(<StationOrderScreen {...props({ order: order(SIX) })} />);
    expect(html).toContain("PICK 2");
    expect(html).toContain("Check piece 1 of 2");
  });

  it("shows sizes without dimensions and frame names", () => {
    const html = renderToStaticMarkup(<StationOrderScreen {...props({ order: order(SIX) })} />);
    expect(html).toContain(">A2<");
    expect(html).not.toContain("42 x 60");
    expect(html).toContain("Natural Timber");
    expect(html).toContain("No frame");
  });

  it("locks Complete with a countdown until every line is checked", () => {
    const html = renderToStaticMarkup(<StationOrderScreen {...props({ order: order(SIX) })} />);
    expect(html).toContain("6 items left to check");
    expect(html).toMatch(/st-btn-complete locked" disabled/);
  });

  it("turns checked lines green, lists them as done and unlocks Complete when all are checked", () => {
    const verified = new Map(
      SIX.map((l, i) => [l.key, { staff_id: "u1", time: `2026-11-22T01:0${i}:00Z` }] as const),
    );
    const html = renderToStaticMarkup(<StationOrderScreen {...props({ order: order(SIX), verified })} />);
    expect(count(html, "st-card is-done")).toBe(6);
    expect(count(html, "st-mini\"")).toBe(6);
    expect(html).toContain("All items checked");
    expect(html).toContain("st-btn-complete ready");
    expect(html).not.toContain("is-current");
    // Newest check first in the done list.
    expect(html.indexOf("st-mini-title\">Abstract Arches")).toBeLessThan(html.indexOf("st-mini-title\">Diving Woman"));
  });

  it("keeps Complete locked when a required box has not been scanned", () => {
    const one = [line("INKA-DIV0147-A0-FN")];
    const verified = new Map([[one[0].key, { staff_id: "u1", time: "2026-11-22T01:00:00Z" }]]);
    const html = renderToStaticMarkup(
      <StationOrderScreen {...props({ order: order(one), verified, packages: { rows: [], required: true, auto: false } })} />,
    );
    expect(html).toContain("Scan a box to finish");
    expect(html).toContain("BOXES FOR THIS SHIPMENT");
    expect(html).toMatch(/st-btn-complete locked" disabled/);
  });

  it("enables Complete once a box is scanned", () => {
    const one = [line("INKA-DIV0147-A0-FN")];
    const verified = new Map([[one[0].key, { staff_id: "u1", time: "2026-11-22T01:00:00Z" }]]);
    const html = renderToStaticMarkup(
      <StationOrderScreen
        {...props({ order: order(one), verified, packages: { rows: [{ key: "A0", label: "A0 box", qty: 1 }], required: true, auto: false } })}
      />,
    );
    expect(html).toContain("st-btn-complete ready");
    expect(html).not.toMatch(/st-btn-complete[^"]*" disabled/);
  });

  it("blocks Complete at Unframed until a mail tube is auto-assigned", () => {
    const one = [line("INKA-HIG0207-A3-UN")];
    const verified = new Map([[one[0].key, { staff_id: "u1", time: "2026-11-22T01:00:00Z" }]]);
    const empty = renderToStaticMarkup(
      <StationOrderScreen {...props({ order: order(one), verified, packages: { rows: [], required: true, auto: true } })} />,
    );
    expect(empty).toContain("No packaging assigned");
    expect(empty).toMatch(/st-btn-complete locked" disabled/);
    const assigned = renderToStaticMarkup(
      <StationOrderScreen
        {...props({ order: order(one), verified, packages: { rows: [{ key: "tube", label: "Mail tube", qty: 1 }], required: true, auto: true } })}
      />,
    );
    expect(assigned).toContain("st-btn-complete ready");
    expect(assigned).toContain("AUTO-ASSIGNED PACKAGING");
  });

  it("keeps the error, Complete and Scrap outside the scrolling part of the sidebar", () => {
    const html = renderToStaticMarkup(
      <StationOrderScreen
        {...props({
          order: order(SIX),
          error: "Verify failed",
          activeCase: { caseId: "42", issueType: "damaged", urgency: "high", customerName: "A Customer" },
          packages: { rows: [{ key: "A0", label: "A0 box", qty: 1 }], required: true, auto: false },
        })}
      />,
    );
    const body = html.indexOf("st-side-body");
    const actions = html.indexOf('class="st-actions"');
    expect(body).toBeGreaterThan(-1);
    expect(actions).toBeGreaterThan(body);
    const scrollPart = html.slice(body, actions);
    expect(scrollPart).toContain("CASE #42");
    expect(scrollPart).toContain("BOXES FOR THIS SHIPMENT");
    expect(scrollPart).not.toContain("Scrap order");
    expect(html.slice(actions)).toContain("Verify failed");
    expect(html.slice(actions)).toContain("Scrap order");
  });

  it("shows other-department and gift lines without check buttons", () => {
    const lines = [
      line("INKA-DIV0147-A2-FN"),
      line("INKA-DIV0147-A0-FN", { belongsToThisDept: false, otherDeptLabel: "A0 Framed" }),
      // Real routing: gift cards belong to no station.
      line("INKA-GC0001-50", { title: "Gift card", belongsToThisDept: false }),
    ];
    const html = renderToStaticMarkup(<StationOrderScreen {...props({ order: order(lines) })} />);
    expect(html).toContain("FOR REFERENCE");
    expect(html).toContain("A0 FRAMED STATION");
    expect(html).toContain("NO CHECK NEEDED");
    expect(html).toContain(">of 1 checked<");
  });

  it("shows replacement work and errors in the sidebar", () => {
    const html = renderToStaticMarkup(
      <StationOrderScreen
        {...props({
          order: order(SIX),
          error: "Verify failed",
          activeCase: { caseId: "42", issueType: "damaged_in_transit", urgency: "high", customerName: null },
        })}
      />,
    );
    expect(html).toContain("CASE #42");
    expect(html).toContain("damaged in transit");
    expect(html).toContain("Verify failed");
  });
});
