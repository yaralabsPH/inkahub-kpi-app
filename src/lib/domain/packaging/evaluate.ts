import type { PackagingContents, PackingPoint, PieceGroup } from "./contents";
import { MAX_PACKAGE_LINES, MAX_PACKAGE_QTY, type PackageQty, type PackagingExample, type PackagingRule, type RuleSetBody } from "./ruleSet";

/** One packaging item in a pick, resolved against the catalogue. */
export interface PickedPackage {
  key: string;
  product_id: string;
  label: string;
  qty: number;
}

export interface PackagingEvaluation {
  /**
   * resolved: every piece was assigned (packages may be empty when there is
   * nothing to pack). unresolved: something was left over or could not be
   * classified; nothing is picked automatically.
   */
  status: "resolved" | "unresolved";
  /** Empty when unresolved: a partial match is never applied (CJ decision Q6). */
  packages: PickedPackage[];
  firedRuleIds: string[];
  /** Pieces no rule took. */
  unassigned: PieceGroup[];
  /** SKUs that could not be classified. */
  unclassified: string[];
  /** Why the pick is unresolved, for the worker and the audit snapshot. */
  reason: string | null;
}

function ruleTakes(rule: PackagingRule, g: PieceGroup): boolean {
  if (!rule.kinds.includes(g.kind)) return false;
  if (!rule.sizes) return true;
  return g.size !== null && rule.sizes.includes(g.size);
}

function addPackage(into: Map<string, number>, key: string, qty: number): void {
  into.set(key, (into.get(key) ?? 0) + qty);
}

/**
 * Evaluate a rule set for one packing point. Pure and deterministic.
 *
 * Rules run top to bottom. A rule fires when it matches at least one
 * remaining piece and its conditions hold; it then takes all the pieces it
 * matched. Evaluation continues with what is left. Anything left at the end
 * makes the whole pick unresolved.
 */
export function evaluatePackaging(
  ruleSet: RuleSetBody,
  point: PackingPoint,
  contents: PackagingContents,
): PackagingEvaluation {
  let remaining: PieceGroup[] = contents.pieces.filter((g) => g.pieces > 0).map((g) => ({ ...g }));
  const picked = new Map<string, number>();
  const firedRuleIds: string[] = [];

  for (const rule of ruleSet.rules) {
    if (rule.packing_point !== point) continue;
    if (remaining.length === 0) break;
    const matched = remaining.filter((g) => ruleTakes(rule, g));
    const count = matched.reduce((s, g) => s + g.pieces, 0);
    if (count === 0) continue;
    if (rule.min_pieces !== undefined && count < rule.min_pieces) continue;
    if (rule.max_pieces !== undefined && count > rule.max_pieces) continue;
    if (rule.contains_sizes && !rule.contains_sizes.every((s) => matched.some((g) => g.size === s))) continue;

    if (rule.output.mode === "fixed") {
      for (const p of rule.output.packages) addPackage(picked, p.key, p.qty);
    } else {
      addPackage(picked, rule.output.package, Math.ceil(count / rule.output.capacity));
    }
    firedRuleIds.push(rule.id);
    remaining = remaining.filter((g) => !matched.includes(g));
  }

  const unresolved = (reason: string): PackagingEvaluation => ({
    status: "unresolved",
    packages: [],
    firedRuleIds,
    unassigned: remaining,
    unclassified: [...contents.unclassified],
    reason,
  });

  if (contents.unclassified.length > 0) return unresolved("Some items could not be recognised.");
  if (remaining.length > 0) return unresolved("No box rule covers every item.");

  const packages: PickedPackage[] = [];
  for (const [key, qty] of picked) {
    const item = ruleSet.catalogue.find((c) => c.key === key);
    if (!item) return unresolved(`Packaging item "${key}" is not in the catalogue.`);
    if (qty > MAX_PACKAGE_QTY) return unresolved(`More than ${MAX_PACKAGE_QTY} of "${item.label}" would be needed.`);
    packages.push({ key, product_id: item.product_id, label: item.label, qty });
  }
  if (packages.length > MAX_PACKAGE_LINES) return unresolved("Too many different packaging items.");

  return { status: "resolved", packages, firedRuleIds, unassigned: [], unclassified: [], reason: null };
}

export interface ExampleResult {
  id: string;
  pass: boolean;
  expected: "unresolved" | PackageQty[];
  actual: "unresolved" | PackageQty[];
}

function samePackages(a: PackageQty[], b: PackageQty[]): boolean {
  const norm = (list: PackageQty[]) => {
    const m = new Map<string, number>();
    for (const p of list) m.set(p.key, (m.get(p.key) ?? 0) + p.qty);
    return [...m.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([k, q]) => `${k}=${q}`).join("|");
  };
  return norm(a) === norm(b);
}

export function runExample(ruleSet: RuleSetBody, example: PackagingExample): ExampleResult {
  const ev = evaluatePackaging(ruleSet, example.packing_point, { pieces: example.contents, unclassified: [] });
  const actual: ExampleResult["actual"] =
    ev.status === "unresolved" ? "unresolved" : ev.packages.map((p) => ({ key: p.key, qty: p.qty }));
  const pass =
    example.expect === "unresolved" || actual === "unresolved"
      ? example.expect === actual
      : samePackages(example.expect, actual);
  return { id: example.id, pass, expected: example.expect, actual };
}

export function runExamples(ruleSet: RuleSetBody): ExampleResult[] {
  return ruleSet.examples.map((e) => runExample(ruleSet, e));
}

/** Activation gate: at least one example, and every example passes. */
export function examplesAllowActivation(ruleSet: RuleSetBody): boolean {
  const results = runExamples(ruleSet);
  return results.length > 0 && results.every((r) => r.pass);
}
