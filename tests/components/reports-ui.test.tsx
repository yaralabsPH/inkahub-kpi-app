import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Inbox } from "lucide-react";
import { formatRangeLabel, splitSizeVariant } from "../../src/pages/Reports";
import { coverLevel, COVER_THRESHOLDS } from "../../src/components/PackageHistoryCard";
import { Section } from "../../src/components/ui/Section";
import { EmptyState } from "../../src/components/ui/EmptyState";
import { Callout } from "../../src/components/ui/Callout";
import { Pager, clampPage } from "../../src/components/ui/Pager";
import { accessGroups, NAV_ICONS } from "../../src/components/layout/navigation";
import { NAV_KEYS } from "../../src/lib/domain";

describe("Reports formatting helpers", () => {
  it("formats the production-date range like the mockup", () => {
    expect(formatRangeLabel("2026-11-13", "2026-11-19")).toBe("Nov 13 – Nov 19, 2026");
    expect(formatRangeLabel("2026-11-19", "2026-11-19")).toBe("Nov 19, 2026");
    expect(formatRangeLabel("2025-12-28", "2026-01-03")).toBe("Dec 28, 2025 – Jan 3, 2026");
    expect(formatRangeLabel("bad", "worse")).toBe("bad → worse");
  });

  it("splits size/variant keys and falls back to the whole key", () => {
    expect(splitSizeVariant("A3-FN")).toEqual({ size: "A3", variant: "FN" });
    expect(splitSizeVariant("PF A0-PM")).toEqual({ size: "PF A0", variant: "PM" });
    expect(splitSizeVariant("GW")).toEqual({ size: "GW", variant: "" });
  });

  it("bands stock cover with the configured thresholds", () => {
    const w = COVER_THRESHOLDS.week;
    expect(coverLevel(w.critical - 0.1, "week")).toBe("critical");
    expect(coverLevel(w.critical, "week")).toBe("warn");
    expect(coverLevel(w.warn, "week")).toBe("ok");
    expect(coverLevel(COVER_THRESHOLDS.day.critical - 1, "day")).toBe("critical");
    expect(coverLevel(COVER_THRESHOLDS.day.warn + 1, "day")).toBe("ok");
  });
});

describe("Shared section components", () => {
  it("renders a section title once, lists it for the section bar, and has an accessible toggle", () => {
    const html = renderToStaticMarkup(
      <Section title="Staff leaderboard" subtitle="All departments" meta="3 people" actions={<button>Go</button>}>
        <p>body</p>
      </Section>,
    );
    expect(html.match(/>Staff leaderboard</g)).toHaveLength(1);
    expect(html).toContain('data-report-section="Staff leaderboard"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("All departments");
    expect(html).toContain("3 people");
    expect(html).toContain("<p>body</p>");
  });

  it("uses navLabel for the section bar and hides the body when closed", () => {
    const html = renderToStaticMarkup(
      <Section title="Orders handled by Mia" navLabel="Orders handled" subtitle="sub" defaultOpen={false}><p>body</p></Section>,
    );
    expect(html).toContain('data-report-section="Orders handled"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("body</p>");
    expect(html).not.toContain(">sub<");
  });

  it("renders empty states and callouts", () => {
    const empty = renderToStaticMarkup(<EmptyState icon={Inbox} title="No completions" hint="Hit Refresh." />);
    expect(empty).toContain("No completions");
    expect(empty).toContain("Hit Refresh.");
    expect(renderToStaticMarkup(<Callout><b>Break rule.</b> text</Callout>)).toContain("<b>Break rule.</b>");
  });
});

describe("Pager", () => {
  it("clamps pages into range", () => {
    expect(clampPage(-1, 791, 10)).toBe(0);
    expect(clampPage(5, 791, 10)).toBe(5);
    expect(clampPage(999, 791, 10)).toBe(79);
    expect(clampPage(3, 0, 10)).toBe(0);
  });

  it("shows the range, sizes up to 200, and disables the ends", () => {
    const first = renderToStaticMarkup(<Pager total={791} page={0} size={10} onPage={() => {}} onSize={() => {}} label="orders" />);
    expect(first).toContain("1–10 of 791 orders");
    expect(first).toMatch(/disabled=""[^>]*aria-label="Previous page"/);
    expect(first).not.toMatch(/disabled=""[^>]*aria-label="Next page"/);
    for (const n of [10, 20, 50, 100, 200]) expect(first).toContain(`<option value="${n}"`);
    expect(first).not.toContain('value="500"');
    const last = renderToStaticMarkup(<Pager total={791} page={79} size={10} onPage={() => {}} onSize={() => {}} label="orders" />);
    expect(last).toContain("791–791 of 791 orders");
    expect(last).toMatch(/disabled=""[^>]*aria-label="Next page"/);
  });
});

describe("Team access groups", () => {
  it("lists every page exactly once, each with an icon", () => {
    const keys = accessGroups().flatMap((g) => g.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...NAV_KEYS].sort());
    for (const k of NAV_KEYS) expect(NAV_ICONS[k]).toBeDefined();
  });
});
