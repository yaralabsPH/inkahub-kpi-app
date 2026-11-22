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
    frameLabel: pres.colourTone === "unknown" ? "Unknown style" : pres.colourLabel,
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

export type StationUi = "new" | "classic";

/**
 * Which station screen to show. Dispatch stays classic until F7.
 * `envValue` = VITE_STATION_UI (build-time rollback switch).
 * `tabOverride` = ?ui=classic|new remembered for the tab (testing).
 */
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
