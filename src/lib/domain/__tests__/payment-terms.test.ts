import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  computeDueDate,
  isShipmentOverdue,
  formatTermsLabel,
  STANDARD_PAYMENT_TERMS,
} from "@/lib/domain";

/**
 * Payment-terms math tests.
 *
 * These cover every realistic edge case so the email-reminder cron job
 * (Phase 3) can rely on computeDueDate being correct.
 *
 * Conventions used here:
 *   - "NET30 EOM" = 30 days from the END of the order's month
 *     (so order Jan 5 â†’ Jan 31 + 30 = Mar 2)
 *   - "NET30" (non-EOM) = order date + 30 days
 *     (so order Jan 5 â†’ Feb 4)
 *   - Days are local-time arithmetic; no timezone surprises within a
 *     single-locale install.
 */

describe("computeDueDate â€” non-EOM", () => {
  it("Jan 5 + NET30 â†’ Feb 4", () => {
    expect(computeDueDate("2026-01-05", 30, false)).toBe("2026-02-04");
  });
  it("Jan 5 + NET60 â†’ Mar 6", () => {
    expect(computeDueDate("2026-01-05", 60, false)).toBe("2026-03-06");
  });
  it("Jan 5 + NET90 â†’ Apr 5", () => {
    expect(computeDueDate("2026-01-05", 90, false)).toBe("2026-04-05");
  });
  it("Dec 15 + NET30 â†’ Jan 14 next year", () => {
    expect(computeDueDate("2025-12-15", 30, false)).toBe("2026-01-14");
  });
  it("Jan 31 + NET30 â†’ Mar 2 (handles month rollover)", () => {
    expect(computeDueDate("2026-01-31", 30, false)).toBe("2026-03-02");
  });
  it("Feb 29 2024 (leap) + NET30 â†’ Mar 30 2024", () => {
    expect(computeDueDate("2024-02-29", 30, false)).toBe("2024-03-30");
  });
  it("Prepaid (0 days) â†’ same date", () => {
    expect(computeDueDate("2026-01-05", 0, false)).toBe("2026-01-05");
  });
});

describe("computeDueDate â€” EOM (30 days from end of order month)", () => {
  it("Jan 5 + NET30 EOM â†’ Mar 2 (Jan 31 + 30)", () => {
    expect(computeDueDate("2026-01-05", 30, true)).toBe("2026-03-02");
  });
  it("Jan 31 + NET30 EOM â†’ Mar 2 (same as above; EOM snaps to month end)", () => {
    expect(computeDueDate("2026-01-31", 30, true)).toBe("2026-03-02");
  });
  it("Feb 15 + NET30 EOM (2026, non-leap) â†’ Mar 30", () => {
    expect(computeDueDate("2026-02-15", 30, true)).toBe("2026-03-30");
  });
  it("Feb 15 + NET30 EOM (2024, leap) â†’ Mar 30", () => {
    // Feb 29 2024 + 30 days = Mar 30 2024
    expect(computeDueDate("2024-02-15", 30, true)).toBe("2024-03-30");
  });
  it("Dec 15 + NET30 EOM â†’ Jan 30 next year", () => {
    // Dec 31 + 30 = Jan 30 2026
    expect(computeDueDate("2025-12-15", 30, true)).toBe("2026-01-30");
  });
  it("Jan 5 + NET60 EOM â†’ Apr 1 (Jan 31 + 60)", () => {
    expect(computeDueDate("2026-01-05", 60, true)).toBe("2026-04-01");
  });
  it("Jan 5 + NET90 EOM â†’ May 1 (Jan 31 + 90)", () => {
    expect(computeDueDate("2026-01-05", 90, true)).toBe("2026-05-01");
  });
});

describe("computeDueDate â€” null / invalid inputs", () => {
  it("null orderPlacedDate â†’ null", () => {
    expect(computeDueDate(null, 30, false)).toBe(null);
  });
  it("undefined orderPlacedDate â†’ null", () => {
    expect(computeDueDate(undefined, 30, false)).toBe(null);
  });
  it("empty string orderPlacedDate â†’ null", () => {
    expect(computeDueDate("", 30, false)).toBe(null);
  });
  it("null termsDays â†’ null", () => {
    expect(computeDueDate("2026-01-05", null, false)).toBe(null);
  });
  it("undefined termsDays â†’ null", () => {
    expect(computeDueDate("2026-01-05", undefined, false)).toBe(null);
  });
});

describe("isShipmentOverdue", () => {
  beforeEach(() => {
    // Pin "today" so the test is reproducible.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T10:00:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("due yesterday + unpaid â†’ overdue", () => {
    expect(isShipmentOverdue("2026-05-19", "unpaid")).toBe(true);
  });
  it("due today + unpaid â†’ NOT overdue (grace period through today)", () => {
    expect(isShipmentOverdue("2026-05-20", "unpaid")).toBe(false);
  });
  it("due tomorrow + unpaid â†’ not overdue", () => {
    expect(isShipmentOverdue("2026-05-21", "unpaid")).toBe(false);
  });
  it("due yesterday + paid â†’ not overdue", () => {
    expect(isShipmentOverdue("2026-05-19", "paid")).toBe(false);
  });
  it("due yesterday + on_hold â†’ not overdue", () => {
    expect(isShipmentOverdue("2026-05-19", "on_hold")).toBe(false);
  });
  it("due yesterday + disputed â†’ still overdue (disputed != paid)", () => {
    expect(isShipmentOverdue("2026-05-19", "disputed")).toBe(true);
  });
  it("due yesterday + pending_approval â†’ still overdue", () => {
    expect(isShipmentOverdue("2026-05-19", "pending_approval")).toBe(true);
  });
  it("null dueDate â†’ not overdue (no due date set)", () => {
    expect(isShipmentOverdue(null, "unpaid")).toBe(false);
  });
});

describe("formatTermsLabel", () => {
  it("null â†’ --", () => {
    expect(formatTermsLabel(null)).toBe("--");
  });
  it("0 days â†’ Prepaid", () => {
    expect(formatTermsLabel(0)).toBe("Prepaid");
  });
  it("30 days, no EOM â†’ NET30", () => {
    expect(formatTermsLabel(30)).toBe("NET30");
  });
  it("30 days, EOM â†’ NET30 EOM", () => {
    expect(formatTermsLabel(30, true)).toBe("NET30 EOM");
  });
  it("45 (custom) â†’ NET45", () => {
    expect(formatTermsLabel(45)).toBe("NET45");
  });
});

describe("STANDARD_PAYMENT_TERMS â€” sanity check", () => {
  it("includes Prepaid (days=0)", () => {
    expect(STANDARD_PAYMENT_TERMS.find((t) => t.label === "Prepaid")).toBeTruthy();
    expect(STANDARD_PAYMENT_TERMS.find((t) => t.label === "Prepaid")?.value).toBe(0);
  });
  it("includes NET30 EOM (days=30, eom=true)", () => {
    const t = STANDARD_PAYMENT_TERMS.find((p) => p.label === "NET30 EOM");
    expect(t?.value).toBe(30);
    expect(t?.eom).toBe(true);
  });
  it("all keys are unique", () => {
    const keys = STANDARD_PAYMENT_TERMS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});