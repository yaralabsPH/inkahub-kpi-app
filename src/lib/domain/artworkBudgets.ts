/**
 * F3 artwork thumbnails — shared quotas, daily budgets and conversion
 * concurrency (pure, no I/O).
 *
 * All windows are UTC. Durable shared state (Task 7's rate-window rows)
 * stores the values these functions return; nothing here is per-process.
 * Routine and launch budgets are separate daily allowances, but both share
 * the same provider rate limits and conversion slots.
 */

import type { ArtworkJobPriority } from "./artworkJobs.js";

export const ARTWORK_BUDGETS = {
  daily: {
    routine: { downloadBytes: 10_000_000_000, conversions: 1_000 },
    launch: { downloadBytes: 50_000_000_000, conversions: 5_000 },
  },
  providerRequestsPerMinute: { dropbox: 60, shopify: 20 },
  /** Global conversion slots: one large original, two small/composition tasks. */
  concurrency: { large: 1, small: 2 },
  /** One worker invocation processes one original, or up to ten small components. */
  perInvocation: { originals: 1, smallComponents: 10 },
} as const;

export type BudgetPool = keyof typeof ARTWORK_BUDGETS.daily;
export type ConversionClass = "large" | "small";

export interface DailyLimits {
  downloadBytes: number;
  conversions: number;
}

export interface DailyUsage {
  /** UTC midnight that starts this window. */
  windowStart: number;
  downloadBytes: number;
  conversions: number;
}

export interface RateWindow {
  /** UTC minute that starts this window. */
  windowStart: number;
  count: number;
  /** Shared provider cooldown (Retry-After / backoff), absolute ms; null when none. */
  cooldownUntil: number | null;
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export function utcDayStart(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

export function utcMinuteStart(now: number): number {
  return Math.floor(now / MINUTE_MS) * MINUTE_MS;
}

/** Launch backfill draws on the launch allowance; everything else on routine. */
export function budgetPoolFor(priority: ArtworkJobPriority): BudgetPool {
  return priority === "backfill" ? "launch" : "routine";
}

/** Reserve bytes/conversions in today's UTC window, or say when to try again. */
export function reserveDaily(
  usage: DailyUsage | null,
  request: { downloadBytes: number; conversions: number },
  limits: DailyLimits,
  now: number,
): { ok: true; usage: DailyUsage } | { ok: false; reason: "daily_bytes" | "daily_conversions"; retryAt: number } {
  for (const v of [request.downloadBytes, request.conversions]) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`budget request must be a non-negative number, got ${v}`);
  }
  const windowStart = utcDayStart(now);
  const current = usage && usage.windowStart === windowStart ? usage : { windowStart, downloadBytes: 0, conversions: 0 };
  const downloadBytes = current.downloadBytes + request.downloadBytes;
  const conversions = current.conversions + request.conversions;
  if (downloadBytes > limits.downloadBytes) return { ok: false, reason: "daily_bytes", retryAt: windowStart + DAY_MS };
  if (conversions > limits.conversions) return { ok: false, reason: "daily_conversions", retryAt: windowStart + DAY_MS };
  return { ok: true, usage: { windowStart, downloadBytes, conversions } };
}

/** Reserve one provider request in this UTC minute, respecting any shared cooldown. */
export function reserveProviderRequest(
  window: RateWindow | null,
  limitPerMinute: number,
  now: number,
): { ok: true; window: RateWindow } | { ok: false; reason: "cooldown" | "rate_limited"; retryAt: number } {
  const cooldownUntil = window?.cooldownUntil ?? null;
  if (cooldownUntil !== null && cooldownUntil > now) return { ok: false, reason: "cooldown", retryAt: cooldownUntil };
  const windowStart = utcMinuteStart(now);
  const count = window && window.windowStart === windowStart ? window.count : 0;
  if (count >= limitPerMinute) return { ok: false, reason: "rate_limited", retryAt: windowStart + MINUTE_MS };
  return { ok: true, window: { windowStart, count: count + 1, cooldownUntil } };
}

/** Record a provider Retry-After/backoff for every caller; a cooldown is only ever extended. */
export function applyProviderCooldown(window: RateWindow, retryAfterMs: number, now: number): RateWindow {
  const until = now + Math.max(0, retryAfterMs);
  return { ...window, cooldownUntil: Math.max(window.cooldownUntil ?? 0, until) };
}

export function admitConversion(
  active: { large: number; small: number },
  cls: ConversionClass,
  limits: { large: number; small: number } = ARTWORK_BUDGETS.concurrency,
): boolean {
  return cls === "large" ? active.large < limits.large : active.small < limits.small;
}

/** One original, or up to ten small components — not both — per invocation. */
export function invocationAllows(
  processed: { originals: number; smallComponents: number },
  cls: ConversionClass,
  limits: { originals: number; smallComponents: number } = ARTWORK_BUDGETS.perInvocation,
): boolean {
  if (cls === "large") return processed.smallComponents === 0 && processed.originals < limits.originals;
  return processed.originals === 0 && processed.smallComponents < limits.smallComponents;
}
