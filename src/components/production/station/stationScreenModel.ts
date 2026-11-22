/**
 * Station screen redesign: pure logic for the new station order screen.
 * No React, no I/O - everything here is derived from the order lines the
 * Production page already fetched, so it can be tested in isolation.
 */
import { isSkuVerifiable, parseSku } from "@/lib/domain/skuRouting";
import type { ProductionDepartment } from "@/lib/domain/schemas";
import { getOrderLinePresentation } from "../orderLinePresentation";

export type StationGroup = "frame" | "flat" | "other";

/** The subset of a Production order line the station screen needs. */
export interface StationLineInput {
  key: string;
  sku: string;
  title: string;
  quantity: number;
  variantTitle: string | null;
  belongsToThisDept: boolean;
}

export interface StationLineView extends StationLineInput {
  group: StationGroup;
  /** "A0".."A4", or null when the SKU does not encode a paper size. */
  size: string | null;
  /** "Black", "White", "Natural Timber", "No frame", "Stretched canvas", ... */
  frameLabel: string;
  /** Swatch colour for a real frame, null when there is no frame. */
  frameColor: string | null;
  /** True when this station must verify the line before Complete. */
  needsCheck: boolean;
  /** Verifiable at all (gift cards are not). */
  verifiable: boolean;
  setCount: number | null;
  /** Shopify / legacy text, shown when the SKU itself says nothing. */
  fallbackDescription: string | null;
}

const FRAME_SWATCH: Record<string, string> = {
  black: "#1E2329",
  white: "#FFFFFF",
  natural: "#9A5426",
};

const PAPER_SIZES = new Set(["A0", "A1", "A2", "A3", "A4"]);

export function getStationLineView(line: StationLineInput): StationLineView {
  const pres = getOrderLinePresentation(line.sku, line.variantTitle);
  const parsed = parseSku(line.sku);
  const verifiable = isSkuVerifiable(line.sku);
  const size = parsed?.size && PAPER_SIZES.has(parsed.size) ? parsed.size : null;
  const frameColor = FRAME_SWATCH[pres.colourTone] ?? null;

  let group: StationGroup;
  if (!line.belongsToThisDept) group = "other";
  else if (pres.styleLabel === "Framed" || pres.kind === "picture_frame") group = "frame";
  else group = "flat";

  return {
    ...line,
    group,
    size,
    // Gift cards / AUX have no frame at all; legacy SKUs are genuinely unknown.
    frameLabel: pres.kind === "other" ? "—" : pres.colourTone === "unknown" ? "Unknown style" : pres.colourLabel,
    frameColor,
    needsCheck: line.belongsToThisDept && verifiable,
    verifiable,
    setCount: parsed?.type === "set_print" ? parsed.setCount ?? null : null,
    fallbackDescription: pres.fallbackDescription,
  };
}

/** Display order of the groups on screen. */
export const GROUP_ORDER: StationGroup[] = ["frame", "flat", "other"];

export function sortByGroup(lines: StationLineView[]): StationLineView[] {
  return GROUP_ORDER.flatMap((g) => lines.filter((l) => l.group === g));
}

export interface StationProgress {
  required: number;
  checked: number;
  remaining: number;
  /** True only when there was something to check and all of it is checked. */
  allDone: boolean;
  /** First unchecked required line, in on-screen order. */
  currentKey: string | null;
  /** Sum of quantities over the lines this station must check. */
  pieces: number;
  toFrame: number;
  packFlat: number;
}

export function buildStationProgress(
  lines: StationLineView[],
  checkedKeys: ReadonlySet<string>,
): StationProgress {
  const required = sortByGroup(lines).filter((l) => l.needsCheck);
  const checked = required.filter((l) => checkedKeys.has(l.key)).length;
  const current = required.find((l) => !checkedKeys.has(l.key)) ?? null;
  return {
    required: required.length,
    checked,
    remaining: required.length - checked,
    allDone: required.length > 0 && checked === required.length,
    currentKey: current?.key ?? null,
    pieces: required.reduce((n, l) => n + safeQty(l.quantity), 0),
    toFrame: required.filter((l) => l.group === "frame").length,
    packFlat: required.filter((l) => l.group === "flat").length,
  };
}

/**
 * One tap of "Check piece N of M". The app verifies per line, so the piece
 * count is screen-only; `verify` says when to call the real verify handler.
 */
export function nextPickCount(current: number, quantity: number): { picked: number; verify: boolean } {
  const qty = safeQty(quantity);
  const picked = Math.min(current + 1, qty);
  return { picked, verify: picked >= qty };
}

/** Keys of checked lines, newest check first. */
export function orderDoneKeys(keys: string[], checkedAt: ReadonlyMap<string, string>): string[] {
  return keys
    .filter((k) => checkedAt.has(k))
    .sort((a, b) => Date.parse(checkedAt.get(b)!) - Date.parse(checkedAt.get(a)!));
}

