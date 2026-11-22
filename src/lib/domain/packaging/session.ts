import { packagingContents, type PackagingContents, type PackagingLineInput, type PackingPoint } from "./contents";
import { evaluatePackaging, type PackagingEvaluation, type PickedPackage } from "./evaluate";
import { isOverride, toQuantities, type Quantities } from "./reconcile";
import { MAX_PACKAGE_LINES, MAX_PACKAGE_QTY, type CatalogueItem, type RuleSetBody } from "./ruleSet";

/**
 * F4 box-auto-pick: what a station does with a prediction. Pure functions
 * shared by the station hook, the packaging panel and their tests.
 */

export const REPLACEMENT_REASON = "Replacement: choose the packaging used.";

/** The packing point a station works at, or null (Framed packs nothing). */
export function stationPackingPoint(department: string): PackingPoint | null {
  return department === "a0_framed" || department === "dispatch" || department === "unframed" ? department : null;
}

export interface PackagingPrediction {
  point: PackingPoint;
  contents: PackagingContents;
  evaluation: PackagingEvaluation;
}

/**
 * Predict the packaging for the part of an order packed at this station.
 *
 * Replacement work (a CS case is active): the station does not know which
 * lines are being re-sent, so nothing is predicted and the worker chooses
 * (spec Q2, default in force).
 */
export function predictPackaging(
  ruleSet: RuleSetBody,
  point: PackingPoint,
  lines: PackagingLineInput[],
  opts: { replacement: boolean },
): PackagingPrediction {
  const contents = packagingContents(lines, point);
  if (opts.replacement) {
    return {
      point,
      contents,
      evaluation: {
        status: "unresolved",
        packages: [],
        firedRuleIds: [],
        unassigned: contents.pieces,
        unclassified: contents.unclassified,
        reason: REPLACEMENT_REASON,
      },
    };
  }
  return { point, contents, evaluation: evaluatePackaging(ruleSet, point, contents) };
}

/** Catalogue items a worker may pick by hand at this packing point. */
export function alternativesFor(ruleSet: RuleSetBody, point: PackingPoint): CatalogueItem[] {
  return ruleSet.catalogue.filter((c) => !c.packing_points || c.packing_points.includes(point));
}

function asPicked(item: CatalogueItem, qty: number): PickedPackage {
  return { key: item.key, product_id: item.product_id, label: item.label, qty };
}

/**
 * One tap on a catalogue item. With zero or one line in the pick, the tap
 * replaces it with one of the tapped item (the common "it was the other
 * box" correction). With several lines, the tap adds one of that item.
 */
export function tapPackage(current: PickedPackage[], item: CatalogueItem): PickedPackage[] {
  if (current.length <= 1) return [asPicked(item, 1)];
  return addPackage(current, item);
}

/** Add one of an item (each legacy box scan adds one, like the old flow). */
export function addPackage(current: PickedPackage[], item: CatalogueItem): PickedPackage[] {
  const hit = current.find((p) => p.key === item.key);
  if (hit) {
    return current.map((p) => (p.key === item.key ? { ...p, qty: Math.min(MAX_PACKAGE_QTY, p.qty + 1) } : p));
  }
  if (current.length >= MAX_PACKAGE_LINES) return current;
  return [...current, asPicked(item, 1)];
}

/** Change a line's quantity by delta; a line that reaches zero is removed. */
export function adjustPackage(current: PickedPackage[], key: string, delta: number): PickedPackage[] {
  return current
    .map((p) => (p.key === key ? { ...p, qty: Math.min(MAX_PACKAGE_QTY, p.qty + delta) } : p))
    .filter((p) => p.qty > 0);
}

/** Printed box barcodes from the old scan flow still work, as a manual pick. */
export function packageFromLegacyBarcode(ruleSet: RuleSetBody, barcode: string, point: PackingPoint): CatalogueItem | null {
  return alternativesFor(ruleSet, point).find((c) => c.legacy_barcode === barcode) ?? null;
}

/** Show a saved pick (product id -> qty) with catalogue labels where known. */
export function pickedFromQuantities(ruleSet: RuleSetBody | null, q: Quantities): PickedPackage[] {
  return Object.entries(q)
    .filter(([, qty]) => qty > 0)
    .map(([productId, qty]) => {
      const item = ruleSet?.catalogue.find((c) => c.product_id === productId);
      return { key: item?.key ?? productId, product_id: productId, label: item?.label ?? productId, qty };
    });
}

export type PickStatus = "auto" | "changed" | "flagged";

/** What the panel shows before Complete. */
export function pickStatus(prediction: PackagingPrediction, chosen: PickedPackage[]): PickStatus {
  if (isOverride(toQuantities(prediction.evaluation.packages), toQuantities(chosen))) return "changed";
  return prediction.evaluation.status === "resolved" ? "auto" : "flagged";
}

export interface ApplyPayload {
  ruleSetId: string;
  resolved: boolean;
  predicted: Quantities;
  target: Quantities;
  snapshot: Record<string, unknown>;
}

/** Everything packaging_apply needs besides the site, request and event ids. */
export function buildApplyPayload(args: {
  ruleSet: { id: string; version: number };
  prediction: PackagingPrediction;
  chosen: PickedPackage[];
}): ApplyPayload {
  const { prediction, chosen, ruleSet } = args;
  const ev = prediction.evaluation;
  return {
    ruleSetId: ruleSet.id,
    resolved: ev.status === "resolved",
    predicted: toQuantities(ev.packages),
    target: toQuantities(chosen),
    snapshot: {
      rule_set_version: ruleSet.version,
      packing_point: prediction.point,
      contents: prediction.contents.pieces,
      unclassified: prediction.contents.unclassified,
      fired_rule_ids: ev.firedRuleIds,
      unassigned: ev.unassigned,
      reason: ev.reason,
      predicted: ev.packages.map((p) => ({ key: p.key, label: p.label, qty: p.qty })),
      chosen: chosen.map((p) => ({ key: p.key, label: p.label, qty: p.qty })),
    },
  };
}
