import { describe, expect, it } from "vitest";
import {
  ARTWORK_BUDGETS,
  admitConversion,
  applyProviderCooldown,
  budgetPoolFor,
  invocationAllows,
  reserveDaily,
  reserveProviderRequest,
  utcDayStart,
  utcMinuteStart,
} from "../artworkBudgets";

const GB = 1_000_000_000;
// 23:59:30 UTC is already the next morning in Sydney; windows must still be UTC.
const LATE = Date.UTC(2026, 10, 22, 23, 59, 30);
const NEXT_DAY = Date.UTC(2026, 10, 23, 0, 0, 0);

describe("UTC windows", () => {
  it("start at UTC midnight and the UTC minute", () => {
    expect(utcDayStart(LATE)).toBe(Date.UTC(2026, 10, 22));
    expect(utcDayStart(NEXT_DAY)).toBe(NEXT_DAY);
    expect(utcMinuteStart(LATE)).toBe(Date.UTC(2026, 10, 22, 23, 59, 0));
  });
});

describe("daily budgets", () => {
  it("uses the recorded routine and launch allowances", () => {
    expect(ARTWORK_BUDGETS.daily.routine).toEqual({ downloadBytes: 10 * GB, conversions: 1000 });
    expect(ARTWORK_BUDGETS.daily.launch).toEqual({ downloadBytes: 50 * GB, conversions: 5000 });
    expect(budgetPoolFor("backfill")).toBe("launch");
    expect(budgetPoolFor("interactive")).toBe("routine");
    expect(budgetPoolFor("replacement")).toBe("routine");
  });

  it("reserves within the window and refuses the request that would exceed it", () => {
    const limits = { downloadBytes: 300, conversions: 2 };
    const a = reserveDaily(null, { downloadBytes: 200, conversions: 1 }, limits, LATE);
    expect(a).toEqual({ ok: true, usage: { windowStart: utcDayStart(LATE), downloadBytes: 200, conversions: 1 } });
    if (!a.ok) throw new Error("unreachable");

    const bytes = reserveDaily(a.usage, { downloadBytes: 101, conversions: 1 }, limits, LATE);
    expect(bytes).toEqual({ ok: false, reason: "daily_bytes", retryAt: NEXT_DAY });
    const exact = reserveDaily(a.usage, { downloadBytes: 100, conversions: 1 }, limits, LATE);
    expect(exact.ok).toBe(true);
    if (!exact.ok) throw new Error("unreachable");
    expect(reserveDaily(exact.usage, { downloadBytes: 0, conversions: 1 }, limits, LATE)).toEqual({ ok: false, reason: "daily_conversions", retryAt: NEXT_DAY });
  });

  it("resets at the next UTC day", () => {
    const full = { windowStart: utcDayStart(LATE), downloadBytes: 300, conversions: 2 };
    expect(reserveDaily(full, { downloadBytes: 300, conversions: 2 }, { downloadBytes: 300, conversions: 2 }, NEXT_DAY)).toEqual({
      ok: true,
      usage: { windowStart: NEXT_DAY, downloadBytes: 300, conversions: 2 },
    });
  });

  it("rejects negative or non-finite requests", () => {
    expect(() => reserveDaily(null, { downloadBytes: -1, conversions: 0 }, ARTWORK_BUDGETS.daily.routine, LATE)).toThrow(RangeError);
    expect(() => reserveDaily(null, { downloadBytes: Number.NaN, conversions: 0 }, ARTWORK_BUDGETS.daily.routine, LATE)).toThrow(RangeError);
  });
});

describe("provider rate windows and cooldowns", () => {
  it("allows 60 Dropbox / 20 Shopify requests per UTC minute", () => {
    expect(ARTWORK_BUDGETS.providerRequestsPerMinute).toEqual({ dropbox: 60, shopify: 20 });
    let w = null as Parameters<typeof reserveProviderRequest>[0];
    for (let i = 0; i < 20; i++) {
      const r = reserveProviderRequest(w, ARTWORK_BUDGETS.providerRequestsPerMinute.shopify, LATE);
      if (!r.ok) throw new Error(`request ${i + 1} refused`);
      w = r.window;
    }
    expect(reserveProviderRequest(w, 20, LATE)).toEqual({ ok: false, reason: "rate_limited", retryAt: NEXT_DAY });
    expect(reserveProviderRequest(w, 20, NEXT_DAY).ok).toBe(true);
  });

  it("holds every caller off during a shared provider cooldown and only ever extends it", () => {
    const r = reserveProviderRequest(null, 60, LATE);
    if (!r.ok) throw new Error("unreachable");
    let w = applyProviderCooldown(r.window, 120_000, LATE);
    expect(w.cooldownUntil).toBe(LATE + 120_000);
    w = applyProviderCooldown(w, 1_000, LATE);
    expect(w.cooldownUntil).toBe(LATE + 120_000);
    expect(reserveProviderRequest(w, 60, LATE + 119_999)).toEqual({ ok: false, reason: "cooldown", retryAt: LATE + 120_000 });
    expect(reserveProviderRequest(w, 60, LATE + 120_000).ok).toBe(true);
  });
});

describe("conversion concurrency and per-invocation work", () => {
  it("admits one global large conversion and at most two small/composition tasks", () => {
    expect(admitConversion({ large: 0, small: 0 }, "large")).toBe(true);
    expect(admitConversion({ large: 1, small: 0 }, "large")).toBe(false);
    expect(admitConversion({ large: 1, small: 1 }, "small")).toBe(true);
    expect(admitConversion({ large: 0, small: 2 }, "small")).toBe(false);
  });

  it("limits one invocation to one original or ten small components", () => {
    expect(invocationAllows({ originals: 0, smallComponents: 0 }, "large")).toBe(true);
    expect(invocationAllows({ originals: 1, smallComponents: 0 }, "large")).toBe(false);
    expect(invocationAllows({ originals: 0, smallComponents: 9 }, "small")).toBe(true);
    expect(invocationAllows({ originals: 0, smallComponents: 10 }, "small")).toBe(false);
    // Mixing: an invocation that downloaded an original does no further small work.
    expect(invocationAllows({ originals: 1, smallComponents: 0 }, "small")).toBe(false);
    expect(invocationAllows({ originals: 0, smallComponents: 1 }, "large")).toBe(false);
  });
});