/** A confirmation the screen shows after a saved verify / unverify. */
export interface CheckChange {
  kind: "done" | "undo";
  key: string;
}

/**
 * Compare the saved checked-set before and after a render. Toasts are
 * driven by this, so they only appear once the event has actually been
 * saved (a failed or pending write changes nothing and shows nothing).
 * `prev === null` is the first render: no toasts for already-saved lines.
 */
export function diffCheckedKeys(
  prev: ReadonlySet<string> | null,
  next: ReadonlySet<string>,
  orderedKeys: string[],
): CheckChange[] {
  if (!prev) return [];
  const out: CheckChange[] = [];
  for (const key of orderedKeys) {
    if (next.has(key) && !prev.has(key)) out.push({ kind: "done", key });
    else if (!next.has(key) && prev.has(key)) out.push({ kind: "undo", key });
  }
  return out;
}

/** Auto-scroll to the new current card only when the current line changes. */
export function scrollTargetFor(prevKey: string | null, nextKey: string | null): string | null {
  return nextKey && nextKey !== prevKey ? nextKey : null;
}

/** No smooth scrolling for people who asked the OS to reduce motion. */
export function scrollBehaviorFor(prefersReducedMotion: boolean): ScrollBehavior {
  return prefersReducedMotion ? "auto" : "smooth";
}

/** F4: "scan" is the old box-scan behaviour; "auto" means the app picks the packaging. */
export type StationPackagingMode = "scan" | "auto";

/**
 * Stations whose Complete is blocked until packaging is set (same as classic).
 * In auto mode (F4 box-auto-pick) no station is ever blocked by packaging.
 */
export function stationNeedsPackaging(
  department: ProductionDepartment,
  mode: StationPackagingMode = "scan",
): boolean {
  if (mode === "auto") return false;
  return department === "a0_framed" || department === "dispatch" || department === "unframed";
}

export function packagingBlocksComplete(
  department: ProductionDepartment,
  packageCount: number,
  mode: StationPackagingMode = "scan",
): boolean {
  return stationNeedsPackaging(department, mode) && packageCount === 0;
}

/**
 * Why Complete must be refused, or null when it may proceed. Shared by the
 * classic and new screens so the rule lives in one tested place:
 *  - dispatch: always allowed (one-tap finalise);
 *  - classic: at least one line verified;
 *  - new screen (CJ decision A): additionally every line this station must
 *    check (its own lines that are verifiable) is verified.
 */
export function completeBlockReason(args: {
  department: ProductionDepartment;
  stationUi: StationUi;
  verifiedCount: number;
  lines: Array<{ key: string; sku: string; belongsToThisDept: boolean }>;
  isVerified: (key: string) => boolean;
}): string | null {
  if (args.department === "dispatch") return null;
  if (args.verifiedCount === 0) return "Verify at least one item before completing the order.";
  if (args.stationUi === "new") {
    const missing = args.lines.filter(
      (l) => l.belongsToThisDept && isSkuVerifiable(l.sku) && !args.isVerified(l.key),
    ).length;
    if (missing > 0) return `Check every item before completing the order (${missing} left).`;
  }
  return null;
}

export type StationUi = "new" | "classic";

/**
 * Which station screen to show. Dispatch stays classic until F7.
 * `envValue` = VITE_STATION_UI (build-time rollback switch).
 * `tabOverride` = ?ui=classic|new remembered for the tab (testing).
 */
/**
 * Read ?ui=classic|new for this tab, remembering it in sessionStorage.
 * A valid URL choice wins even if storage is unavailable (it just isn't
 * remembered). Note: a remembered "new" overrides VITE_STATION_UI=classic
 * until the tab is opened with ?ui=classic or closed.
 */
export function readTabOverride(search: string, storage: Pick<Storage, "getItem" | "setItem"> | null): string | null {
  let param: string | null = null;
  try {
    param = new URLSearchParams(search).get("ui");
  } catch {
    param = null;
  }
  if (param === "classic" || param === "new") {
    try {
      storage?.setItem("inka-station-ui", param);
    } catch {
      // Storage blocked: honour the URL for this load anyway.
    }
    return param;
  }
  try {
    return storage?.getItem("inka-station-ui") ?? null;
  } catch {
    return null;
  }
}

export function resolveStationUi(args: {
  department: ProductionDepartment;
  envValue?: string | null;
  tabOverride?: string | null;
}): StationUi {
  if (args.department === "dispatch") return "classic";
  if (args.tabOverride === "classic" || args.tabOverride === "new") return args.tabOverride;
  return args.envValue === "classic" ? "classic" : "new";
}

function safeQty(q: number): number {
  return Number.isFinite(q) && q > 0 ? Math.floor(q) : 1;
}
